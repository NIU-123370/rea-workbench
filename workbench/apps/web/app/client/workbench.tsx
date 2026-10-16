"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls } from "@xyflow/react";
// React Flow ships its layout as CSS: without it the node boxes are not positioned and
// the edge layer never renders, so a canvas that looks populated can still show no
// relations at all. The browser pass found this by counting `.react-flow__edge` nodes.
import "@xyflow/react/dist/style.css";
import type { Edge, Node } from "@xyflow/react";

import { WorkbenchColumns } from "../../ui/panels.tsx";
import { buildMiddlePanel, buildLeftPanel, buildRightTabs, canvasEdges, directedInquiry, listView, pickCandidateSource } from "../../ui/view-model.ts";
import type { CandidateDiscovery, DirectedInquiry, GraphEdgeView, GraphNodeView, LeftPanel, MiddleCell, RightTab } from "../../ui/view-model.ts";
// `Id` is a brand, not a runtime check: every value cast here arrived from the API, whose
// schemas validated the shape on the way out (§4). Importing `identity.ts` into a client
// component would also drag `node:crypto` into the browser bundle.
import type { Id } from "../../../../packages/domain/identity.ts";
import type { ClaimEvidenceState } from "../../../../packages/domain/evidence.ts";
import type { Digest } from "../../../../packages/domain/canonical-json.ts";

// The browser half of the three columns (PRD F04 / issue #18).
//
// Two things are deliberately kept apart here. The *judgement* — what colour a cell is and
// why — is computed by the same `buildMiddlePanel` the headless render uses, so the
// interactive canvas cannot show a status the tested view model would not have produced.
// React Flow only lays out and pans those cells, and Monaco only displays bytes somebody
// else already fetched. Neither decides anything.

export type GraphViewPayload = {
  projectId: string;
  targetId: string | null;
  truncated: boolean;
  note: string | null;
  nodes: { entityKey: string; claimIds: Id[]; evidenceIds: string[] }[];
  edges: { id: string; fromKey: string; toKey: string; relation: string; claimId: Id }[];
  claims: { claimId: Id; assertion: string; revision: number; state: ClaimEvidenceState }[];
};

export type SessionState = "unknown" | "paired" | "unpaired";

// The two reads the 代码 tab needs (§8 lines 277, 294-296). Cast rather than re-validated:
// the API replied through `jobPageSchema` and `candidateViewSchema` on its way out, and a
// second parser in the browser bundle would be a second owner of the same wire contract.
// `error` is the safe projection the worker already sanitised (§12.1), never a raw message.
export type JobsPagePayload = {
  items: { id: string; kind: string; state: string; cleanupState: string; resultRef: string | null; error: { code: string; message: string } | null }[];
  nextCursor: string | null;
};

export type CandidatePayload = {
  id: string;
  files: { id: string; path: string; byteLength: number; language: string }[];
};

async function getJson(path: string): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string }> {
  const response = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as { error?: { details?: { reason?: string } } } | null)?.error;
    return { ok: false, status: response.status, reason: error?.details?.reason ?? "request-refused" };
  }
  return { ok: true, value: payload };
}

// The list view is the canvas substitute the acceptance row names, so it is always
// rendered; the interactive canvas is an extra surface on top of it when the operator asks
// for the picture instead of the table.
function readEvidenceInquiry(evidenceId: string): DirectedInquiry {
  return { kind: "read-evidence", subjectId: evidenceId, gaps: ["operator-jumped-to-evidence"], request: { evidenceId } };
}

// What the 代码 tab says when there is nothing to show, named by the step that came up
// empty. "No candidate" and "no build job" are different operator problems, and one generic
// empty state would hide which of them this is.
const NO_CANDIDATE_LINE: Record<Extract<CandidateDiscovery, { found: false }>["reason"], string> = {
  "job-page-empty": "本项目还没有任何作业记录：生成候选前先有一次成功的构建。",
  "no-successful-build": "作业清单里没有成功的构建作业，所以还没有可读的候选。",
  "result-ref-is-not-an-id": "最近的构建作业没有把候选 id 写在 resultRef 上（§8 line 294）。",
};

// The report column repeats what the colour was made of rather than restating a colour:
// the coverage state, the examined/total pair when the row has one, and the reasons the
// gate gave (DESIGN §6).
function coverageLine(claim: GraphViewPayload["claims"][number]): string {
  const coverage = claim.state.coverage;
  const counted = coverage.examined === null || coverage.total === null ? "" : `：${String(coverage.examined)}/${String(coverage.total)}`;
  const reasons = coverage.reasons.length === 0 ? "" : `（${coverage.reasons.join("；")}）`;
  return `覆盖 ${coverage.state}${counted}${reasons}`;
}

function grid(index: number): { x: number; y: number } {
  const columns = 4;
  return { x: (index % columns) * 240, y: Math.floor(index / columns) * 130 };
}

export function FlowCanvas(props: { cells: readonly MiddleCell[]; rows: readonly GraphEdgeView[]; onCellPick?: (cellId: string) => void }): React.ReactElement {
  // Only entity cells become boxes. An edge cell is a judgement about a relation, and it
  // already has its own row in the list and its own line here; drawing it as a third node
  // would put the relation on the canvas twice.
  const nodes: Node[] = useMemo(
    () =>
      props.cells
        .filter((cell) => cell.role === "node")
        .map((cell, index) => ({
        id: cell.id,
        position: grid(index),
        data: {
          label: `${cell.label} · ${cell.presentation.label}`,
          // The glyph and the word travel with the node: a canvas that coloured a box and
          // said nothing is the failure mode §6's status rule exists to prevent.
          title: `${cell.presentation.icon} ${cell.presentation.label}${cell.presentation.reasons.length > 0 ? `：${cell.presentation.reasons.join("；")}` : ""}`,
        },
      })),
    [props.cells],
  );
  const placed = useMemo(() => canvasEdges(props.cells, props.rows), [props.cells, props.rows]);
  const edges: Edge[] = placed.drawn;
  return (
    <div
      data-panel="flow-canvas"
      aria-label="交互式图视图"
      data-drawn={String(placed.drawn.length)}
      data-dropped={String(placed.dropped.length)}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_event, node) => props.onCellPick?.(node.id)}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

export function PairingForm(props: { onPaired: () => void }): React.ReactElement {
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const response = await fetch("/api/v1/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bootstrapToken: token }),
      });
      if (response.ok) {
        setNotice("已配对");
        props.onPaired();
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const reason = (body as { error?: { details?: { reason?: string } } } | null)?.error?.details?.reason ?? `http-${String(response.status)}`;
      setNotice(`配对被拒：${reason}`);
    },
    [props, token],
  );
  return (
    <form onSubmit={submit} data-panel="pairing">
      <label htmlFor="bootstrap">终端里显示的配对码</label>
      <input id="bootstrap" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
      <button type="submit">配对</button>
      {notice === null ? null : <p data-pairing-notice>{notice}</p>}
    </form>
  );
}

export function Workbench(props: { projectId: string }): React.ReactElement {
  const [graph, setGraph] = useState<GraphViewPayload | null>(null);
  const [jobs, setJobs] = useState<JobsPagePayload | null>(null);
  const [candidate, setCandidate] = useState<CandidatePayload | null>(null);
  const [source, setSource] = useState<{ fileId: string; content: string; sha256: string } | null>(null);
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>("unknown");
  const [mode, setMode] = useState<"canvas" | "list">("canvas");
  const [activeTab, setActiveTab] = useState<RightTab["id"]>("contract");
  const [inquiries, setInquiries] = useState<DirectedInquiry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const health = await getJson("/api/v1/session");
    setSession(health.ok ? "paired" : "unpaired");
    if (!health.ok) return;
    const view = await getJson(`/api/v1/projects/${props.projectId}/graph`);
    if (!view.ok) {
      setError(view.reason);
      return;
    }
    setGraph(view.value as GraphViewPayload);
    // The candidate is discovered, not typed (§8 lines 277 + 294): the job page names the
    // build job whose resultRef is the candidate, and only then does the file list have an
    // address. A refusal here says which of those two steps did not happen.
    const page = await getJson(`/api/v1/projects/${props.projectId}/jobs?limit=50`);
    if (!page.ok) {
      setCodeNotice(`作业清单读取被拒：${page.reason}`);
      return;
    }
    const loaded = page.value as JobsPagePayload;
    setJobs(loaded);
    const picked = pickCandidateSource(loaded.items);
    if (!picked.found) {
      setCodeNotice(NO_CANDIDATE_LINE[picked.reason]);
      return;
    }
    const files = await getJson(`/api/v1/projects/${props.projectId}/candidates/${picked.candidateId}`);
    if (!files.ok) {
      setCodeNotice(`候选文件清单读取被拒：${files.reason}`);
      return;
    }
    setCandidate(files.value as CandidatePayload);
  }, [props.projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openFile = useCallback(
    async (fileId: string) => {
      if (candidate === null) return;
      const got = await getJson(`/api/v1/projects/${props.projectId}/candidates/${candidate.id}/files/${fileId}`);
      if (!got.ok) {
        setCodeNotice(`文件正文读取被拒：${got.reason}`);
        return;
      }
      const body = got.value as { content: string; sha256: string };
      setCodeNotice(null);
      setSource({ fileId, content: body.content, sha256: body.sha256 });
    },
    [candidate, props.projectId],
  );

  // The wire names the endpoints `fromKey`/`toKey`; the view model names them `from`/`to`.
  // One mapping, shared by the judgement and the canvas, so the two cannot disagree about
  // where a relation points.
  const edgeViews: GraphEdgeView[] = useMemo(
    () =>
      (graph?.edges ?? []).map((edge) => ({
        id: edge.id,
        from: edge.fromKey,
        to: edge.toKey,
        relation: edge.relation,
        claimId: edge.claimId,
      })),
    [graph],
  );

  const built = useMemo(() => {
    if (graph === null) return null;
    const states = new Map(graph.claims.map((entry) => [String(entry.claimId), entry.state]));
    const nodes: GraphNodeView[] = graph.nodes.map((node) => ({
      id: node.entityKey,
      kind: "entity",
      label: node.entityKey,
      targetId: (graph.targetId ?? "00000000-0000-4000-8000-000000000000") as Id,
      claimIds: node.claimIds,
      evidenceIds: node.evidenceIds,
      contractRevisionIds: [],
      coverage: { state: "unknown", examined: null, total: null, reasons: ["coverage-comes-from-claims"] },
    }));
    return buildMiddlePanel({
      nodes,
      edges: edgeViews,
      requiredClaimsOfNode: (node) => node.claimIds.map((id) => states.get(String(id))).filter((state): state is ClaimEvidenceState => state !== undefined),
      claimOfEdge: (claimId) => states.get(String(claimId)) ?? null,
    });
  }, [graph]);

  // The left column names the state and the cleanup state it read (§8: 左栏不从日志推断重试
  // 时间), so the page's newest job is passed to the same builder the headless render uses.
  const newestJob = useMemo(() => {
    const first = jobs?.items[0];
    if (first === undefined) return null;
    return { id: first.id as Id, state: first.state, cleanupState: first.cleanupState, errorJson: first.error };
  }, [jobs]);

  const left: LeftPanel | { reason: string } =
    graph === null
      ? { reason: "graph-unreadable" }
      : buildLeftPanel({
          job: newestJob,
          target: graph.targetId === null ? null : { id: graph.targetId as Id, kind: "har", snapshotDigest: null as Digest | null },
          limitations: graph.truncated ? ["视图已截断：只读到前 500 条"] : [],
          scopeLabel: graph.note ?? "本项目的图",
        });

  const cells = built?.cells ?? [];
  const list = listView(cells);
  const tabs = buildRightTabs({ isBuilder: false, hasBlueprint: false });

  // One cell, one next step: a claim that already has sources is a claim you can read,
  // and a claim with a gap but no source is a claim you have to ask about. The canvas and
  // the list rows therefore do the same thing for the same cell.
  const pickCell = useCallback((cellId: string) => {
    const cell = cells.find((entry) => entry.id === cellId);
    if (cell === undefined) return;
    const first = cell.evidenceJumpTargets[0];
    if (first !== undefined) {
      setInquiries((previous) => [...previous, readEvidenceInquiry(first)]);
      return;
    }
    const inquiry = directedInquiry(cell);
    if (inquiry.ok) setInquiries((previous) => [...previous, inquiry.value]);
  }, [cells]);

  const claimRows = graph?.claims ?? [];
  const droppedEdges = built === null ? [] : canvasEdges(built.cells, edgeViews).dropped;

  return (
    <div data-workbench={props.projectId}>
      <p>
        会话：{session} · 视图：{mode} · 节点/边：
        {String(graph?.nodes.length ?? 0)} / {String(graph?.edges.length ?? 0)}
      </p>
      {error === null ? null : <p data-error>{`读取被拒：${error}`}</p>}
      {session === "paired" ? null : <PairingForm onPaired={() => void load()} />}
      <button type="button" onClick={() => setMode(mode === "canvas" ? "list" : "canvas")}>
        {mode === "canvas" ? "改用列表视图" : "改图画布视图"}
      </button>
      <WorkbenchColumns
        left={left}
        cells={cells}
        canvasFailures={[...(built?.failures ?? []), ...droppedEdges].map((failure) => ({ reason: failure.reason, missing: failure.missing }))}
        tabs={tabs}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        canvasSlot={mode === "canvas" && cells.length > 0 ? <FlowCanvas cells={cells} rows={edgeViews} onCellPick={pickCell} /> : null}
        mode="list"
        onInquiry={(inquiry) => setInquiries((previous) => [...previous, inquiry])}
        onJumpToEvidence={(evidenceId) => setInquiries((previous) => [...previous, readEvidenceInquiry(evidenceId)])}
      />
      <section data-tabpanel={activeTab} aria-label="右栏面板内容">
        {activeTab === "contract" ? (
          <ul>
            {claimRows.map((claim) => (
              <li key={String(claim.claimId)} data-claim={String(claim.claimId)}>
                {`${claim.assertion}（修订 ${String(claim.revision)}｜${claim.state.basis}/${claim.state.validity}）`}
              </li>
            ))}
          </ul>
        ) : null}
        {activeTab === "report" ? (
          <ul>
            {claimRows.map((claim) => (
              <li key={String(claim.claimId)} data-coverage={String(claim.claimId)}>
                {coverageLine(claim)}
              </li>
            ))}
          </ul>
        ) : null}
        {activeTab === "code" ? (
          candidate === null ? (
            <p data-code-empty>{codeNotice ?? "正在读取作业清单…"}</p>
          ) : (
            <div data-code-candidate={candidate.id}>
              <ul>
                {candidate.files.map((file) => (
                  <li key={file.id}>
                    <button type="button" data-code-file={file.id} onClick={() => void openFile(file.id)}>
                      {`${file.path}（${file.language}，${String(file.byteLength)} 字节）`}
                    </button>
                  </li>
                ))}
              </ul>
              {codeNotice === null ? null : <p data-code-notice>{codeNotice}</p>}
              {source === null ? (
                <p data-code-note>选择一个文件读取正文。</p>
              ) : (
                <pre data-code-content data-code-file-id={source.fileId} data-code-sha256={source.sha256}>
                  {source.content}
                </pre>
              )}
            </div>
          )
        ) : null}
      </section>
      {mode === "list" ? (
        <table data-panel="list-view">
          <tbody>
            {list.map((row) => (
              <tr key={row.id}>
                <td>{row.label}</td>
                <td>{row.statusLine}</td>
                <td>{row.reasonLine}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <section aria-label="定向调查队列">
        <h2>已发起的定向调查（本地排队，尚未提交）</h2>
        <ul>{inquiries.map((inquiry, index) => <li key={`${String(inquiry.kind)}-${String(index)}`}>{JSON.stringify(inquiry)}</li>)}</ul>
      </section>
    </div>
  );
}

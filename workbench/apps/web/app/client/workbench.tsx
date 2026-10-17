"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls } from "@xyflow/react";
// React Flow ships its layout as CSS: without it the node boxes are not positioned and
// the edge layer never renders, so a canvas that looks populated can still show no
// relations at all. The browser pass found this by counting `.react-flow__edge` nodes.
import "@xyflow/react/dist/style.css";
import type { Edge, Node } from "@xyflow/react";

import { WorkbenchColumns } from "../../ui/panels.tsx";
import { buildMiddlePanel, buildLeftPanel, buildRightTabs, canvasEdges, directedInquiry, evidenceMetaLine, jobActionLine, jobActions, listView, pickCandidateSource, refusalFactsLine, refusalLine, relayData, SAMPLES_EMPTY_LINE, sampleDecisionLine, samplesPageOf, samplesRefusalLine, sampleIsDecidable, sampleLine, verificationRequestLine } from "../../ui/view-model.ts";
import type { SampleRow } from "../../ui/view-model.ts";
import type { CandidateDiscovery, DirectedInquiry, GraphEdgeView, GraphNodeView, JobLifecycleRow, LeftPanel, LifecycleAction, MiddleCell, RightTab } from "../../ui/view-model.ts";
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

// A refusal's `details` is the declared-safe subset the API published (§12.1): the reason plus
// whatever numbers the service named. This is where JSON becomes a typed value again, so the
// type test is the parse, not a defence against the server.
type RefusalBody = { error?: { code?: string; message?: string; details?: Record<string, unknown> } };

// Exported for the landing page's list: the same read path, so a second copy of the parse - and a
// second idea of what a refusal looks like - cannot appear beside this one.
export async function getJson(
  path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string; facts: Record<string, number | boolean> }> {
  const response = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) return refusalOf(response.status, payload);
  return { ok: true, value: payload };
}

// One parse of a refusal, shared by the read and the write below: this is where an unmodelled
// JSON body becomes a `reason` plus a swept `facts`, and two copies of the sweep would be two
// chances to disagree about what is safe to put on screen (§12.1).
function refusalOf(
  status: number,
  payload: unknown,
): { ok: false; status: number; reason: string; facts: Record<string, number | boolean> } {
  const details = (payload as RefusalBody | null)?.error?.details ?? {};
  const facts: Record<string, number | boolean> = {};
  for (const [name, value] of Object.entries(details)) {
    if (name === "reason") continue;
    if (typeof value === "number" || typeof value === "boolean") facts[name] = value;
  }
  return { ok: false, status, reason: typeof details["reason"] === "string" ? details["reason"] : "request-refused", facts };
}

// A state change the operator asked for. The CSRF token is the one this session was issued,
// read back over the same channel that reports whether it is paired: the API compares it against
// the session it holds, so a page that sent anything else gets a 403 naming the header.
async function postJson(
  path: string,
  body: unknown,
  csrf: string,
  // §8 line 261's keyed creations need an Idempotency-Key and the unkeyed ones must not send one:
  // a cancel's repeat-safety comes from §11's state machine, not from a journal. `null` therefore
  // means "no header", not "empty header".
  key: string | null = null,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string; facts: Record<string, number | boolean> }> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrf,
      accept: "application/json",
      ...(key === null ? {} : { "idempotency-key": key }),
    },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) return refusalOf(response.status, payload);
  return { ok: true, value: payload };
}

// The list view is the canvas substitute the acceptance row names, so it is always
// rendered; the interactive canvas is an extra surface on top of it when the operator asks
// for the picture instead of the table.
//
// "来源 N" used to queue a *draft* of reading the evidence, because there was no way to read
// it. §8 line 281 now has a route (issue #58), so the jump reads: the envelope shown here is
// the stored bytes, and the only thing left as a draft is what the source cannot yet tell us.

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

// The stored envelope the source jump fetched (§8 line 281, issue #58). A component of its
// own because the meta line is the same string in two places - the attribute a test reads and
// the words an operator reads - and it is computed once here rather than twice per render.
export type EvidenceView = {
  evidenceId: string;
  body: string;
  mediaType: string;
  byteLength: number;
  sha256: string | null;
};

export function EvidenceReader(props: { evidence: EvidenceView }): React.ReactElement {
  const line = evidenceMetaLine(props.evidence);
  return (
    <section aria-label="已读取的证据" data-evidence-reader={props.evidence.evidenceId}>
      <p data-evidence-meta={line}>{line}</p>
      <pre data-evidence-body>{props.evidence.body}</pre>
    </section>
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
  const [evidence, setEvidence] = useState<EvidenceView | null>(null);
  const [evidenceNotice, setEvidenceNotice] = useState<string | null>(null);
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>("unknown");
  const [mode, setMode] = useState<"canvas" | "list">("canvas");
  const [activeTab, setActiveTab] = useState<RightTab["id"]>("contract");
  const [samplesTarget, setSamplesTarget] = useState("");
  const [samples, setSamples] = useState<{ rows: SampleRow[]; inventoryRevision: number } | null>(null);
  const [samplesNotice, setSamplesNotice] = useState<string | null>(null);
  const [csrf, setCsrf] = useState("");
  const [jobsNotice, setJobsNotice] = useState<string | null>(null);
  const [verifyNotice, setVerifyNotice] = useState<string | null>(null);
  const [comparator, setComparator] = useState("");
  const [inquiries, setInquiries] = useState<DirectedInquiry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const health = await getJson("/api/v1/session");
    setSession(health.ok ? "paired" : "unpaired");
    if (!health.ok) {
      // Nothing below this line can be read without the session, so each panel says which of its
      // own states it is in rather than leaving one of them spinning at 正在读取 (the browser pass
      // caught the 样本 tab doing exactly that while the worker was stopped).
      setSamples(null);
      setSamplesNotice(SAMPLES_EMPTY_LINE["no-session"]);
      return;
    }
    const issued = relayData(health.value) as { csrfToken?: string } | null;
    setCsrf(typeof issued?.csrfToken === "string" ? issued.csrfToken : "");
    // The inventory is indexed per target (§5), so the page asks the project which targets it
    // has rather than guessing one from a graph node.
    const project = await getJson(`/api/v1/projects/${props.projectId}`);
    if (project.ok) {
      const view = (project.value as { targetIds?: string[]; inventoryRevision?: number } | null) ?? {};
      const first = view.targetIds?.[0];
      if (first === undefined) {
        setSamples(null);
        setSamplesNotice(SAMPLES_EMPTY_LINE["no-target"]);
      } else {
        setSamplesTarget(first);
        const page = await getJson(`/api/v1/projects/${props.projectId}/vectors?targetId=${first}`);
        if (page.ok) {
          const listed = samplesPageOf(page.value);
          setSamples({ rows: listed.rows, inventoryRevision: listed.inventoryRevision });
          setSamplesNotice(listed.rows.length === 0 ? SAMPLES_EMPTY_LINE["empty-page"] : null);
        } else {
          setSamples(null);
          setSamplesNotice(samplesRefusalLine("read", page.reason, page.facts));
        }
      }
    }
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

  // One decision, then a fresh read of the page it came from. The re-read is not decoration:
  // the inventory revision the next decision must name is the one this response reported, and a
  // row that still says draft after a 201 would be the page claiming a state the server does not
  // hold. A refusal keeps the row as it was and says which side of the conflict it disagrees on.
  const decideSample = useCallback(
    async (row: SampleRow, decision: "approved" | "rejected") => {
      if (csrf === "") {
        setSamplesNotice("还没有可用的会话令牌，先完成配对。");
        return;
      }
      const got = await postJson(
        `/api/v1/projects/${props.projectId}/vectors/${row.vectorId}/review`,
        { decision, expectedDigest: row.digest, expectedInventoryRevision: samples?.inventoryRevision ?? 0 },
        csrf,
      );
      if (!got.ok) {
        setSamplesNotice(samplesRefusalLine("decision", got.reason, got.facts));
        return;
      }
      const receipt = (relayData(got.value) as { auditSeq?: number; inventoryRevision?: number } | null) ?? {};
      setSamplesNotice(sampleDecisionLine(receipt, decision));
      const page = await getJson(`/api/v1/projects/${props.projectId}/vectors?targetId=${samplesTarget}`);
      if (page.ok) {
        const listed = samplesPageOf(page.value);
        setSamples({ rows: listed.rows, inventoryRevision: listed.inventoryRevision });
      }
    },
    [csrf, props.projectId, samples, samplesTarget],
  );

  // §8 lines 278-279: the two lifecycle doors, asked about one row at a time.
  //
  // Which row may be asked is `jobActions`' decision (the same function the tests pin), and what
  // the answer means is `jobActionLine`'s - including the case where the door says nothing was
  // re-scheduled, which is a real answer rather than a failure. Then the row is re-read from the
  // server: a page that kept showing 运行中 after the worker answered `cancelling` would be
  // displaying a state it never received.
  const runJobAction = useCallback(
    async (row: JobLifecycleRow, action: LifecycleAction) => {
      if (csrf === "") {
        setJobsNotice("还没有可用的会话令牌，先完成配对。");
        return;
      }
      // The cleanup retry is keyed per click (§8 line 279), so a second click on a row whose first
      // attempt was refused replays that answer instead of scheduling a second cleanup. A cancel
      // carries no key: its repeat-safety is §11's state machine.
      const key = action === "cleanup-retry" ? crypto.randomUUID() : null;
      const got = await postJson(
        `/api/v1/projects/${props.projectId}/jobs/${row.id}/${action === "cancel" ? "cancel" : "cleanup-retry"}`,
        {},
        csrf,
        key,
      );
      if (!got.ok) {
        setJobsNotice(refusalLine(action === "cancel" ? "取消请求被拒" : "清理重排被拒", got.reason, got.facts));
        return;
      }
      setJobsNotice(jobActionLine(action, (relayData(got.value) as Record<string, unknown> | null) ?? {}));
      const page = await getJson(`/api/v1/projects/${props.projectId}/jobs?limit=50`);
      if (page.ok) setJobs(page.value as JobsPagePayload);
    },
    [csrf, props.projectId],
  );

  // §8 line 297 from the browser. The comparator is typed by the operator because no door lists
  // the installed names (recorded on issue #58): the page deliberately does not guess one, and a
  // wrong name comes back as `comparator-policy-not-installed` with how many this build installs.
  const requestVerification = useCallback(
    async (candidateId: string) => {
      if (csrf === "") {
        setVerifyNotice("还没有可用的会话令牌，先完成配对。");
        return;
      }
      const got = await postJson(
        `/api/v1/projects/${props.projectId}/verifications`,
        { candidateId, comparatorPolicyId: comparator },
        csrf,
        crypto.randomUUID(),
      );
      if (!got.ok) {
        setVerifyNotice(refusalLine("验证请求被拒", got.reason, got.facts));
        return;
      }
      setVerifyNotice(verificationRequestLine((relayData(got.value) as Record<string, unknown> | null) ?? {}));
      const page = await getJson(`/api/v1/projects/${props.projectId}/jobs?limit=50`);
      if (page.ok) setJobs(page.value as JobsPagePayload);
    },
    [comparator, csrf, props.projectId],
  );

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

  const showEvidence = useCallback(
    async (evidenceId: string) => {
      const got = await getJson(`/api/v1/projects/${props.projectId}/evidence/${evidenceId}`);
      if (!got.ok) {
        setEvidence(null);
        const facts = refusalFactsLine(got.facts);
        setEvidenceNotice(facts === null ? `读取被拒：${got.reason}` : `读取被拒：${got.reason}（${facts}）`);
        return;
      }
      const view = got.value as { evidence: unknown; mediaType: string; byteLength: number; sha256: string | null };
      setEvidenceNotice(null);
      setEvidence({
        evidenceId,
        body: JSON.stringify(view.evidence, null, 2),
        mediaType: view.mediaType,
        byteLength: view.byteLength,
        sha256: view.sha256,
      });
    },
    [props.projectId],
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
      void showEvidence(first);
      return;
    }
    const inquiry = directedInquiry(cell);
    if (inquiry.ok) setInquiries((previous) => [...previous, inquiry.value]);
  }, [cells, showEvidence]);

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
        onJumpToEvidence={(evidenceId) => void showEvidence(evidenceId)}
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
        {activeTab === "samples" ? (
          samples === null ? (
            <p data-samples-empty>{samplesNotice ?? "正在读取库存…"}</p>
          ) : (
            <ul data-sample-list data-inventory-revision={samples.inventoryRevision}>
              {samples.rows.map((row) => (
                <li key={row.vectorId} data-sample={row.vectorId} data-sample-review={row.reviewStatus}>
                  <span>{sampleLine(row)}</span>
                  {sampleIsDecidable(row.reviewStatus) ? (
                    <>
                      <button type="button" data-sample-approve={row.vectorId} onClick={() => void decideSample(row, "approved")}>
                        批准
                      </button>
                      <button type="button" data-sample-reject={row.vectorId} onClick={() => void decideSample(row, "rejected")}>
                        驳回
                      </button>
                    </>
                  ) : (
                    <span data-sample-decided={row.reviewStatus}>已决定，正文不可改</span>
                  )}
                </li>
              ))}
              {samplesNotice === null ? null : <p data-samples-notice>{samplesNotice}</p>}
            </ul>
          )
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
              <div data-verification-request>
                <label htmlFor="comparator-policy">比较器策略名（§8 line 297 只收已安装的具名版本，不收代码）</label>
                <input
                  id="comparator-policy"
                  type="text"
                  autoComplete="off"
                  value={comparator}
                  onChange={(event) => setComparator(event.target.value)}
                />
                <button type="button" data-verify-request={candidate.id} onClick={() => void requestVerification(candidate.id)}>
                  发起验证
                </button>
                <span data-verify-empty={candidate.files.length === 0 ? "no-files" : "has-files"}>
                  {verifyNotice ?? "尚未发起验证：这道门只会排一个作业，不会给出结论。"}
                </span>
              </div>
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
      <section aria-label="作业与清理" data-panel="jobs">
        <h2>作业（§8 line 277 的清单；每行按 §11 的状态决定给不给按钮）</h2>
        {jobs === null ? (
          <p data-jobs-empty>{jobsNotice ?? "正在读取作业清单…"}</p>
        ) : (
          <ul>
            {jobs.items.map((job) => {
              const actions = jobActions(job);
              return (
                <li key={job.id} data-job={job.id} data-job-state={job.state} data-job-cleanup={job.cleanupState}>
                  <span>{`${job.kind}｜${job.state}｜清理 ${job.cleanupState}`}</span>
                  {actions.cancel ? (
                    <button type="button" data-job-cancel={job.id} onClick={() => void runJobAction(job, "cancel")}>
                      请求取消
                    </button>
                  ) : (
                    <span data-job-cancel-note={job.id}>{actions.cancelNote}</span>
                  )}
                  {actions.cleanupRetry ? (
                    <button type="button" data-job-cleanup-retry={job.id} onClick={() => void runJobAction(job, "cleanup-retry")}>
                      重排清理
                    </button>
                  ) : (
                    <span data-job-cleanup-note={job.id}>{actions.cleanupRetryNote}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {jobsNotice === null || jobs === null ? null : <p data-jobs-line>{jobsNotice}</p>}
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
      {evidence === null ? (evidenceNotice === null ? null : <p data-evidence-refused>{evidenceNotice}</p>) : null}
      {evidence === null ? null : <EvidenceReader evidence={evidence} />}
      <section aria-label="定向调查队列">
        <h2>已发起的定向调查（本地排队，尚未提交）</h2>
        <ul>{inquiries.map((inquiry, index) => <li key={`${String(inquiry.kind)}-${String(index)}`}>{JSON.stringify(inquiry)}</li>)}</ul>
      </section>
    </div>
  );
}

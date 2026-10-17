"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls } from "@xyflow/react";
// React Flow ships its layout as CSS: without it the node boxes are not positioned and
// the edge layer never renders, so a canvas that looks populated can still show no
// relations at all. The browser pass found this by counting `.react-flow__edge` nodes.
import "@xyflow/react/dist/style.css";
import type { Edge, Node } from "@xyflow/react";

import { WorkbenchColumns } from "../../ui/panels.tsx";
import { approvedContractIds, blueprintFreezeLine, buildMiddlePanel, buildLeftPanel, buildRightTabs, canvasEdges, captureDraftOf, captureProfileOptionsOf, captureSubjectLine, captureSubjectOf, CAPTURE_ACTION_OPTIONS, CAPTURE_LOCATOR_OPTIONS, CAPTURE_NETWORK_NOTE, CAPTURE_PROFILES_EMPTY_LINE, CAPTURE_PROFILES_UNREADABLE_LINE, CAPTURE_WAIT_STATE_OPTIONS, comparatorOptionsOf, directedInquiry, evidenceMetaLine, freezePanelOf, FREEZE_EMPTY_LINE, generatePanelOf, GENERATE_EMPTY_LINE, importReceiptLine, inspectClaimsNoteFor, inspectDraftOf, inspectSubjectLine, inspectSubjectOf, inspectTargetReadOf, inquiryQueueLine, INSPECT_CAPTURE_NOTE, INSPECT_SCOPE_OPTIONS, journalEntriesOf, PLAN_EXCLUSION_OPTIONS, PLAN_NO_CONTRACTS_LINE, PLAN_NO_JOURNAL_LINE, planBuildLine, planDraftOf, planSubjectLine, planSubjectOf, jobActionLine, jobActions, listView, pickCandidateSource, queuedJobLine, refusalFactsLine, refusalLine, relayData, SAMPLES_EMPTY_LINE, sampleDecisionLine, samplesPageOf, samplesRefusalLine, sampleIsDecidable, sampleLine, sessionGate, COMPARATOR_EMPTY_LINE, COMPARATOR_UNREADABLE_LINE, jobUpdateSignalOf, streamLineOf, targetDraftOf, targetReceiptLine, uploadDraftOf, verifyDraftOf } from "../../ui/view-model.ts";
import type { SampleRow } from "../../ui/view-model.ts";
import type { CandidateDiscovery, CaptureActionRow, CaptureProfileOption, PlanExclusionRow, ComparatorPolicyOption, DirectedInquiry, GraphEdgeView, GraphNodeView, InspectGraphFacts, InspectTargetRead, JobLifecycleRow, JournalEntryWire, LeftPanel, LifecycleAction, MiddleCell, RightTab } from "../../ui/view-model.ts";
// `Id` is a brand, not a runtime check: every value cast here arrived from the API, whose
// schemas validated the shape on the way out (§4). Importing `identity.ts` into a client
// component would also drag `node:crypto` into the browser bundle.
import type { Id } from "../../../../packages/domain/identity.ts";
import type { ClaimEvidenceState } from "../../../../packages/domain/evidence.ts";

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
// `error` is the safe projection the worker already sanitised (§12.1), never a raw message - and
// `details` is part of that projection, not an extra: it is where §8's ApiError keeps the numbers
// that separate "too big" from "not found" (issue #59). Dropping it from this type would put the
// page back to reading `failed` alone while the reply it already holds says `attempt 4 /
// maxAttempts 3`.
export type JobsPagePayload = {
  items: {
    id: string;
    kind: string;
    state: string;
    cleanupState: string;
    resultRef: string | null;
    error: { code: string; message: string; details?: Record<string, number | string | boolean> } | null;
  }[];
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
export async function postJson(
  path: string,
  body: unknown,
  csrf: string,
  // §8 line 261's keyed creations need an Idempotency-Key and the unkeyed ones must not send one:
  // a cancel's repeat-safety comes from §11's state machine, not from a journal. `null` therefore
  // means "no header", not "empty header".
  key: string | null = null,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string; facts: Record<string, number | boolean> }> {
  return post(path, csrf, key, { "content-type": "application/json" }, JSON.stringify(body));
}

// The same POST for a multipart body (§8 line 272's door reads `form.getAll("file")`). It is a second
// function only for the two headers: a `FormData` body must *not* carry a `content-type` written by
// us, because the boundary the browser generates is the one the parser reads, and a JSON-shaped
// header would ask the API to parse a file as a document.
export async function postForm(
  path: string,
  form: FormData,
  csrf: string,
  key: string,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string; facts: Record<string, number | boolean> }> {
  return post(path, csrf, key, {}, form);
}

// One owner for the request shape and the refusal parse of every write on this page: a second copy
// would be a second chance to send a state change without the CSRF header, or to decide on its own
// what a refusal is allowed to put on screen (§12.1, §14).
async function post(
  path: string,
  csrf: string,
  key: string | null,
  extraHeaders: Record<string, string>,
  body: BodyInit,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string; facts: Record<string, number | boolean> }> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "x-csrf-token": csrf,
      accept: "application/json",
      ...(key === null ? {} : { "idempotency-key": key }),
      ...extraHeaders,
    },
    body,
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

// A new action row starts with the two selects on their first legal option and every text box empty.
// The kind and locator are not security postures - they are what a row *is* - while the address, the
// locator's designator and the wait state are the operator's answer, and an unanswered one is refused
// by name (`captureActionOf`), not silently filled in.
const EMPTY_CAPTURE_ROW: CaptureActionRow = { kind: "click", locatorKind: "role", role: "", name: "", testId: "", value: "", waitState: "" };

// An exclusion row starts answering nothing, including no reason code: the two codes are different
// claims about the inventory (§7.4) and the page picking one would be the page deciding which claim an
// operator is making about somebody's sample.
const EMPTY_PLAN_EXCLUSION_ROW: PlanExclusionRow = { vectorId: "", reasonCode: "", reason: "", excludedBehavior: "", supersededBy: "" };

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
  // The installed comparator policies, read from the worker (issue #82). `null` means "the list did
  // not arrive", which is a different state from an empty array ("this build installs none"), and the
  // select shows its own sentence for each instead of being silently empty.
  const [comparators, setComparators] = useState<ComparatorPolicyOption[] | null>(null);
  // The journal is what tells this page which plans may be frozen and which blueprints may be
  // generated from (§8 gives no list route for either), so it is read like any other panel: null
  // means "not read", and the panel says so instead of offering an empty list.
  const [journal, setJournal] = useState<JournalEntryWire[] | null>(null);
  const [freezeNotice, setFreezeNotice] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadKind, setUploadKind] = useState("har");
  const [uploadDeadline, setUploadDeadline] = useState("");
  const [uploadSensitive, setUploadSensitive] = useState("");
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [stream, setStream] = useState<{ state: "connecting" | "open" | "closed"; seq: number | null }>({ state: "connecting", seq: null });
  const [generateNotice, setGenerateNotice] = useState<string | null>(null);
  const [inquiries, setInquiries] = useState<DirectedInquiry[]>([]);
  // §8 line 275's inspect half (issue #58's last control). The subject of the request is read, never
  // typed: the graph gives the target and the claim list, the target row gives the kind that decides
  // whether an inspect is legal against it, and the project row gives the concurrency token. `null`
  // means the read has not answered, which the panel says in its own sentence instead of offering an
  // empty form.
  const [inspectTarget, setInspectTarget] = useState<InspectTargetRead | null>(null);
  const [graphRevision, setGraphRevision] = useState<number | null>(null);
  const [inspectChosen, setInspectChosen] = useState<string[]>([]);
  const [inspectQuestion, setInspectQuestion] = useState("");
  const [inspectScope, setInspectScope] = useState("");
  const [inspectNotice, setInspectNotice] = useState<string | null>(null);
  // §8 line 275's capture half (issue #58's last handle). Three of these are reads rather than inputs:
  // the profile names come from health (§14's registry, the same one the door resolves against), the
  // target id from the project row, and its kind from that target's own row. Everything the operator
  // types is an address, a locator designator, a value, a timeout, a declared secret.
  const [captureProfiles, setCaptureProfiles] = useState<CaptureProfileOption[] | null>(null);
  const [captureTarget, setCaptureTarget] = useState<{ id: string; read: InspectTargetRead | null } | null>(null);
  const [captureProfileId, setCaptureProfileId] = useState("");
  const [captureStartUrl, setCaptureStartUrl] = useState("");
  const [captureRows, setCaptureRows] = useState<CaptureActionRow[]>([EMPTY_CAPTURE_ROW]);
  const [captureRequestBody, setCaptureRequestBody] = useState(false);
  const [captureResponseBody, setCaptureResponseBody] = useState(false);
  const [captureHeaderValues, setCaptureHeaderValues] = useState(false);
  const [captureTimeout, setCaptureTimeout] = useState("");
  const [captureSensitive, setCaptureSensitive] = useState("");
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  // §8 line 273's own control. It sits above the composer because it is what the composer's subject
  // read will pick up: a declaration makes this project's newest target the address a capture visits.
  const [declareUrl, setDeclareUrl] = useState("");
  const [declareNotice, setDeclareNotice] = useState<string | null>(null);
  // §8 line 289's plan builder. Every value it needs is read somewhere else on this page already - the
  // target row (kind *and* snapshot digest, one projection), the journal (which contracts are approved),
  // the sample page (the inventory this plan must account for) - so the operator only answers judgement:
  // which contracts, and for each excluded sample which of §7.4's two claims and about which behaviour.
  const [planChosen, setPlanChosen] = useState<string[]>([]);
  // Zero rows to start: §8 line 289's `exclusions` has no minimum and a plan that needs no exclusion is the
  // ordinary case, so the form must not force an answer. A row only exists once the operator adds one.
  const [planRows, setPlanRows] = useState<PlanExclusionRow[]>([]);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
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
      setComparators(null);
      setInspectTarget(null);
      setGraphRevision(null);
      setCaptureProfiles(null);
      setCaptureTarget(null);
      return;
    }
    const issued = relayData(health.value) as { csrfToken?: string } | null;
    setCsrf(typeof issued?.csrfToken === "string" ? issued.csrfToken : "");
    // The comparator names live in the worker's installed table, not in this bundle (issue #82):
    // read once with the page so the operator chooses from what exists instead of typing a guess at
    // a name the door will refuse.
    const policies = await getJson("/api/v1/comparator-policies");
    setComparators(policies.ok ? comparatorOptionsOf(relayData(policies.value)) : null);
    // The capture composer's profile names come from the same place the door resolves them (§14: health
    // publishes the effective profiles). A refusal leaves the list `null` - "read failed" - which is a
    // different sentence from "this build has no profile", and the panel keeps them apart.
    const profiles = await getJson("/api/v1/health");
    setCaptureProfiles(profiles.ok ? captureProfileOptionsOf(relayData(profiles.value)) : null);
    // The inventory is indexed per target (§5), so the page asks the project which targets it
    // has rather than guessing one from a graph node.
    const project = await getJson(`/api/v1/projects/${props.projectId}`);
    if (project.ok) {
      const view = (project.value as { targetIds?: string[]; inventoryRevision?: number; graphRevision?: number } | null) ?? {};
      // The directed-inspect request must carry this as its concurrency token, so it is kept from the
      // same read that lists the targets rather than a second one.
      setGraphRevision(typeof view.graphRevision === "number" ? view.graphRevision : null);
      const first = view.targetIds?.[0];
      // `targetIds` is the project's own newest-first list (§8 line 271), so `first` is "the target this
      // project last gained" - the one the 样本 inventory is indexed under and the one a capture would
      // visit. Two sections, one read, one value: a second way to pick a target would be a second owner
      // of the same fact, and the two would eventually disagree about which row the page is about.
      if (first === undefined) {
        setSamples(null);
        setSamplesNotice(SAMPLES_EMPTY_LINE["no-target"]);
        setCaptureTarget(null);
      } else {
        setSamplesTarget(first);
        // §8 line 306 makes the target's kind part of what a capture may be asked for (主动采集 must hit a
        // URL target), and only the row itself carries it - so the composer's subject is this id plus
        // this read, and a row that will not parse leaves `read` null rather than guessed.
        const row = await getJson(`/api/v1/projects/${props.projectId}/targets/${first}`);
        setCaptureTarget({ id: first, read: row.ok ? inspectTargetReadOf(row.value, first) : null });
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
    } else {
      // Without this row the page does not know the graph revision, and an inspect without the
      // concurrency token is a request the door cannot check — so the form says which read is missing
      // rather than carrying on with the number it saw last visit.
      setGraphRevision(null);
      setCaptureTarget(null);
    }
    const view = await getJson(`/api/v1/projects/${props.projectId}/graph`);
    if (!view.ok) {
      setError(view.reason);
      setInspectTarget(null);
      return;
    }
    const graphView = view.value as GraphViewPayload;
    setGraph(graphView);
    // The kind is what decides whether a directed inspect is legal against this target at all (§8: an
    // inspect reads imported bytes), and the graph view does not carry it — so the row is read from the
    // door that has it. A refusal here leaves the form saying 目标类型读不到 instead of assuming the
    // last one still applies.
    if (graphView.targetId === null) {
      setInspectTarget(null);
    } else {
      const row = await getJson(`/api/v1/projects/${props.projectId}/targets/${graphView.targetId}`);
      setInspectTarget(row.ok ? inspectTargetReadOf(row.value, graphView.targetId) : null);
    }
    // A journal refusal stops nothing else on the page: the two panels that depend on it say which
    // of their own emptinesses they are in, and everything else was already read.
    const journalPage = await getJson(`/api/v1/projects/${props.projectId}/audit?limit=100`);
    if (journalPage.ok) {
      setJournal(journalEntriesOf(journalPage.value));
    } else {
      setJournal(null);
      setFreezeNotice(refusalLine("决策日志读取被拒", journalPage.reason, journalPage.facts));
    }
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
      const samplesNoticeGate = sessionGate(csrf);
        if (!samplesNoticeGate.ok) {
          setSamplesNotice(samplesNoticeGate.line);
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

  // §13's stream, subscribed while the session is paired (issue #85). Before this the panel could
  // only be as fresh as its own last read, so a job the worker finished between two clicks stayed on
  // screen as `queued` - true of a snapshot, misleading as a status. One frame re-reads the whole
  // page rather than patching the row: the read doors are the page's only source of state, and a
  // panel that edited itself from an event would be showing what the event implied instead of what
  // the server will answer.
  useEffect(() => {
    if (session !== "paired") {
      setStream({ state: "connecting", seq: null });
      return;
    }
    const source = new EventSource(`/api/v1/projects/${props.projectId}/events`);
    source.addEventListener("open", () => setStream((previous) => ({ ...previous, state: "open" })));
    source.addEventListener("job.updated", (event) => {
      const signal = jobUpdateSignalOf((event as MessageEvent).data as string);
      if (signal === null) {
        // A frame the page cannot read is treated as a stream that stopped: the sentence below then
        // says the rows are a snapshot, which is the honest alternative to pretending nothing came.
        setStream((previous) => ({ ...previous, state: "closed" }));
        return;
      }
      setStream({ state: "open", seq: signal.seq });
      void load();
    });
    source.onerror = () => setStream((previous) => ({ ...previous, state: "closed" }));
    return () => source.close();
  }, [load, props.projectId, session]);

  // §8 lines 278-279: the two lifecycle doors, asked about one row at a time.
  //
  // Which row may be asked is `jobActions`' decision (the same function the tests pin), and what
  // the answer means is `jobActionLine`'s - including the case where the door says nothing was
  // re-scheduled, which is a real answer rather than a failure. Then the row is re-read from the
  // server: a page that kept showing 运行中 after the worker answered `cancelling` would be
  // displaying a state it never received.
  const runJobAction = useCallback(
    async (row: JobLifecycleRow, action: LifecycleAction) => {
      const gated = sessionGate(csrf);
      if (!gated.ok) {
        setJobsNotice(gated.line);
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

  // §8 line 297 from the browser. The comparator is chosen from the list this build installed
  // (issue #82) rather than typed at a name the door would refuse, and the page never picks one:
  // an unmade choice stops here with its own sentence, because defaulting to the looser policy is
  // §10's exact prohibition.
  const requestVerification = useCallback(
    async (candidateId: string) => {
      const draft = verifyDraftOf({ csrf, options: comparators, chosen: comparator });
      if (!draft.ok) {
        setVerifyNotice(draft.line);
        return;
      }
      const got = await postJson(
        `/api/v1/projects/${props.projectId}/verifications`,
        { candidateId, comparatorPolicyId: draft.comparatorPolicyId },
        csrf,
        crypto.randomUUID(),
      );
      if (!got.ok) {
        setVerifyNotice(refusalLine("验证请求被拒", got.reason, got.facts));
        return;
      }
      setVerifyNotice(queuedJobLine((relayData(got.value) as Record<string, unknown> | null) ?? {}, { kind: "verify", done: "已排入验证队列" }));
      const page = await getJson(`/api/v1/projects/${props.projectId}/jobs?limit=50`);
      if (page.ok) setJobs(page.value as JobsPagePayload);
    },
    [comparator, comparators, csrf, props.projectId],
  );

  // The subject a directed inspect may name, read out of the two reads that own it (issue #58). It is
  // computed once here so the sentence on the panel and the gate in front of the POST are literally the
  // same value — a panel that said 可发起 while its own submit refused would be the divergence this
  // file keeps getting told about.
  const inspectGraph = useMemo<InspectGraphFacts | null>(
    () => (graph === null ? null : { targetId: graph.targetId, claimIds: graph.claims.map((claim) => String(claim.claimId)) }),
    [graph],
  );
  const inspectSubject = inspectSubjectOf({ graph: inspectGraph, target: inspectTarget, graphRevision });
  // Whether the 首次分析 sentence may be printed at all - it speaks about a target, so an unread graph
  // or a project with no target shows nothing rather than an answered-looking line.
  const claimsNote = inspectClaimsNoteFor(inspectGraph);

  // The capture panel's subject, from the same function the submit's gate calls, so the line under the
  // heading and the reason a click refuses are one value: which row this capture would visit, at which
  // revision, and how many profiles the health read named.
  const captureSubject = useMemo(
    () => captureSubjectOf({ targetId: captureTarget?.id ?? null, target: captureTarget?.read ?? null, graphRevision, profiles: captureProfiles }),
    [captureProfiles, captureTarget, graphRevision],
  );

  // §8 line 275's inspect half from the browser. Nothing about the request is typed by the operator
  // except the question and the checks: the target comes from the graph read, its kind from the target
  // row, and the concurrency token from the project row — so a moved graph is the door's 409 naming
  // both revisions, not this page widening a scope it already sent. The key is per click (§8 line 261),
  // and the job list is re-read afterwards because the row the door wrote is the answer, not a
  // prediction of it.
  const requestInspect = useCallback(async () => {
    const draft = inspectDraftOf({
      csrf,
      graph: inspectGraph,
      target: inspectTarget,
      graphRevision,
      chosen: inspectChosen,
      question: inspectQuestion,
      scope: inspectScope,
    });
    if (!draft.ok) {
      setInspectNotice(draft.line);
      return;
    }
    const got = await postJson(`/api/v1/projects/${props.projectId}/jobs`, draft.body, csrf, crypto.randomUUID());
    if (!got.ok) {
      setInspectNotice(refusalLine("定向调查请求被拒", got.reason, got.facts));
      return;
    }
    setInspectNotice(
      queuedJobLine((relayData(got.value) as Record<string, unknown> | null) ?? {}, { kind: "inspect", done: "已排入定向调查" }),
    );
    const page = await getJson(`/api/v1/projects/${props.projectId}/jobs?limit=50`);
    if (page.ok) setJobs(page.value as JobsPagePayload);
  }, [csrf, graphRevision, inspectChosen, inspectGraph, inspectQuestion, inspectScope, inspectTarget, props.projectId]);

  // One row of the action list, patched in place. `map` by position rather than by value: two rows can
  // legitimately be identical (click the same button twice), so a value-keyed patch would edit both.
  const patchCaptureRow = useCallback((index: number, patch: Partial<CaptureActionRow>) => {
    setCaptureRows((previous) => previous.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)));
  }, []);

  // §8 line 275's capture half from the browser. Same rule as the inspect half above: the profile, the
  // target and the concurrency token are all read, so what the operator types is the address, the
  // locators, the values and the optional two fields - and `captureDraftOf` refuses before the socket
  // when any name the door requires has no answer. The key is per click (§8 line 261), and the job list
  // is re-read afterwards because the row the door wrote is the answer, not a prediction of it.
  const requestCapture = useCallback(async () => {
    const draft = captureDraftOf({
      csrf,
      targetId: captureTarget?.id ?? null,
      target: captureTarget?.read ?? null,
      graphRevision,
      profiles: captureProfiles,
      profileId: captureProfileId,
      startUrl: captureStartUrl,
      rows: captureRows,
      requestBody: captureRequestBody,
      responseBody: captureResponseBody,
      headerValues: captureHeaderValues,
      timeoutMs: captureTimeout,
      sensitiveValues: captureSensitive,
    });
    if (!draft.ok) {
      setCaptureNotice(draft.line);
      return;
    }
    const got = await postJson(`/api/v1/projects/${props.projectId}/jobs`, draft.body, csrf, crypto.randomUUID());
    if (!got.ok) {
      setCaptureNotice(refusalLine("采集请求被拒", got.reason, got.facts));
      return;
    }
    setCaptureNotice(
      queuedJobLine((relayData(got.value) as Record<string, unknown> | null) ?? {}, { kind: "capture", done: "已排入采集" }),
    );
    const page = await getJson(`/api/v1/projects/${props.projectId}/jobs?limit=50`);
    if (page.ok) setJobs(page.value as JobsPagePayload);
  }, [
    captureHeaderValues,
    captureProfileId,
    captureProfiles,
    captureRequestBody,
    captureResponseBody,
    captureRows,
    captureSensitive,
    captureStartUrl,
    captureTarget,
    captureTimeout,
    csrf,
    graphRevision,
    props.projectId,
  ]);

  // §8 line 273 from the browser. This is the one write control that needs no idempotency key - the
  // route registers `requiresIdempotencyKey: false`, because a declaration is not one of §8 line 261's
  // keyed creations - so `postJson` is called without one rather than with a fresh uuid that nothing
  // would read. The whole page is re-read afterwards for the same reason the upload door is: the new
  // target is the composer's subject only once the project row has said so, and a panel that edited
  // `targetIds` from a receipt would be showing what it predicted.
  const declareTarget = useCallback(async () => {
    const draft = targetDraftOf({ csrf, url: declareUrl });
    if (!draft.ok) {
      setDeclareNotice(draft.line);
      return;
    }
    const got = await postJson(`/api/v1/projects/${props.projectId}/targets`, draft.body, csrf);
    if (!got.ok) {
      setDeclareNotice(refusalLine("声明目标被拒", got.reason, got.facts));
      return;
    }
    setDeclareNotice(targetReceiptLine(relayData(got.value)));
    setDeclareUrl("");
    await load();
  }, [csrf, declareUrl, load, props.projectId]);

  // The plan panel's subject, from the same function its submit's gate calls, so the line under the
  // heading and the reason a click refuses are one value (`inventoryRevision` and the inventory ids both
  // come from the 样本 page read, and the contract list from the journal read - no second read of either).
  const planContracts = useMemo(() => (journal === null ? null : approvedContractIds(journal)), [journal]);
  const planInventory = useMemo(() => (samples === null ? null : samples.rows.map((row) => ({ id: row.vectorId, label: `${row.vectorId}｜${row.caseKey}｜${row.visibility}` }))), [samples]);
  const planSubject = useMemo(
    () =>
      planSubjectOf({
        targetId: captureTarget?.id ?? null,
        target: captureTarget?.read ?? null,
        inventoryRevision: samples?.inventoryRevision ?? null,
        contracts: planContracts,
      }),
    [captureTarget, planContracts, samples],
  );

  const patchPlanRow = useCallback((index: number, patch: Partial<PlanExclusionRow>) => {
    setPlanRows((previous) => previous.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)));
  }, []);

  // §8 line 289 from the browser, keyed per click (§8 line 261 lists plan creation). The whole page is
  // re-read afterwards for the same reason as the other creation doors: the plan row, its digest and the
  // audit entry are the worker's writes, and a panel that assembled them from the receipt would be
  // showing what it predicted.
  const buildPlan = useCallback(async () => {
    const draft = planDraftOf({
      csrf,
      targetId: captureTarget?.id ?? null,
      target: captureTarget?.read ?? null,
      inventoryRevision: samples?.inventoryRevision ?? null,
      contracts: planContracts,
      chosenContractIds: planChosen,
      inventoryIds: (samples?.rows ?? []).map((row) => row.vectorId),
      rows: planRows,
    });
    if (!draft.ok) {
      setPlanNotice(draft.line);
      return;
    }
    const got = await postJson(`/api/v1/projects/${props.projectId}/verification-plans`, draft.body, csrf, crypto.randomUUID());
    if (!got.ok) {
      setPlanNotice(refusalLine("造计划被拒", got.reason, got.facts));
      return;
    }
    setPlanNotice(planBuildLine((relayData(got.value) as Record<string, unknown> | null) ?? {}));
    await load();
  }, [csrf, captureTarget, load, planChosen, planContracts, planRows, props.projectId, samples]);

  // §8 line 272 from the browser: the file goes out as the multipart part the door names, with the
  // four fields it lists and nothing else. No client-side size or type gate is added on top - the
  // door answers a 5 MiB file with 413 naming `byteLength` and `maxBytes`, an unsupported media type
  // with 422 naming the three it takes, and an ASAR with declarations by distinguishing those two
  // cases itself - so the page shows the server's sentence rather than inventing an earlier one.
  const uploadCapture = useCallback(async () => {
    const gated = sessionGate(csrf);
    if (!gated.ok) {
      setUploadNotice(gated.line);
      return;
    }
    const drafted = uploadDraftOf({ file: uploadFile, kind: uploadKind, deadlineAt: uploadDeadline, sensitiveValues: uploadSensitive });
    if (!drafted.ok) {
      setUploadNotice(drafted.line);
      return;
    }
    const got = await postForm(`/api/v1/projects/${props.projectId}/imports`, drafted.form, csrf, crypto.randomUUID());
    if (!got.ok) {
      setUploadNotice(refusalLine("采集上传被拒", got.reason, got.facts));
      return;
    }
    setUploadNotice(importReceiptLine((relayData(got.value) as Record<string, unknown> | null) ?? {}));
    setUploadFile(null);
    // The door made a target, a job and an inventory it has not shown yet, so the whole page is
    // re-read rather than patched from the receipt: a panel that edited its own rows from a 202
    // would be displaying what it predicted instead of what the worker wrote.
    await load();
  }, [csrf, load, props.projectId, uploadDeadline, uploadFile, uploadKind, uploadSensitive]);

  // §8 line 292 from the browser. The body is the plan id and nothing else, so the page asks the
  // journal which plan is freezable instead of letting an operator type one: the target, the
  // contracts and the graph revision are functions of that plan (contract comment in
  // `packages/contracts/blueprint.ts`), and a page that restated them would be deciding facts the
  // freeze re-reads server-side. The key is per click (§8 line 261's creation list), and the journal
  // is re-read after the answer so the row that was just frozen stops being offered.
  const freezeBlueprint = useCallback(
    async (planId: string) => {
      const freezeNoticeGate = sessionGate(csrf);
        if (!freezeNoticeGate.ok) {
          setFreezeNotice(freezeNoticeGate.line);
          return;
        }
      const got = await postJson(
        `/api/v1/projects/${props.projectId}/blueprints`,
        { verificationPlanId: planId },
        csrf,
        crypto.randomUUID(),
      );
      if (!got.ok) {
        setFreezeNotice(refusalLine("蓝图冻结被拒", got.reason, got.facts));
        return;
      }
      setFreezeNotice(blueprintFreezeLine((relayData(got.value) as Record<string, unknown> | null) ?? {}));
      const page = await getJson(`/api/v1/projects/${props.projectId}/audit?limit=100`);
      if (page.ok) setJournal(journalEntriesOf(page.value));
    },
    [csrf, props.projectId],
  );

  // §8 line 294 from the browser, one turn after the freeze that made the blueprint. The answer is a
  // queued job, so the notice says queued and the 作业 panel is re-read - the worker's own runner is
  // what turns that row into a candidate, and a page that claimed 已生成 here would be reading a
  // verdict out of a receipt that only promised work (§10).
  const requestGeneration = useCallback(
    async (blueprintId: string) => {
      const generateNoticeGate = sessionGate(csrf);
        if (!generateNoticeGate.ok) {
          setGenerateNotice(generateNoticeGate.line);
          return;
        }
      const got = await postJson(
        `/api/v1/projects/${props.projectId}/candidates`,
        { blueprintId },
        csrf,
        crypto.randomUUID(),
      );
      if (!got.ok) {
        setGenerateNotice(refusalLine("生成请求被拒", got.reason, got.facts));
        return;
      }
      setGenerateNotice(queuedJobLine((relayData(got.value) as Record<string, unknown> | null) ?? {}, { kind: "build", done: "已排队生成" }));
      const page = await getJson(`/api/v1/projects/${props.projectId}/jobs?limit=50`);
      if (page.ok) setJobs(page.value as JobsPagePayload);
    },
    [csrf, props.projectId],
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
          target: graph.targetId === null ? null : { id: graph.targetId as Id },
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
  const freeze = freezePanelOf(journal);
  const generate = generatePanelOf(journal);
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
          <>
            <ul>
              {claimRows.map((claim) => (
                <li key={String(claim.claimId)} data-claim={String(claim.claimId)}>
                  {`${claim.assertion}（修订 ${String(claim.revision)}｜${claim.state.basis}/${claim.state.validity}）`}
                </li>
              ))}
            </ul>
            <section aria-label="造验证计划" data-panel="plan-build">
              <h3>造一份验证计划（§8 line 289：勾已批准的契约，并为每一条排掉的样本写明是哪一种说法）</h3>
              <p data-plan-subject={planSubject.ok ? "ready" : "blocked"}>{planSubjectLine(planSubject)}</p>
              {planContracts === null ? (
                <p data-plan-contracts="unreadable">{PLAN_NO_JOURNAL_LINE}</p>
              ) : planContracts.length === 0 ? (
                <p data-plan-contracts="empty">{PLAN_NO_CONTRACTS_LINE}</p>
              ) : (
                <ul data-plan-contracts="list">
                  {planContracts.map((id) => (
                    <li key={id}>
                      <label>
                        <input
                          type="checkbox"
                          name="plan-contract"
                          data-plan-contract={id}
                          checked={planChosen.includes(id)}
                          onChange={(event) =>
                            setPlanChosen((previous) =>
                              event.target.checked ? [...previous, id] : previous.filter((entry) => entry !== id),
                            )
                          }
                        />
                        {`契约 ${id}`}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <h4>排除项</h4>
              <ol data-plan-rows={planRows.length}>
                {planRows.map((entry, index) => (
                  <li key={index} data-plan-row={index} data-plan-reason={entry.reasonCode === "" ? "unanswered" : entry.reasonCode}>
                    <label htmlFor={`plan-vector-${String(index)}`}>排掉哪一条样本</label>
                    <select
                      id={`plan-vector-${String(index)}`}
                      data-plan-vector={index}
                      value={entry.vectorId}
                      onChange={(event) => patchPlanRow(index, { vectorId: event.target.value })}
                    >
                      <option value="">（还没有选：这一格不给默认值）</option>
                      {(planInventory ?? []).map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <label htmlFor={`plan-reason-code-${String(index)}`}>哪一种说法</label>
                    <select
                      id={`plan-reason-code-${String(index)}`}
                      data-plan-reason-code={index}
                      value={entry.reasonCode}
                      onChange={(event) => patchPlanRow(index, { reasonCode: event.target.value, supersededBy: "" })}
                    >
                      <option value="">（还没有选：两类理由是两件不同的事）</option>
                      {PLAN_EXCLUSION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <label htmlFor={`plan-reason-${String(index)}`}>理由（reason）</label>
                    <input id={`plan-reason-${String(index)}`} data-plan-reason={index} type="text" value={entry.reason} onChange={(event) => patchPlanRow(index, { reason: event.target.value })} />
                    <label htmlFor={`plan-behavior-${String(index)}`}>被排掉的行为（excludedBehavior）</label>
                    <input id={`plan-behavior-${String(index)}`} data-plan-behavior={index} type="text" value={entry.excludedBehavior} onChange={(event) => patchPlanRow(index, { excludedBehavior: event.target.value })} />
                    {/* The successor is a fact only the `superseded` claim carries, and §7.4 forbids the
                        pairing the other way round - so the box appears for one code and not the other,
                        rather than being a field the operator has to remember to leave alone. */}
                    {entry.reasonCode === "superseded" ? (
                      <>
                        <label htmlFor={`plan-successor-${String(index)}`}>被哪一条取代</label>
                        <select
                          id={`plan-successor-${String(index)}`}
                          data-plan-successor={index}
                          value={entry.supersededBy}
                          onChange={(event) => patchPlanRow(index, { supersededBy: event.target.value })}
                        >
                          <option value="">（还没有选：要说清是哪一行取代了它）</option>
                          {(planInventory ?? []).map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </>
                    ) : null}
                    <button type="button" data-plan-row-remove={index} onClick={() => setPlanRows((previous) => previous.filter((_, position) => position !== index))}>
                      删掉这一条排除
                    </button>
                  </li>
                ))}
              </ol>
              <button type="button" data-plan-row-add onClick={() => setPlanRows((previous) => [...previous, EMPTY_PLAN_EXCLUSION_ROW])}>
                加一条排除
              </button>
              <button type="button" data-plan-submit onClick={() => void buildPlan()}>
                造计划
              </button>
              <span data-plan-notice>{planNotice ?? "尚未造计划：这一发只写一份草稿计划，批准要另走 §8 line 291。"}</span>
            </section>
            <section aria-label="蓝图冻结" data-panel="blueprint-freeze">
              <h3>冻结蓝图（§8 line 292：只收已批准计划的 id）</h3>
              {freeze.state === "ready" ? (
                <ul>
                  {freeze.plans.map((planId) => (
                    <li key={planId} data-plan-freezable={planId}>
                      <button type="button" data-blueprint-freeze={planId} onClick={() => void freezeBlueprint(planId)}>
                        冻结该计划为蓝图
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p data-freeze-empty>{FREEZE_EMPTY_LINE[freeze.state]}</p>
              )}
              {freezeNotice === null ? null : <p data-freeze-notice>{freezeNotice}</p>}
            </section>
            <section aria-label="发起生成" data-panel="generation-request">
              <h3>发起生成（§8 line 294：一道门只排作业，不给结论）</h3>
              {generate.state === "ready" ? (
                <ul>
                  {generate.blueprints.map((blueprintId) => (
                    <li key={blueprintId} data-blueprint-generatable={blueprintId}>
                      <button type="button" data-candidate-generate={blueprintId} onClick={() => void requestGeneration(blueprintId)}>
                        为该蓝图发起一次生成
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p data-generate-empty>{GENERATE_EMPTY_LINE[generate.state]}</p>
              )}
              {generateNotice === null ? null : <p data-generate-notice>{generateNotice}</p>}
            </section>
          </>
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
          <>
            <section aria-label="上传采集" data-panel="capture-upload">
              <h3>上传一次采集（§8 line 272：文件、kind、可选期限与敏感值）</h3>
              <input type="file" name="capture-file" data-upload-file onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} />
              <select aria-label="采集类型" name="capture-kind" data-upload-kind value={uploadKind} onChange={(event) => setUploadKind(event.target.value)}>
                <option value="har">har</option>
                <option value="asar">asar</option>
              </select>
              <input aria-label="截止时间" name="capture-deadline" data-upload-deadline type="text" placeholder="deadlineAt（可空）" value={uploadDeadline} onChange={(event) => setUploadDeadline(event.target.value)} />
              <input aria-label="敏感值" name="upload-sensitive" data-upload-sensitive type="text" placeholder="敏感值，逗号分隔（可空）" value={uploadSensitive} onChange={(event) => setUploadSensitive(event.target.value)} />
              <button type="button" data-upload-send onClick={() => void uploadCapture()}>
                上传
              </button>
              {uploadNotice === null ? null : <p data-upload-notice>{uploadNotice}</p>}
            </section>
            {samples === null ? (
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
            )}
          </>
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
                <label htmlFor="comparator-policy">比较器策略（§8 line 297 只收已安装的具名版本，不收代码；名单由 worker 答，页面不替你选）</label>
                <select
                  id="comparator-policy"
                  value={comparator}
                  disabled={comparators === null || comparators.length === 0}
                  data-comparator-list={comparators === null ? "unreadable" : comparators.length === 0 ? "empty" : "ready"}
                  onChange={(event) => setComparator(event.target.value)}
                >
                  <option value="">（还没有选：页面不默认任何一档）</option>
                  {(comparators ?? []).map((option) => (
                    <option key={option.policyId} value={option.policyId}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {comparators === null ? (
                  <span data-comparator-notice>{COMPARATOR_UNREADABLE_LINE}</span>
                ) : comparators.length === 0 ? (
                  <span data-comparator-notice>{COMPARATOR_EMPTY_LINE}</span>
                ) : null}
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
        <p data-jobs-stream>{streamLineOf(stream.state, stream.seq)}</p>
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
      <section aria-label="定向调查" data-panel="directed-inspect">
        <h2>定向调查（§8 line 275：一道门只排作业，不给结论）</h2>
        <p data-inspect-subject={inspectSubject.ok ? "ready" : "blocked"}>{inspectSubjectLine(inspectSubject, graph?.truncated ?? false)}</p>
        <p data-inspect-capture-note>{INSPECT_CAPTURE_NOTE}</p>
        <h3>这一发问的是哪几条主张</h3>
        {/* Three states, and the first one shows no list at all: with no graph read there is nothing to
            offer, and printing the 首次分析 note there would claim this target holds no claims — a fact
            about the project the page has not read. */}
        {inspectGraph !== null && inspectGraph.claimIds.length > 0 ? (
          <ul data-inspect-claims="list">
            {(graph?.claims ?? []).map((claim) => (
              <li key={String(claim.claimId)}>
                <label>
                  <input
                    type="checkbox"
                    name="inspect-claim"
                    data-inspect-claim={String(claim.claimId)}
                    checked={inspectChosen.includes(String(claim.claimId))}
                    onChange={(event) =>
                      setInspectChosen((previous) =>
                        event.target.checked
                          ? [...previous, String(claim.claimId)]
                          : previous.filter((entry) => entry !== String(claim.claimId)),
                      )
                    }
                  />
                  {`${claim.assertion}（修订 ${String(claim.revision)}｜${coverageLine(claim)}）`}
                </label>
              </li>
            ))}
          </ul>
        ) : claimsNote === null ? null : (
          <p data-inspect-claims="none">{claimsNote}</p>
        )}
        <label htmlFor="inspect-question">问题（§8 要求非空 question）</label>
        <textarea
          id="inspect-question"
          data-inspect-question
          value={inspectQuestion}
          onChange={(event) => setInspectQuestion(event.target.value)}
        />
        <label htmlFor="inspect-scope">调查口径</label>
        <select
          id="inspect-scope"
          data-inspect-scope={inspectSubject.ok ? "ready" : "blocked"}
          value={inspectScope}
          onChange={(event) => setInspectScope(event.target.value)}
        >
          <option value="">（还没有选：页面不默认任何一档）</option>
          {INSPECT_SCOPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button type="button" data-inspect-submit onClick={() => void requestInspect()}>
          发起定向调查
        </button>
        <span data-inspect-notice>{inspectNotice ?? "尚未发起：这一发只会排一个作业，不会给出结论。"}</span>
        <h3>点过的格子缺口（记录，不是请求）</h3>
        {inquiries.length === 0 ? (
          <p data-inquiry-empty>还没有点过任何格子：画布或列表里挑一格，它缺什么会记在这里。</p>
        ) : (
          <ul>{inquiries.map((inquiry, index) => <li key={`${String(inquiry.kind)}-${String(index)}`} data-inquiry={String(inquiry.kind)}>{inquiryQueueLine(inquiry)}</li>)}</ul>
        )}
      </section>
      <section aria-label="声明一个 URL 目标" data-panel="target-declare">
        <h2>声明一个 URL 目标（§8 line 273：这一发只要一个地址）</h2>
        <label htmlFor="declare-url">要访问的地址（凭据、片段与非 http(s) 协议都会被具名拒收，页面与门口用的是同一条规则）</label>
        <input id="declare-url" data-declare-url type="text" autoComplete="off" value={declareUrl} onChange={(event) => setDeclareUrl(event.target.value)} />
        <button type="button" data-declare-submit onClick={() => void declareTarget()}>
          声明目标
        </button>
        <span data-declare-notice>{declareNotice ?? "尚未声明：这一发只写一行目标，不会去访问任何东西。"}</span>
      </section>
      <section aria-label="发起一次采集" data-panel="capture-compose">
        <h2>发起一次采集（§8 line 275 的 capture 半边：同样只排作业，不给结论）</h2>
        <p data-capture-subject={captureSubject.ok ? "ready" : "blocked"}>{captureSubjectLine(captureSubject)}</p>
        <label htmlFor="capture-profile">生效 profile（§14：它固定沙箱、镜像摘要与限额，名单由 health 答，页面不替你挑）</label>
        <select
          id="capture-profile"
          data-capture-profile={captureProfiles === null ? "unreadable" : captureProfiles.length === 0 ? "empty" : "ready"}
          value={captureProfileId}
          disabled={captureProfiles === null || captureProfiles.length === 0}
          onChange={(event) => setCaptureProfileId(event.target.value)}
        >
          <option value="">（还没有选：这一格没有默认值）</option>
          {(captureProfiles ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {captureProfiles === null ? (
          <span data-capture-profile-notice>{CAPTURE_PROFILES_UNREADABLE_LINE}</span>
        ) : captureProfiles.length === 0 ? (
          <span data-capture-profile-notice>{CAPTURE_PROFILES_EMPTY_LINE}</span>
        ) : null}
        <label htmlFor="capture-start-url">起点地址（startUrl：要访问的站点，§8 要求落在所选目标的授权范围内）</label>
        <input id="capture-start-url" data-capture-start-url type="text" value={captureStartUrl} onChange={(event) => setCaptureStartUrl(event.target.value)} />
        <h3>动作序列（§8 只收 click / fill / waitFor，定位只收 role 与 testId；不收 JS、shell、任意 Playwright 表达式）</h3>
        <ol data-capture-rows={captureRows.length}>
          {captureRows.map((entry, index) => (
            <li key={index} data-capture-row={index} data-capture-kind={entry.kind} data-capture-locator={entry.locatorKind}>
              <label htmlFor={`capture-kind-${String(index)}`}>动作</label>
              <select id={`capture-kind-${String(index)}`} value={entry.kind} onChange={(event) => patchCaptureRow(index, { kind: event.target.value })}>
                {CAPTURE_ACTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <label htmlFor={`capture-locator-${String(index)}`}>定位方式</label>
              <select id={`capture-locator-${String(index)}`} value={entry.locatorKind} onChange={(event) => patchCaptureRow(index, { locatorKind: event.target.value })}>
                {CAPTURE_LOCATOR_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {entry.locatorKind === "role" ? (
                <>
                  <label htmlFor={`capture-role-${String(index)}`}>角色（role）</label>
                  <input id={`capture-role-${String(index)}`} data-capture-role={index} type="text" value={entry.role} onChange={(event) => patchCaptureRow(index, { role: event.target.value })} />
                  <label htmlFor={`capture-name-${String(index)}`}>名称（name）</label>
                  <input id={`capture-name-${String(index)}`} data-capture-name={index} type="text" value={entry.name} onChange={(event) => patchCaptureRow(index, { name: event.target.value })} />
                </>
              ) : (
                <>
                  <label htmlFor={`capture-testid-${String(index)}`}>testId</label>
                  <input id={`capture-testid-${String(index)}`} data-capture-testid={index} type="text" value={entry.testId} onChange={(event) => patchCaptureRow(index, { testId: event.target.value })} />
                </>
              )}
              {/* The two fields that exist only for one kind each: a `click` has no value to fill, and a
                  `waitFor` without a stated state is an unanswered question - so the row shows what its
                  own kind can carry and nothing else. */}
              {entry.kind === "fill" ? (
                <>
                  <label htmlFor={`capture-value-${String(index)}`}>填入值（value：留空就是把这一格清空）</label>
                  <input id={`capture-value-${String(index)}`} data-capture-value={index} type="text" value={entry.value} onChange={(event) => patchCaptureRow(index, { value: event.target.value })} />
                </>
              ) : null}
              {entry.kind === "waitFor" ? (
                <>
                  <label htmlFor={`capture-wait-${String(index)}`}>等到</label>
                  <select id={`capture-wait-${String(index)}`} data-capture-wait={index} value={entry.waitState} onChange={(event) => patchCaptureRow(index, { waitState: event.target.value })}>
                    <option value="">（还没有选：等到哪一种状态也是这一发要说的）</option>
                    {CAPTURE_WAIT_STATE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
              <button type="button" data-capture-row-remove={index} onClick={() => setCaptureRows((previous) => previous.filter((_, position) => position !== index))}>
                删掉这一行
              </button>
            </li>
          ))}
        </ol>
        <button type="button" data-capture-row-add onClick={() => setCaptureRows((previous) => [...previous, EMPTY_CAPTURE_ROW])}>
          加一行动作
        </button>
        <h3>网络正文要记哪几格</h3>
        <p data-capture-network-note>{CAPTURE_NETWORK_NOTE}</p>
        <label htmlFor="capture-request-body">
          <input id="capture-request-body" data-capture-request-body type="checkbox" checked={captureRequestBody} onChange={(event) => setCaptureRequestBody(event.target.checked)} />
          请求正文（requestBody）
        </label>
        <label htmlFor="capture-response-body">
          <input id="capture-response-body" data-capture-response-body type="checkbox" checked={captureResponseBody} onChange={(event) => setCaptureResponseBody(event.target.checked)} />
          响应正文（responseBody）
        </label>
        <label htmlFor="capture-header-values">
          <input id="capture-header-values" data-capture-header-values type="checkbox" checked={captureHeaderValues} onChange={(event) => setCaptureHeaderValues(event.target.checked)} />
          header 值（headerValues）
        </label>
        <label htmlFor="capture-timeout">运行时长上限（timeoutMs 毫秒，可空）</label>
        <input id="capture-timeout" data-capture-timeout type="text" value={captureTimeout} onChange={(event) => setCaptureTimeout(event.target.value)} />
        <label htmlFor="capture-sensitive">短期敏感值（逗号分隔，可空：只在这一次任务里存在，不落库、不进请求摘要）</label>
        <input id="capture-sensitive" data-capture-sensitive type="text" autoComplete="off" value={captureSensitive} onChange={(event) => setCaptureSensitive(event.target.value)} />
        <button type="button" data-capture-submit onClick={() => void requestCapture()}>
          发起采集
        </button>
        <span data-capture-notice>{captureNotice ?? "尚未发起：这一发只会排一个采集作业，不会给出结论。"}</span>
      </section>
    </div>
  );
}

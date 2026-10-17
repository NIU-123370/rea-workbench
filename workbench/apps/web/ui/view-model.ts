import type { ClaimEvidenceState, Coverage, DisplayStatus, ProjectedStatus } from "../../../packages/domain/evidence.ts";
import { projectClaim, projectRequiredClaims } from "../../../packages/domain/evidence.ts";
import type { Id } from "../../../packages/domain/identity.ts";
// `id.ts` rather than `identity.ts`: this module is reached from the browser bundle, and the
// identity module owns `newId()`, which imports `node:crypto`.
import { isId } from "../../../packages/domain/id.ts";
import type { Digest } from "../../../packages/domain/canonical-json.ts";
import type { JsonValue } from "../../../packages/domain/json-value.ts";
// The §11 vocabulary comes from the node-free owner (`domain/job-states.ts`) rather than from the
// contract that re-exports it: reaching it through `contracts/primitives.ts` would pull
// `node:crypto` into the browser bundle, which is the same reason this file imports `id.ts`
// instead of `identity.ts`.
import { JOB_STATES, isTerminalJobState } from "../../../packages/domain/job-states.ts";
import type { JobState } from "../../../packages/domain/job-states.ts";

// The three-column workbench surface (PRD F04, DESIGN §6, issue #18).
//
// This file owns only what a screen has to decide *in addition to* the domain
// projection: how a status is presented so that colour is never the only channel,
// which panel a fact belongs to, what a list view needs to be a real substitute for
// the canvas, and what "I do not know this yet" turns into when an operator asks.
//
// It deliberately does not recompute SEEN / INFERRED / UNKNOWN. `projectClaim` and
// `projectRequiredClaims` are the single owner of that judgement (§6), and an edge
// keeps being judged by its own claim.

export type StatusPresentation = {
  label: string;
  icon: string;
  // The colour is an enhancement, so the text and the glyph are required, and a
  // screen reader gets the reasons list rather than a hue.
  tone: "positive" | "caution" | "negative";
  reasons: string[];
};

const PRESENTATION: Record<DisplayStatus, { label: string; icon: string; tone: StatusPresentation["tone"] }> = {
  SEEN: { label: "已观察", icon: "✓", tone: "positive" },
  INFERRED: { label: "推断", icon: "◐", tone: "caution" },
  UNKNOWN: { label: "未知", icon: "?", tone: "negative" },
};

export function presentStatus(status: ProjectedStatus): StatusPresentation {
  const fixed = PRESENTATION[status.status];
  return {
    label: fixed.label,
    icon: fixed.icon,
    tone: fixed.tone,
    reasons: [...status.reasons],
  };
}

export type GraphNodeView = {
  id: string;
  kind: string;
  label: string;
  targetId: Id;
  claimIds: Id[];
  evidenceIds: string[];
  contractRevisionIds: Id[];
  coverage: Coverage;
};

export type GraphEdgeView = {
  id: string;
  from: string;
  to: string;
  relation: string;
  claimId: Id;
};

export type MiddleCell = {
  id: string;
  role: "node" | "edge";
  label: string;
  presentation: StatusPresentation;
  claimIds: Id[];
  // §6: only references leave here. Envelope bodies are read through their own
  // authorized endpoint, so a graph panel cannot become a side channel for a body.
  evidenceJumpTargets: string[];
  contractJumpTargets: Id[];
};

export type CanvasFailure = { code: "GRAPH_VIEW_INCOMPLETE"; reason: string; missing: string[] };

// Claims arrive as a lookup rather than as denormalized fields on a node: the row is
// the owner of validity, basis, source and coverage, and a panel that guessed them
// would be a second semantic source (§5).
export type ClaimLookup = (claimId: Id) => ClaimEvidenceState | null;

export function buildMiddlePanel(input: {
  nodes: readonly GraphNodeView[];
  edges: readonly GraphEdgeView[];
  requiredClaimsOfNode: (node: GraphNodeView) => readonly ClaimEvidenceState[];
  claimOfEdge: ClaimLookup;
}): { cells: MiddleCell[]; failures: CanvasFailure[] } {
  const cells: MiddleCell[] = [];
  const failures: CanvasFailure[] = [];

  for (const node of input.nodes) {
    const required = input.requiredClaimsOfNode(node);
    const status = projectRequiredClaims(required);
    cells.push({
      id: node.id,
      role: "node",
      label: node.label,
      presentation: presentStatus(status),
      claimIds: [...node.claimIds],
      evidenceJumpTargets: [...node.evidenceIds],
      contractJumpTargets: [...node.contractRevisionIds],
    });
  }

  for (const edge of input.edges) {
    const claim = input.claimOfEdge(edge.claimId);
    if (claim === null) {
      // An edge whose claim cannot be read is a visible refusal, not an uncoloured
      // line: the alternative is a canvas that quietly shows nothing for a relation
      // the operator would otherwise assume was settled.
      failures.push({
        code: "GRAPH_VIEW_INCOMPLETE",
        reason: "edge-claim-unreadable",
        missing: [edge.id, edge.claimId],
      });
      continue;
    }
    cells.push({
      id: edge.id,
      role: "edge",
      label: `${edge.from} —${edge.relation}→ ${edge.to}`,
      // The edge's own claim only. `projectRequiredClaims` is never consulted here,
      // which is what keeps §6's "an edge does not inherit a node's colour" true
      // even when both endpoints are SEEN.
      presentation: presentStatus(projectClaim(claim)),
      claimIds: [edge.claimId],
      evidenceJumpTargets: [],
      contractJumpTargets: [],
    });
  }
  return { cells, failures };
}

export type ListRow = {
  id: string;
  role: MiddleCell["role"];
  label: string;
  statusLine: string;
  reasonLine: string;
  // The same tone the canvas cell carries. Colour is an extra channel here, never the
  // only one: the icon and the word are in `statusLine` beside it (§6).
  tone: StatusPresentation["tone"];
  sourceCount: number;
  // The row carries the jump targets rather than only their count: a list that reports
  // "1 source" with nothing to press cannot satisfy "可跳 Evidence 来源".
  evidenceJumpTargets: string[];
  // `null` when the cell has no gap, or when the gap has no named next step (§6 refuses
  // to invent one).
  inquiry: DirectedInquiry | null;
};

// The list is the same data as the canvas, so switching views cannot change what a
// reviewer is told about a claim.
export function listView(cells: readonly MiddleCell[]): ListRow[] {
  return cells.map((cell) => {
    const inquiry = directedInquiry(cell);
    return {
      id: cell.id,
      role: cell.role,
      label: cell.label,
      statusLine: `${cell.presentation.icon} ${cell.presentation.label}`,
      reasonLine: cell.presentation.reasons.join(", ") || "—",
      tone: cell.presentation.tone,
      sourceCount: cell.evidenceJumpTargets.length,
      evidenceJumpTargets: cell.evidenceJumpTargets,
      inquiry: inquiry.ok ? inquiry.value : null,
    };
  });
}

// The canvas's own topology (issue #18).
//
// A React Flow edge names its endpoints by node id, and a cell id for an edge is the
// database row's id, not `from → to`. Deriving the endpoints from the label is what made a
// live canvas draw five nodes and no relations, so the endpoints come from the graph rows
// and an edge that cannot be placed is reported rather than quietly dropped.
export type CanvasEdge = { id: string; source: string; target: string; label: string };

export type CanvasDrop = { reason: string; missing: string[] };

export function canvasEdges(
  cells: readonly MiddleCell[],
  edges: readonly GraphEdgeView[],
): { drawn: CanvasEdge[]; dropped: CanvasDrop[] } {
  const nodeIds = new Set(cells.filter((cell) => cell.role === "node").map((cell) => cell.id));
  const edgeCells = new Set(cells.filter((cell) => cell.role === "edge").map((cell) => cell.id));
  const drawn: CanvasEdge[] = [];
  const dropped: CanvasDrop[] = [];
  for (const edge of edges) {
    if (!edgeCells.has(edge.id)) continue;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      dropped.push({ reason: "edge-endpoint-not-on-canvas", missing: [edge.id, edge.from, edge.to] });
      continue;
    }
    drawn.push({ id: edge.id, source: edge.from, target: edge.to, label: edge.relation });
  }
  return { drawn, dropped };
}

export type InquiryKind = "read-evidence" | "capture-new" | "inspect-runtime" | "review-claim";

export type DirectedInquiry = {
  kind: InquiryKind;
  subjectId: string;
  // What the answer is missing, in the words the gate used to refuse it.
  gaps: string[];
  request: JsonValue;
};

// An UNKNOWN is actionable only if the reason survives the trip. This maps the
// §6 reason vocabulary onto the one next step that could change it, and refuses to
// invent a step for a reason it does not know.
const INQUIRY_BY_REASON: Record<string, InquiryKind> = {
  "claim-without-source": "capture-new",
  "claim-stale": "read-evidence",
  "claim-contradicted": "review-claim",
  "authority-not-applicable": "inspect-runtime",
  "coverage-partial": "capture-new",
  "coverage-unknown": "inspect-runtime",
  "coverage-unavailable": "read-evidence",
  "basis-unknown": "inspect-runtime",
  "no-required-claims-in-scope": "review-claim",
};

export function directedInquiry(cell: MiddleCell): Result2<DirectedInquiry> {
  if (cell.presentation.reasons.length === 0) {
    return { ok: false, reason: "cell-has-no-gap" };
  }
  const kinds = new Set<InquiryKind>();
  const unknownReasons: string[] = [];
  for (const reason of cell.presentation.reasons) {
    const kind = INQUIRY_BY_REASON[reason];
    if (kind === undefined) {
      unknownReasons.push(reason);
      continue;
    }
    kinds.add(kind);
  }
  if (kinds.size === 0) {
    return { ok: false, reason: "reasons-unmapped", unknown: unknownReasons };
  }
  // One inquiry per kind: a reviewer should be able to see that a cell needs two
  // different kinds of work rather than a single blended task.
  const [first, ...rest] = [...kinds];
  if (first === undefined) return { ok: false, reason: "reasons-unmapped", unknown: unknownReasons };
  return {
    ok: true,
    value: {
      kind: first,
      subjectId: cell.id,
      gaps: [...cell.presentation.reasons],
      request: {
        subjectId: cell.id,
        targetId: null,
        kind: first,
        additionalKinds: rest,
        unmappedReasons: unknownReasons,
      },
    },
  };
}

type Result2<T> = { ok: true; value: T } | { ok: false; reason: string; unknown?: string[] };

export type LeftPanel = {
  taskId: string;
  taskState: string;
  viewLabel: string;
  // §6: limitations are shown next to the thing they limit, never as a footnote the
  // operator has to go looking for.
  limitations: string[];
  cleanupState: string | null;
  // The 画面 slot of the left column. An offline HAR import has no frames to show, and
  // saying so is the point: a missing preview must not read as "the capture produced
  // nothing worth looking at" (§6's honesty rule applied to the sandbox panel).
  frames: { count: number; note: string };
};

export function buildLeftPanel(input: {
  job: { id: Id; state: string; cleanupState: string; errorJson: JsonValue | null } | null;
  target: { id: Id; kind: string; snapshotDigest: Digest | null } | null;
  limitations: readonly string[];
  scopeLabel: string;
  frameLabels?: readonly string[];
}): LeftPanel | { reason: string } {
  if (input.job === null && input.target === null) {
    return { reason: "no-task-and-no-target" };
  }
  return {
    taskId: input.job === null ? `target:${input.target?.id ?? "none"}` : input.job.id,
    taskState: input.job === null ? "no-job" : input.job.state,
    viewLabel: input.scopeLabel,
    limitations: [...input.limitations],
    cleanupState: input.job?.cleanupState ?? null,
    frames: {
      count: (input.frameLabels ?? []).length,
      note: (input.frameLabels ?? []).length > 0 ? "见下方画面列表" : "无画面：本次导入只带请求与响应，没有预览帧",
    },
  };
}

export type RightTab = { id: "contract" | "code" | "report" | "samples"; label: string; enabled: boolean; disabledReason: string | null };

// The code tab is an Inspector authority question, not a layout question: a Builder
// that was handed generated or decompiled source would have received content the
// blueprint allowlist exists to keep away from it (§7.3).
export function buildRightTabs(actor: { isBuilder: boolean; hasBlueprint: boolean }): RightTab[] {
  return [
    { id: "contract", label: "契约", enabled: true, disabledReason: null },
    // The inventory is where a sample gets *decided on*, so it is a control-plane surface:
    // §7.3 keeps a Builder to the blueprint projection, and `vector.review` refuses that actor
    // by name. A disabled tab says which rule disabled it, in the same words the server uses.
    actor.isBuilder
      ? { id: "samples", label: "样本", enabled: false, disabledReason: "builder-may-not-decide-samples" }
      : { id: "samples", label: "样本", enabled: true, disabledReason: null },
    actor.isBuilder
      ? { id: "code", label: "代码", enabled: false, disabledReason: "builder-may-not-read-source" }
      : { id: "code", label: "代码", enabled: true, disabledReason: null },
    actor.isBuilder && !actor.hasBlueprint
      ? { id: "report", label: "报告", enabled: false, disabledReason: "builder-needs-a-frozen-blueprint" }
      : { id: "report", label: "报告", enabled: true, disabledReason: null },
  ];
}

// What the evidence reader says about the bytes it just fetched (§8 line 281). The digest
// half is a *stated fact*, not a gap: when the store withheld it, the line has to say that
// rather than leaving an empty field that reads like a truncated value (§4's rule for a
// nullable digest, applied where a person reads it).
export function evidenceMetaLine(input: { mediaType: string; byteLength: number; sha256: string | null }): string {
  return `${input.mediaType} · ${String(input.byteLength)} 字节 · sha256 ${input.sha256 ?? "未公开（见存储侧的保留原因）"}`;
}

// The numbers a refusal published beside its reason (§8's ApiError.details, §12.1 / issue #59).
// "too big" and "not found" are different operator problems, and the reason string alone tells
// the operator that something was refused, not which cap was crossed. Nothing is invented here:
// the input is already the declared-safe subset the API published, so this only orders and joins.
export function refusalFactsLine(facts: Record<string, number | boolean>): string | null {
  const names = Object.keys(facts).sort();
  if (names.length === 0) return null;
  return names.map((name) => `${name} ${String(facts[name] as number | boolean)}`).join(" · ");
}

// Which candidate the 代码 tab reads (DESIGN §8 lines 277 and 294, issue #55).
//
// §8 gives the page one way to name a candidate: the job list carries each row's persisted
// resultRef, and a successful generation's resultRef is the candidate id. So this is a scan
// of the page the server already ordered newest-first, not a guess from a blueprint or a
// digest. The resultRef still has to pass the id shape test before it can go into a path:
// `result_ref` is a TEXT column, and a value that is not an id is a broken row, not a route.
export type JobRowView = { id: string; kind: string; state: string; resultRef: string | null };

export type CandidateDiscovery =
  | { found: true; jobId: string; candidateId: string }
  | { found: false; reason: "job-page-empty" | "no-successful-build" | "result-ref-is-not-an-id" };

export function pickCandidateSource(jobs: readonly JobRowView[]): CandidateDiscovery {
  const builds = jobs.filter((job) => job.kind === "build" && job.state === "succeeded");
  if (jobs.length === 0) return { found: false, reason: "job-page-empty" };
  if (builds.length === 0) return { found: false, reason: "no-successful-build" };
  const latest = builds[0] as JobRowView;
  if (latest.resultRef === null || !isId(latest.resultRef)) {
    return { found: false, reason: "result-ref-is-not-an-id" };
  }
  return { found: true, jobId: latest.id, candidateId: latest.resultRef };
}

// --- The inventory surface (§8 line 283 with issue #58's review doors) -----------------
//
// A row of the inventory page, narrowed to what the operator decides with: which case, whether
// it is public, whether it is usable, and whether someone has decided on it yet. The digest is
// kept with it because `expectedDigest` is what makes the decision a compare-then-write rather
// than a blind overwrite - the page approves the bytes it is looking at.
// The inventory page's own row shape (§8 line 283): the id is `id`, and the review is an object
// with a `status`. The browser pass caught the first version of this file reading
// `vectorId`/`reviewStatus` off that payload, which rendered a list with zero rows and no error -
// the quiet failure a mapping without a test is good at.
export type VectorSummaryWire = {
  id: string;
  digest: string;
  caseKey: string;
  visibility: string;
  eligibility: string;
  review?: { status?: string } | null;
};

export type SampleRow = {
  vectorId: string;
  caseKey: string;
  digest: string;
  visibility: string;
  eligibility: string;
  reviewStatus: string;
};

// Only an undecided sample offers a button. An approved vector's body is immutable (§7.4), so a
// second decision would be a 409 the row could have predicted; showing the control anyway would
// be teaching the operator to press things that cannot work.
export function sampleIsDecidable(reviewStatus: string): boolean {
  return reviewStatus === "draft";
}

export function sampleLine(row: SampleRow): string {
  return `${row.caseKey}｜${row.visibility}｜${row.eligibility}｜${row.reviewStatus}`;
}

// The ways the 样本 tab can legitimately have no rows are different operator problems, and one
// generic 暂无 would hide which of them this is: no session means nothing was read at all, no
// capture target yet means there is nothing to list against, and a target with no rows means the
// inventory is genuinely empty for it. The browser pass found the first of these while the worker
// was stopped: the tab was still saying 正在读取 after the page had already reported 会话：unpaired.
export const SAMPLES_EMPTY_LINE: Record<"no-session" | "no-target" | "empty-page", string> = {
  "no-session": "还没有会话：库存要配对之后才读得到，用终端里打印的配对码建立会话。",
  "no-target": "本项目还没有目标：库存是按目标编的，先导入一次采集或建一个 URL 目标。",
  "empty-page": "该目标的库存里还没有样本：可以先读证据正文看捕获到了什么。",
};

// What a recorded decision says back. The receipt's numbers are the point (§8's
// ApiError.details, issue #59): the inventory revision is what the next decision must name, and
// the audit sequence is where the same decision can be re-read in the journal.
export function sampleDecisionLine(receipt: { inventoryRevision?: number; auditSeq?: number }, decision: string): string {
  const revision = receipt.inventoryRevision === undefined ? "" : `｜库存修订 ${String(receipt.inventoryRevision)}`;
  const audit = receipt.auditSeq === undefined ? "" : `｜日志 seq ${String(receipt.auditSeq)}`;
  return `已${decision === "approved" ? "批准" : "驳回"}该样本${revision}${audit}`;
}

// One mapping, one place: an unknown status is not decidable, so a row this page cannot read
// offers no button rather than guessing at the state it should have had.
export function sampleRowsOf(items: readonly VectorSummaryWire[]): SampleRow[] {
  return items.map((item) => ({
    vectorId: item.id,
    caseKey: item.caseKey,
    digest: item.digest,
    visibility: item.visibility,
    eligibility: item.eligibility,
    reviewStatus: item.review?.status ?? "unknown",
  }));
}

export type SamplesPage = { rows: SampleRow[]; inventoryRevision: number };

// The UI relay answers on behalf of the worker, and the worker's reply arrives under `data`
// (DESIGN §8's response envelope). Everything on this island that reads a reply therefore
// unwraps it the same way, once: a page that looked at the top level only would silently see an
// empty result instead of the data it asked for.
export function relayData(payload: unknown): unknown {
  return (payload as { data?: unknown } | null)?.data ?? payload;
}

// The page the relay answers with, read once per visit. Two things here are load-bearing and
// neither is visible from the client that calls it: the relay wraps the worker's reply in
// `{ data: … }`, and `inventoryRevision` is the number the *next* decision has to name (§8's
// optimistic-concurrency check). The first read and the re-read after a decision parse the same
// payload, so this is one function rather than two copies that can drift apart and leave the
// page holding a revision the server no longer has.
export function samplesPageOf(payload: unknown): SamplesPage {
  const listed = relayData(payload) as { items?: VectorSummaryWire[]; inventoryRevision?: number } | null;
  return { rows: sampleRowsOf(listed?.items ?? []), inventoryRevision: listed?.inventoryRevision ?? 0 };
}

// A refusal on this tab names the facts the server published with it (§8's ApiError.details,
// issue #59): `expected` and `actual` are the difference between "somebody decided first" and
// "this page held a stale revision", and those are different things to do about.
// A refusal the page shows: the reason the server named, plus whatever numbers it published with
// it (§8's ApiError.details, issue #59). One owner, because four panels each writing
// `reason（facts）` is four chances to disagree about what a refusal looks like - and the facts are
// the difference between "somebody decided first" and "this page held a stale revision".
export function refusalLine(head: string, reason: string, facts: Record<string, number | boolean>): string {
  const published = refusalFactsLine(facts);
  return published === null ? `${head}：${reason}` : `${head}：${reason}（${published}）`;
}

export function samplesRefusalLine(kind: "read" | "decision", reason: string, facts: Record<string, number | boolean>): string {
  return refusalLine(kind === "read" ? "库存读取被拒" : "决定被拒", reason, facts);
}

// --- The 作业 rows and the doors the page can honestly offer --------------------------------
//
// Three §8 routes became doors in earlier rounds (`POST /jobs/:j/cancel`,
// `POST /jobs/:j/cleanup-retry`, `POST /verifications`) with no control on the page that calls
// them, and one (`GET /projects`) that the landing page could not use to answer the only question
// an operator arriving fresh has: which projects are here. What follows is the whole of the
// judgement for those controls - which row may be asked, and what the answer means - so the
// browser island renders a decision this file can be tested on rather than inventing one inline.

// The state table and the terminal set are imported, not restated: §11's machine has one owner
// (`contracts/jobs.ts`), and a page-level copy would be a second list that can drift from the
// transitions the worker will actually accept.

export type LifecycleAction = "cancel" | "cleanup-retry";

export type JobLifecycleRow = { id: string; kind: string; state: string; cleanupState: string };

export type JobActions = {
  cancel: boolean;
  cleanupRetry: boolean;
  cancelNote: string | null;
  cleanupRetryNote: string | null;
};

// `cancel` is offered to a non-terminal row because §11 gives a terminal state no outgoing edge:
// the door would answer 202 with the state it is already in, so a button there would be asking the
// operator to click something whose outcome is fixed.
//
// `cleanup-retry` is *not* narrowed to rows whose `cleanupState` is `failed`, even though that is
// the common case: the door re-schedules the leases it can prove it minted (§5), and §11 keeps a
// job's cleanup state and its leases' states independent. The page cannot see the leases, so the
// only thing it may claim is what its own row says - and what the answer then reports is the truth.
export function jobActions(row: JobLifecycleRow): JobActions {
  // A state this page cannot name is treated like a terminal one: no button. That is the same rule
  // the 样本 tab follows for an unrecognised review status - the page does not guess at the state a
  // row "should" have had.
  const recognised = (JOB_STATES as readonly string[]).includes(row.state);
  const terminal = !recognised || isTerminalJobState(row.state as JobState);
  return {
    cancel: !terminal,
    cleanupRetry: row.cleanupState !== "complete",
    cancelNote: !recognised
      ? `这一行的状态「${row.state}」不在 §11 的作业状态表里，页面不认识它就不给按钮`
      : terminal
        ? `这一行已是终态 ${row.state}：§11 不让终态复活，取消只会返回现状`
        : null,
    cleanupRetryNote: row.cleanupState === "complete" ? "作业行的清理状态是 complete，没有要重排的清理" : null,
  };
}

// What each of the two doors answered, in the words the reply supports. An empty `leaseIds` is a
// real answer and has to read as one - "nothing of mine was unfinished" is not a failure, and
// dressing it up as one would teach the operator to distrust the button.
export function jobActionLine(action: LifecycleAction, record: { state?: unknown; cleanupState?: unknown; leaseIds?: unknown }): string {
  const state = typeof record.state === "string" ? record.state : null;
  const cleanupState = typeof record.cleanupState === "string" ? record.cleanupState : null;
  if (action === "cancel") {
    return state === null ? "取消已被接受，但回包没带状态" : `已请求取消，现在这一行是 ${state}`;
  }
  const leaseIds = Array.isArray(record.leaseIds) ? record.leaseIds : null;
  if (leaseIds === null) {
    return cleanupState === null ? "清理重排已被接受，但回包既没有 lease 清单也没有清理状态" : `已请求重排清理，现在这一行是 ${cleanupState}`;
  }
  if (leaseIds.length === 0) {
    return "已请求重排清理：没有可重排的清理（这扇门只回收自己发过的 staging，§5）";
  }
  return `已重排 ${String(leaseIds.length)} 个 lease${cleanupState === null ? "" : `，清理状态 ${cleanupState}`}`;
}

// The 202 body of §8 line 297 is a JobRecord, and the one thing worth saying about it is that
// this is work, not a verdict: naming the job and its state keeps the page from reading the
// success as a result.
// One owner for what a 202 JobRecord says back. §8 lines 294 and 297 answer with the same row
// shape, and a second copy of "read the id, check the kind, name the state" is how one of these
// doors ends up claiming the work already happened when the answer was only that it is queued.
export function queuedJobLine(
  record: { id?: unknown; state?: unknown; kind?: unknown },
  expected: { kind: string; done: string },
): string {
  const id = typeof record.id === "string" ? record.id : null;
  const state = typeof record.state === "string" ? record.state : null;
  const kind = typeof record.kind === "string" ? record.kind : null;
  if (id === null) return "请求已被接受，但回包没带作业 id";
  if (kind !== null && kind !== expected.kind) {
    return `回包的作业类型是 ${kind}，不是 ${expected.kind}——这一行不是本页问的那扇门答的`;
  }
  return `${expected.done}：作业 ${id}${state === null ? "" : `（${state}）`}`;
}

export type ProjectRow = { id: string; name: string; graphRevision: number; inventoryRevision: number };

// The landing page's list, read once per visit: the relay wraps the worker's reply in `{data: …}`,
// and `nextCursor` is the *server's* cursor, so a page that built one from the last row it saw
// would be minting a token it was never given.
export function projectsPageOf(payload: unknown): { rows: ProjectRow[]; nextCursor: string | null } {
  const listed = relayData(payload) as { items?: unknown[]; nextCursor?: unknown } | null;
  // A row that cannot be named is dropped rather than rendered with a guessed id: the only thing
  // the page does with one is turn it into a link, and a link to nowhere reads as a project that
  // exists.
  const rows = (Array.isArray(listed?.items) ? listed.items : []).flatMap((entry) => {
    const row = (entry ?? {}) as { id?: unknown; name?: unknown; graphRevision?: unknown; inventoryRevision?: unknown };
    if (typeof row.id !== "string" || typeof row.name !== "string") return [];
    return [{
      id: row.id,
      name: row.name,
      graphRevision: typeof row.graphRevision === "number" ? row.graphRevision : 0,
      inventoryRevision: typeof row.inventoryRevision === "number" ? row.inventoryRevision : 0,
    }];
  });
  return { rows, nextCursor: typeof listed?.nextCursor === "string" ? listed.nextCursor : null };
}

export function projectLine(row: ProjectRow): string {
  return `${row.name}｜图 ${String(row.graphRevision)}｜库存 ${String(row.inventoryRevision)}`;
}

// The two ways this list can legitimately be empty are different operator problems: no session
// means nothing was read, while a session with no rows means the workbench has no projects yet -
// and the second one has an action (import or declare a target), the first does not.
export const PROJECTS_EMPTY_LINE: Record<"no-session" | "empty-page", string> = {
  "no-session": "还没有会话：项目清单要配对之后才读得到，用终端里打印的配对码建立会话。",
  "empty-page": "这台工作台还没有项目：先导入一次采集，或为一个 URL 建目标。",
};

export function projectsRefusalLine(reason: string, facts: Record<string, number | boolean>): string {
  return refusalLine("项目清单读取被拒", reason, facts);
}

// Which of the list's states to show. The two session reasons are not read failures but the absence
// of the thing that reads, so they show the pairing instruction rather than a refusal that looks
// like a bug (`cookie-absent` is §14's pipeline answering before the worker is asked, and
// `session-unknown` is the same answer one hop later - after a worker restart, which is when an
// operator most needs to be told to pair again).
export const SESSION_REASONS: readonly string[] = ["cookie-absent", "session-unknown"];

// The predicate, not the list, is what callers use. The landing page asks this before it decides
// whether to show the pairing form, and the notice below asks it before it decides whether to show
// a refusal - two places that read the same list would be two places that can disagree about
// whether a given reason means "go pair".
export function isSessionReason(reason: string): boolean {
  return SESSION_REASONS.includes(reason);
}

export function projectsNotice(refusal: { reason: string; facts: Record<string, number | boolean> } | null, rowCount: number): string {
  if (refusal === null) return rowCount === 0 ? PROJECTS_EMPTY_LINE["empty-page"] : "";
  if (isSessionReason(refusal.reason)) return PROJECTS_EMPTY_LINE["no-session"];
  return projectsRefusalLine(refusal.reason, refusal.facts);
}

// --- 蓝图冻结与发起生成的页面规则（§8 lines 292/294，issue #58 的把手清单） -------------
//
// §8 has no list route for plans or blueprints: only the single reads (`.../verification-plans/:v`
// and `.../blueprints/:b`), both of which need the id the page is trying to find. The one window the
// document does give for "what has already been decided here" is §8 line 302's project journal, and
// its rows carry exactly the two facts needed: an allowed `plan-approved` names a plan that may be
// frozen, and an allowed `blueprint-frozen` names both the blueprint it made and the plan it was made
// from (`safeMetadata.planId`, `blueprint-service.ts`'s own metadata). Reading the journal is
// therefore not a convenience here - it is the only documented way to know what is freezable, and a
// page that let the operator type an id instead would be handing back a fact the server owns.
export type JournalEntryWire = {
  seq: number;
  action: string;
  resourceType: string;
  resourceId: string | null;
  decision: string;
  reasonCode: string;
  safeMetadata?: Record<string, unknown> | null;
};

// The journal page, read the way every other relay reply is read: the worker's answer arrives under
// `data`, and an entry whose id or kind is missing is dropped rather than guessed at.
export function journalEntriesOf(payload: unknown): JournalEntryWire[] {
  const page = relayData(payload) as { entries?: unknown } | null;
  return (Array.isArray(page?.entries) ? page.entries : []).flatMap((entry) => {
    const row = entry as Partial<JournalEntryWire> | null;
    if (row === null || typeof row !== "object") return [];
    if (typeof row.seq !== "number" || typeof row.action !== "string" || typeof row.decision !== "string") return [];
    return [
      {
        seq: row.seq,
        action: row.action,
        resourceType: typeof row.resourceType === "string" ? row.resourceType : "",
        resourceId: typeof row.resourceId === "string" ? row.resourceId : null,
        decision: row.decision,
        reasonCode: typeof row.reasonCode === "string" ? row.reasonCode : "",
        safeMetadata: (row.safeMetadata ?? null) as Record<string, unknown> | null,
      },
    ];
  });
}

function allowedIds(entries: readonly JournalEntryWire[], action: string, reasonCode: string): string[] {
  return entries
    .filter((entry) => entry.action === action && entry.decision === "allow" && entry.reasonCode === reasonCode)
    .flatMap((entry) => (entry.resourceId === null ? [] : [entry.resourceId]));
}

// Approved plans minus the ones a freeze already consumed. Both sides read the journal: a plan that
// has been frozen is not "still freezable" just because the approval row is still in the window, and
// §8's idempotency key only makes a repeated click safe - it does not make a second blueprint wanted.
export function freezablePlanIds(entries: readonly JournalEntryWire[]): string[] {
  const frozen = new Set(
    entries
      .filter((entry) => entry.action === "blueprint.freeze" && entry.decision === "allow")
      .flatMap((entry) => {
        const named = entry.safeMetadata?.["planId"];
        return typeof named === "string" ? [named] : [];
      }),
  );
  return [...new Set(allowedIds(entries, "plan.review", "plan-approved"))].filter((id) => !frozen.has(id));
}

// The blueprints a generation can be asked for, newest first: the journal's own order is the order
// the decisions happened in, and §12.2 keeps it append-only.
export function frozenBlueprintIds(entries: readonly JournalEntryWire[]): string[] {
  return [...new Set(allowedIds(entries, "blueprint.freeze", "blueprint-frozen"))].reverse();
}

export const FREEZE_EMPTY_LINE: Record<"no-journal" | "no-plan" | "all-frozen", string> = {
  "no-journal": "还没有读到本项目的决策日志：冻结需要的是「已批准的计划」，而它只在日志里点名。",
  "no-plan": "还没有已批准的计划：批计划（§8 line 291）之后，这一栏才有点得动的东西。",
  "all-frozen": "已批准的计划都已经冻结过蓝图了：再一次冻结要的是一个新计划，不是同一个的第二遍。",
};

export const GENERATE_EMPTY_LINE: Record<"no-journal" | "no-blueprint", string> = {
  "no-journal": "还没有读到本项目的决策日志：生成需要蓝图 id，而它只从冻结回执与日志里来。",
  "no-blueprint": "还没有冻结过的蓝图：先在上面点「冻结蓝图」，§8 line 294 才有点得动的一行。",
};

// What a freeze answers with. The eight fields are the receipt's own (§8 line 292's 201 body plus the
// audit sequence §12.2 gives every decision), and the three counts are what the gate verified - the
// page says them rather than "成功", because "冻上了" is not the fact an operator needs next.
export function blueprintFreezeLine(record: {
  blueprintId?: unknown;
  publicVectorCount?: unknown;
  holdoutVectorCount?: unknown;
  contractCount?: unknown;
  auditSeq?: unknown;
}): string {
  const blueprintId = typeof record.blueprintId === "string" ? record.blueprintId : null;
  if (blueprintId === null) return "冻结已被接受，但回包没带蓝图 id";
  const counts = [record.publicVectorCount, record.holdoutVectorCount, record.contractCount];
  const numbers = counts.every((value) => typeof value === "number")
    ? `｜公开 ${String(counts[0])}｜保留 ${String(counts[1])}｜契约 ${String(counts[2])}`
    : "｜三个计数没带回来";
  const audit = typeof record.auditSeq === "number" ? `｜日志 seq ${String(record.auditSeq)}` : "";
  return `已冻结蓝图 ${blueprintId}${numbers}${audit}`;
}

// Which of its four states the freeze panel is in, decided in one place. `null` is not "empty": it
// means the journal was never read, and the instruction an operator needs then (读日志失败了 / 还没读到)
// is not the one for a project that has a journal but no approved plan.
export type FreezePanel = { state: "no-journal" | "no-plan" | "all-frozen" | "ready"; plans: string[] };

export function freezePanelOf(journal: JournalEntryWire[] | null): FreezePanel {
  if (journal === null) return { state: "no-journal", plans: [] };
  const plans = freezablePlanIds(journal);
  if (plans.length > 0) return { state: "ready", plans };
  const approved = journal.some((entry) => entry.action === "plan.review" && entry.decision === "allow" && entry.reasonCode === "plan-approved");
  return { state: approved ? "all-frozen" : "no-plan", plans: [] };
}

export type GeneratePanel = { state: "no-journal" | "no-blueprint" | "ready"; blueprints: string[] };

export function generatePanelOf(journal: JournalEntryWire[] | null): GeneratePanel {
  if (journal === null) return { state: "no-journal", blueprints: [] };
  const blueprints = frozenBlueprintIds(journal);
  return { state: blueprints.length === 0 ? "no-blueprint" : "ready", blueprints };
}

// Every write control on this page needs the session's CSRF token, and all of them used to say the
// same sentence in their own words - five copies is five chances for one panel to keep posting after
// the worker restarted and took the token away. One string, one meaning: nothing was sent, and the
// reason is the pairing, not the payload.
export const NO_SESSION_LINE = "还没有可用的会话令牌，先完成配对。";

// §8's `POST /projects` answer is the row it just wrote, and `graphRevision: 0` is the part an
// operator reads as "nothing has been analysed yet" - so the line says it instead of a bare 已创建.
// §8's column for this door is `{name:string}`, and the storage model treats the name as the only
// thing an operator types there. An empty one is said before it is sent - not because the API accepts
// it (it does not) but because "先写个名字" is the answer, while a 400 about a required field is not.
export const PROJECT_NAME_EMPTY_LINE = "还没有写项目名：这道门收的就是一个名字，空着不算一次创建。";

export function projectCreateLine(record: { id?: unknown; name?: unknown; graphRevision?: unknown }): string {
  const id = typeof record.id === "string" ? record.id : null;
  const name = typeof record.name === "string" ? record.name : null;
  if (id === null || name === null) return "项目创建已被接受，但回包没带 id 或名字";
  const revision = typeof record.graphRevision === "number" ? `｜图 ${String(record.graphRevision)}` : "";
  return `已建项目 ${name}${revision}｜id ${id}`;
}

// §8 line 272's 202 is `{targetId, job}`: the file became a target and an inspect job, and nothing
// else. The job's own state is quoted rather than assumed, because the door answers while the worker
// has only just been handed the bytes - the inventory rows arrive when that job runs.
export function importReceiptLine(record: { targetId?: unknown; job?: Record<string, unknown> | null }): string {
  const targetId = typeof record.targetId === "string" ? record.targetId : null;
  const job = record.job ?? {};
  const jobId = typeof job["id"] === "string" ? job["id"] : null;
  if (targetId === null || jobId === null) return "导入已被接受，但回包没带目标或作业 id";
  const state = typeof job["state"] === "string" ? `（${job["state"]}）` : "";
  const kind = typeof job["kind"] === "string" ? ` ${job["kind"]}` : "";
  return `已收下采集文件：目标 ${targetId}｜作业${kind} ${jobId}${state}`;
}

// The form can tell before it sends that the `file` part is absent. This is not client-side
// validation of what the door checks - the door still refuses an empty body by name - it is the
// difference between "you have not picked a file yet" and a 400 that reads like a malfunction.
export const UPLOAD_NO_FILE_LINE = "还没有选文件：这道门只收 multipart 的 `file` 部分，空体不算一次导入。";

// --- What a control may send, decided once before anything crosses the socket ------------------
//
// Every write on this page repeats the same two questions - is there a token to sign with, and is
// the body the door actually describes? Ten copies of those checks is ten chances for one panel to
// keep posting after a restart took the token away, or to send a form with no file in it. Answering
// them in functions means a test can say what happens, not only a browser.

export type Gate = { ok: true } | { ok: false; line: string };

// The token is the one this session was issued; an empty string means this page has never paired (or
// the worker restarted and §14's memory-resident sessions went with it), so nothing is sent and the
// sentence names the pairing rather than a 403 the operator would have to interpret.
export function sessionGate(csrf: string): Gate {
  return csrf === "" ? { ok: false, line: NO_SESSION_LINE } : { ok: true };
}

export type ProjectDraft = { ok: true; body: { name: string } } | { ok: false; line: string };

export function projectDraftOf(rawName: string): ProjectDraft {
  const name = rawName.trim();
  return name === "" ? { ok: false, line: PROJECT_NAME_EMPTY_LINE } : { ok: true, body: { name } };
}

export type UploadDraft = { ok: true; form: FormData } | { ok: false; line: string };

// The four names are exactly §8 line 272's list; a fifth would be refused by the door and a missing
// `file` is said here rather than discovered as a 400. Optional fields are appended only when the
// operator filled them, so an empty deadline does not arrive as an unparseable `""`.
export function uploadDraftOf(input: { file: File | null; kind: string; deadlineAt: string; sensitiveValues: string }): UploadDraft {
  if (input.file === null) return { ok: false, line: UPLOAD_NO_FILE_LINE };
  const form = new FormData();
  form.append("file", input.file);
  form.append("kind", input.kind);
  if (input.deadlineAt.trim() !== "") form.append("deadlineAt", input.deadlineAt.trim());
  for (const value of input.sensitiveValues.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")) {
    form.append("sensitiveValues", value);
  }
  return { ok: true, form };
}

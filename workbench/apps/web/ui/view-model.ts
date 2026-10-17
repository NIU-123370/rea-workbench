import type { ClaimEvidenceState, Coverage, DisplayStatus, ProjectedStatus } from "../../../packages/domain/evidence.ts";
import { projectClaim, projectRequiredClaims } from "../../../packages/domain/evidence.ts";
import type { Id } from "../../../packages/domain/identity.ts";
// `id.ts` rather than `identity.ts`: this module is reached from the browser bundle, and the
// identity module owns `newId()`, which imports `node:crypto`.
import { isId } from "../../../packages/domain/id.ts";
import type { Digest } from "../../../packages/domain/canonical-json.ts";
import type { JsonValue } from "../../../packages/domain/json-value.ts";

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
export function samplesRefusalLine(kind: "read" | "decision", reason: string, facts: Record<string, number | boolean>): string {
  const published = refusalFactsLine(facts);
  const head = kind === "read" ? "库存读取被拒" : "决定被拒";
  return published === null ? `${head}：${reason}` : `${head}：${reason}（${published}）`;
}

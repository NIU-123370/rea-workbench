import type { ClaimEvidenceState, Coverage, DisplayStatus, ProjectedStatus } from "../../../packages/domain/evidence.ts";
import { projectClaim, projectRequiredClaims } from "../../../packages/domain/evidence.ts";
import type { Id } from "../../../packages/domain/identity.ts";
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
  sourceCount: number;
};

// The list is the same data as the canvas, so switching views cannot change what a
// reviewer is told about a claim.
export function listView(cells: readonly MiddleCell[]): ListRow[] {
  return cells.map((cell) => ({
    id: cell.id,
    role: cell.role,
    label: cell.label,
    statusLine: `${cell.presentation.icon} ${cell.presentation.label}`,
    reasonLine: cell.presentation.reasons.join(", ") || "—",
    sourceCount: cell.evidenceJumpTargets.length,
  }));
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
};

export function buildLeftPanel(input: {
  job: { id: Id; state: string; cleanupState: string; errorJson: JsonValue | null } | null;
  target: { id: Id; kind: string; snapshotDigest: Digest | null } | null;
  limitations: readonly string[];
  scopeLabel: string;
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
  };
}

export type RightTab = { id: "contract" | "code" | "report"; label: string; enabled: boolean; disabledReason: string | null };

// The code tab is an Inspector authority question, not a layout question: a Builder
// that was handed generated or decompiled source would have received content the
// blueprint allowlist exists to keep away from it (§7.3).
export function buildRightTabs(actor: { isBuilder: boolean; hasBlueprint: boolean }): RightTab[] {
  return [
    { id: "contract", label: "契约", enabled: true, disabledReason: null },
    actor.isBuilder
      ? { id: "code", label: "代码", enabled: false, disabledReason: "builder-may-not-read-source" }
      : { id: "code", label: "代码", enabled: true, disabledReason: null },
    actor.isBuilder && !actor.hasBlueprint
      ? { id: "report", label: "报告", enabled: false, disabledReason: "builder-needs-a-frozen-blueprint" }
      : { id: "report", label: "报告", enabled: true, disabledReason: null },
  ];
}

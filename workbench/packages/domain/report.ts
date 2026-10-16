import type { PlanCounts } from "./inventory.ts";
import type { Digest } from "./canonical-json.ts";
import type { Id } from "./identity.ts";

// Delivery verdict rules (DESIGN §10, PRD 验收尾注). A PASS is only ever about
// the fixed identities below; nothing here claims backend equivalence.

export type VerificationResult = "PASS" | "FAIL" | "UNKNOWN";
export type Currentness = "current" | "stale";

export type ReportIdentities = {
  snapshotDigest: Digest;
  blueprintDigest: Digest;
  candidateDigest: Digest;
  vectorSetDigest: Digest;
  planDigest: Digest;
  inventoryDigest: Digest;
  comparatorDigest: Digest;
  runnerImageDigest: Digest;
};

export type CaseOutcome = {
  vectorId: Id;
  state: "passed" | "failed" | "blocked" | "skipped";
  reason: string | null;
};

export function determineResult(input: {
  counts: PlanCounts;
  requiredCoverageGap: boolean;
  planApproved: boolean;
  identitiesCurrent: boolean;
}): VerificationResult {
  // An observed mismatch stays FAIL even after a bound identity moves: the
  // report keeps result and currentness as separate dimensions, and delivery is
  // blocked by currentness instead of by hiding the failure (DESIGN §10).
  if (input.counts.failed > 0) return "FAIL";
  if (input.counts.total === 0) return "UNKNOWN";
  if (!input.planApproved || !input.identitiesCurrent) return "UNKNOWN";
  if (input.requiredCoverageGap) return "UNKNOWN";
  const settled = input.counts.passed + input.counts.failed;
  if (settled !== input.counts.total) return "UNKNOWN";
  return input.counts.passed === input.counts.total ? "PASS" : "UNKNOWN";
}

export function passRate(counts: PlanCounts): number | null {
  if (counts.total === 0) return null;
  return counts.passed / counts.total;
}

export const REPORT_IDENTITY_FIELDS = [
  "snapshotDigest",
  "blueprintDigest",
  "candidateDigest",
  "vectorSetDigest",
  "planDigest",
  "inventoryDigest",
  "comparatorDigest",
  "runnerImageDigest",
] as const satisfies readonly (keyof ReportIdentities)[];

// Any bound identity changing, newly imported Evidence contradicting the
// selected scope, or the selected range itself changing makes the related
// report stale (DESIGN §10). Unrelated new evidence must not be signalled
// here, or every report in the project would flip on each import.
export type StalenessSignal = {
  contradictingEvidenceIds?: readonly string[];
  selectedScopeChanged?: boolean;
};

export function staleReasons(
  bound: ReportIdentities,
  current: ReportIdentities,
  signal: StalenessSignal = {},
): string[] {
  const reasons: string[] = [];
  for (const field of REPORT_IDENTITY_FIELDS) {
    if (bound[field] !== current[field]) reasons.push(`identity-changed:${field}`);
  }
  for (const evidenceId of signal.contradictingEvidenceIds ?? []) {
    reasons.push(`evidence-contradiction:${evidenceId}`);
  }
  if (signal.selectedScopeChanged === true) reasons.push("selected-scope-changed");
  return reasons;
}

export type DeliverabilityGate = {
  canExportVerifiedSamples: boolean;
  reasons: string[];
};

// Comparison evidence alone is not enough: cleanup and currentness gate export
// independently (DESIGN §11, §10).
export function deliverability(input: {
  result: VerificationResult;
  currentness: Currentness;
  cleanupState: "pending" | "complete" | "failed";
  reportPublished: boolean;
}): DeliverabilityGate {
  const reasons: string[] = [];
  if (input.result !== "PASS") reasons.push(`result-${input.result.toLowerCase()}`);
  if (input.currentness !== "current") reasons.push("report-stale");
  if (input.cleanupState !== "complete") reasons.push(`cleanup-${input.cleanupState}`);
  if (!input.reportPublished) reasons.push("report-unpublished");
  return { canExportVerifiedSamples: reasons.length === 0, reasons };
}

import type { PlanCounts } from "./inventory.ts";
import type { ExcludedVector } from "./inventory.ts";
import type { CanonicalLimits, Digest } from "./canonical-json.ts";
import { asDigest, digestCanonicalJson } from "./canonical-json.ts";
import type { JsonObject, JsonValue } from "./json-value.ts";
import type { VerificationPlanContent } from "./plan.ts";
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

// §10's report body plus the two rules that keep it honest: the published
// report never changes (staleness is `staleReasons` next to it), and its
// denominators are read off the frozen plan rather than asserted by the
// evaluator.
export type ReportedCase = CaseOutcome & { safeDiff: JsonValue | null };

// The four §10 case states as a value, so a wire schema cannot drift from the
// union the domain counts on.
export const CASE_STATES = ["passed", "failed", "blocked", "skipped"] as const;

export type InventoryCounts = {
  total: number;
  selected: number;
  excluded: number;
  blocked: number;
};

export type VerificationReportContent = {
  id: Id;
  candidateId: Id;
  result: VerificationResult;
  scope: string[];
  identities: ReportIdentities;
  counts: PlanCounts;
  inventoryCounts: InventoryCounts;
  excludedVectors: { vectorId: Id; reasonCode: ExcludedVector["reasonCode"] }[];
  outcomes: ReportedCase[];
  limitations: string[];
};

export type VerificationReport = VerificationReportContent & {
  currentness: Currentness;
  digest: Digest;
};

// The digest covers everything the evaluator decided and every identity it is
// bound to — but not `currentness`, which is re-derived from the world later.
export const REPORT_CONTENT_FIELDS = [
  "id",
  "candidateId",
  "result",
  "scope",
  "identities",
  "counts",
  "inventoryCounts",
  "excludedVectors",
  "outcomes",
  "limitations",
] as const satisfies readonly (keyof VerificationReportContent)[];

export class ReportFieldDrift extends Error {
  public readonly drifted: string[];

  public constructor(drifted: readonly string[]) {
    super(`report-digest-field-drift:${drifted.join(",")}`);
    this.drifted = [...drifted];
  }
}

export function reportDigestInput(content: VerificationReportContent): JsonObject {
  const built: Record<string, JsonValue> = {
    id: content.id,
    candidateId: content.candidateId,
    result: content.result,
    scope: [...content.scope].sort(),
    identities: {
      snapshotDigest: content.identities.snapshotDigest,
      blueprintDigest: content.identities.blueprintDigest,
      candidateDigest: content.identities.candidateDigest,
      vectorSetDigest: content.identities.vectorSetDigest,
      planDigest: content.identities.planDigest,
      inventoryDigest: content.identities.inventoryDigest,
      comparatorDigest: content.identities.comparatorDigest,
      runnerImageDigest: content.identities.runnerImageDigest,
    },
    counts: {
      total: content.counts.total,
      passed: content.counts.passed,
      failed: content.counts.failed,
      blocked: content.counts.blocked,
      skipped: content.counts.skipped,
    },
    inventoryCounts: {
      total: content.inventoryCounts.total,
      selected: content.inventoryCounts.selected,
      excluded: content.inventoryCounts.excluded,
      blocked: content.inventoryCounts.blocked,
    },
    excludedVectors: [...content.excludedVectors]
      .sort((left, right) => (left.vectorId < right.vectorId ? -1 : 1))
      .map((entry) => ({ vectorId: entry.vectorId, reasonCode: entry.reasonCode })),
    outcomes: [...content.outcomes]
      .sort((left, right) => (left.vectorId < right.vectorId ? -1 : 1))
      .map((entry) => ({
        vectorId: entry.vectorId,
        state: entry.state,
        reason: entry.reason,
        safeDiff: entry.safeDiff,
      })),
    limitations: [...content.limitations].sort(),
  };
  const missing = REPORT_CONTENT_FIELDS.filter((field) => !(field in built));
  const extra = Object.keys(built).filter(
    (key) => !(REPORT_CONTENT_FIELDS as readonly string[]).includes(key),
  );
  if (missing.length > 0 || extra.length > 0) throw new ReportFieldDrift([...missing, ...extra]);
  return built;
}

export function reportDigest(content: VerificationReportContent, limits: CanonicalLimits): Digest {
  return asDigest(digestCanonicalJson(reportDigestInput(content), limits));
}

// The comparator is an installed named version, never code (§10). Its digest
// covers name, version and the explicitly listed normalizations, so a policy
// that relaxes anything cannot be silently swapped under an existing report.
export type ComparatorPolicyIdentity = {
  policyId: string;
  version: string;
  normalization: readonly string[];
};

export function comparatorDigestOf(
  policy: ComparatorPolicyIdentity,
  limits: CanonicalLimits,
): Digest {
  return asDigest(
    digestCanonicalJson(
      {
        policyId: policy.policyId,
        version: policy.version,
        normalization: [...policy.normalization].sort(),
      },
      limits,
    ),
  );
}

export type DenominatorInput = {
  plan: Pick<VerificationPlanContent, "selectedVectorIds" | "excludedVectors">;
  counts: PlanCounts;
  inventoryCounts: InventoryCounts;
  outcomes: readonly ReportedCase[];
  excludedVectors: readonly { vectorId: Id; reasonCode: ExcludedVector["reasonCode"] }[];
};

export const INVENTORY_COUNT_FIELDS = [
  "total",
  "selected",
  "excluded",
  "blocked",
] as const satisfies readonly (keyof InventoryCounts)[];

// `counts` is the frozen plan's denominator and `inventoryCounts` the full
// snapshot's. `blocked` is an eligibility dimension that overlaps the others, so
// it is never part of a sum — which is why the partition check below only ever
// adds selected and excluded.
export function denominatorDefects(input: DenominatorInput): string[] {
  const defects: string[] = [];
  const fromPlan = input.plan.selectedVectorIds.length;
  if (input.counts.total !== fromPlan) {
    defects.push(`counts-total-not-plan-denominator:${String(input.counts.total)}:${String(fromPlan)}`);
  }
  if (input.inventoryCounts.selected + input.inventoryCounts.excluded !== input.inventoryCounts.total) {
    defects.push("inventory-not-partitioned");
  }
  if (
    input.counts.passed + input.counts.failed + input.counts.blocked + input.counts.skipped !==
    input.counts.total
  ) {
    defects.push("counts-buckets-do-not-sum");
  }
  const reported = new Set(input.outcomes.map((outcome) => outcome.vectorId));
  for (const vectorId of input.plan.selectedVectorIds) {
    if (!reported.has(vectorId)) defects.push(`plan-entry-unreported:${vectorId}`);
  }
  for (const vectorId of reported) {
    if (!input.plan.selectedVectorIds.includes(vectorId)) {
      defects.push(`reported-vector-outside-plan:${vectorId}`);
    }
  }
  const planExclusions = new Map(
    input.plan.excludedVectors.map((entry) => [entry.vectorId, entry.reasonCode]),
  );
  for (const entry of input.excludedVectors) {
    const reason = planExclusions.get(entry.vectorId);
    if (reason === undefined) defects.push(`excluded-outside-plan:${entry.vectorId}`);
    else if (reason !== entry.reasonCode) defects.push(`exclusion-reason-changed:${entry.vectorId}`);
  }
  if (input.inventoryCounts.excluded !== input.plan.excludedVectors.length) {
    defects.push("excluded-count-disagrees-with-plan");
  }
  return defects;
}

// What a Builder may see (§10: 契约级类别与安全 diff). Holdout identifiers, their
// expected values and the policy's internals stay inside the evaluator.
export function holdoutExposureDefects(
  outcomes: readonly ReportedCase[],
  visibilityOf: (vectorId: Id) => "public" | "holdout",
): string[] {
  const defects: string[] = [];
  for (const outcome of outcomes) {
    if (visibilityOf(outcome.vectorId) !== "holdout") continue;
    if (outcome.safeDiff !== null) defects.push(`holdout-safe-diff-exposed:${outcome.vectorId}`);
    if (outcome.reason !== null) defects.push(`holdout-reason-exposed:${outcome.vectorId}`);
  }
  return defects;
}

// The vector set is an identity of its own: which samples, with which immutable
// content, in which visibility and eligibility. A holdout turning public, a
// revised sample or a re-derived eligibility all move this digest and therefore
// make an existing report stale — the set the run was compared against is part
// of what the report claims.
export type VectorSetEntry = {
  vectorId: Id;
  digest: Digest;
  visibility: "public" | "holdout";
  eligibility: "usable" | "blocked";
};

export function vectorSetDigestOf(
  entries: readonly VectorSetEntry[],
  limits: CanonicalLimits,
): Digest {
  return asDigest(
    digestCanonicalJson(
      entries
        .map((entry) => ({
          vectorId: entry.vectorId,
          digest: entry.digest,
          visibility: entry.visibility,
          eligibility: entry.eligibility,
        }))
        .sort((left, right) => (left.vectorId < right.vectorId ? -1 : 1)),
      limits,
    ),
  );
}

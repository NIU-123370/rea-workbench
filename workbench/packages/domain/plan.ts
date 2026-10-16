import type { CanonicalLimits, Digest } from "./canonical-json.ts";
import { asDigest, digestCanonicalJson } from "./canonical-json.ts";
import type { RequiredCase } from "./contract.ts";
import type { ExcludedVector } from "./inventory.ts";
import type { Id, Instant } from "./identity.ts";
import type { JsonObject } from "./json-value.ts";
import type { ReviewStatus } from "./vector.ts";

// Frozen verification plan versus full sample inventory (DESIGN §7.4, D27).
//
// The point of this module is that the denominator is fixed *before* execution:
// `selectedVectorIds` is derived from the approved contracts and a plan that
// disagrees with that derivation is refused. Exclusions are the only way an
// inventory entry leaves the denominator, and each allowed reason has to be
// provable against the revision chain or the promised scope.

export type VerificationPlanContent = {
  id: Id;
  targetId: Id;
  snapshotDigest: Digest;
  contractRevisionIds: Id[];
  graphRevision: number;
  inventoryRevision: number;
  inventoryDigest: Digest;
  selectedVectorIds: Id[];
  excludedVectors: ExcludedVector[];
};

export type PlanReview = {
  status: ReviewStatus;
  reviewerId: string | null;
  reviewedAt: Instant | null;
  approvedDigest: Digest | null;
};

export type VerificationPlan = VerificationPlanContent & {
  digest: Digest;
  review: PlanReview;
  createdAt: Instant;
};

// §7.4: the plan digest excludes itself and the review record.
export const PLAN_CONTENT_FIELDS = [
  "id",
  "targetId",
  "snapshotDigest",
  "contractRevisionIds",
  "graphRevision",
  "inventoryRevision",
  "inventoryDigest",
  "selectedVectorIds",
  "excludedVectors",
] as const;

export function planDigestInput(content: VerificationPlanContent): JsonObject {
  return {
    id: content.id,
    targetId: content.targetId,
    snapshotDigest: content.snapshotDigest,
    contractRevisionIds: [...content.contractRevisionIds].sort(),
    graphRevision: content.graphRevision,
    inventoryRevision: content.inventoryRevision,
    inventoryDigest: content.inventoryDigest,
    selectedVectorIds: [...content.selectedVectorIds].sort(),
    excludedVectors: [...content.excludedVectors]
      .sort((left, right) => (left.vectorId < right.vectorId ? -1 : 1))
      .map((entry) => ({
        vectorId: entry.vectorId,
        reasonCode: entry.reasonCode,
        reason: entry.reason,
        excludedBehavior: entry.excludedBehavior,
        supersededBy: entry.supersededBy,
      })),
  };
}

export function planDigest(content: VerificationPlanContent, limits: CanonicalLimits): Digest {
  return digestCanonicalJson(planDigestInput(content), limits);
}

// The union is computed, not accepted: a caller has no field to submit a
// different set in (see the strict plan-build request in contracts).
export function deriveSelectedVectorIds(cases: readonly RequiredCase[]): Id[] {
  const union = new Set<Id>();
  for (const entry of cases) {
    for (const vectorId of entry.vectorIds) union.add(vectorId);
  }
  return [...union].sort();
}

// A frozen inventory snapshot is the (id, content digest) pairs of the vectors in
// scope, sorted by id, so an unrelated revision elsewhere in the project cannot
// move it and a changed body inside it always does.
export function inventorySnapshotDigest(
  entries: readonly { id: Id; digest: Digest }[],
): Digest {
  const pairs = [...entries]
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .map((entry) => [entry.id, entry.digest] as [string, string]);
  return asDigest(digestCanonicalJson(pairs, { maxDepth: 4, maxCodeUnits: 4_000_000 }));
}

export type PlanVectorFact = {
  id: Id;
  targetId: Id;
  snapshotDigest: Digest;
  evidenceId: string;
  caseKey: string;
  eligibility: "usable" | "blocked";
  reasons: string[];
  reviewStatus: ReviewStatus;
  replacesId: Id | null;
  digest: Digest;
};

export type PlanContractFact = {
  id: Id;
  targetId: Id;
  snapshotDigest: Digest;
  reviewStatus: ReviewStatus;
  requiredCases: RequiredCase[];
};

export type PlanGateInput = {
  content: VerificationPlanContent;
  inventory: readonly PlanVectorFact[];
  contracts: readonly PlanContractFact[];
  // Evidence ids that a claim in the selected scope cites as a contradiction:
  // excluding a vector sourced by one of those is a scope lie (§7.4).
  contradictingEvidenceIds: readonly string[];
  requireComplete: boolean;
};

export function planGateReasons(input: PlanGateInput): string[] {
  const reasons: string[] = [];
  const content = input.content;
  const inventory = new Map<Id, PlanVectorFact>();
  for (const entry of input.inventory) inventory.set(entry.id, entry);
  const contractById = new Map<Id, PlanContractFact>();
  for (const contract of input.contracts) contractById.set(contract.id, contract);

  for (const contractId of content.contractRevisionIds) {
    const contract = contractById.get(contractId);
    if (contract === undefined) {
      reasons.push(`contract-unknown:${contractId}`);
      continue;
    }
    if (contract.reviewStatus !== "approved") reasons.push(`contract-not-approved:${contractId}`);
    if (contract.targetId !== content.targetId) reasons.push(`contract-target-mismatch:${contractId}`);
    if (contract.snapshotDigest !== content.snapshotDigest) {
      reasons.push(`contract-snapshot-mismatch:${contractId}`);
    }
  }

  const expected = deriveSelectedVectorIds(
    content.contractRevisionIds.flatMap((id) => contractById.get(id)?.requiredCases ?? []),
  );
  const actual = [...content.selectedVectorIds].sort();
  if (expected.join("|") !== actual.join("|")) {
    reasons.push("selected-not-required-union");
    // Every remaining check assumes the sets, so report the divergence once.
    return [...new Set(reasons)];
  }

  const selected = new Set(content.selectedVectorIds);
  const excluded = new Map<Id, ExcludedVector>();
  for (const entry of content.excludedVectors) {
    if (excluded.has(entry.vectorId)) reasons.push(`duplicate-exclusion:${entry.vectorId}`);
    excluded.set(entry.vectorId, entry);
  }

  for (const vectorId of selected) {
    const vector = inventory.get(vectorId);
    if (vector === undefined) {
      reasons.push(`selected-vector-outside-inventory:${vectorId}`);
      continue;
    }
    if (vector.targetId !== content.targetId || vector.snapshotDigest !== content.snapshotDigest) {
      reasons.push(`selected-vector-scope-mismatch:${vectorId}`);
    }
    if (input.requireComplete) {
      if (vector.reviewStatus !== "approved") reasons.push(`selected-vector-not-approved:${vectorId}`);
      // A blocked case stays in the denominator and keeps the plan from PASS
      // (§7.4); dropping or skipping it to manufacture a result is the failure
      // this whole module exists to prevent.
      if (vector.eligibility === "blocked") reasons.push(`selected-vector-blocked:${vectorId}`);
    }
  }

  for (const entry of content.excludedVectors) {
    const vector = inventory.get(entry.vectorId);
    if (vector === undefined) {
      reasons.push(`excluded-vector-outside-inventory:${entry.vectorId}`);
      continue;
    }
    if (selected.has(entry.vectorId)) reasons.push(`vector-both-selected-and-excluded:${entry.vectorId}`);
    if (entry.reasonCode === "outside-scope") {
      // "It was blocked" is not a scope statement. If the behaviour named here is
      // one of the vector's own blocking reasons, the exclusion is hiding a gap.
      if (vector.reasons.includes(entry.excludedBehavior)) {
        reasons.push(`blocked-is-not-an-exclusion:${entry.vectorId}`);
      }
    } else {
      // `supersededBy` is required by the type and by the wire schema, so an
      // exclusion that claims a successor always names one; the checks below are
      // about whether that successor is really the next link in this chain.
      const successor = inventory.get(entry.supersededBy);
      if (successor === undefined) {
        reasons.push(`superseded-successor-outside-inventory:${entry.vectorId}`);
      } else if (successor.replacesId !== entry.vectorId) {
        reasons.push(`superseded-link-mismatch:${entry.vectorId}`);
      } else if (!selected.has(successor.id)) {
        reasons.push(`superseded-successor-not-selected:${entry.vectorId}`);
      }
    }
    if (input.contradictingEvidenceIds.includes(vector.evidenceId)) {
      reasons.push(`cannot-exclude-contradicting-evidence:${entry.vectorId}`);
    }
  }

  // selected and excluded must exhaust the frozen snapshot.
  for (const vectorId of inventory.keys()) {
    if (!selected.has(vectorId) && !excluded.has(vectorId)) {
      reasons.push(`inventory-not-exhausted:${vectorId}`);
    }
  }

  // Only the current approved leaf of a chain may be selected.
  for (const vectorId of selected) {
    for (const other of inventory.values()) {
      if (other.replacesId === vectorId && !excluded.has(other.id)) {
        reasons.push(`superseded-version-selected-leaf-left-out:${vectorId}`);
      }
    }
  }

  if (content.selectedVectorIds.length + content.excludedVectors.length !== inventory.size) {
    reasons.push("plan-sets-do-not-partition-inventory");
  }

  return [...new Set(reasons)];
}

import type { JsonValue } from "./json-value.ts";
import type { Id } from "./identity.ts";
import type { Digest } from "./canonical-json.ts";

// Workbench-side evidence semantics. Upstream REA owns the meaning of its own
// envelope fields; nothing here reinterprets them or upgrades one basis into
// another (DESIGN §4, §6, PRD 产品原则).

export type EvidenceBasis = "observed" | "derived" | "inferred" | "unknown";

// REA `confidence` keeps its literal vocabulary (src/domain/evidence.ts).
export type ReaConfidence = "observed" | "derived" | "inferred";

export type ClaimValidity = "current" | "stale" | "contradicted";

export type DisplayStatus = "SEEN" | "INFERRED" | "UNKNOWN";

export type CoverageState = "complete" | "partial" | "unknown" | "unavailable";

export type Coverage = {
  state: CoverageState;
  examined: number | null;
  total: number | null;
  reasons: string[];
};

export type RedactionReason = "transport-auth" | "explicit-sensitive";

// The excluded value and any digest of it are never carried (DESIGN §4).
export type Redaction = {
  fieldPointer: string;
  reason: RedactionReason;
  representation: "omitted";
};

export type TargetSnapshot = {
  targetId: Id;
  sourceKind: "url" | "har" | "asar";
  sourceArtifactId: Id | null;
  captureArtifactId: Id | null;
  // DESIGN §4 fixes this as a Digest: a snapshot without content identity is
  // not a snapshot. An uncaptured URL target has no snapshot at all.
  snapshotDigest: Digest;
  scope: JsonValue;
};

export function coverageIsSufficient(coverage: Coverage): boolean {
  if (coverage.state !== "complete") return false;
  if (coverage.examined === null || coverage.total === null) return true;
  // `complete` only ever means the declared set was fully examined.
  return coverage.examined === coverage.total;
}

export function coverageDeficiencyReasons(coverage: Coverage): string[] {
  switch (coverage.state) {
    case "complete": {
      if (coverage.examined !== null && coverage.total !== null && coverage.examined !== coverage.total) {
        return ["coverage-complete-count-mismatch"];
      }
      return [];
    }
    // `unavailable` is never flattened into "nothing to look at".
    case "partial":
      return ["coverage-partial"];
    case "unknown":
      return ["coverage-unknown"];
    case "unavailable":
      return ["coverage-unavailable"];
  }
}

export type ClaimEvidenceState = {
  basis: EvidenceBasis;
  validity: ClaimValidity;
  sourceEvidenceIds: readonly string[];
  authorityApplies: boolean;
  coverage: Coverage;
};

export type ProjectedStatus = {
  status: DisplayStatus;
  reasons: string[];
};

function claimDeficiencies(claim: ClaimEvidenceState): string[] {
  const reasons: string[] = [];
  if (claim.validity === "stale") reasons.push("claim-stale");
  if (claim.validity === "contradicted") reasons.push("claim-contradicted");
  if (claim.sourceEvidenceIds.length === 0) reasons.push("claim-without-source");
  if (!claim.authorityApplies) reasons.push("authority-not-applicable");
  reasons.push(...coverageDeficiencyReasons(claim.coverage));
  return reasons;
}

export function projectClaim(claim: ClaimEvidenceState): ProjectedStatus {
  const deficiencies = claimDeficiencies(claim);
  if (deficiencies.length > 0) return { status: "UNKNOWN", reasons: deficiencies };
  switch (claim.basis) {
    case "observed":
      return { status: "SEEN", reasons: [] };
    case "derived":
      return { status: "INFERRED", reasons: ["basis-derived"] };
    case "inferred":
      return { status: "INFERRED", reasons: ["basis-inferred"] };
    case "unknown":
      return { status: "UNKNOWN", reasons: ["basis-unknown"] };
  }
}

// Node status aggregates only the required claims of the selected scope; an
// edge is judged by its own claim and never inherits a node colour (DESIGN §6).
export function projectRequiredClaims(
  required: readonly ClaimEvidenceState[],
): ProjectedStatus {
  if (required.length === 0) {
    return { status: "UNKNOWN", reasons: ["no-required-claims-in-scope"] };
  }
  const projected = required.map(projectClaim);
  const reasons = [...new Set(projected.flatMap((entry) => entry.reasons))];
  // The weakest required claim decides the node; an explicitly unknown basis is
  // unknown, not a benign reason.
  if (projected.some((entry) => entry.status === "UNKNOWN")) {
    return { status: "UNKNOWN", reasons };
  }
  if (projected.some((entry) => entry.status === "INFERRED")) {
    return { status: "INFERRED", reasons };
  }
  return { status: "SEEN", reasons: [] };
}

// A strict blueprint requires every required claim and edge to be SEEN; manual
// approval cannot waive this (DESIGN §6, PRD 证据与交付规则).
export function blocksStrictBlueprint(status: ProjectedStatus): boolean {
  return status.status !== "SEEN";
}

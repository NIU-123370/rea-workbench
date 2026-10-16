import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { asDigest, digestBytes } from "../../packages/domain/canonical-json.ts";
import type { CanonicalLimits, Digest } from "../../packages/domain/canonical-json.ts";
import { newId } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import {
  CASE_STATES,
  REPORT_CONTENT_FIELDS,
  comparatorDigestOf,
  denominatorDefects,
  holdoutExposureDefects,
  ReportFieldDrift,
  reportDigest,
  reportDigestInput,
  staleReasons,
  vectorSetDigestOf,
} from "../../packages/domain/report.ts";
import type {
  InventoryCounts,
  ReportIdentities,
  ReportedCase,
  VerificationReportContent,
} from "../../packages/domain/report.ts";
import { findComparatorPolicy, installedComparatorPolicySchema } from "../../packages/contracts/verification.ts";
import { INSTALLED_COMPARATOR_POLICIES } from "../../packages/contracts/verification.ts";

const LIMITS: CanonicalLimits = { maxDepth: 24, maxCodeUnits: 200_000 };

function digestOf(text: string): Digest {
  return asDigest(createHash("sha256").update(text, "utf8").digest("hex"));
}

const identities: ReportIdentities = {
  snapshotDigest: digestOf("1"),
  blueprintDigest: digestOf("2"),
  candidateDigest: digestOf("3"),
  vectorSetDigest: digestOf("4"),
  planDigest: digestOf("5"),
  inventoryDigest: digestOf("6"),
  comparatorDigest: digestOf("7"),
  runnerImageDigest: digestOf("8"),
};

function content(overrides: Partial<VerificationReportContent> = {}): VerificationReportContent {
  const vectorId = newId();
  return {
    id: newId(),
    candidateId: newId(),
    result: "PASS",
    scope: [vectorId],
    identities,
    counts: { total: 1, passed: 1, failed: 0, blocked: 0, skipped: 0 },
    inventoryCounts: { total: 1, selected: 1, excluded: 0, blocked: 0 },
    excludedVectors: [],
    outcomes: [{ vectorId, state: "passed", reason: null, safeDiff: null }],
    limitations: [],
    ...overrides,
  };
}

describe("the report is bound to exactly eight identities (DESIGN §10)", () => {
  it("names the eight fields and refuses a digest built on any other set", () => {
    expect(CASE_STATES).toEqual(["passed", "failed", "blocked", "skipped"]);
    expect(REPORT_CONTENT_FIELDS).toEqual([
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
    ]);
    const built = reportDigestInput(content());
    expect(Object.keys(built).sort()).toEqual([...REPORT_CONTENT_FIELDS].sort());
  });

  it("changes the digest when any one bound identity moves", () => {
    const base = reportDigest(content(), LIMITS);
    const fields = Object.keys(identities) as (keyof ReportIdentities)[];
    expect(fields).toHaveLength(8);
    for (const field of fields) {
      const moved: ReportIdentities = { ...identities, [field]: digestOf(`${field}-moved`) };
      expect(reportDigest(content({ identities: moved }), LIMITS)).not.toBe(base);
    }
  });

  it("never lets a stale status join the published digest", () => {
    // Currentness is derived later from the world; folding it into the digest
    // would rewrite a report that was already published.
    const sample = content();
    expect(JSON.stringify(reportDigestInput(sample))).not.toContain("currentness");
    expect(reportDigest(sample, LIMITS)).toBe(reportDigest(sample, LIMITS));
  });

  it("refuses to digest when the covered fields no longer match the manifest", () => {
    // The guard is what stops a new report field from joining the published
    // identity quietly, so it is exercised by moving the manifest, not by
    // reading it.
    const sample = content();
    const manifest = REPORT_CONTENT_FIELDS as unknown as string[];
    manifest.push("reportedAt");
    try {
      expect(() => reportDigestInput(sample)).toThrow(ReportFieldDrift);
    } finally {
      manifest.pop();
    }
    // A key the caller carries but the manifest does not is not hashed either.
    const withExtra = { ...sample, smuggled: "x" } as unknown as VerificationReportContent;
    expect(Object.keys(reportDigestInput(withExtra))).not.toContain("smuggled");
  });
});

describe("the comparator is a named version, not code (DESIGN §10)", () => {
  it("installs only closed-shape policies and refuses an inline normalization", () => {
    expect(INSTALLED_COMPARATOR_POLICIES.map((policy) => policy.policyId)).toEqual([
      "exact-http-v1",
      "exact-http-normalized-v1",
    ]);
    expect(findComparatorPolicy("exact-http-v1")?.normalization).toEqual([]);
    expect(findComparatorPolicy("anything-else")).toBeNull();
    const inline = installedComparatorPolicySchema.safeParse({
      policyId: "loose",
      version: "1",
      normalization: ["ignore-unstable-fields"],
    });
    expect(inline.success).toBe(false);
  });

  it("gives every relaxation its own digest", () => {
    const strict = comparatorDigestOf(
      { policyId: "exact-http-v1", version: "1.0.0", normalization: [] },
      LIMITS,
    );
    const relaxed = comparatorDigestOf(
      { policyId: "exact-http-v1", version: "1.0.0", normalization: ["json-key-order"] },
      LIMITS,
    );
    const newer = comparatorDigestOf(
      { policyId: "exact-http-v1", version: "1.0.1", normalization: [] },
      LIMITS,
    );
    expect(strict).not.toBe(relaxed);
    expect(strict).not.toBe(newer);
    // Order of the list is not a semantic difference.
    const reordered = comparatorDigestOf(
      {
        policyId: "p",
        version: "1",
        normalization: ["json-key-order", "http-header-name-case"],
      },
      LIMITS,
    );
    const otherOrder = comparatorDigestOf(
      {
        policyId: "p",
        version: "1",
        normalization: ["http-header-name-case", "json-key-order"],
      },
      LIMITS,
    );
    expect(reordered).toBe(otherOrder);
  });

  it("binds the vector set so a new or revised sample is visible", () => {
    const vectorId = newId();
    const other = newId();
    const base = vectorSetDigestOf(
      [{ vectorId, digest: digestOf("a"), visibility: "public", eligibility: "usable" }],
      LIMITS,
    );
    const added = vectorSetDigestOf(
      [
        { vectorId, digest: digestOf("a"), visibility: "public", eligibility: "usable" },
        { vectorId: other, digest: digestOf("b"), visibility: "holdout", eligibility: "usable" },
      ],
      LIMITS,
    );
    const revised = vectorSetDigestOf(
      [{ vectorId, digest: digestOf("a-revised"), visibility: "public", eligibility: "usable" }],
      LIMITS,
    );
    const flippedVisibility = vectorSetDigestOf(
      [{ vectorId, digest: digestOf("a"), visibility: "holdout", eligibility: "usable" }],
      LIMITS,
    );
    const blocked = vectorSetDigestOf(
      [{ vectorId, digest: digestOf("a"), visibility: "public", eligibility: "blocked" }],
      LIMITS,
    );
    expect(new Set([base, added, revised, flippedVisibility, blocked]).size).toBe(5);
  });
});

describe("counts and inventoryCounts are separate denominators (§10, §7.4)", () => {
  const selectedA = newId();
  const selectedB = newId();
  const excluded = newId();

  function input(overrides: Record<string, unknown> = {}) {
    return {
      plan: {
        selectedVectorIds: [selectedA, selectedB] as Id[],
        excludedVectors: [
          {
            vectorId: excluded,
            reasonCode: "outside-scope" as const,
            reason: "not promised",
            excludedBehavior: "retry header",
            supersededBy: null,
          },
        ],
      },
      counts: { total: 2, passed: 2, failed: 0, blocked: 0, skipped: 0 },
      inventoryCounts: { total: 3, selected: 2, excluded: 1, blocked: 0 } as InventoryCounts,
      outcomes: [
        { vectorId: selectedA, state: "passed" as const, reason: null, safeDiff: null },
        { vectorId: selectedB, state: "passed" as const, reason: null, safeDiff: null },
      ] as ReportedCase[],
      excludedVectors: [
        { vectorId: excluded, reasonCode: "outside-scope" as const },
      ] as { vectorId: Id; reasonCode: "outside-scope" | "superseded" }[],
      ...overrides,
    };
  }

  it("accepts a report whose plan denominator matches", () => {
    expect(denominatorDefects(input())).toEqual([]);
  });

  it("refuses to borrow the inventory size as the plan denominator", () => {
    const defects = denominatorDefects(
      input({ counts: { total: 3, passed: 3, failed: 0, blocked: 0, skipped: 0 } }),
    );
    expect(defects.some((reason) => reason.startsWith("counts-total-not-plan-denominator"))).toBe(true);
  });

  it("requires selected plus excluded to exhaust the inventory", () => {
    const defects = denominatorDefects(
      input({ inventoryCounts: { total: 4, selected: 2, excluded: 1, blocked: 0 } }),
    );
    expect(defects).toContain("inventory-not-partitioned");
  });

  it("requires every plan entry to be reported and nothing outside it", () => {
    const missing = denominatorDefects(input({ outcomes: [{ vectorId: selectedA, state: "passed", reason: null, safeDiff: null }] }));
    expect(missing).toContain(`plan-entry-unreported:${selectedB}`);
    const stranger = newId();
    const extra = denominatorDefects(
      input({
        outcomes: [
          { vectorId: selectedA, state: "passed", reason: null, safeDiff: null },
          { vectorId: selectedB, state: "passed", reason: null, safeDiff: null },
          { vectorId: stranger, state: "passed", reason: null, safeDiff: null },
        ],
      }),
    );
    expect(extra).toContain(`reported-vector-outside-plan:${stranger}`);
  });

  it("refuses an exclusion whose reason was rewritten after the plan froze", () => {
    const defects = denominatorDefects(
      input({ excludedVectors: [{ vectorId: excluded, reasonCode: "superseded" }] }),
    );
    expect(defects).toContain(`exclusion-reason-changed:${excluded}`);
  });

  it("keeps blocked as an overlapping dimension instead of a fourth bucket", () => {
    // blocked counts inside the inventory do not join selected + excluded.
    const defects = denominatorDefects(
      input({
        inventoryCounts: { total: 3, selected: 2, excluded: 1, blocked: 2 },
        counts: { total: 2, passed: 1, failed: 0, blocked: 1, skipped: 0 },
        outcomes: [
          { vectorId: selectedA, state: "passed", reason: null, safeDiff: null },
          { vectorId: selectedB, state: "blocked", reason: "eligibility", safeDiff: null },
        ],
      }),
    );
    expect(defects).toEqual([]);
  });

  it("refuses counts whose buckets do not sum to the total", () => {
    const defects = denominatorDefects(
      input({ counts: { total: 3, passed: 2, failed: 0, blocked: 0, skipped: 0 } }),
    );
    expect(defects).toContain("counts-buckets-do-not-sum");
  });
});

describe("what a Builder may see (§10)", () => {
  const holdout = newId();
  const publicId = newId();

  it("flags a holdout entry that carries a diff or a reason", () => {
    const outcomes: ReportedCase[] = [
      { vectorId: publicId, state: "failed", reason: "comparison-mismatch", safeDiff: { expected: "a" } },
      { vectorId: holdout, state: "failed", reason: "comparison-mismatch", safeDiff: { expected: "b" } },
    ];
    const defects = holdoutExposureDefects(outcomes, (vectorId) =>
      vectorId === holdout ? "holdout" : "public",
    );
    expect(defects).toContain(`holdout-safe-diff-exposed:${holdout}`);
    expect(defects).toContain(`holdout-reason-exposed:${holdout}`);
    expect(defects.some((reason) => reason.includes(publicId))).toBe(false);
  });

  it("accepts a projection that carries neither", () => {
    const outcomes: ReportedCase[] = [
      { vectorId: holdout, state: "passed", reason: null, safeDiff: null },
    ];
    expect(holdoutExposureDefects(outcomes, () => "holdout")).toEqual([]);
  });
});

describe("staleness is derived, never written (§10)", () => {
  it("names every identity that moved", () => {
    const moved: ReportIdentities = {
      ...identities,
      candidateDigest: digestOf("candidate-moved"),
      comparatorDigest: digestOf("comparator-moved"),
    };
    const reasons = staleReasons(identities, moved);
    expect(reasons).toEqual([
      "identity-changed:candidateDigest",
      "identity-changed:comparatorDigest",
    ]);
  });

  it("does not signal a report stale over unrelated new evidence", () => {
    expect(staleReasons(identities, identities, { contradictingEvidenceIds: [], selectedScopeChanged: false })).toEqual([]);
  });
});

it("hashes the report body so a byte change is visible", () => {
  const body = new TextEncoder().encode(JSON.stringify(content()));
  const other = new TextEncoder().encode(JSON.stringify({ ...content(), result: "FAIL" }));
  expect(digestBytes(body)).not.toBe(digestBytes(other));
});

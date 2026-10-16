import { describe, expect, it } from "vitest";

import { asDigest, type Digest } from "../../packages/domain/canonical-json.ts";
import { asId, type Id } from "../../packages/domain/identity.ts";
import {
  inventoryCounts,
  planCounts,
  type ExcludedVector,
} from "../../packages/domain/inventory.ts";
import {
  deliverability,
  determineResult,
  passRate,
  staleReasons,
  type ReportIdentities,
} from "../../packages/domain/report.ts";

const hex = (seed: string): Digest => asDigest(seed.repeat(64).slice(0, 64));
const FIRST = asId("11111111-1111-4111-8111-111111111111");
const SECOND = asId("22222222-2222-4222-8222-222222222222");
const ids = [FIRST, SECOND];

function identities(overrides: Partial<ReportIdentities> = {}): ReportIdentities {
  return {
    snapshotDigest: hex("a"),
    blueprintDigest: hex("b"),
    candidateDigest: hex("c"),
    vectorSetDigest: hex("d"),
    planDigest: hex("e"),
    inventoryDigest: hex("1"),
    comparatorDigest: hex("2"),
    runnerImageDigest: hex("3"),
    ...overrides,
  };
}

describe("inventory versus frozen plan (DESIGN §7.4)", () => {
  it("covers the snapshot exactly with selected plus excluded", () => {
    const excluded: ExcludedVector[] = [
      {
        vectorId: SECOND,
        reasonCode: "outside-scope",
        reason: "different operation",
        excludedBehavior: "error branch",
        supersededBy: null,
      },
    ];
    const counts = inventoryCounts({
      inventoryVectorIds: ids,
      selectedVectorIds: [FIRST],
      excluded,
      blockedVectorIds: [SECOND],
    });
    expect(counts).toEqual({ total: 2, selected: 1, excluded: 1, blocked: 1 });
  });

  it("refuses gaps, overlaps and foreign ids instead of quietly rebasing the denominator", () => {
    const base = {
      inventoryVectorIds: ids,
      selectedVectorIds: [FIRST],
      excluded: [] as ExcludedVector[],
      blockedVectorIds: [] as Id[],
    };
    // One inventory item neither selected nor excluded is a coverage gap.
    expect(() => inventoryCounts(base)).toThrow(/cover the frozen inventory/);
    expect(() =>
      inventoryCounts({ ...base, selectedVectorIds: [FIRST, SECOND] }),
    ).not.toThrow();
    expect(() =>
      inventoryCounts({ ...base, selectedVectorIds: [] }),
    ).toThrow(/cover the frozen inventory/);
    expect(() =>
      inventoryCounts({
        ...base,
        excluded: [
          {
            vectorId: SECOND,
            reasonCode: "superseded",
            reason: "r",
            excludedBehavior: "b",
            supersededBy: FIRST,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      inventoryCounts({
        ...base,
        selectedVectorIds: [FIRST, SECOND],
        excluded: [
          {
            vectorId: SECOND,
            reasonCode: "outside-scope",
            reason: "r",
            excludedBehavior: "b",
            supersededBy: null,
          },
        ],
      }),
    ).toThrow(/both selected and excluded/);
    expect(() =>
      inventoryCounts({
        ...base,
        selectedVectorIds: [FIRST, SECOND],
        blockedVectorIds: ["not-in-inventory" as Id],
      }),
    ).toThrow(/outside the frozen inventory/);
    expect(() =>
      inventoryCounts({ ...base, selectedVectorIds: [FIRST, FIRST] }),
    ).toThrow(/selected vectors must be unique/);
  });

  it("ties a superseded exclusion to a successor inside the same snapshot", () => {
    const base = {
      inventoryVectorIds: ids,
      selectedVectorIds: [] as Id[],
      blockedVectorIds: [] as Id[],
    };
    expect(() =>
      inventoryCounts({
        ...base,
        excluded: [
          {
            vectorId: SECOND,
            reasonCode: "superseded",
            reason: "replaced",
            excludedBehavior: "b",
            supersededBy: "33333333-3333-4333-8333-333333333333" as Id,
          },
        ],
      }),
    ).toThrow(/supersededBy is outside/);
    expect(() =>
      inventoryCounts({
        ...base,
        selectedVectorIds: [FIRST],
        excluded: [
          {
            vectorId: FIRST,
            reasonCode: "superseded",
            reason: "self",
            excludedBehavior: "b",
            supersededBy: FIRST,
          },
        ],
      }),
    ).toThrow(/cannot point at itself/);
  });

  it("counts plan cases by state", () => {
    expect(
      planCounts([
        { state: "passed" },
        { state: "passed" },
        { state: "failed" },
        { state: "blocked" },
        { state: "skipped" },
      ]),
    ).toEqual({ total: 5, passed: 2, failed: 1, blocked: 1, skipped: 1 });
  });
});

describe("delivery verdict (DESIGN §10)", () => {
  const args = { requiredCoverageGap: false, planApproved: true, identitiesCurrent: true };

  it("never passes on an empty or partly settled plan", () => {
    expect(determineResult({ ...args, counts: planCounts([]) })).toBe("UNKNOWN");
    expect(
      determineResult({ ...args, counts: planCounts([{ state: "passed" }, { state: "blocked" }]) }),
    ).toBe("UNKNOWN");
    expect(
      determineResult({ ...args, counts: planCounts([{ state: "passed" }, { state: "skipped" }]) }),
    ).toBe("UNKNOWN");
  });

  it("passes only when every planned case really succeeded", () => {
    expect(determineResult({ ...args, counts: planCounts([{ state: "passed" }, { state: "passed" }]) })).toBe(
      "PASS",
    );
    expect(
      determineResult({ ...args, counts: planCounts([{ state: "passed" }, { state: "failed" }]) }),
    ).toBe("FAIL");
    expect(
      determineResult({ ...args, counts: planCounts([{ state: "failed" }, { state: "blocked" }]) }),
    ).toBe("FAIL");
  });

  it("keeps an unapproved plan, a coverage gap or a stale identity out of PASS", () => {
    const allPassed = planCounts([{ state: "passed" }]);
    expect(determineResult({ counts: allPassed, requiredCoverageGap: true, planApproved: true, identitiesCurrent: true })).toBe(
      "UNKNOWN",
    );
    expect(determineResult({ counts: allPassed, requiredCoverageGap: false, planApproved: false, identitiesCurrent: true })).toBe(
      "UNKNOWN",
    );
    expect(determineResult({ counts: allPassed, requiredCoverageGap: false, planApproved: true, identitiesCurrent: false })).toBe(
      "UNKNOWN",
    );
  });

  it("keeps an observed mismatch as FAIL when a bound identity went stale", () => {
    // Currentness is a separate dimension; hiding a real comparison failure
    // behind staleness would erase the finding.
    const mixed = planCounts([{ state: "passed" }, { state: "failed" }]);
    expect(
      determineResult({ counts: mixed, requiredCoverageGap: false, planApproved: true, identitiesCurrent: false }),
    ).toBe("FAIL");
    expect(
      determineResult({ counts: mixed, requiredCoverageGap: false, planApproved: false, identitiesCurrent: true }),
    ).toBe("FAIL");
    expect(
      determineResult({ counts: planCounts([{ state: "passed" }]), requiredCoverageGap: false, planApproved: true, identitiesCurrent: false }),
    ).toBe("UNKNOWN");
  });

  it("reports passRate as null instead of a fake zero on an empty plan", () => {
    expect(passRate(planCounts([]))).toBeNull();
    expect(passRate(planCounts([{ state: "passed" }, { state: "failed" }]))).toBe(0.5);
  });

  it("names every identity that moved", () => {
    expect(staleReasons(identities(), identities({ candidateDigest: hex("9") }))).toEqual([
      "identity-changed:candidateDigest",
    ]);
    expect(staleReasons(identities(), identities())).toEqual([]);
  });

  it("blocks verified-samples export on cleanup even with a current PASS", () => {
    expect(
      deliverability({ result: "PASS", currentness: "current", cleanupState: "pending", reportPublished: true }),
    ).toEqual({ canExportVerifiedSamples: false, reasons: ["cleanup-pending"] });
    expect(
      deliverability({ result: "PASS", currentness: "stale", cleanupState: "complete", reportPublished: true }).reasons,
    ).toContain("report-stale");
    expect(
      deliverability({ result: "PASS", currentness: "current", cleanupState: "complete", reportPublished: true }),
    ).toEqual({ canExportVerifiedSamples: true, reasons: [] });
  });
});

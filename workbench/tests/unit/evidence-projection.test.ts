import { describe, expect, it } from "vitest";

import {
  blocksStrictBlueprint,
  coverageDeficiencyReasons,
  projectClaim,
  projectRequiredClaims,
  type ClaimEvidenceState,
  type Coverage,
} from "../../packages/domain/evidence.ts";

const complete: Coverage = { state: "complete", examined: 3, total: 3, reasons: [] };
const partial: Coverage = { state: "partial", examined: 1, total: 3, reasons: ["only-one-page"] };

function claim(overrides: Partial<ClaimEvidenceState> = {}): ClaimEvidenceState {
  return {
    basis: "observed",
    validity: "current",
    sourceEvidenceIds: ["ev_" + "a".repeat(64)],
    authorityApplies: true,
    coverage: complete,
    ...overrides,
  };
}

describe("three-colour projection (DESIGN §6)", () => {
  it("marks a fully sourced observed claim as SEEN", () => {
    expect(projectClaim(claim())).toEqual({ status: "SEEN", reasons: [] });
  });

  it("keeps derived and inferred claims yellow", () => {
    expect(projectClaim(claim({ basis: "derived" })).status).toBe("INFERRED");
    expect(projectClaim(claim({ basis: "inferred" })).status).toBe("INFERRED");
    expect(projectClaim(claim({ basis: "unknown" })).status).toBe("UNKNOWN");
  });

  it("turns UNKNOWN on staleness, contradiction, missing source, wrong authority or thin coverage", () => {
    for (const bad of [
      claim({ validity: "stale" }),
      claim({ validity: "contradicted" }),
      claim({ sourceEvidenceIds: [] }),
      claim({ authorityApplies: false }),
      claim({ coverage: partial }),
    ]) {
      const projected = projectClaim(bad);
      expect(projected.status).toBe("UNKNOWN");
      expect(projected.reasons.length).toBeGreaterThan(0);
    }
  });

  it("never aggregates an explicitly unknown basis into SEEN or INFERRED", () => {
    // Regression: the aggregation used to key off reason prefixes, so a claim
    // with basis `unknown` and no other deficiency came out green.
    expect(projectRequiredClaims([claim({ basis: "unknown" })]).status).toBe("UNKNOWN");
    expect(projectRequiredClaims([claim(), claim({ basis: "unknown" })]).status).toBe("UNKNOWN");
    expect(
      projectRequiredClaims([claim({ basis: "inferred" }), claim({ basis: "unknown" })]).status,
    ).toBe("UNKNOWN");
    expect(blocksStrictBlueprint(projectRequiredClaims([claim({ basis: "unknown" })]))).toBe(true);
  });

  it("has no required claims means UNKNOWN, not an empty green", () => {
    expect(projectRequiredClaims([]).status).toBe("UNKNOWN");
  });

  it("a node is only as strong as its weakest required claim", () => {
    expect(projectRequiredClaims([claim(), claim({ basis: "derived" })]).status).toBe("INFERRED");
    expect(projectRequiredClaims([claim(), claim({ basis: "derived" })]).status).not.toBe("SEEN");
    expect(projectRequiredClaims([claim(), claim({ validity: "contradicted" })]).status).toBe(
      "UNKNOWN",
    );
  });

  it("judges an edge only by its own claim", () => {
    const seenEdge = projectRequiredClaims([claim()]);
    const inferredEdge = projectRequiredClaims([claim({ basis: "inferred" })]);
    expect(seenEdge.status).toBe("SEEN");
    expect(inferredEdge.status).toBe("INFERRED");
  });

  it("unavailable coverage is never collapsed into nothing-to-examine", () => {
    expect(coverageDeficiencyReasons({ state: "unavailable", examined: null, total: null, reasons: [] })).toEqual(
      ["coverage-unavailable"],
    );
    expect(coverageDeficiencyReasons({ state: "complete", examined: 1, total: 3, reasons: [] })).toEqual([
      "coverage-complete-count-mismatch",
    ]);
  });

  it("blocks a strict blueprint on yellow and red alike, with no review override", () => {
    expect(blocksStrictBlueprint(projectRequiredClaims([]))).toBe(true);
    expect(blocksStrictBlueprint({ status: "INFERRED", reasons: ["basis-derived"] })).toBe(true);
    expect(blocksStrictBlueprint({ status: "SEEN", reasons: [] })).toBe(false);
  });
});

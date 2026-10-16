import { describe, expect, it } from "vitest";

import {
  buildFixture,
  percentile,
  projectOnce,
  run,
  summarize,
  type T17Record,
} from "../../infra/perf/t17-graph-update.ts";

// T17 is a gate whose only product is a number, so the arithmetic around the number is the
// part that can lie. These cases hold the percentile, the fixture size the record claims,
// and the rule that a non-gate host can never report A13 as satisfied (PRD A13 / issue #23).

function summary(overrides: Partial<Parameters<typeof summarize>[0]> = {}): T17Record {
  return summarize({
    samples: Array.from({ length: 30 }, (_, index) => 10 + index),
    cold: 20,
    fixtureBuild: 5,
    fixtureDigest: "f".repeat(64),
    now: "2026-10-17T00:00:00.000Z",
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  });
}

describe("the percentile is nearest-rank, not an invented midpoint", () => {
  it("picks the sample at the rank instead of interpolating", () => {
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(hundred, 0.95)).toBe(95);
    expect(percentile(hundred, 0.5)).toBe(50);
    expect(percentile(hundred, 1)).toBe(100);
    // Unordered input must not change the answer.
    expect(percentile([9, 1, 5, 3], 0.95)).toBe(9);
    expect(percentile([4], 0.95)).toBe(4);
  });

  it("refuses to invent a percentile from no samples", () => {
    expect(Number.isNaN(percentile([], 0.95))).toBe(true);
  });
});

describe("the record keeps the claims the fixture actually honours", () => {
  it("projects 200 nodes and 400 edges from 1000 records", () => {
    const fixture = buildFixture(1000);
    expect(fixture.nodes).toHaveLength(200);
    expect(fixture.edges).toHaveLength(400);
    expect(fixture.claims.size).toBe(1000);
    // 200 node cells + 400 edge cells, doubled because the list view is measured in the
    // same sample. An edge whose claim cannot be read would show up as a smaller number.
    expect(projectOnce(fixture)).toBe(1200);
  });

  it("is deterministic for the same record count", () => {
    const digestOf = (count: number): string => {
      const fixture = buildFixture(count);
      return JSON.stringify(fixture.nodes.map((node) => `${node.id}:${node.coverage.state}`));
    };
    expect(digestOf(1000)).toBe(digestOf(1000));
  });

  it("measures at least the warm minimum the gate demands", () => {
    const record = run(32);
    expect(record.samplesMs.length).toBeGreaterThanOrEqual(30);
    expect(record.p95Ms).toBe(percentile(record.samplesMs, 0.95));
    expect(record.maxMs).toBe(Math.max(...record.samplesMs));
  });
});

describe("A13 cannot be satisfied by a number alone", () => {
  it("keeps a fast non-Linux-x64 host out of the gate", () => {
    const fast = summary({ samples: Array.from({ length: 40 }, () => 0.2) });
    expect(fast.p95Ms).toBeLessThanOrEqual(1000);
    expect(fast.host.platform).toBe("darwin");
    expect(fast.gateHostSatisfied).toBe(false);
  });

  it("requires the warm sample count, not a lucky single run", () => {
    const short = summary({ samples: Array.from({ length: 29 }, () => 1), platform: "linux", arch: "x64" });
    expect(short.gateHostSatisfied).toBe(false);
    const justEnough = summary({ samples: Array.from({ length: 30 }, () => 1), platform: "linux", arch: "x64" });
    expect(justEnough.gateHostSatisfied).toBe(true);
  });

  it("fails the budget rather than dropping the slow samples", () => {
    // Nearest-rank p95 over 30 samples is the 29th smallest, so three two-second outliers
    // sit inside it. The forbidden shortcut would be reporting 27 samples instead of 30.
    const withOutliers = summary({
      samples: [...Array.from({ length: 27 }, () => 1), 2000, 2000, 2000],
      platform: "linux",
      arch: "x64",
    });
    expect(withOutliers.samplesMs).toHaveLength(30);
    expect(withOutliers.p95Ms).toBe(2000);
    expect(withOutliers.maxMs).toBe(2000);
    expect(withOutliers.gateHostSatisfied).toBe(false);
  });

  it("never claims the browser lane and always lists what went unmeasured", () => {
    const record = summary({ platform: "linux", arch: "x64" });
    expect(record.gate.browserLane).toBe(false);
    expect(record.unmeasured.length).toBe(3);
    expect(record.unmeasured.join(" ")).toContain("browser render");
    expect(record.unmeasured.join(" ")).toContain("HAR import");
  });
});

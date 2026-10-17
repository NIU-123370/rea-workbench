import { describe, expect, it } from "vitest";

import {
  buildFixture,
  fixtureDigest,
  percentile,
  projectOnce,
  run,
  summarize,
  type BrowserLane,
  type ProjectionInput,
  type T17Record,
} from "../../infra/perf/t17-graph-update.ts";

// T17 is a gate whose only product is a number, so the arithmetic around the number is the
// part that can lie. These cases hold the percentile, the fixture size the record claims,
// and the rule that a non-gate host can never report A13 as satisfied (PRD A13 / issue #23).
//
// The gate's own history is the reason the last block is this long: `gateHostSatisfied` used to be
// computable without the browser, so a linux/x64 run whose record said "browser render - not
// measured" out loud still reported the release gate as satisfied. Every case below is written
// against the interval A13 names, not against whichever fields the harness happens to fill.

const FIXTURE_DIGEST = "f".repeat(64);

function summary(overrides: Partial<Parameters<typeof summarize>[0]> = {}): T17Record {
  return summarize({
    samples: Array.from({ length: 30 }, (_, index) => 10 + index),
    cold: 20,
    fixtureBuild: 5,
    fixtureDigest: FIXTURE_DIGEST,
    now: "2026-10-17T00:00:00.000Z",
    platform: "darwin",
    arch: "arm64",
    lane: null,
    ...overrides,
  });
}

// The gate host with the lane A13 needs: thirty commit->paint samples on the fixture this record
// counts. Everything that should make the gate true is in here, so each case below breaks exactly
// one of those facts and expects `false`.
const LINUX_X64 = { platform: "linux", arch: "x64" } as const;

function lane(overrides: Partial<BrowserLane> = {}): BrowserLane {
  return {
    browser: "Chrome/141.0.0.0",
    origin: "http://127.0.0.1:3000",
    coldMs: 240,
    commitToPaintMs: Array.from({ length: 30 }, (_, index) => 80 + index),
    fixtureDigest: FIXTURE_DIGEST,
    ...overrides,
  };
}

// Reading a number out of the lane by way of `record.lane.driven && record.lane.p95Ms` would turn a
// missing lane into `false`, which then satisfies `toBeLessThanOrEqual` as 0. This says so instead.
function drivenLane(record: T17Record): Extract<T17Record["lane"], { driven: true }> {
  if (!record.lane.driven) throw new Error("expected a driven lane, the record says it was not measured");
  return record.lane;
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
  it("keeps a fast non-Linux-x64 host out of the gate even with a perfect lane", () => {
    const fast = summary({ samples: Array.from({ length: 40 }, () => 0.2), lane: lane() });
    expect(fast.p95Ms).toBeLessThanOrEqual(1000);
    expect(drivenLane(fast).p95Ms).toBeLessThanOrEqual(1000);
    expect(fast.host.platform).toBe("darwin");
    expect(fast.gateHostSatisfied).toBe(false);
  });

  it("requires the warm sample count, not a lucky single run", () => {
    const short = summary({ ...LINUX_X64, samples: Array.from({ length: 29 }, () => 1), lane: lane() });
    expect(short.gateHostSatisfied).toBe(false);
    const justEnough = summary({ ...LINUX_X64, samples: Array.from({ length: 30 }, () => 1), lane: lane() });
    expect(justEnough.gateHostSatisfied).toBe(true);
  });

  it("fails the budget rather than dropping the slow samples", () => {
    // Nearest-rank p95 over 30 samples is the 29th smallest, so three two-second outliers
    // sit inside it. The forbidden shortcut would be reporting 27 samples instead of 30.
    const withOutliers = summary({
      ...LINUX_X64,
      samples: [...Array.from({ length: 27 }, () => 1), 2000, 2000, 2000],
      lane: lane(),
    });
    expect(withOutliers.samplesMs).toHaveLength(30);
    expect(withOutliers.p95Ms).toBe(2000);
    expect(withOutliers.maxMs).toBe(2000);
    // The lane is inside budget here, so the only reason this can fail is the projection half.
    expect(drivenLane(withOutliers).p95Ms).toBeLessThan(1000);
    expect(withOutliers.gateHostSatisfied).toBe(false);
  });

  it("lists the browser render as unmeasured when no lane ran", () => {
    const record = summary(LINUX_X64);
    expect(record.gate.browserLane).toBe(false);
    expect(record.lane).toEqual({ driven: false });
    expect(record.unmeasured.length).toBe(3);
    expect(record.unmeasured.join(" ")).toContain("browser render");
    expect(record.unmeasured.join(" ")).toContain("HAR import");
    // The reading that started this: the same input used to report the gate satisfied.
    expect(record.gateHostSatisfied).toBe(false);
  });
});

describe("the lane is the interval A13 names, so it is the thing that gates", () => {
  it("satisfies A13 on the gate host with thirty commit->paint samples", () => {
    const record = summary({ ...LINUX_X64, lane: lane() });
    expect(record.gate.browserLane).toBe(true);
    expect(record.lane).toMatchObject({ driven: true, browser: "Chrome/141.0.0.0", fixtureMatches: true });
    expect(record.gateHostSatisfied).toBe(true);
    // T17 asks for 每次测量, so the per-iteration list is in the record rather than only its summary.
    const measured = drivenLane(record);
    expect(measured.samplesMs).toEqual(lane().commitToPaintMs);
    expect(measured.p95Ms).toBe(percentile(lane().commitToPaintMs, 0.95));
    expect(measured.maxMs).toBe(109);
    expect(measured.coldMs).toBe(240);
    // With the render measured, the record stops claiming it was not - and keeps claiming the two
    // things that still need the provider.
    expect(record.unmeasured).toEqual([
      "HAR import duration - needs the REA provider",
      "capture and model waits - reported separately by A13 and not observable offline",
    ]);
  });

  it("refuses a lane one sample short of the warm minimum", () => {
    const record = summary({ ...LINUX_X64, lane: lane({ commitToPaintMs: Array.from({ length: 29 }, () => 5) }) });
    expect(record.lane.driven).toBe(true);
    expect(record.gateHostSatisfied).toBe(false);
  });

  it("refuses a lane whose own p95 is over budget", () => {
    const record = summary({
      ...LINUX_X64,
      lane: lane({ commitToPaintMs: [...Array.from({ length: 27 }, () => 5), 4000, 4000, 4000] }),
    });
    expect(record.p95Ms).toBeLessThanOrEqual(1000);
    // The lane ran, and the number it ran to is over budget - so the only thing that can fail this
    // gate is the interval A13 actually measures.
    expect(drivenLane(record).p95Ms).toBe(4000);
    expect(record.gateHostSatisfied).toBe(false);
  });

  it("refuses a lane that opened a browser but produced no sample", () => {
    // The runner reached the page and never saw an update. `driven` reads the measurement list, so
    // this is not a lane and the gate does not get to call it one.
    const record = summary({ ...LINUX_X64, lane: lane({ commitToPaintMs: [] }) });
    expect(record.gate.browserLane).toBe(false);
    expect(record.lane).toEqual({ driven: false });
    expect(record.gateHostSatisfied).toBe(false);
    expect(record.unmeasured).toContainEqual(
      "browser render (React Flow / DOM) - no browser is driven by this harness",
    );
  });

  it("refuses a lane that drove a different fixture than the one counted here", () => {
    const record = summary({ ...LINUX_X64, lane: lane({ fixtureDigest: "a".repeat(64) }) });
    expect(record.lane).toMatchObject({ driven: true, fixtureMatches: false });
    expect(record.gateHostSatisfied).toBe(false);
  });

  it("digests every part of the workload the record claims was measured", () => {
    // The lane's `fixtureMatches` is the only thing that ties the browser numbers to the projection
    // numbers, so the digest has to change when the workload changes - including the claim set, which
    // is what `fixture.records` counts. A digest over nodes and edges alone gave 1 record and 1,000
    // the same string.
    const fixture = buildFixture(1000);
    expect(fixtureDigest(fixture)).toHaveLength(64);
    expect(fixtureDigest(fixture)).toBe(fixtureDigest(buildFixture(1000)));
    expect(fixtureDigest(buildFixture(999))).not.toBe(fixtureDigest(fixture));
    const first = fixture.claims.get("claim-0");
    if (first === undefined) throw new Error("the fixture must carry claim-0");
    const tampered: ProjectionInput = {
      ...fixture,
      claims: new Map(fixture.claims).set("claim-0", { ...first, validity: "stale" }),
    };
    expect(fixtureDigest(tampered)).not.toBe(fixtureDigest(fixture));
  });
});

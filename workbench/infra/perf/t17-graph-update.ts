import { cpus, machine, totalmem } from "node:os";
import { createHash } from "node:crypto";

import { asId, newId } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { ClaimEvidenceState, Coverage } from "../../packages/domain/evidence.ts";
import { buildMiddlePanel, listView, type GraphEdgeView, type GraphNodeView } from "../../apps/web/ui/view-model.ts";

// T17: the p95 measurement A13 asks for (PRD A13 / TESTPLAN T17, issue #23).
//
// A13's interval has two ends: the worker's atomic commit and the browser having finished updating
// the graph/list. This file owns the first half's arithmetic - 1,000 fixture records projected into
// 200 visible nodes and 400 edges, then `buildMiddlePanel` plus `listView` over all of them - and the
// `lane` field is where the second half arrives: a `BrowserLane` built by a runner that actually
// opened a page and measured commit -> paint per iteration.
//
// What the projection alone can never do is *pass* the gate. Until this split existed, a linux/x64
// run with `browserLane: false` and a `unmeasured` line that said "browser render" out loud still
// reported `gateHostSatisfied: true`, because the predicate read three of the four facts it was
// writing and never looked at the fourth (the CI artifact from run 39054251044 is the reading). The
// record keeps both halves so a fast sub-interval cannot be mistaken for the whole one.
//
// The HAR import duration and the capture/model waits stay listed as unmeasured: those need the REA
// provider, and a number this harness cannot produce is not reported as a number.

const FIXTURE_RECORDS = 1000;
const VISIBLE_NODES = 200;
const VISIBLE_EDGES = 400;
const WARM_MINIMUM = 30;
const P95_BUDGET_MS = 1000;

export type ProjectionInput = {
  nodes: readonly GraphNodeView[];
  edges: readonly GraphEdgeView[];
  claims: ReadonlyMap<string, ClaimEvidenceState>;
};

// What a browser lane is: the same interval A13 names, measured where the operator actually sees
// it. `commitToPaintMs` holds one sample per iteration - from the worker's committed fact to the
// page having finished updating the graph/list - and `browser` is the version string the lane read
// back from the browser itself, not a name this harness assumes. `fixtureDigest` is compared against
// the projection fixture's digest, so a lane that drove a different page than the one counted here
// cannot be reported as the same measurement.
export type BrowserLane = {
  browser: string;
  origin: string;
  commitToPaintMs: number[];
  coldMs: number;
  fixtureDigest: string;
};

export type T17Record = {
  harness: "t17-graph-update";
  at: string;
  host: { platform: string; arch: string; machine: string; cpus: number; totalMemoryGb: number; node: string };
  fixture: { records: number; nodes: number; edges: number; digest: string };
  gate: { p95BudgetMs: number; warmMinimum: number; hostIsLinuxX64: boolean; browserLane: boolean };
  // The projection half of the interval: committed fact set -> the view model the screen consumes.
  samplesMs: number[];
  coldMs: number;
  fixtureBuildMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  // The A13 half: what a real browser took to show the update. The two shapes are the whole story -
  // `{ driven: false }` has no number in it to read as a measurement, and a driven lane carries
  // 每次测量 as well as the percentiles, because T17 asks for the per-iteration record, not a summary.
  lane:
    | { driven: false }
    | {
        driven: true;
        browser: string;
        origin: string;
        coldMs: number;
        samplesMs: number[];
        p50Ms: number;
        p95Ms: number;
        maxMs: number;
        fixtureMatches: boolean;
      };
  gateHostSatisfied: boolean;
  unmeasured: string[];
};

// A deterministic generator: the same fixture on every run, so a number that moved is a
// code change and not a different random graph. `Math.random` is not used anywhere in this
// repository's production or tooling paths on purpose (§4).
function coverageOf(index: number): Coverage {
  const states = ["complete", "partial", "unknown", "unavailable"] as const;
  const state = states[index % states.length] as Coverage["state"];
  const total = 1 + (index % 7);
  return {
    state,
    examined: state === "unavailable" ? null : total - (index % 2),
    total: state === "unknown" ? null : total,
    reasons: state === "complete" ? [] : [`fixture-coverage:${state}`],
  };
}

function claimOf(index: number): ClaimEvidenceState {
  const bases = ["observed", "derived", "inferred", "unknown"] as const;
  const validities = ["current", "current", "current", "stale", "contradicted"] as const;
  return {
    basis: bases[index % bases.length] as ClaimEvidenceState["basis"],
    validity: validities[index % validities.length] as ClaimEvidenceState["validity"],
    sourceEvidenceIds: [`ev_${String(index).padStart(4, "0")}`],
    authorityApplies: index % 3 !== 0,
    coverage: coverageOf(index),
  };
}

export function buildFixture(records: number): ProjectionInput {
  // Every record contributes claims; the visible surface is capped at the numbers A13
  // names, because that is the graph the operator actually looks at.
  const claims = new Map<string, ClaimEvidenceState>();
  for (let index = 0; index < records; index += 1) {
    claims.set(`claim-${String(index)}`, claimOf(index));
  }
  const targetId = asId("11111111-1111-4111-8111-111111111111");
  const nodes: GraphNodeView[] = [];
  for (let index = 0; index < VISIBLE_NODES; index += 1) {
    nodes.push({
      id: `node-${String(index)}`,
      kind: index % 4 === 0 ? "function" : "route",
      label: `n${String(index)}`,
      targetId,
      claimIds: [newId()],
      evidenceIds: [`ev_${String(index).padStart(4, "0")}`],
      contractRevisionIds: [newId()],
      coverage: coverageOf(index),
    });
  }
  const edges: GraphEdgeView[] = [];
  for (let index = 0; index < VISIBLE_EDGES; index += 1) {
    const from = nodes[index % VISIBLE_NODES] as GraphNodeView;
    const to = nodes[(index * 7 + 1) % VISIBLE_NODES] as GraphNodeView;
    edges.push({
      id: `edge-${String(index)}`,
      from: from.id,
      to: to.id,
      relation: index % 5 === 0 ? "calls" : "reads",
      claimId: `claim-${String(index)}` as Id,
    });
  }
  return { nodes, edges, claims };
}

export function projectOnce(input: ProjectionInput): number {
  const built = buildMiddlePanel({
    nodes: input.nodes,
    edges: input.edges,
    requiredClaimsOfNode: (node) => node.claimIds.map((id) => input.claims.get(String(id)) ?? claimOf(0)),
    claimOfEdge: (claimId) => input.claims.get(String(claimId)) ?? null,
  });
  // The list view is the canvas substitute T17's row asks for, so it is part of the same
  // measurement instead of a cheaper number reported in its place.
  return built.cells.length + listView(built.cells).length;
}

// Nearest-rank p95, no interpolation: a percentile that invents a value between two
// samples would let a harness report a latency that was never measured.
export function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[rank - 1] as number;
}

export function summarize(input: {
  samples: readonly number[];
  cold: number;
  fixtureBuild: number;
  fixtureDigest: string;
  now: string;
  platform: string;
  arch: string;
  lane: BrowserLane | null;
}): T17Record {
  const p95 = percentile(input.samples, 0.95);
  const hostIsLinuxX64 = input.platform === "linux" && input.arch === "x64";
  const lane = input.lane;
  // A lane that opened a browser and produced no commit->paint sample has not measured the interval
  // A13 names, so `driven` reads the sample list rather than the caller's intent.
  const driven = lane !== null && lane.commitToPaintMs.length > 0;
  const laneSamples = lane === null ? [] : lane.commitToPaintMs;
  const laneP95 = percentile(laneSamples, 0.95);
  return {
    harness: "t17-graph-update",
    at: input.now,
    host: {
      platform: input.platform,
      arch: input.arch,
      machine: machine(),
      cpus: cpus().length,
      totalMemoryGb: Math.round((totalmem() / 1_073_741_824) * 10) / 10,
      node: process.version,
    },
    fixture: { records: FIXTURE_RECORDS, nodes: VISIBLE_NODES, edges: VISIBLE_EDGES, digest: input.fixtureDigest },
    gate: { p95BudgetMs: P95_BUDGET_MS, warmMinimum: WARM_MINIMUM, hostIsLinuxX64, browserLane: driven },
    // The projection half of the interval: committed fact set -> the view model the screen consumes.
    samplesMs: [...input.samples],
    coldMs: input.cold,
    fixtureBuildMs: input.fixtureBuild,
    p50Ms: percentile(input.samples, 0.5),
    p95Ms: p95,
    maxMs: Math.max(...input.samples),
    // The A13 half: what a real browser took to show the update.
    lane:
      driven && lane !== null
        ? {
            driven: true,
            browser: lane.browser,
            origin: lane.origin,
            coldMs: lane.coldMs,
            samplesMs: [...laneSamples],
            p50Ms: percentile(laneSamples, 0.5),
            p95Ms: laneP95,
            maxMs: Math.max(...laneSamples),
            fixtureMatches: lane.fixtureDigest === input.fixtureDigest,
          }
        : { driven: false },
    // A13's sentence is 「从 worker 原子提交到浏览器图/列表完成更新计算 p95」, so the interval ends in a
    // browser. Until a lane ran, the fast number this harness can produce is a *sub*-interval and the
    // gate has to say so: `hostIsLinuxX64` was never enough on its own, and a linux/x64 run with no
    // lane reported gateHostSatisfied=true against its own `unmeasured: browser render` line until
    // this predicate read the field it was already writing (issue #23).
    gateHostSatisfied:
      input.samples.length >= WARM_MINIMUM &&
      p95 <= P95_BUDGET_MS &&
      hostIsLinuxX64 &&
      // `laneSamples.length >= WARM_MINIMUM` is what says a browser ran: a lane that did not run
      // contributes no samples, so there is no separate `driven` clause to check here (one was, and
      // it was an equivalent mutant - it could only be false when this line was already false).
      laneSamples.length >= WARM_MINIMUM &&
      laneP95 <= P95_BUDGET_MS &&
      // A lane that drove a different page than the fixture counted here would satisfy the shape of
      // every rule above and measure nothing A13 asks about.
      lane?.fixtureDigest === input.fixtureDigest,
    unmeasured: [
      ...(driven
        ? []
        : ["browser render (React Flow / DOM) - no browser is driven by this harness"]),
      "HAR import duration - needs the REA provider",
      "capture and model waits - reported separately by A13 and not observable offline",
    ],
  };
}

// The digest has to cover every part of the workload the record claims was measured, including the
// claim set: `fixture.records` names 1,000 of them, and a digest over only the visible nodes and
// edges would be the same string for a 1-record fixture. A lane matches its own digest against this
// one to be allowed to count, so a digest that ignores half the input is a lane that can claim any
// fixture it likes.
export function fixtureDigest(input: ProjectionInput): string {
  const text = [
    ...input.nodes.map((node) => `${node.id}:${node.kind}:${node.coverage.state}`),
    ...input.edges.map((edge) => `${edge.id}:${edge.from}:${edge.to}:${edge.relation}`),
    ...[...input.claims.entries()].map(
      ([id, claim]) => `${id}:${claim.basis}:${claim.validity}:${claim.coverage.state}:${String(claim.authorityApplies)}`
    ),
  ].join("\n");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function run(warmSamples: number, lane: BrowserLane | null = null): T17Record {
  const buildStart = performance.now();
  const fixture = buildFixture(FIXTURE_RECORDS);
  const fixtureBuild = performance.now() - buildStart;

  const coldStart = performance.now();
  const coldCells = projectOnce(fixture);
  const cold = performance.now() - coldStart;

  const samples: number[] = [];
  for (let index = 0; index < warmSamples; index += 1) {
    const start = performance.now();
    const cells = projectOnce(fixture);
    samples.push(performance.now() - start);
    if (cells !== coldCells) throw new Error(`projection count drifted at sample ${String(index)}`);
  }

  return summarize({
    samples,
    cold,
    fixtureBuild,
    fixtureDigest: fixtureDigest(fixture),
    now: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    lane,
  });
}

function format(record: T17Record): string {
  const lane = record.lane;
  const laneLine = lane.driven
    ? `lane ${String(lane.samplesMs.length)} commit->paint samples  p50 ${lane.p50Ms.toFixed(1)} ms  p95 ${lane.p95Ms.toFixed(1)} ms  max ${lane.maxMs.toFixed(1)} ms  cold ${lane.coldMs.toFixed(1)} ms  ${lane.browser} at ${lane.origin}  fixture matches=${String(lane.fixtureMatches)}`
    : "lane no browser driven - A13's interval (commit -> the screen shows it) is not measured";
  const lines = [
    `T17 graph update  fixture ${String(record.fixture.nodes)} nodes / ${String(record.fixture.edges)} edges from ${String(record.fixture.records)} records`,
    `host ${record.host.platform}/${record.host.arch} node ${record.host.node} cpus ${String(record.host.cpus)}`,
    `projection (worker commit -> view model) fixture build ${record.fixtureBuildMs.toFixed(1)} ms  cold ${record.coldMs.toFixed(1)} ms  samples ${String(record.samplesMs.length)}`,
    `p50 ${record.p50Ms.toFixed(1)} ms  p95 ${record.p95Ms.toFixed(1)} ms  max ${record.maxMs.toFixed(1)} ms  (budget p95 <= ${String(record.gate.p95BudgetMs)} ms)`,
    laneLine,
    `A13 gate host (Linux x64 + browser lane): ${String(record.gate.hostIsLinuxX64)} / ${String(record.gate.browserLane)} -> gateHostSatisfied=${String(record.gateHostSatisfied)}`,
    "not measured by this harness:",
    ...record.unmeasured.map((entry) => `  - ${entry}`),
  ];
  return lines.join("\n");
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("t17-graph-update.ts")) {
  const requested = Number(process.argv[2] ?? WARM_MINIMUM + 10);
  const warm = Number.isInteger(requested) && requested >= WARM_MINIMUM ? requested : WARM_MINIMUM;
  const record = run(warm);
  process.stdout.write(`${format(record)}\n`);
  process.stdout.write(`record: ${JSON.stringify(record)}\n`);
}

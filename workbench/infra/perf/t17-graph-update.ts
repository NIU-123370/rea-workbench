import { cpus, machine, totalmem } from "node:os";
import { createHash } from "node:crypto";

import { asId, newId } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { ClaimEvidenceState, Coverage } from "../../packages/domain/evidence.ts";
import { buildMiddlePanel, listView, type GraphEdgeView, type GraphNodeView } from "../../apps/web/ui/view-model.ts";

// T17: the p95 measurement of a graph update, from a committed fact set to the view model
// the screen consumes (PRD A13 / TESTPLAN T17, issue #23).
//
// What this measures is the whole computation the workbench owns between "the worker
// committed" and "the panel has cells and rows": 1,000 fixture records projected into 200
// visible nodes and 400 edges, then `buildMiddlePanel` plus `listView` over all of them.
// What it cannot measure is stated in the record it writes rather than left implied: the
// browser's own render, the HAR import that needs the REA provider, and the capture/model
// waits. And a run on anything but Linux x64 is not A13's gate host, so the record says
// `gateHostSatisfied: false` even when the number itself passes.

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

export type T17Record = {
  harness: "t17-graph-update";
  at: string;
  host: { platform: string; arch: string; machine: string; cpus: number; totalMemoryGb: number; node: string };
  fixture: { records: number; nodes: number; edges: number; digest: string };
  gate: { p95BudgetMs: number; warmMinimum: number; hostIsLinuxX64: boolean; browserLane: boolean };
  samplesMs: number[];
  coldMs: number;
  fixtureBuildMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
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
}): T17Record {
  const p95 = percentile(input.samples, 0.95);
  const hostIsLinuxX64 = input.platform === "linux" && input.arch === "x64";
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
    gate: { p95BudgetMs: P95_BUDGET_MS, warmMinimum: WARM_MINIMUM, hostIsLinuxX64, browserLane: false },
    samplesMs: [...input.samples],
    coldMs: input.cold,
    fixtureBuildMs: input.fixtureBuild,
    p50Ms: percentile(input.samples, 0.5),
    p95Ms: p95,
    maxMs: Math.max(...input.samples),
    // Three things have to hold for A13: enough warm samples, the p95 budget, and the gate
    // host with a real browser lane. The last one is never true from this harness today,
    // because no browser is driven here.
    gateHostSatisfied: input.samples.length >= WARM_MINIMUM && p95 <= P95_BUDGET_MS && hostIsLinuxX64,
    unmeasured: [
      "browser render (React Flow / DOM) - no browser is driven by this harness",
      "HAR import duration - needs the REA provider",
      "capture and model waits - reported separately by A13 and not observable offline",
    ],
  };
}

function fixtureDigest(input: ProjectionInput): string {
  const text = [
    ...input.nodes.map((node) => `${node.id}:${node.kind}:${node.coverage.state}`),
    ...input.edges.map((edge) => `${edge.id}:${edge.from}:${edge.to}:${edge.relation}`),
  ].join("\n");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function run(warmSamples: number): T17Record {
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
  });
}

function format(record: T17Record): string {
  const lines = [
    `T17 graph update  fixture ${String(record.fixture.nodes)} nodes / ${String(record.fixture.edges)} edges from ${String(record.fixture.records)} records`,
    `host ${record.host.platform}/${record.host.arch} node ${record.host.node} cpus ${String(record.host.cpus)}`,
    `fixture build ${record.fixtureBuildMs.toFixed(1)} ms  cold ${record.coldMs.toFixed(1)} ms  samples ${String(record.samplesMs.length)}`,
    `p50 ${record.p50Ms.toFixed(1)} ms  p95 ${record.p95Ms.toFixed(1)} ms  max ${record.maxMs.toFixed(1)} ms  (budget p95 <= ${String(record.gate.p95BudgetMs)} ms)`,
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

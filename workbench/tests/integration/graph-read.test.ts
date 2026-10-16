import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import { projectClaim } from "../../packages/domain/evidence.ts";
import {
  acquireWorkerLock,
  applyMigrations,
  openWriteConnection,
  planMigrations,
} from "../../packages/adapters/storage/database.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { GraphReadService, GRAPH_READ_LIMIT } from "../../packages/application/graph-read.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { ClaimRow } from "../../packages/application/ports.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type { Result } from "../../packages/domain/result.ts";
import { graphViewSchema } from "../../packages/contracts/graph.ts";
import { hex } from "../support/blueprint-seed.ts";

// The canvas read against real rows (DESIGN §6 / PRD F04, issue #18).
//
// What has to be provable is that the screen gets the stored judgement and nothing else:
// a claim's basis and coverage come out of its own row, an edge carries the claim that
// judges it, the evidence ids behind a jump come from the claim's sources, and an empty
// project says which kind of empty it is instead of looking settled.

const reviewer: Actor = { actorId: "local-reviewer", actorKind: "reviewer" };
const EVIDENCE_ID = `ev_${"1".repeat(64)}`;
let jobId: Id;
let artifactId: Id;
const builder: Actor = { actorId: "builder-agent", actorKind: "builder" };

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let graph: GraphReadService;
let projectId: Id;
let targetId: Id;
const heldLocks: { release: () => Promise<void> }[] = [];

function unwrap<T>(result: Result<T, GateFailure>): T {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.reason}:${result.error.message}`);
  return result.value;
}

function refusalOf<T>(result: Result<T, GateFailure>): GateFailure {
  if (result.ok) throw new Error("expected a refusal, got a value");
  return result.error;
}

function claim(overrides: Partial<ClaimRow>): ClaimRow {
  return {
    id: newId(),
    projectId,
    targetId,
    entityKey: "GET /api/cart",
    claimKey: "route-exists",
    assertion: "the cart route answers with the requested include set",
    scopeJson: { sourceEvidenceIds: [EVIDENCE_ID] },
    basis: "observed",
    sourceState: "retained",
    coverageJson: { state: "complete", examined: null, total: null, reasons: [] },
    validity: "current",
    revision: 1,
    unknownReasonsJson: [],
    ...overrides,
  };
}

function seedClaims(claims: ClaimRow[], edges: { fromKey: string; toKey: string; relation: string; claimId: Id }[]): void {
  const outcome = writer.transact((tx) => {
    for (const row of claims) {
      tx.insertClaim(row);
      for (const evidenceId of (row.scopeJson as { sourceEvidenceIds?: string[] }).sourceEvidenceIds ?? []) {
        tx.insertClaimEvidence({ claimId: row.id, projectId, evidenceId, locationJson: { operation: row.claimKey }, role: "support" });
      }
    }
    for (const edge of edges) {
      tx.insertGraphEdge({ id: newId(), projectId, targetId, fromKey: edge.fromKey, toKey: edge.toKey, relation: edge.relation, claimId: edge.claimId });
    }
    return true;
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-graph-"));
  const lock = await acquireWorkerLock(root);
  if (!lock.ok) throw new Error(JSON.stringify(lock.error));
  heldLocks.push(lock.value);
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  db = opened.value.db;
  writer = new SqliteStorageWriter(db);
  const planned = planMigrations(db);
  if (!planned.ok) throw new Error(JSON.stringify(planned.error));
  const applied = applyMigrations(db, planned.value);
  if (!applied.ok) throw new Error(JSON.stringify(applied.error));

  projectId = newId();
  targetId = newId();
  const created = nowInstant();
  const seeded = writer.transact((tx) => {
    tx.insertProject({ id: projectId, name: "graph-suite", createdAt: created, graphRevision: 1, inventoryRevision: 1, schemaVersion: 1 });
    tx.insertTarget({
      id: targetId,
      projectId,
      kind: "har",
      originalLocator: null,
      sourceSha256: null,
      sourceArtifactId: null,
      snapshotDigest: asDigest(hex("graph-snapshot")),
      identityReason: null,
      createdAt: created,
    });
    return true;
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const created2 = nowInstant();
  jobId = newId();
  artifactId = newId();
  const evidence = writer.transact((tx) => {
    const published = tx.insertJob({
      id: jobId,
      projectId,
      targetId,
      kind: "capture",
      state: "succeeded",
      cleanupState: "complete",
      inputJson: {},
      resultRef: null,
      errorJson: null,
      idempotencyKey: `capture-${jobId}`,
      requestDigest: asDigest(hex("graph-capture")),
      deadlineAt: null,
      retryAt: null,
      createdAt: created2,
      updatedAt: created2,
    });
    if (published.outcome !== "inserted") throw new Error("job not inserted");
    tx.insertArtifact({
      id: artifactId,
      projectId,
      jobId,
      class: "inspector",
      sha256: asDigest(hex("graph-evidence-payload")),
      digestReason: null,
      byteLength: 12,
      storageKey: `projects/${projectId}/artifacts/inspector/${"2".repeat(64)}.bin`,
      mediaType: "application/json",
      createdAt: created2,
    });
    tx.insertEvidence({
      projectId,
      id: EVIDENCE_ID,
      targetId,
      jobId,
      artifactId,
      providerJson: { name: "rea", version: "6.4.0" },
      operation: "inspect_web_network_capture",
      confidence: "observed",
      authority: "shipped-artifact",
      createdAt: created2,
    });
    return true;
  });
  if (!evidence.ok) throw new Error(JSON.stringify(evidence.error));
  graph = new GraphReadService({ storage: writer });
});

afterAll(async () => {
  await Promise.all(heldLocks.map((lock) => lock.release()));
  await rm(root, { recursive: true, force: true });
  db.close();
});

describe("reading the graph the canvas shows (§6)", () => {
  it("an empty project says so by name rather than looking settled", () => {
    const empty = unwrap(graph.read(projectId, reviewer));
    expect(empty.targetId).toBe(targetId);
    expect(empty.nodes).toEqual([]);
    expect(empty.note).toBe("target-has-no-claims");
    expect(empty.claims).toEqual([]);
  });

  it("carries each claim's stored state and the evidence ids behind it", () => {
    const seen = claim({});
    const inferred = claim({ entityKey: "CartService.load", basis: "inferred", claimKey: "calls-fetch" });
    const contradicted = claim({ entityKey: "GET /api/cart", basis: "observed", validity: "contradicted", claimKey: "route-cache" });
    const edgeClaim = claim({ entityKey: "CartService.load", basis: "derived", claimKey: "edge-claim" });
    seedClaims(
      [seen, inferred, contradicted, edgeClaim],
      [{ fromKey: "GET /api/cart", toKey: "CartService.load", relation: "calls", claimId: edgeClaim.id }],
    );
    const view = unwrap(graph.read(projectId, reviewer));
    expect(view.targetId).toBe(targetId);
    expect(view.nodes.map((node) => node.entityKey).sort()).toEqual(["CartService.load", "GET /api/cart"]);
    expect(view.edges).toHaveLength(1);
    // The edge names the claim that judges it; the node does not absorb it.
    expect(view.edges[0]).toMatchObject({ fromKey: "GET /api/cart", toKey: "CartService.load", relation: "calls", claimId: edgeClaim.id });
    expect(projectClaim(view.claims.find((entry) => entry.claimId === seen.id)!.state).status).toBe("SEEN");
    expect(projectClaim(view.claims.find((entry) => entry.claimId === inferred.id)!.state)).toMatchObject({
      status: "INFERRED",
      reasons: ["basis-inferred"],
    });
    expect(projectClaim(view.claims.find((entry) => entry.claimId === contradicted.id)!.state).reasons).toContain("claim-contradicted");
    // The jump target comes from the claim's own sources, not from a copy on the node.
    const jumped = unwrap(graph.evidenceIdsOf(projectId, seen.id));
    expect(jumped).toEqual([EVIDENCE_ID]);
    expect(view.nodes.find((node) => node.entityKey === "GET /api/cart")?.evidenceIds).toEqual(jumped);
    // And the whole view is a named contract: an extra status field would fail here.
    expect(graphViewSchema.safeParse(view).success).toBe(true);
  });

  it("a withheld authority or an unavailable coverage is not smoothed away", () => {
    const noAuthority = claim({ entityKey: "POST /api/checkout", basis: "observed", claimKey: "checkout-authority", sourceState: "unavailable" });
    const unavailable = claim({
      entityKey: "PATCH /api/cart",
      basis: "observed",
      claimKey: "patch-coverage",
      coverageJson: { state: "unavailable", examined: null, total: null, reasons: ["provider-declined"] },
    });
    seedClaims([noAuthority, unavailable], []);
    const view = unwrap(graph.read(projectId, reviewer));
    expect(projectClaim(view.claims.find((entry) => entry.claimId === noAuthority.id)!.state).reasons).toContain("authority-not-applicable");
    const status = projectClaim(view.claims.find((entry) => entry.claimId === unavailable.id)!.state);
    expect(status.status).toBe("UNKNOWN");
    expect(status.reasons.join(",")).toContain("unavailable");
  });

  it("reports truncation instead of pretending a bounded read was the whole graph", () => {
    const atLimit = Array.from({ length: GRAPH_READ_LIMIT }, (_, index) =>
      claim({ entityKey: `bulk-${String(index)}`, claimKey: `bulk-claim-${String(index)}` }),
    );
    seedClaims(atLimit, []);
    const view = unwrap(graph.read(projectId, reviewer));
    expect(view.truncated).toBe(true);
    expect(view.claims.length).toBeGreaterThanOrEqual(GRAPH_READ_LIMIT);
  });

  it("refuses an unknown target and an unknown claim, and the Builder altogether", async () => {
    const unknown = unwrap(graph.read(projectId, reviewer, newId()));
    expect(unknown.note).toBe("target-unknown");
    expect(unknown.targetId).toBe(null);
    const claimMiss = refusalOf(graph.evidenceIdsOf(projectId, newId()));
    expect(claimMiss.reason).toBe("claim-unknown");
    const refused = refusalOf(graph.read(projectId, builder));
    expect(refused.code).toBe("ACCESS_DENIED");
    expect(refused.reason).toBe("builder-may-not-read-graph");
  });
});

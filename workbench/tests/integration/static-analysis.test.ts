import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireWorkerLock, applyMigrations, openWriteConnection, planMigrations } from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { StaticAnalysisService } from "../../packages/application/static-analysis.ts";
import type { StaticOperationContext } from "../../packages/application/static-analysis.ts";
import { readAudit } from "../../packages/application/audit.ts";
import { httpStatusFor } from "../../packages/contracts/errors.ts";
import {
  javascriptApplicationAnalysisResultSchema,
  reaJavaScriptApplicationEvidenceSchema,
} from "../../packages/contracts/rea-static-analysis.ts";
import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type {
  ArtifactRow,
  EvidenceRow,
  JobRow,
  ProjectRow,
  TargetRow,
} from "../../packages/application/ports.ts";

// F12 / D05 / issue #24 against the real storage layer: an ASAR application-graph
// envelope is published as an immutable artifact, indexed as an Evidence row, and
// then read back through the projection. The stored bytes are the fixture at
// `tests/fixtures/asar-application-envelope.json`, i.e. the exact shape REA 6.4.0
// at 98d8470d advertises for `analyze_javascript_application`
// (src/contracts/javascript/electronToolContracts.ts:89-122) — hand-built to that
// contract, since no real .asar archive was analysed by REA while writing this.

const SECRET = "hunter2-embedded-session-secret";
const SOURCE_SHA = ("9" as const).repeat(64) as Digest;

const FIXTURE_URL = new URL("../fixtures/asar-application-envelope.json", import.meta.url);
const FIXTURE_TEXT = await readFile(FIXTURE_URL, "utf8");
const FIXTURE = JSON.parse(FIXTURE_TEXT) as JsonValue;
const ENVELOPE = reaJavaScriptApplicationEvidenceSchema.parse(FIXTURE);
const ANALYSIS = javascriptApplicationAnalysisResultSchema.parse(ENVELOPE.normalized_result);

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let store: ArtifactStore;
let service: StaticAnalysisService;
let projectId: Id;
let targetId: Id;
let importJobId: Id;
let artifactId: Id;
let artifactFile: string;
const heldLocks: { release: () => Promise<void> }[] = [];

const inspector = { actorId: "local-operator", actorKind: "inspector" } as const;
const builder = { actorId: "builder-agent", actorKind: "builder" } as const;

function context(declaredValues: readonly string[] = []): StaticOperationContext {
  return { sensitive: { declaredValues } };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-asar-"));
  await writeFile(path.join(root, "note.txt"), "x");
  const lock = await acquireWorkerLock(root);
  if (!lock.ok) throw new Error(JSON.stringify(lock.error));
  heldLocks.push(lock.value);
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  db = opened.value.db;
  writer = new SqliteStorageWriter(db);
  store = new ArtifactStore(root);
  const plan = planMigrations(db);
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  const applied = applyMigrations(db, plan.value);
  if (!applied.ok) throw new Error(JSON.stringify(applied.error));

  service = new StaticAnalysisService({ storage: writer, artifacts: store });

  projectId = newId();
  targetId = newId();
  importJobId = newId();
  artifactId = newId();
  const created = nowInstant();

  const published = await store.publish(projectId, "inspector", new TextEncoder().encode(FIXTURE_TEXT));
  if (!published.ok) throw new Error(JSON.stringify(published.error));

  const project: ProjectRow = {
    id: projectId,
    name: "demo-app",
    createdAt: created,
    graphRevision: 0,
    inventoryRevision: 0,
    schemaVersion: 1,
  };
  // DESIGN §5: an ASAR target keeps the source digest of the analysed archive
  // and has no deployment snapshot at all, because nothing was ever run.
  const target: TargetRow = {
    id: targetId,
    projectId,
    kind: "asar",
    originalLocator: null,
    sourceSha256: SOURCE_SHA,
    sourceArtifactId: null,
    snapshotDigest: null,
    identityReason: "file-import-without-capture",
    createdAt: created,
  };
  const job: JobRow = {
    id: importJobId,
    projectId,
    targetId,
    kind: "inspect",
    state: "succeeded",
    cleanupState: "complete",
    inputJson: { kind: "asar" },
    resultRef: null,
    errorJson: null,
    idempotencyKey: "seed-asar-envelope",
    requestDigest: SOURCE_SHA,
    deadlineAt: null,
    retryAt: null,
    createdAt: created,
    updatedAt: created,
  };
  const artifact: ArtifactRow = {
    id: artifactId,
    projectId,
    jobId: importJobId,
    class: "inspector",
    sha256: published.value.sha256,
    digestReason: null,
    byteLength: published.value.byteLength,
    storageKey: published.value.storageKey,
    mediaType: "application/json",
    createdAt: created,
  };
  const evidence: EvidenceRow = {
    projectId,
    id: ENVELOPE.evidence_id,
    targetId,
    jobId: importJobId,
    artifactId,
    providerJson: ENVELOPE.provider,
    operation: ENVELOPE.operation,
    confidence: ENVELOPE.confidence,
    authority: ENVELOPE.authority,
    createdAt: created,
  };
  const seeded = writer.transact((tx) => {
    tx.insertProject(project);
    tx.insertTarget(target);
    expect(tx.insertJob(job).outcome).toBe("inserted");
    tx.insertArtifact(artifact);
    tx.insertEvidence(evidence);
    tx.appendEvent({
      projectId,
      type: "evidence.committed",
      aggregateId: ENVELOPE.evidence_id,
      payloadJson: { resourceIds: [ENVELOPE.evidence_id] },
      createdAt: created,
    });
    return artifact;
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  artifactFile = storePath(seeded.value.storageKey);
});

// A storage key is server-visible (§5); the test reaches the same file the
// adapter reads, so a byte-level tamper is a real disk edit, not a mock.
function storePath(storageKey: string): string {
  return path.join(root, ...storageKey.split("/"));
}

afterAll(async () => {
  db.close();
  for (const lock of heldLocks) await lock.release();
  await rm(root, { recursive: true, force: true });
});

function rows(query: string): JsonValue[] {
  return db.prepare(query).all() as JsonValue[];
}

describe("persisted ASAR envelope (DESIGN §4, §5)", () => {
  it("stores the envelope verbatim and indexes only identity fields", () => {
    const stored = rows(`SELECT id, operation, confidence, authority FROM evidence_records`);
    expect(stored).toHaveLength(1);
    const indexed = stored[0] as Record<string, JsonValue>;
    expect(indexed["operation"]).toBe("analyze_javascript_application");
    // The producer classifies a reconstruction as derived; the index says the same
    // and no stronger (D08).
    expect(indexed["confidence"]).toBe("derived");
    expect(indexed["authority"]).toBe("shipped-artifact");

    const snapshot = rows("SELECT snapshot_digest, source_sha256, identity_reason FROM targets");
    expect(snapshot).toHaveLength(1);
    const row = snapshot[0] as Record<string, JsonValue>;
    // Nothing ran, so there is no deployment snapshot to claim.
    expect(row["snapshot_digest"]).toBeNull();
    expect(row["source_sha256"]).toBe(SOURCE_SHA);
    expect(row["identity_reason"]).toBe("file-import-without-capture");
  });

  it("reads the application graph back with every upstream id verbatim", async () => {
    const view = await service.projectApplicationGraph(projectId, ENVELOPE.evidence_id, context());
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.evidenceId).toBe(ENVELOPE.evidence_id);
    expect(view.value.graphId).toBe(ANALYSIS.graph.graph_id);
    expect(view.value.semanticGraphId).toBe(ANALYSIS.semantic_graph.graph_id);
    expect(view.value.rootArtifactSha256).toBe(asDigest(ANALYSIS.root_artifact_sha256));
    expect(view.value.targetId).toBe(targetId);
    expect(view.value.importJobId).toBe(importJobId);
    expect(view.value.nodes.map((node) => node.nodeId)).toEqual(
      ANALYSIS.graph.nodes.map((node) => node.node_id),
    );
    expect(view.value.edges.map((edge) => edge.edgeId)).toEqual(
      ANALYSIS.graph.edges.map((edge) => edge.edge_id),
    );
    // Every observation id survives the round trip unchanged.
    expect(view.value.nodes.flatMap((node) => node.observations.map((o) => o.observationId))).toEqual(
      ANALYSIS.graph.nodes.flatMap((node) => node.observations.map((o) => o.observation_id)),
    );
    expect(view.value.format).toBe("asar");
  });

  it("keeps inferred as inferred across the real storage layer", async () => {
    const view = await service.projectApplicationGraph(projectId, ENVELOPE.evidence_id, context());
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const projected = [
      ...view.value.nodes.flatMap((node) => node.observations.map((o) => o.factState)),
      ...view.value.edges.map((edge) => edge.factState),
    ];
    const upstream = [
      ...ANALYSIS.graph.nodes.flatMap((node) => node.observations.map((o) => o.evidence.state)),
      ...ANALYSIS.graph.edges.map((edge) => edge.evidence.state),
    ];
    expect(projected).toEqual(upstream);
    expect(projected.filter((state) => state === "inferred").length).toBeGreaterThan(0);
    expect(view.value.envelopeConfidence).toBe("derived");
    // No projection key could carry a runtime contract field.
    expect(JSON.stringify(view.value)).not.toContain("httpOperations");
    expect(JSON.stringify(view.value)).not.toContain("expectedOutcome");
  });

  it("answers the named unknowns query from persisted bytes", async () => {
    const unknowns = await service.listStaticUnknowns(projectId, ENVELOPE.evidence_id, context());
    expect(unknowns.ok).toBe(true);
    if (!unknowns.ok) return;
    expect(unknowns.value.applicationUnknownNodes.map((node) => node.nodeId)).toEqual(
      ANALYSIS.graph.nodes.filter((node) => node.kind === "unknown").map((node) => node.node_id),
    );
    expect(unknowns.value.semanticUnknowns.map((entry) => entry.unknownId)).toEqual(
      ANALYSIS.semantic_graph.unknowns.map((entry) => entry.unknown_id),
    );
    expect(unknowns.value.statedUnknowns).toContain("graph.coverage.status is partial");
    expect(unknowns.value.coverageStatuses.applicationGraph).toBe(ANALYSIS.graph.coverage.status);
  });
});

describe("artifact integrity (DESIGN §4, §5)", () => {
  it("refuses an artifact whose bytes no longer match the recorded digest", async () => {
    // Rewrite the stored envelope so one inferred static edge claims `observed`,
    // leaving the index and its digest untouched: the bytes are now a different
    // artifact than the row describes.
    const tampered = FIXTURE_TEXT.replace('"state": "inferred"', '"state": "observed"');
    if (tampered === FIXTURE_TEXT) throw new Error("the fixture tamper did not change any byte");
    await writeFile(artifactFile, tampered, "utf8");

    const projection = await service.projectApplicationGraph(projectId, ENVELOPE.evidence_id, context());
    expect(projection.ok).toBe(false);
    if (projection.ok) return;
    expect(projection.error.reason).toBe("artifact-digest-mismatch");
    expect(projection.error.code).toBe("REA_CONTRACT_MISMATCH");
    expect(httpStatusFor(projection.error.code)).toBe(503);

    const unknowns = await service.listStaticUnknowns(projectId, ENVELOPE.evidence_id, context());
    expect(unknowns.ok).toBe(false);
    if (unknowns.ok) return;
    expect(unknowns.error.reason).toBe("artifact-digest-mismatch");

    // The upgrade attempt never reached the database, and the index row is
    // untouched: an immutable Evidence source is not rewritten in place (§4).
    const indexed = rows("SELECT confidence FROM evidence_records") as { confidence: JsonValue }[];
    expect(indexed[0]?.confidence).toBe("derived");
  });

  it("still refuses a well-formed artifact that carries a different evidence id", async () => {
    // Restore the real bytes, then publish a re-keyed envelope behind the same row.
    const forged = structuredClone(FIXTURE) as Record<string, JsonValue>;
    forged["evidence_id"] = `ev_${("7" as const).repeat(64)}`;
    const bytes = new TextEncoder().encode(JSON.stringify(forged));
    const published = await store.publish(projectId, "inspector", bytes);
    if (!published.ok) throw new Error(JSON.stringify(published.error));
    const forgedFile = storePath(published.value.storageKey);
    await writeFile(forgedFile, bytes);

    const current = rows("SELECT sha256 FROM artifacts") as { sha256: JsonValue }[];
    expect(current[0]?.sha256).not.toBe(published.value.sha256);
    // Pointing the row at bytes it did not measure is the same integrity failure.
    const projection = await service.projectApplicationGraph(projectId, ENVELOPE.evidence_id, context());
    expect(projection.ok).toBe(false);
    if (projection.ok) return;
    expect(projection.error.reason).toBe("artifact-digest-mismatch");

    // Put the original bytes back so the remaining cases read a valid artifact.
    await writeFile(artifactFile, FIXTURE_TEXT, "utf8");
    const restored = await service.projectApplicationGraph(projectId, ENVELOPE.evidence_id, context());
    expect(restored.ok).toBe(true);
  });
});

describe("ASAR import admission on the real journal (DESIGN §8, §12.2)", () => {
  it("journals the deny in the transaction that refused, and writes nothing else", () => {
    const before = rows("SELECT COUNT(*) AS n FROM audit_entries") as { n: number }[];
    const result = service.admitAsarImport(
      projectId,
      inspector,
      { kind: "asar", sensitiveValues: [SECRET] },
      context([SECRET]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SENSITIVE_PROJECTION_UNSUPPORTED");
    expect(httpStatusFor(result.error.code)).toBe(422);

    const after = readAudit(writer, { after: 0, projectId, limit: 50 });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const denials = after.value.filter((entry) => entry.decision === "deny");
    expect(denials.map((entry) => entry.reasonCode)).toEqual(["sensitive-projection-unsupported"]);
    expect(denials[0]?.action).toBe("import.asar.admit");
    expect(Number(before[0]?.n ?? 0)).toBe(0);
    // The declared value is neither stored nor hashed (§12.1).
    expect(JSON.stringify(after.value)).not.toContain(SECRET);
    // Only the journal grew: no second target, artifact or evidence row appeared.
    expect(rows("SELECT COUNT(*) AS n FROM targets")).toEqual([{ n: 1 }]);
    expect(rows("SELECT COUNT(*) AS n FROM artifacts")).toEqual([{ n: 1 }]);
    expect(rows("SELECT COUNT(*) AS n FROM evidence_records")).toEqual([{ n: 1 }]);
  });

  it("accepts the same import without a declaration and journals an allow", () => {
    const result = service.admitAsarImport(projectId, inspector, { kind: "asar" }, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: "asar", deadlineAt: null, sensitiveDeclared: false });
    const after = readAudit(writer, { after: 0, projectId, limit: 50 });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.map((entry) => entry.decision)).toContain("allow");
    expect(rows("SELECT COUNT(*) AS n FROM targets")).toEqual([{ n: 1 }]);
  });

  it("refuses a builder and records that denial too", () => {
    const result = service.admitAsarImport(projectId, builder, { kind: "asar" }, context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACCESS_DENIED");
    const after = readAudit(writer, { after: 0, projectId, limit: 50 });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.filter((entry) => entry.decision === "deny").length).toBe(2);
  });
});

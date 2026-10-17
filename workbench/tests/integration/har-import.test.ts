import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TargetService } from "../../packages/application/target-service.ts";
import { projectJobRecord } from "../../packages/application/job-queue.ts";
import { apiErrorSchema } from "../../packages/contracts/errors.ts";

import { digestBytes } from "../../packages/domain/canonical-json.ts";
import { asDigest } from "../../packages/domain/canonical-json.ts";
import { asId, newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import { acquireWorkerLock, applyMigrations, openWriteConnection, planMigrations } from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { connectReaStdio, handshake } from "../../packages/adapters/rea/protocol.ts";
import { ReaSession } from "../../packages/adapters/rea/session.ts";
import { ReaCaptureInspector } from "../../packages/adapters/rea/capture-inspection.ts";
import { WebCaptureEvidenceFacts } from "../../packages/adapters/rea/web-capture-records.ts";
import { HarIngestionService } from "../../packages/application/har-ingestion.ts";
import { VectorService } from "../../packages/application/vector-service.ts";
import { readAudit } from "../../packages/application/audit.ts";
import { commitDecision } from "../../packages/application/decision.ts";
import { gateFail } from "../../packages/application/gate-failure.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type { Result } from "../../packages/domain/result.ts";
import type { HarImportReceipt } from "../../packages/contracts/imports.ts";
import { testVectorSchema } from "../../packages/contracts/vectors.ts";
import { parseStrict } from "../../packages/contracts/parse.ts";

// The HAR ingestion closed loop (DESIGN §8 ingestion, §5, §9, D25; PRD F02/A01;
// issue #15). The producer here is a fixture MCP server reached over stdio through
// the real client and the real session owner: what this proves is the workbench's
// half of the contract — atomic creation, coordinate retention, declaration
// lifetime, and the refusal to reach a recorded URL.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const SECRET = "hunter2-declared-session-value";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = path.join(ROOT, "tests/fixtures/rea-mcp-fixture.mjs");

const inspectorActor: Actor = { actorId: "local-operator", actorKind: "inspector" };
const builder: Actor = { actorId: "builder-agent", actorKind: "builder" };
const generator: Actor = { actorId: "generation-worker", actorKind: "system" };

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let store: ArtifactStore;
let ingestion: HarIngestionService;
let session: ReaSession;
let constrainedSession: ReaSession;
let projectId: Id;
let otherProjectId: Id;
type Receipt = HarImportReceipt & { auditSeq: number };
let receipt: Receipt;
let harBytes: Uint8Array;
let evidenceId: string;
const heldLocks: { release: () => Promise<void> }[] = [];
const openPeers: { close: () => Promise<void> }[] = [];

function hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function unwrapAsync<T>(result: Result<T, GateFailure>): T {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.reason}:${result.error.message}`);
  return result.value;
}

function failureOf<T>(result: Result<T, GateFailure>): GateFailure {
  if (result.ok) throw new Error("expected a refusal, got a value");
  return result.error;
}

function unwrapStorage<T>(result: Result<T, { code: string; message: string }>): T {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.message}`);
  return result.value;
}

const context = { sensitive: { declaredValues: [SECRET] } };
const emptyContext = { sensitive: null };

function command(overrides: { nonce?: string } & Record<string, unknown> = {}) {
  const { nonce, ...fields } = overrides;
  return {
    filename: "captures/cart-session.har",
    mediaType: "application/json",
    format: "har",
    byteLength: harBytes.byteLength,
    sourceSha256: digestBytes(harBytes),
    idempotencyKey: `import-${hex(String(nonce ?? "one")).slice(0, 12)}`,
    ...fields,
  };
}

async function countStoredFiles(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countStoredFiles(path.join(dir, entry.name));
    else total += 1;
  }
  return total;
}

function rowsOf(table: string): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

function projectRows(table: string, id: Id): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(id) as Record<string, unknown>[];
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-har-"));
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

  const connected = connectReaStdio(process.execPath, [FIXTURE], {
    timeoutMs: 8_000,
    env: { FIXTURE_CASE: "har_records" },
  });
  if (!connected.ok) throw new Error(JSON.stringify(connected.error));
  openPeers.push(connected.value);
  // MCP requires initialize before any other request, so the session is handshaked
  // before the ingestion path calls the capture tool.
  const negotiated = await handshake(connected.value);
  if (!negotiated.ok) throw new Error(JSON.stringify(negotiated.error));
  session = new ReaSession(connected.value);

  const constrained = connectReaStdio(process.execPath, [FIXTURE], {
    timeoutMs: 8_000,
    env: { FIXTURE_CASE: "resource_constraint" },
  });
  if (!constrained.ok) throw new Error(JSON.stringify(constrained.error));
  openPeers.push(constrained.value);
  const negotiatedOther = await handshake(constrained.value);
  if (!negotiatedOther.ok) throw new Error(JSON.stringify(negotiatedOther.error));
  constrainedSession = new ReaSession(constrained.value);

  projectId = newId();
  otherProjectId = newId();
  for (const id of [projectId, otherProjectId]) {
    const created = writer.transact((tx) => {
      tx.insertProject({
        id,
        name: "cart",
        createdAt: nowInstant(),
        graphRevision: 0,
        inventoryRevision: 0,
        schemaVersion: 1,
      });
      return true;
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
  }

  harBytes = new TextEncoder().encode(
    JSON.stringify({
      log: {
        version: "1.2",
        creator: { name: "chrome", version: "141" },
        entries: [
          {
            request: { method: "GET", url: `http://127.0.0.1:9/card?token=${SECRET}` },
            response: { status: 200, content: { size: 2, text: "{}" } },
          },
        ],
      },
    }),
  );

  const inspector = new ReaCaptureInspector({ session });
  ingestion = new HarIngestionService({
    storage: writer,
    artifacts: store,
    inspector,
    ledger: session,
    limits: LIMITS,
  });
  receipt = unwrapAsync(await ingestion.importCapture(projectId, inspectorActor, command(), harBytes, context));
  evidenceId = `ev_${"a".repeat(64)}`;
});

afterAll(async () => {
  await Promise.all(openPeers.map((peer) => peer.close()));
  db.close();
  for (const lock of heldLocks) await lock.release();
  await rm(root, { recursive: true, force: true });
});

describe("import creates the trio atomically (DESIGN §5, §8)", () => {
  it("creates target, inspect job, owned lease and the retained source artifact in one decision", () => {
    expect(receipt.reused).toBe(false);
    const targets = projectRows("targets", projectId);
    const jobs = projectRows("jobs", projectId);
    const leases = db
      .prepare("SELECT * FROM resource_leases WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ?)")
      .all(projectId) as Record<string, unknown>[];
    const artifacts = projectRows("artifacts", projectId);
    expect(targets.length).toBe(1);
    expect(jobs.length).toBe(1);
    expect(leases.length).toBe(1);
    expect(artifacts.length).toBe(1);
    expect(String(jobs[0]?.["state"])).toBe("queued");
    expect(String(jobs[0]?.["cleanup_state"])).toBe("pending");
    expect(String(leases[0]?.["cleanup_state"])).toBe("pending");
    expect(String(targets[0]?.["kind"])).toBe("har");
    expect(String(targets[0]?.["snapshot_digest"])).toBe(digestBytes(harBytes));
    expect(projectRows("events", projectId).map((row) => String(row["type"]))).toContain("job.updated");
    expect(readAudit(writer, { after: 0, projectId, limit: 50 }).ok).toBe(true);
    const journal = unwrapStorage(readAudit(writer, { after: 0, projectId, limit: 50 }));
    expect(journal.some((entry) => entry.action === "har.import" && entry.decision === "allow")).toBe(true);
  });

  it("stores a display locator, never the path the operator named", () => {
    const target = projectRows("targets", projectId)[0];
    expect(String(target?.["original_locator"])).toBe("cart-session.har");
    expect(String(target?.["original_locator"])).not.toContain("captures/");
  });

  it("refuses a digest or length that the bytes do not support", async () => {
    const wrongDigest = failureOf(
      await ingestion.importCapture(projectId, inspectorActor, command({ sourceSha256: asDigest(hex("other")) }), harBytes, context),
    );
    expect(wrongDigest.reason).toBe("source-digest-mismatch");
    const wrongLength = failureOf(
      await ingestion.importCapture(projectId, inspectorActor, command({ byteLength: 7 }), harBytes, context),
    );
    expect(wrongLength.reason).toBe("source-length-mismatch");
    expect(projectRows("targets", projectId).length).toBe(1);
  });

  it("reuses the stored import for the same key and bytes, and refuses a divergent payload", async () => {
    const again = unwrapAsync(
      await ingestion.importCapture(
        projectId,
        inspectorActor,
        command({ idempotencyKey: receipt && String(db.prepare("SELECT idempotency_key FROM jobs WHERE project_id = ? LIMIT 1").all(projectId)[0]?.["idempotency_key"]) }),
        harBytes,
        context,
      ),
    );
    expect(again.reused).toBe(true);
    expect(again.job.id).toBe(receipt.job.id);
    expect(again.targetId).toBe(receipt.targetId);

    const before = projectRows("targets", projectId).length;
    const otherBytes = new TextEncoder().encode(JSON.stringify({ log: { version: "1.2", entries: [] } }));
    const divergent = failureOf(
      await ingestion.importCapture(
        projectId,
        inspectorActor,
        command({
          idempotencyKey: String(db.prepare("SELECT idempotency_key FROM jobs WHERE project_id = ? LIMIT 1").all(projectId)[0]?.["idempotency_key"]),
          byteLength: otherBytes.byteLength,
          sourceSha256: digestBytes(otherBytes),
        }),
        otherBytes,
        context,
      ),
    );
    expect(divergent.code).toBe("IDEMPOTENCY_CONFLICT");
    // The refusal happened inside the transaction, so nothing the attempt wrote
    // survived: no second target, no second job, no orphan artifact row.
    expect(projectRows("targets", projectId).length).toBe(before);
    expect(projectRows("jobs", projectId).length).toBe(1);
    expect(projectRows("artifacts", projectId).length).toBe(1);
  });

  it("refuses an import whose declared value reaches the stored metadata", async () => {
    const leaky = failureOf(
      await ingestion.importCapture(projectId, inspectorActor, command({ filename: `notes/${SECRET}.har`, nonce: "leaky" }), harBytes, context),
    );
    expect(leaky.code).toBe("SENSITIVE_CONTENT_BLOCKED");
    expect(projectRows("targets", projectId).length).toBe(1);
  });

  // §8 line 274's view, read against a target a real import created: the two columns the target
  // row does not carry (which evidence came from it, which job imported it) are the point of the
  // read, and an empty answer would also pass a query whose WHERE clause had been dropped.
  it("requires a declaration context before staging anything", async () => {
    const before = await countStoredFiles(root);
    const failure = failureOf(await ingestion.importCapture(projectId, inspectorActor, command({ nonce: "nodecl" }), harBytes, emptyContext));
    expect(failure.reason).toBe("declaration-context-unavailable");
    expect(projectRows("targets", projectId).length).toBe(1);
    // The refusal happens before anything reaches the disk: a later filter would
    // still catch the value in a row, but the bytes would already be staged.
    expect(await countStoredFiles(root)).toBe(before);
  });

  it("gives Builder and the generation path no import endpoint", async () => {
    expect(failureOf(await ingestion.importCapture(projectId, builder, command({ nonce: "b" }), harBytes, context)).code).toBe("ACCESS_DENIED");
    expect(failureOf(await ingestion.importCapture(projectId, generator, command({ nonce: "g" }), harBytes, context)).code).toBe("ACCESS_DENIED");
  });

  it("never writes the declared value into a row, an event or a journal entry", () => {
    // D25 bounds this: the *declaration* is short-lived and must not be persisted
    // or journalled. The uploaded capture file itself is a retained analysis
    // artifact the operator chose to hand over (§5 targets row), so its bytes are
    // not in scope here — what is in scope is every column this service writes.
    const tables = ["projects", "targets", "jobs", "artifacts", "resource_leases", "events", "audit_entries", "evidence_records"];
    const dumped = tables.map((table) => JSON.stringify(rowsOf(table))).join("\n");
    expect(dumped).not.toContain(SECRET);
    // And the redacted coordinates the producer returned carry no transport value
    // either: the envelope artifact is scanned for the declared literal.
    const envelopeText = JSON.stringify(rowsOf("evidence_records"));
    expect(envelopeText).not.toContain(SECRET);
  });
});

describe("the inspect job preserves what the producer recorded (DESIGN §7.1, §9)", () => {
  it("refuses an inspection that arrives without the operator's declaration", async () => {
    // D25: the filter that keeps declared values out of stored rows is supplied per
    // operation. Without it, parsing the retained capture is refused outright —
    // there is no "assume nothing was declared" path.
    const failure = failureOf(
      await ingestion.runInspection(
        projectId,
        inspectorActor,
        { projectId, jobId: receipt.job.id, expectedJobState: "queued" },
        emptyContext,
      ),
    );
    expect(failure.reason).toBe("declaration-context-unavailable");
    expect(String(db.prepare("SELECT state FROM jobs WHERE id = ?").get(receipt.job.id)?.["state"])).toBe("queued");
    expect(projectRows("evidence_records", projectId).length).toBe(0);
  });

  it("persists the returned envelope and closes the loop into a usable vector", async () => {
    const done = unwrapAsync(
      await ingestion.runInspection(projectId, inspectorActor, { projectId, jobId: receipt.job.id, expectedJobState: "queued" }, context),
    );
    expect(done.jobState).toBe("succeeded");
    expect(done.evidenceIds).toEqual([evidenceId]);
    expect(done.retainedEvidenceIds).toEqual([]);
    expect(session.pendingPersistence).toEqual([]);

    const stored = projectRows("evidence_records", projectId);
    expect(stored.length).toBe(1);
    expect(String(stored[0]?.["id"])).toBe(evidenceId);
    expect(String(stored[0]?.["operation"])).toBe("inspect_web_network_capture");
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(receipt.job.id) as Record<string, unknown>;
    expect(String(job["result_ref"])).toBe(evidenceId);
    expect(String(job["cleanup_state"])).toBe("complete");
    const lease = db.prepare("SELECT * FROM resource_leases WHERE job_id = ?").get(receipt.job.id) as Record<string, unknown>;
    expect(String(lease["cleanup_state"])).toBe("complete");
    expect(projectRows("events", projectId).map((row) => String(row["type"]))).toContain("evidence.committed");

    // The retained coordinates are the point of F02/A01: a vector can be produced
    // from the persisted envelope by ordinal and json-pointer alone.
    const facts = new WebCaptureEvidenceFacts({ storage: writer, artifacts: store, limits: LIMITS });
    const vectors = new VectorService({ storage: writer, artifacts: store, facts, limits: LIMITS });
    const created = unwrapAsync(
      await vectors.create(projectId, inspectorActor, {
        targetId: receipt.targetId,
        snapshotDigest: receipt.snapshotDigest,
        source: {
          evidenceId,
          captureId: null,
          recordOrdinal: 0,
          pointer: "/log/entries/0",
          transactionId: null,
        },
        operationId: "getCart",
        caseKey: "cart-ok",
        sdkInput: { include: "items" },
        expectedOutcome: { kind: "return", value: { items: [] } },
        visibility: "public",
        replacesId: null,
      }, context),
    );
    expect(created.eligibility).toBe("usable");
    const vector = unwrapAsync(await vectors.read(projectId, inspectorActor, created.vectorId));
    expect(vector.request.method).toBe("GET");
    expect(vector.request.url).toBe("http://127.0.0.1:9/card?include=items");
    expect(vector.response.body).toEqual({ kind: "text", text: '{"items":[]}', provenance: "producer-decoded" });
    // The producer redacted the auth header value: the pair is omitted and pointed at.
    expect(vector.request.headers).toEqual([{ name: "accept", value: "application/json" }]);
    expect(vector.redactions[0]?.reason).toBe("transport-auth");
    // The route that serves this object (§8 line 284) parses it against `testVectorSchema`
    // before it answers, so the domain reply and the wire shape are checked against each
    // other here rather than discovered the day a page asks for a vector.
    expect(parseStrict(testVectorSchema, vector).ok).toBe(true);

    const blocked = unwrapAsync(
      await vectors.create(projectId, inspectorActor, {
        targetId: receipt.targetId,
        snapshotDigest: receipt.snapshotDigest,
        source: { evidenceId, captureId: null, recordOrdinal: 1, pointer: "/log/entries/1", transactionId: null },
        operationId: "addItem",
        caseKey: "cart-add",
        sdkInput: {},
        expectedOutcome: { kind: "return", value: {} },
        visibility: "public",
        replacesId: null,
      }, context),
    );
    expect(blocked.eligibility).toBe("blocked");
    expect(blocked.reasons).toContain("vector-response-body-missing");
    const payload = unwrapAsync(await vectors.read(projectId, inspectorActor, blocked.vectorId));
    expect(payload.request.body).toEqual({
      kind: "bytes",
      base64: "e30=",
      sha256: asDigest("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"),
    });
    expect(payload.limitations).toEqual(["response-body-not-retained"]);
  });

  it("refuses an inspection whose expected job state no longer holds", async () => {
    const failure = failureOf(
      await ingestion.runInspection(projectId, inspectorActor, { projectId, jobId: receipt.job.id, expectedJobState: "queued" }, context),
    );
    expect(failure.reason).toBe("job-state-changed");
  });

  it("does not replay a job recovery marked interrupted (§11, D25)", async () => {
    // Recovery marks a lost executor `interrupted`; the state machine gives that
    // state no outgoing edge, so a replay needs a new job, not a re-driven one.
    db.prepare("UPDATE jobs SET state = 'interrupted' WHERE project_id = ? AND id = ?").run(projectId, receipt.job.id);
    const failure = failureOf(
      await ingestion.runInspection(projectId, inspectorActor, { projectId, jobId: receipt.job.id, expectedJobState: "queued" }, context),
    );
    expect(failure.reason).toBe("job-state-changed");
    expect(String(db.prepare("SELECT state FROM jobs WHERE id = ?").get(receipt.job.id)?.["state"])).toBe("interrupted");
    // The one Evidence record this project holds is still the one that was already
    // persisted: nothing was re-parsed behind the refusal.
    expect(projectRows("evidence_records", projectId).length).toBe(1);
  });

  it("records a retained reference instead of re-running the capture", async () => {
    const otherBytes = new TextEncoder().encode(JSON.stringify({ log: { version: "1.2", entries: [] } }));
    const staged = unwrapAsync(
      await ingestion.importCapture(otherProjectId, inspectorActor, {
        filename: "captures/constrained.har",
        mediaType: "application/json",
        format: "har",
        byteLength: otherBytes.byteLength,
        sourceSha256: digestBytes(otherBytes),
        idempotencyKey: "constrained-one",
      }, otherBytes, context),
    );
    const constrainedIngestion = new HarIngestionService({
      storage: writer,
      artifacts: store,
      inspector: new ReaCaptureInspector({ session: constrainedSession }),
      ledger: constrainedSession,
      limits: LIMITS,
    });
    const outcome = unwrapAsync(
      await constrainedIngestion.runInspection(
        otherProjectId,
        inspectorActor,
        { projectId: otherProjectId, jobId: staged.job.id, expectedJobState: "queued" },
        context,
      ),
    );
    expect(outcome.jobState).toBe("failed");
    expect(outcome.retainedEvidenceIds).toEqual([`ev_${"b".repeat(64)}`]);
    expect(outcome.evidenceIds).toEqual([]);
    expect(projectRows("evidence_records", otherProjectId).length).toBe(0);
    expect(constrainedSession.pendingPersistence).toEqual([`ev_${"b".repeat(64)}`]);
    const journal = unwrapStorage(readAudit(writer, { after: 0, projectId: otherProjectId, limit: 50 }));
    expect(journal.some((entry) => entry.reasonCode === "resource-constraint-reference-retained" && entry.decision === "deny")).toBe(true);

    // The stopped row has to survive the read-back: `JobRecord.error` is an ApiError by contract, and
    // a shape only this service knows would not read as "one failed job" - it would make every page of
    // that project's jobs refuse to parse (issue #57's third condition, §12.1).
    const stopped = unwrapStorage(writer.transact((tx) => tx.getJob(otherProjectId, asId(staged.job.id))));
    if (stopped === null) throw new Error("the stopped row is not in the store");
    const record = projectJobRecord(stopped, []);
    expect(record.state).toBe("failed");
    expect(record.error).not.toBeNull();
    if (record.error === null) return;
    expect(apiErrorSchema.safeParse(record.error).success).toBe(true);
    expect(record.error.code).toBe("RESOURCE_LIMIT");
    expect(record.error.message).toBe("resource-constraint-reference-retained");
    expect(record.error.retryable).toBe(false);
    expect(record.error.requestId).toBe(stopped.idempotencyKey);
  });

  it("reads back the evidence and the import job a captured target owns (§8 line 274)", async () => {
    const targets = new TargetService({ storage: writer });
    const view = unwrapAsync(targets.read(projectId, inspectorActor, asId(receipt.targetId)));
    expect(view.id).toBe(receipt.targetId);
    expect(view.kind).toBe("har");
    expect(view.sourceSha256).not.toBeNull();
    expect(view.snapshotDigest).not.toBeNull();
    // A captured target has no identity *reason*: the column is for the unknown, and null here is
    // what keeps "declared, not captured" from looking the same as "capture could not identify".
    expect(view.identityReason).toBeNull();
    // Compared against the rows that exist rather than against a spelled-out id: the point is
    // that the read names this target's evidence and nobody else's, so a dropped WHERE clause and
    // an invented id would both show up here.
    const stored = (db.prepare("SELECT id FROM evidence_records WHERE target_id = ? ORDER BY id ASC").get(receipt.targetId) !== undefined
      ? (db.prepare("SELECT id FROM evidence_records WHERE target_id = ? ORDER BY id ASC").all(receipt.targetId) as { id: string }[])
      : []
    ).map((row) => row.id);
    expect(stored.length).toBeGreaterThan(0);
    expect(view.evidenceIds).toEqual(stored);
    expect(view.importJobId).toBe(receipt.job.id);

    const builder = { actorId: "builder-agent", actorKind: "builder" } as const;
    const refused = targets.read(projectId, builder, asId(receipt.targetId));
    expect(!refused.ok && refused.error.reason).toBe("role-may-not-read-targets");
    const refusedDeclare = targets.declare(projectId, builder, { kind: "url", url: "https://shop.example/cart" });
    expect(!refusedDeclare.ok && refusedDeclare.error.reason).toBe("role-may-not-declare-targets");

    // A second, freshly declared target in the same project is what makes the two new reads mean
    // something: without the target filter each of them would answer from the imported target's
    // rows, and both would still look plausible.
    const declaredId = asId(unwrapAsync(targets.declare(projectId, inspectorActor, { kind: "url", url: "https://shop.example/other" })).id);
    const empty = unwrapAsync(targets.read(projectId, inspectorActor, declaredId));
    expect(empty.evidenceIds).toEqual([]);
    expect(empty.importJobId).toBeNull();
    expect(empty.identityReason).toBe("url-declared-not-captured");
    expect(empty.snapshotDigest).toBeNull();

    // A job that is not an import does not answer `importJobId`: §8 line 272 names the inspect
    // ingestion job, and a capture row for the same target must not be reported as one.
    const jobId = newId();
    const created = nowInstant();
    const inserted = writer.transact((tx) => {
      const outcome = tx.insertJob({
        id: jobId,
        projectId,
        targetId: declaredId,
        kind: "capture",
        state: "queued",
        cleanupState: "pending",
        inputJson: {},
        resultRef: null,
        errorJson: null,
        idempotencyKey: `capture-${jobId}`,
        requestDigest: asDigest("e".repeat(64)),
        deadlineAt: null,
        retryAt: null,
        createdAt: created,
        updatedAt: created,
      });
      if (outcome.outcome !== "inserted") throw new Error(`job ${outcome.outcome}`);
      return true;
    });
    if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
    expect(unwrapAsync(targets.read(projectId, inspectorActor, declaredId)).importJobId).toBeNull();
  });

});

describe("the shared decision unit refuses without leaving rows (DESIGN §12.2)", () => {
  it("rolls back a refusal and journals the deny", () => {
    const doomed = newId();
    const outcome = commitDecision(writer, {
      projectId,
      actor: inspectorActor,
      resourceType: "probe",
      action: "probe.refusal",
      resourceId: doomed,
      allowReason: "probe-allowed",
      metadata: {},
      work: (tx) => {
        // A row is written first, on purpose: the point of the test is that a
        // refusal arriving afterwards leaves nothing committed.
        tx.insertTarget({
          id: doomed,
          projectId,
          kind: "har",
          originalLocator: "doomed",
          sourceSha256: null,
          sourceArtifactId: null,
          snapshotDigest: null,
          identityReason: "test-only",
          createdAt: nowInstant(),
        });
        return { kind: "failure", failure: gateFail("INVALID_INPUT", "refused-after-write", "no") };
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.reason).toBe("refused-after-write");
    expect(db.prepare("SELECT * FROM targets WHERE id = ?").get(doomed)).toBeUndefined();
    const journal = unwrapStorage(readAudit(writer, { after: 0, projectId, limit: 500 }));
    const denial = journal.find((entry) => entry.action === "probe.refusal" && entry.decision === "deny");
    expect(denial?.reasonCode).toBe("refused-after-write");
    expect(journal.some((entry) => entry.action === "probe.refusal" && entry.decision === "allow")).toBe(false);
  });
});

describe("the ingestion path cannot reach a recorded URL (PRD F02, DESIGN §12)", () => {
  const SOURCES = [
    "packages/application/har-ingestion.ts",
    "packages/contracts/imports.ts",
    "packages/adapters/rea/capture-inspection.ts",
    "packages/adapters/rea/web-capture-records.ts",
  ];

  it("imports no network client and calls no fetch", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      for (const specifier of ["node:http", "node:https", "node:net", "node:dgram", "node:tls", "node:dns"]) {
        if (text.includes(`"${specifier}"`)) offenders.push(`${file} -> ${specifier}`);
      }
      if (/\bfetch\s*\(/.test(text)) offenders.push(`${file} -> fetch(`);
      if (/\bnew WebSocket\b|\bXMLHttpRequest\b/.test(text)) offenders.push(`${file} -> browser transport`);
    }
    expect(offenders).toEqual([]);
  });

  it("holds the producer call behind a port the service cannot widen", () => {
    const text = readFileSync(path.join(ROOT, "packages/application/har-ingestion.ts"), "utf8");
    // The service may only hand a path the artifact store minted to the port, and
    // the port's own request shape has no field for a URL, a command or an image.
    expect(text).toContain("absolutePathFor(projectId, artifact.storageKey)");
    const port = readFileSync(path.join(ROOT, "packages/application/ports.ts"), "utf8");
    const request = port.slice(port.indexOf("export type CaptureInspectionRequest"), port.indexOf("export type CaptureInspectionOutcome"));
    for (const forbidden of ["url", "command", "image", "shell", "host", "timeout"]) {
      expect(request.includes(forbidden), `the inspection request exposes ${forbidden}`).toBe(false);
    }
  });
});

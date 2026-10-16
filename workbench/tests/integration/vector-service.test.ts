import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { acquireWorkerLock, applyMigrations, openWriteConnection, planMigrations } from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { WebCaptureEvidenceFacts } from "../../packages/adapters/rea/web-capture-records.ts";
import { readAudit } from "../../packages/application/audit.ts";
import { VectorService } from "../../packages/application/vector-service.ts";
import type { VectorActor, VectorCommit, VectorFailure } from "../../packages/application/vector-service.ts";
import type { EvidenceRow, JobRow, TargetRow, VectorRow } from "../../packages/application/ports.ts";
import { VECTOR_PAGE_MAX_LIMIT, vectorPageSchema, type VectorPage } from "../../packages/contracts/vectors.ts";

// VectorService against a real SQLite file, a real artifact store and a persisted
// REA capture envelope (DESIGN §7.1, §7.4, D26/D27). The envelope is the shape
// mirrored from REA 6.4.0 at 98d8470d, so a reader drift fails here rather than
// in front of a live provider.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const SNAPSHOT = ("1" as const).repeat(64) as Digest;
const EV_GOOD = `ev_${("c" as const).repeat(64)}`;
const EV_SENSITIVE = `ev_${("d" as const).repeat(64)}`;
const SECRET = "hunter2-session-token";

function hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type Err<T> = { ok: false; error: T };

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let store: ArtifactStore;
let service: VectorService;
let projectId: Id;
let targetId: Id;
let otherTargetId: Id;
let envelopeArtifactId: Id;
let _sensitiveArtifactId: Id;
const heldLocks: { release: () => Promise<void> }[] = [];

const inspector: VectorActor = { actorId: "local-operator", actorKind: "inspector" };
const reviewer: VectorActor = { actorId: "reviewer-one", actorKind: "reviewer" };
const builder: VectorActor = { actorId: "builder-agent", actorKind: "builder" };
const generator: VectorActor = { actorId: "generation-worker", actorKind: "system" };

function createRecord(ordinal: number) {
  if (ordinal === 0) {
    return {
      ordinal: 0,
      location: { kind: "json-pointer", pointer: "/records/0/reported" },
      reported: {
        cache: {},
        timings: { send: 1 },
        request: {
          method: "GET",
          url: "https://shop.example/api/cart",
          httpVersion: "HTTP/2",
          queryString: [{ name: "include", value: "items" }],
          headers: [
            { name: "authorization", value: "redacted" },
            { name: "accept", value: "application/json" },
          ],
          cookies: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: "OK",
          headers: [{ name: "content-type", value: "application/json" }],
          cookies: [],
          content: { size: 11, compression: 0, mimeType: "application/json", text: '{"items":[]}' },
          bodySize: 11,
        },
      },
      binary_fields: [],
      numeric_literals: [{ pointer: "/records/0/reported/response/status", producer_type: "json-number", literal: "200" }],
      redactions: [{ pointer: "/records/0/reported/request/headers/0/value", reason: "transport-credential" }],
      limitations: [],
    };
  }
  if (ordinal === 1) {
    return {
      ordinal: 1,
      location: { kind: "json-pointer", pointer: "/records/1/reported" },
      reported: {
        request: {
          method: "POST",
          url: "https://shop.example/api/cart/items",
          queryString: [],
          headers: [{ name: "content-type", value: "application/json" }],
          postData: { mimeType: "application/json", text: "{}" },
        },
        response: {
          status: 201,
          headers: [{ name: "content-type", value: "application/json" }],
          content: { size: 0, mimeType: "application/json" },
        },
      },
      // A retained binary sidecar wins over the reported text and is carried as
      // bytes with the producer's own digest.
      binary_fields: [
        {
          pointer: "/records/1/reported/request/postData/text",
          state: "retained",
          representation: "har-base64-content",
          content_base64: "e30=",
          bytes: 2,
          sha256: hex("{}"),
        },
      ],
      numeric_literals: [],
      redactions: [],
      limitations: ["response-body-not-retained"],
    };
  }
  return {
    ordinal: 2,
    location: { kind: "json-pointer", pointer: "/records/2/reported" },
    reported: {
      request: {
        method: "PUT",
        url: "https://shop.example/api/cart/items/9",
        queryString: [],
        headers: [],
        postData: { mimeType: "application/octet-stream", text: "YWJj" },
      },
      response: { status: 204, headers: [], content: { size: 0, mimeType: "" } },
    },
    // The producer's own digest is wrong here, which the service must refuse as an
    // integrity failure instead of archiving a self-contradictory sample.
    binary_fields: [
      {
        pointer: "/records/2/reported/request/postData/text",
        state: "retained",
        representation: "producer-bytes",
        content_base64: "YWJj",
        bytes: 3,
        sha256: hex("not-abc"),
      },
    ],
    numeric_literals: [],
    redactions: [],
    limitations: [],
  };
}

function envelopeJson(evidenceId: string, sensitiveValues: string[]): JsonValue {
  return {
    evidence_id: evidenceId,
    subject: {
      name: "cart.har",
      digest: { sha256: SNAPSHOT },
      format: "file",
      architecture: null,
      local_path: "/captures/cart.har",
    },
    provider: { id: "rea.web.network", name: "Web network capture", version: "6.4.0" },
    analysis_profile: null,
    predicate_type: "web-network-capture",
    operation: "inspect_web_network_capture",
    parameters: {
      capture_path: "/captures/cart.har",
      format: "har",
      sensitive_values: sensitiveValues,
    },
    raw_result: null,
    normalized_result: {
      decoder: { id: "har-1.2", name: "HAR", version: "1.2" },
      container: {
        reported: { log: { version: "1.2", creator: { name: "chrome", version: "141" } } },
        numeric_literals: [],
        redactions: [],
        records_pointer: "/log/entries",
      },
      total_records: 3,
      records: [createRecord(0), createRecord(1), createRecord(2)],
      artifact: { path: "/captures/cart.har", sha256: SNAPSHOT, bytes: 2048 },
      format: "har",
      runtime_attribution: "unknown",
      limitations: [],
    },
    confidence: "observed",
    authority: "historical-reference",
    environment: null,
    limitations: [],
    relationship_coverage: { status: "complete" },
    locations: [{ kind: "artifact-path", path: "/captures/cart.har" }],
    evidence_links: [],
  };
}

async function seedEnvelope(evidenceId: string, sensitiveValues: string[]): Promise<Id> {
  const bytes = new TextEncoder().encode(JSON.stringify(envelopeJson(evidenceId, sensitiveValues)));
  const published = await store.publish(projectId, "inspector", bytes);
  if (!published.ok) throw new Error(JSON.stringify(published.error));
  const artifactId = newId();
  const jobId = newId();
  const created = nowInstant();
  const inserted = writer.transact((tx) => {
    tx.insertJob(job({ id: jobId, targetId }));
    tx.insertArtifact({
      id: artifactId,
      projectId,
      jobId,
      class: "inspector",
      sha256: published.value.sha256,
      digestReason: null,
      byteLength: published.value.byteLength,
      storageKey: published.value.storageKey,
      mediaType: "application/json",
      createdAt: created,
    });
    const evidence: EvidenceRow = {
      projectId,
      id: evidenceId,
      targetId,
      jobId,
      artifactId,
      providerJson: { id: "rea.web.network", name: "Web network capture", version: "6.4.0" },
      operation: "inspect_web_network_capture",
      confidence: "observed",
      authority: "historical-reference",
      createdAt: created,
    };
    tx.insertEvidence(evidence);
    return artifactId;
  });
  if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
  return inserted.value;
}

function job(input: { id: Id; targetId: Id }): JobRow {
  const created = nowInstant();
  return {
    id: input.id,
    projectId,
    targetId: input.targetId,
    kind: "inspect",
    state: "succeeded",
    cleanupState: "complete",
    inputJson: { capture_path: "/captures/cart.har", format: "har" },
    resultRef: null,
    errorJson: null,
    idempotencyKey: `seed-${input.id}`,
    requestDigest: asDigest(hex("seed")),
    deadlineAt: null,
    retryAt: null,
    createdAt: created,
    updatedAt: created,
  };
}

function target(id: Id): TargetRow {
  return {
    id,
    projectId,
    kind: "har",
    originalLocator: null,
    sourceSha256: SNAPSHOT,
    sourceArtifactId: null,
    snapshotDigest: SNAPSHOT,
    identityReason: null,
    createdAt: nowInstant(),
  };
}

function coordinate(ordinal: number) {
  return {
    evidenceId: EV_GOOD,
    captureId: null,
    recordOrdinal: ordinal,
    pointer: `/records/${String(ordinal)}/reported`,
    transactionId: null,
  };
}

function createRequest(ordinal: number, overrides: Record<string, JsonValue> = {}) {
  return {
    targetId,
    snapshotDigest: SNAPSHOT,
    source: coordinate(ordinal),
    operationId: "getCart",
    caseKey: `cart-case-${String(ordinal)}`,
    sdkInput: { include: "items" },
    expectedOutcome: { kind: "return", value: { items: [] } },
    visibility: "public",
    replacesId: null,
    ...overrides,
  };
}

const context = { sensitive: { declaredValues: [SECRET] } };

function unwrap<T>(result: { ok: true; value: T } | Err<VectorFailure>): T {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.reason}:${result.error.message}`);
  return result.value;
}

function reason(result: { ok: true } | Err<VectorFailure>): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error.reason;
}

function code(result: { ok: true } | Err<VectorFailure>): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error.code;
}

async function auditRows(): Promise<{ action: string; decision: string; reasonCode: string }[]> {
  const rows = readAudit(writer, { after: 0, projectId, limit: 200 });
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  return rows.value.map((entry) => ({ action: entry.action, decision: entry.decision, reasonCode: entry.reasonCode }));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-vectors-"));
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

  const facts = new WebCaptureEvidenceFacts({ storage: writer, artifacts: store, limits: LIMITS });
  service = new VectorService({ storage: writer, artifacts: store, facts, limits: LIMITS });

  projectId = newId();
  targetId = newId();
  otherTargetId = newId();
  const created = nowInstant();
  const seeded = writer.transact((tx) => {
    tx.insertProject({
      id: projectId,
      name: "cart",
      createdAt: created,
      graphRevision: 0,
      inventoryRevision: 0,
      schemaVersion: 1,
    });
    tx.insertTarget(target(targetId));
    tx.insertTarget(target(otherTargetId));
    return true;
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  envelopeArtifactId = await seedEnvelope(EV_GOOD, []);
  _sensitiveArtifactId = await seedEnvelope(EV_SENSITIVE, [SECRET]);
});

afterAll(async () => {
  db.close();
  for (const lock of heldLocks) await lock.release();
  await rm(root, { recursive: true, force: true });
});

describe("VectorService produces the only writable sample shape (DESIGN §7.1)", () => {
  let usableCommit: VectorCommit;

  it("extracts a usable vector from persisted evidence", async () => {
    const commit = unwrap(await service.create(projectId, inspector, createRequest(0), context));
    usableCommit = commit;
    expect(commit.eligibility).toBe("usable");
    expect(commit.reasons).toEqual([]);
    expect(commit.inventoryRevision).toBe(1);

    const vector = unwrap(await service.read(projectId, inspector, commit.vectorId));
    expect(vector.request.method).toBe("GET");
    expect(vector.request.url).toBe("https://shop.example/api/cart");
    expect(vector.response.status).toBe(200);
    expect(vector.response.body).toEqual({
      kind: "text",
      text: '{"items":[]}',
      provenance: "producer-decoded",
    });
    expect(vector.digest).toBe(commit.digest);
    expect(vector.review.status).toBe("draft");
  });

  it("drops a redacted header value but keeps the disclosure", async () => {
    const vector = unwrap(await service.read(projectId, inspector, usableCommit.vectorId));
    // The producer redacted headers[0].value: the pair cannot stay as an empty
    // string (that would claim an empty value) so it is omitted and pointed at.
    expect(vector.request.headers).toEqual([{ name: "accept", value: "application/json" }]);
    expect(vector.redactions).toEqual([
      {
        fieldPointer: "/records/0/reported/request/headers/0/value",
        reason: "transport-auth",
        representation: "omitted",
      },
    ]);
  });

  it("refuses a create request that carries its own request or response", async () => {
    const forged = createRequest(0, {
      request: { method: "GET", url: "https://shop.example/api/cart", query: [], headers: [], body: { kind: "empty" } },
      response: { status: 200, headers: [], body: { kind: "empty" } },
      eligibility: "usable",
      reasons: [],
    });
    const refusal = await service.create(projectId, inspector, forged, context);
    expect(code(refusal)).toBe("INVALID_INPUT");
    expect(reason(refusal)).toBe("create-request");
    if (!refusal.ok) {
      expect(refusal.error.details["issues"]).toContain("request");
      expect(refusal.error.details["issues"]).toContain("response");
    }
  });

  it("blocks a record with no retained response body and still counts it", async () => {
    const commit = unwrap(await service.create(projectId, inspector, createRequest(1, { caseKey: "cart-case-1" }), context));
    expect(commit.eligibility).toBe("blocked");
    expect(commit.reasons).toContain("vector-response-body-missing");

    const listed = service.list(projectId, inspector, targetId);
    expect(listed.ok && listed.value.length).toBe(2);
    const payload = unwrap(await service.read(projectId, inspector, commit.vectorId));
    expect(payload.request.body).toEqual({ kind: "bytes", base64: "e30=", sha256: asDigest(hex("{}")) });
    expect(payload.limitations).toEqual(["response-body-not-retained"]);
  });

  it("refuses a record whose producer digest does not match its bytes", async () => {
    const before = writer.transact((tx) => tx.getProject(projectId));
    if (!before.ok) throw new Error("project missing");
    const refusal = await service.create(projectId, inspector, createRequest(2, { caseKey: "cart-case-2" }), context);
    expect(code(refusal)).toBe("INVALID_INPUT");
    expect(reason(refusal)).toBe("body-bytes-digest-mismatch");

    const after = writer.transact((tx) => ({
      rows: tx.listVectors(projectId, { targetId, evidenceId: null, limit: 10 }),
      revision: tx.getProject(projectId)?.inventoryRevision ?? -1,
    }));
    if (!after.ok) throw new Error("read failed");
    expect(after.value.rows.length).toBe(2);
    expect(after.value.revision).toBe(before.value?.inventoryRevision);
    const journal = await auditRows();
    expect(journal.filter((entry) => entry.reasonCode === "body-bytes-digest-mismatch")).toEqual([]);
  });

  it("refuses a projection of a record whose capture declared sensitive values", async () => {
    const refusal = await service.create(
      projectId,
      inspector,
      createRequest(0, { source: { ...coordinate(0), evidenceId: EV_SENSITIVE } }),
      context,
    );
    expect(code(refusal)).toBe("SENSITIVE_PROJECTION_UNSUPPORTED");
    const journal = await auditRows();
    expect(journal.some((entry) => entry.reasonCode === "sensitive-projection-unsupported")).toBe(true);
  });

  it("refuses SDK input that repeats a declared secret", async () => {
    const refusal = await service.create(
      projectId,
      inspector,
      createRequest(0, { sdkInput: { token: SECRET } }),
      context,
    );
    expect(code(refusal)).toBe("SENSITIVE_CONTENT_BLOCKED");
  });

  it("gives Builder no vector endpoint at all", async () => {
    const created = await service.create(projectId, builder, createRequest(0), context);
    expect(code(created)).toBe("ACCESS_DENIED");
    const listed = service.list(projectId, builder, targetId);
    expect(code(listed)).toBe("ACCESS_DENIED");
    const read = await service.read(projectId, builder, usableCommit.vectorId);
    expect(code(read)).toBe("ACCESS_DENIED");
    const journal = await auditRows();
    expect(journal.filter((entry) => entry.reasonCode === "builder-has-no-vector-permission").length).toBe(3);
  });

  it("keeps a holdout vector away from the generation path", async () => {
    const commit = unwrap(
      await service.create(projectId, inspector, createRequest(0, { visibility: "holdout", caseKey: "cart-holdout" }), context),
    );
    const read = await service.read(projectId, generator, commit.vectorId);
    expect(code(read)).toBe("ACCESS_DENIED");
    const listed = service.list(projectId, generator, targetId);
    expect(listed.ok && listed.value.every((row) => row.visibility === "public")).toBe(true);
  });
});

describe("revision chain and review (DESIGN §7.4)", () => {
  let parentId: Id;
  let revisionA: Id;
  let revisionB: Id;
  let revision: number;

  it("creates a successor that points at the same source record", async () => {
    const parent = unwrap(
      await service.create(projectId, inspector, createRequest(0, { caseKey: "chain-case" }), context),
    );
    parentId = parent.vectorId;
    revision = parent.inventoryRevision;
    const successor = unwrap(
      await service.create(
        projectId,
        inspector,
        createRequest(0, { caseKey: "chain-case", replacesId: parent.vectorId, sdkInput: { include: "items", page: 1 } }),
        context,
      ),
    );
    revisionA = successor.vectorId;
    revision = successor.inventoryRevision;
    expect(successor.eligibility).toBe("usable");
    const stored = unwrap(await service.read(projectId, inspector, successor.vectorId));
    expect(stored.replacesId).toBe(parentId);
  });

  it("refuses to replace a different source record", async () => {
    const refusal = await service.create(
      projectId,
      inspector,
      createRequest(1, { caseKey: "chain-case", replacesId: parentId }),
      context,
    );
    expect(code(refusal)).toBe("INVALID_INPUT");
    expect(reason(refusal)).toBe("replacement-not-same-record");
    if (!refusal.ok) expect(refusal.error.details["mismatched"]).toContain("record");

    const otherCase = await service.create(
      projectId,
      inspector,
      createRequest(0, { caseKey: "another-case", replacesId: parentId }),
      context,
    );
    expect(reason(otherCase)).toBe("replacement-not-same-record");
    if (!otherCase.ok) expect(otherCase.error.details["mismatched"]).toContain("caseKey");
    const journal = await auditRows();
    expect(journal.filter((entry) => entry.reasonCode === "replacement-not-same-record").length).toBe(2);
  });

  it("refuses a replacement chain that loops", async () => {
    const first = newId();
    const second = newId();
    const locator = JSON.parse(JSON.stringify(coordinate(0))) as JsonValue;
    // No sequence of service calls can create this: a link is refused unless the
    // predecessor already exists. The rows are patched directly so the guard is
    // still provable against a state a corrupted or migrated database could hold.
    const inserted = writer.transact((tx) => {
      for (const [id, replaces] of [
        [first, null],
        [second, first],
      ] as [Id, Id | null][]) {
        tx.insertVector({
          id,
          projectId,
          targetId,
          evidenceId: EV_GOOD,
          sourceLocatorJson: locator,
          snapshotDigest: SNAPSHOT,
          payloadArtifactId: envelopeArtifactId,
          digest: asDigest(hex(`cycle-${id}`)),
          replacesId: replaces,
          caseKey: "chain-case",
          visibility: "public",
          eligibility: "usable",
          reasonsJson: [],
          reviewStatus: "draft",
          reviewRecordJson: null,
        });
      }
      return true;
    });
    expect(inserted.ok).toBe(true);
    const closed = db.prepare("UPDATE test_vectors SET replaces_id = ? WHERE id = ?").run(second, first);
    expect(Number(closed.changes)).toBe(1);

    const refusal = await service.create(
      projectId,
      inspector,
      createRequest(0, { caseKey: "chain-case", replacesId: first }),
      context,
    );
    expect(code(refusal)).toBe("REVISION_CONFLICT");
    expect(reason(refusal)).toBe("revision-cycle");
  });

  it("holds at most one approved successor per revision", async () => {
    const sibling = unwrap(
      await service.create(
        projectId,
        inspector,
        createRequest(0, { caseKey: "chain-case", replacesId: parentId, sdkInput: { include: "totals" } }),
        context,
      ),
    );
    revisionB = sibling.vectorId;
    revision = sibling.inventoryRevision;

    const firstDigest = unwrap(await service.read(projectId, reviewer, revisionA)).digest;
    const approved = unwrap(
      await service.review(
        projectId,
        reviewer,
        revisionA,
        { decision: "approved", reviewerId: "reviewer-one", digest: firstDigest, expectedInventoryRevision: revision },
        context,
      ),
    );
    expect(approved.inventoryRevision).toBe(revision + 1);

    const siblingDigest = unwrap(await service.read(projectId, reviewer, revisionB)).digest;
    const conflict = await service.review(
      projectId,
      reviewer,
      revisionB,
      {
        decision: "approved",
        reviewerId: "reviewer-one",
        digest: siblingDigest,
        expectedInventoryRevision: approved.inventoryRevision,
      },
      context,
    );
    expect(code(conflict)).toBe("REVISION_CONFLICT");
    expect(reason(conflict)).toBe("two-approved-successors");
  });

  it("approves the digest under review and nothing else", async () => {
    const live = liveRevision();
    const stale = await service.review(
      projectId,
      reviewer,
      revisionB,
      { decision: "approved", reviewerId: "reviewer-one", digest: asDigest(hex("other")), expectedInventoryRevision: live - 1 },
      context,
    );
    expect(reason(stale)).toBe("inventory-revision-changed");

    const wrongDigest = await service.review(
      projectId,
      reviewer,
      revisionB,
      { decision: "approved", reviewerId: "reviewer-one", digest: asDigest(hex("nope")), expectedInventoryRevision: live },
      context,
    );
    expect(code(wrongDigest)).toBe("REVISION_CONFLICT");
    expect(reason(wrongDigest)).toBe("approved-digest-mismatch");
    // Both refusals ran after the revision check, so only the digest one proves
    // the digest gate; the sibling rule is asserted in the case above.
    expect(reason(stale)).not.toBe(reason(wrongDigest));
  });

  it("never rewrites the payload an approval binds", async () => {
    const beforeArtifact = writer.transact((tx) => tx.getVector(projectId, revisionA)?.payloadArtifactId ?? null);
    if (!beforeArtifact.ok || beforeArtifact.value === null) throw new Error("vector missing");
    const payloadArtifactId = beforeArtifact.value;
    const artifactRow = writer.transact((tx) => tx.getArtifact(projectId, payloadArtifactId));
    if (!artifactRow.ok || artifactRow.value === null) throw new Error("artifact missing");
    const stored = await store.read(projectId, artifactRow.value.storageKey);
    if (!stored.ok) throw new Error("payload unreadable");
    expect(hex(new TextDecoder().decode(stored.value))).toBe(artifactRow.value.sha256);

    const reviewed = unwrap(await service.read(projectId, reviewer, revisionA));
    expect(reviewed.review.status).toBe("approved");
    expect(reviewed.review.approvedDigest).toBe(reviewed.digest);
    expect(reviewed.review.reviewerId).toBe("reviewer-one");
    // The approval only moves the review columns; the content file is immutable.
    const afterArtifact = writer.transact((tx) => tx.getVector(projectId, revisionA)?.payloadArtifactId ?? null);
    expect(afterArtifact.ok && afterArtifact.value).toBe(payloadArtifactId);
  });

  it("records a refusal in the same transaction it refused", async () => {
    const journal = await auditRows();
    const denies = journal.filter((entry) => entry.decision === "deny" && entry.action === "vector.create");
    expect(denies.length).toBeGreaterThan(0);
    const allows = journal.filter((entry) => entry.decision === "allow" && entry.action === "vector.create");
    expect(allows.length).toBeGreaterThan(0);
    expect(journal.some((entry) => entry.reasonCode === "vector-created" && entry.decision === "allow")).toBe(true);
  });

  it("refuses a second decision on the same vector", async () => {
    const refusal = await service.review(
      projectId,
      reviewer,
      revisionA,
      { decision: "rejected", reviewerId: "reviewer-two", digest: null, expectedInventoryRevision: liveRevision() },
      context,
    );
    expect(reason(refusal)).toBe("vector-already-reviewed");
  });

  it("gives a reviewer-only decision path to non-reviewers", async () => {
    const refusal = await service.review(
      projectId,
      generator,
      revisionB,
      { decision: "approved", reviewerId: "generation-worker", digest: null, expectedInventoryRevision: 0 },
      context,
    );
    expect(code(refusal)).toBe("ACCESS_DENIED");
  });

  it("refuses a vector that references evidence from another target", async () => {
    const refusal = await service.create(
      projectId,
      inspector,
      createRequest(0, { targetId: otherTargetId, caseKey: "cross-target" }),
      context,
    );
    expect(reason(refusal)).toBe("evidence-target-mismatch");
    // The refusal happened inside the transaction, so its deny journal entry
    // committed with it rather than being written by a separate call.
    const journal = await auditRows();
    expect(journal.filter((entry) => entry.reasonCode === "evidence-target-mismatch" && entry.decision === "deny").length).toBe(1);
  });

  it("refuses coordinates the producer cannot answer", async () => {
    const missing = await service.create(
      projectId,
      inspector,
      createRequest(0, { source: { ...coordinate(0), recordOrdinal: 41 } }),
      context,
    );
    expect(code(missing)).toBe("NOT_FOUND");
    expect(reason(missing)).toBe("record-ordinal-unavailable");

    const inventedTransaction = await service.create(
      projectId,
      inspector,
      createRequest(0, { source: { ...coordinate(0), transactionId: "txn-1" } }),
      context,
    );
    expect(reason(inventedTransaction)).toBe("transaction-coordinate-unsupported");

    const wrongPointer = await service.create(
      projectId,
      inspector,
      createRequest(0, { source: { ...coordinate(0), pointer: "/records/9/reported" } }),
      context,
    );
    expect(code(wrongPointer)).toBe("INVALID_INPUT");
  });

  it("keeps the whole history in the inventory", () => {
    const listed = service.list(projectId, inspector, targetId);
    expect(listed.ok).toBe(true);
    const rows = (listed as { ok: true; value: VectorRow[] }).value;
    // Parents and superseded revisions stay listed; §7.4 forbids deletion.
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((row) => row.replacesId !== null).length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });
});

function liveRevision(): number {
  // Read the live revision rather than a remembered one: every case in this file
  // may have moved the inventory since the last assertion.
  const project = writer.transact((tx) => tx.getProject(projectId));
  if (!project.ok || project.value === null) throw new Error("project missing");
  return project.value.inventoryRevision;
}

// The inventory page (§8 line 283 / issue #58).
//
// This is the route a reviewer browses before opening one sample, so the properties that
// matter are the ones the listing itself must keep: the page reports the inventory it was cut
// at, its cursor cannot be re-used across a moved inventory, a summary carries the six named
// fields and no body, and a row the caller may not see is absent from the query rather than
// removed from the answer afterwards.

describe("the inventory page (§8 line 283)", () => {
  function pageOf(
    input: { cursor: string | null; limit: number | null },
    actor: VectorActor = inspector,
  ): { ok: true; value: VectorPage } | { ok: false; error: VectorFailure } {
    return service.page(projectId, actor, { targetId, cursor: input.cursor, limit: input.limit });
  }

  function pageIds(count: number): Id[] {
    // The rows this file has already written, in the order the page must produce them.
    const rows = writer.transact((tx) => tx.listVectorsAfter(projectId, { targetId, afterId: null, publicOnly: false, limit: 500 }));
    if (!rows.ok) throw new Error(JSON.stringify(rows.error));
    return rows.value.slice(0, count).map((row) => row.id);
  }

  it("answers with the six summary fields and none of the body", () => {
    const page = unwrap(pageOf({ cursor: null, limit: 3 }));
    expect(vectorPageSchema.safeParse(page).success).toBe(true);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.inventoryRevision).toBe(liveRevision());
    const first = page.items[0] as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(["caseKey", "digest", "eligibility", "id", "review", "visibility"]);
    // A listing that leaked `request`/`response` would put the retained bytes in front of
    // every role that has a page open, before anyone asked for one sample.
    for (const leaked of ["request", "response", "source", "coverage", "redactions", "reasons"]) {
      expect(first[leaked]).toBeUndefined();
    }
  });

  it("walks the whole inventory by cursor without repeating or dropping a row", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 200; guard += 1) {
      const page: VectorPage = unwrap(pageOf({ cursor, limit: 2 }));
      // Two, not "two plus the probe row": the extra read exists to decide whether to hand
      // back a cursor, and it must never reach the answer.
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const everything = pageIds(500).map((id) => String(id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(everything);
  });

  it("does not promise a cursor for a page that happens to come out exactly full", () => {
    // Same trap the audit page test caught: every loop above stops on a null cursor, so a
    // last page that lies would still pass them.
    const size = pageIds(500).length;
    const exact = unwrap(pageOf({ cursor: null, limit: size }));
    expect(exact.items.length).toBe(size);
    expect(exact.nextCursor).toBeNull();
    const short = unwrap(pageOf({ cursor: null, limit: size - 1 }));
    expect(short.nextCursor).not.toBeNull();
  });

  it("refuses a cursor from before the inventory moved, and says which two revisions disagree", async () => {
    const first = unwrap(pageOf({ cursor: null, limit: 1 }));
    expect(first.nextCursor).not.toBeNull();
    const pinned = first.inventoryRevision;
    await service.create(projectId, inspector, createRequest(0, { caseKey: "page-move-case" }), context);
    const refusal = await service.page(projectId, inspector, { targetId, cursor: first.nextCursor, limit: 2 });
    if (refusal.ok) throw new Error("a moved inventory must refuse the stale page cursor");
    expect(refusal.error.code).toBe("REVISION_CONFLICT");
    expect(refusal.error.reason).toBe("vector-inventory-moved");
    expect(refusal.error.details["pinnedRevision"]).toBe(pinned);
    expect(refusal.error.details["currentRevision"]).toBe(liveRevision());
  });

  it("keeps a holdout row inside the query, so the page and its cursor describe the same set", async () => {
    const held = unwrap(await service.create(projectId, inspector, createRequest(0, { caseKey: "page-holdout", visibility: "holdout" }), context));
    const controlPlane: VectorPage = unwrap(pageOf({ cursor: null, limit: null }));
    const systemView: VectorPage = unwrap(pageOf({ cursor: null, limit: null }, generator));
    expect(controlPlane.items.some((item) => item.id === held.vectorId)).toBe(true);
    expect(systemView.items.some((item) => item.id === held.vectorId)).toBe(false);
    expect(systemView.inventoryRevision).toBe(controlPlane.inventoryRevision);
    // And not merely shorter: the last row of the visible page is the last row of the set, so
    // a cursor taken from it cannot skip an invisible row on the next page.
    const lastVisible = systemView.items[systemView.items.length - 1] as { id: string };
    const next = writer.transact((tx) =>
      tx.listVectorsAfter(projectId, { targetId, afterId: lastVisible.id as Id, publicOnly: true, limit: 500 }),
    );
    if (!next.ok) throw new Error(JSON.stringify(next.error));
    expect(next.value).toEqual([]);
  });

  it("cuts the page on (project, target) together, so a foreign project sees nothing", () => {
    // The rows above belong to this project. Asking for the *same target id* under another
    // project must read as empty rather than as a borrow: the composite key is what §5 makes
    // the isolation boundary, and a query that dropped `project_id` would still be correct
    // looking while it leaked.
    const otherProject = newId();
    const seeded = writer.transact((tx) => {
      tx.insertProject({ id: otherProject, name: "other-vectors", createdAt: nowInstant(), graphRevision: 1, inventoryRevision: 1, schemaVersion: 1 });
      return true;
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const rows = writer.transact((tx) => tx.listVectorsAfter(otherProject, { targetId, afterId: null, publicOnly: false, limit: 500 }));
    if (!rows.ok) throw new Error(JSON.stringify(rows.error));
    expect(rows.value).toEqual([]);
    const mine = writer.transact((tx) => tx.listVectorsAfter(projectId, { targetId, afterId: null, publicOnly: false, limit: 500 }));
    if (!mine.ok) throw new Error(JSON.stringify(mine.error));
    expect(mine.value.length).toBeGreaterThan(0);
  });

  it("refuses the Builder, an over-large page and a cursor that was never ours", async () => {
    expect(reason(await service.page(projectId, builder, { targetId, cursor: null, limit: null }))).toBe(
      "builder-has-no-vector-permission",
    );
    const over = await service.page(projectId, inspector, { targetId, cursor: null, limit: VECTOR_PAGE_MAX_LIMIT + 1 });
    if (over.ok) throw new Error("expected a bound refusal");
    expect(over.error.reason).toBe("vector-limit");
    // A well-formed cursor with no round trip is a different cursor; the codec proves it, and
    // the shape check here proves it still names a revision and an id.
    const forged = Buffer.from(`0|not-a-uuid`, "utf8").toString("base64url");
    expect(reason(await service.page(projectId, inspector, { targetId, cursor: forged, limit: 2 }))).toBe("vector-cursor");
    expect(reason(await service.page(projectId, inspector, { targetId, cursor: "%%%%", limit: 2 }))).toBe("vector-cursor");
  });
});

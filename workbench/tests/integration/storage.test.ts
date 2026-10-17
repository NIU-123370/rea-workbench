import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acquireWorkerLock,
  applyMigrations,
  consistentBackup,
  currentSchemaVersion,
  openWriteConnection,
  planMigrations,
} from "../../packages/adapters/storage/database.ts";
import { MIGRATIONS } from "../../packages/adapters/storage/migrations.ts";
import { ArtifactStore, NODE_ARTIFACT_DURABILITY, OWNERSHIP_MARKER } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import type { ArtifactRow, EventDraft, EvidenceRow, JobRow, TargetRow } from "../../packages/application/ports.ts";

// Integration gates for DESIGN §5, §6 (D06) and §13. This file exists to prove
// the five defects recorded on issue #6 and #7 are actually closed, and to keep
// the single-writer, outbox and provenance rules checked against a real SQLite
// file rather than only against mocks.

const HEX_A = ("a" as const).repeat(64) as Digest;
const EV_A = `ev_${HEX_A}`;

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let store: ArtifactStore;
const heldLocks: { release: () => Promise<void> }[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-it-"));
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
  expect(applied.value).toEqual(MIGRATIONS.map((migration) => migration.id));
});

afterAll(async () => {
  db.close();
  for (const lock of heldLocks) await lock.release();
  await rm(root, { recursive: true, force: true });
});

function project(): Id {
  const id = newId();
  const created = nowInstant();
  const result = writer.transact((tx) =>
    tx.insertProject({
      id,
      name: "cart",
      createdAt: created,
      graphRevision: 0,
      inventoryRevision: 0,
      schemaVersion: 1,
    }),
  );
  expect(result.ok).toBe(true);
  return id;
}

function jobRow(projectId: Id, targetId: Id | null, key: string, digest: Digest = HEX_A): JobRow {
  const at = nowInstant();
  return {
    id: newId(),
    projectId,
    targetId,
    kind: "inspect",
    state: "queued",
    cleanupState: "pending",
    inputJson: { capture_path: "/operator/session.har", format: "har" },
    resultRef: null,
    errorJson: null,
    idempotencyKey: key,
    requestDigest: digest,
    deadlineAt: null,
    retryAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

describe("migrations (DESIGN §5, §13)", () => {
  it("is reentrant and reports nothing pending on a second pass", () => {
    const plan = planMigrations(db);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.pending).toEqual([]);
    expect([...plan.value.applied].sort()).toEqual(MIGRATIONS.map((m) => m.id).sort());
    expect(applyMigrations(db, plan.value).ok).toBe(true);
    expect(currentSchemaVersion(db)).toBe(1);
  });

  it("refuses an edited historical migration", () => {
    const other = path.join(root, "tampered.db");
    const db2 = new DatabaseSync(other);
    db2.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS) {
      db2.exec("BEGIN");
      db2.exec(migration.sql);
      db2
        .prepare("INSERT INTO schema_migrations (id, sql_sha256, applied_at) VALUES (?, ?, ?)")
        .run(migration.id, "0".repeat(64), nowInstant());
      db2.exec("COMMIT");
    }
    const plan = planMigrations(db2);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("MIGRATION_CHECKSUM_CONFLICT");
    db2.close();
  });

  it("refuses a database carrying migrations this build does not know (issue #6)", () => {
    const other = path.join(root, "future.db");
    const db2 = new DatabaseSync(other);
    db2.exec("PRAGMA foreign_keys = ON");
    const plan = planMigrations(db2);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    applyMigrations(db2, plan.value);
    db2
      .prepare("INSERT INTO schema_migrations (id, sql_sha256, applied_at) VALUES (?, ?, ?)")
      .run("9999-future-step", "1".repeat(64), nowInstant());
    const replanned = planMigrations(db2);
    expect(replanned.ok).toBe(false);
    if (replanned.ok) return;
    expect(replanned.error.code).toBe("MIGRATION_UNKNOWN");
    expect(currentSchemaVersion(db2)).toBe(0);
    db2.close();
  });
});

describe("foreign keys and CHECKs (DESIGN §5, issue #6)", () => {
  it("passes foreign_key_check after a real commit", () => {
    const projectId = project();
    const targetId = newId();
    const job = jobRow(projectId, targetId, "idem-fk");
    const artifact: ArtifactRow = {
      id: newId(),
      projectId,
      jobId: job.id,
      class: "inspector",
      sha256: HEX_A,
      digestReason: null,
      byteLength: 12,
      storageKey: `projects/${projectId}/artifacts/inspector/${HEX_A}.bin`,
      mediaType: "application/json",
      createdAt: nowInstant(),
    };
    const evidence: EvidenceRow = {
      projectId,
      id: EV_A,
      targetId,
      jobId: job.id,
      artifactId: artifact.id,
      providerJson: { id: "har-schema/lossless-json", name: "REA HAR capture adapter", version: null },
      operation: "inspect_web_network_capture",
      confidence: "observed",
      authority: "historical-reference",
      createdAt: nowInstant(),
    };
    const committed = writer.transact((tx) => {
      tx.insertTarget({
        id: targetId,
        projectId,
        kind: "har",
        originalLocator: null,
        sourceSha256: HEX_A,
        sourceArtifactId: null,
        snapshotDigest: HEX_A,
        identityReason: null,
        createdAt: nowInstant(),
      } satisfies TargetRow);
      expect(tx.insertJob(job).outcome).toBe("inserted");
      tx.insertArtifact(artifact);
      tx.insertEvidence(evidence);
      tx.appendEvent({
        projectId,
        type: "evidence.committed",
        aggregateId: EV_A,
        payloadJson: { resourceIds: [EV_A] },
        createdAt: nowInstant(),
      } satisfies EventDraft);
      return tx.latestSeq(projectId);
    });
    expect(committed.ok).toBe(true);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("refuses a target from another project (issue #6)", () => {
    const mine = project();
    const other = project();
    const foreignTarget = newId();
    writer.transact((tx) =>
      tx.insertTarget({
        id: foreignTarget,
        projectId: other,
        kind: "url",
        originalLocator: "https://example.test",
        sourceSha256: null,
        sourceArtifactId: null,
        snapshotDigest: null,
        identityReason: "not-captured",
        createdAt: nowInstant(),
      }),
    );
    const result = writer.transact((tx) => tx.insertJob(jobRow(mine, foreignTarget, "idem-cross")));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FK_VIOLATION");
  });

  it("rejects a non-hex digest that SQLite GLOB alone would accept (issue #6)", () => {
    const projectId = project();
    const malformed = `a${"Z".repeat(63)}` as Digest;
    const result = writer.transact((tx) => tx.insertJob(jobRow(projectId, null, "idem-digest", malformed)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("CHECK constraint failed");
  });
});

describe("single writer and idempotency (DESIGN §2, §8)", () => {
  it("refuses a second worker over the same directory (D06)", async () => {
    const second = await acquireWorkerLock(root);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("DATA_DIR_LOCKED");
  });

  it("refuses a data directory that does not exist", async () => {
    const missing = await acquireWorkerLock(path.join(root, "not-chosen"));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("DATA_DIR_MISSING");
  });

  it("returns the stored job for a retry and conflicts on a divergent payload", () => {
    const projectId = project();
    const first = jobRow(projectId, null, "idem-twice");
    const inserted = writer.transact((tx) => tx.insertJob(first));
    expect(inserted.ok && inserted.value.outcome).toBe("inserted");
    const again = writer.transact((tx) => tx.insertJob({ ...first, id: newId() }));
    expect(again.ok && again.value.outcome).toBe("existing");
    const divergent = writer.transact((tx) =>
      tx.insertJob({ ...first, id: newId(), requestDigest: ("b" as const).repeat(64) as Digest }),
    );
    expect(divergent.ok && divergent.value.outcome).toBe("divergent");
  });

  it("rolls the business row and its outbox event back together (DESIGN §12.2)", () => {
    const projectId = project();
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?")
      .get(projectId) as { n: number };
    const failed = writer.transact((tx) => {
      tx.appendEvent({
        projectId,
        type: "job.updated",
        aggregateId: newId(),
        payloadJson: { state: "running" },
        createdAt: nowInstant(),
      });
      throw new Error("audit write rejected");
    });
    expect(failed.ok).toBe(false);
    const after = db.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?").get(projectId) as {
      n: number;
    };
    expect(after.n).toBe(before.n);
  });

  it("reads committed events from a cursor without losing order", () => {
    const projectId = newId();
    writer.transact((tx) =>
      tx.insertProject({
        id: projectId,
        name: "cursor",
        createdAt: nowInstant(),
        graphRevision: 0,
        inventoryRevision: 0,
        schemaVersion: 1,
      }),
    );
    const seqs = writer.transact((tx) =>
      [0, 1, 2].map((index) =>
        tx.appendEvent({
          projectId,
          type: "graph.updated",
          aggregateId: newId(),
          payloadJson: { graphRevision: index + 1 },
          createdAt: nowInstant(),
        }),
      ),
    );
    expect(seqs.ok).toBe(true);
    if (!seqs.ok) return;
    const resumed = writer.transact((tx) => tx.eventsAfter(projectId, seqs.value[0] as number, 10));
    expect(resumed.ok && resumed.value.length).toBe(2);
    const again = writer.transact((tx) => tx.eventsAfter(projectId, seqs.value[0] as number, 10));
    expect(again.ok && again.value.map((event) => event.seq)).toEqual([
      seqs.value[1],
      seqs.value[2],
    ]);
  });
});

describe("artifact store (DESIGN §5 line 126, §12)", () => {
  const bytes = new TextEncoder().encode('{"records":[]}');

  it("publishes content-addressed and dedupes only within the project and class", async () => {
    const projectId = newId();
    const first = await store.publish(projectId, "inspector", bytes);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await store.publish(projectId, "inspector", bytes);
    expect(second.ok && second.value.storageKey).toBe(first.value.storageKey);
    const otherClass = await store.publish(projectId, "report", bytes);
    expect(otherClass.ok && otherClass.value.storageKey).not.toBe(first.value.storageKey);
    expect(first.value.storageKey.startsWith(`projects/${projectId}/`)).toBe(true);
  });

  it("refuses a declared digest that does not match the bytes", async () => {
    const result = await store.publish(newId(), "candidate", bytes, HEX_A);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ARTIFACT_MISMATCH");
  });

  it("never reads a storage key belonging to another project", async () => {
    const owner = newId();
    const stranger = newId();
    const published = await store.publish(owner, "inspector", bytes);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const read = await store.read(stranger, published.value.storageKey);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe("ARTIFACT_MISMATCH");
  });

  it("resolves an absolute path that points at the bytes read returns", async () => {
    // The store's own key is the only thing a caller may hand to a producer process. A
    // slice that is off by one character resolves `artifacts/...` as `rtifacts/...`, so the
    // path it returns names a file that does not exist while `read` still works — the two
    // views have to agree on the same bytes.
    const projectId = newId();
    const published = await store.publish(projectId, "export", bytes);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const target = store.absolutePathFor(projectId, published.value.storageKey);
    expect(target).not.toBeNull();
    expect(target).toContain("/artifacts/export/");
    expect(readFileSync(target as string)).toEqual(Buffer.from(bytes));
    const read = await store.read(projectId, published.value.storageKey);
    expect(read.ok && Buffer.from(read.value).equals(readFileSync(target as string))).toBe(true);
    expect(store.absolutePathFor(newId(), published.value.storageKey)).toBeNull();
  });

  it("rejects a traversal id instead of touching the host filesystem", async () => {
    const projectId = newId();
    const result = await store.writeStaging(projectId, "../escape", bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("STAGING_UNVERIFIED");
  });

  it("cleans up only its own unreferenced staging and never by name or pid", async () => {
    const projectId = newId();
    const kept = await store.writeStaging(projectId, "11111111-1111-4111-8111-111111111111", bytes);
    const dropped = await store.writeStaging(projectId, "22222222-2222-4222-8222-222222222222", bytes);
    expect(kept.ok && dropped.ok).toBe(true);
    if (!kept.ok || !dropped.ok) return;
    const removed = await store.collectUnreferencedStaging(projectId, [kept.value.stagingId]);
    expect(removed.ok && removed.value).toEqual([dropped.value.stagingId]);
    // The marker is what makes this directory ours to clean at all.
    await expect(stat(path.join(store.stagingDir(projectId), OWNERSHIP_MARKER))).resolves.toBeTruthy();
    await expect(stat(path.join(store.stagingDir(projectId), kept.value.stagingId))).resolves.toBeTruthy();
    await expect(stat(path.join(store.stagingDir(projectId), dropped.value.stagingId))).rejects.toThrow();
  });

  it("does not delete files in a directory that carries no ownership marker", async () => {
    const projectId = newId();
    const dir = store.stagingDir(projectId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, "operator-upload.har"), "keep me");
    const result = await store.collectUnreferencedStaging(projectId, []);
    expect(result.ok && result.value).toEqual([]);
    await expect(stat(path.join(dir, "operator-upload.har"))).resolves.toBeTruthy();
  });
});

describe("backup (DESIGN §13, D23, issue #7)", () => {
  it("keeps earlier recovery points when a later attempt fails", async () => {
    const first = await consistentBackup(db, root);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await consistentBackup(db, root);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.file).not.toBe(first.value.file);

    const closed = new DatabaseSync(path.join(root, "closed.db"));
    closed.exec("CREATE TABLE t(x)");
    closed.close();
    const failing = await consistentBackup(
      {
        exec: () => {
          throw new Error("SQLITE_BUSY: database is locked");
        },
      } as unknown as DatabaseSync,
      root,
    );
    expect(failing.ok).toBe(false);
    if (failing.ok) return;
    expect(failing.error.code).toBe("BACKUP_FAILED");

    const files = await readdir(path.join(root, "backups"));
    expect(files.filter((name) => name.endsWith(".db"))).toHaveLength(2);
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
    await expect(stat(first.value.file)).resolves.toBeTruthy();
    await expect(stat(second.value.file)).resolves.toBeTruthy();
  });

  it("produces a snapshot that opens and answers the schema query", async () => {
    const backup = await consistentBackup(db, root);
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    const copy = new DatabaseSync(backup.value.file);
    const names = copy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    expect(names.map((row) => row.name)).toContain("evidence_records");
    copy.close();
  });
});

describe("the flush order §5 promises before a name exists", () => {
  // `rename` is atomic only once the bytes are on the device. These cases pin the two flushes
  // the store used to claim in a comment without making: content before the rename, the
  // directory entry after it - and that a failing flush is a refusal that leaves no half-written
  // artifact and no orphan temp behind (T13's 不发布半写 artifact, T16's power-loss recovery).
  let durRoot: string;

  function recorder(failAt: "file" | "dir" | null) {
    const ops: string[] = [];
    return {
      ops,
      durability: {
        async writeAndSync(file: string, bytes: Uint8Array) {
          await NODE_ARTIFACT_DURABILITY.writeAndSync(file, bytes);
          ops.push(`sync-file:${path.basename(file)}`);
          if (failAt === "file") throw new Error("ENOSPC: no space left on device");
        },
        async syncDirectory(dir: string) {
          await NODE_ARTIFACT_DURABILITY.syncDirectory(dir);
          ops.push(`sync-dir:${path.basename(dir)}`);
          if (failAt === "dir") throw new Error("EROFS: read-only file system, fsync");
        },
      },
    };
  }

  beforeAll(async () => {
    durRoot = await mkdtemp(path.join(tmpdir(), "rea-wb-dur-"));
  });
  afterAll(async () => {
    await rm(durRoot, { recursive: true, force: true });
  });

  it("flushes the bytes while the final name does not exist, and the directory after it does", async () => {
    // The rename itself is not observable from the port, so the order is proven by what is on
    // the file system at each flush: no `.bin` yet when the content is flushed, the `.bin`
    // present (and the temp gone) when the directory is flushed.
    const seen: { op: string; binPresent: boolean; tempPresent: boolean }[] = [];
    const projectId = newId();
    const probe = {
      async writeAndSync(file: string, bytes: Uint8Array) {
        await NODE_ARTIFACT_DURABILITY.writeAndSync(file, bytes);
        const entries = await readdir(path.dirname(file)).catch(() => []);
        seen.push({ op: "sync-file", binPresent: entries.some((n) => n.endsWith(".bin")), tempPresent: entries.some((n) => n.endsWith(".tmp")) });
      },
      async syncDirectory(dir: string) {
        await NODE_ARTIFACT_DURABILITY.syncDirectory(dir);
        const entries = await readdir(dir).catch(() => []);
        seen.push({ op: "sync-dir", binPresent: entries.some((n) => n.endsWith(".bin")), tempPresent: entries.some((n) => n.endsWith(".tmp")) });
      },
    };
    const store = new ArtifactStore(durRoot, { durability: probe });
    const published = await store.publish(projectId, "inspector", new Uint8Array([1, 2, 3, 4]));
    if (!published.ok) throw new Error(JSON.stringify(published.error));
    expect(seen).toEqual([
      { op: "sync-file", binPresent: false, tempPresent: true },
      { op: "sync-dir", binPresent: true, tempPresent: false },
    ]);
  });

  it("flushes a staging payload before its final name exists", async () => {
    // Different code path, same claim: the upload bytes are durable under the opaque id the
    // import command later cites. Dropping the staging flush alone would otherwise pass.
    const seen: { op: string; finalPresent: boolean; tempPresent: boolean }[] = [];
    const projectId = newId();
    const stagingId = "0f0f0f0f-0000";
    const probe = {
      async writeAndSync(file: string, bytes: Uint8Array) {
        await NODE_ARTIFACT_DURABILITY.writeAndSync(file, bytes);
        const entries = await readdir(path.dirname(file)).catch((): string[] => []);
        seen.push({ op: "sync-file", finalPresent: entries.includes(stagingId), tempPresent: entries.some((n) => n.endsWith(".tmp")) });
      },
      async syncDirectory(dir: string) {
        await NODE_ARTIFACT_DURABILITY.syncDirectory(dir);
        const entries = await readdir(dir).catch((): string[] => []);
        seen.push({ op: "sync-dir", finalPresent: entries.includes(stagingId), tempPresent: entries.some((n) => n.endsWith(".tmp")) });
      },
    };
    const store = new ArtifactStore(durRoot, { durability: probe });
    const staged = await store.writeStaging(projectId, stagingId, new TextEncoder().encode("har-bytes"));
    if (!staged.ok) throw new Error(JSON.stringify(staged.error));
    // Two content flushes land first: the ownership marker (no temp yet) and then the payload
    // (temp present, final name not). The directory is flushed last, after the rename.
    expect(seen).toEqual([
      { op: "sync-file", finalPresent: false, tempPresent: false },
      { op: "sync-file", finalPresent: false, tempPresent: true },
      { op: "sync-dir", finalPresent: true, tempPresent: false },
    ]);
  });

  it("the default durability really flushes - the promise was in a comment before it was in code", () => {
    // Whether a device actually got fsynced is not observable from user space, so this guard is
    // source-shaped on purpose: the ordering tests above prove the store *asks* for the flush,
    // and this proves the shipped implementation performs one instead of a plain write.
    const write = NODE_ARTIFACT_DURABILITY.writeAndSync.toString();
    const dir = NODE_ARTIFACT_DURABILITY.syncDirectory.toString();
    expect(write).toContain(".sync()");
    expect(write).toContain(".close()");
    expect(dir).toContain(".sync()");
    expect(dir).toContain(".close()");
  });

  it("refuses a failed content flush without publishing or leaving a temp behind", async () => {
    const spy = recorder("file");
    const store = new ArtifactStore(durRoot, { durability: spy.durability });
    const projectId = newId();
    const refused = await store.publish(projectId, "blueprint", new TextEncoder().encode("half-written"));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("ARTIFACT_WRITE_FAILED");
    const partition = path.join(durRoot, "projects", projectId, "artifacts", "blueprint");
    expect(await readdir(partition).catch(() => [])).toEqual([]);
  });

  it("refuses a failed directory flush even though the bytes landed", async () => {
    const spy = recorder("dir");
    const store = new ArtifactStore(durRoot, { durability: spy.durability });
    const projectId = newId();
    const bytes = new TextEncoder().encode("renamed-but-not-persisted");
    const refused = await store.publish(projectId, "report", bytes);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("ARTIFACT_WRITE_FAILED");
    // The name is on the file system, and the caller is told it did not land: reporting success
    // here would be the half-published artifact T13 forbids, while deleting it would destroy
    // bytes a retry wants. A retry of the same bytes then takes the `existing` path and succeeds.
    const again = new ArtifactStore(durRoot);
    const retried = await again.publish(projectId, "report", bytes);
    expect(retried.ok).toBe(true);
  });
});

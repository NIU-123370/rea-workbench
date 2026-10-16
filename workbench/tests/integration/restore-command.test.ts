import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runRestore, MANIFEST_SUFFIX } from "../../apps/worker/restore.ts";
import { runBackup, runVerify } from "../../apps/worker/backup.ts";
import {
  acquireWorkerLock,
  applyMigrations,
  openWriteConnection,
  planMigrations,
} from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { MIGRATIONS } from "../../packages/adapters/storage/migrations.ts";
import { MIGRATION_TABLE } from "../../packages/adapters/storage/database.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";

// The operator's restore command (DESIGN §13 line 453, D23 / PRD A16, issue #23).
//
// `backup-restore.test.ts` covers the library pieces. What this file pins is the *order* the
// command is supposed to enforce: it cannot run beside a live worker, it refuses before it
// writes anything, it leaves the data directory exactly as it found it on every refusal, and
// a successful run ends with a database that needs no further migration.

const bytes = new TextEncoder().encode('{"records":[]}');
let root: string;
let store: ArtifactStore;
let writer: SqliteStorageWriter;
let db: DatabaseSync;
let projectId: Id;
let storageKey = "";
let snapshotFile = "";
let manifestFile = "";

function freshWriter(): SqliteStorageWriter {
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(opened.error.message);
  return new SqliteStorageWriter(opened.value.db);
}

function countProjects(): number {
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const row = opened.value.db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
    return Number(row.n);
  } finally {
    opened.value.db.close();
  }
}

function projectNames(): string[] {
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    return (opened.value.db.prepare("SELECT name FROM projects ORDER BY name").all() as { name: string }[]).map((row) => row.name);
  } finally {
    opened.value.db.close();
  }
}

async function addProject(name: string): Promise<Id> {
  const id = newId();
  const created = nowInstant();
  // A fresh connection every time: the restore replaces the file under any handle that was
  // opened before it, so a long-lived writer would be writing into a retired database.
  const outcome = freshWriter().transact((tx) => {
    tx.insertProject({ id, name, createdAt: created, graphRevision: 1, inventoryRevision: 1, schemaVersion: 1 });
    return true;
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return id;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-restore-"));
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  store = new ArtifactStore(root);
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  db = opened.value.db;
  const plan = planMigrations(db);
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  const applied = applyMigrations(db, plan.value);
  if (!applied.ok) throw new Error(JSON.stringify(applied.error));
  writer = new SqliteStorageWriter(db);

  projectId = await addProject("before-restore");
  const published = await store.publish(projectId, "inspector", bytes);
  if (!published.ok) throw new Error(JSON.stringify(published.error));
  storageKey = published.value.storageKey;
  const created = nowInstant();
  const artifact = writer.transact((tx) => {
    tx.insertArtifact({
      id: newId(),
      projectId,
      jobId: null,
      class: "inspector",
      sha256: published.value.sha256,
      digestReason: null,
      byteLength: published.value.byteLength,
      storageKey: published.value.storageKey,
      mediaType: "application/json",
      createdAt: created,
    });
    return true;
  });
  if (!artifact.ok) throw new Error(JSON.stringify(artifact.error));

  // The bundle under test is produced by the operator's own command, not by a test helper:
  // a restore that only works against a fixture-built manifest is not a restore.
  const made = await runBackup(root);
  if (!made.ok) throw new Error(JSON.stringify(made.failure));
  expect(made.artifacts).toBe(1);
  expect(made.projects).toBe(1);
  snapshotFile = made.databaseFile;
  manifestFile = made.manifestFile;
  db.close();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the restore command (D23 / A16)", () => {
  it("verifies the bundle the backup command produced, with nothing to complain about", async () => {
    const verified = await runVerify(root, snapshotFile);
    if (!verified.ok) throw new Error(JSON.stringify(verified.failure));
    expect(verified.report.artifacts.verified).toBe(1);
    expect(verified.report.reasons).toEqual([]);
    const refused = await runVerify(root, path.join(root, "backups", "workbench-never-written.db"));
    expect(!refused.ok && refused.failure.reason).toBe("backup-pair-incomplete");
    const relative = await runVerify(root, "workbench-relative.db");
    expect(!relative.ok && relative.failure.reason).toBe("snapshot-path-must-be-absolute");
  });

  it("refuses to back up or verify while the worker still holds the directory", async () => {
    // The same lock the worker takes: a manifest written while another process is still
    // publishing files describes a moment that never existed, so neither command is allowed
    // to read the database in that state - not even read-only.
    const held = await acquireWorkerLock(root);
    if (!held.ok) throw new Error(JSON.stringify(held.error));
    try {
      const backup = await runBackup(root);
      expect(backup.ok).toBe(false);
      if (backup.ok) return;
      expect(backup.failure.reason).toBe("worker-still-running-close-it-first");
      const verify = await runVerify(root, snapshotFile);
      expect(verify.ok).toBe(false);
      if (verify.ok) return;
      expect(verify.failure.reason).toBe("worker-still-running-close-it-first");
    } finally {
      await held.value.release();
    }
  });

  it("reports a drifted file instead of passing the bundle", async () => {
    const file = store.absolutePathFor(projectId, storageKey);
    if (file === null) throw new Error("the store could not resolve its own key");
    const original = readFileSync(file);
    await writeFile(file, "drifted after the backup");
    try {
      const verified = await runVerify(root, snapshotFile);
      if (!verified.ok) throw new Error(JSON.stringify(verified.failure));
      expect(verified.report.artifacts.mismatched).toBe(1);
      expect(verified.report.artifacts.verified).toBe(0);
      expect(verified.report.reasons.join(" ")).toContain("artifact-file-digest-mismatch");
    } finally {
      await writeFile(file, original);
    }
    const again = await runVerify(root, snapshotFile);
    if (!again.ok) throw new Error(JSON.stringify(again.failure));
    expect(again.report.reasons).toEqual([]);
  });

  it("says what it could not read when the snapshot itself is unreadable", async () => {
    // A bundle can be present and still useless - truncated transfer, disk trouble. The
    // answer has to name the failure rather than be a bare "not verifiable", because this is
    // the message an operator reads at 2am while deciding whether to restore.
    const corrupt = path.join(root, "backups", "workbench-corrupt.db");
    await writeFile(corrupt, "this is not a sqlite database");
    await copyFile(manifestFile, `${corrupt}${MANIFEST_SUFFIX}`);
    const outcome = await runVerify(root, corrupt);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("BACKUP_UNVERIFIABLE");
    expect(outcome.failure.reason).toBe("backup-unverifiable");
    expect(outcome.failure.details.length).toBeGreaterThan(0);
    await rm(corrupt, { force: true });
    await rm(`${corrupt}${MANIFEST_SUFFIX}`, { force: true });
  });

  it("brings a database that is behind this build forward before backing it up", async () => {
    // The worker would apply these at startup anyway. Backing up a schema this build has not
    // finished with would produce a bundle that cannot be handed back to a worker.
    const opened = openWriteConnection(root);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    if (last === undefined) throw new Error("no migrations to drop");
    opened.value.db.prepare(`DELETE FROM ${MIGRATION_TABLE} WHERE id = ?`).run(last.id);
    opened.value.db.close();
    const outcome = await runBackup(root);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.failure));
    const check = openWriteConnection(root);
    if (!check.ok) throw new Error(JSON.stringify(check.error));
    try {
      const plan = planMigrations(check.value.db);
      expect(plan.ok && plan.value.pending.length).toBe(0);
    } finally {
      check.value.db.close();
    }
  });

  it("refuses while the worker still holds the data directory", async () => {
    const held = await acquireWorkerLock(root);
    if (!held.ok) throw new Error(JSON.stringify(held.error));
    try {
      const refused = await runRestore({ dataDir: root, snapshotFile });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe("DATA_DIR_LOCKED");
      expect(refused.reason).toBe("worker-still-running-close-it-first");
      // The refusal is not allowed to have touched anything.
      expect(existsSync(path.join(root, "workbench.db"))).toBe(true);
    } finally {
      await held.value.release();
    }
  });

  it("refuses an incomplete pair rather than guessing a manifest", async () => {
    const missing = path.join(root, "backups", "workbench-no-manifest.db");
    await mkdir(path.dirname(missing), { recursive: true, mode: 0o700 });
    await writeFile(missing, "not really a database");
    const refused = await runRestore({ dataDir: root, snapshotFile: missing });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe("backup-pair-incomplete");
    expect(refused.details).toEqual(["database-snapshot-present", "manifest-missing"]);
    await rm(missing, { force: true });
  });

  it("refuses a snapshot whose schema this build cannot read, and leaves the live database alone", async () => {
    const before = countProjects();
    const forged = JSON.parse(readFileSync(manifestFile, "utf8")) as { migrations: string[] };
    const hostile = `${snapshotFile}.hostile.db`;
    const hostileManifest = `${hostile}${MANIFEST_SUFFIX}`;
    await writeFile(hostile, readFileSync(snapshotFile));
    await writeFile(hostileManifest, JSON.stringify({ ...forged, migrations: [...forged.migrations, "9999-future-migration"] }));
    const refused = await runRestore({ dataDir: root, snapshotFile: hostile });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("RESTORE_SCHEMA_INCOMPATIBLE");
    expect(refused.reason).toBe("snapshot-schema-newer-than-build");
    expect(refused.details.join(" ")).toContain("9999-future-migration");
    expect(countProjects()).toBe(before);
    await rm(hostile, { force: true });
    await rm(hostileManifest, { force: true });
  });

  it("refuses when the manifest's files no longer match, before replacing the database", async () => {
    // Drift the file the manifest promises, behind the index's back.
    const file = store.absolutePathFor(projectId, storageKey);
    if (file === null) throw new Error("the store could not resolve its own key");
    await writeFile(file, "changed after the snapshot");
    const before = countProjects();
    const refused = await runRestore({ dataDir: root, snapshotFile });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("BACKUP_INCOMPLETE");
    expect(refused.reason).toBe("artifact-files-do-not-match-the-manifest");
    expect(refused.details.join(" ")).toContain("artifact-file-digest-mismatch");
    // Half-restored is the state §13 forbids, so the row count must be untouched.
    expect(countProjects()).toBe(before);
    // Put the bytes back so the later cases run against a store that matches its index.
    // Re-publishing is not an option: the key is content-addressed and the row already
    // exists, so the drifted file is rewritten in place with what the manifest promises.
    await writeFile(file, bytes);
  });

  it("restores the pair, keeps a safety snapshot, and ends with nothing pending", async () => {
    // Change the live state after the snapshot, then restore and watch it come back.
    const extra = await addProject("added-after-backup");
    expect(countProjects()).toBe(2);
    const outcome = await runRestore({ dataDir: root, snapshotFile: snapshotFile });
    if (!outcome.ok) throw new Error(`${outcome.code}:${outcome.reason}:${outcome.details.join(" ")}`);
    expect(outcome.report.artifacts.verified).toBe(1);
    expect(outcome.report.artifacts.missing).toBe(0);
    expect(outcome.report.projects).toBe(1);
    expect(countProjects()).toBe(1);
    // The project that only existed after the backup is gone from the restored index.
    expect(projectNames()).toEqual(["before-restore"]);
    expect(projectNames()).not.toContain("added-after-backup");
    void extra;
    // A restore that cannot be rolled back is not one: what was there before is kept.
    expect(outcome.safetySnapshot).not.toBeNull();
    if (outcome.safetySnapshot === null) return;
    expect(await stat(outcome.safetySnapshot).then((info) => info.size > 0)).toBe(true);
    // D23's other half: an older snapshot may be behind this build, and the command brings it
    // up so the next worker start has nothing to write.
    expect(outcome.migrationsApplied).toBeGreaterThanOrEqual(0);
    const opened = openWriteConnection(root);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    try {
      const plan = planMigrations(opened.value.db);
      expect(plan.ok && plan.value.pending.length).toBe(0);
    } finally {
      opened.value.db.close();
    }
    // The stale side files went with the database they belonged to.
    expect(existsSync(`${path.join(root, "workbench.db")}-wal`)).toBe(false);
    // The bundle survives its own restore: an operator has to be able to re-verify what
    // was applied, and a move would leave only the manifest behind.
    expect(existsSync(snapshotFile)).toBe(true);
    expect(existsSync(manifestFile)).toBe(true);
  });

  it("brings a snapshot that is behind this build up to date", async () => {
    // D23's real case: the backup was taken by an older build, so the restored database is
    // missing migrations this one knows. The command has to apply them with the same
    // additive, reentrant migrator the worker uses, or it hands the operator a database the
    // next worker start has to write during boot.
    const behind = `${snapshotFile}.behind.db`;
    await copyFile(snapshotFile, behind);
    const snapshot = new DatabaseSync(behind);
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    if (last === undefined) throw new Error("no migrations to drop");
    snapshot.prepare(`DELETE FROM ${MIGRATION_TABLE} WHERE id = ?`).run(last.id);
    expect((snapshot.prepare(`SELECT COUNT(*) AS n FROM ${MIGRATION_TABLE} WHERE id = ?`).get() as { n: number }).n).toBe(0);
    snapshot.close();
    await copyFile(manifestFile, `${behind}${MANIFEST_SUFFIX}`);

    const outcome = await runRestore({ dataDir: root, snapshotFile: behind });
    if (!outcome.ok) throw new Error(`${outcome.code}:${outcome.reason}:${outcome.details.join(" ")}`);
    expect(outcome.migrationsApplied).toBeGreaterThanOrEqual(1);
    const opened = openWriteConnection(root);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    try {
      const plan = planMigrations(opened.value.db);
      expect(plan.ok && plan.value.pending.length).toBe(0);
      // Re-entrant: the table the dropped migration creates already has its rows, so the
      // rebuild must not have eaten data.
      expect(projectNames()).toEqual(["before-restore"]);
    } finally {
      opened.value.db.close();
    }
    await rm(behind, { force: true });
    await rm(`${behind}${MANIFEST_SUFFIX}`, { force: true });
  });

  it("refuses a snapshot database carrying a migration this build has never seen", async () => {
    // The manifest list is not the only way a snapshot can be too new: the database itself
    // can hold an id this build does not know. D23 says confirm before rolling back, so the
    // command must stop and name the id instead of leaving an unreadable schema in place.
    const unknown = `${snapshotFile}.unknown.db`;
    await copyFile(snapshotFile, unknown);
    const snapshot = new DatabaseSync(unknown);
    snapshot
      .prepare(`INSERT INTO ${MIGRATION_TABLE} (id, sql_sha256, applied_at) VALUES (?, ?, ?)`)
      .run("9999-from-a-future-build", "0".repeat(64), nowInstant());
    snapshot.close();
    await copyFile(manifestFile, `${unknown}${MANIFEST_SUFFIX}`);
    const refused = await runRestore({ dataDir: root, snapshotFile: unknown });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe("restored-schema-unplannable");
    expect(refused.details.join(" ")).toContain("9999-from-a-future-build");
    await rm(unknown, { force: true });
    await rm(`${unknown}${MANIFEST_SUFFIX}`, { force: true });
  });

  it("refuses a manifest that parses to nothing checkable", async () => {
    const empty = `${snapshotFile}.empty.db`;
    await writeFile(empty, readFileSync(snapshotFile));
    await writeFile(`${empty}${MANIFEST_SUFFIX}`, JSON.stringify({ schemaVersion: 1 }));
    const refused = await runRestore({ dataDir: root, snapshotFile: empty });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe("backup-manifest-shape");
    await rm(empty, { force: true });
    await rm(`${empty}${MANIFEST_SUFFIX}`, { force: true });
  });
});

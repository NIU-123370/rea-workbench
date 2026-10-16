import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import { asId, newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import {
  applyMigrations,
  currentSchemaVersion,
  openWriteConnection,
  planMigrations,
} from "../../packages/adapters/storage/database.ts";
import {
  buildManifest,
  createReleaseBackup,
  planRestore,
  verifyReleaseBackup,
} from "../../packages/adapters/storage/backup-manifest.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../../packages/adapters/storage/migrations.ts";
import type { ManifestEntry } from "../../packages/adapters/storage/backup-manifest.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import type { ArtifactRow, ProjectRow } from "../../packages/application/ports.ts";
import { hex } from "../support/blueprint-seed.ts";

// Backup, restore and upgrade recovery against real SQLite and a real filesystem
// (DESIGN §13 lines 453-455, PRD A12 / TESTPLAN T16, issue #23).
//
// The rule this suite exists for is that a backup is two halves: a consistent database
// snapshot *and* the artifact files the snapshot claims. Verifying only the database would
// let a restore report a project whose evidence, blueprint or report bytes are gone.

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let projectId: Id;
const opened: DatabaseSync[] = [];

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.message}`);
  return result.value;
}

async function migrate(handle: DatabaseSync): Promise<readonly string[]> {
  const planned = planMigrations(handle);
  if (!planned.ok) throw new Error(planned.error.message);
  const applied = applyMigrations(handle, planned.value);
  if (!applied.ok) throw new Error(`${applied.error.code}:${applied.error.message}`);
  return applied.value;
}

function seedProject(target: SqliteStorageWriter, id: Id, name: string): void {
  const created = nowInstant();
  const row: ProjectRow = { id, name, createdAt: created, graphRevision: 1, inventoryRevision: 1, schemaVersion: 1 };
  const outcome = target.transact((tx) => tx.insertProject(row));
  if (!outcome.ok) throw new Error(outcome.error.message);
}

// One artifact of every class the store knows — including the delivery partition — plus a
// verification whose report bytes are in the store and a lease that never finished
// cleaning, so the manifest has something to say about each of T16's facts.
async function seedStore(handle: DatabaseSync, local: ArtifactStore, project: Id) {
  const target = new SqliteStorageWriter(handle);
  const created = nowInstant();
  const entries: { artifact: ArtifactRow; bytes: Uint8Array }[] = [];
  for (const class_ of ["inspector", "blueprint", "candidate", "report", "export"] as const) {
    const bytes = new TextEncoder().encode(`${class_}-${project}-payload`);
    const published = await local.publish(project, class_, bytes);
    if (!published.ok) throw new Error(published.error.message);
    entries.push({
      bytes,
      artifact: {
        id: newId(),
        projectId: project,
        jobId: null,
        class: class_,
        sha256: published.value.sha256,
        digestReason: null,
        byteLength: published.value.byteLength,
        storageKey: published.value.storageKey,
        mediaType: "application/octet-stream",
        createdAt: created,
      },
    });
  }
  // A digest withheld with a stated reason (§4): the manifest carries it as a fact, not as
  // a mismatch and not as a gap.
  const withheldBytes = new TextEncoder().encode("withheld-payload");
  const withheld = await local.publish(project, "inspector", withheldBytes);
  if (!withheld.ok) throw new Error(withheld.error.message);
  entries.push({
    bytes: withheldBytes,
    artifact: {
      id: newId(),
      projectId: project,
      jobId: null,
      class: "inspector",
      sha256: null,
      digestReason: "provider-declined-digest",
      byteLength: withheld.value.byteLength,
      storageKey: withheld.value.storageKey,
      mediaType: "application/octet-stream",
      createdAt: created,
    },
  });

  const targetId = newId();
  const jobId = newId();
  const planId = newId();
  const blueprintId = newId();
  const candidateId = newId();
  const verificationId = newId();
  const snapshotDigest = asDigest(hex(`backup-snapshot-${project}`));
  const inserted = target.transact((tx) => {
    tx.insertProject({ id: project, name: `backup-${project.slice(0, 8)}`, createdAt: created, graphRevision: 1, inventoryRevision: 1, schemaVersion: 1 });
    tx.insertTarget({
      id: targetId,
      projectId: project,
      kind: "har",
      originalLocator: null,
      sourceSha256: null,
      sourceArtifactId: null,
      snapshotDigest,
      identityReason: null,
      createdAt: created,
    });
    for (const entry of entries) tx.insertArtifact(entry.artifact);
    tx.insertJob({
      id: jobId,
      projectId: project,
      targetId,
      kind: "verify",
      state: "succeeded",
      cleanupState: "pending",
      inputJson: {},
      resultRef: null,
      errorJson: null,
      idempotencyKey: `verify-${jobId}`,
      requestDigest: asDigest(hex(`backup-request-${jobId}`)),
      deadlineAt: null,
      retryAt: null,
      createdAt: created,
      updatedAt: created,
    });
    tx.insertPlan({
      id: planId,
      projectId: project,
      targetId,
      snapshotDigest,
      graphRevision: 1,
      inventoryRevision: 1,
      inventoryDigest: asDigest(hex(`backup-inventory-${project}`)),
      payloadJson: {},
      digest: asDigest(hex(`backup-plan-${project}`)),
      reviewStatus: "approved",
      reviewRecordJson: null,
      createdAt: created,
    });
    tx.insertBlueprint({
      id: blueprintId,
      projectId: project,
      targetId,
      graphRevision: 1,
      snapshotDigest,
      verificationPlanId: planId,
      artifactId: entries[1]!.artifact.id,
      digest: asDigest(hex(`backup-blueprint-${project}`)),
      sourceManifestArtifactId: entries[0]!.artifact.id,
      createdAt: created,
    });
    tx.insertCandidate({
      id: candidateId,
      projectId: project,
      blueprintId,
      jobId,
      artifactId: entries[2]!.artifact.id,
      digest: asDigest(hex(`backup-candidate-${project}`)),
      generatorJson: {},
      dependencyManifestJson: {},
    });
    tx.insertVerification({
      id: verificationId,
      projectId: project,
      candidateId,
      jobId,
      planId,
      planDigest: asDigest(hex(`backup-plan-${project}`)),
      inventoryDigest: asDigest(hex(`backup-inventory-${project}`)),
      blueprintDigest: asDigest(hex(`backup-blueprint-${project}`)),
      vectorSetDigest: asDigest(hex("backup-vector-set")),
      comparatorDigest: asDigest(hex("backup-comparator")),
      runnerImageDigest: asDigest(hex("backup-runner")),
      result: "PASS",
      currentness: "stale",
      summaryJson: { counts: { total: 1, passed: 1, failed: 0, blocked: 0, skipped: 0 } },
      reportArtifactId: entries[3]!.artifact.id,
    });
    tx.insertLease({
      id: newId(),
      jobId,
      kind: "har-staging",
      resourceIdentityJson: { storageKey: "x" },
      ownershipProofJson: { mintedBy: "seed", jobId },
      cleanupState: "pending",
      lastErrorJson: null,
      retryAt: null,
      retryCount: 0,
    });
    return true;
  });
  if (!inserted.ok) throw new Error(inserted.error.message);
  return { target, local };
}

function resolverFor(local: ArtifactStore) {
  return (entry: ManifestEntry): string | null => local.absolutePathFor(asId(entry.projectId), entry.storageKey);
}

async function freshDb(name: string): Promise<{ handle: DatabaseSync; dir: string; local: ArtifactStore }> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  const handle = new DatabaseSync(path.join(dir, "workbench.db"));
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA foreign_keys = ON");
  opened.push(handle);
  return { handle, dir, local: new ArtifactStore(dir) };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-backup-"));
  const live = path.join(root, "live");
  await mkdir(live, { recursive: true });
  const openedLive = openWriteConnection(live);
  if (!openedLive.ok) throw new Error(openedLive.error.message);
  db = openedLive.value.db;
  opened.push(db);
  writer = new SqliteStorageWriter(db);
  await migrate(db);
  projectId = newId();
  seedProject(writer, projectId, "backup-suite");
});

afterAll(async () => {
  for (const handle of opened) handle.close();
  await rm(root, { recursive: true, force: true });
});

describe("an interrupted upgrade (D23 / T16)", () => {
  it("rolls the table rebuild back entirely and replays cleanly", async () => {
    const { handle } = await freshDb("interrupted");

    // Everything up to the rebuild applies, then the rebuild fails on its own first
    // statement because a decoy table is left in its way.
    const planned = planMigrations(handle);
    if (!planned.ok) throw new Error(planned.error.message);
    const firstFour = { ...planned.value, pending: planned.value.pending.filter((id) => id !== "0005-artifact-export-class") };
    expect(unwrap(applyMigrations(handle, firstFour))).toEqual([
      "0001-core",
      "0002-evidence-graph",
      "0003-delivery",
      "0004-events-audit",
    ]);
    handle.exec("CREATE TABLE artifacts_new (id TEXT PRIMARY KEY)");

    const replay = planMigrations(handle);
    if (!replay.ok) throw new Error(replay.error.message);
    const failed = applyMigrations(handle, replay.value);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe("MIGRATION_FAILED");
    handle.exec("DROP TABLE artifacts_new");

    // No half state: 0005 is unrecorded, the fifth class is still refused, and the schema
    // this build can serve is still zero rather than a flattering four.
    const after = planMigrations(handle);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.pending).toEqual(["0005-artifact-export-class"]);
    expect(currentSchemaVersion(handle)).toBe(0);
    const refused = new SqliteStorageWriter(handle).transact((tx) => {
      try {
        tx.insertArtifact({
          id: newId(),
          projectId,
          jobId: null,
          class: "export" as never,
          sha256: asDigest(hex("interrupted")),
          digestReason: null,
          byteLength: 1,
          storageKey: `projects/${projectId}/artifacts/export/x.bin`,
          mediaType: "application/octet-stream",
          createdAt: nowInstant(),
        });
        return "accepted";
      } catch {
        return "refused";
      }
    });
    expect(refused.ok && refused.value).toBe("refused");

    const second = planMigrations(handle);
    if (!second.ok) throw new Error(second.error.message);
    expect(unwrap(applyMigrations(handle, second.value))).toEqual(["0005-artifact-export-class"]);
    expect(currentSchemaVersion(handle)).toBe(SCHEMA_VERSION);
    // The rebuild is reentrant: the same id applied twice would be a second migration.
    const third = planMigrations(handle);
    if (!third.ok) throw new Error(third.error.message);
    expect(third.value.pending).toEqual([]);
  });

  it("rolls back a migration that would leave a dangling reference", async () => {
    const { handle } = await freshDb("dangling");
    await migrate(handle);
    const planned = planMigrations(handle);
    if (!planned.ok) throw new Error(planned.error.message);
    // A project with a child row, so deleting the parent is a real dangling reference and
    // not a no-op: the guard has to catch the child being orphaned.
    const parent = newId();
    seedProject(new SqliteStorageWriter(handle), parent, "dangling-parent");
    const childTarget = newId();
    const seeded = new SqliteStorageWriter(handle).transact((tx) => {
      tx.insertTarget({
        id: childTarget,
        projectId: parent,
        kind: "har",
        originalLocator: null,
        sourceSha256: null,
        sourceArtifactId: null,
        snapshotDigest: null,
        identityReason: "seeded-for-the-integrity-check",
        createdAt: nowInstant(),
      });
      return true;
    });
    if (!seeded.ok) throw new Error(seeded.error.message);
    const destructive = {
      ...planned.value,
      pending: ["9001-breaks-references"],
    };
    const outcome = applyMigrations(handle, destructive, [
      {
        id: "9001-breaks-references",
        // The deferred-FK path is what makes this dangerous: enforcement is off while the
        // statements run, so the only thing standing between this and a corrupt database is
        // the integrity check before COMMIT.
        deferForeignKeys: true,
        sql: `DELETE FROM projects WHERE id = '${parent}'`,
      },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("MIGRATION_FAILED");
    expect(outcome.error.message).toContain("dangling reference");
    // The rollback was real: both the parent and the child the destructive step orphaned
    // are still there, and the migration is unrecorded so it can be replayed.
    expect(handle.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(parent)).toEqual({ n: 1 });
    expect(handle.prepare("SELECT COUNT(*) AS n FROM targets WHERE id = ?").get(childTarget)).toEqual({ n: 1 });
    expect(handle.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '9001-breaks-references'").get()).toEqual({ n: 0 });

    // Enforcement off is a privilege a migration has to ask for by name. Without the flag,
    // the same drop is refused by SQLite itself, which is what keeps `deferForeignKeys` from
    // quietly becoming a global disable.
    const undeclared = applyMigrations(handle, { ...destructive, pending: ["9002-drops-a-parent"] }, [
      { id: "9002-drops-a-parent", sql: "DROP TABLE projects;" },
    ]);
    expect(undeclared.ok).toBe(false);
    if (undeclared.ok) return;
    expect(undeclared.error.code).toBe("MIGRATION_FAILED");
    expect(handle.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(parent)).toEqual({ n: 1 });
  });

  it("refuses to read a database a newer build already migrated", async () => {
    const { handle } = await freshDb("newer");
    await migrate(handle);
    handle
      .prepare("INSERT INTO schema_migrations (id, sql_sha256, applied_at) VALUES (?, ?, ?)")
      .run("0099-of-a-newer-build", hex("newer-build").padEnd(64, "0").slice(0, 64), nowInstant());

    const planned = planMigrations(handle);
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error.code).toBe("MIGRATION_UNKNOWN");
    expect(planned.error.message).toContain("0099-of-a-newer-build");
    expect(currentSchemaVersion(handle)).toBe(0);

    const restore = planRestore({
      buildMigrationIds: MIGRATIONS.map((migration) => migration.id),
      snapshotMigrationIds: [...MIGRATIONS.map((migration) => migration.id), "0099-of-a-newer-build"],
    });
    expect(restore.ok).toBe(false);
    if (restore.ok) return;
    expect(restore.error.code).toBe("RESTORE_SCHEMA_INCOMPATIBLE");
    expect(restore.error.message).toContain("does not know");
  });
});

describe("a backup that can be restored (A12 / T16)", () => {
  it("records both halves and verifies every artifact digest again", async () => {
    const { handle, dir, local } = await freshDb("snapshot");
    const project = newId();
    await migrate(handle);
    await seedStore(handle, local, project);

    const bundle = unwrap(
      await createReleaseBackup({ db: handle, dataDir: dir, schemaVersion: SCHEMA_VERSION, resolveFile: resolverFor(local) }),
    );
    expect(bundle.manifest.artifacts).toHaveLength(6);
    expect(bundle.manifest.projects).toBe(1);
    expect(bundle.manifest.migrations).toEqual(MIGRATIONS.map((migration) => migration.id));
    expect(bundle.manifest.openLeases).toBe(1);
    expect(bundle.manifest.verifications).toEqual({ current: 0, stale: 1, byResult: { PASS: 1 } });
    expect(path.basename(bundle.manifestFile)).toContain(".manifest.json");
    expect(bundle.manifest.artifacts.map((entry) => entry.class).sort()).toEqual([
      "blueprint",
      "candidate",
      "export",
      "inspector",
      "inspector",
      "report",
    ]);

    const verified = unwrap(await verifyReleaseBackup({ bundle, resolveFile: resolverFor(local) }));
    expect(verified.reasons).toEqual([]);
    // The manifest's migration list is checked against the snapshot, not assumed: a bundle
    // claiming a step the database does not record is not restorable.
    const drifted = { ...bundle, manifest: { ...bundle.manifest, migrations: [...bundle.manifest.migrations, "0006-that-never-ran"] } };
    const driftedReport = unwrap(await verifyReleaseBackup({ bundle: drifted, resolveFile: resolverFor(local) }));
    expect(driftedReport.reasons).toEqual(["migration-missing-from-snapshot:0006-that-never-ran"]);
    // Five digested artifacts re-hashed from disk, plus one withheld with a reason.
    expect(verified.artifacts).toEqual({ verified: 5, missing: 0, mismatched: 0, withheld: 1 });
    expect(verified.openLeases).toBe(1);
  });

  it("refuses to write a backup whose file list is already broken", async () => {
    const { handle, dir, local } = await freshDb("missing-file");
    const project = newId();
    await migrate(handle);
    await seedStore(handle, local, project);
    const gone = handle
      .prepare("SELECT storage_key AS k FROM artifacts WHERE class = 'export'")
      .get() as { k: string };
    const file = local.absolutePathFor(project, gone.k);
    if (file === null) throw new Error("the store refused to resolve its own key");
    await rm(file, { force: true });

    // Failing here is the point: a manifest naming a file that is already gone would
    // produce a bundle that looks restorable and is not (D23).
    const refused = await createReleaseBackup({ db: handle, dataDir: dir, schemaVersion: SCHEMA_VERSION, resolveFile: resolverFor(local) });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("BACKUP_INCOMPLETE");
    expect(refused.error.message).toContain("artifact file missing before backup");
  });

  it("reports a file that changed after the snapshot instead of trusting the manifest", async () => {
    const { handle, dir, local } = await freshDb("corrupt");
    const project = newId();
    await migrate(handle);
    await seedStore(handle, local, project);
    const bundle = unwrap(
      await createReleaseBackup({ db: handle, dataDir: dir, schemaVersion: SCHEMA_VERSION, resolveFile: resolverFor(local) }),
    );
    const victim = bundle.manifest.artifacts.find((entry) => entry.class === "candidate");
    if (victim === undefined) throw new Error("no candidate artifact in the manifest");
    const file = local.absolutePathFor(project, victim.storageKey);
    if (file === null) throw new Error("the store refused to resolve its own key");
    await writeFile(file, "rewritten after the snapshot");

    const verified = unwrap(await verifyReleaseBackup({ bundle, resolveFile: resolverFor(local) }));
    expect(verified.artifacts.mismatched).toBe(1);
    expect(verified.reasons.join(",")).toContain(`artifact-file-digest-mismatch:${victim.storageKey}`);
    expect(verified.artifacts.verified).toBe(4);
  });

  it("refuses to back up a manifest that names a file outside the store", async () => {
    const { handle, dir, local } = await freshDb("outside");
    await migrate(handle);
    seedProject(new SqliteStorageWriter(handle), projectId, "outside-suite");
    handle
      .prepare(
        `INSERT INTO artifacts (id, project_id, job_id, class, sha256, digest_reason, byte_length, storage_key, media_type, created_at)
         VALUES (?, ?, NULL, 'inspector', ?, NULL, 4, ?, 'application/octet-stream', ?)`,
      )
      .run(newId(), projectId, asDigest(hex("outside-key")), `projects/${projectId}/../../escape.bin`, nowInstant());

    const refused = await createReleaseBackup({ db: handle, dataDir: dir, schemaVersion: SCHEMA_VERSION, resolveFile: resolverFor(local) });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("BACKUP_INCOMPLETE");
    expect(refused.error.message).toContain("resolves outside the store");
  });

  it("keeps a WAL commit in the snapshot and the counts identical after a restore", async () => {
    const { handle, dir, local } = await freshDb("wal");
    const project = newId();
    await migrate(handle);
    await seedStore(handle, local, project);
    // Nothing is checkpointed before the snapshot: this commit lives only in the WAL, and a
    // plain file copy of the `.db` would lose it. D23 makes the consistent snapshot the only
    // allowed copy for exactly that reason.
    const late = newId();
    seedProject(new SqliteStorageWriter(handle), late, "wal-suite");

    const bundle = unwrap(
      await createReleaseBackup({ db: handle, dataDir: dir, schemaVersion: SCHEMA_VERSION, resolveFile: resolverFor(local) }),
    );
    expect(bundle.manifest.projects).toBe(2);

    const restoredDir = path.join(root, "restored");
    await mkdir(restoredDir, { recursive: true });
    const restoredFile = path.join(restoredDir, "workbench.db");
    await copyFile(bundle.databaseFile, restoredFile);
    const restored = new DatabaseSync(restoredFile);

    const names = restored.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(names.map((row) => row.name)).toContain("exports");
    expect(restored.prepare("SELECT name FROM projects WHERE id = ?").get(late)).toBeTruthy();
    const manifestFromRestore = buildManifest(restored, SCHEMA_VERSION);
    expect(manifestFromRestore.migrations).toEqual(bundle.manifest.migrations);
    expect(manifestFromRestore.projects).toBe(bundle.manifest.projects);
    expect(manifestFromRestore.openLeases).toBe(bundle.manifest.openLeases);
    expect(manifestFromRestore.verifications).toEqual(bundle.manifest.verifications);
    expect(manifestFromRestore.artifacts).toEqual(bundle.manifest.artifacts);
    restored.close();
    expect(readFileSync(bundle.manifestFile, "utf8")).toContain("schemaVersion");
  });
});

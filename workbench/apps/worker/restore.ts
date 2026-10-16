import { existsSync } from "node:fs";
import { copyFile, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  createReleaseBackup,
  planRestore,
  verifyReleaseBackup,
  type BackupManifest,
  type ManifestEntry,
  type RestoreReport,
} from "../../packages/adapters/storage/backup-manifest.ts";
import {
  acquireWorkerLock,
  applyMigrations,
  openWriteConnection,
  planMigrations,
} from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { MIGRATIONS } from "../../packages/adapters/storage/migrations.ts";
import { asId, type Id } from "../../packages/domain/identity.ts";

// The offline restore (DESIGN §13 line 453, D23 / PRD A16, issue #23).
//
// §13 says a rollback first confirms this build can read the database, and otherwise
// restores the pair - the DB and the artifact manifest - from the same moment. That order is
// the whole design of this file:
//
//   1. take the worker's own exclusive lock, or stop. The offline entry reuses the same lock
//      precisely so it can never run beside a live worker.
//   2. confirm the schema (an id this build does not know is not a schema to open).
//   3. confirm the files the manifest promises are present and hash to what was recorded.
//   4. snapshot what is there now, so a restore that goes wrong has something to go back to.
//   5. only then swap the database in, and bring it up to this build's schema with the same
//      additive, reentrant migrator the worker uses.
//
// Steps 2 and 3 refuse before anything is written, which is what "no half-upgraded library"
// means operationally: the failure mode this command must never have is a data directory
// that is half old and half new.

export const DATABASE_BASENAME = "workbench.db";
export const MANIFEST_SUFFIX = ".manifest.json";

export type RestoreOutcome =
  | { ok: true; report: RestoreReport; restoredFrom: string; safetySnapshot: string | null; migrationsApplied: number }
  | { ok: false; code: string; reason: string; details: string[] };

function refusal(code: string, reason: string, details: string[] = []): { ok: false; code: string; reason: string; details: string[] } {
  return { ok: false, code, reason, details };
}

// The manifest is read as data and shape-checked here: a file that parses but has no
// migration list or no artifact list cannot be verified, and "verified" must not mean
// "nothing was checked".
function readManifest(file: string): Promise<{ ok: true; value: BackupManifest } | { ok: false; reason: string }> {
  return readFile(file, "utf8")
    .then((text) => {
      const parsed = JSON.parse(text) as Partial<BackupManifest>;
      if (typeof parsed.schemaVersion !== "number" || !Array.isArray(parsed.migrations) || !Array.isArray(parsed.artifacts)) {
        return { ok: false as const, reason: "backup-manifest-shape" };
      }
      return { ok: true as const, value: parsed as BackupManifest };
    })
    .catch(() => ({ ok: false as const, reason: "backup-manifest-unreadable" }));
}

export async function runRestore(input: { dataDir: string; snapshotFile: string }): Promise<RestoreOutcome> {
  const lock = await acquireWorkerLock(input.dataDir);
  if (!lock.ok) {
    // `DATA_DIR_LOCKED` is a live worker holding the directory; anything else (§14's privacy
    // and path checks) is its own named answer.
    return refusal(
      lock.error.code,
      lock.error.code === "DATA_DIR_LOCKED" ? "worker-still-running-close-it-first" : "data-directory-unusable",
    );
  }
  try {
    const manifestFile = `${input.snapshotFile}${MANIFEST_SUFFIX}`;
    if (!existsSync(input.snapshotFile) || !existsSync(manifestFile)) {
      return refusal("BACKUP_UNVERIFIABLE", "backup-pair-incomplete", [
        existsSync(input.snapshotFile) ? "database-snapshot-present" : "database-snapshot-missing",
        existsSync(manifestFile) ? "manifest-present" : "manifest-missing",
      ]);
    }
    const loaded = await readManifest(manifestFile);
    if (!loaded.ok) return refusal("BACKUP_UNVERIFIABLE", loaded.reason);

    const schema = planRestore({
      buildMigrationIds: MIGRATIONS.map((migration) => migration.id),
      snapshotMigrationIds: loaded.value.migrations,
    });
    if (!schema.ok) return refusal(schema.error.code, "snapshot-schema-newer-than-build", [schema.error.message]);

    const store = new ArtifactStore(input.dataDir);
    const resolveFile = (entry: ManifestEntry) => store.absolutePathFor(asId(entry.projectId) as Id & string, entry.storageKey);
    const verified = await verifyReleaseBackup({
      bundle: { databaseFile: input.snapshotFile, manifestFile, manifest: loaded.value },
      resolveFile,
    });
    if (!verified.ok) return refusal(verified.error.code, "backup-unverifiable", [verified.error.message]);
    const report = verified.value;
    // A restore whose files are gone would put the index back in front of content that is
    // not there: the rows would resolve to nothing and every read would look like corruption
    // the operator caused. §13 pairs the two on purpose.
    if (report.artifacts.missing > 0 || report.artifacts.mismatched > 0) {
      return refusal("BACKUP_INCOMPLETE", "artifact-files-do-not-match-the-manifest", report.reasons);
    }

    // What is there now gets its own snapshot before anything is overwritten, and it is
    // taken through the same code path a release backup uses, so the safety copy is as
    // verifiable as the thing it protects.
    let safetySnapshot: string | null = null;
    const live = openWriteConnection(input.dataDir);
    if (live.ok) {
      try {
        const before = await createReleaseBackup({
          db: live.value.db,
          dataDir: input.dataDir,
          schemaVersion: loaded.value.schemaVersion,
          resolveFile,
        });
        if (before.ok) safetySnapshot = before.value.databaseFile;
      } finally {
        live.value.db.close();
      }
    }

    const target = path.join(input.dataDir, DATABASE_BASENAME);
    try {
      // The side files belong to the database being replaced. Leaving a stale `-wal` behind
      // would let SQLite replay frames from the state this command just retired.
      await rm(`${target}-wal`, { force: true });
      await rm(`${target}-shm`, { force: true });
      // Copy, then rename the copy into place: the move is what makes the swap atomic, and
      // renaming the snapshot itself would consume the bundle the operator still needs to
      // prove what was restored.
      const staged = `${target}.restoring`;
      await rm(staged, { force: true });
      await copyFile(input.snapshotFile, staged);
      const stagedInfo = await stat(staged).catch(() => null);
      const sourceInfo = await stat(input.snapshotFile).catch(() => null);
      if (stagedInfo === null || sourceInfo === null || stagedInfo.size !== sourceInfo.size) {
        await rm(staged, { force: true }).catch(() => undefined);
        return refusal("RESTORE_FAILED", "snapshot-copy-incomplete", [
          `staged=${String(stagedInfo?.size ?? "none")}`,
          `source=${String(sourceInfo?.size ?? "none")}`,
        ]);
      }
      await rename(staged, target);
    } catch (error) {
      return refusal("RESTORE_FAILED", "snapshot-could-not-be-moved-into-place", [String((error as Error).message)]);
    }

    // Bring the restored database up with the same additive, reentrant migrator the worker
    // runs at startup. An older snapshot is expected to be behind; that is the D23 case
    // ("confirm the old build can read it, otherwise restore the pair"). `planMigrations` is
    // itself that confirmation here: it refuses a database carrying an id this build has
    // never seen, so nothing further is written to a schema this build cannot read.
    const opened = openWriteConnection(input.dataDir);
    if (!opened.ok) return refusal("RESTORE_FAILED", "restored-database-unopenable", [opened.error.message]);
    let applied = 0;
    try {
      const plan = planMigrations(opened.value.db);
      if (!plan.ok) return refusal("RESTORE_FAILED", "restored-schema-unplannable", [plan.error.message]);
      const pendingBefore = plan.value.pending;
      const done = applyMigrations(opened.value.db, plan.value);
      if (!done.ok) return refusal("RESTORE_FAILED", "restored-schema-upgrade-failed", [done.error.message]);
      applied = pendingBefore.length;
      // "Nothing left to do" is the assertion, not the count: a snapshot that still needs a
      // migration after this command would be handed back to a worker that has to write
      // during startup, which is the half-upgraded state §13 forbids.
      const after = planMigrations(opened.value.db);
      if (!after.ok) return refusal("RESTORE_FAILED", "restored-schema-unreplanable", [after.error.message]);
      if (after.value.pending.length > 0) {
        return refusal("RESTORE_FAILED", "restored-schema-still-pending", [...after.value.pending]);
      }
    } finally {
      opened.value.db.close();
    }

    return { ok: true, report, restoredFrom: input.snapshotFile, safetySnapshot, migrationsApplied: applied };
  } finally {
    await lock.value.release();
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const dataDir = process.env.WB_DATA_DIR ?? "";
  const fromIndex = argv.indexOf("--from");
  const snapshotFile = fromIndex >= 0 ? (argv[fromIndex + 1] ?? "") : "";
  if (dataDir === "" || snapshotFile === "") {
    log("usage: WB_DATA_DIR=<data dir> npm run db:restore -- --from <data dir>/backups/workbench-<stamp>.db");
    log("the worker must be stopped: this command takes the same exclusive lock it holds.");
    return 64;
  }
  if (!path.isAbsolute(snapshotFile)) {
    log("restore-refused snapshot-path-must-be-absolute");
    return 64;
  }
  const outcome = await runRestore({ dataDir, snapshotFile });
  if (!outcome.ok) {
    // Reasons and the named code only: no host paths beyond the one the operator typed.
    log(`restore-refused ${outcome.code}:${outcome.reason}`);
    for (const detail of outcome.details) log(`  ${detail}`);
    return 1;
  }
  const { report } = outcome;
  log(`restored from=${path.basename(outcome.restoredFrom)}`);
  log(
    `artifacts verified=${String(report.artifacts.verified)} missing=${String(report.artifacts.missing)} mismatched=${String(report.artifacts.mismatched)} withheld=${String(report.artifacts.withheld)}`,
  );
  log(`projects=${String(report.projects)} openLeases=${String(report.openLeases)} verifications.current=${String(report.verifications.current)} stale=${String(report.verifications.stale)}`);
  log(`migrationsApplied=${String(outcome.migrationsApplied)} safetySnapshot=${outcome.safetySnapshot === null ? "none" : path.basename(outcome.safetySnapshot)}`);
  const size = await stat(path.join(dataDir, DATABASE_BASENAME)).catch(() => null);
  log(`database=${DATABASE_BASENAME} bytes=${String(size?.size ?? 0)}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

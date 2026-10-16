import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createReleaseBackup, verifyReleaseBackup, type ManifestEntry, type RestoreReport } from "../../packages/adapters/storage/backup-manifest.ts";
import {
  acquireWorkerLock,
  applyMigrations,
  openWriteConnection,
  planMigrations,
} from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SCHEMA_VERSION } from "../../packages/adapters/storage/migrations.ts";
import type { BackupManifest } from "../../packages/adapters/storage/backup-manifest.ts";
import type { Id } from "../../packages/domain/identity.ts";

// The operator's backup and verify commands (DESIGN §13 line 453, §5 line 126 / PRD A12,
// issue #23).
//
// `db:restore` only means something if a bundle exists to restore, and a bundle only means
// something if the same pair can be checked before it is needed. These are one story with the
// restore: same lock, same store-resolved keys, counts on the terminal rather than paths an
// operator has to retype.
//
// Both refuse to run beside a live worker. A backup is a `VACUUM INTO` snapshot plus a
// per-artifact manifest, and a manifest written while another process is still publishing
// files describes a moment that never existed.

export type CommandFailure = { code: string; reason: string; details: string[] };
export type BackupOutcome =
  | { ok: true; databaseFile: string; manifestFile: string; artifacts: number; projects: number; bytes: number }
  | { ok: false; failure: CommandFailure };
export type VerifyOutcome = { ok: true; report: RestoreReport } | { ok: false; failure: CommandFailure };

function failure(code: string, reason: string, details: string[] = []): { ok: false; failure: CommandFailure } {
  return { ok: false, failure: { code, reason, details } };
}

type Quiesced = { ok: true; db: DatabaseSync; release: () => Promise<void>; store: ArtifactStore };

// The shared front door: the worker's own exclusive lock, then the database, then a schema
// that is complete for this build. A pending migration is applied here rather than worked
// around, because the worker would have applied it at startup anyway and a backup taken
// before it is not something this build can hand back.
async function quiesce(dataDir: string): Promise<Quiesced | { ok: false; failure: CommandFailure }> {
  const lock = await acquireWorkerLock(dataDir);
  if (!lock.ok) {
    return failure(
      lock.error.code,
      lock.error.code === "DATA_DIR_LOCKED" ? "worker-still-running-close-it-first" : "data-directory-unusable",
    );
  }
  const opened = openWriteConnection(dataDir);
  if (!opened.ok) {
    await lock.value.release();
    return failure(opened.error.code, "database-unopenable", [opened.error.message]);
  }
  const finish = (message: { code: string; message: string }): { ok: false; failure: CommandFailure } => {
    opened.value.db.close();
    void lock.value.release();
    return failure(message.code, "schema-unusable", [message.message]);
  };
  const plan = planMigrations(opened.value.db);
  if (!plan.ok) return finish(plan.error);
  if (plan.value.pending.length > 0) {
    const applied = applyMigrations(opened.value.db, plan.value);
    if (!applied.ok) return finish(applied.error);
  }
  return { ok: true, db: opened.value.db, release: lock.value.release, store: new ArtifactStore(dataDir) };
}

function resolveThrough(store: ArtifactStore): (entry: ManifestEntry) => string | null {
  // Keys are resolved by the store, per entry: a manifest that names a path outside the
  // store cannot be backed up or verified through this code at all (§5).
  return (entry) => store.absolutePathFor(entry.projectId as Id, entry.storageKey);
}

export async function runBackup(dataDir: string): Promise<BackupOutcome> {
  const held = await quiesce(dataDir);
  if (!held.ok) return held;
  try {
    const bundle = await createReleaseBackup({
      db: held.db,
      dataDir,
      schemaVersion: SCHEMA_VERSION,
      resolveFile: resolveThrough(held.store),
    });
    if (!bundle.ok) return failure(bundle.error.code, "backup-refused", [bundle.error.message]);
    const bytes = await stat(bundle.value.databaseFile).then((info) => info.size).catch(() => 0);
    return {
      ok: true,
      databaseFile: bundle.value.databaseFile,
      manifestFile: bundle.value.manifestFile,
      artifacts: bundle.value.manifest.artifacts.length,
      projects: bundle.value.manifest.projects,
      bytes,
    };
  } finally {
    held.db.close();
    await held.release();
  }
}

export async function runVerify(dataDir: string, snapshotFile: string): Promise<VerifyOutcome> {
  if (!path.isAbsolute(snapshotFile)) return failure("INVALID_INPUT", "snapshot-path-must-be-absolute");
  const manifestFile = `${snapshotFile}.manifest.json`;
  if (!existsSync(snapshotFile) || !existsSync(manifestFile)) {
    return failure("BACKUP_UNVERIFIABLE", "backup-pair-incomplete", [
      existsSync(snapshotFile) ? "database-snapshot-present" : "database-snapshot-missing",
      existsSync(manifestFile) ? "manifest-present" : "manifest-missing",
    ]);
  }
  const held = await quiesce(dataDir);
  if (!held.ok) return held;
  try {
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as BackupManifest;
    const verified = await verifyReleaseBackup({
      bundle: { databaseFile: snapshotFile, manifestFile, manifest },
      resolveFile: resolveThrough(held.store),
    });
    if (!verified.ok) return failure(verified.error.code, "backup-unverifiable", [verified.error.message]);
    return { ok: true, report: verified.value };
  } catch (error) {
    return failure("BACKUP_UNVERIFIABLE", "backup-manifest-unreadable", [String((error as Error).message)]);
  } finally {
    held.db.close();
    await held.release();
  }
}

const USAGE = [
  "usage:",
  "  WB_DATA_DIR=<data dir> npm run db:backup",
  "  WB_DATA_DIR=<data dir> npm run db:verify -- <data dir>/backups/workbench-<stamp>.db",
  "both take the worker's exclusive lock: stop the worker first.",
];

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const dataDir = process.env.WB_DATA_DIR ?? "";
  if (dataDir === "") {
    for (const line of USAGE) log(line);
    return 64;
  }
  const verify = argv[0] === "verify";
  if (verify) {
    const target = argv[1] ?? "";
    if (target === "") {
      for (const line of USAGE) log(line);
      return 64;
    }
    const outcome = await runVerify(dataDir, target);
    if (!outcome.ok) {
      log(`verify-refused ${outcome.failure.code}:${outcome.failure.reason}`);
      for (const detail of outcome.failure.details) log(`  ${detail}`);
      return 1;
    }
    const { report } = outcome;
    log(
      `verified artifacts=${String(report.artifacts.verified)} missing=${String(report.artifacts.missing)} mismatched=${String(report.artifacts.mismatched)} withheld=${String(report.artifacts.withheld)}`,
    );
    log(`projects=${String(report.projects)} openLeases=${String(report.openLeases)} verifications.current=${String(report.verifications.current)} stale=${String(report.verifications.stale)}`);
    for (const reason of report.reasons) log(`  reason ${reason}`);
    // A report with named reasons is not a pass even when every file was found: §13 wants the
    // pair confirmed, and `reasons` is where a bundle says what it cannot promise.
    return report.reasons.length === 0 ? 0 : 1;
  }
  const outcome = await runBackup(dataDir);
  if (!outcome.ok) {
    log(`backup-refused ${outcome.failure.code}:${outcome.failure.reason}`);
    for (const detail of outcome.failure.details) log(`  ${detail}`);
    return 1;
  }
  log(`backed-up projects=${String(outcome.projects)} artifacts=${String(outcome.artifacts)} bytes=${String(outcome.bytes)}`);
  log(`database=${path.basename(outcome.databaseFile)}`);
  log(`manifest=${path.basename(outcome.manifestFile)}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

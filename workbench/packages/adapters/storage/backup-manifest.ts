import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { asDigest } from "../../domain/canonical-json.ts";
import type { Digest } from "../../domain/canonical-json.ts";
import type { Instant } from "../../domain/identity.ts";
import { nowInstant } from "../../domain/identity.ts";
import type { Result } from "../../domain/result.ts";
import type { ArtifactClass } from "../../application/ports.ts";
import { consistentBackup, MIGRATION_TABLE, writeFileFsync } from "./database.ts";
import type { StorageError, StorageErrorCode } from "./database.ts";

// A backup that can actually be restored (DESIGN §13 line 453, PRD A12 / T16, issue #23).
//
// `consistentBackup` alone is half of D23: the database is a consistent snapshot, but the
// artifact store is a directory of files that kept changing while the snapshot was taken.
// A restore is only honest when both halves agree, so the backup writes a manifest of every
// artifact with its digest and byte length, and verification re-hashes the files on disk
// against the rows the snapshot contains. Anything else is a copy of two unrelated moments.

export type ManifestEntry = {
  projectId: string;
  artifactId: string;
  class: ArtifactClass;
  sha256: Digest | null;
  digestReason: string | null;
  byteLength: number;
  storageKey: string;
};

export type BackupManifest = {
  schemaVersion: number;
  createdAt: Instant;
  migrations: string[];
  projects: number;
  artifacts: ManifestEntry[];
  openLeases: number;
  verifications: { current: number; stale: number; byResult: Record<string, number> };
};

export type BackupBundle = { databaseFile: string; manifestFile: string; manifest: BackupManifest };

export type RestoreReport = {
  manifestFile: string;
  artifacts: { verified: number; missing: number; mismatched: number; withheld: number };
  projects: number;
  openLeases: number;
  verifications: { current: number; stale: number };
  reasons: string[];
};

function fail(code: StorageErrorCode, message: string): { ok: false; error: StorageError } {
  return { ok: false, error: { code, message } };
}

// Every query here is a fixed statement with no caller-supplied text: the inputs are this
// module's own table and column names.
function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[];
}

export function buildManifest(db: DatabaseSync, schemaVersion: number): BackupManifest {
  const artifacts = rows(
    db,
    `SELECT project_id, id, class, sha256, digest_reason, byte_length, storage_key FROM artifacts ORDER BY project_id, id`,
  ).map(
    (row) =>
      ({
        projectId: String(row["project_id"]),
        artifactId: String(row["id"]),
        class: String(row["class"]) as ArtifactClass,
        sha256: row["sha256"] === null ? null : asDigest(String(row["sha256"])),
        digestReason: row["digest_reason"] === null ? null : String(row["digest_reason"]),
        byteLength: Number(row["byte_length"]),
        storageKey: String(row["storage_key"]),
      }) satisfies ManifestEntry,
  );
  const verifications = rows(db, "SELECT result, currentness FROM verifications");
  const byResult: Record<string, number> = {};
  for (const row of verifications) {
    const key = String(row["result"]);
    byResult[key] = (byResult[key] ?? 0) + 1;
  }
  return {
    schemaVersion,
    createdAt: nowInstant(),
    migrations: rows(db, `SELECT id FROM ${MIGRATION_TABLE} ORDER BY id`).map((row) => String(row["id"])),
    projects: Number((rows(db, "SELECT COUNT(*) AS n FROM projects")[0] as { n: number }).n),
    artifacts,
    openLeases: Number(
      (rows(db, "SELECT COUNT(*) AS n FROM resource_leases WHERE cleanup_state <> 'complete'")[0] as { n: number }).n,
    ),
    verifications: {
      current: verifications.filter((row) => row["currentness"] === "current").length,
      stale: verifications.filter((row) => row["currentness"] === "stale").length,
      byResult,
    },
  };
}

// The artifact files are read through the store's own key resolution, so a manifest that
// names a path outside the store cannot be verified by this code at all.
export async function createReleaseBackup(input: {
  db: DatabaseSync;
  dataDir: string;
  schemaVersion: number;
  // The store resolves the key itself, per entry: a manifest naming a path outside
  // the store cannot be backed up at all.
  resolveFile: (entry: ManifestEntry) => string | null;
}): Promise<Result<BackupBundle, StorageError>> {
  const snapshot = await consistentBackup(input.db, input.dataDir);
  if (!snapshot.ok) return snapshot;
  const manifest = buildManifest(input.db, input.schemaVersion);
  // Every entry the manifest promises has to be present and the right size now: a backup
  // whose file list names a truncated artifact is worse than no backup, because it looks
  // restorable.
  for (const entry of manifest.artifacts) {
    const file = input.resolveFile(entry);
    if (file === null) return fail("BACKUP_INCOMPLETE", `manifest key resolves outside the store: ${entry.artifactId}`);
    const info = await stat(file).catch(() => null);
    if (info === null) return fail("BACKUP_INCOMPLETE", `artifact file missing before backup: ${entry.storageKey}`);
    if (info.size !== entry.byteLength) {
      return fail("BACKUP_INCOMPLETE", `artifact size drift: ${entry.storageKey} ${String(info.size)}!=${String(entry.byteLength)}`);
    }
  }
  const manifestFile = `${snapshot.value.file}.manifest.json`;
  try {
    await writeFileFsync(manifestFile, JSON.stringify(manifest));
  } catch (error) {
    return fail("BACKUP_FAILED", `manifest could not be written: ${String((error as Error).message)}`);
  }
  return { ok: true, value: { databaseFile: snapshot.value.file, manifestFile, manifest } };
}

// Verification opens the snapshot read-only and re-hashes the files. `reasons` is the
// answer T16 asks for: what a restore would be missing, named by artifact.
export async function verifyReleaseBackup(input: {
  bundle: BackupBundle;
  resolveFile: (entry: ManifestEntry) => string | null;
}): Promise<Result<RestoreReport, StorageError>> {
  let db: DatabaseSync | null = null;
  const report: RestoreReport = {
    manifestFile: input.bundle.manifestFile,
    artifacts: { verified: 0, missing: 0, mismatched: 0, withheld: 0 },
    projects: input.bundle.manifest.projects,
    openLeases: input.bundle.manifest.openLeases,
    verifications: { current: input.bundle.manifest.verifications.current, stale: input.bundle.manifest.verifications.stale },
    reasons: [],
  };
  try {
    db = new DatabaseSync(input.bundle.databaseFile, { readOnly: true });
    const recorded = rows(db, `SELECT id, sql_sha256 FROM ${MIGRATION_TABLE} ORDER BY id`);
    const recordedIds = recorded.map((row) => String(row["id"]));
    for (const id of input.bundle.manifest.migrations) {
      if (!recordedIds.includes(id)) report.reasons.push(`migration-missing-from-snapshot:${id}`);
    }
    const live = new Map(
      rows(db, "SELECT project_id, id, sha256, byte_length FROM artifacts").map((row) => [
        `${String(row["project_id"])}|${String(row["id"])}`,
        row,
      ]),
    );
    for (const entry of input.bundle.manifest.artifacts) {
      const row = live.get(`${entry.projectId}|${entry.artifactId}`);
      if (row === undefined) {
        report.reasons.push(`artifact-row-absent-from-snapshot:${entry.artifactId}`);
        report.artifacts.missing += 1;
        continue;
      }
      // A withheld digest is stored as NULL, and `String(null)` would never equal the
      // manifest's null: compare the two sides as the nullable values they are (§4).
      const rowDigest = row["sha256"] === null ? null : String(row["sha256"]);
      if (rowDigest !== entry.sha256 || Number(row["byte_length"]) !== entry.byteLength) {
        report.reasons.push(`artifact-row-disagrees-with-manifest:${entry.artifactId}`);
        report.artifacts.mismatched += 1;
        continue;
      }
      if (entry.sha256 === null) {
        // A withheld digest is a stated fact, not a gap: §4 requires the reason beside it.
        if (entry.digestReason === null) report.reasons.push(`withheld-digest-without-reason:${entry.artifactId}`);
        report.artifacts.withheld += 1;
        continue;
      }
      const file = input.resolveFile(entry);
      if (file === null) {
        report.reasons.push(`artifact-key-outside-store:${entry.artifactId}`);
        report.artifacts.missing += 1;
        continue;
      }
      const bytes = await readFile(file);
      if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
        report.reasons.push(`artifact-file-digest-mismatch:${entry.storageKey}`);
        report.artifacts.mismatched += 1;
        continue;
      }
      report.artifacts.verified += 1;
    }
    return { ok: true, value: report };
  } catch (error) {
    return fail("BACKUP_UNVERIFIABLE", String((error as Error).message));
  } finally {
    db?.close();
  }
}

// D23 says a rollback first confirms the old build can read the database, and otherwise
// restores the pair from the same moment. The confirmation is exactly the rule
// `planMigrations` applies: an id this build does not know is not a schema to open.
export function planRestore(input: {
  buildMigrationIds: readonly string[];
  snapshotMigrationIds: readonly string[];
}): Result<{ compatible: true }, StorageError> {
  const newer = input.snapshotMigrationIds.filter((id) => !input.buildMigrationIds.includes(id));
  if (newer.length > 0) {
    return fail(
      "RESTORE_SCHEMA_INCOMPATIBLE",
      `the backup carries migrations this build does not know: ${[...newer].sort().join(", ")}`,
    );
  }
  return { ok: true, value: { compatible: true } as { compatible: true } };
}

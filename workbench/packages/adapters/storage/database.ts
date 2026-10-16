import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Err, Result } from "../../domain/result.ts";
import { nowInstant } from "../../domain/identity.ts";
import { KNOWN_MIGRATION_IDS, MIGRATIONS, SCHEMA_VERSION } from "./migrations.ts";

// DESIGN §2/§6 (D06): exactly one worker owns the SQLite write connection and
// holds a process-level exclusive lock over the data directory. A second worker
// must fail to start rather than degrade into multi-writer access.

export const DATABASE_FILE = "workbench.db";
export const LOCK_FILE = "worker.lock";
export const BACKUP_DIR = "backups";
export const MIGRATION_TABLE = "schema_migrations";

export type StorageErrorCode =
  | "DATA_DIR_MISSING"
  | "DATA_DIR_LOCKED"
  | "MIGRATION_CHECKSUM_CONFLICT"
  | "MIGRATION_UNKNOWN"
  | "MIGRATION_FAILED"
  | "BACKUP_FAILED"
  | "SQLITE_FAILURE";

export type StorageError = { code: StorageErrorCode; message: string };

function fail(code: StorageErrorCode, message: string): Err<StorageError> {
  return { ok: false, error: { code, message } };
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export type OwnedLock = {
  readonly dataDir: string;
  readonly lockPath: string;
  release: () => Promise<void>;
};

// The lock is created with O_EXCL and records this pid. A live or stale owner
// both block a second writer; takeover is an explicit operator action outside
// the workbench, never an implicit retry.
export async function acquireWorkerLock(dataDir: string): Promise<Result<OwnedLock, StorageError>> {
  if (!existsSync(dataDir)) {
    return fail("DATA_DIR_MISSING", `data directory ${dataDir} must exist and be chosen explicitly`);
  }
  const lockPath = path.join(dataDir, LOCK_FILE);
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const holder = await readFile(lockPath, "utf8").catch(() => "unknown");
      return fail("DATA_DIR_LOCKED", `another worker holds ${lockPath} (pid ${holder.trim()})`);
    }
    return fail("SQLITE_FAILURE", `cannot create ${lockPath}: ${String(code ?? error)}`);
  }
  await handle.writeFile(`${process.pid}\n`, "utf8");
  await handle.sync();
  await handle.close();
  return {
    ok: true,
    value: {
      dataDir,
      lockPath,
      release: async () => {
        await rm(lockPath, { force: true });
      },
    },
  };
}

export type OpenedDatabase = {
  readonly db: DatabaseSync;
  readonly file: string;
};

export function openWriteConnection(dataDir: string): Result<OpenedDatabase, StorageError> {
  const file = path.join(dataDir, DATABASE_FILE);
  try {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = FULL");
    return { ok: true, value: { db, file } };
  } catch (error) {
    return fail("SQLITE_FAILURE", `cannot open ${file}: ${String((error as Error).message)}`);
  }
}

export type MigrationPlan = {
  readonly pending: readonly string[];
  readonly applied: readonly string[];
};

function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
  id TEXT PRIMARY KEY,
  sql_sha256 TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`);
}

export function planMigrations(db: DatabaseSync): Result<MigrationPlan, StorageError> {
  try {
    ensureMigrationTable(db);
    const rows = db
      .prepare(`SELECT id, sql_sha256 FROM ${MIGRATION_TABLE} ORDER BY id`)
      .all() as { id: string; sql_sha256: string }[];
    const recorded = new Map(rows.map((row) => [row.id, row.sql_sha256]));

    // A newer release may have upgraded this database already; continuing with
    // an older binary would read a schema this code does not understand.
    const unknown = rows.map((row) => row.id).filter((id) => !KNOWN_MIGRATION_IDS.includes(id));
    if (unknown.length > 0) {
      return fail(
        "MIGRATION_UNKNOWN",
        `database carries migrations this build does not know: ${unknown.sort().join(", ")}`,
      );
    }
    for (const migration of MIGRATIONS) {
      const digest = recorded.get(migration.id);
      if (digest !== undefined && digest !== checksum(migration.sql)) {
        return fail(
          "MIGRATION_CHECKSUM_CONFLICT",
          `migration ${migration.id} changed after it was applied`,
        );
      }
    }
    return {
      ok: true,
      value: {
        pending: MIGRATIONS.filter((migration) => !recorded.has(migration.id)).map((m) => m.id),
        applied: [...recorded.keys()].sort(),
      },
    };
  } catch (error) {
    return fail("SQLITE_FAILURE", String((error as Error).message));
  }
}

// Additive and reentrant: each step runs in its own transaction and is recorded,
// so an interrupted run can be replayed without half-upgrading.
export function applyMigrations(
  db: DatabaseSync,
  plan: MigrationPlan,
): Result<readonly string[], StorageError> {
  const insert = db.prepare(
    `INSERT INTO ${MIGRATION_TABLE} (id, sql_sha256, applied_at) VALUES (?, ?, ?)`,
  );
  const done: string[] = [];
  for (const migration of MIGRATIONS) {
    if (!plan.pending.includes(migration.id)) continue;
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(migration.sql);
      insert.run(migration.id, checksum(migration.sql), nowInstant());
      db.exec("COMMIT");
      done.push(migration.id);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction is already gone; the recorded failure is authoritative.
      }
      return fail("MIGRATION_FAILED", `${migration.id}: ${String((error as Error).message)}`);
    }
  }
  return { ok: true, value: done };
}

// Only a database that carries every migration this build knows counts as
// current; a partially migrated file reports 0 rather than the local version.
export function currentSchemaVersion(db: DatabaseSync): number {
  const plan = planMigrations(db);
  if (!plan.ok) return 0;
  return plan.value.pending.length === 0 ? SCHEMA_VERSION : 0;
}

export type BackupFile = { file: string; bytes: number };

// A copy of a live `.db` file is not a backup (D23, A12), so the consistent
// snapshot statement is used. Existing recovery points are never deleted before
// the new one exists: the only removed path is this call's own temporary file.
export async function consistentBackup(
  db: DatabaseSync,
  dataDir: string,
): Promise<Result<BackupFile, StorageError>> {
  const dir = path.join(dataDir, BACKUP_DIR);
  const stamp = nowInstant().replace(/[:.]/g, "-");
  const temp = path.join(dir, `workbench-${stamp}.db.tmp`);
  const final = path.join(dir, `workbench-${stamp}.db`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await rm(temp, { force: true });
    db.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
    const info = await stat(temp);
    if (info.size === 0) {
      await rm(temp, { force: true });
      return fail("BACKUP_FAILED", "snapshot came out empty");
    }
    await rename(temp, final);
    const written = await stat(final);
    return { ok: true, value: { file: final, bytes: written.size } };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    return fail("BACKUP_FAILED", String((error as Error).message));
  }
}

export async function writeFileFsync(file: string, data: Uint8Array | string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(data, typeof data === "string" ? "utf8" : undefined);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

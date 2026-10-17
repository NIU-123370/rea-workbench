import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Err, Result } from "../../domain/result.ts";
import { nowInstant } from "../../domain/identity.ts";
import { KNOWN_MIGRATION_IDS, MIGRATIONS, SCHEMA_VERSION } from "./migrations.ts";
import type { Migration } from "./migrations.ts";

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
  // The two halves of a backup did not agree, or the snapshot cannot be opened at all
  // (D23 / A12: a manifest that names a missing artifact is not restorable).
  | "BACKUP_INCOMPLETE"
  | "BACKUP_UNVERIFIABLE"
  // This build refuses to restore a database it does not understand (D23).
  | "RESTORE_SCHEMA_INCOMPATIBLE"
  | "SQLITE_FAILURE";

export type StorageError = { code: StorageErrorCode; message: string };

function fail(code: StorageErrorCode, message: string): Err<StorageError> {
  return { ok: false, error: { code, message } };
}

// Exported because `npm run db:migrate` shows the operator this exact digest before they approve,
// and a plan display computed elsewhere would be a number that cannot be compared with the
// `schema_migrations` row the runner writes.
export function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export type OwnedLock = {
  readonly dataDir: string;
  readonly lockPath: string;
  release: () => Promise<void>;
};

// The lock is created with O_EXCL and records this pid. A second worker may take that file over
// only when it can *show* the recorded holder is not a running process (issue #72): a worker that
// dies from SIGKILL never reaches `release()`, and without this the data directory would be
// unopenable until an operator deleted a file the workbench itself wrote.
//
// The proof is a signal-free `kill(pid, 0)`. Two hazards are accepted and named rather than
// papered over: a pid can be recycled by an unrelated process (the check then says "alive" and the
// second worker refuses - the conservative direction), and a holder that never got as far as
// writing its pid leaves a file nobody can identify (also refused - stealing a lock whose owner is
// unknown is exactly the multi-writer risk §2 forbids).
export function lockHolderState(text: string, probe: (pid: number) => "alive" | "dead" = pidAlive): "alive" | "dead" | "unknown" {
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  return probe(pid);
}

function pidAlive(pid: number): "alive" | "dead" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    // A process we may not signal is still a process; only "no such process" means dead.
    return (error as NodeJS.ErrnoException).code === "EPERM" ? "alive" : "dead";
  }
}

export async function acquireWorkerLock(dataDir: string): Promise<Result<OwnedLock, StorageError>> {
  if (!existsSync(dataDir)) {
    return fail("DATA_DIR_MISSING", `data directory ${dataDir} must exist and be chosen explicitly`);
  }
  const lockPath = path.join(dataDir, LOCK_FILE);
  // Two starters that both find the same dead holder both unlink and both retry; O_EXCL makes the
  // retry exactly-once, so the second one is refused by the file system rather than by a guess.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const created = await tryCreateLock(lockPath, attempt === 1);
    if (created !== null) return created;
  }
  // Unreachable: the loop returns on every outcome. Kept for the type checker's benefit.
  return fail("SQLITE_FAILURE", `could not decide the lock at ${lockPath}`);
}

// A null return means "create it again": the holder is provably dead and this is the first attempt.
async function tryCreateLock(lockPath: string, isRetry: boolean): Promise<Result<OwnedLock, StorageError> | null> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      return fail("SQLITE_FAILURE", `cannot create ${lockPath}: ${String(code ?? error)}`);
    }
    const holder = await readFile(lockPath, "utf8").catch(() => "");
    const state = lockHolderState(holder);
    if (state === "unknown") {
      return fail("DATA_DIR_LOCKED", `${lockPath} names no readable holder pid - nothing will be taken over without a proof`);
    }
    if (state === "alive" || isRetry) {
      return fail("DATA_DIR_LOCKED", `another worker holds ${lockPath} (pid ${holder.trim()})`);
    }
    try {
      await rm(lockPath, { force: true });
    } catch (removal) {
      return fail("DATA_DIR_LOCKED", `the stale holder in ${lockPath} is gone but the file could not be removed: ${String((removal as NodeJS.ErrnoException).code ?? removal)}`);
    }
    return null;
  }
  await handle.writeFile(`${process.pid}\n`, "utf8");
  await handle.sync();
  await handle.close();
  return {
    ok: true,
    value: {
      dataDir: path.dirname(lockPath),
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
  // Injectable so a test can hand the runner a migration that violates the schema and see
  // whether the pre-commit integrity check catches it. Nothing outside a test passes this.
  steps: readonly Migration[] = MIGRATIONS,
): Result<readonly string[], StorageError> {
  const insert = db.prepare(
    `INSERT INTO ${MIGRATION_TABLE} (id, sql_sha256, applied_at) VALUES (?, ?, ?)`,
  );
  const done: string[] = [];
  for (const migration of steps) {
    if (!plan.pending.includes(migration.id)) continue;
    // A rebuild needs enforcement off *before* the transaction opens, because SQLite
    // ignores a pragma issued inside one. The transaction still wraps the whole rebuild,
    // and the schema is checked for dangling references before it commits, so turning
    // enforcement off cannot leave a half-upgraded database (D23).
    if (migration.deferForeignKeys === true) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(migration.sql);
      const broken = db.prepare("PRAGMA foreign_key_check").all() as { sqlite_err?: string }[];
      if (broken.length > 0) {
        throw new Error(`foreign_key_check found ${String(broken.length)} dangling reference(s)`);
      }
      insert.run(migration.id, checksum(migration.sql), nowInstant());
      db.exec("COMMIT");
      done.push(migration.id);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction is already gone; the recorded failure is authoritative.
      }
      db.exec("PRAGMA foreign_keys = ON");
      return fail("MIGRATION_FAILED", `${migration.id}: ${String((error as Error).message)}`);
    }
    db.exec("PRAGMA foreign_keys = ON");
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

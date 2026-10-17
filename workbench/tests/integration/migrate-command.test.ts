import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireWorkerLock, checksum,
  applyMigrations,
  openWriteConnection,
  planMigrations,
  MIGRATION_TABLE,
} from "../../packages/adapters/storage/database.ts";
import { MIGRATIONS } from "../../packages/adapters/storage/migrations.ts";
import { main, MIGRATE_APPROVAL_FLAG, runMigrate } from "../../apps/worker/migrate.ts";

// `npm run db:migrate`, the operator-facing half TESTPLAN §5 names together with its protocol:
// show the changes, get approval, take a consistency backup, only then migrate. The order is
// what is being tested - a command that backs up after applying, or that applies without asking,
// would answer the same way on a happy path and be wrong on the one that matters.

let root: string;
const held: { release: () => Promise<void> }[] = [];
const heldDb: DatabaseSync[] = [];

// A database that has taken the first `through` migrations and no further ones, which is the
// only state in which this command has something to say.
async function partiallyMigrated(through: number): Promise<DatabaseSync> {
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  const db = opened.value.db;
  const plan = planMigrations(db);
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  const applied = applyMigrations(db, plan.value, MIGRATIONS.slice(0, through));
  if (!applied.ok) throw new Error(JSON.stringify(applied.error));
  heldDb.push(db);
  return db;
}

async function backupsPresent(): Promise<string[]> {
  const dir = path.join(root, "backups");
  return await readdir(dir).catch(() => []);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-migrate-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const db of heldDb.splice(0)) db.close();
  for (const lock of held.splice(0)) await lock.release();
  await rm(root, { recursive: true, force: true });
});

describe("the review-before-migrate half of the protocol", () => {
  it("shows the pending migrations and touches nothing without approval", async () => {
    await partiallyMigrated(2);
    const outcome = await runMigrate(root, { approved: false });
    if (outcome.kind !== "plan-only") throw new Error(`expected plan-only, got ${outcome.kind}`);
    expect(outcome.plan.pending.map((step) => step.id)).toEqual(MIGRATIONS.slice(2).map((m) => m.id));
    // The digest on a plan line must be the digest the runner will record, not merely a hex
    // string of the right length: compared against the recorded row for already-applied ids and
    // against `checksum` for pending ones, so a CLI-side reimplementation cannot pass.
    const db = openWriteConnection(root);
    if (!db.ok) throw new Error(JSON.stringify(db.error));
    heldDb.push(db.value.db);
    const recorded = new Map(
      (db.value.db.prepare(`SELECT id, sql_sha256 FROM ${MIGRATION_TABLE}`).all() as { id: string; sql_sha256: string }[])
        .map((row) => [row.id, row.sql_sha256]),
    );
    for (const step of outcome.plan.applied) expect(step.sqlSha256).toBe(recorded.get(step.id));
    for (const step of outcome.plan.pending) {
      expect(step.sqlSha256).toBe(checksum(MIGRATIONS.find((entry) => entry.id === step.id)?.sql ?? ""));
    }
    expect(recorded.size).toBe(2);
    expect(await backupsPresent()).toEqual([]);
  });

  it("is up to date when there is nothing pending, and takes no backup for that", async () => {
    await partiallyMigrated(MIGRATIONS.length);
    const outcome = await runMigrate(root, { approved: true });
    expect(outcome).toEqual({ kind: "up-to-date", appliedCount: MIGRATIONS.length });
    expect(await backupsPresent()).toEqual([]);
  });

  it("backs up before applying, and finishes with an empty pending set", async () => {
    await partiallyMigrated(2);
    const outcome = await runMigrate(root, { approved: true });
    if (outcome.kind !== "applied") throw new Error(`expected applied, got ${outcome.kind}`);
    expect(outcome.applied).toEqual(MIGRATIONS.slice(2).map((m) => m.id));
    const files = await backupsPresent();
    expect(files.length).toBe(1);
    expect(outcome.backupFile.endsWith(files[0] ?? "")).toBe(true);
    // The snapshot is what an operator rolls back *to*, so it has to describe the database as it
    // was before the first migration statement ran. Inside this process a backup taken after a
    // rolled-back failure looks identical, which is why this assertion is the one that proves the
    // order: `test_vectors` is created by 0003-delivery, the first migration this run applies.
    const snapshot = new DatabaseSync(outcome.backupFile, { readOnly: true });
    const inSnapshot = new Set(
      (snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name),
    );
    snapshot.close();
    const reopened = openWriteConnection(root);
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    heldDb.push(reopened.value.db);
    const inLive = new Set(
      (reopened.value.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name),
    );
    expect(inSnapshot.has("test_vectors")).toBe(false);
    expect(inLive.has("test_vectors")).toBe(true);
    expect(inSnapshot.has("evidence_records")).toBe(true); // 0002 was already applied: the copy is not empty
  });

  it("keeps the backup it took when a migration fails, and the failed step is not recorded", async () => {
    await partiallyMigrated(2);
    const broken = MIGRATIONS.map((step, index) =>
      index === 2 ? { ...step, sql: `${step.sql}; SELECT no_such_column FROM definitely_not_here;` } : step,
    );
    const outcome = await runMigrate(root, { approved: true, steps: broken });
    if (outcome.kind !== "refused") throw new Error(`expected refused, got ${outcome.kind}`);
    expect(outcome.reason).toBe("migration-apply-failed");
    expect(outcome.code).toBe("MIGRATION_FAILED");
    // This is the case the ordering exists for: the failure happens after the backup, so the
    // operator is told what to roll back to rather than left with a half-migrated database and
    // no copy of the old one.
    expect(outcome.backupFile).not.toBeNull();
    expect(await backupsPresent()).toHaveLength(1);
    const reopened = openWriteConnection(root);
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    heldDb.push(reopened.value.db);
    const plan = planMigrations(reopened.value.db);
    if (!plan.ok) throw new Error(JSON.stringify(plan.error));
    expect(plan.value.applied).toEqual(MIGRATIONS.slice(0, 2).map((m) => m.id));
  });

  it("refuses while a live worker holds the lock, before opening the database", async () => {
    await partiallyMigrated(1);
    const lock = await acquireWorkerLock(root);
    if (!lock.ok) throw new Error(JSON.stringify(lock.error));
    held.push(lock.value);
    const outcome = await runMigrate(root, { approved: true });
    if (outcome.kind !== "refused") throw new Error(`expected refused, got ${outcome.kind}`);
    expect(outcome.reason).toBe("worker-lock-held");
    expect(await backupsPresent()).toEqual([]);
  });
});

describe("the command line's own answers", () => {
  function captureStdout(): string[] {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    return lines;
  }

  it("asks for a data directory instead of guessing one", async () => {
    const lines = captureStdout();
    vi.stubEnv("WB_DATA_DIR", "");
    expect(await main([])).toBe(64);
    expect(lines.join("")).toContain("WB_DATA_DIR=<data dir> npm run db:migrate");
  });

  it("exits 2 for a plan it was not allowed to apply, and prints every pending id", async () => {
    await partiallyMigrated(2);
    const lines = captureStdout();
    vi.stubEnv("WB_DATA_DIR", root);
    expect(await main([])).toBe(2);
    const text = lines.join("");
    expect(text).toContain("approval-required");
    for (const migration of MIGRATIONS.slice(2)) expect(text).toContain(`pending ${migration.id} `);
    expect(text).toContain("nothing was backed up and nothing was applied");
  });

  it("exits 0 once the schema is current, and 0 after a completed migration", async () => {
    await partiallyMigrated(2);
    const lines = captureStdout();
    vi.stubEnv("WB_DATA_DIR", root);
    expect(await main([])).toBe(2);
    expect(await main([MIGRATE_APPROVAL_FLAG])).toBe(0);
    expect(await main([MIGRATE_APPROVAL_FLAG])).toBe(0);
    expect(lines.join("")).toContain("up-to-date");
  });
});

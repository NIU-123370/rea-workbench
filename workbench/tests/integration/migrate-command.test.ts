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
import { MIGRATIONS, migrationTargets } from "../../packages/adapters/storage/migrations.ts";
import { main, MIGRATE_APPROVAL_FLAG, planLineOf, runMigrate } from "../../apps/worker/migrate.ts";

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

function captureStdout(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

// The schema as SQLite sees it: every object a migration statement can create, keyed by type and
// name, holding the text that defines it. Automatic (constraint) indexes carry no SQL and are left
// out - they belong to their table, and the table's own definition is what a rebuild changes.
function schemaObjects(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index')")
    .all() as { type: string; name: string; sql: string | null }[];
  const seen = new Map<string, string>();
  for (const row of rows) {
    if (row.sql === null) continue;
    seen.set(`${row.type}:${row.name}`, row.sql);
  }
  return seen;
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
    (row) => row.name,
  );
}

// Which table owns an index, asked of SQLite rather than read out of the index's own SQL text: the
// witness has to be able to disagree with the parser it is checking.
function indexesOn(db: DatabaseSync, table: string): string[] {
  return (db.prepare("SELECT name FROM pragma_index_list(?)").all(table) as { name: string }[]).map((row) => row.name);
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

// #123's first box: a plan an operator can actually approve. §5 makes approval the gate before a
// schema change, and an id plus a digest is not a description of a change - so each pending line also
// names the tables its SQL touches. The three cases below cover the three ways that claim can be
// false: the list never reaches the terminal, the list disagrees with the schema, or the list is
// quietly shorter than the SQL.
describe("the target table half of the plan line", () => {
  it("carries a table list onto every pending line, including an index-only migration", async () => {
    await partiallyMigrated(2);
    const lines = captureStdout();
    vi.stubEnv("WB_DATA_DIR", root);
    expect(await main([])).toBe(2);
    const pending = lines.join("").split("\n").filter((line) => line.startsWith("pending "));
    expect(pending.length).toBe(MIGRATIONS.length - 2);
    // Shape, not content: a line whose list vanished, or whose digest is no longer the 64 hex
    // characters `schema_migrations` will hold, fails here.
    for (const line of pending) {
      expect(line).toMatch(/^pending [0-9a-z-]+ sql_sha256=[0-9a-f]{64} tables=[a-z_][a-z0-9_]*(?:,[a-z_][a-z0-9_]*)*$/u);
    }
    // 0007 contains no table statement at all - only `CREATE INDEX ... ON test_vectors` - so this
    // line can read as it does only if the index's table is followed. An operator approving "a change
    // to test_vectors" and getting an unnamed index change is the gap this closes.
    expect(pending.join("\n")).toMatch(/^pending 0007-vectors-target-keyset sql_sha256=[0-9a-f]{64} tables=test_vectors$/mu);
  });

  it("names every table the migration really changed, read back out of the schema", () => {
    const opened = openWriteConnection(root);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const db = opened.value.db;
    heldDb.push(db);
    // One migration at a time, with `sqlite_master` diffed across each as the witness. The direction
    // proved is the one that can fail silently: a statement form `migrationTargets` does not cover
    // leaves a table the migration changed off the line the operator approved.
    // The other direction is deliberately not asserted - a rebuild names an intermediate table that
    // exists only inside its own transaction (0005 lists `artifacts_new`, which does not survive),
    // and no snapshot taken after a run can show a name the run renamed away.
    for (const migration of MIGRATIONS) {
      const planned = planMigrations(db);
      if (!planned.ok) throw new Error(JSON.stringify(planned.error));
      const before = schemaObjects(db);
      const applied = applyMigrations(db, planned.value, [migration]);
      if (!applied.ok) throw new Error(`${migration.id}: ${JSON.stringify(applied.error)}`);
      expect(applied.value).toEqual([migration.id]);
      const after = schemaObjects(db);
      const changed = new Set<string>();
      for (const [key, sql] of after) {
        if (!key.startsWith("table:")) continue;
        const name = key.slice("table:".length);
        // SQLite's own bookkeeping tables - `sqlite_sequence` appears the first time a migration
        // uses `AUTOINCREMENT` (0004 does, twice) - are a consequence of a column declaration, not
        // a table any statement names. The plan line lists the tables a migration declares, which is
        // the boundary this test enforces rather than papers over.
        if (name.startsWith("sqlite_")) continue;
        if (before.get(key) !== sql) changed.add(name);
      }
      for (const [key] of after) {
        if (!key.startsWith("index:") || before.has(key)) continue;
        for (const table of tableNames(db)) {
          if (indexesOn(db, table).includes(key.slice("index:".length))) changed.add(table);
        }
      }
      // Every shipped migration leaves a trace: without this the loop below could pass by having
      // nothing to say about a migration that changed no visible object.
      expect(changed.size, `${migration.id} left no trace in sqlite_master`).toBeGreaterThan(0);
      const targets = migrationTargets(migration.sql);
      for (const table of changed) {
        expect(targets, `${migration.id} changed ${table} but its plan line does not name it`).toContain(table);
      }
      expect(targets).toEqual([...new Set(targets)].sort());
    }
  });

  it("reads a quoted name, and prints a hole when the SQL names no table", async () => {
    await partiallyMigrated(2);
    const quoted = { id: "0003-delivery", sql: 'CREATE TABLE IF NOT EXISTS "operator_notes" (id TEXT PRIMARY KEY);' };
    const shown = await runMigrate(root, { approved: false, steps: [quoted] });
    if (shown.kind !== "plan-only") throw new Error(`expected plan-only, got ${shown.kind}`);
    const line = (id: string): string => {
      const step = shown.plan.pending.find((entry) => entry.id === id);
      if (step === undefined) throw new Error(`${id} is not pending in this fixture`);
      return planLineOf(step);
    };
    expect(line("0003-delivery")).toBe(`pending 0003-delivery sql_sha256=${checksum(quoted.sql)} tables=operator_notes`);
    // The remaining ids are pending but carry no step in this list, and 0003 with a step that names
    // no table both print the hole rather than dropping the line or inventing a table. A plan that
    // said nothing would read the same as a migration that changes nothing.
    for (const id of ["0004-events-audit", "0005-artifact-export-class", "0006-jobs-project-created", "0007-vectors-target-keyset"]) {
      expect(line(id)).toContain("sql_sha256=not-in-this-build tables=none-detected");
    }
    const opaque = await runMigrate(root, { approved: false, steps: [{ id: "0003-delivery", sql: "SELECT 1;" }] });
    if (opaque.kind !== "plan-only") throw new Error(`expected plan-only, got ${opaque.kind}`);
    const opaqueStep = opaque.plan.pending.find((entry) => entry.id === "0003-delivery");
    if (opaqueStep === undefined) throw new Error("0003-delivery is not pending in this fixture");
    expect(planLineOf(opaqueStep)).toBe(`pending 0003-delivery sql_sha256=${checksum("SELECT 1;")} tables=none-detected`);
  });

  it("follows the two statement forms no shipped migration can prove", async () => {
    await partiallyMigrated(2);
    // The shipped list has one index-only migration (0006) and one rebuild (0005), and 0005's ALTER
    // TABLE and INSERT both name the intermediate table its own CREATE TABLE already names. So no
    // migration in this build can show that the ALTER and INSERT patterns work - and the next
    // additive migration is very likely an ALTER. A plan line that quietly names nothing is the
    // failure this command exists to avoid, so both forms are driven through the real renderer here.
    const cases = [
      { id: "0006-jobs-project-created", sql: "ALTER TABLE jobs ADD COLUMN note TEXT;", want: "jobs" },
      { id: "0004-events-audit", sql: "INSERT INTO exports (id) SELECT id FROM events;", want: "exports" },
    ];
    for (const one of cases) {
      const shown = await runMigrate(root, { approved: false, steps: [one] });
      if (shown.kind !== "plan-only") throw new Error(`expected plan-only, got ${shown.kind}`);
      const step = shown.plan.pending.find((entry) => entry.id === one.id);
      if (step === undefined) throw new Error(`${one.id} is not pending in this fixture`);
      expect(planLineOf(step)).toBe(`pending ${one.id} sql_sha256=${checksum(one.sql)} tables=${one.want}`);
    }
  });

  it("records the digest it showed when the SQL it was handed is not the built-in one", async () => {
    await partiallyMigrated(2);
    // A step whose SQL is plainly not the shipped 0003: it creates one table nobody else creates. So
    // a displayed list of `plain_notes` and a displayed digest of this text can only have come from
    // the step the caller handed over - keying the display back to the built-in array fails both.
    const noted = { id: "0003-delivery", sql: "CREATE TABLE plain_notes (id TEXT PRIMARY KEY);" };
    const preview = await runMigrate(root, { approved: false, steps: [noted] });
    if (preview.kind !== "plan-only") throw new Error(`expected plan-only, got ${preview.kind}`);
    const shown = preview.plan.pending.find((entry) => entry.id === "0003-delivery");
    if (shown === undefined) throw new Error("0003-delivery is not pending in this fixture");
    expect(planLineOf(shown)).toBe(`pending 0003-delivery sql_sha256=${checksum(noted.sql)} tables=plain_notes`);

    const ran = await runMigrate(root, { approved: true, steps: [noted] });
    if (ran.kind !== "applied") throw new Error(`expected applied, got ${ran.kind}`);
    expect(ran.applied).toEqual(["0003-delivery"]);
    const reopened = openWriteConnection(root);
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    heldDb.push(reopened.value.db);
    const recorded = (reopened.value.db
      .prepare(`SELECT sql_sha256 FROM ${MIGRATION_TABLE} WHERE id = '0003-delivery'`)
      .all() as { sql_sha256: string }[])[0];
    if (recorded === undefined) throw new Error("0003-delivery was not recorded");
    // The line the operator read and the row the runner wrote are the same number, or the approval
    // was given for a digest nobody can point at afterwards.
    expect(recorded.sql_sha256).toBe(shown.sqlSha256);
  });
});

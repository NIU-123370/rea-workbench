import path from "node:path";

import {
  acquireWorkerLock,
  applyMigrations,
  checksum,
  consistentBackup,
  openWriteConnection,
  planMigrations,
} from "../../packages/adapters/storage/database.ts";
import { MIGRATIONS, migrationTargets } from "../../packages/adapters/storage/migrations.ts";
import type { Migration } from "../../packages/adapters/storage/migrations.ts";

// `npm run db:migrate` - TESTPLAN §5 names this command and names its protocol in the same
// breath: 「`db:migrate` 必须在先展示变更并获得操作批准、完成一致性备份后执行」. So the order in
// `runMigrate` *is* the feature: show the plan, stop for approval, take the consistency backup,
// and only then touch the schema. A run that fails mid-apply still has the backup it took first,
// which is the whole point of putting the backup before the migration.
//
// The worker's own boot still applies migrations automatically - a worker cannot run on a schema
// it has not seen. This command is the other half: the operator gets to review a schema change
// *before* it happens, which is what #6's fourth condition asked for and did not have. Both
// halves share `planMigrations`/`applyMigrations`, so "what a migration is" and "a rewritten
// historical migration is refused" stay single-owner rules.

export const MIGRATE_APPROVAL_FLAG = "--approve";

export type MigrationStep = { id: string; sqlSha256: string; tables: readonly string[] };

export type MigratePlanView = {
  pending: readonly MigrationStep[];
  applied: readonly MigrationStep[];
};

export type MigrateOutcome =
  | { kind: "plan-only"; plan: MigratePlanView }
  | { kind: "up-to-date"; appliedCount: number }
  | {
      kind: "applied";
      plan: MigratePlanView;
      backupFile: string;
      applied: readonly string[];
    }
  | { kind: "refused"; code: string; reason: string; backupFile: string | null };

// The digest and the table list on a plan line both describe the SQL the runner is about to
// execute, not the SQL this file happens to know: `applyMigrations` records the checksum of the step
// it is *handed*, and `runMigrate` accepts an injected step list, so keying the display off the
// built-in array would let an operator approve one digest and have a different one recorded.
// `checksum` is imported from the storage module for the same reason - a reimplementation here could
// not be compared against `schema_migrations`.
function stepOf(id: string, steps: readonly Migration[]): MigrationStep {
  const migration = steps.find((entry) => entry.id === id);
  // `planMigrations` already refuses a recorded id this build does not know, so the only way to
  // reach the empty side is a step list that omits an id the plan still counts as pending. Saying
  // so beats inventing a digest or a table list for a migration nobody is about to run.
  return {
    id,
    sqlSha256: migration === undefined ? "not-in-this-build" : checksum(migration.sql),
    tables: migration === undefined ? [] : migrationTargets(migration.sql),
  };
}

export async function runMigrate(
  dataDir: string,
  opts: { approved: boolean; steps?: readonly Migration[] },
): Promise<MigrateOutcome> {
  const lock = await acquireWorkerLock(dataDir);
  if (!lock.ok) return { kind: "refused", code: lock.error.code, reason: "worker-lock-held", backupFile: null };
  const held = lock.value;
  try {
    const opened = openWriteConnection(dataDir);
    if (!opened.ok) {
      return { kind: "refused", code: opened.error.code, reason: "database-unopenable", backupFile: null };
    }
    const db = opened.value.db;
    try {
      const planned = planMigrations(db);
      if (!planned.ok) {
        // `planMigrations` is where a rewritten historical migration is caught. Refusing here
        // means the operator learns it before anything is written, not after a backup.
        return { kind: "refused", code: planned.error.code, reason: "migration-history-refused", backupFile: null };
      }
      const plan = planned.value;
      if (plan.pending.length === 0) return { kind: "up-to-date", appliedCount: plan.applied.length };
      // One list for both halves: the steps shown for approval are the steps handed to the runner.
      const steps = opts.steps ?? MIGRATIONS;
      const view: MigratePlanView = {
        pending: plan.pending.map((id) => stepOf(id, steps)),
        applied: plan.applied.map((id) => stepOf(id, steps)),
      };
      if (!opts.approved) return { kind: "plan-only", plan: view };

      const backup = await consistentBackup(db, dataDir);
      if (!backup.ok) {
        return { kind: "refused", code: backup.error.code, reason: "backup-before-migration-failed", backupFile: null };
      }
      const applied = applyMigrations(db, plan, steps);
      if (!applied.ok) {
        // The backup is named even in the failure: it is the thing the operator can roll back to.
        return { kind: "refused", code: applied.error.code, reason: "migration-apply-failed", backupFile: backup.value.file };
      }
      // No "what is still pending" report here on purpose: `applyMigrations` returning ok is
      // already the statement that every pending id was applied (anything else is the refused
      // arm), so re-planning to print 0 would be a number that cannot disagree with anything.
      return { kind: "applied", plan: view, backupFile: backup.value.file, applied: applied.value };
    } finally {
      db.close();
    }
  } finally {
    await held.release();
  }
}

// The one place a pending step becomes a line an operator reads. `none-detected` is a claim about
// this command's own coverage, not about the migration: the patterns found no table in that SQL, and
// the line is still printed, so a plan with a hole in it shows a hole.
export function planLineOf(step: MigrationStep): string {
  return `pending ${step.id} sql_sha256=${step.sqlSha256} tables=${step.tables.length === 0 ? "none-detected" : step.tables.join(",")}`;
}

const USAGE = [
  "usage:",
  "  WB_DATA_DIR=<data dir> npm run db:migrate             # show the plan, change nothing",
  `  WB_DATA_DIR=<data dir> npm run db:migrate -- ${MIGRATE_APPROVAL_FLAG}`,
  "takes the worker's exclusive lock: stop the worker first.",
  "with approval, a consistency backup is taken before any migration is applied.",
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
  const outcome = await runMigrate(dataDir, { approved: argv.includes(MIGRATE_APPROVAL_FLAG) });
  switch (outcome.kind) {
    case "plan-only": {
      for (const step of outcome.plan.pending) log(planLineOf(step));
      log(`already-applied=${String(outcome.plan.applied.length)} pending=${String(outcome.plan.pending.length)} migrations-in-this-build=${String(MIGRATIONS.length)}`);
      log("approval-required: nothing was backed up and nothing was applied");
      // 2, not 0 and not 1: "you asked to see it, and you did" is neither a success nor a
      // failure. A caller that reads 0 as "migrated" must not be able to read this as one.
      return 2;
    }
    case "up-to-date": {
      log(`up-to-date already-applied=${String(outcome.appliedCount)} pending=0`);
      return 0;
    }
    case "applied": {
      log(`backed-up ${path.basename(outcome.backupFile)}`);
      for (const id of outcome.applied) log(`applied ${id}`);
      log(`migrated count=${String(outcome.applied.length)} of=${String(outcome.plan.pending.length)}`);
      return 0;
    }
    case "refused": {
      log(`migrate-refused ${outcome.code}:${outcome.reason}`);
      if (outcome.backupFile !== null) log(`  backup taken before the failure: ${path.basename(outcome.backupFile)}`);
      return 1;
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

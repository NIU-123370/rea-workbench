import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireWorkerLock, applyMigrations, openWriteConnection, planMigrations } from "../../packages/adapters/storage/database.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { commitWithAudit, enforceDeny, readAudit } from "../../packages/application/audit.ts";
import type { AuditRow, JobRow } from "../../packages/application/ports.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";

// DESIGN §12.2 / D29: business change and audit commit together, a failed audit
// write blocks the change, and a denial stands even when the audit store cannot
// be written.

const HEX = ("c" as const).repeat(64) as Digest;
let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let projectId: ReturnType<typeof newId>;
let heldLock: { release: () => Promise<void> } | null = null;

function auditEntry(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    projectId,
    actorId: "reviewer-local",
    actorKind: "local-operator",
    action: "vector.review",
    resourceType: "test_vector",
    resourceId: null,
    decision: "allow",
    reasonCode: "approved",
    safeMetadataJson: { revision: 3, caseCount: 2 },
    createdAt: nowInstant(),
    ...overrides,
  };
}

function jobRow(idempotencyKey: string): JobRow {
  const at = nowInstant();
  return {
    id: newId(),
    projectId,
    targetId: null,
    kind: "inspect",
    state: "queued",
    cleanupState: "pending",
    inputJson: { kind: "inspect", claimIds: [] },
    resultRef: null,
    errorJson: null,
    idempotencyKey,
    requestDigest: HEX,
    deadlineAt: null,
    retryAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-audit-"));
  const lock = await acquireWorkerLock(root);
  if (!lock.ok) throw new Error(JSON.stringify(lock.error));
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  db = opened.value.db;
  writer = new SqliteStorageWriter(db);
  const plan = planMigrations(db);
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  applyMigrations(db, plan.value);
  projectId = newId();
  const created = writer.transact((tx) =>
    tx.insertProject({
      id: projectId,
      name: "audit",
      createdAt: nowInstant(),
      graphRevision: 0,
      inventoryRevision: 0,
      schemaVersion: 1,
    }),
  );
  expect(created.ok).toBe(true);
  heldLock = lock.value;
});

afterAll(async () => {
  db.close();
  await heldLock?.release();
  heldLock = null;
  await rm(root, { recursive: true, force: true });
});

function countAudit(): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM audit_entries").get() as { n: number }).n);
}

function countJobs(): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n);
}

describe("audit and change share one transaction", () => {
  it("commits the change and its record together", () => {
    const before = countAudit();
    const job = jobRow("audit-ok");
    const result = commitWithAudit(writer, auditEntry({ resourceId: job.id }), (tx) => tx.insertJob(job));
    expect(result.ok).toBe(true);
    expect(countJobs()).toBe(1);
    expect(countAudit()).toBe(before + 1);
    if (!result.ok) return;
    expect(result.value.auditSeq).toBeGreaterThan(0);
    expect(result.value.auditSeq).toBeTypeOf("number");
  });

  it("does not let a change survive an audit write failure", () => {
    const jobsBefore = countJobs();
    const auditBefore = countAudit();
    // A missing project for the audit row is the injected fault: the FK on
    // audit_entries.project_id fires after the business row was inserted.
    const result = commitWithAudit(
      writer,
      auditEntry({ projectId: newId() }),
      (tx) => tx.insertJob(jobRow("audit-fail")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FK_VIOLATION");
    expect(countJobs()).toBe(jobsBefore);
    expect(countAudit()).toBe(auditBefore);
  });

  it("enforces a denial even when it cannot be journaled", () => {
    const recorded = enforceDeny(writer, auditEntry({ decision: "deny", reasonCode: "ACCESS_DENIED" }));
    expect(recorded).toMatchObject({ decision: "deny", reasonCode: "ACCESS_DENIED", recorded: true, degraded: false });

    const before = countAudit();
    const broken = enforceDeny(
      writer,
      auditEntry({ projectId: newId(), decision: "deny", reasonCode: "ACCESS_DENIED" }),
    );
    expect(broken.decision).toBe("deny");
    expect(broken.recorded).toBe(false);
    expect(broken.degraded).toBe(true);
    expect(countAudit()).toBe(before);
  });

  it("keeps startup and unauthenticated denials readable without a project", () => {
    writer.transact((tx) => tx.insertAudit(auditEntry({ projectId: null, action: "session.pair" })));
    const projectless = readAudit(writer, { after: 0, projectId: null, limit: 50 });
    expect(projectless.ok).toBe(true);
    if (!projectless.ok) return;
    expect(projectless.value.every((entry) => entry.projectId === null)).toBe(true);
    expect(projectless.value.some((entry) => entry.action === "session.pair")).toBe(true);

    const scoped = readAudit(writer, { after: 0, projectId, limit: 50 });
    expect(scoped.ok && scoped.value.every((entry) => entry.projectId === projectId)).toBe(true);
  });

  it("pages by seq and returns the sanitized metadata shape unchanged", () => {
    writer.transact((tx) => {
      tx.insertAudit(auditEntry({ action: "blueprint.freeze" }));
      tx.insertAudit(auditEntry({ action: "export.create" }));
    });
    const all = readAudit(writer, { after: 0, projectId, limit: 50 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const seqs = all.value.map((entry) => entry.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const page = readAudit(writer, { after: seqs[0] as number, projectId, limit: 1 });
    expect(page.ok && page.value.length).toBe(1);
    expect(page.ok && page.value[0]?.seq).toBe(seqs[1]);
    const frozen = all.value.find((entry) => entry.action === "blueprint.freeze");
    expect(frozen?.safeMetadataJson).toEqual({ revision: 3, caseCount: 2 });
    expect(frozen?.decision).toBe("allow");
  });
});

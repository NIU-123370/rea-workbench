import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireWorkerLock, applyMigrations, openWriteConnection, planMigrations } from "../../packages/adapters/storage/database.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { commitWithAudit, enforceDeny, readAudit } from "../../packages/application/audit.ts";
import { AuditReadService } from "../../packages/application/audit-read.ts";
import { AUDIT_LIST_MAX_LIMIT, auditPageSchema } from "../../packages/contracts/audit.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type { AuditPageWire } from "../../packages/contracts/audit.ts";
import type { Result } from "../../packages/domain/result.ts";
import type { AuditRow, JobRow } from "../../packages/application/ports.ts";
import { newId, nowInstant, type Id } from "../../packages/domain/identity.ts";
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

function reads(): AuditReadService {
  return new AuditReadService({ storage: writer });
}

function errorOf<T>(result: Result<T, GateFailure>): GateFailure {
  if (result.ok) throw new Error("expected a refusal, got a value");
  return result.error;
}

function unwrapAudit(result: Result<AuditPageWire, GateFailure>): AuditPageWire {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.reason}:${result.error.message}`);
  return result.value;
}

// The two §8 audit windows over the real journal (§8 lines 302-303 / issue #58).
//
// `readAudit` was the storage-side helper every test used; what it never had was a reader
// with the semantics §8 spells out: two named windows that must not overlap, an integer
// cursor that means what it says, a page bound that is refused rather than applied quietly,
// and the role gate that keeps an agent out of the record of what was decided about it.

describe("the audit reads (§8 lines 302-303)", () => {
  const reviewerActor: Actor = { actorId: "local-reviewer", actorKind: "reviewer" };
  const builderActor: Actor = { actorId: "builder-agent", actorKind: "builder" };
  const evaluatorActor: Actor = { actorId: "eval-1", actorKind: "evaluator" };

  function seedAudit(count: number, scoped: Id | null): number[] {
    const seqs: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const written = writer.transact((tx) => tx.insertAudit(auditEntry({ projectId: scoped, action: `audit-read-case-${String(index)}` })));
      if (!written.ok) throw new Error(JSON.stringify(written.error));
      seqs.push(written.value);
    }
    return seqs;
  }

  it("refuses the Builder and the evaluator from both windows, by name", () => {
    expect(errorOf(reads().listProject(projectId, builderActor, { after: null, limit: null })).reason).toBe("audit-not-for-role");
    expect(errorOf(reads().listGlobal(builderActor, { after: null, limit: null })).reason).toBe("global-audit-not-for-role");
    expect(errorOf(reads().listProject(projectId, evaluatorActor, { after: null, limit: null })).code).toBe("ACCESS_DENIED");
    // A refusal is a refusal before it is a read: nothing about the journal is revealed by
    // the difference between "no such project" and "not for you".
    expect(errorOf(reads().listGlobal(evaluatorActor, { after: null, limit: null })).code).toBe("ACCESS_DENIED");
  });

  it("answers the reviewer and the worker, which are the local-operator kinds §8 names", () => {
    const systemActor: Actor = { actorId: "worker", actorKind: "system" };
    expect(auditPageSchema.safeParse(unwrapAudit(reads().listProject(projectId, reviewerActor, { after: null, limit: null }))).success).toBe(true);
    expect(unwrapAudit(reads().listGlobal(systemActor, { after: null, limit: null })).entries).toBeInstanceOf(Array);
  });

  it("keeps the project window and the unrooted window from reading each other's rows", () => {
    const mine = seedAudit(3, projectId);
    const projectless = seedAudit(2, null);
    const scoped = unwrapAudit(reads().listProject(projectId, reviewerActor, { after: 0, limit: AUDIT_LIST_MAX_LIMIT }));
    const global = unwrapAudit(reads().listGlobal(reviewerActor, { after: 0, limit: AUDIT_LIST_MAX_LIMIT }));
    expect(scoped.entries.every((entry) => entry.projectId === projectId)).toBe(true);
    expect(scoped.entries.map((entry) => entry.seq)).toEqual(expect.arrayContaining(mine));
    expect(global.entries.every((entry) => entry.projectId === null)).toBe(true);
    expect(global.entries.map((entry) => entry.seq)).toEqual(expect.arrayContaining(projectless));
    // Not one row is in both windows: the split is the two selectors, not a filter a caller
    // may forget to apply.
    const overlap = scoped.entries.map((entry) => entry.seq).filter((seq) => global.entries.some((entry) => entry.seq === seq));
    expect(overlap).toEqual([]);
  });

  it("pages by the integer cursor it hands back, without repeating or losing a row", () => {
    seedAudit(5, projectId);
    const seen: number[] = [];
    let after: number | null = 0;
    let pages = 0;
    for (;;) {
      pages += 1;
      const page = unwrapAudit(reads().listProject(projectId, reviewerActor, { after, limit: 2 }));
      seen.push(...page.entries.map((entry) => entry.seq));
      if (page.nextCursor === null) break;
      after = page.nextCursor;
      if (pages > 200) throw new Error("the journal page never ended");
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort((left, right) => left - right));
    const whole = unwrapAudit(reads().listProject(projectId, reviewerActor, { after: null, limit: AUDIT_LIST_MAX_LIMIT }));
    expect(seen.sort((left, right) => left - right)).toEqual(whole.entries.map((entry) => entry.seq).sort((left, right) => left - right));
  });

  it("hands back a cursor only when a row actually follows the page", () => {
    // A page that comes out exactly full is not evidence that more exists. Without this the
    // loop-based tests pass whether or not the last page lies, because a lying cursor still
    // terminates on the next empty read.
    seedAudit(4, projectId);
    const whole = unwrapAudit(reads().listProject(projectId, reviewerActor, { after: 0, limit: AUDIT_LIST_MAX_LIMIT }));
    const size = whole.entries.length;
    const exact = unwrapAudit(reads().listProject(projectId, reviewerActor, { after: 0, limit: size }));
    expect(exact.entries.length).toBe(size);
    expect(exact.nextCursor).toBeNull();
    const short = unwrapAudit(reads().listProject(projectId, reviewerActor, { after: 0, limit: size - 1 }));
    expect(short.entries.length).toBe(size - 1);
    expect(short.nextCursor).not.toBeNull();
    // And that cursor is the last seq it showed, so the next page starts where this one ended.
    expect(short.nextCursor).toBe((short.entries[short.entries.length - 1] as { seq: number }).seq);
  });

  it("carries the row's own resourceId to the wire, null staying null rather than a string", () => {
    const resource = newId();
    const written = writer.transact((tx) => tx.insertAudit(auditEntry({ projectId, action: "plan.review", resourceId: resource })));
    if (!written.ok) throw new Error(JSON.stringify(written.error));
    const empty = writer.transact((tx) => tx.insertAudit(auditEntry({ projectId: null, action: "session.pair", resourceId: null })));
    if (!empty.ok) throw new Error(JSON.stringify(empty.error));
    const page = unwrapAudit(reads().listProject(projectId, reviewerActor, { after: 0, limit: AUDIT_LIST_MAX_LIMIT }));
    expect(page.entries.find((entry) => entry.seq === written.value)?.resourceId).toBe(resource);
    const projectless = unwrapAudit(reads().listGlobal(reviewerActor, { after: 0, limit: AUDIT_LIST_MAX_LIMIT }));
    expect(projectless.entries.find((entry) => entry.seq === empty.value)?.resourceId).toBeNull();
  });

  it("refuses a page past the bound instead of serving a smaller one", () => {
    const refusal = errorOf(reads().listProject(projectId, reviewerActor, { after: null, limit: AUDIT_LIST_MAX_LIMIT + 1 }));
    expect(refusal.code).toBe("RESOURCE_LIMIT");
    expect(refusal.reason).toBe("audit-limit");
  });

  it("carries the sanitizer's metadata through unchanged and renames only the field", () => {
    const written = writer.transact((tx) =>
      tx.insertAudit(auditEntry({ projectId, action: "vector.review", safeMetadataJson: { revision: 3, caseCount: 12 } })),
    );
    if (!written.ok) throw new Error(JSON.stringify(written.error));
    const page = unwrapAudit(reads().listProject(projectId, reviewerActor, { after: 0, limit: AUDIT_LIST_MAX_LIMIT }));
    const entry = page.entries.find((candidate) => candidate.seq === written.value);
    expect(entry?.safeMetadata).toEqual({ revision: 3, caseCount: 12 });
    // §12.2's field list is the contract; a wire entry that drops one of them would let a
    // reader conclude nothing happened where a decision was recorded.
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "action",
      "actorId",
      "actorKind",
      "createdAt",
      "decision",
      "projectId",
      "reasonCode",
      "resourceId",
      "resourceType",
      "safeMetadata",
      "seq",
    ]);
  });
});

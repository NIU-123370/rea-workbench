import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import { asInstant, newId, nowInstant, type Id, type Instant } from "../../packages/domain/identity.ts";
import { acquireWorkerLock, applyMigrations, openWriteConnection, planMigrations } from "../../packages/adapters/storage/database.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { JobReadService, decodeJobCursor, encodeJobCursor } from "../../packages/application/job-read.ts";
import { projectJobRecord } from "../../packages/application/job-queue.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type { JobRow, LeaseRow, StoragePortError } from "../../packages/application/ports.ts";
import type { Result } from "../../packages/domain/result.ts";
import type { ApiError } from "../../packages/contracts/errors.ts";
import { JOB_LIST_MAX_LIMIT, jobPageSchema, jobRecordSchema, type JobPage } from "../../packages/contracts/jobs.ts";
import { hex } from "../support/blueprint-seed.ts";

// The job read surface against real rows (DESIGN §8 line 277, §11 / issue #55).
//
// The claim this file holds is narrow and load-bearing: a client that was never told a
// candidate id can still name one, because the job page carries each row's persisted
// resultRef, and because every row on that page is the same projection the single-job read
// returns. §8 states the second half as a rule - GET job, GET jobs and job.updated report
// the same named time fields, and 左栏不从日志推断重试时间 - so it is asserted field by
// field here rather than assumed from a shared helper.

const reviewer: Actor = { actorId: "local-reviewer", actorKind: "reviewer" };
const inspector: Actor = { actorId: "local-inspector", actorKind: "inspector" };
const system: Actor = { actorId: "worker", actorKind: "system" };
const builder: Actor = { actorId: "builder-agent", actorKind: "builder" };
const evaluator: Actor = { actorId: "eval-1", actorKind: "evaluator" };

const BASE_MS = Date.parse("2026-10-16T00:00:00Z");

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let reads: JobReadService;
let projectId: Id;
let otherProjectId: Id;
let targetId: Id;

function unwrap<T>(result: Result<T, GateFailure>): T {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.reason}:${result.error.message}`);
  return result.value;
}

function refusalOf<T>(result: Result<T, GateFailure>): GateFailure {
  if (result.ok) throw new Error("expected a refusal, got a value");
  return result.error;
}

function unwrapPort<T>(result: Result<T, StoragePortError>): T {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.message}`);
  return result.value;
}

// Timestamps the tests can reason about: whole seconds apart from a fixed base, so a page
// order never depends on the millisecond a fixture happened to run at.
function stamp(offsetSeconds: number): Instant {
  return asInstant(new Date(BASE_MS + offsetSeconds * 1000).toISOString());
}

function safeError(message: string): ApiError {
  return { code: "CAPABILITY_UNAVAILABLE", message, retryable: true, details: {}, requestId: "req-seed" };
}

function page(limit: number | null = null): JobPage {
  return unwrap(reads.list(projectId, reviewer, { cursor: null, limit: limit ?? JOB_LIST_MAX_LIMIT }));
}

let counter = 0;
function seedJob(input: { id?: Id; createdAt?: Instant; state?: JobRow["state"]; retryAt?: Instant | null; deadlineAt?: Instant | null; errorJson?: ApiError | null; resultRef?: string | null; cleanupState?: JobRow["cleanupState"] } = {}): JobRow {
  counter += 1;
  const id = (input.id ?? newId()) as Id;
  const createdAt = input.createdAt ?? stamp(counter);
  const row: JobRow = {
    projectId,
    targetId,
    kind: "build",
    state: "succeeded",
    cleanupState: "pending",
    inputJson: {},
    resultRef: null,
    errorJson: null,
    idempotencyKey: `seed-${String(counter)}`,
    requestDigest: asDigest(hex(`job-${String(counter)}`)),
    deadlineAt: null,
    retryAt: null,
    ...input,
    id,
    createdAt,
    updatedAt: createdAt,
  };
  const written = writer.transact((tx) => {
    const outcome = tx.insertJob(row);
    if (outcome.outcome !== "inserted") throw new Error("job not inserted");
    return true;
  });
  if (!written.ok) throw new Error(JSON.stringify(written.error));
  return row;
}

function seedLease(jobId: Id, input: Partial<LeaseRow> = {}): LeaseRow {
  const row: LeaseRow = {
    id: newId(),
    kind: "staging-dir",
    resourceIdentityJson: { path: `runs/${String(jobId)}` },
    ownershipProofJson: { marker: "owned" },
    cleanupState: "pending",
    lastErrorJson: null,
    retryAt: null,
    retryCount: 0,
    ...input,
    jobId,
  };
  const written = writer.transact((tx) => {
    tx.insertLease(row);
    return true;
  });
  if (!written.ok) throw new Error(JSON.stringify(written.error));
  return row;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-jobs-"));
  const lock = await acquireWorkerLock(root);
  if (!lock.ok) throw new Error(JSON.stringify(lock.error));
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  db = opened.value.db;
  writer = new SqliteStorageWriter(db);
  const planned = planMigrations(db);
  if (!planned.ok) throw new Error(JSON.stringify(planned.error));
  const applied = applyMigrations(db, planned.value);
  if (!applied.ok) throw new Error(JSON.stringify(applied.error));

  projectId = newId();
  otherProjectId = newId();
  targetId = newId();
  const createdAt = nowInstant();
  const seeded = writer.transact((tx) => {
    tx.insertProject({ id: projectId, name: "jobs-suite", createdAt, graphRevision: 1, inventoryRevision: 1, schemaVersion: 1 });
    tx.insertProject({ id: otherProjectId, name: "jobs-other", createdAt, graphRevision: 1, inventoryRevision: 1, schemaVersion: 1 });
    tx.insertTarget({
      id: targetId,
      projectId,
      kind: "har",
      originalLocator: null,
      sourceSha256: null,
      sourceArtifactId: null,
      snapshotDigest: asDigest(hex("jobs-snapshot")),
      identityReason: null,
      createdAt,
    });
    return true;
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  reads = new JobReadService({ storage: writer });
});

afterAll(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("the job page (§8 line 277)", () => {
  it("answers with rows the wire schema accepts and no cursor when there is nothing after", () => {
    const first = seedJob();
    const listed = page();
    expect(jobPageSchema.safeParse(listed).success).toBe(true);
    expect(listed.items.map((item) => item.id)).toContain(first.id);
    expect(listed.nextCursor).toBeNull();
  });

  it("orders the page newest-first, which is what a cursor cut on the same key assumes", () => {
    // Five rows a known distance apart. The order assertion is made about these ids only:
    // other suites seed jobs into the same project, and a global "descending by created_at"
    // claim would then depend on fixtures this file does not own.
    const ordered = [1, 2, 3, 4, 5].map(() => newId());
    ordered.forEach((id, index) => {
      seedJob({ id, createdAt: stamp(500 + index) });
    });
    const ids = new Set(ordered);
    const shown = page()
      .items.filter((item) => ids.has(item.id as Id))
      .map((item) => item.id);
    expect(shown).toEqual([...ordered].reverse());
  });

  it("pages to the end without repeating or losing a row", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      pages += 1;
      const listed: JobPage = unwrap(reads.list(projectId, reviewer, { cursor, limit: 2 }));
      seen.push(...listed.items.map((item) => item.id));
      if (listed.nextCursor === null) break;
      cursor = listed.nextCursor;
      if (pages > 50) throw new Error("the page never ended");
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice().sort()).toEqual(page().items.map((item) => item.id).slice().sort());
  });

  it("hands out a cursor only when a row actually follows the page", () => {
    const size = page().items.length;
    expect(size).toBeGreaterThan(1);
    // A page exactly as long as the request still has no next page when the probe for row
    // `limit + 1` came back empty: "full" is not evidence of "more".
    expect(page(size).nextCursor).toBeNull();
    expect(page(size - 1).nextCursor).not.toBeNull();
  });

  it("refuses a limit past the bound instead of quietly serving a smaller one", () => {
    const refusal = refusalOf(reads.list(projectId, reviewer, { cursor: null, limit: JOB_LIST_MAX_LIMIT + 1 }));
    expect(refusal.code).toBe("RESOURCE_LIMIT");
    expect(refusal.reason).toBe("jobs-limit");
    expect(refusal.details["limit"]).toBe(JOB_LIST_MAX_LIMIT + 1);
  });

  it("refuses a cursor this server never issued, however close to one it looks", () => {
    const real = encodeJobCursor({ createdAt: stamp(900), id: newId() });
    const lookalikes: [string, string][] = [
      ["not-a-cursor", "not base64url of a key at all"],
      [real.slice(0, real.length - 1), "a cursor with its last character dropped"],
      [`${real}%`, "the same bytes behind padding base64url decoding tolerates"],
      [Buffer.from(`${stamp(901)}|not-a-uuid`, "utf8").toString("base64url"), "a well-formed string whose id is not an id"],
      [Buffer.from(`${stamp(902)}|${String(newId())}|extra`, "utf8").toString("base64url"), "a key with a third field appended"],
      [Buffer.from("2026-13-45T99:99:99Z|" + String(newId()), "utf8").toString("base64url"), "a calendar date Date.parse would roll forward"],
    ];
    for (const [cursor, why] of lookalikes) {
      const refusal = refusalOf(reads.list(projectId, reviewer, { cursor, limit: null }));
      expect(`${why}: ${refusal.reason}`).toBe(`${why}: jobs-cursor`);
    }
    // The one string that is ours round-trips, which is what makes the refusals above a
    // property of the codec rather than of a broken fixture.
    const decoded = decodeJobCursor(real);
    if (!decoded.ok) throw new Error("the issued cursor was refused");
    expect(encodeJobCursor(decoded.value)).toBe(real);
  });

  it("keeps another project's jobs out of the page entirely", () => {
    const foreign = seedJob({ id: newId() });
    const theirs = unwrap(reads.list(otherProjectId, inspector, { cursor: null, limit: null }));
    expect(theirs.items).toEqual([]);
    expect(page().items.map((item) => item.id)).toContain(foreign.id);
  });

  it("refuses a lease by job id even when a caller asks the port for that id directly", () => {
    // The service never builds such a call, but the port is the boundary §5 puts the project
    // partition at: a query that takes job ids must resolve them through the owning project,
    // or a future caller that forgets to pre-filter gets another project's cleanup schedule.
    const foreign = seedJobIn(otherProjectId, "direct-lease-lookup");
    seedLease(foreign.id, { retryAt: stamp(655) });
    const mine = seedJob();
    const asked = unwrapPort(writer.transact((tx) => tx.listLeasesForJobs(projectId, [mine.id, foreign.id])));
    expect(asked.map((lease) => lease.jobId)).toEqual([]);
    const theirs = unwrapPort(writer.transact((tx) => tx.listLeasesForJobs(otherProjectId, [foreign.id])));
    expect(theirs.map((lease) => lease.jobId)).toEqual([foreign.id]);
  });
});

describe("the single projection behind both job reads (§8)", () => {
  it("reports the same fields for the same row from the page and from the one-job read", () => {
    const job = seedJob({ state: "running", retryAt: stamp(770), deadlineAt: stamp(780) });
    seedLease(job.id, { retryAt: stamp(700) });
    const listed = page(JOB_LIST_MAX_LIMIT).items.find((item) => item.id === job.id);
    const single = unwrap(reads.get(projectId, reviewer, job.id));
    expect(listed).toEqual(single);
    // And that object is what the pure projection produces from the same rows, so neither
    // read carries a private idea of what a job looks like.
    const rows = unwrapPort(
      writer.transact((tx) => ({ job: tx.getJob(projectId, job.id), leases: tx.listLeasesForJobs(projectId, [job.id]) })),
    );
    expect(single).toEqual(projectJobRecord(rows.job as JobRow, rows.leases));
  });

  it("carries every named field the left column reads, including error and cleanup retry", () => {
    const job = seedJob({ state: "failed", errorJson: safeError("the model did not answer") });
    seedLease(job.id, { retryAt: stamp(600) });
    const record = unwrap(reads.get(projectId, reviewer, job.id));
    expect(jobRecordSchema.safeParse(record).success).toBe(true);
    expect(record.state).toBe("failed");
    // A terminal job keeps its deadline and reports no further queue retry (§8 JobRecord).
    expect(record.retryAt).toBeNull();
    expect(record.deadlineAt).toBeNull();
    expect(record.cleanupRetryAt).toBe(stamp(600));
    expect(record.error?.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(record.resultRef).toBeNull();
  });

  it("takes the cleanup retry from this job's earliest pending lease, not the last one written", () => {
    const job = seedJob();
    seedLease(job.id, { retryAt: stamp(660) });
    seedLease(job.id, { retryAt: stamp(640) });
    // A completed lease is discharged and must not raise its retry time into the report.
    seedLease(job.id, { cleanupState: "complete", retryAt: stamp(610) });
    expect(unwrap(reads.get(projectId, reviewer, job.id)).cleanupRetryAt).toBe(stamp(640));
  });

  it("reports the job's own update time when a pending lease carries no retry of its own", () => {
    const job = seedJob({ state: "interrupted", createdAt: stamp(670) });
    seedLease(job.id, { retryAt: null });
    expect(unwrap(reads.get(projectId, reviewer, job.id)).cleanupRetryAt).toBe(stamp(670));
  });

  it("never reads a lease belonging to another project's job", () => {
    const foreign = seedJobIn(otherProjectId, "foreign-job");
    seedLease(foreign.id, { retryAt: stamp(650) });
    // The other project's own read sees it: the row is not hidden, only unreachable from here.
    expect(unwrap(reads.get(otherProjectId, inspector, foreign.id)).cleanupRetryAt).toBe(stamp(650));
    expect(page().items.some((item) => item.id === foreign.id)).toBe(false);
  });
});

describe("who may read jobs (§7.3, §2)", () => {
  it("refuses the Builder from the page and from the single read, each by name", () => {
    const job = seedJob();
    expect(refusalOf(reads.list(projectId, builder, { cursor: null, limit: null })).reason).toBe("builder-may-not-list-jobs");
    expect(refusalOf(reads.get(projectId, builder, job.id)).reason).toBe("builder-may-not-read-jobs");
  });

  it("refuses the evaluator too: a job page is control-plane data, not a completion channel", () => {
    const job = seedJob();
    expect(refusalOf(reads.get(projectId, evaluator, job.id)).code).toBe("ACCESS_DENIED");
    expect(refusalOf(reads.list(projectId, evaluator, { cursor: null, limit: null })).code).toBe("ACCESS_DENIED");
  });

  it("answers the system actor, which is what runs the queue", () => {
    const job = seedJob();
    expect(unwrap(reads.get(projectId, system, job.id)).id).toBe(job.id);
  });

  it("says job-unknown for a job that is not this project's", () => {
    const mine = seedJob();
    const refusal = refusalOf(reads.get(otherProjectId, inspector, mine.id));
    expect(refusal.code).toBe("NOT_FOUND");
    expect(refusal.reason).toBe("job-unknown");
  });
});

function seedJobIn(target: Id, key: string): JobRow {
  const id = newId();
  const created = stamp(690);
  const row: JobRow = {
    id,
    projectId: target,
    targetId: null,
    kind: "inspect",
    state: "queued",
    cleanupState: "pending",
    inputJson: {},
    resultRef: null,
    errorJson: null,
    idempotencyKey: key,
    requestDigest: asDigest(hex(key)),
    deadlineAt: null,
    retryAt: null,
    createdAt: created,
    updatedAt: created,
  };
  const written = writer.transact((tx) => {
    const outcome = tx.insertJob(row);
    if (outcome.outcome !== "inserted") throw new Error("job not inserted");
    return true;
  });
  if (!written.ok) throw new Error(JSON.stringify(written.error));
  return row;
}

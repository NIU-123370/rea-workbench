import { JOB_LIST_DEFAULT_LIMIT, JOB_LIST_MAX_LIMIT, type JobPage, type JobRecord } from "../contracts/jobs.ts";
import { isId, type Instant, isInstant, type Id } from "../domain/identity.ts";
import type { Result } from "../domain/result.ts";
import type { Actor } from "./actor.ts";
import { isControlPlane } from "./actor.ts";
import { gateFail, type GateFailure } from "./gate-failure.ts";
import { projectJobRecord } from "./job-queue.ts";
import { decodePageCursor, encodePageCursor } from "./page-cursor.ts";
import type { JobRow, LeaseRow, StorageWriterPort } from "./ports.ts";

// The job read surface (DESIGN §8 line 277, §11 / PRD F05, issue #55).
//
// §8 gives the left column one way to find out which resource a job produced: the job page
// carries each row's persisted `resultRef`, and a successful generation's resultRef is the
// candidate ID (line 294). Everything a client addresses a candidate with comes from here,
// which is why both reads go through the single `projectJobRecord` projection — the doc says
// GET job, GET jobs and job.updated report the same named time fields, and two hand-built
// objects are exactly how that drifts apart.

// A cursor is a row key this server handed out, encoded by the shared page-cursor codec so a
// client cannot compose one for a row it has never seen. The separator is a character neither
// an RFC 3339 instant nor a UUID can contain, so a decoded cursor splits into two parts.
export type JobCursor = { createdAt: Instant; id: Id };

export function encodeJobCursor(row: { createdAt: Instant; id: Id }): string {
  return encodePageCursor([row.createdAt, row.id]);
}

export function decodeJobCursor(raw: string): Result<JobCursor, GateFailure> {
  const decoded = decodePageCursor(raw, 2, "jobs-cursor");
  if (!decoded.ok) return decoded;
  const [createdAt, id] = decoded.value as [string, string];
  // The codec proves the string is ours; this proves the two fields still name a row key.
  if (!isInstant(createdAt) || !isId(id)) {
    return gateFail("INVALID_INPUT", "jobs-cursor", "the page cursor is not one this server issued");
  }
  return { ok: true, value: { createdAt, id: id as Id } };
}

export class JobReadService {
  readonly storage: StorageWriterPort;

  constructor(deps: { storage: StorageWriterPort }) {
    this.storage = deps.storage;
  }

  // §7.3 keeps the Builder inside its frozen handoff and §2 gives it no file view of the
  // control plane. A job row is full of other roles' resource ids — an inspect job's
  // resultRef is an evidence id — so both job reads are control-plane reads.
  private refuseRole(actor: Actor, reason: string): Result<never, GateFailure> | null {
    if (isControlPlane(actor)) return null;
    return gateFail("ACCESS_DENIED", reason, "this role does not read the job surface");
  }

  get(projectId: Id, actor: Actor, jobId: Id): Result<JobRecord, GateFailure> {
    const refused = this.refuseRole(actor, "builder-may-not-read-jobs");
    if (refused !== null) return refused;
    const read = this.storage.transact((tx) => {
      const job = tx.getJob(projectId, jobId);
      if (job === null) return null;
      return { job, leases: tx.listLeasesForJobs(projectId, [jobId]) };
    });
    if (!read.ok) return gateFail("CAPABILITY_UNAVAILABLE", "job-read-failed", "the job could not be read");
    if (read.value === null) return gateFail("NOT_FOUND", "job-unknown", "job not found");
    return { ok: true, value: projectJobRecord(read.value.job, read.value.leases) };
  }

  list(
    projectId: Id,
    actor: Actor,
    input: { cursor: string | null; limit: number | null | undefined },
  ): Result<JobPage, GateFailure> {
    const refused = this.refuseRole(actor, "builder-may-not-list-jobs");
    if (refused !== null) return refused;
    const limit = input.limit ?? JOB_LIST_DEFAULT_LIMIT;
    if (limit > JOB_LIST_MAX_LIMIT) {
      return gateFail("RESOURCE_LIMIT", "jobs-limit", `a job page is at most ${String(JOB_LIST_MAX_LIMIT)} rows`, {
        limit,
        maxLimit: JOB_LIST_MAX_LIMIT,
      });
    }
    let cursor: JobCursor | null = null;
    if (input.cursor !== null) {
      const decoded = decodeJobCursor(input.cursor);
      if (!decoded.ok) return decoded;
      cursor = decoded.value;
    }
    // One row more than the page asks for is how the read knows a nextCursor exists without
    // a second query — and why a page that comes up exactly full may still have no next page.
    const read = this.storage.transact((tx) => {
      const rows = tx.listJobsAfter(projectId, { cursor, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const ids = page.map((row: JobRow) => row.id);
      const leases = ids.length === 0 ? [] : tx.listLeasesForJobs(projectId, ids);
      return { page, leases, hasMore: rows.length > limit };
    });
    if (!read.ok) return gateFail("CAPABILITY_UNAVAILABLE", "job-read-failed", "the job page could not be read");
    const byJob = new Map<Id, LeaseRow[]>();
    for (const lease of read.value.leases) {
      const existing = byJob.get(lease.jobId);
      if (existing === undefined) byJob.set(lease.jobId, [lease]);
      else existing.push(lease);
    }
    const items = read.value.page.map((row: JobRow) => projectJobRecord(row, byJob.get(row.id) ?? []));
    const lastRow = read.value.page[read.value.page.length - 1];
    return {
      ok: true,
      value: {
        items,
        nextCursor: read.value.hasMore && lastRow !== undefined ? encodeJobCursor(lastRow) : null,
      },
    };
  }
}

import { httpStatusFor, isNamedErrorCode, makeApiError, safeFailureDetails } from "../contracts/errors.ts";
import type { NamedErrorCode } from "../contracts/errors.ts";
import { canTransitionJob, isTerminalJobState } from "../contracts/jobs.ts";
import type { JobRecord, JobState } from "../contracts/jobs.ts";
import { instantToEpochMs } from "../domain/identity.ts";
import type { Instant } from "../domain/identity.ts";
import type { JsonValue, JsonObject } from "../domain/json-value.ts";
import type { LeaseRow, JobRow } from "./ports.ts";

// DESIGN §11 / D20: job lifecycle and resource cleanup are separate facts. The
// queue may move a job between queued, running and the terminal states; it may
// never imply anything about cleanup, and cleanup retry never reruns business
// work (that path lives in CleanupService).

export type QueuePolicy = {
  // profile.limits.queueWaitMs: how long a job may wait before it must start.
  queueWaitMs: number;
  retryDelayMs: number;
};

export function computeDeadlineAt(
  explicit: Instant | null,
  enqueuedAt: Instant,
  policy: QueuePolicy,
): Instant {
  // An explicit caller value is adopted verbatim; otherwise the wait budget is
  // measured from enqueue time and never extended by a later retry (§11).
  if (explicit !== null) return explicit;
  return new Date(instantToEpochMs(enqueuedAt) + policy.queueWaitMs).toISOString() as Instant;
}

export type StartDecision =
  | { action: "start" }
  | { action: "requeue"; retryAt: Instant }
  | { action: "fail"; reason: "deadline-expired" | "permanent-start-failure" };

export function decideStart(input: {
  job: JobRow;
  now: Instant;
  brokerAvailable: boolean;
  permanentFailure: boolean;
}): StartDecision {
  const { job, now } = input;
  if (job.state !== "queued") return { action: "fail", reason: "permanent-start-failure" };
  if (input.permanentFailure) return { action: "fail", reason: "permanent-start-failure" };
  if (job.deadlineAt !== null && instantToEpochMs(now) >= instantToEpochMs(job.deadlineAt)) {
    return { action: "fail", reason: "deadline-expired" };
  }
  if (!input.brokerAvailable) {
    return {
      action: "requeue",
      retryAt: nextRetryAt(now, input.job, { queueWaitMs: 0, retryDelayMs: 0 }),
    };
  }
  return { action: "start" };
}

function nextRetryAt(now: Instant, job: JobRow, policy: QueuePolicy): Instant {
  const base = instantToEpochMs(now);
  const floor = job.retryAt === null ? 0 : instantToEpochMs(job.retryAt);
  return new Date(Math.max(base, floor) + policy.retryDelayMs).toISOString() as Instant;
}

export function withRetryAt(job: JobRow, now: Instant, policy: QueuePolicy): JobRow {
  return { ...job, retryAt: nextRetryAt(now, job, policy), deadlineAt: job.deadlineAt, updatedAt: now };
}

export function transition(job: JobRow, to: JobState, now: Instant): JobRow | null {
  if (!canTransitionJob(job.state, to)) return null;
  const terminal = isTerminalJobState(to);
  return {
    ...job,
    state: to,
    // A terminal job keeps its original deadline for traceability and reports no
    // further queue retry (§8 JobRecord note).
    retryAt: terminal ? null : job.retryAt,
    updatedAt: now,
  };
}

// Cancel is safe to repeat: a terminal job stays where it is, a queued job never
// needs a target started, and a running job goes through cancelling first.
export function requestCancel(job: JobRow, now: Instant): JobRow {
  if (isTerminalJobState(job.state)) return job;
  const to: JobState = job.state === "queued" ? "cancelled" : "cancelling";
  return transition(job, to, now) ?? job;
}

// Recovery marks lost executors interrupted; it never silently replays target
// execution (DESIGN §11).
export function recoveredState(state: JobState): JobState {
  return state === "running" || state === "cancelling" ? "interrupted" : state;
}

export function cleanupRetryAt(leases: readonly LeaseRow[], now: Instant): Instant | null {
  const pending = leases
    .filter((lease) => lease.cleanupState !== "complete")
    .map((lease) => (lease.retryAt === null ? now : lease.retryAt))
    .sort((left, right) => instantToEpochMs(left) - instantToEpochMs(right));
  return pending[0] ?? null;
}

// The single projection used by GET job, GET jobs and job.updated, so the left
// column can never derive a retry time from log text (§8).
export function projectJobRecord(job: JobRow, leases: readonly LeaseRow[]): JobRecord {
  const retry = job.retryAt;
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    cleanupState: job.cleanupState,
    deadlineAt: job.deadlineAt,
    retryAt: isTerminalJobState(job.state) ? null : retry,
    cleanupRetryAt: cleanupRetryAt(leases, job.updatedAt),
    resultRef: job.resultRef,
    error: job.errorJson === null ? null : (job.errorJson as JobRecord["error"]),
  };
}

// What a stored job failure looks like when it is read back (§8's JobRecord.error). Whoever settles
// a job - the runner, or the ingestion service that stops on a retained reference - writes through
// this one function, because the column is read by `projectJobRecord` and validated by
// `jobRecordSchema`: a row whose error is `{code, reason}` instead of an ApiError does not read as a
// failed job, it makes every page of that project's jobs refuse to parse.
//
// The message is the service's own sentence, never caller text, and the details go through the
// declared name list (§12.1). `requestId` is the idempotency key - the name the request that made
// this job already carries. A code that is not in §8's table stays reportable as the one name that
// means "an upstream answer did not fit the contract", rather than inventing a status.
export function jobErrorFromFailure(
  job: JobRow,
  failure: { code: string; reason: string; details?: JsonObject },
): JsonValue {
  const code: NamedErrorCode = isNamedErrorCode(failure.code) ? failure.code : "REA_CONTRACT_MISMATCH";
  return makeApiError(code, {
    message: failure.reason,
    // The status table is the only owner of "is this worth asking again": a 5xx class is an
    // infrastructure answer that may change, a 4xx will refuse the same way next time.
    retryable: httpStatusFor(code) >= 500,
    details: safeFailureDetails(failure.details ?? {}),
    requestId: job.idempotencyKey,
  }) as unknown as JsonValue;
}

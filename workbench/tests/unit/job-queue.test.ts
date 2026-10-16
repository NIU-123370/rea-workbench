import { describe, expect, it } from "vitest";

import {
  cleanupRetryAt,
  computeDeadlineAt,
  decideStart,
  projectJobRecord,
  recoveredState,
  requestCancel,
  transition,
  withRetryAt,
} from "../../packages/application/job-queue.ts";
import { JOB_STATES } from "../../packages/contracts/jobs.ts";
import type { JobRow, LeaseRow } from "../../packages/application/ports.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Instant } from "../../packages/domain/identity.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";

const HEX = ("a" as const).repeat(64) as Digest;
const POLICY = { queueWaitMs: 60_000, retryDelayMs: 5_000 };
const ENQUEUED = "2026-10-16T00:00:00.000Z" as Instant;
const BEFORE_DEADLINE = "2026-10-16T00:00:30.000Z" as Instant;
const AFTER_DEADLINE = "2026-10-16T00:02:00.000Z" as Instant;

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: newId(),
    projectId: newId(),
    targetId: null,
    kind: "inspect",
    state: "queued",
    cleanupState: "pending",
    inputJson: { kind: "inspect" },
    resultRef: null,
    errorJson: null,
    idempotencyKey: "k1",
    requestDigest: HEX,
    deadlineAt: computeDeadlineAt(null, ENQUEUED, POLICY),
    retryAt: null,
    createdAt: ENQUEUED,
    updatedAt: ENQUEUED,
    ...overrides,
  };
}

function lease(overrides: Partial<LeaseRow> = {}): LeaseRow {
  return {
    id: newId(),
    jobId: newId(),
    kind: "staging",
    resourceIdentityJson: { path: "/operator/private/staging/x" },
    ownershipProofJson: { token: "issued-by-broker" },
    cleanupState: "pending",
    lastErrorJson: null,
    retryAt: null,
    retryCount: 0,
    ...overrides,
  };
}

describe("deadline and retry (DESIGN §11)", () => {
  it("adopts an explicit deadline verbatim and derives otherwise", () => {
    const explicit = "2026-12-31T23:59:59.000Z" as Instant;
    expect(computeDeadlineAt(explicit, ENQUEUED, POLICY)).toBe(explicit);
    expect(computeDeadlineAt(null, ENQUEUED, POLICY)).toBe("2026-10-16T00:01:00.000Z");
  });

  it("never extends the deadline when a retry is scheduled", () => {
    const retried = withRetryAt(job({ deadlineAt: computeDeadlineAt(null, ENQUEUED, POLICY) }), BEFORE_DEADLINE, POLICY);
    expect(retried.deadlineAt).toBe("2026-10-16T00:01:00.000Z");
    expect(retried.retryAt).toBe("2026-10-16T00:00:35.000Z");
    const again = withRetryAt(retried, AFTER_DEADLINE, POLICY);
    expect(again.deadlineAt).toBe(retried.deadlineAt);
    expect(again.retryAt! > retried.retryAt!).toBe(true);
  });

  it("decides start, requeue and the two failure reasons", () => {
    const base = job();
    expect(decideStart({ job: base, now: BEFORE_DEADLINE, brokerAvailable: true, permanentFailure: false })).toEqual({
      action: "start",
    });
    const waiting = decideStart({
      job: base,
      now: BEFORE_DEADLINE,
      brokerAvailable: false,
      permanentFailure: false,
    });
    expect(waiting.action).toBe("requeue");
    expect(decideStart({ job: base, now: AFTER_DEADLINE, brokerAvailable: true, permanentFailure: false })).toEqual({
      action: "fail",
      reason: "deadline-expired",
    });
    expect(decideStart({ job: base, now: BEFORE_DEADLINE, brokerAvailable: true, permanentFailure: true })).toEqual({
      action: "fail",
      reason: "permanent-start-failure",
    });
    expect(
      decideStart({ job: job({ state: "running" }), now: BEFORE_DEADLINE, brokerAvailable: true, permanentFailure: false })
        .action,
    ).toBe("fail");
  });
});

describe("state machine (DESIGN §11)", () => {
  it("permits exactly the §11 edges and refuses everything else", () => {
    const allowed: [string, string][] = [
      ["queued", "running"],
      ["queued", "failed"],
      ["queued", "cancelled"],
      ["running", "cancelling"],
      ["running", "succeeded"],
      ["running", "failed"],
      ["running", "interrupted"],
      ["cancelling", "cancelled"],
      ["cancelling", "interrupted"],
    ];
    for (const [from, to] of allowed) {
      expect(transition(job({ state: from as JobRow["state"] }), to as JobRow["state"], ENQUEUED)).not.toBeNull();
    }
    const total = JOB_STATES.length ** 2;
    expect(allowed.length).toBeLessThan(total);
    for (const from of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
      for (const to of JOB_STATES) {
        expect(transition(job({ state: from }), to, ENQUEUED)).toBeNull();
      }
    }
    expect(transition(job({ state: "queued" }), "succeeded", ENQUEUED)).toBeNull();
    expect(transition(job({ state: "queued" }), "cancelling", ENQUEUED)).toBeNull();
  });

  it("keeps the deadline on a terminal job and clears its retry time", () => {
    const running = job({ state: "running", retryAt: BEFORE_DEADLINE });
    const failed = transition(running, "failed", AFTER_DEADLINE);
    expect(failed).not.toBeNull();
    if (!failed) return;
    expect(failed.deadlineAt).toBe(running.deadlineAt);
    expect(failed.retryAt).toBeNull();
  });

  it("cancels idempotently without resuming anything", () => {
    expect(requestCancel(job({ state: "queued" }), ENQUEUED).state).toBe("cancelled");
    expect(requestCancel(job({ state: "running" }), ENQUEUED).state).toBe("cancelling");
    const terminal = job({ state: "succeeded" });
    expect(requestCancel(terminal, ENQUEUED)).toBe(terminal);
    const cancelling = job({ state: "cancelling" });
    expect(requestCancel(cancelling, ENQUEUED).state).toBe("cancelling");
  });

  it("maps recovery onto interrupted only for lost executors", () => {
    expect(recoveredState("running")).toBe("interrupted");
    expect(recoveredState("cancelling")).toBe("interrupted");
    expect(recoveredState("queued")).toBe("queued");
    expect(recoveredState("succeeded")).toBe("succeeded");
  });
});

describe("job record projection (DESIGN §8)", () => {
  it("derives cleanupRetryAt from owned leases only", () => {
    const row = job({ state: "succeeded", cleanupState: "pending" });
    const leases = [
      lease({ cleanupState: "complete", retryAt: null }),
      lease({ cleanupState: "failed", retryAt: "2026-10-16T00:00:10.000Z" as Instant }),
      lease({ cleanupState: "pending", retryAt: "2026-10-16T00:00:05.000Z" as Instant }),
    ];
    expect(cleanupRetryAt(leases, AFTER_DEADLINE)).toBe("2026-10-16T00:00:05.000Z");
    expect(cleanupRetryAt([lease({ cleanupState: "complete" })], AFTER_DEADLINE)).toBeNull();
    const projected = projectJobRecord(row, leases);
    expect(projected.cleanupRetryAt).toBe("2026-10-16T00:00:05.000Z");
    expect(projected.retryAt).toBeNull();
    expect(projected.deadlineAt).toBe(row.deadlineAt);
    expect(projected.state).toBe("succeeded");
    expect(projected.cleanupState).toBe("pending");
  });

  it("carries the persisted error object without inventing one", () => {
    const error = {
      code: "CAPABILITY_UNAVAILABLE" as const,
      message: "broker not running",
      retryable: true,
      details: {},
      requestId: "req_1",
    };
    const failed = job({ state: "failed", errorJson: error, resultRef: null });
    expect(projectJobRecord(failed, []).error).toEqual(error);
    expect(projectJobRecord(job(), []).error).toBeNull();
    expect(nowInstant()).toMatch(/Z$/);
  });
});

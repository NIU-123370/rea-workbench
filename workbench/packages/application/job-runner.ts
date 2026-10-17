import { asId, isId } from "../domain/identity.ts";
import type { Id, Instant } from "../domain/identity.ts";
import type { JsonObject, JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import type { Actor } from "./actor.ts";
import type { CandidateCommit, GenerationBudget } from "./builder-service.ts";
import type { GateFailure } from "./gate-failure.ts";
import { gateFail } from "./gate-failure.ts";
import { decideStart, jobErrorFromFailure, transition } from "./job-queue.ts";
import type { JobRow, StorageWriterPort } from "./ports.ts";
import type { EventDraft } from "./ports.ts";

// The worker's job runner (§11, §8 line 294 / issue #57).
//
// Before this module the build could *record* a job and nothing ran it: `queued` described an
// intention, and the rows piled up. The runner is the executor half of §11 - claim a queued job,
// move it to `running`, do the work, settle it - and it is the only place that mints the Builder
// identity, which turns §7.3's "only the Builder generates" into a worker fact instead of a claim a
// request could bring along.
//
// Two boundaries are kept on purpose:
//   - the claim and the settle are each one transaction and the work happens between them, outside
//     SQLite. Holding `BEGIN IMMEDIATE` across a Builder child process would put the write lock and
//     the RPC frame timeout in a contest over the same minute;
//   - the runner never decides *whether* work exists. It reads the queue the doors wrote, so no
//     client can ask it to run something it was not allowed to enqueue.
//
// A crash between claim and settle is §11's `interrupted`: `recoverJobs` marks the row at the next
// boot and nothing here replays it.

// The one job kind this build can execute. `inspect` and `verify` have rows and no executor yet -
// that is issue #75 and the `capture.inspect` gap the README records, and it stays a named absence
// rather than a handler that would have to invent what "ran" means for them.
export const RUNNABLE_JOB_KINDS = ["build"] as const;

export type RunnerOutcome =
  | { kind: "idle" }
  | { kind: "succeeded"; jobId: Id; candidateId: Id; attempt: number }
  | { kind: "failed"; jobId: Id; reason: string }
  | { kind: "cancelled"; jobId: Id }
  | { kind: "skipped"; jobId: Id; reason: string };

export type BuildWork = {
  // Who the runner is when it asks a service to generate: minted here, never imported from a
  // request, because §12.1 keeps a role identity off the wire and §7.3 gives the generation to that
  // role alone.
  actor: Actor;
  // What the candidate row journals as "the thing that produced these bytes". Names are allowed; a
  // model endpoint or a host path is not, since the row is readable by other roles.
  generator: JsonObject;
  // The attempt budget, read from the profile when the job runs rather than when it was asked for.
  // It is a thunk because the profile can be unavailable at run time, and a job that cannot state
  // its budget fails with that name instead of running uncapped (§7.3, §10).
  budget: () => Result<number, string[]>;
  generate: (
    projectId: Id,
    actor: Actor,
    blueprintId: Id,
    input: { budget: GenerationBudget; generator: JsonObject; jobId: Id },
  ) => Promise<Result<CandidateCommit, GateFailure>>;
};

export type JobRunner = { runOnce: () => Promise<Result<RunnerOutcome, GateFailure>> };

// A turn that finished is an outcome; only a port failure is an `err`. Keeping the two apart here
// means a caller (the process loop, a test) can tell "the queue had nothing for me" from "SQLite
// said no", which is the difference between a sleep and an alarm.
function done(outcome: RunnerOutcome): Result<RunnerOutcome, GateFailure> {
  return { ok: true, value: outcome };
}

export function createJobRunner(deps: {
  storage: StorageWriterPort;
  builds: BuildWork;
  scanLimit: number;
  now: () => Instant;
}): JobRunner {
  const { storage, builds, scanLimit } = deps;

  // One transaction, one row read back inside it, and a transition the state machine has to accept:
  // a job that moved under the runner (cancelled while the Builder worked) is settled as what it is,
  // not as what the runner expected.
  function settle(
    job: JobRow,
    to: "failed" | "cancelled",
    failure: { code: string; reason: string; details: JsonObject },
  ): Result<RunnerOutcome, GateFailure> {
    const written = storage.transact((tx) => {
      const current = tx.getJob(job.projectId, job.id);
      if (current === null) return "gone";
      const moved = transition(current, to, deps.now());
      if (moved === null) return "refused";
      tx.updateJob({
        ...moved,
        ...(to === "failed" ? { errorJson: jobErrorFromFailure(moved, failure) } : {}),
        updatedAt: deps.now(),
      });
      tx.appendEvent({
        projectId: job.projectId,
        type: "job.updated",
        aggregateId: job.id,
        // `reasonCode`, not `reason`: §8.1's payload contract is a strict object, so a key it does
        // not name does not merely go undelivered - it makes `GET /events` refuse the whole backlog
        // for that project forever, which is one failed job killing the stream for every later one.
        payloadJson: { resourceIds: [job.id], state: to, reasonCode: failure.reason },
        createdAt: deps.now(),
      } satisfies EventDraft);
      return to;
    });
    if (!written.ok) return done({ kind: "skipped", jobId: job.id, reason: `settle-write-${written.error.code}` });
    if (written.value === "gone") return done({ kind: "skipped", jobId: job.id, reason: "job-disappeared" });
    if (written.value === "refused") return done({ kind: "skipped", jobId: job.id, reason: `state-${job.state}-refused-${to}` });
    return written.value === "cancelled"
      ? done({ kind: "cancelled", jobId: job.id })
      : done({ kind: "failed", jobId: job.id, reason: failure.reason });
  }

  return {
    async runOnce() {
      const queued = storage.transact((tx) =>
        tx
          .listJobsByStates(["queued"], scanLimit)
          .filter((job) => (RUNNABLE_JOB_KINDS as readonly string[]).includes(job.kind))
          // The queue owns the row, the kind owns the input: a `build` row that does not name a
          // blueprint is not a job to run, and reading it anyway would turn one bad row into a
          // loop over the same page of jobs.
          .map((job) => ({ job, blueprintId: readBlueprintId(job.inputJson) })),
      );
      if (!queued.ok) return gateFail("INVALID_INPUT", queued.error.code, queued.error.message);
      const next = queued.value[0];
      if (next === undefined) return done({ kind: "idle" });
      const { job } = next;

      if (next.blueprintId === null) {
        return settle(job, "failed", { code: "INVALID_INPUT", reason: "build-job-input-unreadable", details: {} });
      }

      // §11's own start decision, so the deadline the door wrote is the deadline that is honoured -
      // a runner that re-derived it would be a second clock. `brokerAvailable` is true because a
      // build asks no broker; the requeue branch belongs to capture jobs, which have no executor
      // here, so the only outcomes this call can produce are start and deadline-expired.
      const start = decideStart({ job, now: deps.now(), brokerAvailable: true, permanentFailure: false });
      if (start.action === "fail") {
        return settle(job, "failed", { code: "RESOURCE_LIMIT", reason: start.reason, details: {} });
      }
      if (start.action === "requeue") return done({ kind: "skipped", jobId: job.id, reason: "start-requeued" });

      const claimed = storage.transact((tx) => {
        const current = tx.getJob(job.projectId, job.id);
        if (current === null) return null;
        // §11's transition is the only state check here: it refuses a row that is no longer `queued`
        // for the same reason the cancel door does, so restating "is it queued" above it would be a
        // second guard with no answer the first one does not already give.
        const started = transition(current, "running", deps.now());
        if (started === null) return null;
        tx.updateJob({ ...started, updatedAt: deps.now() });
        tx.appendEvent({
          projectId: job.projectId,
          type: "job.updated",
          aggregateId: job.id,
          payloadJson: { resourceIds: [job.id], state: "running" },
          createdAt: deps.now(),
        } satisfies EventDraft);
        return started;
      });
      if (!claimed.ok) return gateFail("INVALID_INPUT", claimed.error.code, claimed.error.message);
      if (claimed.value === null) return done({ kind: "skipped", jobId: job.id, reason: "job-no-longer-queued" });
      const running = claimed.value;

      const attempts = builds.budget();
      if (!attempts.ok) {
        return settle(running, "failed", { code: "CAPABILITY_UNAVAILABLE", reason: "generation-budget-unknown", details: {} });
      }

      const generated = await builds.generate(running.projectId, builds.actor, next.blueprintId, {
        budget: { maxAttemptsPerBlueprint: attempts.value, deadlineAt: running.deadlineAt },
        generator: builds.generator,
        jobId: running.id,
      });
      if (generated.ok) {
        return done({
          kind: "succeeded",
          jobId: running.id,
          candidateId: generated.value.candidateId,
          attempt: generated.value.attempt,
        });
      }

      // The service refused and left the row where it found it, so §11 decides what a refused run
      // becomes: a cancel that arrived while the Builder was working moved the row to `cancelling`,
      // and that is a cancellation - the work was stopped, it did not go wrong.
      const reread = storage.transact((tx) => tx.getJob(running.projectId, running.id));
      if (!reread.ok) return gateFail("INVALID_INPUT", reread.error.code, reread.error.message);
      const fresh = reread.value;
      if (fresh === null) return done({ kind: "skipped", jobId: running.id, reason: "job-disappeared" });
      if (fresh.state === "cancelling") return settle(fresh, "cancelled", { code: "ACCESS_DENIED", reason: "cancelled-during-generation", details: {} });
      if (fresh.state === "succeeded") return done({ kind: "skipped", jobId: fresh.id, reason: "already-succeeded" });
      return settle(fresh, "failed", {
        code: generated.error.code,
        reason: generated.error.reason,
        details: generated.error.details,
      });
    },
  };
}

// The job row's own input, read by name with the shape checked - the same discipline every other
// input here uses, so a missing field never travels further as `undefined`.
function readBlueprintId(input: JsonValue): Id | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const named = (input as Record<string, unknown>)["blueprintId"];
  return typeof named === "string" && isId(named) ? asId(named) : null;
}

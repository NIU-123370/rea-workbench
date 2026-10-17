import { asId, instantToEpochMs, isId } from "../domain/identity.ts";
import type { Id, Instant } from "../domain/identity.ts";
import type { JsonObject, JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import { ingestionJobInputSchema } from "../contracts/imports.ts";
import type { InspectionReceipt } from "../contracts/imports.ts";
import { inspectTaskSchema } from "../contracts/tasks.ts";
import type { Actor } from "./actor.ts";
import type { CandidateCommit, GenerationBudget } from "./builder-service.ts";
import type { GateFailure } from "./gate-failure.ts";
import { gateFail } from "./gate-failure.ts";
import type { IngestionContext } from "./har-ingestion.ts";
import { decideStart, jobErrorFromFailure, transition, withRetryAt } from "./job-queue.ts";
import type { EventDraft, JobRow, StorageWriterPort } from "./ports.ts";
import type { SensitiveDeclaration } from "./sanitizer.ts";

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
//
// The ingestion job (§8 line 272's inspect row) joins this build's executable kinds with one
// difference, and the difference is the service's own contract: `inspectionCommandSchema` accepts
// exactly one expected state, `queued`, and §11 gives `interrupted` no outgoing edge. So the runner
// does not pre-claim that row - it hands the queued row over and reads back what became of it. The
// service then walks `queued → running → succeeded` inside one transaction, which is why the job page
// can show an ingestion job go straight from queued to succeeded without the state machine being
// bent: the transition function enforced both edges, in order, in that transaction.

// `build` is what issue #57 landed, `inspect` is this module's (issue #108): an uploaded HAR's row
// finally has a driver. `verify` still has none - that is issue #75's evaluator, whose completion RPC
// is named but whose host process this build does not ship - and a `capture` row needs
// `capture_browser_scenario`, which has no mirrored contract here at all. Both stay named absences
// that the doctor reports, rather than handlers that would have to invent what "ran" means.
export const RUNNABLE_JOB_KINDS = ["build", "inspect"] as const;

// Which executor, if any, owns a queued row. `inquiry` is §8 line 310's directed investigation: a real
// job with a real door and no executor in this build, so it is deliberately not a candidate - the
// runner neither runs it nor fails it, and the doctor says so.
export type JobPlan = "build" | "ingest" | "inquiry" | "unreadable";

export type RunnerOutcome =
  | { kind: "idle" }
  | { kind: "succeeded"; jobId: Id; candidateId: Id; attempt: number }
  | { kind: "inspected"; jobId: Id; jobState: InspectionReceipt["jobState"]; evidenceIds: readonly string[] }
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

export type InspectionWork = {
  // The identity the ingestion runs under. §14 has the worker issue an inspector-scope capability
  // internally, so this is minted the same way the build's Builder identity is - never taken from a
  // frame. The service re-checks the kind against its own list, so this is not the gate.
  actor: Actor;
  // §11's distinction: a provider that cannot be reached right now is a *wait*, not a failure. The
  // runner asks before it touches the row, so a job with no provider stays `queued` and gains a
  // visible retry time instead of an error it did not earn. It is a question rather than a field
  // because the answer is the provider's: the worker negotiates MCP with the child it spawned, and a
  // child that never negotiated is not "available" no matter how well it started.
  providerAvailable: () => Promise<boolean>;
  // The upload's sensitive declaration, held in worker memory (§12.1, §8 line 306). `null` is the
  // state D25 refuses - the memo does not hold it, typically because the worker restarted - and is
  // not the same thing as a declaration of nothing.
  declaration: (jobId: Id) => SensitiveDeclaration | null;
  inspect: (
    projectId: Id,
    actor: Actor,
    command: { projectId: Id; jobId: Id; expectedJobState: "queued" },
    context: IngestionContext,
  ) => Promise<Result<InspectionReceipt, GateFailure>>;
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
  inspections: InspectionWork;
  scanLimit: number;
  // How far ahead a requeued row looks. §14's profile list names `queueWaitMs` (how long a job may
  // wait before it must start) and no retry interval, so this is the process's own scheduler tick
  // passed in from the composition root - the same category as the poll interval that file defends
  // as a latency choice rather than a resource limit. Recorded as a deviation on issue #108, next to
  // #99's list of profile numbers with no document home.
  retryDelayMs: number;
  now: () => Instant;
}): JobRunner {
  const { storage, builds, inspections, scanLimit } = deps;

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

  // §11's 暂时不可用 branch, made visible: `decideStart` says wait, this says until when, and both the
  // row and the event stream carry it - a retry time nobody can read is how a permanently idle job
  // looks like one that is about to run.
  function requeue(job: JobRow): Result<RunnerOutcome, GateFailure> {
    const rescheduled = storage.transact((tx) => {
      const current = tx.getJob(job.projectId, job.id);
      if (current === null) return null;
      const retry = withRetryAt(current, deps.now(), { queueWaitMs: 0, retryDelayMs: deps.retryDelayMs });
      tx.updateJob(retry);
      tx.appendEvent({
        projectId: job.projectId,
        type: "job.updated",
        aggregateId: job.id,
        payloadJson: { resourceIds: [job.id], state: "queued", retryAt: retry.retryAt },
        createdAt: deps.now(),
      } satisfies EventDraft);
      return retry.retryAt;
    });
    if (!rescheduled.ok) return gateFail("INVALID_INPUT", rescheduled.error.code, rescheduled.error.message);
    if (rescheduled.value === null) return done({ kind: "skipped", jobId: job.id, reason: "job-disappeared" });
    return done({ kind: "skipped", jobId: job.id, reason: "start-requeued" });
  }

  // The ingestion half of the turn: no pre-claim, because the service walks its own row from
  // `queued` and refuses any other expected state. What comes back is either a receipt - the service
  // settled the row, or stopped it on §9's retained-reference path - or a refusal that wrote nothing.
  async function runIngestion(job: JobRow): Promise<Result<RunnerOutcome, GateFailure>> {
    const outcome = await inspections.inspect(
      job.projectId,
      inspections.actor,
      { projectId: job.projectId, jobId: job.id, expectedJobState: "queued" },
      { sensitive: inspections.declaration(job.id) },
    );
    if (outcome.ok) {
      return done({
        kind: "inspected",
        jobId: job.id,
        jobState: outcome.value.jobState,
        evidenceIds: outcome.value.evidenceIds,
      });
    }
    const reread = storage.transact((tx) => tx.getJob(job.projectId, job.id));
    if (!reread.ok) return gateFail("INVALID_INPUT", reread.error.code, reread.error.message);
    const fresh = reread.value;
    if (fresh === null) return done({ kind: "skipped", jobId: job.id, reason: "job-disappeared" });
    if (fresh.state === "cancelling") {
      return settle(fresh, "cancelled", { code: "ACCESS_DENIED", reason: "cancelled-during-inspection", details: {} });
    }
    // The service moved the row itself on the paths that ran (the §9 stop, a provider failure): the
    // job is what it is, and writing a second verdict over it would make one run answer twice. A
    // refusal that reached no writer leaves it `queued`, which §11 lets fail directly.
    if (fresh.state !== "queued") return done({ kind: "failed", jobId: fresh.id, reason: outcome.error.reason });
    return settle(fresh, "failed", {
      code: outcome.error.code,
      reason: outcome.error.reason,
      details: outcome.error.details,
    });
  }

  return {
    async runOnce() {
      const now = deps.now();
      const queued = storage.transact((tx) =>
        tx
          .listJobsByStates(["queued"], scanLimit)
          .filter((job) => (RUNNABLE_JOB_KINDS as readonly string[]).includes(job.kind))
          .map((job) => ({ job, plan: planOf(job) }))
          // A directed investigation stays in the queue untouched: nothing in this build can run it,
          // and a row that fails because a feature was never shipped tells the operator the wrong
          // story about the work they asked for.
          .filter((entry) => entry.plan !== "inquiry")
          // §11's wait is honoured by not looking again before the time it wrote. Without this the
          // requeue branch would be a poll-interval spin, and `retryAt` a number nothing reads.
          .filter(
            (entry) =>
              entry.job.retryAt === null ||
              instantToEpochMs(entry.job.retryAt) <= instantToEpochMs(now),
          ),
      );
      if (!queued.ok) return gateFail("INVALID_INPUT", queued.error.code, queued.error.message);
      const next = queued.value[0];
      if (next === undefined) return done({ kind: "idle" });
      const { job, plan } = next;

      // The queue owns the row, the kind owns the input: a row that names neither an ingestion
      // projection nor a blueprint is not a job to run, and reading it anyway would turn one bad row
      // into a loop over the same page of jobs.
      if (plan === "unreadable") {
        return settle(job, "failed", { code: "INVALID_INPUT", reason: "inspect-job-input-unreadable", details: {} });
      }

      // The provider question is only asked of the kind that asks it: a build spawns a Builder child,
      // not a REA session, and a busy provider must not requeue work that never uses it.
      const brokerAvailable = plan === "ingest" ? await inspections.providerAvailable() : true;
      const start = decideStart({ job, now, brokerAvailable, permanentFailure: false });
      if (start.action === "fail") {
        return settle(job, "failed", { code: "RESOURCE_LIMIT", reason: start.reason, details: {} });
      }
      if (start.action === "requeue") return requeue(job);

      if (plan === "ingest") return runIngestion(job);

      // Checked before the claim, so a build row that names no blueprint never gets a `running` event
      // it cannot honour.
      const blueprintId = readBlueprintId(job.inputJson);
      if (blueprintId === null) {
        return settle(job, "failed", { code: "INVALID_INPUT", reason: "build-job-input-unreadable", details: {} });
      }

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

      const generated = await builds.generate(running.projectId, builds.actor, blueprintId, {
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

// Two positive parses, not a field sniff: the ingestion projection and §8 line 310's `InspectTask` are
// both contracts, so a row that is neither is reported as unreadable instead of being handed to
// whichever service happens to be wired. The two doors write different shapes on purpose: the import
// persists its own filtered projection at the top level (`har-ingestion.ts`'s `ingestionJobInputSchema`
// object), while §8 line 275's door persists `{targetId, expectedGraphRevision, task}` - so the task
// union is read from the field the door put it in, not guessed at from whichever key is present.
export function planOf(job: JobRow): JobPlan {
  if (job.kind === "build") return "build";
  if (ingestionJobInputSchema.safeParse(job.inputJson).success) return "ingest";
  const nested =
    job.inputJson !== null && typeof job.inputJson === "object" && !Array.isArray(job.inputJson)
      ? (job.inputJson as Record<string, JsonValue>)["task"]
      : undefined;
  if (nested !== undefined && inspectTaskSchema.safeParse(nested).success) return "inquiry";
  return "unreadable";
}

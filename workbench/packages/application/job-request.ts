import { newId, nowInstant, asId } from "../domain/identity.ts";
import type { Id } from "../domain/identity.ts";
import type { Err, Result } from "../domain/result.ts";
import { asDigest, canonicalJson, digestBytes } from "../domain/canonical-json.ts";
import type { CanonicalLimits } from "../domain/canonical-json.ts";
import type { JsonObject, JsonValue } from "../domain/json-value.ts";
import { normalizeUrlLocator } from "../domain/target.ts";
import { jobRequestSchema } from "../contracts/jobs.ts";
import type { JobRecord, JobRequest } from "../contracts/jobs.ts";
import type { JobTask } from "../contracts/tasks.ts";
import type { Actor } from "./actor.ts";
import { isControlPlane } from "./actor.ts";
import { commitDecision, recordDeny } from "./decision.ts";
import type { Step } from "./decision.ts";
import { blockedByReasons, gateFail, type GateFailure } from "./gate-failure.ts";
import { computeDeadlineAt, projectJobRecord } from "./job-queue.ts";
import type { EventDraft, JobRow, StorageTransaction, StorageWriterPort } from "./ports.ts";

// Asking for work against a target (§8 line 275, §7.3, §10, §12.1; issue #58).
//
// §8's last unmounted row, and the one door whose body is a task rather than a reference. Three
// rules make this file worth having on its own:
//
//   * It creates a **job** and nothing else (§10: 一次请求只造工作，不造结论). Nothing here can
//     produce a snapshot, an evidence row or a claim; the row it writes says `queued` and waits for
//     an executor, which this build does not have for `capture`/`inspect` any more than it has one
//     for `verify` - the doctor's absence cell and issue #75 say so out loud rather than this file
//     pretending the work would happen.
//   * The **graph revision is a concurrency token the caller holds** (§8's own note: 依赖图版本的写入
//     必须带 `expectedGraphRevision`). This is the door that honours it: the contract and plan doors
//     refuse that field because nothing they write is indexed on the graph, while a capture appends
//     to it. So a moved graph is a 409 naming the two revisions, not a silently-widened scope.
//   * The **short-lived secrets go through a structural drop**, not a filter. §12.1 says a capture's
//     `sensitiveValues` never enter the persisted job input and never enter the request digest, so
//     the task is *rebuilt* from the fields that may be stored. A spread with a `delete` on it would
//     work until someone added a second secret-bearing field to the union and forgot the delete.
//
// The two halves of the scope rule (§8: target 必须是 URL、startUrl 必须匹配目标授权范围) are decided
// here as far as this build can decide them: the target must be a URL target, and the capture must
// start at the host that target names. §8's exception - a profile may authorise its own fixture
// origins - has no owner yet, because `profileSchema` (§14) names a `networkPolicyId` and no origin
// list, so nothing here invents an allowlist to consult.

export type JobRequestDeps = {
  readonly storage: StorageWriterPort;
  readonly limits: CanonicalLimits;
  // The worker's profile registry, asked as a question. A capture task names a profile by id, and
  // §14 makes that profile the only source of the wait budget - so this service neither guesses a
  // number nor reads a registry it does not own. `null` means "no profile installed under that
  // name", which is a refusal, not a default.
  readonly profiles: { resolve(profileId: string): { queueWaitMs: number } | null };
};

// The task as it may be persisted and digested: the same named union, minus the short-lived
// operation context §12.1 keeps out of both. Rebuilding field by field rather than copying and
// deleting is the point - a field that cannot be written down is not *present* in what gets written
// down, so adding a second secret-bearing field to the union cannot be forgotten the way a `delete`
// can. The result is a plain JSON object, which is what both the row's input column and the
// canonical digest take.
export function taskForStorage(task: JobTask): JsonObject {
  const stored: Record<string, JsonValue> =
    task.kind === "capture"
      ? {
          kind: "capture",
          profileId: task.profileId,
          scenario: { startUrl: task.scenario.startUrl, actions: task.scenario.actions },
          network: { requestBody: task.network.requestBody, responseBody: task.network.responseBody, headerValues: task.network.headerValues },
        }
      : { kind: "inspect", claimIds: [...task.claimIds], question: task.question, scope: task.scope };
  if (task.kind === "capture" && task.timeoutMs !== undefined) stored.timeoutMs = task.timeoutMs;
  return stored;
}

export type JobRequestContext = {
  // The profile whose queue wait bounds a job that names no profile of its own (an inspect task).
  readonly defaultProfileId: string;
};

export class JobRequestService {
  readonly storage: StorageWriterPort;
  readonly limits: CanonicalLimits;
  readonly profiles: JobRequestDeps["profiles"];

  constructor(deps: JobRequestDeps) {
    this.storage = deps.storage;
    this.limits = deps.limits;
    this.profiles = deps.profiles;
  }

  request(
    projectId: Id,
    actor: Actor,
    input: unknown,
    idempotencyKey: string,
    context: JobRequestContext,
  ): Result<JobRecord, GateFailure> {
    if (!isControlPlane(actor)) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "job",
        action: "job.request",
        resourceId: null,
        decision: "deny",
        reasonCode: "role-may-not-request-jobs",
        metadata: {},
      });
      return gateFail("ACCESS_DENIED", "role-may-not-request-jobs", "only the control plane asks for work against a target (§7.3)", {
        actorKind: actor.actorKind,
      });
    }
    const parsed = jobRequestSchema.safeParse(input);
    if (!parsed.success) {
      return gateFail("INVALID_INPUT", "job-request", "the job request was rejected", {
        fields: parsed.error.issues.map((issue) => issue.path.join(".")),
        rejectedKeys: parsed.error.issues.flatMap((issue) => (issue as { keys?: string[] }).keys ?? []),
      });
    }
    const request = parsed.data;
    const storedTask = taskForStorage(request.task);
    const profileId = request.task.kind === "capture" ? request.task.profileId : context.defaultProfileId;
    const profile = this.profiles.resolve(profileId);
    if (profile === null) {
      // Named by the id the caller used, because that is the thing to fix; the reason says which
      // half of the request asked for it (§12.1 publishes names, never values).
      return gateFail(
        "CAPABILITY_UNAVAILABLE",
        "task-profile-not-installed",
        "no profile is installed under the name this task carries, and §14 forbids inventing its numbers",
        { taskKind: request.task.kind },
      );
    }

    const committed = commitDecision(this.storage, {
      projectId,
      actor,
      resourceType: "job",
      action: "job.request",
      resourceId: null,
      allowReason: "job-queued",
      metadata: { taskKind: request.task.kind },
      work: (tx): Step<JobRecord> => {
        const target = tx.getTarget(projectId, asId(request.targetId));
        if (target === null) {
          return { kind: "failure", failure: gateFail("NOT_FOUND", "target-unknown", "no such target in this project") };
        }
        const project = tx.getProject(projectId);
        if (project === null) {
          return { kind: "failure", failure: gateFail("NOT_FOUND", "project-unknown", "project not found") };
        }
        if (project.graphRevision !== request.expectedGraphRevision) {
          return {
            kind: "failure",
            failure: gateFail(
              "REVISION_CONFLICT",
              "graph-revision-changed",
              `the graph is at revision ${String(project.graphRevision)} while this request expected ${String(request.expectedGraphRevision)}`,
              { expected: request.expectedGraphRevision, actual: project.graphRevision },
            ),
          };
        }
        const scopeFailure = taskScopeFailure(request, target.kind, target.originalLocator, tx, projectId);
        if (scopeFailure !== null) return { kind: "failure", failure: scopeFailure };

        const at = nowInstant();
        const job: JobRow = {
          id: newId(),
          projectId,
          // Unlike a build or a verify row, this job is *about* a target, and §8's route names it in
          // the body - so the row carries it instead of burying it in the input.
          targetId: target.id,
          kind: request.task.kind,
          state: "queued",
          cleanupState: "pending",
          inputJson: { targetId: target.id, expectedGraphRevision: request.expectedGraphRevision, task: storedTask },
          resultRef: null,
          errorJson: null,
          idempotencyKey,
          // The digest covers the storable half of the request: two different captures under one key
          // must not look like the same request, and a secret must not ride along in a column that is
          // read back (§8 line 261, §12.1).
          requestDigest: asDigest(
            digestBytes(
              new TextEncoder().encode(
                canonicalJson(
                  {
                    targetId: target.id,
                    expectedGraphRevision: request.expectedGraphRevision,
                    deadlineAt: request.deadlineAt ?? null,
                    task: storedTask,
                  },
                  this.limits,
                ),
              ),
            ),
          ),
          deadlineAt: computeDeadlineAt(request.deadlineAt ?? null, at, { queueWaitMs: profile.queueWaitMs, retryDelayMs: 0 }),
          retryAt: null,
          createdAt: at,
          updatedAt: at,
        };
        const outcome = tx.insertJob(job);
        if (outcome.outcome === "divergent") {
          return { kind: "failure", failure: gateFail("IDEMPOTENCY_CONFLICT", "idempotency-key-reused", "that key already carries a different job request") };
        }
        const row = outcome.outcome === "existing" ? outcome.job : job;
        // A replay of the same key is not a state change, so it writes no second event (§13).
        if (outcome.outcome !== "existing") {
          tx.appendEvent({
            projectId,
            type: "job.updated",
            aggregateId: row.id,
            payloadJson: { resourceIds: [row.id], state: "queued" },
            createdAt: at,
          } satisfies EventDraft);
        }
        return { kind: "committed", value: projectJobRecord(row, tx.listLeasesForJobs(projectId, [row.id])) };
      },
    });
    if (!committed.ok) return committed;
    return { ok: true, value: committed.value.value };
  }
}

// What this task is allowed to point at. The checks are separate per task kind because §8 states them
// separately, and each refusal names the half that failed rather than a single "bad task".
function taskScopeFailure(
  request: JobRequest,
  targetKind: "url" | "har" | "asar",
  targetLocator: string | null,
  tx: StorageTransaction,
  projectId: Id,
): Err<GateFailure> | null {
  const task = request.task;
  if (task.kind === "capture") {
    if (targetKind !== "url") {
      return gateFail("INVALID_INPUT", "capture-needs-url-target", "a capture runs against a URL target, and this one is a file target", {
        targetKind,
      });
    }
    const start = normalizeUrlLocator(task.scenario.startUrl);
    if (!start.ok) return blockedByReasons(start.error, "INVALID_INPUT", "the capture start URL");
    // The target's own locator was written through this same normaliser, so a host read of it cannot
    // fail for a reason the caller could correct; anything else is the parse this door just did.
    const declared = targetLocator === null ? null : normalizeUrlLocator(targetLocator);
    if (declared === null || !declared.ok) {
      return gateFail("STALE_INPUT", "target-locator-unreadable", "this target's stored locator cannot be compared against a start URL");
    }
    if (declared.value.host !== start.value.host) {
      // Neither host is echoed: §12.1 publishes names, and the two strings the caller already has
      // would be a locator pair in an error body that other screens list.
      return gateFail("ACCESS_DENIED", "start-url-outside-target-scope", "the capture must start at the host this URL target names (§8: 不能任意换目标)");
    }
    return null;
  }
  if (targetKind === "url") {
    return gateFail("INVALID_INPUT", "inspect-needs-file-target", "an inspect reads imported bytes, and this target has none yet", { targetKind });
  }
  if (task.claimIds.length === 0) {
    // §8: an empty list is only the *first* analysis. The target's own claim rows are what decides
    // whether one has happened, so this asks the storage rather than remembering a counter.
    if (tx.listClaimsForTarget(projectId, asId(request.targetId), 1).length > 0) {
      return gateFail(
        "INVALID_INPUT",
        "directed-inspect-needs-claims",
        "this target already has claims, so an investigation must name the ones it is about (§8)",
      );
    }
    return null;
  }
  const unknown = task.claimIds.filter((claimId) => tx.getClaim(projectId, asId(claimId)) === null);
  if (unknown.length > 0) {
    return gateFail("NOT_FOUND", "claim-unknown", "an inspect may only name claims this project already holds", {
      claimCount: task.claimIds.length,
      unknownCount: unknown.length,
    });
  }
  return null;
}

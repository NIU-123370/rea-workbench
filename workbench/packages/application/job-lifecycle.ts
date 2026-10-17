import { nowInstant } from "../domain/identity.ts";
import type { Id } from "../domain/identity.ts";
import type { Result } from "../domain/result.ts";
import type { JobRecord } from "../contracts/jobs.ts";
import type { CleanupRetryReceipt } from "../contracts/jobs.ts";
import type { Actor } from "./actor.ts";
import { isControlPlane } from "./actor.ts";
import { commitDecision, recordDeny, type Step } from "./decision.ts";
import { gateFail, type GateFailure } from "./gate-failure.ts";
import { projectJobRecord, requestCancel } from "./job-queue.ts";
import type { LeaseRow, StorageWriterPort } from "./ports.ts";

// Cancelling a job and asking for its cleanup again (§8 lines 278-279, §11, §14 line 419; issue #58).
//
// Both operations are deliberately narrow, and the narrowness is the rule rather than a limitation:
//   * `cancel` moves a job along §11's state machine and nothing else. A queued job becomes
//     cancelled; a running one becomes `cancelling`, which is the *request* and not the fact - the
//     executor that owns the run reports the interruption. A job that has already ended returns its
//     current record unchanged (完成态返回现状), because rewriting a terminal row would be §11's
//     终态不复活 through the back door.
//   * `retryCleanup` changes cleanup state only. It never re-runs the business operation, never
//     touches a report, and never schedules a lease it cannot prove this workbench minted - §5
//     allows reclaiming only owned resources, so an unprovable lease stays exactly where it is.
//
// Every request is journaled, including one that changed nothing: §12.2 keeps the operator's
// decisions, and "asked again, row already said that" is a fact worth reading back. What is *not*
// journaled is a refusal from the role gate, which `recordDeny` writes as a deny instead.

export type JobLifecycleDeps = { readonly storage: StorageWriterPort };

export class JobLifecycleService {
  readonly storage: StorageWriterPort;

  constructor(deps: JobLifecycleDeps) {
    this.storage = deps.storage;
  }

  private refused(projectId: Id, actor: Actor, action: string, jobId: Id, reason: string, message: string): Result<never, GateFailure> {
    recordDeny(this.storage, {
      projectId,
      actor,
      resourceType: "job",
      action,
      resourceId: jobId,
      decision: "deny",
      reasonCode: reason,
      metadata: {},
    });
    return gateFail("ACCESS_DENIED", reason, message, { actorKind: actor.actorKind });
  }

  cancel(projectId: Id, actor: Actor, jobId: Id): Result<JobRecord, GateFailure> {
    if (!isControlPlane(actor)) {
      return this.refused(projectId, actor, "job.cancel", jobId, "role-may-not-cancel-jobs", "only the control plane cancels a job (§7.3)");
    }
    const committed = commitDecision(this.storage, {
      projectId,
      actor,
      resourceType: "job",
      action: "job.cancel",
      resourceId: jobId,
      allowReason: "cancel-requested",
      metadata: {},
      work: (tx): Step<JobRecord> => {
        const row = tx.getJob(projectId, jobId);
        if (row === null) {
          return { kind: "failure", failure: gateFail("NOT_FOUND", "job-unknown", "no such job in this project") };
        }
        // `requestCancel` owns what a cancel means for each state (§11): queued becomes cancelled,
        // running becomes the request `cancelling`, and a job that has already ended comes back
        // unchanged because the transition table refuses it. There is deliberately no second
        // terminal check here - a guard no test can tell apart from the rule it guards is
        // decoration, and the table is the owner.
        const moved = requestCancel(row, nowInstant());
        tx.updateJob(moved);
        return { kind: "committed", value: projectJobRecord(moved, tx.listLeasesForJobs(projectId, [jobId])) };
      },
    });
    if (!committed.ok) return committed;
    return { ok: true, value: committed.value.value };
  }

  retryCleanup(projectId: Id, actor: Actor, jobId: Id): Result<CleanupRetryReceipt, GateFailure> {
    if (!isControlPlane(actor)) {
      return this.refused(projectId, actor, "job.cleanup-retry", jobId, "role-may-not-retry-cleanup", "only the control plane re-schedules cleanup (§7.3)");
    }
    const committed = commitDecision(this.storage, {
      projectId,
      actor,
      resourceType: "job",
      action: "job.cleanup-retry",
      resourceId: jobId,
      allowReason: "cleanup-re-scheduled",
      metadata: {},
      work: (tx): Step<Omit<CleanupRetryReceipt, "auditSeq">> => {
        const row = tx.getJob(projectId, jobId);
        if (row === null) {
          return { kind: "failure", failure: gateFail("NOT_FOUND", "job-unknown", "no such job in this project") };
        }
        const eligible = tx
          .listLeasesForJobs(projectId, [jobId])
          .filter((lease) => lease.cleanupState !== "complete" && ownsProof(lease));
        if (eligible.length === 0) {
          // Nothing to schedule: the job's own recorded state is returned rather than a new one.
          return {
            kind: "committed",
            value: { jobId, cleanupState: row.cleanupState, retryAt: null, leaseIds: [] },
          };
        }
        const at = nowInstant();
        for (const lease of eligible) {
          tx.updateLeaseCleanup(lease.id, "pending", null, at, lease.retryCount + 1);
        }
        return {
          kind: "committed",
          value: {
            jobId,
            // `pending` is what those leases now say. The job's own cleanup state is decided by
            // whoever finishes the work, so this reports the schedule it was handed, not a promise
            // that the cleanup succeeded.
            cleanupState: "pending",
            retryAt: at,
            leaseIds: eligible.map((lease) => lease.id),
          },
        };
      },
    });
    if (!committed.ok) return committed;
    return { ok: true, value: { ...committed.value.value, auditSeq: committed.value.auditSeq } };
  }
}

function ownsProof(lease: LeaseRow): boolean {
  const proof = lease.ownershipProofJson;
  return proof !== null && typeof proof === "object" && !Array.isArray(proof) && Object.keys(proof).length > 0;
}

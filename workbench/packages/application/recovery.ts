import type { JobState } from "../contracts/jobs.ts";
import { transition } from "./job-queue.ts";
import type { LeaseRow, StorageTransaction } from "./ports.ts";
import { nowInstant } from "../domain/identity.ts";

// Restart recovery (DESIGN §11).
//
// A lost executor is marked `interrupted`, its committed Evidence is kept, and its
// leases are only ever cleaned when the ownership proof says so. Nothing here
// deletes by path, by PID or by filename: §11 states those guesses explicitly.

export const RECOVERABLE_STATES: readonly JobState[] = ["running", "cancelling"];

export const OPEN_CLEANUP_STATES: readonly LeaseRow["cleanupState"][] = ["pending", "failed"];

export type RecoveryReport = {
  interruptedJobIds: string[];
  // A lease whose ownership proof this build cannot verify stays where it is, and
  // the report says so instead of quietly leaving it out.
  retainedLeaseIds: string[];
  unprovableLeaseIds: string[];
};

export function recoverJobs(tx: StorageTransaction, limit: number): RecoveryReport {
  const report: RecoveryReport = { interruptedJobIds: [], retainedLeaseIds: [], unprovableLeaseIds: [] };
  for (const job of tx.listJobsByStates(RECOVERABLE_STATES, limit)) {
    const at = nowInstant();
    const moved = transition(job, "interrupted", at);
    // No outgoing edge means the state machine does not allow this transition;
    // pretending otherwise would rewrite history rather than record the loss.
    if (moved === null) continue;
    tx.updateJob(moved);
    // The row moved, so §13's outbox has to say so: a mark of lost work is exactly the kind of
    // fact a subscriber cannot be expected to notice by re-reading, and recovery runs in a process
    // whose page may be holding a stream open from before the crash.
    tx.appendEvent({
      projectId: job.projectId,
      type: "job.updated",
      aggregateId: job.id,
      payloadJson: { resourceIds: [job.id], state: "interrupted" },
      createdAt: at,
    });
    report.interruptedJobIds.push(job.id);
  }
  for (const lease of tx.listOpenLeases(OPEN_CLEANUP_STATES, limit)) {
    report.retainedLeaseIds.push(lease.id);
    if (!ownershipProvable(lease)) report.unprovableLeaseIds.push(lease.id);
  }
  return report;
}

// An ownership proof is only provable when it names the minting owner and the
// exact resource it claimed; anything else is unknown, and unknown is kept.
export function ownershipProvable(lease: LeaseRow): boolean {
  const proof = lease.ownershipProofJson;
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)) return false;
  const record = proof as Record<string, unknown>;
  return typeof record["mintedBy"] === "string" && typeof record["jobId"] === "string" && record["jobId"] === lease.jobId;
}

export function recoveryTruncated(limit: number, seen: number): string[] {
  return seen >= limit ? [`recovery-scan-truncated:${String(limit)}`] : [];
}

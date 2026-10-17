import { z } from "zod";

import { apiErrorSchema } from "./errors.ts";
import { idSchema, instantSchema, nonEmptyString } from "./primitives.ts";

export const JOB_KINDS = ["capture", "inspect", "build", "verify"] as const;

export const JOB_STATES = [
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export const CLEANUP_STATES = ["pending", "complete", "failed"] as const;

export type JobKind = (typeof JOB_KINDS)[number];
export type JobState = (typeof JOB_STATES)[number];
export type CleanupState = (typeof CLEANUP_STATES)[number];

// State machine of DESIGN §11. `queued` may only reach running, failed or
// cancelled; a cancelled job never resumes, and recovery marks lost executors
// interrupted instead of replaying them.
export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["cancelling", "succeeded", "failed", "interrupted"],
  cancelling: ["cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
} as const;

export const TERMINAL_JOB_STATES: readonly JobState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export const jobRecordSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(JOB_KINDS),
  state: z.enum(JOB_STATES),
  cleanupState: z.enum(CLEANUP_STATES),
  deadlineAt: instantSchema.nullable(),
  retryAt: instantSchema.nullable(),
  cleanupRetryAt: instantSchema.nullable(),
  resultRef: z.string().min(1).nullable(),
  error: apiErrorSchema.nullable(),
});

export type JobRecord = z.infer<typeof jobRecordSchema>;

// §8 line 279's cleanup-retry answer. It names the leases that were re-scheduled and the time they
// were given, and nothing else: §14 says this operation may change cleanup state and nothing about
// the business result, so there is no field here a report could arrive in.
export const cleanupRetryReceiptSchema = z.strictObject({
  jobId: idSchema,
  cleanupState: z.enum(CLEANUP_STATES),
  retryAt: instantSchema.nullable(),
  leaseIds: z.array(idSchema),
  auditSeq: z.int().nonnegative(),
});

export type CleanupRetryReceipt = z.infer<typeof cleanupRetryReceiptSchema>;

// §8 line 278's cancel body is `{}`: the job is named by the path and the decision is the request
// itself, so a schema that accepts a field would be a door through which a second meaning could be
// smuggled. Strict-and-empty is how that sentence becomes checkable.
export const cancelRequestSchema = z.strictObject({});

// --- The project's job page (DESIGN §8 line 277 / issue #55) -------------------------
//
// §8 names this route as the way a client recovers a build or verification resource ID:
// the page carries each job's persisted `resultRef`, and a successful generation's
// resultRef is the candidate ID (line 294). Without it the code tab has a candidate read
// and nothing to address. The cursor is opaque because it is a row key this server issued,
// not a value the page composes; the bound is here so no caller turns the left column into
// a full table scan.

export const JOB_LIST_DEFAULT_LIMIT = 50;
export const JOB_LIST_MAX_LIMIT = 200;

export const jobListRequestSchema = z.strictObject({
  cursor: nonEmptyString.nullable().optional(),
  // The bound lives in the read service, which is the only place that can name the
  // refusal; the wire shape says what a limit is, not what the largest one is. An
  // omitted field and an explicit null are the same statement here, as elsewhere (§8).
  limit: z.int().min(1).nullable().optional(),
});

export const jobPageSchema = z.strictObject({
  items: z.array(jobRecordSchema),
  nextCursor: nonEmptyString.nullable(),
});

export type JobListRequest = z.infer<typeof jobListRequestSchema>;
export type JobPage = z.infer<typeof jobPageSchema>;

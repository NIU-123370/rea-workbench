import { z } from "zod";

import { apiErrorSchema } from "./errors.ts";
import { idSchema, instantSchema, nonEmptyString } from "./primitives.ts";
import { jobTaskSchema } from "./tasks.ts";
// Imported for the schemas below *and* re-exported: a re-export alone would not put these names in
// scope here, and a copy of the vocabulary in two files is what this move exists to remove.
import { CLEANUP_STATES, JOB_KINDS, JOB_STATES } from "../domain/job-states.ts";

// §11's machine is the domain's, not this file's: the page has to consult it too and cannot reach
// it through the zod primitives without pulling `node:crypto` into the browser bundle. Re-exported
// here so every existing importer of the contract keeps one name for each of these facts.
export {
  CLEANUP_STATES,
  JOB_KINDS,
  JOB_STATES,
  JOB_TRANSITIONS,
  TERMINAL_JOB_STATES,
  canTransitionJob,
  isTerminalJobState,
} from "../domain/job-states.ts";
export type { CleanupState, JobKind, JobState } from "../domain/job-states.ts";

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

// --- Asking for work (DESIGN §8 line 275 / issue #58) ---------------------------------
//
// The one route in §8's table whose body *is* a task: `CaptureTask | InspectTask`, the named union
// that is the whole instruction surface a target may receive (no JS, no shell, no arbitrary file
// access). Two fields here are not decoration:
//   * `expectedGraphRevision` is required rather than optional because §8's own note says
//     依赖图版本的写入必须带它, and a capture is such a write;
//   * `deadlineAt` stays optional, and when it is absent the profile's queue wait decides - the
//     service takes that number from the installed profile and invents nothing (§14).
// `sensitiveValues` is a field of the capture task that never reaches this request's stored or
// digested half (§12.1), which is why the service rebuilds the task rather than persisting what it
// was handed.
export const jobRequestSchema = z.strictObject({
  targetId: idSchema,
  expectedGraphRevision: z.int().nonnegative(),
  deadlineAt: instantSchema.optional(),
  task: jobTaskSchema,
});

export type JobRequest = z.infer<typeof jobRequestSchema>;

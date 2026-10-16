import { z } from "zod";

import { apiErrorSchema } from "./errors.ts";
import { ID_PATTERN, INSTANT_PATTERN } from "../domain/identity.ts";

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
  id: z.string().regex(ID_PATTERN),
  kind: z.enum(JOB_KINDS),
  state: z.enum(JOB_STATES),
  cleanupState: z.enum(CLEANUP_STATES),
  deadlineAt: z.string().regex(INSTANT_PATTERN).nullable(),
  retryAt: z.string().regex(INSTANT_PATTERN).nullable(),
  cleanupRetryAt: z.string().regex(INSTANT_PATTERN).nullable(),
  resultRef: z.string().min(1).nullable(),
  error: apiErrorSchema.nullable(),
});

export type JobRecord = z.infer<typeof jobRecordSchema>;

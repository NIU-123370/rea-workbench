// §11's job state machine, with no zod and no Node dependency in it.
//
// It lives here rather than only in `contracts/jobs.ts` for the same reason `domain/id.ts`
// exists next to `domain/identity.ts`: the browser island has to ask "is this row terminal?"
// before it offers a button, and the only other owner of that answer is reached through
// `contracts/primitives.ts` -> `domain/identity.ts` -> `node:crypto`. A second copy of the
// table in the UI would be worse than either - it could drift from the transitions the
// worker will actually accept - so the vocabulary lives where both sides can read it.

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

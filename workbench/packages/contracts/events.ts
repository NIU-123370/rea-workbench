import { z } from "zod";

import { CLEANUP_STATES, JOB_STATES } from "./jobs.ts";
import { idSchema, instantSchema, nonEmptyString, reaEvidenceIdSchema } from "./primitives.ts";

// Committed events (DESIGN §8, §8.1). The SSE `id` is the database `seq`, the
// `event` name is `type`, and delivery is at-least-once: consumers deduplicate
// by seq rather than by timestamp.

export const EVENT_TYPES = [
  "job.updated",
  "evidence.committed",
  "graph.updated",
  "vector.created",
  "vector.reviewed",
  "plan.reviewed",
  "contract.reviewed",
  "verification.completed",
  "resource.cleanup_failed",
  "report.stale",
] as const;

// Payloads carry references, states, revisions and the named deadline/retry
// times only. A strict object is what makes "no body, no source, no
// credentials, no model context" enforceable rather than aspirational.
export const eventPayloadSchema = z.strictObject({
  resourceIds: z.array(z.union([idSchema, reaEvidenceIdSchema])).optional(),
  state: z.enum(JOB_STATES).optional(),
  cleanupState: z.enum(CLEANUP_STATES).optional(),
  result: z.enum(["PASS", "FAIL", "UNKNOWN"]).optional(),
  graphRevision: z.int().nonnegative().optional(),
  inventoryRevision: z.int().nonnegative().optional(),
  deadlineAt: instantSchema.nullable().optional(),
  retryAt: instantSchema.nullable().optional(),
  cleanupRetryAt: instantSchema.nullable().optional(),
  reasonCode: nonEmptyString.optional(),
});

export const committedEventSchema = z.strictObject({
  seq: z.int().nonnegative(),
  projectId: idSchema,
  type: z.enum(EVENT_TYPES),
  aggregateId: z.union([idSchema, reaEvidenceIdSchema]),
  createdAt: instantSchema,
  payload: eventPayloadSchema,
});

export type EventType = (typeof EVENT_TYPES)[number];
export type CommittedEvent = z.infer<typeof committedEventSchema>;

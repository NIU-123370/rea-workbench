import { z } from "zod";

import { digestSchema, idSchema, instantSchema, jsonValueSchema, limitSchema, nonEmptyString } from "./primitives.ts";
import { jobRecordSchema } from "./jobs.ts";

// HAR ingestion contract (DESIGN §8 ingestion, §5 targets/jobs, D25, PRD F02/A01).
//
// The two things this file exists to make unrepresentable: a place to put a URL
// the workbench should visit, and a place to store a sensitive declaration. Both
// are absent on purpose — an upload records what the capture already contains, and
// a declaration lives only for the operation that supplied it.

export const CAPTURE_MEDIA_TYPES = [
  "application/json",
  "application/x-ndjson",
  "application/octet-stream",
] as const;

export const harImportCommandSchema = z.strictObject({
  // `filename` is display text chosen by the operator, never a path the workbench
  // opens: the bytes arrive in this request.
  filename: nonEmptyString.max(255),
  mediaType: z.enum(CAPTURE_MEDIA_TYPES),
  format: z.literal("har"),
  byteLength: z.int().nonnegative(),
  sourceSha256: digestSchema,
  idempotencyKey: nonEmptyString.max(200),
  deadlineAt: instantSchema.optional(),
  // A selection is allowed; the container still reports what it omitted.
  recordOrdinals: z.array(z.int().nonnegative()).min(1).max(5000).optional(),
});

// The declaration is a *command-time* value. It is deliberately not part of
// `harImportCommandSchema`'s persisted projection below, and no receipt echoes it.
export const harImportFieldsSchema = harImportCommandSchema.extend({
  sensitiveValues: z.array(nonEmptyString).optional(),
});

export const harImportReceiptSchema = z.strictObject({
  targetId: idSchema,
  // §8 line 272 answers `{targetId,job:JobRecord}`. The job is named by the same schema the job
  // read doors use, because it is the same row: a receipt that re-listed `jobId` and `jobState`
  // beside it would be two names for one fact, and the pair could drift.
  job: jobRecordSchema,
  leaseId: idSchema,
  sourceArtifactId: idSchema,
  // A file target's snapshot identity is its content digest, stated rather than
  // guessed: the snapshot exists before any producer has looked inside.
  snapshotDigest: digestSchema,
  byteLength: z.int().nonnegative(),
  reused: z.boolean(),
});

// The HTTP body §8 line 272 names, spelled out as a contract so the door answers exactly that and
// not the receipt's internal fields. `leaseId` and `sourceArtifactId` are real, but this route's
// third column does not list them, so they stay on the service-side receipt.
export const harImportHttpResponseSchema = z.strictObject({
  targetId: idSchema,
  job: jobRecordSchema,
});

// The projection `har.import` actually persists on its job row: the command minus the two
// command-time-only fields (`idempotencyKey`, `deadlineAt`) and plus the digest the store measured.
// It is a contract rather than an inline object literal because the writer and the runner read this
// column from opposite ends - the runner has to tell an ingestion job's row apart from a directed
// investigation's row (§8 line 310's `InspectTask`), and sniffing for a field name would make that
// choice depend on whichever field someone remembered to keep.
export const ingestionJobInputSchema = z.strictObject({
  filename: nonEmptyString.max(255),
  mediaType: z.enum(CAPTURE_MEDIA_TYPES),
  format: z.literal("har"),
  byteLength: z.int().nonnegative(),
  sourceSha256: digestSchema,
  // A selection is stated, an omitted selection is `null` - not an empty list, which would read as
  // "the operator asked for no records".
  recordOrdinals: z.array(z.int().nonnegative()).nullable(),
});

export type IngestionJobInput = z.infer<typeof ingestionJobInputSchema>;

export const inspectionCommandSchema = z.strictObject({
  projectId: idSchema,
  jobId: idSchema,
  // A job is driven from exactly one expected state. §11 gives `interrupted` no
  // outgoing edge — recovery marks the lost executor and the follow-up is a new
  // job, never a re-driven one — so resuming is not expressible here at all.
  expectedJobState: z.literal("queued"),
});

export const inspectionReceiptSchema = z.strictObject({
  jobId: idSchema,
  jobState: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
  // A retained-reference stop leaves the job failed but the lease still owned, so
  // the receipt has to be able to say which state the job actually is in.
  liveState: z.enum(["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted"]),
  evidenceIds: z.array(nonEmptyString),
  cleanupState: z.enum(["pending", "complete", "failed"]),
  // Retained-by-reference records were not re-run; they are named so a reader can
  // resolve them later (§9 item 7) instead of being silently dropped.
  retainedEvidenceIds: z.array(nonEmptyString),
});

export const importJobViewSchema = z.strictObject({
  id: idSchema,
  targetId: idSchema.nullable(),
  state: z.enum(["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted"]),
  cleanupState: z.enum(["pending", "complete", "failed"]),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  deadlineAt: instantSchema.nullable(),
  retryAt: instantSchema.nullable(),
  // Sanitized facts only: no body, no token, no model context.
  safeInput: jsonValueSchema,
});

export const importListQuerySchema = z.strictObject({
  targetId: idSchema.optional(),
  state: z.enum(["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted"]).optional(),
  limit: limitSchema.optional(),
});

export type HarImportCommand = z.infer<typeof harImportCommandSchema>;
export type HarImportFields = z.infer<typeof harImportFieldsSchema>;
export type HarImportReceipt = z.infer<typeof harImportReceiptSchema>;
export type InspectionCommand = z.infer<typeof inspectionCommandSchema>;
export type InspectionReceipt = z.infer<typeof inspectionReceiptSchema>;

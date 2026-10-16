import { z } from "zod";

import { jobRecordSchema } from "./jobs.ts";
import {
  digestSchema,
  idSchema,
  instantSchema,
  jsonValueSchema,
  nonEmptyString,
  reaEvidenceIdSchema,
} from "./primitives.ts";

// Projects, targets and file imports (DESIGN §8). A file target is only ever
// created by an import, and a URL target has no snapshot until it is captured.

export const createProjectRequestSchema = z.strictObject({
  name: nonEmptyString,
});

// The 201 body of `POST /projects` is exactly these four fields (§8), and a fresh
// project's graph revision is stated as zero rather than left to a default.
export const createdProjectSchema = z.strictObject({
  id: idSchema,
  name: nonEmptyString,
  graphRevision: z.literal(0),
  createdAt: instantSchema,
});

export const projectSummarySchema = z.strictObject({
  id: idSchema,
  name: nonEmptyString,
  graphRevision: z.int().nonnegative(),
  inventoryRevision: z.int().nonnegative(),
});

export const pagedSchema = <T extends z.ZodTypeAny>(items: T) =>
  z.strictObject({
    items: z.array(items),
    // A cursor the server mints; callers never construct one.
    nextCursor: z.string().min(1).max(512).nullable(),
  });

export const projectViewSchema = z.strictObject({
  id: idSchema,
  name: nonEmptyString,
  graphRevision: z.int().nonnegative(),
  inventoryRevision: z.int().nonnegative(),
  targetIds: z.array(idSchema),
  recentJobIds: z.array(idSchema),
});

export const createUrlTargetRequestSchema = z.strictObject({
  kind: z.literal("url"),
  url: z.string().url(),
});

export const pendingTargetSchema = z.strictObject({
  id: idSchema,
  kind: z.literal("url"),
  // Nothing has been observed yet, so the deployment identity stays unknown.
  snapshotDigest: z.null(),
  identityReason: nonEmptyString,
});

export const targetViewSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(["url", "har", "asar"]),
  sourceSha256: digestSchema.nullable(),
  snapshotDigest: digestSchema.nullable(),
  identityReason: nonEmptyString.nullable(),
  evidenceIds: z.array(reaEvidenceIdSchema),
  importJobId: idSchema.nullable(),
});

export const importFieldsSchema = z.strictObject({
  kind: z.enum(["har", "asar"]),
  deadlineAt: instantSchema.optional(),
  // Only a HAR import may carry short-lived declarations; ASAR support does
  // not exist upstream and must be refused rather than pretended (DESIGN §8).
  sensitiveValues: z.array(nonEmptyString).optional(),
});

export const importAcceptedSchema = z.strictObject({
  targetId: idSchema,
  job: jobRecordSchema,
});

// The stored-evidence read (§8 line 281): the provider envelope travels under `evidence`,
// not loose at the top level, and it is passed through verbatim (§4's rule that a schema
// object is transferred as the source stated it). The three companion fields are what the
// store already knew about those bytes - class-free media type, length, and the digest or
// the fact that the digest was withheld - so a page can say which envelope it is showing.
export const evidenceViewSchema = z.strictObject({
  evidence: jsonValueSchema,
  mediaType: nonEmptyString,
  byteLength: z.int().min(0),
  sha256: digestSchema.nullable(),
});

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type ImportFields = z.infer<typeof importFieldsSchema>;
export type TargetView = z.infer<typeof targetViewSchema>;

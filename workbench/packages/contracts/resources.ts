import { z } from "zod";

import { jobRecordSchema } from "./jobs.ts";
import {
  digestSchema,
  idSchema,
  instantSchema,
  nonEmptyString,
  reaEvidenceIdSchema,
} from "./primitives.ts";

// Projects, targets and file imports (DESIGN §8). A file target is only ever
// created by an import, and a URL target has no snapshot until it is captured.

export const createProjectRequestSchema = z.strictObject({
  name: nonEmptyString,
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

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type ImportFields = z.infer<typeof importFieldsSchema>;
export type TargetView = z.infer<typeof targetViewSchema>;

import { z } from "zod";

import { idSchema, instantSchema, jsonValueSchema, nonEmptyString } from "./primitives.ts";

// The audit reads (DESIGN §8 lines 302-303, §12.2).
//
// §12.2 makes the audit trail a *decision* journal: every allow and deny carries a named
// reason code and safe metadata that already went through the sanitizer. §8 then gives the
// local operator exactly two windows onto it — one project's rows, and the rows that belong
// to no project (startup, pairing, unauthenticated refusals). The two are different queries,
// not one query with an optional filter: reading them as one would let a missing project
// filter silently widen a page into another project's decisions.

// The field names are §12.2's list verbatim. `safeMetadata` is the sanitizer's output, so the
// shape is any JSON value and nothing here narrows it — §4's rule that a schema object is
// transferred as its source stated it, applied to a record the worker wrote.
export const auditEntrySchema = z.strictObject({
  seq: z.int().nonnegative(),
  projectId: idSchema.nullable(),
  actorId: nonEmptyString,
  actorKind: nonEmptyString,
  action: nonEmptyString,
  resourceType: nonEmptyString,
  resourceId: nonEmptyString.nullable(),
  decision: z.enum(["allow", "deny"]),
  reasonCode: nonEmptyString,
  safeMetadata: jsonValueSchema,
  createdAt: instantSchema,
});

// A page of the journal. The cursor is an integer `seq` rather than an opaque token because
// §8 names it as one, and because the journal is append-only: a `seq` a caller re-sends either
// names a row that exists or is refused, never silently reinterpreted.
export const auditPageSchema = z.strictObject({
  entries: z.array(auditEntrySchema),
  nextCursor: z.int().nonnegative().nullable(),
});

export const auditListRequestSchema = z.strictObject({
  after: z.int().nonnegative().nullable().optional(),
  // The bound is enforced by the read service, which is the only place that can name the
  // refusal; an omitted limit and an explicit null both mean "the default page".
  limit: z.int().min(1).nullable().optional(),
});

export const AUDIT_LIST_DEFAULT_LIMIT = 100;
export const AUDIT_LIST_MAX_LIMIT = 500;

export type AuditEntryWire = z.infer<typeof auditEntrySchema>;
export type AuditPageWire = z.infer<typeof auditPageSchema>;
export type AuditListRequest = z.infer<typeof auditListRequestSchema>;

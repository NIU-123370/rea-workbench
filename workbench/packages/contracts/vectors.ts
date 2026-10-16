import { z } from "zod";

import { BODY_KINDS } from "../domain/vector.ts";
import {
  digestSchema,
  idSchema,
  instantSchema,
  jsonValueSchema,
  limitSchema,
  nonEmptyString,
  reaEvidenceIdSchema,
} from "./primitives.ts";

// Wire shapes for sample vectors (DESIGN §7.1, §8). The domain owns the types
// so the projection rules have one owner; this file owns what a caller may send,
// and the create request deliberately has no place to put a request or response.

export const nameValueSchema = z.strictObject({
  name: nonEmptyString,
  value: z.string(),
});

export const bodyValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("missing"), reason: nonEmptyString }),
  z.strictObject({ kind: z.literal("empty") }),
  z.strictObject({
    kind: z.literal("text"),
    text: z.string(),
    provenance: z.literal("producer-decoded"),
  }),
  z.strictObject({ kind: z.literal("bytes"), base64: z.string(), sha256: digestSchema }),
  z.strictObject({ kind: z.literal("redacted"), reason: nonEmptyString }),
]);

export const vectorRequestSchema = z.strictObject({
  method: z.string().nullable(),
  url: z.string().nullable(),
  query: z.array(nameValueSchema),
  headers: z.array(nameValueSchema),
  body: bodyValueSchema,
});

export const vectorResponseSchema = z.strictObject({
  // A real HTTP status is 100..599; `null` is the only way "not recorded" is
  // expressed, so a 0 can never be mistaken for an unknown status.
  status: z.int().min(100).max(599).nullable(),
  headers: z.array(nameValueSchema),
  body: bodyValueSchema,
});

export const expectedOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("return"), value: jsonValueSchema }),
  z.strictObject({ kind: z.literal("throw"), code: nonEmptyString, detail: jsonValueSchema }),
]);

export const coverageSchema = z.strictObject({
  state: z.enum(["complete", "partial", "unknown", "unavailable"]),
  examined: z.int().nonnegative().nullable(),
  total: z.int().nonnegative().nullable(),
  reasons: z.array(nonEmptyString),
});

export const redactionSchema = z.strictObject({
  fieldPointer: nonEmptyString,
  reason: z.enum(["transport-auth", "explicit-sensitive"]),
  representation: z.literal("omitted"),
});

export const vectorSourceSchema = z.strictObject({
  evidenceId: reaEvidenceIdSchema,
  captureId: idSchema.nullable(),
  recordOrdinal: z.int().nonnegative().nullable(),
  pointer: z.string().nullable(),
  transactionId: z.string().nullable(),
});

export const vectorReviewSchema = z.strictObject({
  status: z.enum(["draft", "approved", "rejected"]),
  reviewerId: nonEmptyString.nullable(),
  reviewedAt: instantSchema.nullable(),
  approvedDigest: digestSchema.nullable(),
}).superRefine((review, ctx) => {
  // The pairing is what keeps "approved" from meaning "someone looked at it":
  // an approval without a reviewer, a time or the digest it approved is invalid.
  const attributed = review.reviewerId !== null && review.reviewedAt !== null;
  if (review.status === "draft" && (attributed || review.approvedDigest !== null)) {
    ctx.addIssue({ code: "custom", message: "a draft review carries no attribution or digest" });
  }
  if (review.status === "approved" && (!attributed || review.approvedDigest === null)) {
    ctx.addIssue({ code: "custom", message: "an approval needs reviewer, instant and digest" });
  }
  if (review.status === "rejected" && (!attributed || review.approvedDigest !== null)) {
    ctx.addIssue({ code: "custom", message: "a rejection needs attribution and has no digest" });
  }
});

const contentFields = {
  id: idSchema,
  targetId: idSchema,
  snapshotDigest: digestSchema,
  operationId: nonEmptyString,
  sdkInput: jsonValueSchema,
  caseKey: nonEmptyString,
  replacesId: idSchema.nullable(),
  source: vectorSourceSchema,
  request: vectorRequestSchema,
  response: vectorResponseSchema,
  expectedOutcome: expectedOutcomeSchema.nullable(),
  coverage: coverageSchema,
  limitations: z.array(z.string()),
  redactions: z.array(redactionSchema),
  visibility: z.enum(["public", "holdout"]),
  eligibility: z.enum(["usable", "blocked"]),
  reasons: z.array(nonEmptyString),
};

export const testVectorContentSchema = z.strictObject(contentFields);

export const testVectorSchema = z.strictObject({
  ...contentFields,
  digest: digestSchema,
  review: vectorReviewSchema,
});

// What an Inspector may ask for: identity of the evidence record plus the SDK-facing
// interpretation. `request`, `response`, `coverage`, `redactions`, `eligibility`
// and `reasons` are absent, and `strictObject` is what makes their presence a
// refusal rather than something to ignore (DESIGN §7.1 "请求不得直接上传替代的
// 预期 HTTP request/response").
export const vectorCreateRequestSchema = z.strictObject({
  targetId: idSchema,
  snapshotDigest: digestSchema,
  source: vectorSourceSchema,
  operationId: nonEmptyString,
  caseKey: nonEmptyString,
  sdkInput: jsonValueSchema,
  expectedOutcome: expectedOutcomeSchema.nullable(),
  visibility: z.enum(["public", "holdout"]),
  // The revision chain link is Inspector intent, so it is caller-supplied — but
  // only a link, never content: §7.4 forbids replacing a different source record.
  replacesId: idSchema.nullable(),
});

// The reviewer names the digest they looked at, so approving a vector that was
// replaced underneath the review is a conflict rather than a silent pass.
export const vectorReviewRequestSchema = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  reviewerId: nonEmptyString,
  digest: digestSchema.nullable(),
  expectedInventoryRevision: z.int().nonnegative(),
}).superRefine((request, ctx) => {
  if (request.decision === "approved" && request.digest === null) {
    ctx.addIssue({ code: "custom", message: "an approval must name the digest it approved" });
  }
});

// The vector review route's own body and receipt (§8 line 285 / issue #58). Same two rules as
// the contract and plan review surface: `expectedDigest` is the document's name for what the
// service calls `digest`, and no caller may name its own reviewer - the session does that.
export const vectorReviewHttpRequestSchema = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  expectedDigest: digestSchema.nullable(),
  expectedInventoryRevision: z.int().nonnegative(),
});

export const vectorReviewReceiptSchema = z.strictObject({
  vectorId: idSchema,
  digest: digestSchema,
  eligibility: z.enum(["usable", "blocked"]),
  reasons: z.array(nonEmptyString),
  inventoryRevision: z.int().nonnegative(),
  auditSeq: z.int().nonnegative(),
  eventSeq: z.int().nonnegative().nullable(),
});

// --- The inventory page (§8 line 283 / issue #58) ------------------------------------
//
// §8 gives this route three query slots - `targetId`, an optional `cursor` and an optional
// `limit` - and one reply: the project's current `inventoryRevision`, a page of summaries, and
// a cursor or null. A summary is the six fields it names, and no body: the listing is a
// disclosure surface (holdout rows are a control-plane-only matter, and a row's request/response
// bytes only ever come back through the named single-vector read).

export const vectorSummarySchema = z.strictObject({
  id: idSchema,
  digest: digestSchema,
  caseKey: nonEmptyString,
  visibility: z.enum(["public", "holdout"]),
  eligibility: z.enum(["usable", "blocked"]),
  review: vectorReviewSchema,
});

export const vectorPageSchema = z.strictObject({
  inventoryRevision: z.int().nonnegative(),
  items: z.array(vectorSummarySchema),
  // Opaque here even though the audit journal's cursor is a plain integer, because §8 calls
  // this one a "稳定快照游标": it pins the inventory revision the page was cut at, and a
  // client re-sending it after the inventory moved is a conflict, not a reinterpretation.
  nextCursor: nonEmptyString.nullable(),
});

export const vectorPageQuerySchema = z.strictObject({
  targetId: idSchema,
  cursor: nonEmptyString.nullable().optional(),
  // The page bound is enforced by the read service, which is the only place that can name the
  // refusal. Null and absent both mean "the default page", as elsewhere in §8.
  limit: z.int().min(1).nullable().optional(),
});

export const VECTOR_PAGE_DEFAULT_LIMIT = 50;
export const VECTOR_PAGE_MAX_LIMIT = 200;

export const vectorListQuerySchema = z.strictObject({
  targetId: idSchema.optional(),
  snapshotDigest: digestSchema.optional(),
  visibility: z.enum(["public", "holdout"]).optional(),
  eligibility: z.enum(["usable", "blocked"]).optional(),
  reviewStatus: z.enum(["draft", "approved", "rejected"]).optional(),
  limit: limitSchema.optional(),
});

export type VectorCreateRequest = z.infer<typeof vectorCreateRequestSchema>;
export type VectorReviewRequest = z.infer<typeof vectorReviewRequestSchema>;
export type VectorListQuery = z.infer<typeof vectorListQuerySchema>;
export type VectorSummary = z.infer<typeof vectorSummarySchema>;
export type VectorPage = z.infer<typeof vectorPageSchema>;
export type VectorPageQuery = z.infer<typeof vectorPageQuerySchema>;
export type TestVectorRecord = z.infer<typeof testVectorSchema>;
export type TestVectorWireContent = z.infer<typeof testVectorContentSchema>;

export { BODY_KINDS };

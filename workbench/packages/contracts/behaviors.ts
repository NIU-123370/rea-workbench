import { z } from "zod";

import { vectorReviewSchema } from "./vectors.ts";
import {
  digestSchema,
  idSchema,
  instantSchema,
  jsonValueSchema,
  limitSchema,
  nonEmptyString,
} from "./primitives.ts";

// Wire shapes for behaviour contracts and frozen plans (DESIGN §7.2, §7.4, §8).
//
// Two absences carry the design: a plan-build request has no `selectedVectorIds`
// field, and an exclusion has no `blocked` reason code. Both are therefore
// refused at parse time instead of being validated away downstream.

export const httpResponsesSchema = z.strictObject({
  status: z.int().min(100).max(599),
  mediaType: z.string().nullable(),
  schema: jsonValueSchema,
});

export const httpOperationSchema = z.strictObject({
  operationId: nonEmptyString,
  // method and path keep the source spelling; template generalisation is a
  // separate claim to be proven, never a rewrite here (§7.2).
  method: nonEmptyString,
  path: nonEmptyString,
  requestMediaType: z.string().nullable(),
  responses: z.array(httpResponsesSchema),
});

export const contractScopeSchema = z.strictObject({
  snapshotDigest: digestSchema,
  operationIds: z.array(nonEmptyString),
  excludedBehaviors: z.array(nonEmptyString),
});

export const requiredCaseSchema = z.strictObject({
  caseKey: nonEmptyString,
  claimId: idSchema,
  kind: z.enum(["success", "error", "edge"]),
  vectorIds: z.array(idSchema),
});

const contractContentFields = {
  id: idSchema,
  contractKey: nonEmptyString,
  revision: z.int().min(1),
  targetId: idSchema,
  scope: contractScopeSchema,
  behaviorSpec: nonEmptyString,
  inputSchema: jsonValueSchema,
  outputSchema: jsonValueSchema,
  httpOperations: z.array(httpOperationSchema),
  errorCases: z.array(z.string()),
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
  sourceClaimIds: z.array(idSchema),
  requiredCases: z.array(requiredCaseSchema),
};

export const contractRevisionContentSchema = z.strictObject(contractContentFields);

export const contractRevisionSchema = z.strictObject({
  ...contractContentFields,
  digest: digestSchema,
  review: vectorReviewSchema,
});

// A new revision is created by content, never by editing an approved one, so the
// request carries no `revision` and no `review`.
export const contractDraftRequestSchema = z.strictObject({
  contractKey: nonEmptyString,
  targetId: idSchema,
  scope: contractScopeSchema,
  behaviorSpec: nonEmptyString,
  inputSchema: jsonValueSchema,
  outputSchema: jsonValueSchema,
  httpOperations: z.array(httpOperationSchema),
  errorCases: z.array(z.string()),
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
  sourceClaimIds: z.array(idSchema),
  requiredCases: z.array(requiredCaseSchema),
});

export const contractReviewRequestSchema = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  reviewerId: nonEmptyString,
  digest: digestSchema.nullable(),
}).superRefine((request, ctx) => {
  if (request.decision === "approved" && request.digest === null) {
    ctx.addIssue({ code: "custom", message: "an approval must name the digest it approved" });
  }
});

// --- The review routes' own surface (§8 lines 287 and 291 / issue #58) -----------------
//
// Two deliberate differences from the service request schemas above, and both are the point.
//
// `expectedDigest` is §8's spelling; the service calls the same value `digest`. The boundary
// speaks the documented name and the handler maps it, so the document stays the contract a
// page can code against.
//
// There is no `reviewerId` field here, and `strictObject` is what makes a caller that sends
// one a refusal rather than a suggestion. The service stores the reviewer *in the review record
// the blueprint freeze later cites*, so a route that relayed a caller-named reviewer would let
// any session write someone else's approval into the durable record. The handler writes the
// session's own reviewer id and nothing else can.
//
// §8 also names a `note:string`. Nothing in the storage model or §12.2's journal field list has
// an owner for it, so this schema does not accept one: a page must not be able to believe it
// recorded a reason that no row kept. Recorded as a deviation on issue #58 rather than dropped in
// silence.

export const REVIEW_DECISIONS = ["approved", "rejected"] as const;

// What a record's review field can *hold*, which is one wider than what a caller may decide:
// a fresh creation is a draft, and the same receipt shape serves the create door and the review
// door. Naming the two apart is what caught me reusing the decision enum for a draft reply.
export const REVIEW_STATUSES = ["draft", "approved", "rejected"] as const;

export const contractReviewHttpRequestSchema = z.strictObject({
  decision: z.enum(REVIEW_DECISIONS),
  expectedDigest: digestSchema.nullable(),
});

export const planReviewHttpRequestSchema = z.strictObject({
  decision: z.enum(REVIEW_DECISIONS),
  expectedDigest: digestSchema.nullable(),
  expectedInventoryRevision: z.int().nonnegative(),
});

// The receipts are what these commands answer: the commit each service makes about one row, so
// the create door and the review door share a shape instead of inventing two. They are *not* the
// record - §8's third column names the full record for the read routes, and those have their own
// bodies (`contractRevisionSchema`, `verificationPlanSchema`, reached through `contract.read` and
// `plan.read`). Naming the receipt separately is what keeps a creation from being read as if it
// had answered a question it was never asked.
export const contractCommitReceiptSchema = z.strictObject({
  contractId: idSchema,
  contractKey: nonEmptyString,
  revision: z.int().nonnegative(),
  digest: digestSchema,
  reviewStatus: z.enum(REVIEW_STATUSES),
  auditSeq: z.int().nonnegative(),
  eventSeq: z.int().nonnegative().nullable(),
});

export const planCommitReceiptSchema = z.strictObject({
  planId: idSchema,
  digest: digestSchema,
  inventoryDigest: digestSchema,
  selectedCount: z.int().nonnegative(),
  excludedCount: z.int().nonnegative(),
  graphRevision: z.int().nonnegative(),
  inventoryRevision: z.int().nonnegative(),
  reviewStatus: z.enum(REVIEW_STATUSES),
  auditSeq: z.int().nonnegative(),
  eventSeq: z.int().nonnegative().nullable(),
});

export const excludedVectorSchema = z.discriminatedUnion("reasonCode", [
  z.strictObject({
    vectorId: idSchema,
    reasonCode: z.literal("outside-scope"),
    reason: nonEmptyString,
    excludedBehavior: nonEmptyString,
    supersededBy: z.null(),
  }),
  z.strictObject({
    vectorId: idSchema,
    reasonCode: z.literal("superseded"),
    reason: nonEmptyString,
    excludedBehavior: nonEmptyString,
    supersededBy: idSchema,
  }),
]);

const planContentFields = {
  id: idSchema,
  targetId: idSchema,
  snapshotDigest: digestSchema,
  contractRevisionIds: z.array(idSchema),
  graphRevision: z.int().nonnegative(),
  inventoryRevision: z.int().nonnegative(),
  inventoryDigest: digestSchema,
  selectedVectorIds: z.array(idSchema),
  excludedVectors: z.array(excludedVectorSchema),
};

export const verificationPlanContentSchema = z.strictObject(planContentFields);

export const verificationPlanSchema = z.strictObject({
  ...planContentFields,
  digest: digestSchema,
  review: vectorReviewSchema,
  createdAt: instantSchema,
});

// The build request names the inputs the derivation consumes. There is no field
// for `selectedVectorIds` and none for `inventoryDigest`: §7.4 makes both a
// function of the approved contracts plus the frozen snapshot.
export const planBuildRequestSchema = z.strictObject({
  targetId: idSchema,
  snapshotDigest: digestSchema,
  contractRevisionIds: z.array(idSchema).min(1),
  excludedVectors: z.array(excludedVectorSchema),
  expectedInventoryRevision: z.int().nonnegative(),
});

export const planReviewRequestSchema = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  reviewerId: nonEmptyString,
  digest: digestSchema.nullable(),
  expectedInventoryRevision: z.int().nonnegative(),
}).superRefine((request, ctx) => {
  if (request.decision === "approved" && request.digest === null) {
    ctx.addIssue({ code: "custom", message: "an approval must name the digest it approved" });
  }
});

// §8 line 289's plan creation body. It is the service's `planBuildRequestSchema` with the
// document's name for one field: §8 calls the list `exclusions`, the service calls the identical
// list `excludedVectors`, and the door maps between them in one line. The item shape is not
// redeclared here - a second definition of the same record is how two doors start disagreeing.
export const planBuildHttpRequestSchema = z.strictObject({
  targetId: idSchema,
  snapshotDigest: digestSchema,
  contractRevisionIds: z.array(idSchema).min(1),
  exclusions: z.array(excludedVectorSchema),
  expectedInventoryRevision: z.int().nonnegative(),
});

export const planListQuerySchema = z.strictObject({
  targetId: idSchema.optional(),
  reviewStatus: z.enum(["draft", "approved", "rejected"]).optional(),
  limit: limitSchema.optional(),
});

export type PlanContentWire = z.infer<typeof verificationPlanContentSchema>;
export type ContractContentWire = z.infer<typeof contractRevisionContentSchema>;
export type ContractDraftRequest = z.infer<typeof contractDraftRequestSchema>;
export type ContractReviewRequest = z.infer<typeof contractReviewRequestSchema>;
export type ContractRevisionWire = z.infer<typeof contractRevisionSchema>;
export type PlanBuildRequest = z.infer<typeof planBuildRequestSchema>;
export type PlanReviewRequest = z.infer<typeof planReviewRequestSchema>;
export type VerificationPlanWire = z.infer<typeof verificationPlanSchema>;
export type ExcludedVectorWire = z.infer<typeof excludedVectorSchema>;


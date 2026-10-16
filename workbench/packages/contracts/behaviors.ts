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


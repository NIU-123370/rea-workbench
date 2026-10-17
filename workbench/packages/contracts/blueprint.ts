import { z } from "zod";

import { digestSchema, idSchema, instantSchema, jsonValueSchema, nonEmptyString } from "./primitives.ts";

// The Builder-facing handoff and the control plane's own source manifest
// (DESIGN §7.3, D12/D13). Both are strict objects: the handoff because an
// unmodelled field would be a disclosure, the manifest because a stray field here
// is harmless but a missing one would lose provenance.

export const publicHttpOperationSchema = z.strictObject({
  operationId: nonEmptyString,
  method: nonEmptyString,
  path: nonEmptyString,
  requestMediaType: z.string().nullable(),
  responses: z.array(
    z.strictObject({
      status: z.int().min(100).max(599),
      mediaType: z.string().nullable(),
      schema: jsonValueSchema,
    }),
  ),
});

export const publicBodyValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("missing"), reason: nonEmptyString }),
  z.strictObject({ kind: z.literal("empty") }),
  z.strictObject({ kind: z.literal("text"), text: z.string(), provenance: z.literal("producer-decoded") }),
  z.strictObject({ kind: z.literal("bytes"), base64: z.string(), sha256: digestSchema }),
  z.strictObject({ kind: z.literal("redacted"), reason: nonEmptyString }),
]);

const nameValueSchema = z.strictObject({ name: nonEmptyString, value: z.string() });

export const publicRequestSchema = z.strictObject({
  method: z.string().nullable(),
  url: z.string().nullable(),
  query: z.array(nameValueSchema),
  headers: z.array(nameValueSchema),
  body: publicBodyValueSchema,
});

export const publicResponseSchema = z.strictObject({
  status: z.int().min(100).max(599).nullable(),
  headers: z.array(nameValueSchema),
  body: publicBodyValueSchema,
});

export const publicCoverageSchema = z.strictObject({
  state: z.enum(["complete", "partial", "unknown", "unavailable"]),
  examined: z.int().nonnegative().nullable(),
  total: z.int().nonnegative().nullable(),
  reasons: z.array(nonEmptyString),
});

export const publicExpectedOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("return"), value: jsonValueSchema }),
  z.strictObject({ kind: z.literal("throw"), code: nonEmptyString, detail: jsonValueSchema }),
]);

export const publicTestVectorSchema = z.strictObject({
  id: idSchema,
  operationId: nonEmptyString,
  sdkInput: jsonValueSchema,
  request: publicRequestSchema,
  response: publicResponseSchema,
  // A public vector without an oracle cannot be compared, so the handoff makes it
  // impossible rather than nullable (§7.3).
  expectedOutcome: publicExpectedOutcomeSchema,
  coverage: publicCoverageSchema,
  limitations: z.array(z.string()),
});

export const blueprintContractEntrySchema = z.strictObject({
  contractKey: nonEmptyString,
  revision: z.int().min(1),
  digest: digestSchema,
  behaviorSpec: nonEmptyString,
  inputSchema: jsonValueSchema,
  outputSchema: jsonValueSchema,
  httpOperations: z.array(publicHttpOperationSchema),
  errorCases: z.array(z.string()),
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
});

// Exactly the §7.3 list, in that spelling. `source`, `targetId`, `snapshotDigest`,
// `evidenceId`, storage keys and file paths are absent — there is no field for
// them, which is what makes the allowlist checkable instead of aspirational.
export const builderBlueprintSchema = z.strictObject({
  schemaVersion: z.literal(1),
  blueprintId: idSchema,
  blueprintDigest: digestSchema,
  contractRevisions: z.array(blueprintContractEntrySchema),
  publicVectors: z.array(publicTestVectorSchema),
  generation: z.strictObject({
    language: z.literal("typescript"),
    outputKind: z.literal("http-sdk"),
    openapiVersion: z.literal("3.1.1"),
  }),
  verificationScope: z.array(nonEmptyString),
});

export const blueprintFreezeRequestSchema = z.strictObject({
  planId: idSchema,
});

// --- The freeze route (§8 line 292 / issue #58) --------------------------------------
//
// §8 pictures this body as `{targetId, contractRevisionIds, verificationPlanId,
// expectedGraphRevision, sensitiveValues?}`. The service takes one field, and §7.4 is why: the
// target, the contracts and the graph revision are all *functions of the approved plan* - the
// freeze re-reads them inside its own transaction and refuses when the graph has moved since the
// plan was cut. A caller that could restate them would be handing the route facts it is not
// allowed to decide, and `strictObject` is what makes that a named refusal rather than an ignored
// extra field. §8's `expectedGraphRevision` is therefore subsumed: the plan row's own revision is
// the concurrency token, and it is server-held.
//
// `sensitiveValues` is the one name in that list the route does honour, because §8 and §12.1 line
// 441 both type it differently from the other four: it is not a fact about the plan, it is the
// operation's exclusion context. So it is optional here, and the door forwards it to the worker's
// frame context instead of the freeze request - the published blueprint is digested over what the
// plan decided, never over what the caller asked to be hidden.
export const blueprintFreezeHttpRequestSchema = z.strictObject({
  verificationPlanId: idSchema,
  sensitiveValues: z.array(nonEmptyString).optional(),
});

// The receipt is what the freeze proves at the moment it commits: which plan became a blueprint,
// the digest the Builder will be handed, the manifest digest, and the three counts the gate
// verified. §8's third column also names `planDigest`, `scope` and `limitations`; those live in
// the blueprint artifact's payload rather than in the commit, and reading the artifact back is
// `GET /blueprints/:b` (`blueprintReadSchema` below). Inventing them here would put words in a
// reply the freeze command did not answer.
export const blueprintFreezeReceiptSchema = z.strictObject({
  blueprintId: idSchema,
  digest: digestSchema,
  manifestDigest: digestSchema,
  planId: idSchema,
  publicVectorCount: z.int().nonnegative(),
  holdoutVectorCount: z.int().nonnegative(),
  contractCount: z.int().nonnegative(),
  auditSeq: z.int().nonnegative(),
});

// §8 line 293's blueprint read: the frozen handoff, plus the two facts that place it (the row id
// and the digest the Builder will be handed) and - for the control plane only - which plan it was
// cut from. There is deliberately no field here for the source manifest or the holdout list:
// §8 says no role reads them through this interface, and a schema with no place for them is the
// checkable version of that sentence.
export const blueprintReadSchema = z.strictObject({
  id: idSchema,
  digest: digestSchema,
  scope: z.array(nonEmptyString),
  bundle: builderBlueprintSchema,
  verificationPlanId: idSchema.nullable(),
});

export const sourceManifestClaimSchema = z.strictObject({
  contractDigest: digestSchema,
  claimId: idSchema,
  evidenceIds: z.array(nonEmptyString),
  sourceLocations: z.array(jsonValueSchema),
});

export const sourceManifestHoldoutSchema = z.strictObject({
  vectorId: idSchema,
  caseKey: nonEmptyString,
  operationId: nonEmptyString,
  digest: digestSchema,
});

export const blueprintSourceManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  blueprintId: idSchema,
  blueprintDigest: digestSchema,
  manifestDigest: digestSchema,
  projectId: idSchema,
  targetId: idSchema,
  snapshotDigest: digestSchema,
  graphRevision: z.int().nonnegative(),
  planId: idSchema,
  planDigest: digestSchema,
  inventoryDigest: digestSchema,
  selectedVectorIds: z.array(idSchema),
  excludedVectorReasons: z.array(
    z.strictObject({
      vectorId: idSchema,
      reasonCode: z.enum(["outside-scope", "superseded"]),
      excludedBehavior: nonEmptyString,
    }),
  ),
  claims: z.array(sourceManifestClaimSchema),
  holdoutVectorIds: z.array(sourceManifestHoldoutSchema),
  reviewAttribution: z.array(
    z.strictObject({
      reviewerId: nonEmptyString,
      reviewedAt: instantSchema,
      approvedDigest: digestSchema,
    }),
  ),
  // Advisory findings from the source-text detector. The human review owns the
  // conclusion (§7.3), so this records what automation noticed, not a verdict.
  sourceTextSuspicions: z.array(nonEmptyString),
});

export type BuilderBlueprintWire = z.infer<typeof builderBlueprintSchema>;
export type PublicTestVectorWire = z.infer<typeof publicTestVectorSchema>;
export type BlueprintFreezeRequest = z.infer<typeof blueprintFreezeRequestSchema>;
export type BlueprintSourceManifestWire = z.infer<typeof blueprintSourceManifestSchema>;

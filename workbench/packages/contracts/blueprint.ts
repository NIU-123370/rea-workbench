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

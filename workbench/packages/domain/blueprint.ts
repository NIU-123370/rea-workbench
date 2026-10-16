import type { CanonicalLimits, Digest } from "./canonical-json.ts";
import { digestCanonicalJson } from "./canonical-json.ts";
import type { Coverage } from "./evidence.ts";
import { blocksStrictBlueprint, projectClaim } from "./evidence.ts";
import type { ClaimEvidenceState } from "./evidence.ts";
import type { Id, Instant } from "./identity.ts";
import type { JsonValue, JsonObject } from "./json-value.ts";
import type { HttpOperation } from "./contract.ts";
import type { BodyValue, ExpectedOutcome, NameValue, RequestSide, ResponseSide, TestVector } from "./vector.ts";

// BuilderBlueprint: an independent allowlist serialization (DESIGN §7.3, D12).
//
// This module is the only place that decides what leaves the control plane. It is
// written field by field on purpose: `{...vector}` or "delete a few keys" would
// make the disclosure surface whatever the source object happens to contain, and
// the next field added upstream would be handed to the Builder silently.

export const BLUEPRINT_SCHEMA_VERSION = 1;
export const GENERATION_LANGUAGE = "typescript";
export const GENERATION_OUTPUT_KIND = "http-sdk";
export const OPENAPI_VERSION = "3.1.1";

export type BlueprintContractEntry = {
  contractKey: string;
  revision: number;
  digest: Digest;
  behaviorSpec: string;
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  httpOperations: HttpOperation[];
  errorCases: string[];
  limitations: string[];
  unknowns: string[];
};

export type PublicTestVector = {
  id: Id;
  operationId: string;
  sdkInput: JsonValue;
  request: RequestSide;
  response: ResponseSide;
  expectedOutcome: ExpectedOutcome;
  coverage: Coverage;
  limitations: string[];
};

export type BlueprintPayload = {
  schemaVersion: number;
  blueprintId: Id;
  blueprintDigest: Digest;
  contractRevisions: BlueprintContractEntry[];
  publicVectors: PublicTestVector[];
  generation: {
    language: typeof GENERATION_LANGUAGE;
    outputKind: typeof GENERATION_OUTPUT_KIND;
    openapiVersion: typeof OPENAPI_VERSION;
  };
  verificationScope: string[];
};

// Everything the Builder must never see lives here, in the control plane's own
// manifest (§7.3): claim→Evidence→source location, the target snapshot, holdout
// references and the storage keys that point at files.
export type SourceManifestClaimEntry = {
  contractDigest: Digest;
  claimId: Id;
  evidenceIds: string[];
  sourceLocations: JsonValue[];
};

export type SourceManifestHoldoutEntry = {
  vectorId: Id;
  caseKey: string;
  operationId: string;
  digest: Digest;
};

export type SourceManifest = {
  schemaVersion: number;
  blueprintId: Id;
  blueprintDigest: Digest;
  manifestDigest: Digest;
  projectId: Id;
  targetId: Id;
  snapshotDigest: Digest;
  graphRevision: number;
  planId: Id;
  planDigest: Digest;
  inventoryDigest: Digest;
  selectedVectorIds: Id[];
  excludedVectorReasons: { vectorId: Id; reasonCode: string; excludedBehavior: string }[];
  claims: SourceManifestClaimEntry[];
  holdoutVectorIds: SourceManifestHoldoutEntry[];
  // §7.3: a human reviewer confirmed the spec text carries no source code. The
  // automatic detector below is a helper, never the legal conclusion.
  reviewAttribution: { reviewerId: string; reviewedAt: Instant; approvedDigest: Digest }[];
  // Advisory findings from the source-text detector (§7.3). Automation records
  // what it suspected; the reviewer attribution above is the conclusion.
  sourceTextSuspicions: string[];
};

function bodyToJson(body: BodyValue): JsonObject {
  switch (body.kind) {
    case "missing":
      return { kind: "missing", reason: body.reason };
    case "empty":
      return { kind: "empty" };
    case "text":
      return { kind: "text", text: body.text, provenance: body.provenance };
    case "bytes":
      return { kind: "bytes", base64: body.base64, sha256: body.sha256 };
    case "redacted":
      return { kind: "redacted", reason: body.reason };
  }
}

function sideToJson(side: RequestSide): JsonObject {
  return {
    method: side.method,
    url: side.url,
    query: side.query.map((pair: NameValue) => ({ name: pair.name, value: pair.value })),
    headers: side.headers.map((pair: NameValue) => ({ name: pair.name, value: pair.value })),
    body: bodyToJson(side.body),
  };
}

function responseToJson(side: ResponseSide): JsonObject {
  return {
    status: side.status,
    headers: side.headers.map((pair: NameValue) => ({ name: pair.name, value: pair.value })),
    body: bodyToJson(side.body),
  };
}

// Only a usable, publicly visible vector with an independent oracle can be
// projected. Anything else returns null so the caller has to account for the gap
// instead of shipping a vector whose expected outcome is missing.
export function publicVectorOf(vector: TestVector): PublicTestVector | null {
  if (vector.visibility !== "public") return null;
  if (vector.eligibility !== "usable") return null;
  if (vector.expectedOutcome === null) return null;
  // An approval only counts for the digest it named: a vector whose recorded
  // approval binds another content digest has not been reviewed as it stands.
  if (vector.review.status !== "approved") return null;
  if (vector.review.approvedDigest !== vector.digest) return null;
  return {
    id: vector.id,
    operationId: vector.operationId,
    sdkInput: vector.sdkInput,
    request: vector.request,
    response: vector.response,
    expectedOutcome: vector.expectedOutcome,
    coverage: vector.coverage,
    limitations: [...vector.limitations],
  };
}

// The fields the Builder-facing digest covers. `blueprintDigest` is absent by
// rule (§7.3), so the manifest below is the only place that names it, and a new
// field cannot join the identity quietly.
export const BLUEPRINT_DIGEST_FIELDS = [
  "schemaVersion",
  "blueprintId",
  "contractRevisions",
  "publicVectors",
  "generation",
  "verificationScope",
] as const;

export function blueprintDigestInput(payload: Omit<BlueprintPayload, "blueprintDigest">): JsonObject {
  const input: JsonObject = {
    schemaVersion: payload.schemaVersion,
    blueprintId: payload.blueprintId,
    contractRevisions: payload.contractRevisions.map((entry) => ({
      contractKey: entry.contractKey,
      revision: entry.revision,
      digest: entry.digest,
      behaviorSpec: entry.behaviorSpec,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      httpOperations: entry.httpOperations.map(operationToJson),
      errorCases: [...entry.errorCases],
      limitations: [...entry.limitations],
      unknowns: [...entry.unknowns],
    })),
    publicVectors: payload.publicVectors.map(vectorToJson),
    generation: {
      language: payload.generation.language,
      outputKind: payload.generation.outputKind,
      openapiVersion: payload.generation.openapiVersion,
    },
    verificationScope: [...payload.verificationScope],
  };
  const declared = [...BLUEPRINT_DIGEST_FIELDS].sort();
  const actual = Object.keys(input).sort();
  if (declared.join(",") !== actual.join(",")) {
    throw new RangeError(`blueprint digest field mismatch: ${actual.join(",")} != ${declared.join(",")}`);
  }
  return input;
}

function operationToJson(operation: HttpOperation): JsonObject {
  return {
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    requestMediaType: operation.requestMediaType,
    responses: operation.responses.map((response) => ({
      status: response.status,
      mediaType: response.mediaType,
      schema: response.schema,
    })),
  };
}

function vectorToJson(vector: PublicTestVector): JsonObject {
  return {
    id: vector.id,
    operationId: vector.operationId,
    sdkInput: vector.sdkInput,
    request: sideToJson(vector.request),
    response: responseToJson(vector.response),
    expectedOutcome:
      vector.expectedOutcome.kind === "return"
        ? { kind: "return", value: vector.expectedOutcome.value }
        : { kind: "throw", code: vector.expectedOutcome.code, detail: vector.expectedOutcome.detail },
    coverage: {
      state: vector.coverage.state,
      examined: vector.coverage.examined,
      total: vector.coverage.total,
      reasons: [...vector.coverage.reasons],
    },
    limitations: [...vector.limitations],
  };
}

export function blueprintDigestOf(
  payload: Omit<BlueprintPayload, "blueprintDigest">,
  limits: CanonicalLimits,
): Digest {
  return digestCanonicalJson(blueprintDigestInput(payload), limits);
}

export function buildBlueprintPayload(input: {
  blueprintId: Id;
  blueprintDigest: Digest;
  contracts: readonly BlueprintContractEntry[];
  publicVectors: readonly PublicTestVector[];
  verificationScope: readonly string[];
}): BlueprintPayload {
  return {
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    blueprintId: input.blueprintId,
    blueprintDigest: input.blueprintDigest,
    contractRevisions: input.contracts.map((entry) => ({
      contractKey: entry.contractKey,
      revision: entry.revision,
      digest: entry.digest,
      behaviorSpec: entry.behaviorSpec,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      httpOperations: entry.httpOperations.map((operation) => ({
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        requestMediaType: operation.requestMediaType,
        responses: operation.responses.map((response) => ({
          status: response.status,
          mediaType: response.mediaType,
          schema: response.schema,
        })),
      })),
      errorCases: [...entry.errorCases],
      limitations: [...entry.limitations],
      unknowns: [...entry.unknowns],
    })),
    publicVectors: input.publicVectors.map((vector) => ({
      id: vector.id,
      operationId: vector.operationId,
      sdkInput: vector.sdkInput,
      request: vector.request,
      response: vector.response,
      expectedOutcome: vector.expectedOutcome,
      coverage: {
        state: vector.coverage.state,
        examined: vector.coverage.examined,
        total: vector.coverage.total,
        reasons: [...vector.coverage.reasons],
      },
      limitations: [...vector.limitations],
    })),
    generation: {
      language: GENERATION_LANGUAGE,
      outputKind: GENERATION_OUTPUT_KIND,
      openapiVersion: OPENAPI_VERSION,
    },
    verificationScope: [...input.verificationScope].sort(),
  };
}

// The disclosure test a reviewer can actually check: nothing that names a file,
// an evidence record, a target or a snapshot may appear anywhere in the text of
// the Builder-facing payload.
export function leakReasons(payload: BlueprintPayload, forbidden: readonly string[]): string[] {
  const serialized = JSON.stringify(payload);
  return forbidden.filter((token) => token.length > 0 && serialized.includes(token));
}

const SOURCE_TEXT_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\b(?:function|class|interface)\s+\w*\s*[({]/, label: "declaration" },
  { pattern: /^\s*(?:import|export)\s.+from\s+["']/m, label: "module-io" },
  { pattern: /=>\s*[{(]/, label: "arrow-body" },
  { pattern: /\bdef\s+\w+\s*\(/, label: "python-def" },
];

// Advisory only (§7.3): a human reviewer still owns the conclusion. It exists so
// an accidental paste of a source excerpt cannot freeze silently.
export function sourceTextSuspicions(texts: readonly string[]): string[] {
  const flagged: string[] = [];
  for (const text of texts) {
    for (const entry of SOURCE_TEXT_PATTERNS) {
      if (entry.pattern.test(text)) flagged.push(entry.label);
    }
  }
  return [...new Set(flagged)];
}

// A claim as the freeze sees it: the projection inputs plus its identity. The
// colour is computed here from basis, validity, authority and coverage, so a
// stored label can never be the thing that gets trusted.
export type BlueprintClaim = ClaimEvidenceState & { id: Id };

// §6 with D10: every required claim must project SEEN. A yellow (derived or
// inferred) claim and a red (UNKNOWN) one both block, and manual approval cannot
// waive it — the projection is recomputed here, not read from a stored colour.
export function nonSeenClaimReasons(claims: readonly BlueprintClaim[]): string[] {
  const reasons: string[] = [];
  for (const claim of claims) {
    const projected = projectClaim(claim);
    if (blocksStrictBlueprint(projected)) {
      reasons.push(`claim-not-seen:${claim.id}:${projected.status}:${projected.reasons.join("+")}`);
    }
  }
  return reasons;
}

// An edge is judged by its own claim and never inherits a node colour (§6).
export function nonSeenEdgeReasons(
  edges: readonly { id: string; relation: string; claim: BlueprintClaim }[],
): string[] {
  const reasons: string[] = [];
  for (const edge of edges) {
    const projected = projectClaim(edge.claim);
    if (blocksStrictBlueprint(projected)) {
      reasons.push(`edge-not-seen:${edge.id}:${edge.relation}:${projected.status}`);
    }
  }
  return reasons;
}

// The manifest digest covers everything the manifest records except its own
// digest field, so the value can be recomputed on read (§7.3).
export const SOURCE_MANIFEST_DIGEST_FIELDS = [
  "schemaVersion",
  "blueprintId",
  "blueprintDigest",
  "projectId",
  "targetId",
  "snapshotDigest",
  "graphRevision",
  "planId",
  "planDigest",
  "inventoryDigest",
  "selectedVectorIds",
  "excludedVectorReasons",
  "claims",
  "holdoutVectorIds",
  "reviewAttribution",
  "sourceTextSuspicions",
] as const;

export function sourceManifestDigestInput(manifest: Omit<SourceManifest, "manifestDigest">): JsonObject {
  const input: JsonObject = {
    schemaVersion: manifest.schemaVersion,
    blueprintId: manifest.blueprintId,
    blueprintDigest: manifest.blueprintDigest,
    projectId: manifest.projectId,
    targetId: manifest.targetId,
    snapshotDigest: manifest.snapshotDigest,
    graphRevision: manifest.graphRevision,
    planId: manifest.planId,
    planDigest: manifest.planDigest,
    inventoryDigest: manifest.inventoryDigest,
    selectedVectorIds: [...manifest.selectedVectorIds].sort(),
    excludedVectorReasons: manifest.excludedVectorReasons.map((entry) => ({
      vectorId: entry.vectorId,
      reasonCode: entry.reasonCode,
      excludedBehavior: entry.excludedBehavior,
    })),
    claims: manifest.claims.map((entry) => ({
      contractDigest: entry.contractDigest,
      claimId: entry.claimId,
      evidenceIds: [...entry.evidenceIds].sort(),
      sourceLocations: entry.sourceLocations,
    })),
    holdoutVectorIds: [...manifest.holdoutVectorIds].sort((left, right) => (left.vectorId < right.vectorId ? -1 : 1)),
    reviewAttribution: [...manifest.reviewAttribution].sort(
      (left, right) => (left.reviewedAt < right.reviewedAt ? -1 : 1),
    ),
    sourceTextSuspicions: [...manifest.sourceTextSuspicions].sort(),
  };
  const declared = [...SOURCE_MANIFEST_DIGEST_FIELDS].sort();
  const actual = Object.keys(input).sort();
  if (declared.join(",") !== actual.join(",")) {
    throw new RangeError(`manifest digest field mismatch: ${actual.join(",")} != ${declared.join(",")}`);
  }
  return input;
}

export function sourceManifestDigestOf(manifest: Omit<SourceManifest, "manifestDigest">, limits: CanonicalLimits): Digest {
  return digestCanonicalJson(sourceManifestDigestInput(manifest), limits);
}

import type { CanonicalLimits, Digest } from "./canonical-json.ts";
import { digestCanonicalJson } from "./canonical-json.ts";
import type { ClaimValidity, Coverage } from "./evidence.ts";
import { blocksStrictBlueprint, projectClaim } from "./evidence.ts";
import type { Id, Instant } from "./identity.ts";
import type { JsonValue, JsonObject } from "./json-value.ts";
import type { ReviewStatus } from "./vector.ts";

// ContractRevision content rules (DESIGN §7.2). A contract is the only place
// that says which behaviours a delivery promises to cover, so the gates here are
// about *scope honesty*: an operation without a case, a case without a source
// claim, or a vector borrowed from another operation is a refusal, not a warning.

export const JSON_SCHEMA_DIALECT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export type HttpMethod = string;

export type HttpResponseContract = {
  status: number;
  mediaType: string | null;
  schema: JsonValue;
};

export type HttpOperation = {
  operationId: string;
  method: HttpMethod;
  path: string;
  requestMediaType: string | null;
  responses: HttpResponseContract[];
};

export type ContractScope = {
  snapshotDigest: Digest;
  operationIds: string[];
  excludedBehaviors: string[];
};

export type RequiredCaseKind = "success" | "error" | "edge";

export type RequiredCase = {
  caseKey: string;
  claimId: Id;
  kind: RequiredCaseKind;
  vectorIds: Id[];
};

export type ContractReview = {
  status: ReviewStatus;
  reviewerId: string | null;
  reviewedAt: Instant | null;
  approvedDigest: Digest | null;
};

export type ContractRevisionContent = {
  id: Id;
  contractKey: string;
  revision: number;
  targetId: Id;
  scope: ContractScope;
  behaviorSpec: string;
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  httpOperations: HttpOperation[];
  errorCases: string[];
  limitations: string[];
  unknowns: string[];
  sourceClaimIds: Id[];
  requiredCases: RequiredCase[];
};

export type ContractRevision = ContractRevisionContent & {
  digest: Digest;
  review: ContractReview;
};

// §7.2: the digest excludes itself, the review record and mutable UI metadata.
// `digest` and `review` are therefore absent here by rule, not by omission.
export const CONTRACT_CONTENT_FIELDS = [
  "id",
  "contractKey",
  "revision",
  "targetId",
  "scope",
  "behaviorSpec",
  "inputSchema",
  "outputSchema",
  "httpOperations",
  "errorCases",
  "limitations",
  "unknowns",
  "sourceClaimIds",
  "requiredCases",
] as const;

function operationToJson(operation: HttpOperation): JsonValue {
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

export function contractDigestInput(content: ContractRevisionContent): JsonObject {
  return {
    id: content.id,
    contractKey: content.contractKey,
    revision: content.revision,
    targetId: content.targetId,
    scope: {
      snapshotDigest: content.scope.snapshotDigest,
      operationIds: [...content.scope.operationIds],
      excludedBehaviors: [...content.scope.excludedBehaviors],
    },
    behaviorSpec: content.behaviorSpec,
    inputSchema: content.inputSchema,
    outputSchema: content.outputSchema,
    httpOperations: content.httpOperations.map(operationToJson),
    errorCases: [...content.errorCases],
    limitations: [...content.limitations],
    unknowns: [...content.unknowns],
    sourceClaimIds: [...content.sourceClaimIds],
    requiredCases: content.requiredCases.map((entry) => ({
      caseKey: entry.caseKey,
      claimId: entry.claimId,
      kind: entry.kind,
      vectorIds: [...entry.vectorIds],
    })),
  };
}

export function contractDigest(content: ContractRevisionContent, limits: CanonicalLimits): Digest {
  return digestCanonicalJson(contractDigestInput(content), limits);
}

// What the service must know about a referenced vector to check the contract's
// own scope promise (§7.2: targetId, snapshotDigest, caseKey, operationId).
export type ContractVectorFact = {
  id: Id;
  targetId: Id;
  snapshotDigest: Digest;
  caseKey: string;
  operationId: string;
  eligibility: "usable" | "blocked";
  reviewStatus: ReviewStatus;
};

export type ContractClaimFact = {
  id: Id;
  targetId: Id;
  validity: ClaimValidity;
  basis: "observed" | "derived" | "inferred" | "unknown";
  sourceEvidenceIds: readonly string[];
  authorityApplies: boolean;
  coverage: Coverage;
};

export type ContractGateInput = {
  content: ContractRevisionContent;
  vectors: readonly ContractVectorFact[];
  claims: readonly ContractClaimFact[];
  // Approval and strict freeze are the same rule set, run at two moments.
  requireComplete: boolean;
};

function dialectDefect(name: string, schema: JsonValue): string | null {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    // A non-object schema would have to be a boolean "accept anything", which
    // §7.2 forbids: unknown fields may not be dressed up as a proven type.
    return `schema-${name}-not-an-object`;
  }
  const declared = (schema as Record<string, JsonValue>)["$schema"];
  if (declared !== JSON_SCHEMA_DIALECT_2020_12) return `schema-${name}-dialect-not-2020-12`;
  return null;
}

// One rule, one list of reasons. Approval never re-derives a subset of these, so
// a contract cannot pass a weaker check than the freeze applies to it.
export function contractGateReasons(input: ContractGateInput): string[] {
  const reasons: string[] = [];
  const content = input.content;
  const claims = new Map<Id, ContractClaimFact>();
  for (const claim of input.claims) claims.set(claim.id, claim);
  const vectors = new Map<Id, ContractVectorFact>();
  for (const vector of input.vectors) vectors.set(vector.id, vector);
  const operationIds = new Set(content.scope.operationIds);
  const boundOperations = new Set(content.httpOperations.map((operation) => operation.operationId));

  for (const field of ["inputSchema", "outputSchema"] as const) {
    const defect = dialectDefect(field, content[field]);
    if (defect !== null) reasons.push(defect);
  }

  for (const operationId of operationIds) {
    if (!boundOperations.has(operationId)) reasons.push(`operation-without-http-binding:${operationId}`);
  }
  for (const operation of content.httpOperations) {
    if (!operationIds.has(operation.operationId)) {
      reasons.push(`http-binding-outside-scope:${operation.operationId}`);
    }
  }

  const coveredOperations = new Set<string>();
  for (const entry of content.requiredCases) {
    if (!content.sourceClaimIds.includes(entry.claimId)) {
      reasons.push(`required-case-claim-outside-source:${entry.caseKey}`);
    }
    const claim = claims.get(entry.claimId);
    if (claim === undefined) {
      reasons.push(`required-case-claim-unknown:${entry.caseKey}`);
    } else if (claim.targetId !== content.targetId) {
      reasons.push(`required-case-claim-target-mismatch:${entry.caseKey}`);
    }
    if (entry.vectorIds.length === 0) {
      reasons.push(`required-case-without-vector:${entry.caseKey}`);
    }
    const caseVectors = entry.vectorIds.map((id) => vectors.get(id));
    entry.vectorIds.forEach((id, index) => {
      const vector = caseVectors[index];
      if (vector === undefined) {
        reasons.push(`required-vector-unknown:${entry.caseKey}:${id}`);
        return;
      }
      if (
        vector.targetId !== content.targetId ||
        vector.snapshotDigest !== content.scope.snapshotDigest ||
        vector.caseKey !== entry.caseKey
      ) {
        reasons.push(`vector-scope-mismatch:${entry.caseKey}:${id}`);
      }
      if (!operationIds.has(vector.operationId)) {
        reasons.push(`vector-operation-out-of-scope:${entry.caseKey}:${id}`);
      }
      if (!boundOperations.has(vector.operationId)) {
        reasons.push(`vector-operation-unbound:${entry.caseKey}:${id}`);
      }
      if (input.requireComplete) {
        if (vector.reviewStatus !== "approved") reasons.push(`required-vector-not-approved:${id}`);
        if (vector.eligibility === "blocked") reasons.push(`required-vector-blocked:${id}`);
      }
    });
    if (entry.vectorIds.length > 0) {
      for (const vector of caseVectors) {
        if (vector !== undefined) coveredOperations.add(vector.operationId);
      }
    }
  }

  for (const operationId of operationIds) {
    if (!coveredOperations.has(operationId)) reasons.push(`operation-without-required-case:${operationId}`);
  }

  if (input.requireComplete) {
    for (const claimId of content.sourceClaimIds) {
      const claim = claims.get(claimId);
      if (claim === undefined) {
        reasons.push(`source-claim-unknown:${claimId}`);
        continue;
      }
      const projected = projectClaim(claim);
      if (blocksStrictBlueprint(projected)) {
        reasons.push(`source-claim-not-seen:${claimId}:${projected.status.toLowerCase()}`);
      }
    }
  }

  return [...new Set(reasons)];
}

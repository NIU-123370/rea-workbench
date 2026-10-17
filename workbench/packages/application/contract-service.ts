import { CanonicalizationError } from "../domain/canonical-json.ts";
import type { CanonicalLimits, Digest } from "../domain/canonical-json.ts";
import { asDigest } from "../domain/canonical-json.ts";
import { asId, newId, nowInstant } from "../domain/identity.ts";
import type { Id, Instant } from "../domain/identity.ts";
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import {
  contractDraftRequestSchema,
  contractReviewRequestSchema,
  contractRevisionContentSchema,
  type ContractRevisionWire,
} from "../contracts/behaviors.ts";
import {
  contractDigest,
  contractDigestInput,
  contractGateReasons,
  type ContractClaimFact,
  type ContractRevision,
  type ContractRevisionContent,
  type ContractVectorFact,
} from "../domain/contract.ts";
import type { ClaimValidity, Coverage } from "../domain/evidence.ts";
import type { ReviewStatus } from "../domain/vector.ts";
import { isBuilder, mayRecordDecision, type Actor } from "./actor.ts";
import { commitDecision, recordDeny, type Step } from "./decision.ts";
import { blockedByReasons, gateFail, issueNames, type GateFailure } from "./gate-failure.ts";
import { assertPayloadClean, type OperationFilterContext } from "./sanitizer.ts";
import type {
  ClaimRow,
  ContractRow,
  StorageTransaction,
  StorageWriterPort,
  VectorRow,
} from "./ports.ts";
import type { VectorService } from "./vector-service.ts";

// ContractService owns behaviour contracts (DESIGN §7.2). Revision numbers come
// from the store, never from the caller, and an approved body is immutable: a
// changed promise is a new revision, which is what lets a plan bind a digest and
// a later report still describe what was promised.


export type ContractCommit = {
  contractId: Id;
  contractKey: string;
  revision: number;
  digest: Digest;
  reviewStatus: ReviewStatus;
  auditSeq: number;
  eventSeq: number | null;
};

function claimValidityOf(row: ClaimRow): ClaimValidity {
  return row.validity;
}

function coverageOf(row: ClaimRow): Coverage {
  const parsed = row.coverageJson;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("a claim row must carry an object coverage");
  }
  const record = parsed as Record<string, JsonValue>;
  const state = record["state"];
  const examined = record["examined"];
  const total = record["total"];
  const reasons = record["reasons"];
  if (
    state !== "complete" &&
    state !== "partial" &&
    state !== "unknown" &&
    state !== "unavailable"
  ) {
    throw new Error("a claim row must carry a named coverage state");
  }
  return {
    state,
    examined: typeof examined === "number" ? examined : null,
    total: typeof total === "number" ? total : null,
    reasons: Array.isArray(reasons) ? (reasons.filter((entry) => typeof entry === "string") as string[]) : [],
  };
}

export function claimFactOf(row: ClaimRow): ContractClaimFact {
  const sources = row.scopeJson;
  const sourceEvidenceIds: string[] =
    sources !== null && typeof sources === "object" && !Array.isArray(sources)
      ? ((sources as Record<string, JsonValue>)["sourceEvidenceIds"] as JsonValue[] | undefined ?? [])
          .filter((entry) => typeof entry === "string")
          .map((entry) => entry as string)
      : [];
  return {
    id: row.id,
    targetId: row.targetId,
    validity: claimValidityOf(row),
    basis: row.basis,
    sourceEvidenceIds,
    authorityApplies: row.sourceState !== "unavailable",
    coverage: coverageOf(row),
  };
}

// `operationId` lives in the vector's immutable payload, not in an index column
// (§5: an index must never become a second semantic source). The row columns
// still decide review state and eligibility, because those are read again inside
// the transaction that writes the decision.
function vectorFactOf(row: VectorRow, operationId: string): ContractVectorFact {
  return {
    id: row.id,
    targetId: row.targetId,
    snapshotDigest: row.snapshotDigest,
    caseKey: row.caseKey,
    operationId,
    eligibility: row.eligibility,
    reviewStatus: row.reviewStatus,
  };
}

export class ContractService {
  readonly storage: StorageWriterPort;
  readonly limits: CanonicalLimits;
  readonly vectors: VectorService;

  constructor(deps: { storage: StorageWriterPort; limits: CanonicalLimits; vectors: VectorService }) {
    this.storage = deps.storage;
    this.limits = deps.limits;
    this.vectors = deps.vectors;
  }

  createDraft(
    projectId: Id,
    actor: Actor,
    input: unknown,
    context: OperationFilterContext,
  ): Result<ContractCommit, GateFailure> {
    if (isBuilder(actor)) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "contract",
        action: "contract.create",
        resourceId: null,
        decision: "deny",
        reasonCode: "builder-has-no-contract-permission",
        metadata: {},
      });
      return gateFail(
        "ACCESS_DENIED",
        "builder-has-no-contract-permission",
        "Builder reads blueprint projections only (DESIGN §7.3)",
      );
    }
    const parsed = contractDraftRequestSchema.safeParse(input);
    if (!parsed.success) {
      return gateFail("INVALID_INPUT", "draft-request", "draft request rejected", {
        issues: issueNames(parsed.error.issues) as unknown as JsonValue,
      });
    }
    const request = parsed.data;

    const committed = commitDecision<Omit<ContractCommit, "auditSeq" | "eventSeq">>(this.storage, {
      projectId,
      actor,
      resourceType: "contract",
      action: "contract.create",
      resourceId: null,
      allowReason: "contract-drafted",
      metadata: { contractKey: request.contractKey },
      work: (tx): Step<Omit<ContractCommit, "auditSeq" | "eventSeq">> => {
        const project = tx.getProject(projectId);
        if (project === null) {
          return { kind: "failure", failure: gateFail("NOT_FOUND", "project-unknown", "project not found") };
        }
        const target = tx.getTarget(projectId, asId(request.targetId));
        if (target === null) {
          return { kind: "failure", failure: gateFail("NOT_FOUND", "target-unknown", "target not found") };
        }
        if (target.snapshotDigest !== request.scope.snapshotDigest) {
          return {
            kind: "failure",
            failure: gateFail(
              "STALE_INPUT",
              "scope-snapshot-mismatch",
              "the contract scope names a snapshot this target does not hold",
            ),
          };
        }
        for (const claimId of request.sourceClaimIds) {
          const claim = tx.getClaim(projectId, asId(claimId));
          if (claim === null) {
            return {
              kind: "failure",
              failure: gateFail("NOT_FOUND", "source-claim-unknown", `claim ${claimId} is not in this project`),
            };
          }
          if (claim.targetId !== request.targetId) {
            return {
              kind: "failure",
              failure: gateFail("INVALID_INPUT", "source-claim-target-mismatch", "claim belongs to another target"),
            };
          }
        }
        for (const entry of request.requiredCases) {
          if (!request.sourceClaimIds.includes(entry.claimId)) {
            return {
              kind: "failure",
              failure: gateFail(
                "INVALID_INPUT",
                "required-case-claim-outside-source",
                "a required case must cite one of the contract's own source claims",
                { caseKey: entry.caseKey },
              ),
            };
          }
          for (const vectorId of entry.vectorIds) {
            const vector = tx.getVector(projectId, asId(vectorId));
            if (vector === null) {
              return {
                kind: "failure",
                failure: gateFail("NOT_FOUND", "required-vector-unknown", `vector ${vectorId} is not in this project`),
              };
            }
            if (vector.targetId !== request.targetId) {
              return {
                kind: "failure",
                failure: gateFail("INVALID_INPUT", "required-vector-target-mismatch", "vector belongs to another target"),
              };
            }
          }
        }
        const caseKeys = request.requiredCases.map((entry) => entry.caseKey);
        if (new Set(caseKeys).size !== caseKeys.length) {
          return {
            kind: "failure",
            failure: gateFail(
              "INVALID_INPUT",
              "duplicate-case-key",
              "two required cases sharing a caseKey make a sample's binding ambiguous",
            ),
          };
        }

        const revision = tx.latestContractRevision(projectId, request.contractKey) + 1;
        const content: ContractRevisionContent = {
          id: newId(),
          contractKey: request.contractKey,
          revision,
          targetId: asId(request.targetId),
          scope: {
            snapshotDigest: asDigest(request.scope.snapshotDigest),
            operationIds: [...request.scope.operationIds],
            excludedBehaviors: [...request.scope.excludedBehaviors],
          },
          behaviorSpec: request.behaviorSpec,
          inputSchema: request.inputSchema,
          outputSchema: request.outputSchema,
          httpOperations: request.httpOperations,
          errorCases: request.errorCases,
          limitations: request.limitations,
          unknowns: request.unknowns,
          sourceClaimIds: request.sourceClaimIds.map((id) => asId(id)),
          requiredCases: request.requiredCases.map((entry) => ({
            caseKey: entry.caseKey,
            claimId: asId(entry.claimId),
            kind: entry.kind,
            vectorIds: entry.vectorIds.map((id) => asId(id)),
          })),
        };

        // §12.1 / D28 (PRD A11, and issue #8's fourth box): this body is one of the seven faces
        // the single filter owner covers, and the check runs on `contractDigestInput`
        // because that object is byte-for-byte what lands in `contracts.payload_json`.
        // A hit therefore means nothing was persisted and no digest was minted - not
        // that a copy was rewritten on its way to an approved body, which is the one
        // thing §12.1 forbids (an approved body keeps its digest or does not exist).
        const payloadCheck = assertPayloadClean(contractDigestInput(content), context.sensitive);
        if (!payloadCheck.ok) {
          return {
            kind: "failure",
            failure: gateFail(
              "SENSITIVE_CONTENT_BLOCKED",
              payloadCheck.reason,
              "the contract body is refused by the diagnostic filter",
            ),
          };
        }

        let digest: Digest;
        try {
          digest = contractDigest(content, this.limits);
        } catch (error) {
          if (error instanceof CanonicalizationError) {
            return {
              kind: "failure",
              failure: gateFail("RESOURCE_LIMIT", `canonicalization-${error.reason}`, "contract payload exceeds the budget"),
            };
          }
          throw error;
        }

        tx.insertContract({
          id: content.id,
          projectId,
          targetId: content.targetId,
          contractKey: content.contractKey,
          revision: content.revision,
          payloadJson: contractDigestInput(content),
          digest,
          reviewStatus: "draft",
          reviewRecordJson: null,
        });
        return {
          kind: "committed",
          value: {
            contractId: content.id,
            contractKey: content.contractKey,
            revision: content.revision,
            digest,
            reviewStatus: "draft" as ReviewStatus,
          },
        };
      },
    });

    if (!committed.ok) return committed;
    return {
      ok: true,
      value: { ...committed.value.value, auditSeq: committed.value.auditSeq, eventSeq: null },
    };
  }

  async review(
    projectId: Id,
    actor: Actor,
    contractId: Id,
    input: unknown,
  ): Promise<Result<ContractCommit, GateFailure>> {
    if (!mayRecordDecision(actor)) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "contract",
        action: "contract.review",
        resourceId: contractId,
        decision: "deny",
        reasonCode: "actor-may-not-review",
        metadata: {},
      });
      return gateFail(
        "ACCESS_DENIED",
        "actor-may-not-review",
        "only an inspector or reviewer may record a contract decision",
      );
    }
    const parsed = contractReviewRequestSchema.safeParse(input);
    if (!parsed.success) {
      return gateFail("INVALID_INPUT", "review-request", "review request rejected", {
        issues: issueNames(parsed.error.issues) as unknown as JsonValue,
      });
    }
    const request = parsed.data;

    const preflight = this.storage.transact((tx) => {
      const row = tx.getContract(projectId, contractId);
      if (row === null) return null;
      const content = contentOf(row);
      if (content === null) return { malformed: true as const };
      const ids = content.requiredCases.flatMap((entry) => entry.vectorIds);
      return { malformed: false as const, vectorIds: [...new Set(ids)], digest: row.digest };
    });
    if (!preflight.ok) return gateFail("INVALID_INPUT", preflight.error.code, preflight.error.message);
    if (preflight.value === null) return gateFail("NOT_FOUND", "contract-unknown", "contract not found");
    if (preflight.value.malformed) {
      return gateFail("REA_CONTRACT_MISMATCH", "contract-payload-shape", "stored contract payload is malformed");
    }
    // The digest is only compared inside the write transaction, after the
    // already-reviewed check: a rejection carries no digest, and reporting a
    // digest conflict for an already-approved contract would hide the real cause.
    const operations = await this.loadVectorOperations(projectId, preflight.value.vectorIds);
    if (!operations.ok) return operations;

    const committed = commitDecision<Omit<ContractCommit, "auditSeq">>(this.storage, {
      projectId,
      actor,
      resourceType: "contract",
      action: "contract.review",
      resourceId: contractId,
      allowReason: `contract-${request.decision}`,
      metadata: { decision: request.decision, digest: request.digest },
      work: (tx): Step<Omit<ContractCommit, "auditSeq">> => {
        const row = tx.getContract(projectId, contractId);
        if (row === null) {
          return { kind: "failure", failure: gateFail("NOT_FOUND", "contract-unknown", "contract not found") };
        }
        if (row.reviewStatus !== "draft") {
          return {
            kind: "failure",
            failure: gateFail(
              "REVISION_CONFLICT",
              "contract-already-reviewed",
              "an approved contract body is immutable; create a new revision instead",
            ),
          };
        }
        if (request.decision === "approved" && request.digest !== row.digest) {
          return {
            kind: "failure",
            failure: gateFail("REVISION_CONFLICT", "approved-digest-mismatch", "the digest under review is not this contract's"),
          };
        }
        if (request.decision !== "approved") {
          // A rejection records no gate result: the reasons would only help an
          // operator decide, and refusing to recompute keeps reject idempotent.
          return this.record(tx, row, request.decision, request.reviewerId, null);
        }

        const content = contentOf(row);
        if (content === null) {
          return {
            kind: "failure",
            failure: gateFail("REA_CONTRACT_MISMATCH", "contract-payload-shape", "stored contract payload is malformed"),
          };
        }
        // The operations were loaded before this transaction opened and their
        // digests were verified there; `gateRows` re-reads every decision-relevant
        // column inside the transaction, so a stale read cannot pass the gate.
        const gate = this.gateRows(tx, projectId, content, operations.value, false);
        if (!gate.ok) return { kind: "failure", failure: gate };
        return this.record(tx, row, request.decision, request.reviewerId, row.digest);
      },
    });

    if (!committed.ok) return committed;
    return { ok: true, value: { ...committed.value.value, auditSeq: committed.value.auditSeq } };
  }

  read(projectId: Id, actor: Actor, contractId: Id): Result<ContractRevision, GateFailure> {
    if (isBuilder(actor)) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "contract",
        action: "contract.read",
        resourceId: contractId,
        decision: "deny",
        reasonCode: "builder-has-no-contract-permission",
        metadata: {},
      });
      return gateFail("ACCESS_DENIED", "builder-has-no-contract-permission", "Builder reads blueprint projections only");
    }
    const looked = this.storage.transact((tx) => {
      const row = tx.getContract(projectId, contractId);
      if (row === null) return null;
      const content = contentOf(row);
      if (content === null) return { malformed: true as const };
      return { malformed: false as const, revision: rebuild(row, content) };
    });
    if (!looked.ok) return gateFail("INVALID_INPUT", looked.error.code, looked.error.message);
    if (looked.value === null) return gateFail("NOT_FOUND", "contract-unknown", "contract not found");
    if ("malformed" in looked.value && looked.value.malformed) {
      return gateFail("REA_CONTRACT_MISMATCH", "contract-payload-shape", "stored contract payload is malformed");
    }
    return { ok: true, value: looked.value.revision };
  }

  // The gate is a query, not only an approval step: the blueprint freeze (#13)
  // and any UI hint must run the identical rule set against current rows.
  // Payload reads happen outside the write transaction (they are immutable and
  // need the artifact store), and every decision-relevant column is read again
  // inside it by `gateRows`.
  async loadVectorOperations(
    projectId: Id,
    vectorIds: readonly Id[],
  ): Promise<Result<Map<string, string>, GateFailure>> {
    const loaded = await this.vectors.loadContents(projectId, vectorIds);
    if (!loaded.ok) return loaded;
    const operations = new Map<string, string>();
    for (const [id, vector] of loaded.value) operations.set(id, vector.operationId);
    return { ok: true, value: operations };
  }

  gateRows(
    tx: StorageTransaction,
    projectId: Id,
    content: ContractRevisionContent,
    operations: ReadonlyMap<string, string>,
    requireComplete: boolean,
  ): Result<true, GateFailure> {
    const claims: ContractClaimFact[] = [];
    for (const claimId of content.sourceClaimIds) {
      const row = tx.getClaim(projectId, claimId);
      if (row === null) continue;
      claims.push(claimFactOf(row));
    }
    const vectors: ContractVectorFact[] = [];
    for (const entry of content.requiredCases) {
      for (const vectorId of entry.vectorIds) {
        const row = tx.getVector(projectId, vectorId);
        if (row === null) continue;
        const operationId = operations.get(vectorId);
        if (operationId === undefined) continue;
        vectors.push(vectorFactOf(row, operationId));
      }
    }
    const reasons = contractGateReasons({ content, claims, vectors, requireComplete });
    if (reasons.length > 0) return blockedByReasons(reasons, "BLUEPRINT_BLOCKED", `contract ${content.contractKey} r${String(content.revision)}`);
    return { ok: true, value: true };
  }

  private record(
    tx: StorageTransaction,
    row: ContractRow,
    decision: "approved" | "rejected",
    reviewerId: string,
    approvedDigest: Digest | null,
  ): Step<Omit<ContractCommit, "auditSeq">> {
    const reviewedAt: Instant = nowInstant();
    tx.updateContractReview({
      ...row,
      reviewStatus: decision,
      reviewRecordJson: {
        status: decision,
        reviewerId,
        reviewedAt,
        approvedDigest: decision === "approved" ? approvedDigest : null,
      },
    });
    const eventSeq = tx.appendEvent({
      projectId: row.projectId,
      type: "contract.reviewed",
      aggregateId: row.id,
      payloadJson: { resourceIds: [row.id], reasonCode: `contract-${decision}` },
      createdAt: reviewedAt,
    });
    return {
      kind: "committed",
      value: {
        contractId: row.id,
        contractKey: row.contractKey,
        revision: row.revision,
        digest: row.digest,
        reviewStatus: decision,
        eventSeq,
      },
    };
  }
}

export function contractContentOf(row: ContractRow): ContractRevisionContent | null {
  return contentOf(row);
}

function contentOf(row: ContractRow): ContractRevisionContent | null {
  const parsed = contractRevisionContentSchema.safeParse(row.payloadJson);
  if (!parsed.success) return null;
  return contentFromWire(parsed.data);
}

function contentFromWire(data: {
  id: string;
  contractKey: string;
  revision: number;
  targetId: string;
  scope: { snapshotDigest: string; operationIds: string[]; excludedBehaviors: string[] };
  behaviorSpec: string;
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  httpOperations: ContractRevisionWire["httpOperations"];
  errorCases: string[];
  limitations: string[];
  unknowns: string[];
  sourceClaimIds: string[];
  requiredCases: ContractRevisionWire["requiredCases"];
}): ContractRevisionContent {
  return {
    id: asId(data.id),
    contractKey: data.contractKey,
    revision: data.revision,
    targetId: asId(data.targetId),
    scope: {
      snapshotDigest: asDigest(data.scope.snapshotDigest),
      operationIds: data.scope.operationIds,
      excludedBehaviors: data.scope.excludedBehaviors,
    },
    behaviorSpec: data.behaviorSpec,
    inputSchema: data.inputSchema,
    outputSchema: data.outputSchema,
    httpOperations: data.httpOperations.map((operation) => ({
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
    errorCases: data.errorCases,
    limitations: data.limitations,
    unknowns: data.unknowns,
    sourceClaimIds: data.sourceClaimIds.map((id) => asId(id)),
    requiredCases: data.requiredCases.map((entry) => ({
      caseKey: entry.caseKey,
      claimId: asId(entry.claimId),
      kind: entry.kind,
      vectorIds: entry.vectorIds.map((id) => asId(id)),
    })),
  };
}

function rebuild(row: ContractRow, content: ContractRevisionContent): ContractRevision {
  const record = row.reviewRecordJson;
  const review = {
    status: row.reviewStatus,
    reviewerId: reviewField<string>(record, "reviewerId"),
    reviewedAt: reviewField<Instant>(record, "reviewedAt"),
    approvedDigest:
      row.reviewStatus === "approved" && record !== null
        ? asDigest(String((record as Record<string, JsonValue>)["approvedDigest"]))
        : null,
  };
  return { ...content, digest: row.digest, review };
}

function reviewField<T>(record: JsonValue | null, field: string): T | null {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const value = (record as Record<string, JsonValue>)[field];
  return value === null || value === undefined ? null : (value as T);
}

import { CanonicalizationError } from "../domain/canonical-json.ts";
import type { CanonicalLimits, Digest } from "../domain/canonical-json.ts";
import { asDigest, canonicalJson } from "../domain/canonical-json.ts";
import { asId, isId, newId, nowInstant } from "../domain/identity.ts";
import type { Id, Instant } from "../domain/identity.ts";
import type { JsonValue, JsonObject } from "../domain/json-value.ts";
import { isJsonObject } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import {
  testVectorContentSchema,
  vectorCreateRequestSchema,
  vectorReviewRequestSchema,
  vectorSourceSchema,
  VECTOR_PAGE_DEFAULT_LIMIT,
  VECTOR_PAGE_MAX_LIMIT,
  type TestVectorWireContent,
  type VectorPage,
} from "../contracts/vectors.ts";
import {
  deriveEligibility,
  draftReview,
  sameSourceCoordinates,
  vectorDigest,
  vectorDigestInput,
  vectorIntegrityDefects,
} from "../domain/vector.ts";
import type {
  BodyValue,
  NameValue,
  RequestSide,
  ResponseSide,
  TestVector,
  TestVectorContent,
  VectorReview,
  VectorSource,
} from "../domain/vector.ts";
import { enforceDeny } from "./audit.ts";
import { decodePageCursor, encodePageCursor } from "./page-cursor.ts";
import { assertPayloadClean, redactText } from "./sanitizer.ts";
import type { SensitiveDeclaration } from "./sanitizer.ts";
import type {
  ArtifactPort,
  AuditRow,
  EvidenceFactsPort,
  StorageTransaction,
  StorageWriterPort,
  VectorRow,
} from "./ports.ts";

// VectorService is the sole producer of sample vectors (DESIGN §7.1, D26/D27).
// Two properties carry the whole module:
//   1. a vector's request/response can only come out of persisted Evidence — the
//      create request schema has nowhere to put them, so a forged pair is refused
//      by the type that parses it rather than by a convention;
//   2. eligibility is derived here and the revision chain is validated here, so no
//      caller can turn a blocked sample into a usable one or replace a different
//      source record.

import type { Actor, ActorKind } from "./actor.ts";
import { buildAuditRow, commitDecision as journalDecision } from "./decision.ts";
import type { GateFailure } from "./gate-failure.ts";
import { issueNames } from "./gate-failure.ts";

// The actor vocabulary and the failure shape have one owner each, so a refusal
// in this service cannot drift from a refusal in the contract or plan service.
export type VectorActorKind = ActorKind;
export type VectorActor = Actor;
export type VectorFailure = GateFailure;

export type VectorCommit = {
  vectorId: Id;
  digest: Digest;
  eligibility: TestVectorContent["eligibility"];
  reasons: string[];
  inventoryRevision: number;
  eventSeq: number;
  auditSeq: number;
};

export type VectorOperationContext = {
  // Short-lived per-operation declaration. It gates and filters; it is never
  // persisted with the vector (DESIGN §12.1, issue #15).
  sensitive: SensitiveDeclaration | null;
};

// Chain validation reads the whole cluster of one evidence record. The scan is
// bounded, and reaching the bound refuses the write instead of approving a chain
// it could not fully read.
export const CHAIN_SCAN_LIMIT = 500;

const APPROVER_KINDS: VectorActorKind[] = ["inspector", "reviewer"];

type Err<T> = { ok: false; error: T };

function fail(
  code: VectorFailure["code"],
  reason: string,
  message: string,
  details: JsonObject = {},
): Err<VectorFailure> {
  return { ok: false, error: { code, reason, message, details } };
}

function safeMessage(text: string, context: VectorOperationContext): string {
  // Messages can quote a caller-supplied key or a producer string, so even the
  // error path goes through the single filter owner (§12.1).
  return redactText(text, context.sensitive).text;
}

function auditRow(
  projectId: Id,
  actor: VectorActor,
  action: string,
  resourceId: string | null,
  decision: AuditRow["decision"],
  reasonCode: string,
  metadata: JsonValue,
): AuditRow {
  return buildAuditRow({
    projectId,
    actor,
    resourceType: "vector",
    action,
    resourceId,
    decision,
    reasonCode,
    metadata,
  });
}

function stringArray(value: JsonValue): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : [];
}

// The stored payload is written by this service and read back as wire data, so
// the only way to hand the domain a branded value is to re-brand it here. A
// malformed stored value throws instead of coercing.
function toBody(value: TestVectorWireContent["request"]["body"]): BodyValue {
  switch (value.kind) {
    case "bytes":
      return { kind: "bytes", base64: value.base64, sha256: asDigest(value.sha256) };
    default:
      return value;
  }
}

function toNameValues(list: readonly { name: string; value: string }[]): NameValue[] {
  return list.map((entry) => ({ name: entry.name, value: entry.value }));
}

type WireRequest = TestVectorWireContent["request"];
type WireResponse = TestVectorWireContent["response"];

function toRequest(value: WireRequest): RequestSide {
  return {
    method: value.method,
    url: value.url,
    query: toNameValues(value.query),
    headers: toNameValues(value.headers),
    body: toBody(value.body),
  };
}

function toResponse(value: WireResponse): ResponseSide {
  return {
    status: value.status,
    headers: toNameValues(value.headers),
    body: toBody(value.body),
  };
}

function toSource(value: TestVectorWireContent["source"]): VectorSource {
  return {
    evidenceId: value.evidenceId,
    captureId: value.captureId === null ? null : (value.captureId as Id),
    recordOrdinal: value.recordOrdinal,
    pointer: value.pointer,
    transactionId: value.transactionId,
  };
}

type StoredContent = TestVectorWireContent;

function toContent(stored: StoredContent): TestVectorContent {
  return {
    id: stored.id as Id,
    targetId: stored.targetId as Id,
    snapshotDigest: asDigest(stored.snapshotDigest) as Digest,
    operationId: stored.operationId,
    sdkInput: stored.sdkInput,
    caseKey: stored.caseKey,
    replacesId: stored.replacesId === null ? null : (stored.replacesId as Id),
    source: toSource(stored.source),
    request: toRequest(stored.request),
    response: toResponse(stored.response),
    expectedOutcome:
      stored.expectedOutcome === null
        ? null
        : stored.expectedOutcome.kind === "return"
          ? { kind: "return", value: stored.expectedOutcome.value }
          : { kind: "throw", code: stored.expectedOutcome.code, detail: stored.expectedOutcome.detail },
    coverage: {
      state: stored.coverage.state,
      examined: stored.coverage.examined,
      total: stored.coverage.total,
      reasons: stored.coverage.reasons,
    },
    limitations: stored.limitations,
    redactions: stored.redactions.map((redaction) => ({
      fieldPointer: redaction.fieldPointer,
      reason: redaction.reason,
      representation: redaction.representation,
    })),
    visibility: stored.visibility,
    eligibility: stored.eligibility,
    reasons: stored.reasons,
  };
}

type Step<T> = { kind: "failure"; failure: Err<VectorFailure> } | { kind: "committed"; value: T };

export class VectorService {
  readonly storage: StorageWriterPort;
  readonly artifacts: ArtifactPort;
  readonly facts: EvidenceFactsPort;
  readonly limits: CanonicalLimits;

  constructor(deps: {
    storage: StorageWriterPort;
    artifacts: ArtifactPort;
    facts: EvidenceFactsPort;
    limits: CanonicalLimits;
  }) {
    this.storage = deps.storage;
    this.artifacts = deps.artifacts;
    this.facts = deps.facts;
    this.limits = deps.limits;
  }

  // DESIGN §12.2: the decision and its journal entry commit together. The
  // transaction unit itself is owned by `decision.ts` so the vector, contract and
  // plan services cannot drift apart on when a deny is journalled.
  private commitDecision<T>(
    projectId: Id,
    actor: VectorActor,
    action: string,
    resourceId: Id | null,
    allowReason: string,
    metadata: JsonValue,
    work: (tx: StorageTransaction) => Step<T>,
  ): Result<{ value: T; auditSeq: number }, VectorFailure> {
    return journalDecision(this.storage, {
      projectId,
      actor,
      resourceType: "vector",
      action,
      resourceId,
      allowReason,
      metadata,
      work,
    });
  }

  private chainCluster(
    tx: StorageTransaction,
    projectId: Id,
    targetId: Id,
    evidenceId: string,
  ): Result<VectorRow[], VectorFailure> {
    const cluster = tx.listVectors(projectId, { targetId, evidenceId, limit: CHAIN_SCAN_LIMIT + 1 });
    if (cluster.length > CHAIN_SCAN_LIMIT) {
      return fail(
        "RESOURCE_LIMIT",
        "chain-scan-truncated",
        `revision chain cluster passed the ${String(CHAIN_SCAN_LIMIT)} vector bound`,
        { bound: CHAIN_SCAN_LIMIT },
      );
    }
    return { ok: true, value: cluster };
  }

  // A cycle needs a stored link pointing back down the chain; walking up from the
  // predecessor over the rows just read is what makes it detectable at all.
  private assertNoCycle(
    cluster: readonly VectorRow[],
    predecessorId: Id,
  ): Result<true, VectorFailure> {
    const byId = new Map<string, VectorRow>();
    for (const row of cluster) byId.set(row.id, row);
    const seen = new Set<string>();
    let cursor: Id | null = predecessorId;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        return fail("REVISION_CONFLICT", "revision-cycle", "the replacement chain loops back on itself");
      }
      seen.add(cursor);
      const node = byId.get(cursor);
      if (node === undefined) break;
      cursor = node.replacesId;
    }
    return { ok: true, value: true };
  }

  private denyBuilder(projectId: Id, actor: VectorActor, action: string, resourceId: string | null): Err<VectorFailure> {
    enforceDeny(
      this.storage,
      auditRow(projectId, actor, action, resourceId, "deny", "builder-has-no-vector-permission", {}),
    );
    return fail(
      "ACCESS_DENIED",
      "builder-has-no-vector-permission",
      "Builder reads blueprint projections only (DESIGN §7.1)",
    );
  }

  async create(
    projectId: Id,
    actor: VectorActor,
    input: unknown,
    context: VectorOperationContext,
  ): Promise<Result<VectorCommit, VectorFailure>> {
    // Authorization precedes validation: an unauthorized actor learns nothing
    // about the accepted shape from a refusal.
    if (actor.actorKind === "builder") return this.denyBuilder(projectId, actor, "vector.create", null);

    const parsed = vectorCreateRequestSchema.safeParse(input);
    if (!parsed.success) {
      // A create request that carries a `request` or `response` field lands here:
      // the schema is strict and has no such field, so a forged pair is refused
      // rather than ignored.
      return fail(
        "INVALID_INPUT",
        "create-request",
        safeMessage(`create request rejected: ${issueNames(parsed.error.issues).join(",")}`, context),
        { issues: issueNames(parsed.error.issues) },
      );
    }
    const request = parsed.data;

    const callerPayload = assertPayloadClean(
      { sdkInput: request.sdkInput, expectedOutcome: request.expectedOutcome as JsonValue | null },
      context.sensitive,
    );
    if (!callerPayload.ok) {
      enforceDeny(
        this.storage,
        auditRow(projectId, actor, "vector.create", null, "deny", callerPayload.reason, {}),
      );
      return fail(
        "SENSITIVE_CONTENT_BLOCKED",
        callerPayload.reason,
        "the submitted SDK input or oracle is refused by the diagnostic filter",
      );
    }

    // The wire schema types the coordinates as plain strings; the domain's
    // branded identity is re-established here and nowhere else.
    const coordinate = toSource(request.source);
    const factsResult = await this.facts.readRecord({
      projectId,
      evidenceId: coordinate.evidenceId,
      coordinate,
    });
    if (!factsResult.ok) {
      return fail(factsResult.error.code, factsResult.error.reason, safeMessage(factsResult.error.message, context));
    }
    const facts = factsResult.value;

    if (facts.sensitiveDeclared) {
      enforceDeny(
        this.storage,
        auditRow(projectId, actor, "vector.create", null, "deny", "sensitive-projection-unsupported", {}),
      );
      return fail(
        "SENSITIVE_PROJECTION_UNSUPPORTED",
        "sensitive-projection-unsupported",
        "the capture declared sensitive values, so no projection of this record may be persisted",
      );
    }

    // The coordinates the caller named must be the coordinates the producer has.
    if (
      facts.evidenceId !== coordinate.evidenceId ||
      !sameSourceCoordinates(facts.source, coordinate) ||
      (coordinate.pointer !== null && facts.source.pointer !== coordinate.pointer)
    ) {
      return fail(
        "INVALID_INPUT",
        "record-coordinate-mismatch",
        "the evidence record at those coordinates is not the one referenced",
      );
    }

    const decision = deriveEligibility({
      request: facts.request,
      response: facts.response,
      expectedOutcome: request.expectedOutcome,
      coverage: facts.coverage,
    });

    const content: TestVectorContent = {
      id: newId(),
      // The wire schema already proved the patterns; this only re-attaches the
      // domain's branded identity, so a plain string cannot leak into a digest
      // computation or an FK column.
      targetId: asId(request.targetId),
      snapshotDigest: asDigest(request.snapshotDigest),
      operationId: request.operationId,
      sdkInput: request.sdkInput,
      caseKey: request.caseKey,
      replacesId: request.replacesId === null ? null : asId(request.replacesId),
      source: facts.source,
      request: facts.request,
      response: facts.response,
      expectedOutcome: request.expectedOutcome,
      coverage: facts.coverage,
      limitations: facts.limitations,
      redactions: facts.redactions,
      visibility: request.visibility,
      eligibility: decision.eligibility,
      reasons: decision.reasons,
    };

    const defects = vectorIntegrityDefects(content);
    if (defects.length > 0) {
      return fail(
        "INVALID_INPUT",
        defects[0] ?? "body-integrity",
        "the record body fails integrity verification",
        { defects },
      );
    }

    let digest: Digest;
    let payloadBytes: Uint8Array;
    try {
      digest = vectorDigest(content, this.limits);
      payloadBytes = new TextEncoder().encode(canonicalJson(vectorDigestInput(content), this.limits));
    } catch (error) {
      if (error instanceof CanonicalizationError) {
        return fail(
          "RESOURCE_LIMIT",
          `canonicalization-${error.reason}`,
          "the vector body exceeds the canonicalisation budget of this profile",
        );
      }
      throw error;
    }

    const payloadCheck = assertPayloadClean(vectorDigestInput(content), context.sensitive);
    if (!payloadCheck.ok) {
      enforceDeny(
        this.storage,
        auditRow(projectId, actor, "vector.create", null, "deny", payloadCheck.reason, {
          evidenceId: content.source.evidenceId,
        }),
      );
      return fail(
        "SENSITIVE_CONTENT_BLOCKED",
        payloadCheck.reason,
        "the extracted record is refused by the diagnostic filter",
      );
    }

    const published = await this.artifacts.publish(projectId, "inspector", payloadBytes);
    if (!published.ok) {
      return fail(
        "CAPABILITY_UNAVAILABLE",
        published.error.code,
        "the vector payload could not be published to the artifact store",
      );
    }
    const payloadArtifactId = newId();

    const committed = this.commitDecision(
      projectId,
      actor,
      "vector.create",
      content.id,
      "vector-created",
      { evidenceId: content.source.evidenceId, eligibility: content.eligibility, digest },
      (tx): Step<Omit<VectorCommit, "auditSeq">> => {
        const project = tx.getProject(projectId);
        if (project === null) return { kind: "failure", failure: fail("NOT_FOUND", "project-unknown", "project not found") };
        const evidence = tx.getEvidence(projectId, content.source.evidenceId);
        if (evidence === null) {
          return {
            kind: "failure",
            failure: fail("NOT_FOUND", "evidence-unknown", "evidence is not persisted in this project"),
          };
        }
        if (evidence.targetId !== content.targetId) {
          return {
            kind: "failure",
            failure: fail(
              "INVALID_INPUT",
              "evidence-target-mismatch",
              "the evidence belongs to a different target than the vector claims",
            ),
          };
        }
        const target = tx.getTarget(projectId, content.targetId);
        if (target === null) return { kind: "failure", failure: fail("NOT_FOUND", "target-unknown", "target not found") };
        if (target.snapshotDigest === null) {
          return {
            kind: "failure",
            failure: fail(
              "SAMPLE_UNUSABLE",
              "target-snapshot-missing",
              `an uncaptured target has no snapshot digest (${target.identityReason ?? "no reason recorded"})`,
            ),
          };
        }
        if (target.snapshotDigest !== content.snapshotDigest) {
          return {
            kind: "failure",
            failure: fail(
              "STALE_INPUT",
              "snapshot-digest-mismatch",
              "the target's current snapshot differs from the digest this vector binds",
            ),
          };
        }

        if (content.replacesId !== null) {
          const predecessor = tx.getVector(projectId, content.replacesId);
          if (predecessor === null) {
            return {
              kind: "failure",
              failure: fail("NOT_FOUND", "predecessor-unknown", "the replaced vector is not in this project"),
            };
          }
          const cluster = this.chainCluster(tx, projectId, content.targetId, content.source.evidenceId);
          if (!cluster.ok) return { kind: "failure", failure: cluster };
          const cycle = this.assertNoCycle(cluster.value, content.replacesId);
          if (!cycle.ok) return { kind: "failure", failure: cycle };
          const predecessorSource = vectorSourceSchema.safeParse(predecessor.sourceLocatorJson);
          if (!predecessorSource.success) {
            return {
              kind: "failure",
              failure: fail(
                "REA_CONTRACT_MISMATCH",
                "predecessor-locator-shape",
                "the predecessor's stored coordinates are unreadable",
              ),
            };
          }
          const mismatched: string[] = [];
          if (predecessor.targetId !== content.targetId) mismatched.push("targetId");
          if (predecessor.snapshotDigest !== content.snapshotDigest) mismatched.push("snapshotDigest");
          if (predecessor.evidenceId !== content.source.evidenceId) mismatched.push("evidenceId");
          if (!sameSourceCoordinates(toSource(predecessorSource.data), content.source)) mismatched.push("record");
          if (predecessor.caseKey !== content.caseKey) mismatched.push("caseKey");
          if (mismatched.length > 0) {
            return {
              kind: "failure",
              failure: fail(
                "INVALID_INPUT",
                "replacement-not-same-record",
                `a revision may only replace the same source record; mismatched: ${mismatched.join(",")}`,
                { mismatched },
              ),
            };
          }
        }

        tx.insertArtifact({
          id: payloadArtifactId,
          projectId,
          jobId: null,
          class: "inspector",
          sha256: published.value.sha256,
          digestReason: null,
          byteLength: published.value.byteLength,
          storageKey: published.value.storageKey,
          mediaType: "application/json",
          createdAt: nowInstant(),
        });

        tx.insertVector({
          id: content.id,
          projectId,
          targetId: content.targetId,
          evidenceId: content.source.evidenceId,
          sourceLocatorJson: content.source as unknown as JsonValue,
          snapshotDigest: content.snapshotDigest,
          payloadArtifactId,
          digest,
          replacesId: content.replacesId,
          caseKey: content.caseKey,
          visibility: content.visibility,
          eligibility: content.eligibility,
          reasonsJson: content.reasons,
          reviewStatus: "draft",
          reviewRecordJson: null,
        });

        tx.upsertProjectRevision(projectId, { inventory: 1 });
        const refreshed = tx.getProject(projectId);
        if (refreshed === null) throw new Error("project row missing after revision bump");
        const eventSeq = tx.appendEvent({
          projectId,
          type: "vector.created",
          aggregateId: content.id,
          payloadJson: {
            resourceIds: [content.id, content.source.evidenceId],
            inventoryRevision: refreshed.inventoryRevision,
          },
          createdAt: nowInstant(),
        });
        return {
          kind: "committed",
          value: {
            vectorId: content.id,
            digest,
            eligibility: content.eligibility,
            reasons: content.reasons,
            inventoryRevision: refreshed.inventoryRevision,
            eventSeq,
          },
        };
      },
    );

    if (!committed.ok) return committed;
    return { ok: true, value: { ...committed.value.value, auditSeq: committed.value.auditSeq } };
  }

  async review(
    projectId: Id,
    actor: VectorActor,
    vectorId: Id,
    input: unknown,
    context: VectorOperationContext,
  ): Promise<Result<VectorCommit, VectorFailure>> {
    if (!APPROVER_KINDS.includes(actor.actorKind)) {
      enforceDeny(
        this.storage,
        auditRow(projectId, actor, "vector.review", vectorId, "deny", "actor-may-not-review", {}),
      );
      return fail(
        "ACCESS_DENIED",
        "actor-may-not-review",
        "only an inspector or reviewer may record a vector decision",
      );
    }

    const parsed = vectorReviewRequestSchema.safeParse(input);
    if (!parsed.success) {
      return fail(
        "INVALID_INPUT",
        "review-request",
        safeMessage(`review request rejected: ${issueNames(parsed.error.issues).join(",")}`, context),
      );
    }
    const request = parsed.data;

    const committed = this.commitDecision(
      projectId,
      actor,
      "vector.review",
      vectorId,
      `vector-${request.decision}`,
      { decision: request.decision, digest: request.digest },
      (tx): Step<Omit<VectorCommit, "auditSeq">> => {
        const project = tx.getProject(projectId);
        if (project === null) return { kind: "failure", failure: fail("NOT_FOUND", "project-unknown", "project not found") };
        if (project.inventoryRevision !== request.expectedInventoryRevision) {
          return {
            kind: "failure",
            failure: fail(
              "REVISION_CONFLICT",
              "inventory-revision-changed",
              `the sample inventory moved to revision ${String(project.inventoryRevision)} while this review was prepared`,
              { expected: request.expectedInventoryRevision, actual: project.inventoryRevision },
            ),
          };
        }
        const row = tx.getVector(projectId, vectorId);
        if (row === null) return { kind: "failure", failure: fail("NOT_FOUND", "vector-unknown", "vector not found") };
        if (row.reviewStatus !== "draft") {
          return {
            kind: "failure",
            failure: fail(
              "REVISION_CONFLICT",
              "vector-already-reviewed",
              "a recorded decision is never overwritten; create a revision instead",
            ),
          };
        }
        if (request.decision === "approved" && request.digest !== row.digest) {
          return {
            kind: "failure",
            failure: fail(
              "REVISION_CONFLICT",
              "approved-digest-mismatch",
              "the digest under review is not the digest of this vector",
            ),
          };
        }
        if (request.decision === "approved" && row.replacesId !== null) {
          const cluster = this.chainCluster(tx, projectId, row.targetId, row.evidenceId);
          if (!cluster.ok) return { kind: "failure", failure: cluster };
          const sibling = cluster.value.find(
            (entry) => entry.id !== row.id && entry.replacesId === row.replacesId && entry.reviewStatus === "approved",
          );
          if (sibling !== undefined) {
            return {
              kind: "failure",
              failure: fail(
                "REVISION_CONFLICT",
                "two-approved-successors",
                "one revision may hold at most one approved successor",
                { sibling: sibling.id },
              ),
            };
          }
        }

        const reviewedAt = nowInstant();
        const review: VectorReview = {
          status: request.decision,
          reviewerId: request.reviewerId,
          reviewedAt,
          approvedDigest: request.decision === "approved" ? row.digest : null,
        };
        tx.updateVectorReview({
          ...row,
          reviewStatus: review.status,
          reviewRecordJson: review as unknown as JsonValue,
        });
        tx.upsertProjectRevision(projectId, { inventory: 1 });
        const refreshed = tx.getProject(projectId);
        if (refreshed === null) throw new Error("project row missing after revision bump");
        const eventSeq = tx.appendEvent({
          projectId,
          type: "vector.reviewed",
          aggregateId: row.id,
          payloadJson: {
            resourceIds: [row.id],
            inventoryRevision: refreshed.inventoryRevision,
            reasonCode: `vector-${request.decision}`,
          },
          createdAt: reviewedAt,
        });
        return {
          kind: "committed",
          value: {
            vectorId: row.id,
            digest: row.digest,
            eligibility: row.eligibility,
            reasons: stringArray(row.reasonsJson),
            inventoryRevision: refreshed.inventoryRevision,
            eventSeq,
          },
        };
      },
    );

    if (!committed.ok) return committed;
    return { ok: true, value: { ...committed.value.value, auditSeq: committed.value.auditSeq } };
  }

  async read(
    projectId: Id,
    actor: VectorActor,
    vectorId: Id,
  ): Promise<Result<TestVector, VectorFailure>> {
    if (actor.actorKind === "builder") return this.denyBuilder(projectId, actor, "vector.read", vectorId);
    const looked = this.storage.transact((tx) => tx.getVector(projectId, vectorId));
    if (!looked.ok) return fail("INVALID_INPUT", looked.error.code, looked.error.message);
    const row = looked.value;
    if (row === null) return fail("NOT_FOUND", "vector-unknown", "vector not found");
    if (row.visibility === "holdout" && actor.actorKind === "system") {
      // Nothing in the generation path may read a holdout sample (§7.3).
      enforceDeny(
        this.storage,
        auditRow(projectId, actor, "vector.read", row.id, "deny", "holdout-not-for-generation", {}),
      );
      return fail("ACCESS_DENIED", "holdout-not-for-generation", "holdout vectors stay with the control plane");
    }
    return await this.materialize(row);
  }

  list(
    projectId: Id,
    actor: VectorActor,
    targetId: Id | null,
  ): Result<VectorRow[], VectorFailure> {
    if (actor.actorKind === "builder") return this.denyBuilder(projectId, actor, "vector.list", null);
    const listed = this.storage.transact((tx) =>
      tx.listVectors(projectId, { targetId, evidenceId: null, limit: CHAIN_SCAN_LIMIT }),
    );
    if (!listed.ok) return fail("INVALID_INPUT", listed.error.code, listed.error.message);
    // A listing is a disclosure surface: holdout rows stay with the control plane
    // and the rows themselves never carry bodies.
    const controlPlane = actor.actorKind === "inspector" || actor.actorKind === "reviewer";
    return {
      ok: true,
      value: controlPlane ? listed.value : listed.value.filter((row) => row.visibility === "public"),
    };
  }

  // The inventory page (§8 line 283). Three things the unpaged `list` above does not do, and
  // each of them is the route's contract rather than an optimisation:
  //
  //  * it reports the `inventoryRevision` the page was cut at, and a cursor that names a
  //    different one is a conflict (409) rather than a page that mixes two inventories;
  //  * it cuts on the row's own id, so a capture landing mid-pagination neither skips a row
  //    nor repeats one;
  //  * it answers with the six summary fields and no body - a listing is a disclosure
  //    surface, and the bytes only ever come back through the named single-vector read.
  page(
    projectId: Id,
    actor: VectorActor,
    input: { targetId: Id; cursor: string | null; limit: number | null | undefined },
  ): Result<VectorPage, VectorFailure> {
    if (actor.actorKind === "builder") return this.denyBuilder(projectId, actor, "vector.list", null);
    const limit = input.limit ?? VECTOR_PAGE_DEFAULT_LIMIT;
    if (limit > VECTOR_PAGE_MAX_LIMIT) {
      return fail("RESOURCE_LIMIT", "vector-limit", `an inventory page is at most ${String(VECTOR_PAGE_MAX_LIMIT)} rows`, {
        limit,
        maxLimit: VECTOR_PAGE_MAX_LIMIT,
      });
    }
    let afterId: Id | null = null;
    let pinnedRevision: number | null = null;
    if (input.cursor !== null) {
      const decoded = decodePageCursor(input.cursor, 2, "vector-cursor");
      if (!decoded.ok) return decoded;
      const [revision, id] = decoded.value as [string, string];
      if (!/^(0|[1-9]\d*)$/.test(revision) || !isId(id)) {
        return fail("INVALID_INPUT", "vector-cursor", "the page cursor is not one this server issued");
      }
      pinnedRevision = Number(revision);
      afterId = id as Id;
    }
    // The disclosure rule is decided before the read, not after it: `system` and the web
    // session roles see public rows, and only inspector/reviewer see holdout rows at all.
    const controlPlane = actor.actorKind === "inspector" || actor.actorKind === "reviewer";
    const read = this.storage.transact((tx) => {
      const project = tx.getProject(projectId);
      if (project === null) return { missing: true as const };
      // One transaction for the revision and the rows: reading the revision first would let a
      // write land in between and have the page claim a state it is not showing.
      return {
        missing: false as const,
        revision: project.inventoryRevision,
        rows: tx.listVectorsAfter(projectId, {
          targetId: input.targetId,
          afterId,
          publicOnly: !controlPlane,
          limit: limit + 1,
        }),
      };
    });
    if (!read.ok) return fail("INVALID_INPUT", read.error.code, read.error.message);
    if (read.value.missing) return fail("NOT_FOUND", "project-unknown", "project not found");
    if (pinnedRevision !== null && pinnedRevision !== read.value.revision) {
      return fail(
        "REVISION_CONFLICT",
        "vector-inventory-moved",
        "the inventory changed since this page was cut; re-read from the start",
        { pinnedRevision, currentRevision: read.value.revision },
      );
    }
    const rows = read.value.rows as VectorRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      ok: true,
      value: {
        inventoryRevision: read.value.revision,
        items: page.map((row) => ({
          id: row.id,
          digest: row.digest,
          caseKey: row.caseKey,
          visibility: row.visibility,
          eligibility: row.eligibility,
          review: reviewOf(row),
        })),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodePageCursor([String(read.value.revision), last.id])
            : null,
      },
    };
  }

  // Bulk read for the contract gate. Each payload digest is verified against its
  // index row, so content read outside a write transaction is still provably the
  // content that transaction is deciding about.
  async loadContents(
    projectId: Id,
    vectorIds: readonly Id[],
  ): Promise<Result<Map<string, TestVector>, VectorFailure>> {
    const loaded = new Map<string, TestVector>();
    for (const vectorId of vectorIds) {
      const looked = this.storage.transact((tx) => tx.getVector(projectId, vectorId));
      if (!looked.ok) return fail("INVALID_INPUT", looked.error.code, looked.error.message);
      if (looked.value === null) return fail("NOT_FOUND", "vector-unknown", "vector not found");
      const read = await this.materialize(looked.value);
      if (!read.ok) return read;
      loaded.set(vectorId, read.value);
    }
    return { ok: true, value: loaded };
  }

  private async materialize(row: VectorRow): Promise<Result<TestVector, VectorFailure>> {
    const artifactLookup = this.storage.transact((tx) => tx.getArtifact(row.projectId, row.payloadArtifactId));
    if (!artifactLookup.ok) return fail("INVALID_INPUT", artifactLookup.error.code, artifactLookup.error.message);
    const artifact = artifactLookup.value;
    if (artifact === null) return fail("NOT_FOUND", "payload-unknown", "vector payload artifact is missing");
    const bytes = await this.artifacts.read(row.projectId, artifact.storageKey);
    if (!bytes.ok) return fail("INVALID_INPUT", bytes.error.code, bytes.error.message);
    let json: JsonValue;
    try {
      json = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes.value)) as JsonValue;
    } catch {
      return fail("REA_CONTRACT_MISMATCH", "payload-unparseable", "vector payload is not JSON");
    }
    if (!isJsonObject(json)) return fail("REA_CONTRACT_MISMATCH", "payload-shape", "vector payload is not an object");
    const parsed = testVectorContentSchema.safeParse(json);
    if (!parsed.success) {
      return fail(
        "REA_CONTRACT_MISMATCH",
        "payload-schema",
        `vector payload violates the schema at ${issueNames(parsed.error.issues).join(",")}`,
      );
    }
    const content = toContent(parsed.data);
    // The payload repeats what the index asserts. If the two disagree, the row is
    // no longer describing the file it points at, which is an integrity failure
    // rather than a rendering choice.
    if (
      content.id !== row.id ||
      content.targetId !== row.targetId ||
      content.snapshotDigest !== row.snapshotDigest ||
      content.replacesId !== row.replacesId ||
      content.source.evidenceId !== row.evidenceId ||
      content.caseKey !== row.caseKey ||
      content.visibility !== row.visibility ||
      content.eligibility !== row.eligibility
    ) {
      return fail("REA_CONTRACT_MISMATCH", "payload-index-divergence", "payload no longer matches its index row");
    }
    const recomputed = vectorDigest(content, this.limits);
    if (recomputed !== row.digest) {
      return fail("REA_CONTRACT_MISMATCH", "digest-drift", "the stored payload no longer matches the indexed digest");
    }
    return {
      ok: true,
      value: { ...content, digest: row.digest, review: reviewOf(row) },
    };
  }
}

function reviewOf(row: VectorRow): VectorReview {
  if (row.reviewStatus === "draft") return draftReview();
  const record = row.reviewRecordJson;
  if (record === null || !isJsonObject(record)) {
    throw new Error("a reviewed vector must carry a review record");
  }
  const reviewerId = record["reviewerId"];
  const reviewedAt = record["reviewedAt"];
  const approvedDigest = record["approvedDigest"];
  if (typeof reviewerId !== "string" || typeof reviewedAt !== "string") {
    throw new Error("a reviewed vector must name its reviewer and instant");
  }
  return {
    status: row.reviewStatus,
    reviewerId,
    reviewedAt: reviewedAt as Instant,
    approvedDigest: typeof approvedDigest === "string" ? asDigest(approvedDigest) : null,
  };
}

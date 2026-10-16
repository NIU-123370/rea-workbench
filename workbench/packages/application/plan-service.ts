import { CanonicalizationError } from "../domain/canonical-json.ts";
import type { CanonicalLimits, Digest } from "../domain/canonical-json.ts";
import { asDigest } from "../domain/canonical-json.ts";
import { asId, newId, nowInstant } from "../domain/identity.ts";
import type { Id, Instant } from "../domain/identity.ts";
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import {
  planBuildRequestSchema,
  planReviewRequestSchema,
  verificationPlanContentSchema,
  type PlanContentWire,
  type VerificationPlanWire,
} from "../contracts/behaviors.ts";
import type { ContractRevisionContent } from "../domain/contract.ts";
import type { ExcludedVector } from "../domain/inventory.ts";
import {
  deriveSelectedVectorIds,
  inventorySnapshotDigest,
  planDigest,
  planDigestInput,
  planGateReasons,
  type PlanContractFact,
  type PlanVectorFact,
  type VerificationPlan,
  type VerificationPlanContent,
} from "../domain/plan.ts";
import type { ReviewStatus } from "../domain/vector.ts";
import { isBuilder, mayRecordDecision, type Actor } from "./actor.ts";
import { contractContentOf } from "./contract-service.ts";
import { commitDecision, recordDeny, type Step } from "./decision.ts";
import { blockedByReasons, gateFail, issueNames, type GateFailure } from "./gate-failure.ts";
import type { ContractRow, PlanRow, StorageWriterPort, VectorRow } from "./ports.ts";

// PlanService freezes the verification plan (DESIGN §7.4, D27). Its whole purpose
// is that nobody gets to move the denominator afterwards: `selectedVectorIds` is
// derived from the approved contracts, the exclusions must exhaust the same
// snapshot, and an approved plan is never rewritten — a narrower promise is a new
// contract revision, a new plan and a new blueprint.

// A plan reads and re-derives the whole snapshot, so the bound is explicit and
// passing it is a refusal rather than a silently partial denominator.
export const PLAN_INVENTORY_LIMIT = 2000;

export type PlanCommit = {
  planId: Id;
  digest: Digest;
  inventoryDigest: Digest;
  selectedCount: number;
  excludedCount: number;
  graphRevision: number;
  inventoryRevision: number;
  reviewStatus: ReviewStatus;
  auditSeq: number;
  eventSeq: number | null;
};

export function vectorFactsOf(rows: readonly VectorRow[]): PlanVectorFact[] {
  return rows.map((row) => ({
    id: row.id,
    targetId: row.targetId,
    snapshotDigest: row.snapshotDigest,
    evidenceId: row.evidenceId,
    caseKey: row.caseKey,
    eligibility: row.eligibility,
    reasons: stringArray(row.reasonsJson),
    reviewStatus: row.reviewStatus,
    replacesId: row.replacesId,
    digest: row.digest,
  }));
}

function stringArray(value: JsonValue): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : [];
}

function contractFactsOf(
  row: ContractRow,
  content: ContractRevisionContent,
): PlanContractFact {
  return {
    id: row.id,
    targetId: row.targetId,
    snapshotDigest: content.scope.snapshotDigest,
    reviewStatus: row.reviewStatus,
    requiredCases: content.requiredCases,
  };
}

function excludedFromWire(entries: VerificationPlanWire["excludedVectors"]): ExcludedVector[] {
  return entries.map((entry) =>
    entry.reasonCode === "outside-scope"
      ? {
          vectorId: asId(entry.vectorId),
          reasonCode: "outside-scope",
          reason: entry.reason,
          excludedBehavior: entry.excludedBehavior,
          supersededBy: null,
        }
      : {
          vectorId: asId(entry.vectorId),
          reasonCode: "superseded",
          reason: entry.reason,
          excludedBehavior: entry.excludedBehavior,
          supersededBy: asId(entry.supersededBy),
        },
  );
}

function contentFromWire(data: PlanContentWire): VerificationPlanContent {
  return {
    id: asId(data.id),
    targetId: asId(data.targetId),
    snapshotDigest: asDigest(data.snapshotDigest),
    contractRevisionIds: data.contractRevisionIds.map((id) => asId(id)),
    graphRevision: data.graphRevision,
    inventoryRevision: data.inventoryRevision,
    inventoryDigest: asDigest(data.inventoryDigest),
    selectedVectorIds: data.selectedVectorIds.map((id) => asId(id)),
    excludedVectors: excludedFromWire(data.excludedVectors),
  };
}

export function planContentOf(row: PlanRow): VerificationPlanContent | null {
  const parsed = verificationPlanContentSchema.safeParse(row.payloadJson);
  if (!parsed.success) return null;
  return contentFromWire(parsed.data);
}

export class PlanService {
  readonly storage: StorageWriterPort;
  readonly limits: CanonicalLimits;

  constructor(deps: { storage: StorageWriterPort; limits: CanonicalLimits }) {
    this.storage = deps.storage;
    this.limits = deps.limits;
  }

  build(
    projectId: Id,
    actor: Actor,
    input: unknown,
  ): Result<PlanCommit, GateFailure> {
    if (isBuilder(actor)) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "plan",
        action: "plan.build",
        resourceId: null,
        decision: "deny",
        reasonCode: "builder-has-no-plan-permission",
        metadata: {},
      });
      return gateFail(
        "ACCESS_DENIED",
        "builder-has-no-plan-permission",
        "Builder reads blueprint projections only (DESIGN §7.3)",
      );
    }
    const parsed = planBuildRequestSchema.safeParse(input);
    if (!parsed.success) {
      return gateFail("INVALID_INPUT", "build-request", "plan build request rejected", {
        issues: issueNames(parsed.error.issues) as unknown as JsonValue,
      });
    }
    const request = parsed.data;

    const committed = commitDecision<Omit<PlanCommit, "auditSeq" | "eventSeq">>(this.storage, {
      projectId,
      actor,
      resourceType: "plan",
      action: "plan.build",
      resourceId: null,
      allowReason: "plan-built",
      metadata: { contractCount: request.contractRevisionIds.length },
      work: (tx): Step<Omit<PlanCommit, "auditSeq" | "eventSeq">> => {
        const project = tx.getProject(projectId);
        if (project === null) {
          return { kind: "failure", failure: gateFail("NOT_FOUND", "project-unknown", "project not found") };
        }
        if (project.inventoryRevision !== request.expectedInventoryRevision) {
          return {
            kind: "failure",
            failure: gateFail(
              "REVISION_CONFLICT",
              "inventory-revision-changed",
              `the sample inventory moved to revision ${String(project.inventoryRevision)} while this plan was prepared`,
              { expected: request.expectedInventoryRevision, actual: project.inventoryRevision },
            ),
          };
        }

        const contracts: { row: ContractRow; content: ContractRevisionContent }[] = [];
        for (const contractId of request.contractRevisionIds) {
          const row = tx.getContract(projectId, asId(contractId));
          if (row === null) {
            return {
              kind: "failure",
              failure: gateFail("NOT_FOUND", "contract-unknown", `contract ${contractId} is not in this project`),
            };
          }
          const content = contractContentOf(row);
          if (content === null) {
            return {
              kind: "failure",
              failure: gateFail("REA_CONTRACT_MISMATCH", "contract-payload-shape", "stored contract payload is malformed"),
            };
          }
          contracts.push({ row, content });
        }

        const inventoryRows = tx.listVectorsForSnapshot(
          projectId,
          asId(request.targetId),
          asDigest(request.snapshotDigest),
          PLAN_INVENTORY_LIMIT + 1,
        );
        if (inventoryRows.length > PLAN_INVENTORY_LIMIT) {
          return {
            kind: "failure",
            failure: gateFail(
              "RESOURCE_LIMIT",
              "inventory-too-large",
              `the frozen snapshot holds more than ${String(PLAN_INVENTORY_LIMIT)} vectors; the plan cannot prove a denominator`,
              { bound: PLAN_INVENTORY_LIMIT },
            ),
          };
        }
        const inventory = vectorFactsOf(inventoryRows);

        const content: VerificationPlanContent = {
          id: newId(),
          targetId: asId(request.targetId),
          snapshotDigest: asDigest(request.snapshotDigest),
          contractRevisionIds: request.contractRevisionIds.map((id) => asId(id)),
          // Both revisions are read from the project row at this instant: the plan
          // binds the graph and inventory it was derived against (§7.4).
          graphRevision: project.graphRevision,
          inventoryRevision: project.inventoryRevision,
          inventoryDigest: inventorySnapshotDigest(inventory.map((entry) => ({ id: entry.id, digest: entry.digest }))),
          selectedVectorIds: deriveSelectedVectorIds(
            contracts.flatMap((entry) => entry.content.requiredCases),
          ),
          excludedVectors: excludedFromWire(request.excludedVectors),
        };

        let digest: Digest;
        try {
          digest = planDigest(content, this.limits);
        } catch (error) {
          if (error instanceof CanonicalizationError) {
            return {
              kind: "failure",
              failure: gateFail("RESOURCE_LIMIT", `canonicalization-${error.reason}`, "plan payload exceeds the budget"),
            };
          }
          throw error;
        }

        const reasons = planGateReasons({
          content,
          inventory,
          contracts: contracts.map((entry) => contractFactsOf(entry.row, entry.content)),
          contradictingEvidenceIds: tx.contradictingEvidenceIds(
            projectId,
            contracts.flatMap((entry) => entry.content.sourceClaimIds),
          ),
          // A draft plan is allowed to state its gaps (§7.4); completeness is the
          // approval and freeze question, asked again in `review`.
          requireComplete: false,
        });
        if (reasons.length > 0) {
          return { kind: "failure", failure: blockedByReasons(reasons, "BLUEPRINT_BLOCKED", "plan build") };
        }

        tx.insertPlan({
          id: content.id,
          projectId,
          targetId: content.targetId,
          snapshotDigest: content.snapshotDigest,
          graphRevision: content.graphRevision,
          inventoryRevision: content.inventoryRevision,
          inventoryDigest: content.inventoryDigest,
          payloadJson: planDigestInput(content),
          digest,
          reviewStatus: "draft",
          reviewRecordJson: null,
          createdAt: nowInstant(),
        });

        return {
          kind: "committed",
          value: {
            planId: content.id,
            digest,
            inventoryDigest: content.inventoryDigest,
            selectedCount: content.selectedVectorIds.length,
            excludedCount: content.excludedVectors.length,
            graphRevision: content.graphRevision,
            inventoryRevision: content.inventoryRevision,
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

  review(
    projectId: Id,
    actor: Actor,
    planId: Id,
    input: unknown,
  ): Result<PlanCommit, GateFailure> {
    if (!mayRecordDecision(actor)) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "plan",
        action: "plan.review",
        resourceId: planId,
        decision: "deny",
        reasonCode: "actor-may-not-review",
        metadata: {},
      });
      return gateFail(
        "ACCESS_DENIED",
        "actor-may-not-review",
        "only an inspector or reviewer may record a plan decision",
      );
    }
    const parsed = planReviewRequestSchema.safeParse(input);
    if (!parsed.success) {
      return gateFail("INVALID_INPUT", "review-request", "plan review request rejected", {
        issues: issueNames(parsed.error.issues) as unknown as JsonValue,
      });
    }
    const request = parsed.data;

    const committed = commitDecision<Omit<PlanCommit, "auditSeq">>(this.storage, {
      projectId,
      actor,
      resourceType: "plan",
      action: "plan.review",
      resourceId: planId,
      allowReason: `plan-${request.decision}`,
      metadata: { decision: request.decision, digest: request.digest },
      work: (tx): Step<Omit<PlanCommit, "auditSeq">> => {
        const project = tx.getProject(projectId);
        if (project === null) {
          return { kind: "failure", failure: gateFail("NOT_FOUND", "project-unknown", "project not found") };
        }
        const row = tx.getPlan(projectId, planId);
        if (row === null) return { kind: "failure", failure: gateFail("NOT_FOUND", "plan-unknown", "plan not found") };
        if (row.reviewStatus !== "draft") {
          return {
            kind: "failure",
            failure: gateFail(
              "REVISION_CONFLICT",
              "plan-already-reviewed",
              "a frozen plan is never rewritten; build a new plan instead",
            ),
          };
        }
        if (request.decision === "approved" && request.digest !== row.digest) {
          return {
            kind: "failure",
            failure: gateFail("REVISION_CONFLICT", "approved-digest-mismatch", "the digest under review is not this plan's"),
          };
        }
        if (project.inventoryRevision !== request.expectedInventoryRevision) {
          return {
            kind: "failure",
            failure: gateFail(
              "REVISION_CONFLICT",
              "inventory-revision-changed",
              `the sample inventory moved to revision ${String(project.inventoryRevision)} while this review was prepared`,
              { expected: request.expectedInventoryRevision, actual: project.inventoryRevision },
            ),
          };
        }

        const content = planContentOf(row);
        if (content === null) {
          return {
            kind: "failure",
            failure: gateFail("REA_CONTRACT_MISMATCH", "plan-payload-shape", "stored plan payload is malformed"),
          };
        }

        const inventoryRows = tx.listVectorsForSnapshot(
          projectId,
          content.targetId,
          content.snapshotDigest,
          PLAN_INVENTORY_LIMIT + 1,
        );
        if (inventoryRows.length > PLAN_INVENTORY_LIMIT) {
          return {
            kind: "failure",
            failure: gateFail("RESOURCE_LIMIT", "inventory-too-large", "the snapshot exceeds the plan bound"),
          };
        }
        const inventory = vectorFactsOf(inventoryRows);
        // The plan froze a snapshot, not a count. New evidence in the same scope
        // changes the denominator, so it must be re-planned rather than approved
        // around (§7.4, §10).
        const currentDigest = inventorySnapshotDigest(
          inventory.map((entry) => ({ id: entry.id, digest: entry.digest })),
        );
        if (currentDigest !== content.inventoryDigest) {
          return {
            kind: "failure",
            failure: gateFail(
              "STALE_INPUT",
              "inventory-moved-since-build",
              "the frozen inventory no longer matches this snapshot; build a new plan",
            ),
          };
        }

        const contracts: PlanContractFact[] = [];
        for (const contractId of content.contractRevisionIds) {
          const contractRow = tx.getContract(projectId, contractId);
          if (contractRow === null) {
            return {
              kind: "failure",
              failure: gateFail("NOT_FOUND", "contract-unknown", "a contract this plan binds is missing"),
            };
          }
          const contractContent = contractContentOf(contractRow);
          if (contractContent === null) {
            return {
              kind: "failure",
              failure: gateFail("REA_CONTRACT_MISMATCH", "contract-payload-shape", "stored contract payload is malformed"),
            };
          }
          contracts.push(contractFactsOf(contractRow, contractContent));
        }

        const reasons = planGateReasons({
          content,
          inventory,
          contracts,
          contradictingEvidenceIds: tx.contradictingEvidenceIds(
            projectId,
            contracts.flatMap((entry) => entry.requiredCases.map((caseEntry) => caseEntry.claimId)),
          ),
          requireComplete: request.decision === "approved",
        });
        if (reasons.length > 0) {
          return { kind: "failure", failure: blockedByReasons(reasons, "BLUEPRINT_BLOCKED", "plan review") };
        }

        const reviewedAt: Instant = nowInstant();
        tx.updatePlanReview({
          ...row,
          reviewStatus: request.decision,
          reviewRecordJson: {
            status: request.decision,
            reviewerId: request.reviewerId,
            reviewedAt,
            approvedDigest: request.decision === "approved" ? row.digest : null,
          },
        });
        const eventSeq = tx.appendEvent({
          projectId: row.projectId,
          type: "plan.reviewed",
          aggregateId: row.id,
          payloadJson: {
            resourceIds: [row.id, ...content.selectedVectorIds],
            graphRevision: row.graphRevision,
            inventoryRevision: row.inventoryRevision,
            reasonCode: `plan-${request.decision}`,
          },
          createdAt: reviewedAt,
        });
        return {
          kind: "committed",
          value: {
            planId: row.id,
            digest: row.digest,
            inventoryDigest: row.inventoryDigest,
            selectedCount: content.selectedVectorIds.length,
            excludedCount: content.excludedVectors.length,
            graphRevision: row.graphRevision,
            inventoryRevision: row.inventoryRevision,
            reviewStatus: request.decision,
            eventSeq,
          },
        };
      },
    });

    if (!committed.ok) return committed;
    return { ok: true, value: { ...committed.value.value, auditSeq: committed.value.auditSeq } };
  }

  read(projectId: Id, actor: Actor, planId: Id): Result<VerificationPlan, GateFailure> {
    if (isBuilder(actor)) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "plan",
        action: "plan.read",
        resourceId: planId,
        decision: "deny",
        reasonCode: "builder-has-no-plan-permission",
        metadata: {},
      });
      return gateFail("ACCESS_DENIED", "builder-has-no-plan-permission", "Builder reads blueprint projections only");
    }
    const looked = this.storage.transact((tx) => {
      const row = tx.getPlan(projectId, planId);
      if (row === null) return null;
      const content = planContentOf(row);
      if (content === null) return { malformed: true as const };
      return { malformed: false as const, plan: rebuild(row, content) };
    });
    if (!looked.ok) return gateFail("INVALID_INPUT", looked.error.code, looked.error.message);
    if (looked.value === null) return gateFail("NOT_FOUND", "plan-unknown", "plan not found");
    if ("malformed" in looked.value && looked.value.malformed) {
      return gateFail("REA_CONTRACT_MISMATCH", "plan-payload-shape", "stored plan payload is malformed");
    }
    return { ok: true, value: looked.value.plan };
  }

  list(projectId: Id, actor: Actor, targetId: Id | null): Result<VerificationPlan[], GateFailure> {
    if (isBuilder(actor)) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "plan",
        action: "plan.list",
        resourceId: null,
        decision: "deny",
        reasonCode: "builder-has-no-plan-permission",
        metadata: {},
      });
      return gateFail("ACCESS_DENIED", "builder-has-no-plan-permission", "Builder reads blueprint projections only");
    }
    const listed = this.storage.transact((tx) =>
      tx.listPlans(projectId, { targetId, limit: PLAN_INVENTORY_LIMIT }),
    );
    if (!listed.ok) return gateFail("INVALID_INPUT", listed.error.code, listed.error.message);
    const plans: VerificationPlan[] = [];
    for (const row of listed.value) {
      const content = planContentOf(row);
      if (content === null) {
        return gateFail("REA_CONTRACT_MISMATCH", "plan-payload-shape", "stored plan payload is malformed");
      }
      plans.push(rebuild(row, content));
    }
    return { ok: true, value: plans };
  }
}

function rebuild(row: PlanRow, content: VerificationPlanContent): VerificationPlan {
  const record = row.reviewRecordJson;
  const field = (name: string): JsonValue | undefined =>
    record !== null && typeof record === "object" && !Array.isArray(record)
      ? (record as Record<string, JsonValue>)[name]
      : undefined;
  const reviewerId = field("reviewerId");
  const reviewedAt = field("reviewedAt");
  const approvedDigest = field("approvedDigest");
  return {
    ...content,
    digest: row.digest,
    createdAt: row.createdAt,
    review: {
      status: row.reviewStatus,
      reviewerId: typeof reviewerId === "string" ? reviewerId : null,
      reviewedAt: typeof reviewedAt === "string" ? (reviewedAt as Instant) : null,
      approvedDigest: typeof approvedDigest === "string" ? asDigest(approvedDigest) : null,
    },
  };
}

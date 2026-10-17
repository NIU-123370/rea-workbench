import { digestBytes } from "../domain/canonical-json.ts";
import type { CanonicalLimits, Digest } from "../domain/canonical-json.ts";
import { asDigest } from "../domain/canonical-json.ts";
import { asId, newId, nowInstant } from "../domain/identity.ts";
import type { Id, Instant } from "../domain/identity.ts";
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import type { BuilderBlueprintWire, BlueprintSourceManifestWire } from "../contracts/blueprint.ts";
import {
  blueprintFreezeRequestSchema,
  blueprintSourceManifestSchema,
  builderBlueprintSchema,
} from "../contracts/blueprint.ts";
import type { ContractClaimFact, ContractRevisionContent } from "../domain/contract.ts";
import { contractGateReasons } from "../domain/contract.ts";
import type {
  BlueprintClaim,
  BlueprintContractEntry,
  BlueprintPayload,
  PublicTestVector,
  SourceManifest,
} from "../domain/blueprint.ts";
import {
  BLUEPRINT_SCHEMA_VERSION,
  blueprintDigestOf,
  buildBlueprintPayload,
  leakReasons,
  nonSeenClaimReasons,
  nonSeenEdgeReasons,
  publicVectorOf,
  sourceManifestDigestOf,
  sourceTextSuspicions,
} from "../domain/blueprint.ts";
import type { PlanVectorFact, VerificationPlanContent } from "../domain/plan.ts";
import { planGateReasons } from "../domain/plan.ts";
import type { TestVector } from "../domain/vector.ts";
import { isControlPlane, mayRecordDecision, type Actor } from "./actor.ts";

// What §8 line 293 answers with: the two facts of the row, the scope the plan froze, the
// allowlisted bundle, and the plan id for the control plane only.
export type BlueprintRead = {
  id: Id;
  digest: Digest;
  scope: string[];
  bundle: BlueprintPayload;
  verificationPlanId: Id | null;
};
import { claimFactOf, contractContentOf } from "./contract-service.ts";
import { commitDecision, recordDeny, type Step } from "./decision.ts";
import { blockedByReasons, gateFail, issueNames, type GateFailure } from "./gate-failure.ts";
import { planContentOf, vectorFactsOf } from "./plan-service.ts";
import { assertPayloadClean, type OperationFilterContext } from "./sanitizer.ts";
import type { ArtifactPort, ContractRow, PlanRow, StorageTransaction, StorageWriterPort, VectorRow } from "./ports.ts";
import type { VectorService } from "./vector-service.ts";

// BlueprintService is the handoff owner (DESIGN §7.3, D12/D13). It is the only
// module that turns control-plane rows into Builder-facing bytes, and it does so
// field by field: no spread of a domain object, no delete-a-keys filter. A freeze
// re-runs every gate the plan and its contracts passed, because a blueprint is a
// promise about a delivery and a plan approved an hour ago is not proof that the
// graph still supports it.

export type BlueprintCommit = {
  blueprintId: Id;
  digest: Digest;
  manifestDigest: Digest;
  planId: Id;
  publicVectorCount: number;
  holdoutVectorCount: number;
  contractCount: number;
  auditSeq: number;
};

const INVENTORY_BOUND = 2000;

// A placeholder for the payload the digest is computed over. `blueprintDigest` is
// excluded from its own input (§7.3), so this value cannot affect the result.
const ZERO_DIGEST = asDigest("0".repeat(64));

type FreezeSnapshot = {
  planRow: PlanRow;
  plan: VerificationPlanContent;
  contracts: { row: ContractRow; content: ContractRevisionContent }[];
  vectors: VectorRow[];
  inventory: PlanVectorFact[];
  claimFacts: Map<string, ContractClaimFact>;
  edges: { id: string; relation: string; claim: ContractClaimFact }[];
  claimLinks: { claimId: Id; evidenceId: string; locationJson: JsonValue }[];
  contradictingEvidenceIds: string[];
  graphRevision: number;
  reviewAttribution: { reviewerId: string; reviewedAt: Instant; approvedDigest: Digest }[];
};

function missingClaim(claimId: Id, targetId: Id): ContractClaimFact {
  // A claim the contract cites but the project no longer holds is not a benign
  // absence: it projects UNKNOWN and therefore blocks (§6).
  return {
    id: claimId,
    targetId,
    basis: "unknown",
    validity: "current",
    sourceEvidenceIds: [],
    authorityApplies: false,
    coverage: { state: "unavailable", examined: null, total: null, reasons: ["claim-row-missing"] },
  };
}

function scopeOf(
  contracts: readonly { content: ContractRevisionContent }[],
  plan: VerificationPlanContent,
): string[] {
  const scope: string[] = [];
  for (const entry of contracts) {
    const content = entry.content;
    scope.push(`contract:${content.contractKey}@${String(content.revision)}`);
    for (const operationId of content.scope.operationIds) scope.push(`operation:${operationId}`);
    for (const behavior of content.scope.excludedBehaviors) scope.push(`excluded-behavior:${behavior}`);
  }
  for (const exclusion of plan.excludedVectors) scope.push(`inventory-excluded:${exclusion.excludedBehavior}`);
  return [...new Set(scope)];
}

function contractEntries(
  contracts: readonly { row: ContractRow; content: ContractRevisionContent }[],
): BlueprintContractEntry[] {
  return contracts.map((entry) => ({
    contractKey: entry.content.contractKey,
    revision: entry.content.revision,
    // The handoff names the contract revision by the digest the reviewer locked,
    // never by a target, snapshot or claim reference (§7.3).
    digest: entry.row.digest,
    behaviorSpec: entry.content.behaviorSpec,
    inputSchema: entry.content.inputSchema,
    outputSchema: entry.content.outputSchema,
    httpOperations: entry.content.httpOperations.map((operation) => ({
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
    errorCases: [...entry.content.errorCases],
    limitations: [...entry.content.limitations],
    unknowns: [...entry.content.unknowns],
  }));
}

function textsToScan(
  contracts: readonly { content: ContractRevisionContent }[],
  vectors: readonly TestVector[],
): string[] {
  const texts: string[] = [];
  for (const entry of contracts) {
    texts.push(entry.content.behaviorSpec);
    texts.push(...entry.content.errorCases, ...entry.content.limitations, ...entry.content.unknowns);
    texts.push(JSON.stringify(entry.content.inputSchema), JSON.stringify(entry.content.outputSchema));
  }
  for (const vector of vectors) {
    texts.push(JSON.stringify(vector.sdkInput), JSON.stringify(vector.expectedOutcome ?? null));
  }
  return texts;
}

// A leak is reported by category, never by value: the forbidden tokens are exactly
// the identifiers that must not reach a log, an audit row or the Builder.
function forbiddenCategories(
  projectId: Id,
  state: FreezeSnapshot,
  contents: ReadonlyMap<string, TestVector>,
  selectedIds: readonly Id[],
): Map<string, string> {
  const tokens = new Map<string, string>();
  tokens.set(projectId, "project-id");
  tokens.set(state.planRow.targetId, "target-id");
  tokens.set(state.planRow.id, "plan-id");
  tokens.set(state.planRow.snapshotDigest, "snapshot-digest");
  // A public vector's own id is on the allowlist, so only two kinds of vector id
  // may not appear in the handoff: one the plan never selected, and any holdout
  // sample (§7.3, D13).
  const selected = new Set(selectedIds.map((id) => String(id)));
  for (const row of state.vectors) {
    tokens.set(row.evidenceId, "evidence-id");
    if (row.visibility === "holdout" || !selected.has(row.id)) {
      tokens.set(row.id, row.visibility === "holdout" ? "holdout-vector-id" : "unselected-vector-id");
    }
  }
  for (const content of contents.values()) {
    if (content.source.pointer !== null) tokens.set(content.source.pointer, "record-pointer");
    if (content.source.transactionId !== null) tokens.set(content.source.transactionId, "transaction-id");
    for (const redaction of content.redactions) tokens.set(redaction.fieldPointer, "redaction-pointer");
    for (const location of content.source.captureId === null ? [] : [content.source.captureId]) {
      tokens.set(location, "capture-id");
    }
  }
  for (const link of state.claimLinks) {
    tokens.set(link.evidenceId, "evidence-id");
    if (typeof link.locationJson === "string") tokens.set(link.locationJson, "source-location");
  }
  const sized = new Map<string, string>();
  for (const [token, category] of tokens) {
    if (typeof token === "string" && token.length >= 8) sized.set(token, category);
  }
  return sized;
}

function driftReasons(
  before: FreezeSnapshot,
  after: FreezeSnapshot,
  selectedIds: readonly Id[],
): string[] {
  const drift: string[] = [];
  if (before.planRow.digest !== after.planRow.digest) drift.push("plan");
  if (before.planRow.reviewStatus !== after.planRow.reviewStatus) drift.push("plan-review");
  if (before.graphRevision !== after.graphRevision) drift.push("graph");
  if (before.contracts.length !== after.contracts.length) drift.push("contract-count");
  for (const entry of before.contracts) {
    const match = after.contracts.find((candidate) => candidate.row.id === entry.row.id);
    if (match === undefined || match.row.digest !== entry.row.digest) drift.push(`contract:${entry.row.id}`);
  }
  for (const vectorId of selectedIds) {
    const beforeRow = before.vectors.find((row) => row.id === vectorId);
    const afterRow = after.vectors.find((row) => row.id === vectorId);
    if (beforeRow === undefined || afterRow === undefined) drift.push(`vector:${vectorId}`);
    else if (beforeRow.digest !== afterRow.digest || beforeRow.reviewStatus !== afterRow.reviewStatus) {
      drift.push(`vector:${vectorId}`);
    }
  }
  if (before.contradictingEvidenceIds.join(",") !== after.contradictingEvidenceIds.join(",")) {
    drift.push("contradictions");
  }
  return [...new Set(drift)];
}

// The wire schema enforces the UUID and digest *patterns*, so re-branding the
// parsed value back to the domain's nominal types is total: this is a branding
// cast, not a shape change, and no field is added or dropped.
function brandPayload(wire: BuilderBlueprintWire): BlueprintPayload {
  return wire as unknown as BlueprintPayload;
}

function brandManifest(wire: BlueprintSourceManifestWire): SourceManifest {
  return wire as unknown as SourceManifest;
}

export class BlueprintService {
  readonly storage: StorageWriterPort;
  readonly artifacts: ArtifactPort;
  readonly vectors: VectorService;
  readonly limits: CanonicalLimits;

  constructor(deps: {
    storage: StorageWriterPort;
    artifacts: ArtifactPort;
    vectors: VectorService;
    limits: CanonicalLimits;
  }) {
    this.storage = deps.storage;
    this.artifacts = deps.artifacts;
    this.vectors = deps.vectors;
    this.limits = deps.limits;
  }

  private collect(
    tx: StorageTransaction,
    projectId: Id,
    planId: Id,
  ): Result<FreezeSnapshot, GateFailure> {
    const project = tx.getProject(projectId);
    if (project === null) return gateFail("NOT_FOUND", "project-unknown", "project not found");
    const planRow = tx.getPlan(projectId, planId);
    if (planRow === null) return gateFail("NOT_FOUND", "plan-unknown", "plan not found");
    const plan = planContentOf(planRow);
    if (plan === null) {
      return gateFail("REA_CONTRACT_MISMATCH", "plan-payload-shape", "stored plan payload is malformed");
    }

    const contracts: FreezeSnapshot["contracts"] = [];
    for (const contractId of plan.contractRevisionIds) {
      const row = tx.getContract(projectId, contractId);
      if (row === null) return gateFail("NOT_FOUND", "contract-unknown", "a contract this plan binds is missing");
      const content = contractContentOf(row);
      if (content === null) {
        return gateFail("REA_CONTRACT_MISMATCH", "contract-payload-shape", "stored contract payload is malformed");
      }
      contracts.push({ row, content });
    }

    const vectors = tx.listVectorsForSnapshot(projectId, planRow.targetId, planRow.snapshotDigest, INVENTORY_BOUND + 1);
    if (vectors.length > INVENTORY_BOUND) {
      return gateFail("RESOURCE_LIMIT", "inventory-too-large", "the frozen snapshot exceeds the blueprint bound");
    }

    const claimIds = [...new Set(contracts.flatMap((entry) => entry.content.sourceClaimIds))];
    const claimFacts = new Map<string, ContractClaimFact>();
    const claimLinks: FreezeSnapshot["claimLinks"] = [];
    for (const claimId of claimIds) {
      const row = tx.getClaim(projectId, claimId);
      claimFacts.set(claimId, row === null ? missingClaim(claimId, planRow.targetId) : claimFactOf(row));
      for (const link of tx.listClaimEvidence(projectId, claimId)) {
        claimLinks.push({ claimId, evidenceId: link.evidenceId, locationJson: link.locationJson });
      }
    }

    const edges = tx
      .listEdges(projectId, planRow.targetId)
      .filter((edge) => claimIds.some((claimId) => claimId === edge.claimId))
      .map((edge) => ({
        id: edge.id,
        relation: edge.relation,
        claim: claimFacts.get(edge.claimId) ?? missingClaim(edge.claimId, planRow.targetId),
      }));

    const reviewAttribution: FreezeSnapshot["reviewAttribution"] = [];
    for (const entry of contracts) {
      const record = entry.row.reviewRecordJson;
      if (entry.row.reviewStatus !== "approved" || record === null) continue;
      if (typeof record !== "object" || Array.isArray(record)) continue;
      const reviewerId = (record as Record<string, JsonValue>)["reviewerId"];
      const reviewedAt = (record as Record<string, JsonValue>)["reviewedAt"];
      if (typeof reviewerId === "string" && typeof reviewedAt === "string") {
        reviewAttribution.push({
          reviewerId,
          reviewedAt: reviewedAt as Instant,
          approvedDigest: entry.row.digest,
        });
      }
    }

    return {
      ok: true,
      value: {
        planRow,
        plan,
        contracts,
        vectors,
        inventory: vectorFactsOf(vectors),
        claimFacts,
        edges,
        claimLinks,
        contradictingEvidenceIds: tx.contradictingEvidenceIds(projectId, claimIds),
        graphRevision: project.graphRevision,
        reviewAttribution,
      },
    };
  }

  private blocked(
    projectId: Id,
    actor: Actor,
    reasons: readonly string[],
    resourceId: string | null,
  ): Result<never, GateFailure> {
    // A refused freeze is journalled: "the blueprint could not be built, and why"
    // is the record an auditor asks for (§12.2). The reason list itself is safe —
    // it names rules and ids the control plane already knows.
    recordDeny(this.storage, {
      projectId,
      actor,
      resourceType: "blueprint",
      action: "blueprint.freeze",
      resourceId,
      decision: "deny",
      reasonCode: reasons[0] ?? "gate-blocked",
      metadata: { reasonCount: reasons.length },
    });
    return blockedByReasons(reasons, "BLUEPRINT_BLOCKED", "blueprint freeze");
  }

  async freeze(
    projectId: Id,
    actor: Actor,
    input: unknown,
    context: OperationFilterContext,
  ): Promise<Result<BlueprintCommit, GateFailure>> {
    if (!mayRecordDecision(actor)) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "blueprint",
        action: "blueprint.freeze",
        resourceId: null,
        decision: "deny",
        reasonCode: "actor-may-not-freeze",
        metadata: {},
      });
      return gateFail(
        "ACCESS_DENIED",
        "actor-may-not-freeze",
        "only an inspector or reviewer may freeze a blueprint",
      );
    }
    const parsed = blueprintFreezeRequestSchema.safeParse(input);
    if (!parsed.success) {
      return gateFail("INVALID_INPUT", "freeze-request", "freeze request rejected", {
        issues: issueNames(parsed.error.issues) as unknown as JsonValue,
      });
    }
    const planId = asId(parsed.data.planId);

    const collected = this.storage.transact((tx) => this.collect(tx, projectId, planId));
    if (!collected.ok) return gateFail("INVALID_INPUT", collected.error.code, collected.error.message);
    if (!collected.value.ok) return collected.value;
    const state = collected.value.value;

    if (state.planRow.reviewStatus !== "approved") {
      return this.blocked(projectId, actor, ["plan-not-approved"], planId);
    }
    if (state.graphRevision !== state.planRow.graphRevision) {
      return gateFail(
        "STALE_INPUT",
        "graph-moved-since-plan",
        `the graph is at revision ${String(state.graphRevision)} while this plan froze ${String(state.planRow.graphRevision)}; re-plan first`,
        { planGraphRevision: state.planRow.graphRevision, currentGraphRevision: state.graphRevision },
      );
    }
    const unattributed = state.contracts.filter((entry) => entry.row.reviewStatus !== "approved");
    if (unattributed.length > 0) {
      return this.blocked(
        projectId,
        actor,
        unattributed.map((entry) => `contract-not-approved:${entry.row.id}`),
        planId,
      );
    }

    const selectedIds = state.plan.selectedVectorIds;
    const contents = await this.vectors.loadContents(projectId, selectedIds);
    if (!contents.ok) return gateFail("REA_CONTRACT_MISMATCH", contents.error.reason, contents.error.message);
    const operations = new Map<string, string>();
    for (const [id, vector] of contents.value) operations.set(id, vector.operationId);

    const reasons: string[] = [];
    reasons.push(...this.contractReasons(state, operations));
    reasons.push(
      ...planGateReasons({
        content: state.plan,
        inventory: state.inventory,
        contracts: state.contracts.map((entry) => ({
          id: entry.row.id,
          targetId: entry.row.targetId,
          snapshotDigest: entry.content.scope.snapshotDigest,
          reviewStatus: entry.row.reviewStatus,
          requiredCases: entry.content.requiredCases,
        })),
        contradictingEvidenceIds: state.contradictingEvidenceIds,
        requireComplete: true,
      }),
    );
    // §6 with D10: required claims and edges must each project SEEN. The colour is
    // recomputed from the stored basis, validity, authority and coverage — never
    // read back from a previously projected value.
    reasons.push(...nonSeenClaimReasons(gatesOf(state)));
    reasons.push(...nonSeenEdgeReasons(state.edges));

    const publicVectors: PublicTestVector[] = [];
    const holdout: SourceManifest["holdoutVectorIds"] = [];
    for (const vectorId of selectedIds) {
      const vector = contents.value.get(vectorId);
      if (vector === undefined) {
        reasons.push(`selected-vector-payload-missing:${vectorId}`);
        continue;
      }
      const projected = publicVectorOf(vector);
      if (projected !== null) publicVectors.push(projected);
      if (vector.visibility === "holdout") {
        holdout.push({
          vectorId: vector.id,
          caseKey: vector.caseKey,
          operationId: vector.operationId,
          digest: vector.digest,
        });
      }
    }
    // D13: holdout never reaches the Builder, so a promise covered only by holdout
    // samples would hand over an empty spec and still claim coverage.
    if (publicVectors.length === 0) reasons.push("blueprint-without-public-sample");

    const suspicions = sourceTextSuspicions(textsToScan(state.contracts, [...contents.value.values()]));
    if (reasons.length > 0) return this.blocked(projectId, actor, reasons, planId);

    const blueprintId = newId();
    const contracts = contractEntries(state.contracts);
    const verificationScope = scopeOf(state.contracts, state.plan);
    // The digest is taken over the serialized payload, not over the inputs that
    // produced it. Serialization normalizes (it sorts the scope), so binding the
    // inputs instead would make the handoff fail its own recomputation check.
    const provisional = buildBlueprintPayload({
      blueprintId,
      blueprintDigest: ZERO_DIGEST,
      contracts,
      publicVectors,
      verificationScope,
    });
    // §12.1 line 441 gives the handoff owner this door: the same filter that gates
    // every emitted face runs on the allowlisted payload, and only a payload that
    // passes gets a `blueprintDigest` and a public release. It is checked here -
    // before the digest exists - because §12.1 forbids rewriting a body that already
    // carries an approved digest, and `leakReasons` below is a different owner: it
    // guards holdout references, not declared values.
    const payloadCheck = assertPayloadClean(provisional as unknown as JsonValue, context.sensitive);
    if (!payloadCheck.ok) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "blueprint",
        action: "blueprint.freeze",
        resourceId: planId,
        decision: "deny",
        reasonCode: payloadCheck.reason,
        metadata: {},
      });
      return gateFail(
        "SENSITIVE_CONTENT_BLOCKED",
        payloadCheck.reason,
        "the blueprint payload is refused by the diagnostic filter",
      );
    }

    const digest = blueprintDigestOf(provisional, this.limits);
    const payload = buildBlueprintPayload({
      blueprintId,
      blueprintDigest: digest,
      contracts,
      publicVectors,
      verificationScope,
    });

    const categories = forbiddenCategories(projectId, state, contents.value, selectedIds);
    const leaks = leakReasons(payload, [...categories.keys()]);
    if (leaks.length > 0) {
      return this.blocked(
        projectId,
        actor,
        leaks.map((token) => `blueprint-discloses-reference:${categories.get(token) ?? "unknown"}`),
        planId,
      );
    }

    const withoutDigest: Omit<SourceManifest, "manifestDigest"> = {
      schemaVersion: BLUEPRINT_SCHEMA_VERSION,
      blueprintId,
      blueprintDigest: digest,
      projectId,
      targetId: state.planRow.targetId,
      snapshotDigest: state.planRow.snapshotDigest,
      graphRevision: state.planRow.graphRevision,
      planId: state.planRow.id,
      planDigest: state.planRow.digest,
      inventoryDigest: state.plan.inventoryDigest,
      selectedVectorIds: [...selectedIds],
      excludedVectorReasons: state.plan.excludedVectors.map((entry) => ({
        vectorId: entry.vectorId,
        reasonCode: entry.reasonCode,
        excludedBehavior: entry.excludedBehavior,
      })),
      claims: manifestClaims(state),
      holdoutVectorIds: holdout,
      reviewAttribution: state.reviewAttribution,
      sourceTextSuspicions: suspicions,
    };
    const manifestDigest = sourceManifestDigestOf(withoutDigest, this.limits);
    const manifest: SourceManifest = { ...withoutDigest, manifestDigest };

    const publishedBlueprint = await this.artifacts.publish(
      projectId,
      "blueprint",
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    if (!publishedBlueprint.ok) {
      return gateFail("CAPABILITY_UNAVAILABLE", publishedBlueprint.error.code, "blueprint payload could not be published");
    }
    const publishedManifest = await this.artifacts.publish(
      projectId,
      "inspector",
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    if (!publishedManifest.ok) {
      return gateFail("CAPABILITY_UNAVAILABLE", publishedManifest.error.code, "source manifest could not be published");
    }

    const blueprintArtifactId = newId();
    const manifestArtifactId = newId();
    const createdAt = nowInstant();

    const committed = commitDecision<Omit<BlueprintCommit, "auditSeq">>(this.storage, {
      projectId,
      actor,
      resourceType: "blueprint",
      action: "blueprint.freeze",
      resourceId: blueprintId,
      allowReason: "blueprint-frozen",
      metadata: { planId: state.planRow.id, digest, publicVectorCount: publicVectors.length },
      work: (tx): Step<Omit<BlueprintCommit, "auditSeq">> => {
        // Everything that decided the freeze is read again inside the write
        // transaction. A plan, contract, sample or contradiction that moved in
        // between must produce a refusal, not a blueprint built on stale facts.
        const reread = this.collect(tx, projectId, state.planRow.id);
        if (!reread.ok) {
          return { kind: "failure", failure: gateFail("INVALID_INPUT", reread.error.code, reread.error.message) };
        }
        const drift = driftReasons(state, reread.value, selectedIds);
        if (drift.length > 0) {
          return {
            kind: "failure",
            failure: gateFail(
              "REVISION_CONFLICT",
              "state-changed-under-freeze",
              "the plan, contracts or samples changed while this blueprint was being prepared",
              { drift },
            ),
          };
        }

        tx.insertArtifact({
          id: blueprintArtifactId,
          projectId,
          jobId: null,
          class: "blueprint",
          sha256: publishedBlueprint.value.sha256,
          digestReason: null,
          byteLength: publishedBlueprint.value.byteLength,
          storageKey: publishedBlueprint.value.storageKey,
          mediaType: "application/json",
          createdAt,
        });
        tx.insertArtifact({
          id: manifestArtifactId,
          projectId,
          jobId: null,
          class: "inspector",
          sha256: publishedManifest.value.sha256,
          digestReason: null,
          byteLength: publishedManifest.value.byteLength,
          storageKey: publishedManifest.value.storageKey,
          mediaType: "application/json",
          createdAt,
        });
        tx.insertBlueprint({
          id: blueprintId,
          projectId,
          targetId: state.planRow.targetId,
          graphRevision: state.planRow.graphRevision,
          snapshotDigest: state.planRow.snapshotDigest,
          verificationPlanId: state.planRow.id,
          artifactId: blueprintArtifactId,
          digest,
          sourceManifestArtifactId: manifestArtifactId,
          createdAt,
        });
        return {
          kind: "committed",
          value: {
            blueprintId,
            digest,
            manifestDigest,
            planId: state.planRow.id,
            publicVectorCount: publicVectors.length,
            holdoutVectorCount: holdout.length,
            contractCount: state.contracts.length,
          },
        };
      },
    });

    if (!committed.ok) return committed;
    return { ok: true, value: { ...committed.value.value, auditSeq: committed.value.auditSeq } };
  }

  // The only read path a Builder may use. The stored bytes are re-parsed with the
  // handoff schema and the digest is recomputed, so a blueprint written by an
  // older build cannot deliver a field that is no longer on the allowlist.
  async handoff(projectId: Id, blueprintId: Id): Promise<Result<BlueprintPayload, GateFailure>> {
    const looked = this.storage.transact((tx) => {
      const row = tx.getBlueprint(projectId, blueprintId);
      if (row === null) return null;
      return { artifact: tx.getArtifact(projectId, row.artifactId), digest: row.digest };
    });
    if (!looked.ok) return gateFail("INVALID_INPUT", looked.error.code, looked.error.message);
    if (looked.value === null) return gateFail("NOT_FOUND", "blueprint-unknown", "blueprint not found");
    const artifact = looked.value.artifact;
    if (artifact === null) return gateFail("NOT_FOUND", "artifact-unknown", "blueprint artifact row is missing");
    const read = await this.readJson(projectId, artifact.storageKey, artifact.sha256);
    if (!read.ok) return read;
    const parsed = builderBlueprintSchema.safeParse(read.value);
    if (!parsed.success) {
      return gateFail("REA_CONTRACT_MISMATCH", "blueprint-schema", "stored blueprint violates the handoff schema", {
        issues: issueNames(parsed.error.issues) as unknown as JsonValue,
      });
    }
    const payload = brandPayload(parsed.data);
    const recomputed = blueprintDigestOf(
      {
        schemaVersion: payload.schemaVersion,
        blueprintId: payload.blueprintId,
        contractRevisions: payload.contractRevisions,
        publicVectors: payload.publicVectors,
        generation: payload.generation,
        verificationScope: payload.verificationScope,
      },
      this.limits,
    );
    if (recomputed !== looked.value.digest || payload.blueprintDigest !== looked.value.digest) {
      return gateFail("REA_CONTRACT_MISMATCH", "blueprint-digest-drift", "blueprint bytes no longer match the row digest");
    }
    return { ok: true, value: payload };
  }

  // §8 line 293: the frozen blueprint read back through the same door the Builder is served
  // from. `handoff` is the only place that re-parses the stored bytes against the allowlist
  // schema and recomputes the digest, so a second copy of that work is exactly how a read
  // starts answering from bytes the freeze gate would have refused.
  //
  // Which plan a blueprint was cut from goes to the control plane and not to a Builder: §8
  // grants the Builder this route only as a capability scoped to one id, and the plan is the
  // holdout other half. The source manifest and the holdout list are not in this reply at
  // all - that is what `blueprintReadSchema` having no field for them means.
  async read(
    projectId: Id,
    actor: Actor,
    blueprintId: Id,
  ): Promise<Result<BlueprintRead, GateFailure>> {
    const handed = await this.handoff(projectId, blueprintId);
    if (!handed.ok) return handed;
    const row = this.storage.transact((tx) => tx.getBlueprint(projectId, blueprintId));
    if (!row.ok) return gateFail("INVALID_INPUT", row.error.code, row.error.message);
    if (row.value === null) return gateFail("NOT_FOUND", "blueprint-unknown", "blueprint not found");
    return {
      ok: true,
      value: {
        id: row.value.id,
        digest: row.value.digest,
        scope: handed.value.verificationScope,
        bundle: handed.value,
        verificationPlanId: isControlPlane(actor) ? row.value.verificationPlanId : null,
      },
    };
  }

  async readSourceManifest(
    projectId: Id,
    actor: Actor,
    blueprintId: Id,
  ): Promise<Result<SourceManifest, GateFailure>> {
    if (actor.actorKind !== "inspector" && actor.actorKind !== "reviewer") {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "blueprint",
        action: "blueprint.manifest.read",
        resourceId: blueprintId,
        decision: "deny",
        reasonCode: "manifest-is-control-plane-only",
        metadata: {},
      });
      return gateFail(
        "ACCESS_DENIED",
        "manifest-is-control-plane-only",
        "the source manifest is readable by the control plane and the evaluator only (§7.3)",
      );
    }
    const looked = this.storage.transact((tx) => {
      const row = tx.getBlueprint(projectId, blueprintId);
      if (row === null) return null;
      return tx.getArtifact(projectId, row.sourceManifestArtifactId);
    });
    if (!looked.ok) return gateFail("INVALID_INPUT", looked.error.code, looked.error.message);
    if (looked.value === null) return gateFail("NOT_FOUND", "blueprint-unknown", "blueprint not found");
    const artifact = looked.value;
    if (artifact === null) return gateFail("NOT_FOUND", "artifact-unknown", "manifest artifact row is missing");
    const read = await this.readJson(projectId, artifact.storageKey, artifact.sha256);
    if (!read.ok) return read;
    const parsed = blueprintSourceManifestSchema.safeParse(read.value);
    if (!parsed.success) {
      return gateFail("REA_CONTRACT_MISMATCH", "manifest-schema", "stored manifest violates the manifest schema");
    }
    const manifest = brandManifest(parsed.data);
    if (sourceManifestDigestOf(manifest, this.limits) !== manifest.manifestDigest) {
      return gateFail("REA_CONTRACT_MISMATCH", "manifest-digest-drift", "manifest no longer matches its own digest");
    }
    return { ok: true, value: manifest };
  }

  private async readJson(
    projectId: Id,
    storageKey: string,
    sha256: Digest | null,
  ): Promise<Result<JsonValue, GateFailure>> {
    const bytes = await this.artifacts.read(projectId, storageKey);
    if (!bytes.ok) return gateFail("INVALID_INPUT", bytes.error.code, bytes.error.message);
    if (sha256 === null) {
      return gateFail("REA_CONTRACT_MISMATCH", "artifact-digest-withheld", "artifact digest is required to read a handoff");
    }
    if (digestBytes(bytes.value) !== sha256) {
      return gateFail("REA_CONTRACT_MISMATCH", "artifact-digest-mismatch", "artifact bytes changed after publication");
    }
    try {
      return { ok: true, value: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes.value)) as JsonValue };
    } catch {
      return gateFail("REA_CONTRACT_MISMATCH", "artifact-unparseable", "artifact is not JSON");
    }
  }

  private contractReasons(
    state: FreezeSnapshot,
    operations: ReadonlyMap<string, string>,
  ): string[] {
    const reasons: string[] = [];
    for (const entry of state.contracts) {
      const vectors = entry.content.requiredCases
        .flatMap((required) => required.vectorIds)
        .map((id) => state.vectors.find((row) => row.id === id))
        .filter((row): row is VectorRow => row !== undefined)
        .map((row) => ({
          id: row.id,
          targetId: row.targetId,
          snapshotDigest: row.snapshotDigest,
          caseKey: row.caseKey,
          // An operation id the payload read cannot resolve is reported rather than
          // assumed: the gate would otherwise pass a vector it never checked.
          operationId: operations.get(row.id) ?? "",
          eligibility: row.eligibility,
          reviewStatus: row.reviewStatus,
        }));
      reasons.push(
        ...contractGateReasons({
          content: entry.content,
          vectors,
          claims: entry.content.sourceClaimIds.map(
            (claimId) => state.claimFacts.get(claimId) ?? missingClaim(claimId, state.planRow.targetId),
          ),
          requireComplete: true,
        }),
      );
    }
    return [...new Set(reasons)];
  }
}

function gatesOf(state: FreezeSnapshot): BlueprintClaim[] {
  const seen = new Set<string>();
  const gates: BlueprintClaim[] = [];
  for (const entry of state.contracts) {
    for (const claimId of entry.content.sourceClaimIds) {
      if (seen.has(claimId)) continue;
      seen.add(claimId);
      gates.push(state.claimFacts.get(claimId) ?? missingClaim(claimId, state.planRow.targetId));
    }
  }
  return gates;
}

function manifestClaims(state: FreezeSnapshot): SourceManifest["claims"] {
  const entries: SourceManifest["claims"] = [];
  for (const contract of state.contracts) {
    for (const claimId of contract.content.sourceClaimIds) {
      const links = state.claimLinks.filter((link) => link.claimId === claimId);
      entries.push({
        contractDigest: contract.row.digest,
        claimId,
        evidenceIds: [...new Set(links.map((link) => link.evidenceId))].sort(),
        sourceLocations: links.map((link) => link.locationJson),
      });
    }
  }
  return entries;
}

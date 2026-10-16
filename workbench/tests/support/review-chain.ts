import { canonicalJson } from "../../packages/domain/canonical-json.ts";
import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { inventorySnapshotDigest } from "../../packages/domain/plan.ts";
import { vectorDigest, vectorDigestInput } from "../../packages/domain/vector.ts";
import type { TestVectorContent } from "../../packages/domain/vector.ts";
import type { ArtifactRow, ClaimRow, ContractRow, EvidenceRow, JobRow, PlanRow, TargetRow, VectorRow } from "../../packages/application/ports.ts";
import type { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { hex } from "./blueprint-seed.ts";

// A project whose review chain is seeded to the edge of being approvable (issue #58).
//
// The three review routes have to be tested against rows the *services* will approve, not
// against stubs, because what the routes promise is that a decision reaches those services and
// is stored there. So this builds the smallest state that passes the contract gate and the plan
// gate: one capture target, one evidence envelope behind a real artifact, one claim with complete
// coverage, one usable vector (still draft), one contract that binds that vector's case (still
// draft) and one plan that selects exactly the union the contracts require (still draft).
//
// Rows are written directly rather than derived through `vector.create`, because that command
// reads the record back through the live provider's fact path - a browser-pass or HTTP test would
// then be testing the REA adapter as well. The digest the vector index row carries is still the
// domain's own over the same canonical bytes, which is what the contract gate re-verifies.
const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const SNAPSHOT = ("9" as const).repeat(64) as Digest;
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

export type SeededChain = {
  targetId: Id;
  evidenceId: string;
  claimId: Id;
  vectorId: Id;
  vectorDigest: Digest;
  contractId: Id;
  contractDigest: Digest;
  planId: Id;
  planDigest: Digest;
  snapshotDigest: Digest;
};

export async function seedReviewChain(deps: {
  writer: SqliteStorageWriter;
  store: ArtifactStore;
  projectId: Id;
  // Every digest and idempotency key is namespaced by this label, so two fixtures in one file
  // cannot collide inside the artifact store's (project, class, digest) dedupe.
  name: string;
}): Promise<SeededChain> {
  const { writer, store, projectId, name } = deps;
  const createdAt = nowInstant();
  const targetId = newId();
  const jobId = newId();
  const evidenceArtifactId = newId();
  const evidenceId = `ev_${"8".repeat(64)}`;
  const claimId = newId();

  const envelope = { evidence_id: evidenceId, operation: "inspect_web_network_capture", detail: { status: 200 } };
  const evidenceBytes = await store.publish(projectId, "inspector", new TextEncoder().encode(JSON.stringify(envelope)));
  if (!evidenceBytes.ok) throw new Error(`evidence publish -> ${JSON.stringify(evidenceBytes.error)}`);

  const vectorId = newId();
  const vectorContent: TestVectorContent = {
    id: vectorId,
    targetId,
    snapshotDigest: SNAPSHOT,
    operationId: "getCart",
    sdkInput: { include: "items" },
    caseKey: "cart-ok",
    replacesId: null,
    source: { evidenceId, captureId: null, recordOrdinal: 0, pointer: "/records/0", transactionId: null },
    request: { method: "GET", url: "https://shop.example/api/cart", query: [], headers: [], body: { kind: "empty" } },
    response: { status: 200, headers: [], body: { kind: "text", text: "{}", provenance: "producer-decoded" } },
    expectedOutcome: { kind: "return", value: { items: [] } },
    coverage: { state: "complete", examined: null, total: null, reasons: [] },
    limitations: [],
    redactions: [],
    visibility: "public",
    eligibility: "usable",
    reasons: [],
  };
  const digest = vectorDigest(vectorContent, LIMITS);
  const vectorBytes = await store.publish(projectId, "inspector", new TextEncoder().encode(canonicalJson(vectorDigestInput(vectorContent), LIMITS)));
  if (!vectorBytes.ok) throw new Error(`vector publish -> ${JSON.stringify(vectorBytes.error)}`);
  const vectorArtifactId = newId();

  const contractId = newId();
  const contractDigest = asDigest(hex(`contract-${name}`));
  const contractContent: Record<string, JsonValue> = {
    id: contractId,
    contractKey: "cart-api",
    revision: 1,
    targetId,
    scope: { snapshotDigest: SNAPSHOT, operationIds: ["getCart"], excludedBehaviors: [] },
    behaviorSpec: "GET /api/cart returns the item list",
    inputSchema: { $schema: DIALECT, type: "object" },
    outputSchema: { $schema: DIALECT, type: "object" },
    httpOperations: [
      {
        operationId: "getCart",
        method: "GET",
        path: "/api/cart",
        requestMediaType: null,
        responses: [{ status: 200, mediaType: "application/json", schema: { $schema: DIALECT, type: "object" } }],
      },
    ],
    errorCases: [],
    limitations: [],
    unknowns: [],
    sourceClaimIds: [claimId],
    requiredCases: [{ caseKey: "cart-ok", claimId, kind: "success", vectorIds: [vectorId] }],
  };

  const planId = newId();
  const planDigest = asDigest(hex(`plan-${name}`));
  // The plan binds the inventory it was cut from. With the one vector above still the whole
  // snapshot, that digest is the domain's own over `[[vectorId, its digest]]` - and the review
  // recomputes it, so a fixture that guessed would be refused for the right reason.
  const inventoryDigest = inventorySnapshotDigest([{ id: vectorId, digest }]);
  // The two revisions a real build stamps come from the project row at that instant (§7.4), so
  // the fixture reads them the same way instead of writing zeros: a plan that claimed an
  // inventory the seed never had would make the route's 409 tests prove a shape, not a state.
  const revisions = () => {
    const live = writer.transact((tx) => tx.getProject(projectId));
    if (!live.ok || live.value === null) throw new Error("project row missing");
    return { graphRevision: live.value.graphRevision, inventoryRevision: live.value.inventoryRevision };
  };

  const target: TargetRow = {
    id: targetId,
    projectId,
    kind: "har",
    originalLocator: null,
    sourceSha256: null,
    sourceArtifactId: null,
    snapshotDigest: SNAPSHOT,
    identityReason: null,
    createdAt,
  };
  const job: JobRow = {
    id: jobId,
    projectId,
    targetId,
    kind: "capture",
    state: "succeeded",
    cleanupState: "complete",
    inputJson: {},
    resultRef: evidenceId,
    errorJson: null,
    idempotencyKey: `chain-${name}`,
    requestDigest: asDigest(hex(`chain-job-${name}`)),
    deadlineAt: null,
    retryAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  const evidenceArtifact: ArtifactRow = {
    id: evidenceArtifactId,
    projectId,
    jobId,
    class: "inspector",
    sha256: evidenceBytes.value.sha256,
    digestReason: null,
    byteLength: evidenceBytes.value.byteLength,
    storageKey: evidenceBytes.value.storageKey,
    mediaType: "application/json",
    createdAt,
  };
  const vectorPayload: ArtifactRow = {
    id: vectorArtifactId,
    projectId,
    jobId,
    class: "inspector",
    sha256: vectorBytes.value.sha256,
    digestReason: null,
    byteLength: vectorBytes.value.byteLength,
    storageKey: vectorBytes.value.storageKey,
    mediaType: "application/json",
    createdAt,
  };
  const evidence: EvidenceRow = {
    projectId,
    id: evidenceId,
    targetId,
    jobId,
    artifactId: evidenceArtifactId,
    providerJson: { id: "rea", name: "rea", version: "6.4.0" },
    operation: "inspect_web_network_capture",
    confidence: "observed",
    authority: "shipped-artifact",
    createdAt,
  };
  const claim: ClaimRow = {
    id: claimId,
    projectId,
    targetId,
    entityKey: "entity-cart",
    claimKey: "get-cart",
    assertion: "get-cart at /api/cart",
    scopeJson: { sourceEvidenceIds: [evidenceId] },
    basis: "observed",
    sourceState: "available",
    coverageJson: { state: "complete", examined: null, total: null, reasons: [] },
    validity: "current",
    revision: 1,
    unknownReasonsJson: [],
  };
  const vector: VectorRow = {
    id: vectorId,
    projectId,
    targetId,
    evidenceId,
    sourceLocatorJson: vectorContent.source,
    snapshotDigest: SNAPSHOT,
    payloadArtifactId: vectorArtifactId,
    digest,
    replacesId: null,
    caseKey: "cart-ok",
    visibility: "public",
    eligibility: "usable",
    reasonsJson: [],
    reviewStatus: "draft",
    reviewRecordJson: null,
  };
  const contract: ContractRow = {
    id: contractId,
    projectId,
    targetId,
    contractKey: "cart-api",
    revision: 1,
    payloadJson: contractContent,
    digest: contractDigest,
    reviewStatus: "draft",
    reviewRecordJson: null,
  };

  const seeded = await writer.transact(async (tx) => {
    tx.insertTarget(target);
    tx.insertJob(job);
    tx.insertArtifact(evidenceArtifact);
    tx.insertArtifact(vectorPayload);
    tx.insertEvidence(evidence);
    tx.insertClaim(claim);
    tx.insertVector(vector);
    tx.insertContract(contract);
    // One inventory bump for the seeded sample, before the plan is cut from it: the reviews name
    // the revision they were prepared against, and a plan claiming a different one than the row
    // it was built from is a fixture that misrepresents the state under test.
    tx.upsertProjectRevision(projectId, { inventory: 1 });
    return true;
  });
  if (!seeded.ok) throw new Error(`chain seed -> ${JSON.stringify(seeded.error)}`);

  const bound = revisions();
  const plan: PlanRow = {
    id: planId,
    projectId,
    targetId,
    snapshotDigest: SNAPSHOT,
    graphRevision: bound.graphRevision,
    inventoryRevision: bound.inventoryRevision,
    inventoryDigest,
    payloadJson: {
      id: planId,
      targetId,
      snapshotDigest: SNAPSHOT,
      contractRevisionIds: [contractId],
      graphRevision: bound.graphRevision,
      inventoryRevision: bound.inventoryRevision,
      inventoryDigest,
      selectedVectorIds: [vectorId],
      excludedVectors: [],
    },
    digest: planDigest,
    reviewStatus: "draft",
    reviewRecordJson: null,
    createdAt,
  };
  const inserted = writer.transact((tx) => tx.insertPlan(plan));
  if (!inserted.ok) throw new Error(`plan insert -> ${JSON.stringify(inserted.error)}`);

  return {
    targetId,
    evidenceId,
    claimId,
    vectorId,
    vectorDigest: digest,
    contractId,
    contractDigest,
    planId,
    planDigest,
    snapshotDigest: SNAPSHOT,
  };
}

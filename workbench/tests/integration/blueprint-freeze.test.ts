import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalJson } from "../../packages/domain/canonical-json.ts";
import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { vectorDigest, vectorDigestInput } from "../../packages/domain/vector.ts";
import type { TestVectorContent } from "../../packages/domain/vector.ts";
import { acquireWorkerLock, applyMigrations, openWriteConnection, planMigrations } from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { BlueprintService } from "../../packages/application/blueprint-service.ts";
import { ContractService } from "../../packages/application/contract-service.ts";
import { PlanService } from "../../packages/application/plan-service.ts";
import { VectorService } from "../../packages/application/vector-service.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import { readAudit } from "../../packages/application/audit.ts";
import type { ClaimRow, EvidenceRow, JobRow, VectorRow } from "../../packages/application/ports.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { Result } from "../../packages/domain/result.ts";

// BlueprintService against real storage (DESIGN §6, §7.3, D10/D12/D13, issue #13).
// The cases a reviewer needs are the two directions of the promise: what the
// Builder is handed must contain nothing outside the allowlist, and a required
// claim or edge that is not SEEN must stop the freeze even when every row around
// it says "approved".

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const SNAPSHOT = ("1" as const).repeat(64) as Digest;
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

const inspector: Actor = { actorId: "local-operator", actorKind: "inspector" };
const reviewer: Actor = { actorId: "reviewer-one", actorKind: "reviewer" };
const builder: Actor = { actorId: "builder-agent", actorKind: "builder" };
const generator: Actor = { actorId: "generation-worker", actorKind: "system" };

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let store: ArtifactStore;
let contracts: ContractService;
let plans: PlanService;
let blueprints: BlueprintService;
let projectId: Id;
let targetId: Id;
let observedClaimId: Id;
let yellowClaimId: Id;
let holdoutOnlyClaimId: Id;
let evidenceOne: string;
let evidenceTwo: string;
const heldLocks: { release: () => Promise<void> }[] = [];

function hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function evId(name: string): string {
  return `ev_${hex(name)}`;
}

function unwrap<T>(result: Result<T, GateFailure>): T {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.reason}:${JSON.stringify(result.error.details)}`);
  return result.value;
}

function errorOf<T>(result: Result<T, GateFailure>): GateFailure {
  if (result.ok) throw new Error("expected a refusal, got a value");
  return result.error;
}

function reasonText(failure: GateFailure): string {
  const reasons = failure.details["reasons"];
  return Array.isArray(reasons) ? reasons.map(String).join(",") : failure.reason;
}

function jobRow(id: Id): JobRow {
  const created = nowInstant();
  return {
    id,
    projectId,
    targetId,
    kind: "inspect",
    state: "succeeded",
    cleanupState: "complete",
    inputJson: {},
    resultRef: null,
    errorJson: null,
    idempotencyKey: `seed-${id}`,
    requestDigest: asDigest(hex("seed")),
    deadlineAt: null,
    retryAt: null,
    createdAt: created,
    updatedAt: created,
  };
}

async function seedEvidence(id: string): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({ seeded: id }));
  const published = await store.publish(projectId, "inspector", bytes);
  if (!published.ok) throw new Error(JSON.stringify(published.error));
  const inserted = writer.transact((tx) => {
    const jobId = newId();
    const artifactId = newId();
    const created = nowInstant();
    tx.insertJob(jobRow(jobId));
    tx.insertArtifact({
      id: artifactId,
      projectId,
      jobId,
      class: "inspector",
      sha256: published.value.sha256,
      digestReason: null,
      byteLength: published.value.byteLength,
      storageKey: published.value.storageKey,
      mediaType: "application/json",
      createdAt: created,
    });
    const row: EvidenceRow = {
      projectId,
      id,
      targetId,
      jobId,
      artifactId,
      providerJson: { id: "rea.web.network", name: "capture", version: "6.4.0" },
      operation: "inspect_web_network_capture",
      confidence: "observed",
      authority: "historical-reference",
      createdAt: created,
    };
    tx.insertEvidence(row);
    return true;
  });
  if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
}

function claimRow(input: { id: Id; key: string; basis: ClaimRow["basis"] }): ClaimRow {
  return {
    id: input.id,
    projectId,
    targetId,
    entityKey: `entity-${input.key}`,
    claimKey: input.key,
    assertion: `${input.key} at /api/cart`,
    scopeJson: { sourceEvidenceIds: [evidenceOne] },
    basis: input.basis,
    sourceState: "available",
    coverageJson: { state: "complete", examined: null, total: null, reasons: [] },
    validity: "current",
    revision: 1,
    unknownReasonsJson: [],
  };
}

async function seedVector(input: {
  evidence: string;
  ordinal: number;
  caseKey: string;
  visibility?: "public" | "holdout";
  approved?: boolean;
}): Promise<{ id: Id; digest: Digest }> {
  const id = newId();
  const created = nowInstant();
  const content: TestVectorContent = {
    id,
    targetId,
    snapshotDigest: SNAPSHOT,
    operationId: "getCart",
    sdkInput: { include: "items" },
    caseKey: input.caseKey,
    replacesId: null,
    source: {
      evidenceId: input.evidence,
      captureId: null,
      recordOrdinal: input.ordinal,
      pointer: `/records/${String(input.ordinal)}/reported`,
      transactionId: null,
    },
    request: { method: "GET", url: "https://shop.example/api/cart", query: [], headers: [], body: { kind: "empty" } },
    response: { status: 200, headers: [], body: { kind: "text", text: "{}", provenance: "producer-decoded" } },
    expectedOutcome: { kind: "return", value: { items: [] } },
    coverage: { state: "complete", examined: null, total: null, reasons: [] },
    limitations: [],
    redactions: [{ fieldPointer: `/records/${String(input.ordinal)}/reported/headers/0/value`, reason: "transport-auth", representation: "omitted" }],
    visibility: input.visibility ?? "public",
    eligibility: "usable",
    reasons: [],
  };
  const digest = vectorDigest(content, LIMITS);
  const bytes = new TextEncoder().encode(canonicalJson(vectorDigestInput(content), LIMITS));
  const published = await store.publish(projectId, "inspector", bytes);
  if (!published.ok) throw new Error(JSON.stringify(published.error));
  const artifactId = newId();
  const row: VectorRow = {
    id,
    projectId,
    targetId,
    evidenceId: content.source.evidenceId,
    sourceLocatorJson: content.source,
    snapshotDigest: SNAPSHOT,
    payloadArtifactId: artifactId,
    digest,
    replacesId: null,
    caseKey: input.caseKey,
    visibility: content.visibility,
    eligibility: "usable",
    reasonsJson: [],
    reviewStatus: input.approved === true ? "approved" : "draft",
    reviewRecordJson:
      input.approved === true
        ? { status: "approved", reviewerId: "reviewer-one", reviewedAt: created, approvedDigest: digest }
        : null,
  };
  const inserted = writer.transact((tx) => {
    tx.insertArtifact({
      id: artifactId,
      projectId,
      jobId: null,
      class: "inspector",
      sha256: published.value.sha256,
      digestReason: null,
      byteLength: published.value.byteLength,
      storageKey: published.value.storageKey,
      mediaType: "application/json",
      createdAt: created,
    });
    tx.insertVector(row);
    tx.upsertProjectRevision(projectId, { inventory: 1 });
    return true;
  });
  if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
  return { id, digest };
}

function contractRequest(overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    contractKey: "cart-api",
    targetId,
    scope: { snapshotDigest: SNAPSHOT, operationIds: ["getCart"], excludedBehaviors: ["paging"] },
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
    errorCases: ["401 unauthenticated"],
    limitations: ["only one sample observed"],
    unknowns: ["pagination"],
    sourceClaimIds: [observedClaimId],
    requiredCases: [],
    ...overrides,
  };
}

function inventoryRevision(): number {
  const project = writer.transact((tx) => tx.getProject(projectId));
  if (!project.ok || project.value === null) throw new Error("project missing");
  return project.value.inventoryRevision;
}

async function approvedPlanFor(
  contractId: Id,
  vectorIds: Id[],
  extras: Record<string, JsonValue>[] = [],
): Promise<{ planId: Id; digest: Digest }> {
  const rows = writer.transact((tx) => tx.listVectorsForSnapshot(projectId, targetId, SNAPSHOT, 500));
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  const selected = new Set(vectorIds);
  const excluded = rows.value
    .filter((row) => !selected.has(row.id))
    .map((row) => ({
      vectorId: row.id,
      reasonCode: "outside-scope",
      reason: "not part of this delivery",
      excludedBehavior: `case:${row.caseKey}`,
      supersededBy: null,
    }));
  const created = unwrap(
    plans.build(projectId, inspector, {
      targetId,
      snapshotDigest: SNAPSHOT,
      contractRevisionIds: [contractId],
      excludedVectors: [...excluded, ...extras],
      expectedInventoryRevision: inventoryRevision(),
    }),
  );
  unwrap(
    plans.review(projectId, reviewer, created.planId, {
      decision: "approved",
      reviewerId: "reviewer-one",
      digest: created.digest,
      expectedInventoryRevision: created.inventoryRevision,
    }),
  );
  return { planId: created.planId, digest: created.digest };
}

function journal(action: string, decision: string): string[] {
  const rows = readAudit(writer, { after: 0, projectId, limit: 500 });
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  return rows.value
    .filter((entry) => entry.action === action && entry.decision === decision)
    .map((entry) => entry.reasonCode);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-blueprints-"));
  await writeFile(path.join(root, "note.txt"), "x");
  const lock = await acquireWorkerLock(root);
  if (!lock.ok) throw new Error(JSON.stringify(lock.error));
  heldLocks.push(lock.value);
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  db = opened.value.db;
  writer = new SqliteStorageWriter(db);
  store = new ArtifactStore(root);
  const plan = planMigrations(db);
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  const applied = applyMigrations(db, plan.value);
  if (!applied.ok) throw new Error(JSON.stringify(applied.error));

  projectId = newId();
  targetId = newId();
  observedClaimId = newId();
  yellowClaimId = newId();
  holdoutOnlyClaimId = newId();
  evidenceOne = evId("one");
  evidenceTwo = evId("two");

  const vectorService = new VectorService({
    storage: writer,
    artifacts: store,
    facts: {
      readRecord: async () => {
        throw new Error("the facts port is not used by the freeze");
      },
    },
    limits: LIMITS,
  });
  contracts = new ContractService({ storage: writer, limits: LIMITS, vectors: vectorService });
  plans = new PlanService({ storage: writer, limits: LIMITS });
  blueprints = new BlueprintService({ storage: writer, artifacts: store, vectors: vectorService, limits: LIMITS });

  const seeded = writer.transact((tx) => {
    tx.insertProject({
      id: projectId,
      name: "cart",
      createdAt: nowInstant(),
      graphRevision: 4,
      inventoryRevision: 0,
      schemaVersion: 1,
    });
    tx.insertTarget({
      id: targetId,
      projectId,
      kind: "har",
      originalLocator: null,
      sourceSha256: SNAPSHOT,
      sourceArtifactId: null,
      snapshotDigest: SNAPSHOT,
      identityReason: null,
      createdAt: nowInstant(),
    });
    tx.insertClaim(claimRow({ id: observedClaimId, key: "cart-observed", basis: "observed" }));
    tx.insertClaim(claimRow({ id: yellowClaimId, key: "cart-derived", basis: "derived" }));
    tx.insertClaim(claimRow({ id: holdoutOnlyClaimId, key: "cart-holdout-only", basis: "observed" }));
    return true;
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  await seedEvidence(evidenceOne);
  await seedEvidence(evidenceTwo);
});

afterAll(async () => {
  db.close();
  for (const lock of heldLocks) await lock.release();
  await rm(root, { recursive: true, force: true });
});

describe("blueprint handoff carries the allowlist and nothing else (DESIGN §7.3)", () => {
  let mainVectorId: Id;
  let holdoutVectorId: Id;
  let blueprintId: Id;
  let digest: Digest;

  beforeAll(async () => {
    mainVectorId = (await seedVector({ evidence: evidenceOne, ordinal: 0, caseKey: "cart-ok", approved: true })).id;
    holdoutVectorId = (
      await seedVector({ evidence: evidenceTwo, ordinal: 1, caseKey: "cart-holdout", visibility: "holdout", approved: true })
    ).id;
    // Prove the freeze can see a location: the manifest must carry it and the
    // handoff must not.
    const linked = writer.transact((tx) => {
      tx.insertClaimEvidence({
        projectId,
        claimId: observedClaimId,
        evidenceId: evidenceOne,
        locationJson: { pointer: "/records/0/reported" },
        role: "support",
      });
      tx.insertGraphEdge({
        id: newId(),
        projectId,
        targetId,
        fromKey: "entity-cart-observed",
        toKey: "entity-item",
        relation: "contains",
        claimId: observedClaimId,
      });
      return true;
    });
    if (!linked.ok) throw new Error(JSON.stringify(linked.error));

    const contract = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          requiredCases: [
            { caseKey: "cart-ok", claimId: observedClaimId, kind: "success", vectorIds: [mainVectorId] },
            { caseKey: "cart-holdout", claimId: observedClaimId, kind: "edge", vectorIds: [holdoutVectorId] },
          ],
        }),
      ),
    );
    unwrap(
      await contracts.review(
        projectId,
        reviewer,
        contract.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: contract.digest },
      ),
    );
    const plan = await approvedPlanFor(contract.contractId, [mainVectorId, holdoutVectorId]);
    const frozen = unwrap(await blueprints.freeze(projectId, reviewer, { planId: plan.planId }));
    blueprintId = frozen.blueprintId;
    digest = frozen.digest;
  });

  it("freezes a blueprint that names one public and one holdout sample", () => {
    expect(blueprintId).not.toBeNull();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hands over exactly the §7.3 fields", async () => {
    const payload = unwrap(await blueprints.handoff(projectId, blueprintId));
    expect(Object.keys(payload).sort()).toEqual(
      ["blueprintDigest", "blueprintId", "contractRevisions", "generation", "publicVectors", "schemaVersion", "verificationScope"].sort(),
    );
    expect(payload.schemaVersion).toBe(1);
    expect(payload.generation).toEqual({ language: "typescript", outputKind: "http-sdk", openapiVersion: "3.1.1" });
    expect(payload.publicVectors).toHaveLength(1);
    expect(payload.publicVectors[0]?.id).toBe(mainVectorId);
    expect(Object.keys(payload.publicVectors[0] ?? {}).sort()).toEqual(
      ["coverage", "expectedOutcome", "id", "limitations", "operationId", "request", "response", "sdkInput"].sort(),
    );
    expect(payload.verificationScope).toContain("contract:cart-api@1");
    expect(payload.verificationScope).toContain("operation:getCart");
    expect(payload.verificationScope).toContain("excluded-behavior:paging");
  });

  it("discloses no evidence id, locator, target, project, snapshot or storage path", async () => {
    const payload = unwrap(await blueprints.handoff(projectId, blueprintId));
    const text = JSON.stringify(payload);
    for (const forbidden of [
      evidenceOne,
      evidenceTwo,
      targetId,
      projectId,
      SNAPSHOT,
      "/records/0/reported",
      "/records/1/reported",
      holdoutVectorId,
      observedClaimId,
      "storageKey",
      "projects/",
    ]) {
      expect(text.includes(forbidden), `handoff leaked ${forbidden.slice(0, 12)}…`).toBe(false);
    }
  });

  it("keeps the provenance and the holdout reference in the control plane", async () => {
    const manifest = unwrap(await blueprints.readSourceManifest(projectId, reviewer, blueprintId));
    expect(manifest.blueprintDigest).toBe(digest);
    expect(manifest.planDigest.length).toBe(64);
    expect(manifest.selectedVectorIds.sort()).toEqual([mainVectorId, holdoutVectorId].sort());
    expect(manifest.claims.find((entry) => entry.claimId === observedClaimId)?.evidenceIds).toEqual([evidenceOne]);
    expect(manifest.claims.find((entry) => entry.claimId === observedClaimId)?.sourceLocations).toEqual([
      { pointer: "/records/0/reported" },
    ]);
    expect(manifest.holdoutVectorIds.map((entry) => entry.vectorId)).toEqual([holdoutVectorId]);
    expect(manifest.reviewAttribution.length).toBeGreaterThanOrEqual(1);
    expect(manifest.sourceTextSuspicions).toEqual([]);
    const reread = unwrap(await blueprints.readSourceManifest(projectId, inspector, blueprintId));
    expect(manifest.manifestDigest).toBe(reread.manifestDigest);
  });

  it("refuses the source manifest to Builder and to the generation path", async () => {
    expect(errorOf(await blueprints.readSourceManifest(projectId, builder, blueprintId)).reason).toBe(
      "manifest-is-control-plane-only",
    );
    expect(errorOf(await blueprints.readSourceManifest(projectId, generator, blueprintId)).code).toBe("ACCESS_DENIED");
    expect(journal("blueprint.manifest.read", "deny")).toContain("manifest-is-control-plane-only");
  });

  it("re-verifies the stored bytes on every handoff", async () => {
    // Point the blueprint row at another artifact: the handoff must notice that the
    // bytes it reads are no longer the payload its digest binds.
    const rows = writer.transact((tx) => {
      const row = tx.getBlueprint(projectId, blueprintId);
      if (row === null) throw new Error("blueprint missing");
      const other = tx.getArtifact(projectId, row.sourceManifestArtifactId);
      if (other === null) throw new Error("manifest missing");
      return { artifactId: row.artifactId, otherId: other.id };
    });
    if (!rows.ok) throw new Error(JSON.stringify(rows.error));
    db.prepare(
      "UPDATE blueprints SET artifact_id = (SELECT id FROM artifacts WHERE class = 'inspector' AND project_id = blueprints.project_id ORDER BY created_at DESC LIMIT 1) WHERE id = ? AND project_id = ?",
    )
      .run(blueprintId, projectId);

    const failure = errorOf(await blueprints.handoff(projectId, blueprintId));
    expect(failure.code).toBe("REA_CONTRACT_MISMATCH");
    expect(["blueprint-schema", "blueprint-digest-drift", "artifact-digest-mismatch"]).toContain(failure.reason);

    db.prepare("UPDATE blueprints SET artifact_id = ? WHERE id = ? AND project_id = ?").run(
      rows.value.artifactId,
      blueprintId,
      projectId,
    );
    const restored = unwrap(await blueprints.handoff(projectId, blueprintId));
    expect(restored.blueprintDigest).toBe(digest);

    // A second tampering: keep the payload bytes but rewrite the indexed digest.
    // The payload still parses as a blueprint, so only the recomputation over the
    // stored bytes can catch it.
    db.prepare("UPDATE blueprints SET digest = ? WHERE id = ? AND project_id = ?").run(
      asDigest(hex("tampered")),
      blueprintId,
      projectId,
    );
    const drifted = errorOf(await blueprints.handoff(projectId, blueprintId));
    expect(drifted.reason).toBe("blueprint-digest-drift");

    db.prepare("UPDATE blueprints SET digest = ? WHERE id = ? AND project_id = ?").run(digest, blueprintId, projectId);
    expect(unwrap(await blueprints.handoff(projectId, blueprintId)).blueprintDigest).toBe(digest);
  });

  it("treats two freezes as two handoffs instead of overwriting one", async () => {
    const looked = writer.transact((tx) => tx.getBlueprint(projectId, blueprintId)?.verificationPlanId ?? null);
    if (!looked.ok || looked.value === null) throw new Error("blueprint missing");
    const second = unwrap(await blueprints.freeze(projectId, reviewer, { planId: looked.value }));
    expect(second.blueprintId).not.toBe(blueprintId);
    expect(second.digest).not.toBe(digest);
    const first = unwrap(await blueprints.handoff(projectId, blueprintId));
    const other = unwrap(await blueprints.handoff(projectId, second.blueprintId));
    expect(first.blueprintDigest).toBe(digest);
    expect(other.blueprintDigest).toBe(second.digest);
    // The promised content is identical; only the handoff identity differs.
    expect(JSON.stringify({ ...first, blueprintId: "", blueprintDigest: "" })).toBe(
      JSON.stringify({ ...other, blueprintId: "", blueprintDigest: "" }),
    );
  });
});

describe("the freeze gate blocks on colour, sample and drift (DESIGN §6, PRD A06)", () => {
  let yellowContract: Id;

  it("refuses a freeze requested by Builder or the generation path", async () => {
    const failure = errorOf(await blueprints.freeze(projectId, builder, { planId: newId() }));
    expect(failure.reason).toBe("actor-may-not-freeze");
    expect(errorOf(await blueprints.freeze(projectId, generator, { planId: newId() })).code).toBe("ACCESS_DENIED");
    expect(journal("blueprint.freeze", "deny")).toContain("actor-may-not-freeze");
  });

  it("refuses a plan that was never approved", async () => {
    const vector = await seedVector({ evidence: evidenceOne, ordinal: 2, caseKey: "draft-plan-case" });
    const contract = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          contractKey: "draft-plan-api",
          requiredCases: [{ caseKey: "draft-plan-case", claimId: observedClaimId, kind: "success", vectorIds: [vector.id] }],
        }),
      ),
    );
    unwrap(
      await contracts.review(
        projectId,
        reviewer,
        contract.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: contract.digest },
      ),
    );
    const built = await approvedPlanDraftOnly(contract.contractId, [vector.id]);
    const failure = errorOf(await blueprints.freeze(projectId, reviewer, { planId: built.planId }));
    expect(failure.code).toBe("BLUEPRINT_BLOCKED");
    expect(reasonText(failure)).toContain("plan-not-approved");
  });

  it("refuses a blueprint whose required claim is yellow", async () => {
    const vector = await seedVector({ evidence: evidenceOne, ordinal: 3, caseKey: "yellow-case", approved: true });
    const contract = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          contractKey: "yellow-api",
          sourceClaimIds: [yellowClaimId],
          requiredCases: [{ caseKey: "yellow-case", claimId: yellowClaimId, kind: "success", vectorIds: [vector.id] }],
        }),
      ),
    );
    unwrap(
      await contracts.review(
        projectId,
        reviewer,
        contract.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: contract.digest },
      ),
    );
    yellowContract = contract.contractId;
    const plan = await approvedPlanFor(yellowContract, [vector.id]);
    const failure = errorOf(await blueprints.freeze(projectId, reviewer, { planId: plan.planId }));
    expect(failure.code).toBe("BLUEPRINT_BLOCKED");
    expect(reasonText(failure)).toContain(`claim-not-seen:${yellowClaimId}:INFERRED:basis-derived`);
    expect(journal("blueprint.freeze", "deny").length).toBeGreaterThan(0);
  });

  it("judges an edge by its own claim instead of inheriting a passing node", async () => {
    const vector = await seedVector({ evidence: evidenceOne, ordinal: 4, caseKey: "edge-case", approved: true });
    // The contract's required case is backed by a SEEN claim, so anything that
    // blocks here comes from the second source claim and the edge that cites it.
    const contract = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          contractKey: "edge-api",
          sourceClaimIds: [observedClaimId, yellowClaimId],
          requiredCases: [{ caseKey: "edge-case", claimId: observedClaimId, kind: "success", vectorIds: [vector.id] }],
        }),
      ),
    );
    unwrap(
      await contracts.review(
        projectId,
        reviewer,
        contract.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: contract.digest },
      ),
    );
    const edgeId = newId();
    const linked = writer.transact((tx) => {
      tx.insertGraphEdge({
        id: edgeId,
        projectId,
        targetId,
        fromKey: "entity-cart-observed",
        toKey: "entity-unknown",
        relation: "depends-on",
        claimId: yellowClaimId,
      });
      return true;
    });
    if (!linked.ok) throw new Error(JSON.stringify(linked.error));

    const plan = await approvedPlanFor(contract.contractId, [vector.id]);
    const both = reasonText(errorOf(await blueprints.freeze(projectId, reviewer, { planId: plan.planId })));
    expect(both).toContain(`edge-not-seen:${edgeId}:depends-on:INFERRED`);
    expect(both).toContain(`claim-not-seen:${yellowClaimId}:INFERRED:basis-derived`);

    // Remove the yellow edge but keep the yellow source claim: still blocked, and
    // now only for the claim. That is the proof the two are evaluated separately.
    db.prepare("DELETE FROM graph_edges WHERE id = ?").run(edgeId);
    const claimOnly = reasonText(errorOf(await blueprints.freeze(projectId, reviewer, { planId: plan.planId })));
    expect(claimOnly).toContain(`claim-not-seen:${yellowClaimId}`);
    expect(claimOnly).not.toContain("edge-not-seen");

    // Drop the yellow claim from the promise entirely and the same plan freezes.
    const clean = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          contractKey: "edge-api",
          requiredCases: [{ caseKey: "edge-case", claimId: observedClaimId, kind: "success", vectorIds: [vector.id] }],
        }),
      ),
    );
    unwrap(
      await contracts.review(
        projectId,
        reviewer,
        clean.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: clean.digest },
      ),
    );
    const cleanPlan = await approvedPlanFor(clean.contractId, [vector.id]);
    const frozen = unwrap(await blueprints.freeze(projectId, reviewer, { planId: cleanPlan.planId }));
    expect(frozen.contractCount).toBe(1);
  });

  it("refuses a promise covered only by a holdout sample", async () => {
    const holdout = await seedVector({
      evidence: evidenceTwo,
      ordinal: 5,
      caseKey: "holdout-only",
      visibility: "holdout",
      approved: true,
    });
    const contract = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          contractKey: "holdout-api",
          sourceClaimIds: [holdoutOnlyClaimId],
          requiredCases: [
            { caseKey: "holdout-only", claimId: holdoutOnlyClaimId, kind: "success", vectorIds: [holdout.id] },
          ],
        }),
      ),
    );
    unwrap(
      await contracts.review(
        projectId,
        reviewer,
        contract.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: contract.digest },
      ),
    );
    const plan = await approvedPlanFor(contract.contractId, [holdout.id]);
    const failure = errorOf(await blueprints.freeze(projectId, reviewer, { planId: plan.planId }));
    expect(reasonText(failure)).toContain("blueprint-without-public-sample");
  });

  it("refuses to freeze a plan whose graph revision is stale", async () => {
    const vector = await seedVector({ evidence: evidenceOne, ordinal: 6, caseKey: "stale-case", approved: true });
    const contract = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          contractKey: "stale-api",
          requiredCases: [{ caseKey: "stale-case", claimId: observedClaimId, kind: "success", vectorIds: [vector.id] }],
        }),
      ),
    );
    unwrap(
      await contracts.review(
        projectId,
        reviewer,
        contract.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: contract.digest },
      ),
    );
    const plan = await approvedPlanFor(contract.contractId, [vector.id]);
    const bumped = writer.transact((tx) => tx.upsertProjectRevision(projectId, { graph: 1 }));
    if (!bumped.ok) throw new Error(JSON.stringify(bumped.error));

    const failure = errorOf(await blueprints.freeze(projectId, reviewer, { planId: plan.planId }));
    expect(failure.code).toBe("STALE_INPUT");
    expect(failure.reason).toBe("graph-moved-since-plan");
  });

  it("refuses a handoff whose own text carries a provenance reference", async () => {
    // §7.3 removes the source locator from the projection; that is not enough if a
    // reviewer pasted the evidence id into the behaviour text. The disclosure check
    // runs over the serialized payload, so a reference inside data is refused too.
    const vector = await seedVector({ evidence: evidenceOne, ordinal: 7, caseKey: "leaky-case", approved: true });
    const contract = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          contractKey: "leaky-api",
          behaviorSpec: `GET /api/cart returns the item list, observed in ${evidenceOne}`,
          requiredCases: [{ caseKey: "leaky-case", claimId: observedClaimId, kind: "success", vectorIds: [vector.id] }],
        }),
      ),
    );
    unwrap(
      await contracts.review(
        projectId,
        reviewer,
        contract.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: contract.digest },
      ),
    );
    const plan = await approvedPlanFor(contract.contractId, [vector.id]);
    const failure = errorOf(await blueprints.freeze(projectId, reviewer, { planId: plan.planId }));
    expect(failure.code).toBe("BLUEPRINT_BLOCKED");
    expect(reasonText(failure)).toContain("blueprint-discloses-reference:evidence-id");
    // The refused reason names the category, never the value it protects.
    expect(failure.message).not.toContain(evidenceOne);
    expect(journal("blueprint.freeze", "deny")).toContain("blueprint-discloses-reference:evidence-id");
  });

  it("refuses a freeze request that names anything but a plan", async () => {
    const failure = errorOf(await blueprints.freeze(projectId, reviewer, { planId: newId(), contractIds: [] }));
    expect(failure.code).toBe("INVALID_INPUT");
    expect((failure.details["issues"] as string[]).join(",")).toContain("contractIds");
  });
});

async function approvedPlanDraftOnly(
  contractId: Id,
  vectorIds: Id[],
): Promise<{ planId: Id; digest: Digest }> {
  const rows = writer.transact((tx) => tx.listVectorsForSnapshot(projectId, targetId, SNAPSHOT, 500));
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  const selected = new Set(vectorIds);
  const excluded = rows.value
    .filter((row) => !selected.has(row.id))
    .map((row) => ({
      vectorId: row.id,
      reasonCode: "outside-scope",
      reason: "not part of this delivery",
      excludedBehavior: `case:${row.caseKey}`,
      supersededBy: null,
    }));
  return unwrap(
    plans.build(projectId, inspector, {
      targetId,
      snapshotDigest: SNAPSHOT,
      contractRevisionIds: [contractId],
      excludedVectors: excluded,
      expectedInventoryRevision: inventoryRevision(),
    }),
  );
}

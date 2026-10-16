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
import type { Id } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { vectorDigest, vectorDigestInput } from "../../packages/domain/vector.ts";
import type { TestVectorContent } from "../../packages/domain/vector.ts";
import { acquireWorkerLock, applyMigrations, openWriteConnection, planMigrations } from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { ContractService } from "../../packages/application/contract-service.ts";
import { PlanService } from "../../packages/application/plan-service.ts";
import { VectorService } from "../../packages/application/vector-service.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import { readAudit } from "../../packages/application/audit.ts";
import type { ClaimRow, EvidenceRow, JobRow, TargetRow, VectorRow } from "../../packages/application/ports.ts";
import type { Result } from "../../packages/domain/result.ts";

// ContractService and PlanService against a real SQLite file (DESIGN §7.2, §7.4,
// D27, issue #12). Each of the issue's three checkboxes is pinned by a case that
// would fail if the rule were only documented: a build request with no field to
// move the denominator in, exclusions that must exhaust the same snapshot, and an
// approved plan that cannot be rewritten.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const SNAPSHOT = ("1" as const).repeat(64) as Digest;
const OTHER_SNAPSHOT = ("2" as const).repeat(64) as Digest;
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

const inspector: Actor = { actorId: "local-operator", actorKind: "inspector" };
const reviewer: Actor = { actorId: "reviewer-one", actorKind: "reviewer" };
const builder: Actor = { actorId: "builder-agent", actorKind: "builder" };

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let store: ArtifactStore;
let contracts: ContractService;
let plans: PlanService;
let projectId: Id;
let contractTarget: Id;
let planTarget: Id;
let foreignTarget: Id;
let claimId: Id;
let planClaimId: Id;
let inferredClaimId: Id;
let foreignClaimId: Id;
const heldLocks: { release: () => Promise<void> }[] = [];

function hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function evidenceName(name: string): string {
  return `ev_${hex(name)}`;
}

function unwrap<T>(result: Result<T, GateFailure>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}:${result.error.reason}:${JSON.stringify(result.error.details)}`);
  }
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

function jobRow(id: Id, target: Id): JobRow {
  const created = nowInstant();
  return {
    id,
    projectId,
    targetId: target,
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

async function seedEvidence(id: string, target: Id): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({ seeded: id }));
  const published = await store.publish(projectId, "inspector", bytes);
  if (!published.ok) throw new Error(JSON.stringify(published.error));
  const inserted = writer.transact((tx) => {
    const jobId = newId();
    const artifactId = newId();
    const created = nowInstant();
    tx.insertJob(jobRow(jobId, target));
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
      targetId: target,
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

function claimRow(input: { id: Id; target: Id; key: string; basis: ClaimRow["basis"] }): ClaimRow {
  return {
    id: input.id,
    projectId,
    targetId: input.target,
    entityKey: `entity-${input.key}`,
    claimKey: input.key,
    assertion: `${input.key} at /api/cart`,
    scopeJson: { sourceEvidenceIds: [evidenceName("one")] },
    basis: input.basis,
    sourceState: "available",
    coverageJson: { state: "complete", examined: null, total: null, reasons: [] },
    validity: "current",
    revision: 1,
    unknownReasonsJson: [],
  };
}

type SeededVector = { id: Id; digest: Digest; caseKey: string; evidenceId: string };

// Vectors are seeded directly — payload artifact plus an index row whose digest
// the domain computed — because the contract gate reads them through the vector
// service's verified load path and would notice any mismatch between the two.
async function seedVector(input: {
  evidence: string;
  target: Id;
  ordinal: number;
  caseKey: string;
  operationId?: string;
  blocked?: boolean;
  replacesId?: Id;
  approved?: boolean;
}): Promise<SeededVector> {
  const id = newId();
  const created = nowInstant();
  const content: TestVectorContent = {
    id,
    targetId: input.target,
    snapshotDigest: SNAPSHOT,
    operationId: input.operationId ?? "getCart",
    sdkInput: { include: "items" },
    caseKey: input.caseKey,
    replacesId: input.replacesId ?? null,
    source: {
      evidenceId: input.evidence,
      captureId: null,
      recordOrdinal: input.ordinal,
      pointer: `/records/${String(input.ordinal)}`,
      transactionId: null,
    },
    request: { method: "GET", url: "https://shop.example/api/cart", query: [], headers: [], body: { kind: "empty" } },
    response: { status: 200, headers: [], body: { kind: "text", text: "{}", provenance: "producer-decoded" } },
    expectedOutcome: input.blocked === true ? null : { kind: "return", value: { items: [] } },
    coverage: { state: "complete", examined: null, total: null, reasons: [] },
    limitations: [],
    redactions: [],
    visibility: "public",
    eligibility: input.blocked === true ? "blocked" : "usable",
    reasons: input.blocked === true ? ["vector-missing-oracle"] : [],
  };
  const digest = vectorDigest(content, LIMITS);
  const bytes = new TextEncoder().encode(canonicalJson(vectorDigestInput(content), LIMITS));
  const published = await store.publish(projectId, "inspector", bytes);
  if (!published.ok) throw new Error(JSON.stringify(published.error));
  const artifactId = newId();
  const row: VectorRow = {
    id,
    projectId,
    targetId: content.targetId,
    evidenceId: content.source.evidenceId,
    sourceLocatorJson: content.source,
    snapshotDigest: content.snapshotDigest,
    payloadArtifactId: artifactId,
    digest,
    replacesId: content.replacesId,
    caseKey: content.caseKey,
    visibility: "public",
    eligibility: content.eligibility,
    reasonsJson: content.reasons,
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
  return { id, digest, caseKey: content.caseKey, evidenceId: content.source.evidenceId };
}

function contractRequest(overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    contractKey: "cart-api",
    targetId: contractTarget,
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
    requiredCases: [{ caseKey: "cart-ok", claimId, kind: "success", vectorIds: [] }],
    ...overrides,
  };
}

function inventoryRevision(): number {
  const project = writer.transact((tx) => tx.getProject(projectId));
  if (!project.ok || project.value === null) throw new Error("project missing");
  return project.value.inventoryRevision;
}

function journal(action: string, decision: string): string[] {
  const rows = readAudit(writer, { after: 0, projectId, limit: 500 });
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  return rows.value
    .filter((entry) => entry.action === action && entry.decision === decision)
    .map((entry) => entry.reasonCode);
}

function eventsOfType(type: string): { aggregateId: string; payload: JsonValue }[] {
  const rows = writer.transact((tx) => tx.eventsAfter(projectId, 0, 500));
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  return rows.value
    .filter((entry) => entry.type === type)
    .map((entry) => ({ aggregateId: entry.aggregateId, payload: entry.payloadJson }));
}

function vectorsIn(target: Id): VectorRow[] {
  const rows = writer.transact((tx) => tx.listVectorsForSnapshot(projectId, target, SNAPSHOT, 500));
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  return rows.value;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-behaviors-"));
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
  contractTarget = newId();
  planTarget = newId();
  foreignTarget = newId();
  claimId = newId();
  planClaimId = newId();
  inferredClaimId = newId();
  foreignClaimId = newId();

  const vectorService = new VectorService({
    storage: writer,
    artifacts: store,
    // The contract gate only reads persisted vectors; nothing here asks REA.
    facts: {
      readRecord: async () => {
        throw new Error("the facts port must not be reached by the contract gate");
      },
    },
    limits: LIMITS,
  });
  contracts = new ContractService({ storage: writer, limits: LIMITS, vectors: vectorService });
  plans = new PlanService({ storage: writer, limits: LIMITS });

  function target(id: Id, snapshot: Digest | null): TargetRow {
    return {
      id,
      projectId,
      kind: "har",
      originalLocator: null,
      sourceSha256: snapshot,
      sourceArtifactId: null,
      snapshotDigest: snapshot,
      identityReason: snapshot === null ? "not-captured" : null,
      createdAt: nowInstant(),
    };
  }

  const seeded = writer.transact((tx) => {
    tx.insertProject({
      id: projectId,
      name: "cart",
      createdAt: nowInstant(),
      graphRevision: 4,
      inventoryRevision: 0,
      schemaVersion: 1,
    });
    tx.insertTarget(target(contractTarget, SNAPSHOT));
    tx.insertTarget(target(planTarget, SNAPSHOT));
    tx.insertTarget(target(foreignTarget, OTHER_SNAPSHOT));
    tx.insertClaim(claimRow({ id: claimId, target: contractTarget, key: "cart-observed", basis: "observed" }));
    tx.insertClaim(claimRow({ id: planClaimId, target: planTarget, key: "plan-observed", basis: "observed" }));
    tx.insertClaim(claimRow({ id: inferredClaimId, target: contractTarget, key: "cart-inferred", basis: "inferred" }));
    tx.insertClaim(claimRow({ id: foreignClaimId, target: foreignTarget, key: "foreign", basis: "observed" }));
    return true;
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  await seedEvidence(evidenceName("one"), contractTarget);
  await seedEvidence(evidenceName("two"), contractTarget);
  await seedEvidence(evidenceName("plan"), planTarget);
  await seedEvidence(evidenceName("legacy"), planTarget);
});

afterAll(async () => {
  db.close();
  for (const lock of heldLocks) await lock.release();
  await rm(root, { recursive: true, force: true });
});

describe("ContractService revisions (DESIGN §7.2)", () => {
  let emptyContract: { contractId: Id; digest: Digest };

  it("assigns the revision number itself", () => {
    const first = unwrap(contracts.createDraft(projectId, inspector, contractRequest()));
    expect(first.revision).toBe(1);
    emptyContract = { contractId: first.contractId, digest: first.digest };
    const second = unwrap(contracts.createDraft(projectId, inspector, contractRequest()));
    expect(second.revision).toBe(2);
    expect(second.contractId).not.toBe(first.contractId);
  });

  it("refuses a claim the contract does not own, and one from another target", () => {
    const outside = errorOf(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          requiredCases: [{ caseKey: "x", claimId: inferredClaimId, kind: "edge", vectorIds: [] }],
        }),
      ),
    );
    expect(outside.reason).toBe("required-case-claim-outside-source");

    const foreign = errorOf(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          sourceClaimIds: [foreignClaimId],
          requiredCases: [{ caseKey: "x", claimId: foreignClaimId, kind: "edge", vectorIds: [] }],
        }),
      ),
    );
    expect(foreign.reason).toBe("source-claim-target-mismatch");
  });

  it("refuses a sample reference that does not resolve", () => {
    const unknown = errorOf(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({ requiredCases: [{ caseKey: "cart-ok", claimId, kind: "success", vectorIds: [newId()] }] }),
      ),
    );
    expect(unknown.reason).toBe("required-vector-unknown");
  });

  it("refuses two required cases sharing a caseKey", () => {
    const failure = errorOf(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          requiredCases: [
            { caseKey: "cart-ok", claimId, kind: "success", vectorIds: [] },
            { caseKey: "cart-ok", claimId, kind: "error", vectorIds: [] },
          ],
        }),
      ),
    );
    expect(failure.reason).toBe("duplicate-case-key");
  });

  it("refuses a scope snapshot the target does not hold", () => {
    const failure = errorOf(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          scope: { snapshotDigest: OTHER_SNAPSHOT, operationIds: ["getCart"], excludedBehaviors: [] },
        }),
      ),
    );
    expect(failure.reason).toBe("scope-snapshot-mismatch");
  });

  it("blocks approval when an operation has no required case", async () => {
    const failure = errorOf(
      await contracts.review(
        projectId,
        reviewer,
        emptyContract.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: emptyContract.digest },
      ),
    );
    expect(failure.code).toBe("BLUEPRINT_BLOCKED");
    expect(reasonText(failure)).toContain("operation-without-required-case:getCart");
    // The journal names one reason; the review body names them all. The invariant
    // a reader needs is that the journalled reason is one of the reported ones,
    // not that it is first in the list.
    const denies = journal("contract.review", "deny");
    expect(denies.length).toBe(1);
    expect((failure.details["reasons"] as string[]).join(",")).toContain(denies[0] as string);
    expect(eventsOfType("contract.reviewed").length).toBe(0);
  });

  it("approves, locks the digest, and refuses any later decision", async () => {
    const vector = await seedVector({
      evidence: evidenceName("one"),
      target: contractTarget,
      ordinal: 0,
      caseKey: "cart-ok",
    });
    const created = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({ requiredCases: [{ caseKey: "cart-ok", claimId, kind: "success", vectorIds: [vector.id] }] }),
      ),
    );
    const committed = unwrap(
      await contracts.review(
        projectId,
        reviewer,
        created.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: created.digest },
      ),
    );
    expect(committed.reviewStatus).toBe("approved");
    expect(committed.eventSeq).not.toBeNull();

    const reread = unwrap(contracts.read(projectId, reviewer, created.contractId));
    expect(reread.digest).toBe(created.digest);
    expect(reread.review.approvedDigest).toBe(created.digest);
    expect(reread.review.reviewerId).toBe("reviewer-one");
    expect(reread.requiredCases[0]?.vectorIds).toEqual([vector.id]);
    expect(reread.sourceClaimIds).toEqual([claimId]);

    const again = errorOf(
      await contracts.review(
        projectId,
        reviewer,
        created.contractId,
        { decision: "rejected", reviewerId: "reviewer-two", digest: null },
      ),
    );
    expect(again.reason).toBe("contract-already-reviewed");
  });

  it("refuses an approval that names a different digest", async () => {
    const failure = errorOf(
      await contracts.review(
        projectId,
        reviewer,
        emptyContract.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: asDigest(hex("other")) },
      ),
    );
    expect(failure.reason).toBe("approved-digest-mismatch");
  });

  it("refuses a sample whose operation is outside the contract scope", async () => {
    const vector = await seedVector({
      evidence: evidenceName("two"),
      target: contractTarget,
      ordinal: 0,
      caseKey: "cart-ok",
      operationId: "postCart",
    });
    const created = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({ requiredCases: [{ caseKey: "cart-ok", claimId, kind: "success", vectorIds: [vector.id] }] }),
      ),
    );
    const failure = errorOf(
      await contracts.review(
        projectId,
        reviewer,
        created.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: created.digest },
      ),
    );
    expect(failure.code).toBe("BLUEPRINT_BLOCKED");
    expect(reasonText(failure)).toContain("vector-operation-out-of-scope");
  });

  it("does not demand an approved usable sample for contract approval", async () => {
    // Eligibility is the plan and blueprint question (§7.2 vs §7.4): the contract
    // only has to prove the scope is honest.
    const draftVector = await seedVector({
      evidence: evidenceName("one"),
      target: contractTarget,
      ordinal: 4,
      caseKey: "cart-ok",
    });
    const created = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({ requiredCases: [{ caseKey: "cart-ok", claimId, kind: "success", vectorIds: [draftVector.id] }] }),
      ),
    );
    const approved = unwrap(
      await contracts.review(
        projectId,
        reviewer,
        created.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: created.digest },
      ),
    );
    expect(approved.reviewStatus).toBe("approved");
  });

  it("gives Builder no contract endpoint", () => {
    expect(errorOf(contracts.createDraft(projectId, builder, contractRequest())).code).toBe("ACCESS_DENIED");
    expect(errorOf(contracts.read(projectId, builder, emptyContract.contractId)).code).toBe("ACCESS_DENIED");
    expect(journal("contract.create", "deny")).toContain("builder-has-no-contract-permission");
  });

  it("lets only an inspector or reviewer record a contract decision", async () => {
    // A decision is attribution: the generation path and Builder may neither
    // approve nor reject, and the refusal is journalled (§12.2).
    const asBuilder = errorOf(
      await contracts.review(
        projectId,
        builder,
        emptyContract.contractId,
        { decision: "approved", reviewerId: "builder-agent", digest: emptyContract.digest },
      ),
    );
    expect(asBuilder.code).toBe("ACCESS_DENIED");
    expect(asBuilder.reason).toBe("actor-may-not-review");

    const asWorker = errorOf(
      await contracts.review(
        projectId,
        { actorId: "generation-worker", actorKind: "system" },
        emptyContract.contractId,
        { decision: "approved", reviewerId: "generation-worker", digest: emptyContract.digest },
      ),
    );
    expect(asWorker.code).toBe("ACCESS_DENIED");
    expect(journal("contract.review", "deny")).toContain("actor-may-not-review");
    // Nothing was approved by the refusals above.
    expect(unwrap(contracts.read(projectId, reviewer, emptyContract.contractId)).review.status).toBe("draft");
  });
});

describe("PlanService frozen denominator (DESIGN §7.4)", () => {
  let requiredVector: SeededVector;
  let legacyVector: SeededVector;
  let leafVector: SeededVector;
  let frozenContract: { contractId: Id; digest: Digest };
  let adoptedContract: { contractId: Id; digest: Digest };

  function scopeCase(vectorId: Id): Record<string, JsonValue> {
    return { caseKey: "frozen-case", claimId: planClaimId, kind: "success", vectorIds: [vectorId] };
  }

  function selectedOf(contractIds: Id[]): Id[] {
    const union = new Set<Id>();
    for (const id of contractIds) {
      const contract = unwrap(contracts.read(projectId, reviewer, id));
      for (const entry of contract.requiredCases) {
        for (const vectorId of entry.vectorIds) union.add(vectorId);
      }
    }
    return [...union].sort();
  }

  // The only honest exclusion for an unselected vector: its own successor if the
  // plan selected that successor, otherwise an explicit out-of-scope behaviour.
  function autoExclusions(selected: Id[]): Record<string, JsonValue>[] {
    const chosen = new Set(selected);
    const rows = vectorsIn(planTarget);
    return rows
      .filter((row) => !chosen.has(row.id))
      .map((row) => {
        const successor = rows.find((entry) => entry.replacesId === row.id && chosen.has(entry.id));
        return successor === undefined
          ? {
              vectorId: row.id,
              reasonCode: "outside-scope",
              reason: "not part of this delivery",
              excludedBehavior: `case:${row.caseKey}`,
              supersededBy: null,
            }
          : {
              vectorId: row.id,
              reasonCode: "superseded",
              reason: "revised by the selected leaf",
              excludedBehavior: "none",
              supersededBy: successor.id,
            };
      });
  }

  function buildRequest(options: { contractIds?: Id[]; excludedVectors?: Record<string, JsonValue>[] } = {}) {
    const contractIds = options.contractIds ?? [frozenContract.contractId];
    return {
      targetId: planTarget,
      snapshotDigest: SNAPSHOT,
      contractRevisionIds: contractIds,
      excludedVectors: options.excludedVectors ?? autoExclusions(selectedOf(contractIds)),
      expectedInventoryRevision: inventoryRevision(),
    };
  }

  beforeAll(async () => {
    requiredVector = await seedVector({
      evidence: evidenceName("plan"),
      target: planTarget,
      ordinal: 0,
      caseKey: "frozen-case",
      approved: true,
    });
    legacyVector = await seedVector({
      evidence: evidenceName("legacy"),
      target: planTarget,
      ordinal: 1,
      caseKey: "legacy-search",
      blocked: true,
    });
    const created = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          targetId: planTarget,
          contractKey: "frozen-api",
          sourceClaimIds: [planClaimId],
          requiredCases: [scopeCase(requiredVector.id)],
        }),
      ),
    );
    unwrap(
      await contracts.review(
        projectId,
        reviewer,
        created.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: created.digest },
      ),
    );
    frozenContract = { contractId: created.contractId, digest: created.digest };
  });

  it("has no field a caller could use to move the denominator", () => {
    const failure = errorOf(
      plans.build(projectId, inspector, {
        ...buildRequest(),
        selectedVectorIds: [],
        inventoryDigest: asDigest(hex("nothing")),
      }),
    );
    expect(failure.code).toBe("INVALID_INPUT");
    const issues = (failure.details["issues"] as string[]).join(",");
    expect(issues).toContain("selectedVectorIds");
    expect(issues).toContain("inventoryDigest");
  });

  it("refuses a plan whose exclusions leave an inventory entry unaccounted", () => {
    const failure = errorOf(plans.build(projectId, inspector, buildRequest({ excludedVectors: [] })));
    expect(failure.code).toBe("BLUEPRINT_BLOCKED");
    expect(reasonText(failure)).toContain(`inventory-not-exhausted:${legacyVector.id}`);
  });

  it("refuses excluding the vector the contract requires", () => {
    const failure = errorOf(
      plans.build(
        projectId,
        inspector,
        buildRequest({
          excludedVectors: [
            {
              vectorId: requiredVector.id,
              reasonCode: "outside-scope",
              reason: "declared out of scope",
              excludedBehavior: "case:renamed",
              supersededBy: null,
            },
            {
              vectorId: legacyVector.id,
              reasonCode: "outside-scope",
              reason: "not part of this delivery",
              excludedBehavior: "case:legacy-search",
              supersededBy: null,
            },
          ],
        }),
      ),
    );
    expect(reasonText(failure)).toContain(`vector-both-selected-and-excluded:${requiredVector.id}`);
  });

  it("refuses an exclusion outside the frozen snapshot", () => {
    const failure = errorOf(
      plans.build(
        projectId,
        inspector,
        buildRequest({
          excludedVectors: [
            {
              vectorId: newId(),
              reasonCode: "outside-scope",
              reason: "not part of this delivery",
              excludedBehavior: "case:elsewhere",
              supersededBy: null,
            },
          ],
        }),
      ),
    );
    expect(reasonText(failure)).toContain("excluded-vector-outside-inventory");
  });

  it("refuses using the sample's own blocking reason as a scope claim", () => {
    const failure = errorOf(
      plans.build(
        projectId,
        inspector,
        buildRequest({
          excludedVectors: [
            {
              vectorId: legacyVector.id,
              reasonCode: "outside-scope",
              reason: "declared out of scope",
              excludedBehavior: "vector-missing-oracle",
              supersededBy: null,
            },
          ],
        }),
      ),
    );
    expect(reasonText(failure)).toContain(`blocked-is-not-an-exclusion:${legacyVector.id}`);
  });

  it("refuses excluding the counter-evidence of a promised claim", () => {
    const linked = writer.transact((tx) => {
      tx.insertClaimEvidence({
        projectId,
        claimId: planClaimId,
        evidenceId: legacyVector.evidenceId,
        locationJson: { pointer: "/records/1" },
        role: "contradict",
      });
      return true;
    });
    if (!linked.ok) throw new Error(JSON.stringify(linked.error));

    const failure = errorOf(plans.build(projectId, inspector, buildRequest()));
    expect(reasonText(failure)).toContain(`cannot-exclude-contradicting-evidence:${legacyVector.id}`);

    // The link existed only to prove the refusal; keeping it would contradict the
    // later cases, whose scope has no counter-evidence.
    db.exec("DELETE FROM claim_evidence WHERE role = 'contradict'");
  });

  it("checks expectedInventoryRevision before deriving anything", () => {
    const failure = errorOf(
      plans.build(projectId, inspector, { ...buildRequest(), expectedInventoryRevision: 0 }),
    );
    expect(failure.code).toBe("REVISION_CONFLICT");
    expect(failure.reason).toBe("inventory-revision-changed");
  });

  it("derives the selected set from the approved contract and binds both revisions", () => {
    const built = unwrap(plans.build(projectId, inspector, buildRequest()));
    expect(built.selectedCount).toBe(1);
    expect(built.excludedCount).toBe(1);
    expect(built.graphRevision).toBe(4);
    expect(built.inventoryRevision).toBe(inventoryRevision());

    const plan = unwrap(plans.read(projectId, reviewer, built.planId));
    expect(plan.selectedVectorIds).toEqual([requiredVector.id]);
    expect(plan.excludedVectors[0]?.vectorId).toBe(legacyVector.id);
    expect(plan.review.status).toBe("draft");
    // A draft is not a delivery event: only a reviewed plan reaches the outbox.
    expect(eventsOfType("plan.reviewed").length).toBe(0);
  });

  it("refuses a plan bound to an unapproved contract", () => {
    const draftContract = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          targetId: planTarget,
          contractKey: "draft-api",
          sourceClaimIds: [planClaimId],
          requiredCases: [scopeCase(requiredVector.id)],
        }),
      ),
    );
    const failure = errorOf(plans.build(projectId, inspector, buildRequest({ contractIds: [draftContract.contractId] })));
    expect(reasonText(failure)).toContain(`contract-not-approved:${draftContract.contractId}`);
  });

  it("refuses selecting a chain parent while its leaf is unaccounted, then adopts the leaf honestly", async () => {
    leafVector = await seedVector({
      evidence: evidenceName("plan"),
      target: planTarget,
      ordinal: 0,
      caseKey: "frozen-case",
      replacesId: requiredVector.id,
      approved: true,
    });
    const failure = errorOf(
      plans.build(
        projectId,
        inspector,
        buildRequest({
          excludedVectors: [
            {
              vectorId: legacyVector.id,
              reasonCode: "outside-scope",
              reason: "not part of this delivery",
              excludedBehavior: "case:legacy-search",
              supersededBy: null,
            },
          ],
        }),
      ),
    );
    expect(reasonText(failure)).toContain(`superseded-version-selected-leaf-left-out:${requiredVector.id}`);

    const created = unwrap(
      contracts.createDraft(
        projectId,
        inspector,
        contractRequest({
          targetId: planTarget,
          contractKey: "frozen-api",
          sourceClaimIds: [planClaimId],
          requiredCases: [scopeCase(leafVector.id)],
        }),
      ),
    );
    expect(created.revision).toBe(2);
    unwrap(
      await contracts.review(
        projectId,
        reviewer,
        created.contractId,
        { decision: "approved", reviewerId: "reviewer-one", digest: created.digest },
      ),
    );
    adoptedContract = { contractId: created.contractId, digest: created.digest };

    const rebuilt = unwrap(plans.build(projectId, inspector, buildRequest({ contractIds: [adoptedContract.contractId] })));
    expect(rebuilt.selectedCount).toBe(1);
    expect(rebuilt.excludedCount).toBe(2);
    const plan = unwrap(plans.read(projectId, reviewer, rebuilt.planId));
    expect(plan.selectedVectorIds).toEqual([leafVector.id]);
    const superseded = plan.excludedVectors.find((entry) => entry.vectorId === requiredVector.id);
    expect(superseded?.reasonCode).toBe("superseded");
    if (superseded?.reasonCode === "superseded") expect(superseded.supersededBy).toBe(leafVector.id);
  });

  it("approves a plan whose selected cases are all usable and approved, then keeps it immutable", () => {
    const built = unwrap(plans.build(projectId, inspector, buildRequest({ contractIds: [adoptedContract.contractId] })));
    const committed = unwrap(
      plans.review(
        projectId,
        reviewer,
        built.planId,
        {
          decision: "approved",
          reviewerId: "reviewer-one",
          digest: built.digest,
          expectedInventoryRevision: built.inventoryRevision,
        },
      ),
    );
    expect(committed.reviewStatus).toBe("approved");
    expect(eventsOfType("plan.reviewed").length).toBe(1);

    const rewritten = errorOf(
      plans.review(
        projectId,
        reviewer,
        built.planId,
        { decision: "rejected", reviewerId: "reviewer-two", digest: null, expectedInventoryRevision: inventoryRevision() },
      ),
    );
    expect(rewritten.reason).toBe("plan-already-reviewed");
    const reread = unwrap(plans.read(projectId, reviewer, built.planId));
    expect(reread.digest).toBe(built.digest);
    expect(reread.selectedVectorIds).toEqual([leafVector.id]);
  });

  it("refuses to approve a plan whose frozen snapshot moved", async () => {
    const built = unwrap(plans.build(projectId, inspector, buildRequest({ contractIds: [adoptedContract.contractId] })));
    await seedVector({
      evidence: evidenceName("legacy"),
      target: planTarget,
      ordinal: 2,
      caseKey: "new-contradiction",
      blocked: true,
    });
    const failure = errorOf(
      plans.review(
        projectId,
        reviewer,
        built.planId,
        {
          decision: "approved",
          reviewerId: "reviewer-one",
          digest: built.digest,
          expectedInventoryRevision: inventoryRevision(),
        },
      ),
    );
    expect(failure.reason).toBe("inventory-moved-since-build");
  });

  it("lists plans for the control plane and refuses a frozen plan to a builder", () => {
    const listed = unwrap(plans.list(projectId, reviewer, planTarget));
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed.every((plan) => plan.targetId === planTarget)).toBe(true);
    expect(errorOf(plans.list(projectId, builder, planTarget)).code).toBe("ACCESS_DENIED");
    expect(vectorsIn(planTarget).length).toBe(4);
  });

  it("gives Builder no plan endpoint", () => {
    expect(errorOf(plans.build(projectId, builder, buildRequest())).code).toBe("ACCESS_DENIED");
    expect(errorOf(plans.read(projectId, builder, newId())).code).toBe("ACCESS_DENIED");
    expect(journal("plan.build", "deny")).toContain("builder-has-no-plan-permission");
  });

  it("lets only an inspector or reviewer record a plan decision", () => {
    const built = unwrap(plans.build(projectId, inspector, buildRequest({ contractIds: [adoptedContract.contractId] })));
    for (const kind of ["builder", "system"] as const) {
      const refusal = errorOf(
        plans.review(
          projectId,
          { actorId: `${kind}-actor`, actorKind: kind },
          built.planId,
          {
            decision: "approved",
            reviewerId: `${kind}-actor`,
            digest: built.digest,
            expectedInventoryRevision: built.inventoryRevision,
          },
        ),
      );
      expect(refusal.code).toBe("ACCESS_DENIED");
      expect(refusal.reason).toBe("actor-may-not-review");
    }
    expect(journal("plan.review", "deny")).toContain("actor-may-not-review");
    expect(unwrap(plans.read(projectId, reviewer, built.planId)).review.status).toBe("draft");
  });
});

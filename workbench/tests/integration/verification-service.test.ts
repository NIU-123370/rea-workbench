import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asDigest, canonicalJson } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { vectorDigest, vectorDigestInput } from "../../packages/domain/vector.ts";
import type { TestVector, TestVectorContent } from "../../packages/domain/vector.ts";
import { planDigest } from "../../packages/domain/plan.ts";
import type { VerificationPlanContent } from "../../packages/domain/plan.ts";
import {
  acquireWorkerLock,
  applyMigrations,
  openWriteConnection,
  planMigrations,
} from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { VectorService } from "../../packages/application/vector-service.ts";
import {
  VerificationService,
  deriveOutcomes,
  hasReviewedOracle,
} from "../../packages/application/verification-service.ts";
import { readAudit } from "../../packages/application/audit.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type {
  ArtifactRow,
  EvidenceFactsPort,
  VerificationRow,
  JobRow,
  PlanRow,
  VectorRow,
} from "../../packages/application/ports.ts";
import type { Result } from "../../packages/domain/result.ts";

// VerificationService against real storage (DESIGN §10, PRD F09 / A08, issue #20).
//
// Plan, blueprint and candidate rows are seeded through the storage port here:
// their owners (S12/S13/S20) have their own suites, and this file has to prove the
// verification gate — who may record, what a record binds, and that nothing a
// candidate says can become a verdict. Every scenario owns a target and snapshot,
// because a plan must exhaust *its* inventory (§7.4): samples added to the same
// snapshot would legitimately make an earlier plan non-exhaustive, and those two
// rules belong in different tests.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const RUNNER_IMAGE = ("a" as const).repeat(64) as Digest;
const TAMPERED_STAGING_ID = "ffffffff-0000-4000-8000-000000000001";

const evaluator: Actor = { actorId: "evaluator-one", actorKind: "evaluator" };
const builder: Actor = { actorId: "builder-agent", actorKind: "builder" };
const inspector: Actor = { actorId: "local-operator", actorKind: "inspector" };

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let store: ArtifactStore;
let verifications: VerificationService;
let projectId: Id;
const heldLocks: { release: () => Promise<void> }[] = [];

function hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function unwrap<T>(result: Result<T, GateFailure>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}:${result.error.reason}:${JSON.stringify(result.error.details)}`);
  }
  return result.value;
}

async function failureOf<T>(result: Promise<Result<T, GateFailure>> | Result<T, GateFailure>) {
  const settled = await result;
  if (settled.ok) throw new Error("expected a refusal, got a value");
  return settled.error;
}

function jobRow(id: Id, targetId: Id, kind: JobRow["kind"], state: JobRow["state"]): JobRow {
  const created = nowInstant();
  return {
    id,
    projectId,
    targetId,
    kind,
    state,
    cleanupState: "pending",
    inputJson: {},
    resultRef: null,
    errorJson: null,
    idempotencyKey: `verify-${id}`,
    requestDigest: asDigest(hex(`verify-${id}`)),
    deadlineAt: null,
    retryAt: null,
    createdAt: created,
    updatedAt: created,
  };
}

// Bodies carry a fresh nonce so two seeds of the same shape do not collide in the
// store's (project, class, digest) dedupe. `publishExact` is for the bodies that
// must stay byte-for-byte what a schema will re-parse.
async function publishArtifact(
  class_: "inspector" | "blueprint" | "candidate" | "report",
  body: Record<string, unknown>,
): Promise<Id> {
  return insertArtifactBytes(class_, JSON.stringify({ ...body, nonce: newId() }));
}

async function publishExact(
  class_: "inspector" | "blueprint" | "candidate" | "report",
  text: string,
): Promise<Id> {
  return insertArtifactBytes(class_, text);
}

async function insertArtifactBytes(
  class_: "inspector" | "blueprint" | "candidate" | "report",
  text: string,
): Promise<Id> {
  const bytes = new TextEncoder().encode(text);
  const published = await store.publish(projectId, class_, bytes);
  if (!published.ok) throw new Error(JSON.stringify(published.error));
  const rowId = newId();
  const row: ArtifactRow = {
    id: rowId,
    projectId,
    jobId: null,
    class: class_,
    sha256: published.value.sha256,
    digestReason: null,
    byteLength: published.value.byteLength,
    storageKey: published.value.storageKey,
    mediaType: "application/json",
    createdAt: nowInstant(),
  };
  const inserted = writer.transact((tx) => {
    tx.insertArtifact(row);
    return true;
  });
  if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
  return rowId;
}

async function seedVector(input: {
  targetId: Id;
  snapshotDigest: Digest;
  evidenceId: string;
  caseKey: string;
  visibility: "public" | "holdout";
  approved: boolean;
}): Promise<{ id: Id; digest: Digest }> {
  const id = newId();
  const content: TestVectorContent = {
    id,
    targetId: input.targetId,
    snapshotDigest: input.snapshotDigest,
    operationId: "getCart",
    sdkInput: { include: "items" },
    caseKey: input.caseKey,
    replacesId: null,
    source: {
      evidenceId: input.evidenceId,
      captureId: null,
      recordOrdinal: 0,
      pointer: "/records/0/reported",
      transactionId: null,
    },
    request: { method: "GET", url: "https://shop.example/api/cart", query: [], headers: [], body: { kind: "empty" } },
    response: {
      status: 200,
      headers: [],
      body: { kind: "text", text: "{}", provenance: "producer-decoded" },
    },
    expectedOutcome: { kind: "return", value: { items: [] } },
    coverage: { state: "complete", examined: null, total: null, reasons: [] },
    limitations: [],
    redactions: [],
    visibility: input.visibility,
    eligibility: "usable",
    reasons: input.approved ? [] : ["sample-awaiting-review"],
  };
  const digest = vectorDigest(content, LIMITS);
  const payloadArtifactId = await publishExact(
    "inspector",
    canonicalJson(vectorDigestInput(content), LIMITS),
  );
  const row: VectorRow = {
    id,
    projectId,
    targetId: input.targetId,
    evidenceId: input.evidenceId,
    sourceLocatorJson: { pointer: "/records/0/reported" },
    snapshotDigest: input.snapshotDigest,
    payloadArtifactId,
    digest,
    replacesId: null,
    caseKey: input.caseKey,
    visibility: input.visibility,
    eligibility: "usable",
    reasonsJson: content.reasons,
    reviewStatus: input.approved ? "approved" : "draft",
    reviewRecordJson: input.approved
      ? {
          status: "approved",
          reviewerId: "reviewer-one",
          reviewedAt: nowInstant(),
          approvedDigest: digest,
        }
      : null,
  };
  const inserted = writer.transact((tx) => {
    tx.insertVector(row);
    return true;
  });
  if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
  return { id, digest };
}

type Scenario = {
  targetId: Id;
  snapshotDigest: Digest;
  jobId: Id;
  planId: Id;
  planDigest: Digest;
  blueprintId: Id;
  blueprintDigest: Digest;
  candidateId: Id;
  candidateDigest: Digest;
  vectors: { id: Id; visibility: "public" | "holdout" }[];
  evidenceId: string;
  // Each scenario stages its own transcript: the store dedupes published bodies by
  // (project, class, digest), and two runs of the same bytes are one artifact.
  stagingId: string;
  stagingSha: Digest;
};

async function seedScenario(
  name: string,
  options: { approvedPlan?: boolean; unreviewedMain?: boolean } = {},
): Promise<Scenario> {
  const targetId = newId();
  const snapshotDigest = asDigest(hex(`snapshot-${name}`));
  const planId = newId();
  const blueprintId = newId();
  const candidateId = newId();
  const jobId = newId();
  const created = nowInstant();

  const target = writer.transact((tx) => {
    tx.insertTarget({
      id: targetId,
      projectId,
      kind: "asar",
      originalLocator: null,
      sourceSha256: null,
      sourceArtifactId: null,
      snapshotDigest,
      identityReason: null,
      createdAt: created,
    });
    return true;
  });
  if (!target.ok) throw new Error(JSON.stringify(target.error));

  const evidenceId = `ev_${hex(`evidence-${name}`)}`;
  const evidenceArtifactId = await publishArtifact("inspector", { seeded: evidenceId });
  const captureJobId = newId();
  const seeded = writer.transact((tx) => {
    tx.insertJob(jobRow(captureJobId, targetId, "capture", "succeeded"));
    tx.insertEvidence({
      projectId,
      id: evidenceId,
      targetId,
      jobId: captureJobId,
      artifactId: evidenceArtifactId,
      providerJson: { id: "rea.web.network", name: "capture", version: "6.4.0" },
      operation: "inspect_web_network_capture",
      confidence: "observed",
      authority: "historical-reference",
      createdAt: created,
    });
    tx.insertJob(jobRow(jobId, targetId, "verify", "running"));
    return true;
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));

  const main = await seedVector({
    targetId,
    snapshotDigest,
    evidenceId,
    caseKey: `cart-ok-${name}`,
    visibility: "public",
    approved: options.unreviewedMain !== true,
  });
  const held = await seedVector({
    targetId,
    snapshotDigest,
    evidenceId,
    caseKey: `cart-holdout-${name}`,
    visibility: "holdout",
    approved: true,
  });

  const content: VerificationPlanContent = {
    id: planId,
    targetId,
    snapshotDigest,
    contractRevisionIds: [newId()],
    graphRevision: 1,
    inventoryRevision: 2,
    inventoryDigest: asDigest(hex(`inventory-${name}`)),
    selectedVectorIds: [main.id, held.id],
    excludedVectors: [],
  };
  const planDigestValue = planDigest(content, LIMITS);
  const blueprintArtifactId = await publishArtifact("blueprint", { schemaVersion: 1 });
  const manifestArtifactId = await publishArtifact("inspector", { manifest: true });
  const candidateArtifactId = await publishArtifact("candidate", { adapter: "abi-v1" });
  const blueprintDigest = asDigest(hex(`blueprint-${name}`));
  const candidateDigest = asDigest(hex(`candidate-${name}`));

  const planRow: PlanRow = {
    id: planId,
    projectId,
    targetId,
    snapshotDigest,
    graphRevision: 1,
    inventoryRevision: 2,
    inventoryDigest: content.inventoryDigest,
    payloadJson: content as unknown as JsonValue,
    digest: planDigestValue,
    reviewStatus: options.approvedPlan === false ? "draft" : "approved",
    reviewRecordJson: null,
    createdAt: created,
  };
  const rows = writer.transact((tx) => {
    tx.insertPlan(planRow);
    tx.insertBlueprint({
      id: blueprintId,
      projectId,
      targetId,
      graphRevision: 1,
      snapshotDigest,
      verificationPlanId: planId,
      artifactId: blueprintArtifactId,
      digest: blueprintDigest,
      sourceManifestArtifactId: manifestArtifactId,
      createdAt: created,
    });
    tx.insertCandidate({
      id: candidateId,
      projectId,
      blueprintId,
      jobId,
      artifactId: candidateArtifactId,
      digest: candidateDigest,
      generatorJson: { model: "untrusted-candidate" },
      dependencyManifestJson: { packages: [] },
    });
    return true;
  });
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));

  const stagingId = hex(`staging-${name}`).slice(0, 36);
  const staged = new TextEncoder().encode(
    JSON.stringify({ transcript: "observations", scenario: name }),
  );
  const written = await store.writeStaging(projectId, stagingId, staged);
  if (!written.ok) throw new Error(JSON.stringify(written.error));

  return {
    targetId,
    snapshotDigest,
    jobId,
    planId,
    planDigest: planDigestValue,
    blueprintId,
    blueprintDigest,
    candidateId,
    candidateDigest,
    vectors: [
      { id: main.id, visibility: "public" },
      { id: held.id, visibility: "holdout" },
    ],
    evidenceId,
    stagingId,
    stagingSha: written.value.sha256,
  };
}

function observation(vectorId: Id, overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    vectorId,
    requestObserved: true,
    requestMatches: true,
    decodedMatches: true,
    outcome: { kind: "return", value: { items: [] } },
    expectedOutcomeObserved: true,
    nondeterministic: false,
    safeDiff: null,
    ...overrides,
  };
}

function completionFor(scenario: Scenario, overrides: Record<string, JsonValue> = {}) {
  return {
    candidateId: scenario.candidateId,
    jobId: scenario.jobId,
    blueprintId: scenario.blueprintId,
    planId: scenario.planId,
    comparatorPolicyId: "exact-http-v1",
    runnerImageDigest: RUNNER_IMAGE,
    observations: scenario.vectors.map((vector) => observation(vector.id)),
    reportStagingId: scenario.stagingId,
    reportSha256: scenario.stagingSha,
    limitations: ["http client boundary only (DESIGN §10)"],
    ...overrides,
  };
}

function journal(action: string, decision: string): string[] {
  const rows = readAudit(writer, { after: 0, projectId, limit: 500 });
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  return rows.value
    .filter((entry) => entry.action === action && entry.decision === decision)
    .map((entry) => entry.reasonCode);
}

function recordedCount(candidateId: Id): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM verifications WHERE candidate_id = ?")
    .get(candidateId) as { n: number };
  return Number(row.n);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-verify-"));
  const lock = await acquireWorkerLock(root);
  if (!lock.ok) throw new Error(JSON.stringify(lock.error));
  heldLocks.push(lock.value);
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  db = opened.value.db;
  writer = new SqliteStorageWriter(db);
  store = new ArtifactStore(root);
  const planned = planMigrations(db);
  if (!planned.ok) throw new Error(JSON.stringify(planned.error));
  const applied = applyMigrations(db, planned.value);
  if (!applied.ok) throw new Error(JSON.stringify(applied.error));

  projectId = newId();
  const project = writer.transact((tx) => {
    tx.insertProject({
      id: projectId,
      name: "verify-suite",
      createdAt: nowInstant(),
      graphRevision: 1,
      inventoryRevision: 2,
      schemaVersion: 1,
    });
    return true;
  });
  if (!project.ok) throw new Error(JSON.stringify(project.error));

  // The facts port is unreachable on purpose: recording a verification reads
  // stored samples, never a capture again (§9: consume the evidence by reference).
  const facts = {
    readRecord(): Promise<never> {
      throw new Error("the verification gate never reads capture facts");
    },
  } as unknown as EvidenceFactsPort;
  const vectors = new VectorService({ storage: writer, artifacts: store, facts, limits: LIMITS });
  verifications = new VerificationService({ storage: writer, artifacts: store, vectors, limits: LIMITS });
});

afterAll(async () => {
  await Promise.all(heldLocks.map((lock) => lock.release()));
  await rm(root, { recursive: true, force: true });
  db.close();
});

describe("recording a verification (DESIGN §10)", () => {
  it("derives a PASS the caller was never allowed to state", async () => {
    const scenario = await seedScenario("pass");
    const committed = unwrap(await verifications.complete(projectId, evaluator, completionFor(scenario)));
    expect(committed.report.result).toBe("PASS");
    expect(committed.report.counts).toEqual({ total: 2, passed: 2, failed: 0, blocked: 0, skipped: 0 });
    expect(committed.report.identities.snapshotDigest).toBe(scenario.snapshotDigest);
    expect(committed.report.identities.blueprintDigest).toBe(scenario.blueprintDigest);
    expect(committed.report.identities.candidateDigest).toBe(scenario.candidateDigest);
    expect(committed.report.identities.planDigest).toBe(scenario.planDigest);
    expect(committed.report.identities.inventoryDigest).toBe(asDigest(hex("inventory-pass")));
    expect(committed.report.identities.runnerImageDigest).toBe(RUNNER_IMAGE);
    // Eight named identities, and not one more.
    expect(Object.keys(committed.report.identities).sort()).toEqual([
      "blueprintDigest",
      "candidateDigest",
      "comparatorDigest",
      "inventoryDigest",
      "planDigest",
      "runnerImageDigest",
      "snapshotDigest",
      "vectorSetDigest",
    ]);
    expect(journal("verification.complete", "allow")).toEqual(["verification-recorded"]);

    const viewed = unwrap(await verifications.read(projectId, inspector, committed.verificationId));
    expect(viewed.report.digest).toBe(committed.report.digest);
    expect(viewed.staleness).toEqual([]);
  });

  it("refuses a submission that tries to state its own verdict", async () => {
    const scenario = await seedScenario("forged");
    const forged = await failureOf(
      verifications.complete(projectId, evaluator, completionFor(scenario, { result: "PASS" })),
    );
    expect(forged.code).toBe("INVALID_INPUT");
    expect(forged.reason).toBe("completion-schema");
    expect(JSON.stringify(forged.details)).toContain("result");
    expect(recordedCount(scenario.candidateId)).toBe(0);
  });

  it("refuses every actor but the evaluator, before reading the payload", async () => {
    const scenario = await seedScenario("actors");
    const denied = await failureOf(verifications.complete(projectId, builder, { nonsense: true }));
    expect(denied.code).toBe("ACCESS_DENIED");
    expect(denied.reason).toBe("builder-may-not-record-a-verification");

    const inspectorDenied = await failureOf(
      verifications.complete(projectId, inspector, completionFor(scenario)),
    );
    expect(inspectorDenied.reason).toBe("only-the-evaluator-records-a-verification");
    expect(journal("verification.complete", "deny")).toContain("only-the-evaluator-records-a-verification");
    expect(recordedCount(scenario.candidateId)).toBe(0);
  });

  it("refuses a comparator that is not an installed named version", async () => {
    const scenario = await seedScenario("comparator");
    const denied = await failureOf(
      verifications.complete(
        projectId,
        evaluator,
        completionFor(scenario, { comparatorPolicyId: "ignore-volatile-v9" }),
      ),
    );
    expect(denied.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(denied.reason).toBe("comparator-not-installed");
  });

  it("refuses a transcript whose bytes are not what was hashed", async () => {
    const scenario = await seedScenario("transcript");
    const written = await store.writeStaging(
      projectId,
      TAMPERED_STAGING_ID,
      new TextEncoder().encode(JSON.stringify({ transcript: "tampered" })),
    );
    if (!written.ok) throw new Error(JSON.stringify(written.error));
    const denied = await failureOf(
      verifications.complete(
        projectId,
        evaluator,
        completionFor(scenario, { reportStagingId: TAMPERED_STAGING_ID }),
      ),
    );
    expect(denied.code).toBe("REA_CONTRACT_MISMATCH");
    expect(denied.reason).toBe("transcript-digest-mismatch");
  });

  it("refuses a completion naming a blueprint the candidate was not built against", async () => {
    const scenario = await seedScenario("wrong-blueprint");
    const denied = await failureOf(
      verifications.complete(projectId, evaluator, completionFor(scenario, { blueprintId: newId() })),
    );
    expect(denied.reason).toBe("candidate-blueprint-mismatch");
  });

  it("refuses an observation for a sample outside the frozen plan", async () => {
    const scenario = await seedScenario("outside-plan");
    const stranger = newId();
    const denied = await failureOf(
      verifications.complete(
        projectId,
        evaluator,
        completionFor(scenario, { observations: [observation(stranger)] }),
      ),
    );
    expect(denied.code).toBe("REA_CONTRACT_MISMATCH");
    expect(JSON.stringify(denied.details)).toContain(`observation-outside-plan:${stranger}`);
  });

  it("settles a missing oracle to skipped, which keeps the result below PASS", async () => {
    const scenario = await seedScenario("no-oracle", { unreviewedMain: true });
    const committed = unwrap(await verifications.complete(projectId, evaluator, completionFor(scenario)));
    expect(committed.report.result).toBe("UNKNOWN");
    // The unreviewed sample still occupies the plan's denominator (§10).
    expect(committed.report.counts.total).toBe(2);
    expect(committed.report.counts.skipped).toBe(1);
    expect(committed.report.counts.passed).toBe(1);
    const skipped = committed.report.outcomes.find((outcome) => outcome.state === "skipped");
    expect(skipped?.reason).toBe("no-reviewed-oracle");
  });

  it("refuses a plan that is not approved and writes nothing", async () => {
    const scenario = await seedScenario("draft-plan", { approvedPlan: false });
    const denied = await failureOf(verifications.complete(projectId, evaluator, completionFor(scenario)));
    expect(denied.code).toBe("BLUEPRINT_BLOCKED");
    expect(denied.reason).toBe("plan-not-approved");
    expect(journal("verification.complete", "deny")).toContain("plan-not-approved");
    expect(recordedCount(scenario.candidateId)).toBe(0);
  });

  it("hands the Builder categories only, never a sample id or a diff", async () => {
    const scenario = await seedScenario("builder-view");
    const committed = unwrap(await verifications.complete(projectId, evaluator, completionFor(scenario)));
    const summary = unwrap(await verifications.builderSummary(projectId, committed.verificationId));
    const text = JSON.stringify(summary);
    for (const vector of scenario.vectors) {
      expect(text).not.toContain(vector.id);
    }
    expect(text).not.toContain("safeDiff");
    expect(summary.categories.map((entry) => `${entry.state}:${String(entry.count)}`)).toEqual([
      "passed:2",
      "failed:0",
      "blocked:0",
      "skipped:0",
    ]);
    expect(summary.result).toBe("PASS");
  });

  it("refuses to read back a report whose body disagrees with its row", async () => {
    const scenario = await seedScenario("tampered-report");
    const committed = unwrap(await verifications.complete(projectId, evaluator, completionFor(scenario)));
    const stored = unwrap(await verifications.read(projectId, inspector, committed.verificationId));

    // A report body that is internally valid and correctly hashed, but bound to a
    // plan digest the row does not carry. The artifact store cannot tell this
    // apart, so the index row is the second witness (§5: an index is not a second
    // semantic source, but a disagreement between the two is a refusal).
    const tampered = {
      ...stored.report,
      identities: { ...stored.report.identities, planDigest: asDigest(hex("a-different-plan")) },
    };
    const tamperedArtifactId = await publishExact("report", JSON.stringify(tampered));
    const original = writer.transact((tx) => tx.getVerification(projectId, committed.verificationId));
    if (!original.ok) throw new Error(JSON.stringify(original.error));
    if (original.value === null) throw new Error("the verification row disappeared");
    const copy: VerificationRow = {
      ...original.value,
      id: newId(),
      reportArtifactId: tamperedArtifactId,
    };
    const repointed = writer.transact((tx) => {
      tx.insertVerification(copy);
      return true;
    });
    if (!repointed.ok) throw new Error(JSON.stringify(repointed.error));

    const denied = await failureOf(verifications.read(projectId, inspector, copy.id));
    expect(denied.code).toBe("REA_CONTRACT_MISMATCH");
    expect(denied.reason).toBe("report-row-disagreement");
  });

  it("refuses a plan that no longer exhausts its own inventory", async () => {
    const scenario = await seedScenario("non-exhaustive");
    // A sample lands in the same snapshot after the plan froze. The plan is now
    // silent about it, and silence is not an exclusion (§7.4: exclusions have to
    // be reviewed). The verification is refused instead of quietly borrowing a
    // smaller denominator.
    await seedVector({
      targetId: scenario.targetId,
      snapshotDigest: scenario.snapshotDigest,
      evidenceId: scenario.evidenceId,
      caseKey: "cart-unaccounted",
      visibility: "public",
      approved: true,
    });
    const denied = await failureOf(
      verifications.complete(projectId, evaluator, completionFor(scenario)),
    );
    expect(denied.code).toBe("BLUEPRINT_BLOCKED");
    expect(JSON.stringify(denied.details)).toContain("inventory-not-partitioned");
    expect(recordedCount(scenario.candidateId)).toBe(0);
    expect(journal("verification.complete", "deny")).toContain("inventory-not-partitioned");
  });

  it("keeps a failed sample's reason and diff inside the evaluator", async () => {
    const scenario = await seedScenario("failed-view");
    const [publicVector, holdoutVector] = scenario.vectors;
    if (publicVector === undefined || holdoutVector === undefined) {
      throw new Error("the scenario lost its vectors");
    }
    const secretExpected = "Bearer-credential-looking-value-8fj29d";
    const committed = unwrap(
      await verifications.complete(
        projectId,
        evaluator,
        completionFor(scenario, {
          observations: [
            observation(publicVector.id, {
              requestMatches: false,
              decodedMatches: false,
              safeDiff: { expected: secretExpected, got: "{}" },
            }),
            observation(holdoutVector.id),
          ],
        }),
      ),
    );
    expect(committed.report.result).toBe("FAIL");
    // The control plane keeps the diff: it is the evidence for the fix.
    const stored = unwrap(await verifications.read(projectId, inspector, committed.verificationId));
    expect(JSON.stringify(stored.report.outcomes)).toContain("comparison-mismatch");

    const summary = unwrap(await verifications.builderSummary(projectId, committed.verificationId));
    const text = JSON.stringify(summary);
    expect(text).not.toContain(secretExpected);
    expect(text).not.toContain("comparison-mismatch");
    expect(text).not.toContain(publicVector.id);
    expect(text).not.toContain(holdoutVector.id);
    expect(summary.categories.find((entry) => entry.state === "failed")?.count).toBe(1);
  });

  it("reports staleness from the rows that exist now without rewriting the report", async () => {
    const scenario = await seedScenario("stale");
    const committed = unwrap(await verifications.complete(projectId, evaluator, completionFor(scenario)));
    const storedBefore = unwrap(await verifications.read(projectId, inspector, committed.verificationId));

    // A later import adds a sample to the same snapshot. The frozen plan is not
    // rewritten and neither is this report; the vector set the run was compared
    // against is simply no longer what exists (§7.4, §10).
    await seedVector({
      targetId: scenario.targetId,
      snapshotDigest: scenario.snapshotDigest,
      evidenceId: scenario.evidenceId,
      caseKey: "cart-late-arrival",
      visibility: "public",
      approved: true,
    });

    const after = unwrap(await verifications.read(projectId, inspector, committed.verificationId));
    expect(after.report.digest).toBe(storedBefore.report.digest);
    expect(after.report.identities.vectorSetDigest).toBe(storedBefore.report.identities.vectorSetDigest);
    expect(after.staleness).toEqual(["identity-changed:vectorSetDigest"]);
    // The published row keeps the state it was recorded with: invalidation is
    // reported next to it, never written into it.
    const row = writer.transact((tx) => tx.getVerification(projectId, committed.verificationId));
    if (!row.ok) throw new Error(JSON.stringify(row.error));
    expect(row.value?.currentness).toBe("current");
    expect(row.value?.vectorSetDigest).toBe(storedBefore.report.identities.vectorSetDigest);
  });
});

describe("the outcome derivation itself (DESIGN §10)", () => {
  const vectorId = newId();
  const vectorDigestValue = asDigest(hex("vector-a"));

  it("never lets a nondeterministic comparison settle to passed", () => {
    const vector = {
      eligibility: "usable",
      review: { status: "approved", approvedDigest: vectorDigestValue },
      digest: vectorDigestValue,
      expectedOutcome: { kind: "return", value: {} },
      reasons: [],
    } as unknown as TestVector;
    const derived = deriveOutcomes(
      {
        observations: [
          {
            vectorId,
            requestObserved: true,
            requestMatches: true,
            decodedMatches: true,
            outcome: { kind: "return", value: {} },
            expectedOutcomeObserved: true,
            nondeterministic: true,
            safeDiff: null,
          },
        ],
      } as unknown as Parameters<typeof deriveOutcomes>[0],
      new Map([[vectorId, vector]]),
    );
    expect(derived.cases[0]?.state).toBe("skipped");
    expect(derived.cases[0]?.reason).toBe("nondeterministic-unmodelled");
    expect(hasReviewedOracle(vector)).toBe(true);
  });

  it("treats an unreviewed expected outcome as no oracle at all", () => {
    const unreviewed = {
      eligibility: "usable",
      digest: vectorDigestValue,
      expectedOutcome: { kind: "return", value: {} },
      review: { status: "draft", approvedDigest: null },
      reasons: [],
    } as unknown as TestVector;
    expect(hasReviewedOracle(unreviewed)).toBe(false);
  });

  it("keeps a blocked plan entry in the denominator and carries no diff", () => {
    const blocked = {
      eligibility: "blocked",
      digest: vectorDigestValue,
      expectedOutcome: { kind: "return", value: {} },
      review: { status: "approved", approvedDigest: vectorDigestValue },
      reasons: ["vector-response-body-redacted"],
    } as unknown as TestVector;
    const derived = deriveOutcomes(
      {
        observations: [
          {
            vectorId,
            requestObserved: false,
            requestMatches: false,
            decodedMatches: false,
            outcome: { kind: "return", value: {} },
            expectedOutcomeObserved: false,
            nondeterministic: false,
            safeDiff: { kind: "text", expected: "redacted" },
          },
        ],
      } as unknown as Parameters<typeof deriveOutcomes>[0],
      new Map([[vectorId, blocked]]),
    );
    expect(derived.cases).toHaveLength(1);
    expect(derived.cases[0]?.state).toBe("blocked");
    expect(derived.cases[0]?.safeDiff).toBeNull();
    expect(derived.defects).toEqual([]);
  });
});

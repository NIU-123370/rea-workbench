import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asDigest, canonicalJson } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Instant } from "../../packages/domain/identity.ts";
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
import { INSTALLED_COMPARATOR_POLICIES } from "../../packages/contracts/verification.ts";
import { readAudit } from "../../packages/application/audit.ts";
// The projection every job reader shares (§8 lines 277-278): what the completion wrote has to show up
// here, because this is the only shape a client is allowed to recover a verification id from.
import { projectJobRecord } from "../../packages/application/job-queue.ts";
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

function jobRow(id: Id, targetId: Id, kind: JobRow["kind"], state: JobRow["state"], input: JsonValue = {}): JobRow {
  const created = nowInstant();
  return {
    id,
    projectId,
    targetId,
    kind,
    state,
    cleanupState: "pending",
    inputJson: input,
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
    // The job row carries what `verification.request` actually writes into `input_json` - the
    // completion is bound to that request (§10), so a fixture with an empty input is not a
    // verification job this door could have queued.
    tx.insertJob(jobRow(jobId, targetId, "verify", "running", { candidateId, comparatorPolicyId: "exact-http-v1" }));
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

// Lifted out of the `request` describe so the completion cases and the request cases read the same
// rows with the same SQL: two copies of "what does a job row look like here" is two chances to
// disagree about which column proves the write happened.
// Shared by the completion cases and the claim cases: a job row that names a target out of thin air is
// refused by §5's foreign key before any gate gets to speak, so both need the scenario's own target.
function seedJob(scenario: Scenario, kind: JobRow["kind"], state: JobRow["state"], input: JsonValue): Id {
  const id = newId();
  const inserted = writer.transact((tx) => tx.insertJob(jobRow(id, scenario.targetId, kind, state, input)));
  if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
  return id;
}

// What `verification.request` really writes into `input_json` - the two fields the completion and the
// claim are bound to.
function verifyInputFor(scenario: Scenario): JsonValue {
  return { candidateId: scenario.candidateId, comparatorPolicyId: "exact-http-v1" };
}

function jobCount(): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n);
}

function verificationCount(): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM verifications").get() as { n: number }).n);
}

function jobFields(id: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error(`no job row ${id}`);
  return row;
}

function eventRowsFor(id: string): { type: string; payload_json: string }[] {
  return db
    .prepare("SELECT type, payload_json FROM events WHERE aggregate_id = ?")
    .all(id) as { type: string; payload_json: string }[];
}

function projectEventCount(): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?").get(projectId) as { n: number }).n);
}

function eventsFor(id: string): string[] {
  return eventRowsFor(id).map((event) => event.type);
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

  // The completion has to land on a job that exists, that asked for this work, and that may hold a
  // result (§11: 只有 running 能到 succeeded). Before these cases `jobId` was copied into three rows
  // while nothing looked it up, and the job an operator queued through §8 line 297 stayed `queued`
  // even after its verification was recorded - so §8 line 277's 「含持久 resultRef，可恢复构建/验证资源
  // ID」 was true only for builds.
  it("records the result onto the job that asked for it, in the same write as the report", async () => {
    const scenario = await seedScenario("job-bound");
    const committed = unwrap(await verifications.complete(projectId, evaluator, completionFor(scenario)));
    const row = jobFields(scenario.jobId);
    expect(row["state"]).toBe("succeeded");
    // Read back by value: the pointer is the verification this call just returned, which is the whole
    // reason a client can recover a verification id from the job page at all.
    expect(row["result_ref"]).toBe(committed.verificationId);
    // §11 keeps cleanup a separate state: taking a result does not claim the resources were cleaned.
    expect(row["cleanup_state"]).toBe("pending");
    const events = eventRowsFor(scenario.jobId);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("job.updated");
    expect(JSON.parse(String(events[0]?.payload_json))).toEqual({
      resourceIds: [scenario.jobId, committed.verificationId],
      state: "succeeded",
    });
    // The report's own event stays on the verification aggregate - one event per thing that changed.
    expect(eventsFor(committed.verificationId)).toEqual(["verification.completed"]);
  });

  it("refuses a completion whose job id is not a job in this project, and writes nothing", async () => {
    const scenario = await seedScenario("job-unknown");
    const reports = verificationCount();
    const jobs = jobCount();
    const failure = await failureOf(verifications.complete(projectId, evaluator, completionFor(scenario, { jobId: newId() })));
    expect(failure.code).toBe("NOT_FOUND");
    expect(failure.reason).toBe("verification-job-unknown");
    expect(verificationCount()).toBe(reports);
    expect(jobCount()).toBe(jobs);
    expect(recordedCount(scenario.candidateId)).toBe(0);
  });

  it("refuses to hang a verification on another kind of work, naming the kind", async () => {
    const scenario = await seedScenario("job-kind");
    const captureJob = seedJob(scenario, "capture", "running", {});
    const failure = await failureOf(verifications.complete(projectId, evaluator, completionFor(scenario, { jobId: captureJob })));
    expect(failure.code).toBe("INVALID_INPUT");
    expect(failure.reason).toBe("verification-job-kind-mismatch");
    expect(failure.details["jobKind"]).toBe("capture");
    expect(recordedCount(scenario.candidateId)).toBe(0);
    expect(jobFields(captureJob)["state"]).toBe("running");
  });

  it("names the field that differs when the completion answers a different request", async () => {
    const asked = await seedScenario("job-request-a");
    const other = await seedScenario("job-request-b");
    // A real verify job in the same project - but it was queued for another candidate. §10 has the
    // worker derive the bound identities from rows it owns, so this is not a free choice of pointer.
    const crossed = await failureOf(verifications.complete(projectId, evaluator, completionFor(asked, { jobId: other.jobId })));
    expect(crossed.reason).toBe("verification-job-request-mismatch");
    expect(crossed.details["fields"]).toEqual(["candidateId"]);

    // The comparator is the other half of the same request. An *installed* name still has to be the one
    // that was asked for, or the looser policy would be adjudicating a request made under the strict one.
    const looser = await failureOf(
      verifications.complete(projectId, evaluator, completionFor(asked, { comparatorPolicyId: "exact-http-normalized-v1" })),
    );
    expect(looser.reason).toBe("verification-job-request-mismatch");
    expect(looser.details["fields"]).toEqual(["comparatorPolicyId"]);
    expect(recordedCount(asked.candidateId)).toBe(0);
    expect(recordedCount(other.candidateId)).toBe(0);
  });

  it("refuses a verify job whose input this door never wrote, rather than reading it as no constraint", async () => {
    const scenario = await seedScenario("job-blank-input");
    const handWritten = seedJob(scenario, "verify", "running", {});
    const failure = await failureOf(verifications.complete(projectId, evaluator, completionFor(scenario, { jobId: handWritten })));
    expect(failure.reason).toBe("verification-job-request-mismatch");
    expect((failure.details["fields"] as string[]).slice().sort()).toEqual(["candidateId", "comparatorPolicyId"]);
    expect(recordedCount(scenario.candidateId)).toBe(0);
  });

  it("will not resurrect a terminal job, and says which state it found (§11)", async () => {
    const scenario = await seedScenario("job-terminal");
    const cancelled = seedJob(scenario, "verify", "cancelled", verifyInputFor(scenario));
    const failure = await failureOf(verifications.complete(projectId, evaluator, completionFor(scenario, { jobId: cancelled })));
    expect(failure.code).toBe("REVISION_CONFLICT");
    expect(failure.reason).toBe("verification-job-terminal");
    expect(failure.details["jobState"]).toBe("cancelled");
    expect(recordedCount(scenario.candidateId)).toBe(0);
    // The refusal did not write over the row it was refusing.
    expect(jobFields(cancelled)["state"]).toBe("cancelled");
    expect(jobFields(cancelled)["result_ref"]).toBeNull();
  });

  it("takes a queued job through running to succeeded in one write (the build door's precedent)", async () => {
    const scenario = await seedScenario("job-queued");
    const queued = seedJob(scenario, "verify", "queued", verifyInputFor(scenario));
    const committed = unwrap(await verifications.complete(projectId, evaluator, completionFor(scenario, { jobId: queued })));
    // §11's diagram has no queued→succeeded edge, so the row is moved through running first by the same
    // owner (`transition`) the build door uses - `queued` is not a state that holds a result.
    expect(jobFields(queued)["state"]).toBe("succeeded");
    expect(jobFields(queued)["result_ref"]).toBe(committed.verificationId);
  });

  it("refuses a second result on a job that already carries one", async () => {
    const scenario = await seedScenario("job-twice");
    const first = unwrap(await verifications.complete(projectId, evaluator, completionFor(scenario)));
    const failure = await failureOf(verifications.complete(projectId, evaluator, completionFor(scenario)));
    expect(failure.code).toBe("REVISION_CONFLICT");
    expect(failure.reason).toBe("verification-job-already-completed");
    expect(recordedCount(scenario.candidateId)).toBe(1);
    expect(jobFields(scenario.jobId)["result_ref"]).toBe(first.verificationId);
    expect(eventRowsFor(scenario.jobId).filter((event) => event.type === "job.updated").length).toBe(1);
  });

  it("reaches the client through the projection the job page reads (§8 line 277)", async () => {
    const scenario = await seedScenario("job-projection");
    const committed = unwrap(await verifications.complete(projectId, evaluator, completionFor(scenario)));
    const looked = writer.transact((tx) => {
      const job = tx.getJob(projectId, scenario.jobId);
      return job === null ? null : projectJobRecord(job, tx.listLeasesForJobs(projectId, [scenario.jobId]));
    });
    if (!looked.ok) throw new Error(JSON.stringify(looked.error));
    const record = looked.value;
    if (record === null) throw new Error("the job row vanished");
    // Not the raw column: the same object `GET /projects/:p/jobs`, `GET .../jobs/:j` and the
    // `job.updated` frame are all built from, so 「含持久 resultRef，可恢复…验证资源 ID」 is read here
    // in the shape a browser would actually get.
    expect(record).toMatchObject({ kind: "verify", state: "succeeded", resultRef: committed.verificationId });
    expect(record.error).toBeNull();
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


// §8 line 297: asking for a verification. The rule this block keeps is that asking creates
// *work*, never a verdict - one `verify` job in `queued`, no `verifications` row anywhere near
// it - and that the request itself is what the idempotency key names, so a key cannot be
// re-pointed at a different candidate after the fact.
describe("asking for a verification (DESIGN §8 line 297)", async () => {
  const requestFor = (scenario: Scenario, overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({
    candidateId: scenario.candidateId,
    comparatorPolicyId: "exact-http-v1",
    ...overrides,
  });

  it("queues the work and writes no verdict", async () => {
    const scenario = await seedScenario("request-queued");
    const jobs = jobCount();
    const reports = verificationCount();
    const record = unwrap(verifications.request(projectId, inspector, requestFor(scenario), "key-queued"));
    expect(record).toMatchObject({
      kind: "verify",
      state: "queued",
      cleanupState: "pending",
      resultRef: null,
      error: null,
      deadlineAt: null,
    });
    expect(jobCount()).toBe(jobs + 1);
    // §10: a report exists only once the trusted evaluator answers. Nothing a request can say
    // puts a row in `verifications`, and this is the test that would notice if it could.
    expect(verificationCount()).toBe(reports);
    expect(String(jobFields(record.id)["idempotency_key"])).toBe("key-queued");
    expect(eventsFor(record.id)).toEqual(["job.updated"]);
    expect(journal("verification.request", "allow")).toContain("verify-job-queued");
  });

  it("carries the deadline the operator named into the job", async () => {
    const scenario = await seedScenario("request-deadline");
    const deadlineAt = new Date(Date.now() + 600_000).toISOString();
    const record = unwrap(verifications.request(projectId, inspector, requestFor(scenario, { deadlineAt }), "key-deadline"));
    expect(record.deadlineAt).toBe(deadlineAt);
    expect(String(jobFields(record.id)["deadline_at"])).toBe(deadlineAt);
  });

  it("refuses a role that is not the control plane, before looking anything up", async () => {
    const jobs = jobCount();
    // A candidate that does not exist would answer NOT_FOUND, so naming one here proves the role
    // test runs first: an untrusted kind learns nothing about what is in the project.
    const body: Record<string, JsonValue> = { candidateId: newId(), comparatorPolicyId: "exact-http-v1" };
    for (const actor of [builder, evaluator]) {
      const failure = await failureOf(verifications.request(projectId, actor, body, `key-role-${actor.actorKind}`));
      expect(failure.code).toBe("ACCESS_DENIED");
      expect(failure.reason).toBe("role-may-not-request-verification");
    }
    expect(jobCount()).toBe(jobs);
    expect(journal("verification.request", "deny")).toContain("role-may-not-request-verification");
  });

  it("refuses a comparator this build does not install", async () => {
    const scenario = await seedScenario("request-comparator");
    const jobs = jobCount();
    const failure = await failureOf(
      verifications.request(projectId, inspector, requestFor(scenario, { comparatorPolicyId: "exact-http-v2" }), "key-comparator"),
    );
    expect(failure.code).toBe("INVALID_INPUT");
    expect(failure.reason).toBe("comparator-policy-not-installed");
    expect(failure.details["declaredCount"]).toBe(INSTALLED_COMPARATOR_POLICIES.length);
    expect(jobCount()).toBe(jobs);
  });

  it("refuses a candidate the project does not have and commits nothing", async () => {
    const jobs = jobCount();
    const failure = await failureOf(
      verifications.request(projectId, inspector, { candidateId: newId(), comparatorPolicyId: "exact-http-v1" }, "key-unknown"),
    );
    expect(failure.code).toBe("NOT_FOUND");
    expect(failure.reason).toBe("candidate-unknown");
    expect(jobCount()).toBe(jobs);
    expect(journal("verification.request", "deny")).toContain("candidate-unknown");
  });

  it("replays the job a key already queued instead of queueing a second one", async () => {
    const scenario = await seedScenario("request-replay");
    const first = unwrap(verifications.request(projectId, inspector, requestFor(scenario), "key-replay"));
    const jobs = jobCount();
    const second = unwrap(verifications.request(projectId, inspector, requestFor(scenario), "key-replay"));
    expect(second.id).toBe(first.id);
    expect(jobCount()).toBe(jobs);
    // A replay is not a state change, so the stream carries the queue event exactly once.
    expect(eventsFor(first.id)).toHaveLength(1);
  });

  it("refuses a key that already carries a different request", async () => {
    const first = await seedScenario("request-diverge-a");
    const second = await seedScenario("request-diverge-b");
    const queued = unwrap(verifications.request(projectId, inspector, requestFor(first), "key-diverge"));
    const digest = String(jobFields(queued.id)["request_digest"]);
    const failure = await failureOf(
      verifications.request(projectId, inspector, requestFor(second), "key-diverge"),
    );
    expect(failure.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(failure.reason).toBe("idempotency-key-reused");
    // The refused call wrote nothing, so the job the key already owns is still what it was.
    expect(String(jobFields(queued.id)["request_digest"])).toBe(digest);
    expect(String(jobFields(queued.id)["state"])).toBe("queued");
    // Two candidates are two requests even under different keys: the digest is of the request,
    // not of the key it arrived with.
    const other = unwrap(verifications.request(projectId, inspector, requestFor(second), "key-diverge-other"));
    expect(String(jobFields(other.id)["request_digest"])).not.toBe(digest);
  });

  it("refuses a body that names anything §8 does not", async () => {
    const scenario = await seedScenario("request-strict");
    const jobs = jobCount();
    const failure = await failureOf(
      verifications.request(projectId, inspector, requestFor(scenario, { comparatorCode: "return a === b" }), "key-strict"),
    );
    expect(failure.code).toBe("INVALID_INPUT");
    expect(failure.reason).toBe("verification-request");
    expect(JSON.stringify(failure.details)).toContain("comparatorCode");
    expect(jobCount()).toBe(jobs);
  });
});

// §10's claim door: who may start a verify job, and what a start is allowed to say. The completion
// (#95) made a result bind to its job; this is the other end of §11's path - `queued → running` - and
// in a build that ships neither a container runner nor an evaluator process, it is the only way a
// `verify` row ever leaves `queued`.
describe("claiming a verification job (DESIGN §10, §11, issue #75)", () => {
  function queuedVerifyJob(scenario: Scenario, deadline: Instant | null = null): Id {
    const id = newId();
    const row = { ...jobRow(id, scenario.targetId, "verify", "queued", verifyInputFor(scenario)) };
    if (deadline !== null) row.deadlineAt = deadline;
    const created = writer.transact((tx) => tx.insertJob(row));
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    return id;
  }

  it("starts the next queued job and names the rows it is bound to - without stating a result", async () => {
    const scenario = await seedScenario("claim-start");
    const jobId = queuedVerifyJob(scenario);
    const records = verificationCount();

    const claimed = unwrap(verifications.claim(projectId, evaluator, { candidateId: scenario.candidateId }));
    expect(claimed.state).toBe("claimed");
    if (claimed.state !== "claimed") return;
    expect(claimed.job.id).toBe(jobId);
    // The row is what a start looks like: running, no result, cleanup untouched (§11 keeps them apart).
    expect(claimed.job.state).toBe("running");
    expect(claimed.job.resultRef).toBeNull();
    expect(jobFields(jobId)["state"]).toBe("running");
    expect(jobFields(jobId)["result_ref"]).toBeNull();
    expect(jobFields(jobId)["cleanup_state"]).toBe("pending");

    // Every field read back by value from the rows the worker owns, so "here is your work" means this
    // candidate, this frozen blueprint, this plan, this snapshot - not a shape that merely fits.
    expect(claimed.work).toEqual({
      candidateId: scenario.candidateId,
      candidateDigest: scenario.candidateDigest,
      blueprintId: scenario.blueprintId,
      planId: scenario.planId,
      targetId: scenario.targetId,
      snapshotDigest: scenario.snapshotDigest,
      comparatorPolicyId: "exact-http-v1",
    });

    const events = eventRowsFor(jobId);
    expect(events.map((event) => event.type)).toEqual(["job.updated"]);
    expect(JSON.parse(String(events[0]?.payload_json))).toEqual({ resourceIds: [jobId], state: "running" });
    // Newest-entry and delta, not emptiness: every test in this file shares one project, and the audit
    // trail is per project, so "no deny wrote anything" is what is provable here - not "none ever did".
    expect(journal("verification.claim", "allow").at(-1)).toBe("verify-job-running");
    expect(journal("verification.claim", "deny")).toEqual([]);
    // And the answer crosses the socket as the contract says it may: no field in this shape can carry
    // an outcome, so a claim cannot report a PASS even by accident.
    expect(JSON.stringify(claimed)).not.toContain("PASS");
    expect(verificationCount()).toBe(records);
  });

  it("an empty queue is an answer that writes nothing", async () => {
    const scenario = await seedScenario("claim-idle");
    const jobs = jobCount();
    const events = projectEventCount();
    // The journal is per project and other claims in this file have already written to it, so what an
    // idle answer must not do is add to it - measured as a delta, not as emptiness.
    const allowed = journal("verification.claim", "allow").length;
    const denied = journal("verification.claim", "deny").length;

    const idle = unwrap(verifications.claim(projectId, evaluator, { candidateId: scenario.candidateId }));
    expect(idle).toEqual({ state: "idle" });
    expect(jobCount()).toBe(jobs);
    // The whole project's outbox, not one aggregate's: an empty answer must not write a frame about
    // somebody else's job either, and a per-row count could not see that.
    expect(projectEventCount()).toBe(events);
    // A poll that found nothing decides nothing about anyone's permission, so §12.2's allow/deny journal
    // does not move: an evaluator polling every second must not be able to fill the audit trail.
    expect(journal("verification.claim", "allow").length).toBe(allowed);
    expect(journal("verification.claim", "deny").length).toBe(denied);
  });

  it("keeps every other role out of the queue, before looking at it", async () => {
    const scenario = await seedScenario("claim-roles");
    const jobId = queuedVerifyJob(scenario);

    const asBuilder = await failureOf(verifications.claim(projectId, builder, {}));
    expect(asBuilder.code).toBe("ACCESS_DENIED");
    expect(asBuilder.reason).toBe("builder-may-not-claim-a-verification");

    // The control plane asked for this work; it does not run it (§7.3's split between requesting and
    // comparing), so an inspector reaching the name is refused for the role, not for the body.
    const asInspector = await failureOf(verifications.claim(projectId, inspector, { candidateId: scenario.candidateId }));
    expect(asInspector.reason).toBe("only-the-evaluator-claims-a-verification");
    expect(jobFields(jobId)["state"]).toBe("queued");
  });

  it("refuses a body that names anything §10 does not, by name", async () => {
    const scenario = await seedScenario("claim-shape");
    queuedVerifyJob(scenario);
    const failure = await failureOf(verifications.claim(projectId, evaluator, { candidateId: scenario.candidateId, maxAttempts: 3 }));
    expect(failure.code).toBe("INVALID_INPUT");
    expect(failure.reason).toBe("verification-claim");
    expect(JSON.stringify(failure.details)).toContain("maxAttempts");
    // The extra key is refused *and* nothing started: the queue is unchanged.
    expect(jobFields(scenario.jobId)["state"]).toBe("running");
    expect(jobCount()).toBe(jobCount());
  });

  it("does not hand the same running job out twice", async () => {
    const scenario = await seedScenario("claim-once");
    const jobId = queuedVerifyJob(scenario);
    const first = unwrap(verifications.claim(projectId, evaluator, { candidateId: scenario.candidateId }));
    expect(first.state).toBe("claimed");

    const second = unwrap(verifications.claim(projectId, evaluator, { candidateId: scenario.candidateId }));
    // `running` is not claimable, and the scan asks only for `queued` - so the second evaluator gets
    // "nothing for you" rather than a job that is already being worked.
    expect(second).toEqual({ state: "idle" });
    expect(jobFields(jobId)["state"]).toBe("running");
    expect(eventRowsFor(jobId).filter((event) => event.type === "job.updated").length).toBe(1);
  });

  it("narrows the queue to one candidate when the evaluator asks that way", async () => {
    const wanted = await seedScenario("claim-narrow-a");
    const other = await seedScenario("claim-narrow-b");
    const wantedJob = queuedVerifyJob(wanted);
    const otherJob = queuedVerifyJob(other);

    const claimed = unwrap(await verifications.claim(projectId, evaluator, { candidateId: wanted.candidateId }));
    expect(claimed.state).toBe("claimed");
    if (claimed.state !== "claimed") return;
    expect(claimed.job.id).toBe(wantedJob);
    expect(jobFields(otherJob)["state"]).toBe("queued");

    // And the row it picked is the one whose own request named that candidate, not a row that happens
    // to be first in the scan.
    const next = unwrap(await verifications.claim(projectId, evaluator, { candidateId: other.candidateId }));
    expect(next.state).toBe("claimed");
    if (next.state !== "claimed") return;
    expect(next.job.id).toBe(otherJob);
  });

  it("fails a job whose deadline has passed instead of starting it, and keeps that failure", async () => {
    const scenario = await seedScenario("claim-deadline");
    const jobId = queuedVerifyJob(scenario, "2020-01-01T00:00:00.000Z" as Instant);

    const answer = unwrap(verifications.claim(projectId, evaluator, { candidateId: scenario.candidateId }));
    expect(answer.state).toBe("failed");
    if (answer.state !== "failed") return;
    expect(answer.reasonCode).toBe("deadline-expired");
    expect(answer.job.state).toBe("failed");
    // §11's 保存明确错误: the row says what stopped it, and no result pointer rode along.
    expect(String(jobFields(jobId)["error_json"])).toContain("deadline-expired");
    expect(jobFields(jobId)["result_ref"]).toBeNull();
    const events = eventRowsFor(jobId);
    expect(events.map((event) => event.type)).toEqual(["job.updated"]);
    expect(JSON.parse(String(events[0]?.payload_json))).toEqual({ resourceIds: [jobId], state: "failed", reasonCode: "deadline-expired" });
    expect(journal("verification.claim", "allow")).toContain("verify-job-not-started");

    // It is not offered again either: a terminal row is not work.
    const after = unwrap(verifications.claim(projectId, evaluator, { candidateId: scenario.candidateId }));
    expect(after).toEqual({ state: "idle" });
  });

  it("refuses to start a job whose binding no longer resolves, and leaves the row queued", async () => {
    const scenario = await seedScenario("claim-binding-gone");
    // A valid id of a candidate this project does not have: the row names work that cannot be run.
    const bogus = newId();
    const jobId = queuedVerifyJob({ ...scenario, candidateId: bogus } as Scenario);
    const allowed = journal("verification.claim", "allow").length;

    const failure = await failureOf(verifications.claim(projectId, evaluator, { candidateId: bogus }));
    expect(failure.code).toBe("NOT_FOUND");
    expect(failure.reason).toBe("verification-claim-candidate-unknown");
    // The transition is rolled back with the refusal - a `running` job the evaluator cannot act on would
    // be a claim that lied about having started work.
    expect(jobFields(jobId)["state"]).toBe("queued");
    expect(eventRowsFor(jobId)).toEqual([]);
    // Nothing was started, so no allow was written - measured as a delta because the project's trail
    // already holds allows from the cases above.
    expect(journal("verification.claim", "allow").length).toBe(allowed);
    expect(journal("verification.claim", "deny")).toContain("verification-claim-candidate-unknown");
  });
});

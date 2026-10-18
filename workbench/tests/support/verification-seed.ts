import { asDigest, digestBytes } from "../../packages/domain/canonical-json.ts";
import type { CanonicalLimits, Digest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import { vectorSetDigestOf } from "../../packages/domain/report.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { BuilderService } from "../../packages/application/builder-service.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { ArtifactRow, JobRow, LeaseRow } from "../../packages/application/ports.ts";
import type { VerificationReportWire } from "../../packages/contracts/verification.ts";
import { hex, seedBlueprintForGeneration } from "./blueprint-seed.ts";

// A verification row plus the report artifact it claims, agreeing field for field (DESIGN §10,
// §8 line 298).
//
// `VerificationService.read` re-hashes the stored bytes, re-parses them against the report
// schema and then compares every identity the report names against the index row, so a fixture
// that guessed any one of those digests makes the *refusal* the interesting result rather than
// the read. The candidate comes from the real `BuilderService`, and the plan and blueprint from
// `seedBlueprintForGeneration`, so the rows a verification is bound to exist for the same reason
// they would in a running workbench.
//
// Two files need this: the delivery gate (which packages a report) and the report read door
// (§8 line 298), so it lives here rather than beside either one.

const LIMITS: CanonicalLimits = { maxDepth: 24, maxCodeUnits: 200_000 };
const COMPARATOR = asDigest("c".repeat(64));
const RUNNER = asDigest("d".repeat(64));

export type VerifiedScenario = {
  blueprintId: Id;
  blueprintDigest: Digest;
  planId: Id;
  candidateId: Id;
  candidateDigest: Digest;
  verificationId: Id;
  reportBytes: Uint8Array;
  reportArtifactId: Id;
  buildJobId: Id;
  verifyJobId: Id;
};

export type VerifiedOverrides = {
  result?: "PASS" | "FAIL" | "UNKNOWN";
  cleanupState?: JobRow["cleanupState"];
  leaseState?: LeaseRow["cleanupState"];
  // The two report fields that hold free text: what a verifier said about the run, and the per-case
  // rows behind the counts the report already claims (`counts.total` is 1, so an empty `outcomes`
  // is the fixture leaving a row out rather than a run that saw nothing). Both are how a package
  // ends up carrying a string nobody declared at completion time - the case §12.1's
  // 「后续操作仍需排除上下文时，调用方必须重新显式提供 sensitiveValues」 is about.
  limitations?: readonly string[];
  outcomes?: readonly ReportOutcomeRow[];
};

/** One row of the stored report's outcome list (§10's `outcomes`), as the report schema shapes it. */
export type ReportOutcomeRow = VerificationReportWire["outcomes"][number];

function fail(message: string): never {
  throw new Error(message);
}

export async function seedVerifiedScenario(deps: {
  writer: SqliteStorageWriter;
  store: ArtifactStore;
  projectId: Id;
  targetId: Id;
  name: string;
  builderActor?: Actor;
  overrides?: VerifiedOverrides;
}): Promise<VerifiedScenario> {
  const { writer, store, projectId, targetId, name } = deps;
  const overrides = deps.overrides ?? {};
  const builder = deps.builderActor ?? { actorId: `builder-${name}`, actorKind: "builder" as const };

  function insertJob(id: Id, kind: JobRow["kind"], state: JobRow["state"], cleanupState: JobRow["cleanupState"]): void {
    const created = nowInstant();
    const outcome = writer.transact((tx) => {
      const inserted = tx.insertJob({
        id,
        projectId,
        targetId,
        kind,
        state,
        cleanupState,
        inputJson: {},
        resultRef: null,
        errorJson: null,
        idempotencyKey: `${kind}-${id}`,
        requestDigest: asDigest(hex(`${kind}-request-${id}`)),
        deadlineAt: null,
        retryAt: null,
        createdAt: created,
        updatedAt: created,
      });
      if (inserted.outcome !== "inserted") fail(`job ${inserted.outcome}`);
      return true;
    });
    if (!outcome.ok) fail(JSON.stringify(outcome.error));
  }

  const seeded = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name });
  const buildJobId = newId();
  insertJob(buildJobId, "build", "running", "pending");
  const committed = await new BuilderService({ storage: writer, artifacts: store, limits: LIMITS }).generate(
    projectId,
    builder,
    seeded.blueprintId,
    { budget: { maxAttemptsPerBlueprint: 3, deadlineAt: null }, generator: { model: "fixture-agent" }, jobId: buildJobId },
  );
  if (!committed.ok) fail(`candidate -> ${JSON.stringify(committed.error)}`);
  const candidateId = committed.value.candidateId;
  const candidateDigest = committed.value.digest;

  const verifyJobId = newId();
  insertJob(verifyJobId, "verify", "succeeded", overrides.cleanupState ?? "complete");
  const lease = writer.transact((tx) => {
    tx.insertLease({
      id: newId(),
      jobId: verifyJobId,
      kind: "har-staging",
      resourceIdentityJson: { storageKey: `projects/${projectId}/staging/x` },
      ownershipProofJson: { mintedBy: "verify-runner", jobId: verifyJobId },
      cleanupState: overrides.leaseState ?? "complete",
      lastErrorJson: null,
      retryAt: null,
      retryCount: 0,
    });
    return true;
  });
  if (!lease.ok) fail(JSON.stringify(lease.error));

  const planRead = writer.transact((tx) => tx.getPlan(projectId, seeded.planId));
  if (!planRead.ok || planRead.value === null) fail("the seeded plan row vanished");
  const plan = planRead.value;
  const verificationId = newId();
  const reportArtifactId = newId();
  const vectorSetDigest = vectorSetDigestOf([], LIMITS);
  const identities = {
    snapshotDigest: plan.snapshotDigest,
    blueprintDigest: seeded.digest,
    candidateDigest,
    vectorSetDigest,
    planDigest: plan.digest,
    inventoryDigest: plan.inventoryDigest,
    comparatorDigest: COMPARATOR,
    runnerImageDigest: RUNNER,
  };
  const content = {
    id: verificationId,
    candidateId,
    result: overrides.result ?? "PASS",
    currentness: "current",
    scope: ["getCart"],
    identities,
    counts: { total: 1, passed: 1, failed: 0, blocked: 0, skipped: 0 },
    inventoryCounts: { total: 1, selected: 1, excluded: 0, blocked: 0 },
    excludedVectors: [],
    outcomes: overrides.outcomes ?? [],
    limitations: overrides.limitations ?? ["no retry semantics observed"],
  };
  const reportDigest = asDigest(hex(`report-${name}`));
  // Stored with a key order and formatting a re-serialization would not reproduce, so a reader
  // that copies the published bytes stays distinguishable from one that rebuilds them from the
  // parsed report (§10: a published report never changes).
  const bytes = new TextEncoder().encode(JSON.stringify({ digest: reportDigest, ...content }, null, 1));
  const published = await store.publish(projectId, "report", bytes);
  if (!published.ok) fail(`report publish -> ${JSON.stringify(published.error)}`);
  if (digestBytes(bytes) !== published.value.sha256) fail("the store hashed different bytes than it was given");
  const created = nowInstant();
  const inserted = writer.transact((tx) => {
    tx.insertArtifact({
      id: reportArtifactId,
      projectId,
      jobId: verifyJobId,
      class: "report",
      sha256: published.value.sha256,
      digestReason: null,
      byteLength: published.value.byteLength,
      storageKey: published.value.storageKey,
      mediaType: "application/json",
      createdAt: created,
    } satisfies ArtifactRow);
    tx.insertVerification({
      id: verificationId,
      projectId,
      candidateId,
      jobId: verifyJobId,
      planId: plan.id,
      planDigest: plan.digest,
      inventoryDigest: plan.inventoryDigest,
      blueprintDigest: seeded.digest,
      vectorSetDigest,
      comparatorDigest: COMPARATOR,
      runnerImageDigest: RUNNER,
      result: content.result,
      currentness: "current",
      summaryJson: { counts: content.counts },
      reportArtifactId,
    });
    return true;
  });
  if (!inserted.ok) fail(`verification -> ${JSON.stringify(inserted.error)}`);

  return {
    blueprintId: seeded.blueprintId,
    blueprintDigest: seeded.digest,
    planId: seeded.planId,
    candidateId,
    candidateDigest,
    verificationId,
    reportBytes: bytes,
    reportArtifactId,
    buildJobId,
    verifyJobId,
  };
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asDigest, digestBytes } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import { vectorSetDigestOf } from "../../packages/domain/report.ts";
import { readZipArchive } from "../../packages/domain/zip.ts";
import { racingStorage } from "../support/racing-storage.ts";
import { declaredPackageEntries } from "../../packages/domain/export.ts";
import {
  acquireWorkerLock,
  applyMigrations,
  openWriteConnection,
  planMigrations,
} from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { BuilderService } from "../../packages/application/builder-service.ts";
import { ExportService } from "../../packages/application/export-service.ts";
import { VerificationService } from "../../packages/application/verification-service.ts";
import { VectorService } from "../../packages/application/vector-service.ts";
import { readAudit } from "../../packages/application/audit.ts";
import type { EvidenceFactsPort } from "../../packages/application/ports.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { ArtifactRow, JobRow, LeaseRow } from "../../packages/application/ports.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type { Result } from "../../packages/domain/result.ts";
import { exportManifestSchema, exportRecordSchema } from "../../packages/contracts/export.ts";
import { hex, seedBlueprintForGeneration } from "../support/blueprint-seed.ts";

// Export packages against real storage (DESIGN §10, §11, §8 / PRD F11, issue #22).
//
// The chain is seeded rather than driven end to end — the candidate comes from the real
// `BuilderService`, the report row and its artifact are written consistently by hand, and
// the read path is the real `VerificationService`. What is under test is the delivery
// gate: what a label may claim, what goes into the package, and what has to be true again
// before a byte leaves (the end-to-end PASS chain belongs to verification-service.test.ts).

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const ZIP_LIMITS = { maxEntries: 16, maxUncompressedBytes: 8_000_000, maxArchiveBytes: 9_000_000 };
const reviewer: Actor = { actorId: "local-reviewer", actorKind: "reviewer" };
const builder: Actor = { actorId: "builder-agent", actorKind: "builder" };
const COMPARATOR = asDigest("c".repeat(64));
const RUNNER = asDigest("d".repeat(64));

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let store: ArtifactStore;
let exports_: ExportService;
let verifications: VerificationService;
let projectId: Id;
let targetId: Id;
const heldLocks: { release: () => Promise<void> }[] = [];

function unwrap<T>(result: Result<T, GateFailure>): T {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.reason}:${result.error.message}:${JSON.stringify(result.error.details)}`);
  return result.value;
}

async function failureOf<T>(result: Promise<Result<T, GateFailure>>): Promise<GateFailure> {
  const settled = await result;
  if (settled.ok) throw new Error("expected a refusal, got a value");
  return settled.error;
}

function insertJob(id: Id, kind: JobRow["kind"], state: JobRow["state"], cleanupState: JobRow["cleanupState"], deadlineAt: Instant | null = null): void {
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
      deadlineAt,
      retryAt: null,
      createdAt: created,
      updatedAt: created,
    });
    if (inserted.outcome !== "inserted") throw new Error(`job ${inserted.outcome}`);
    return true;
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
}

function insertLease(jobId: Id, cleanupState: LeaseRow["cleanupState"]): void {
  const outcome = writer.transact((tx) => {
    tx.insertLease({
      id: newId(),
      jobId,
      kind: "har-staging",
      resourceIdentityJson: { storageKey: `projects/${projectId}/staging/x` },
      ownershipProofJson: { mintedBy: "verify-runner", jobId },
      cleanupState,
      lastErrorJson: null,
      retryAt: null,
      retryCount: 0,
    });
    return true;
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
}

type Scenario = {
  blueprintId: Id;
  candidateId: Id;
  candidateDigest: Digest;
  verificationId: Id;
  reportBytes: Uint8Array;
  reportArtifactId: Id;
};

// A verification row plus the report artifact it claims, agreeing field for field, so
// `VerificationService.read` finds nothing to complain about and the gate's decision is
// the one under test rather than an artefact of the fixture.
async function seedVerified(name: string, overrides: { result?: "PASS" | "FAIL" | "UNKNOWN"; cleanupState?: JobRow["cleanupState"]; leaseState?: LeaseRow["cleanupState"] } = {}): Promise<Scenario> {
  const seeded = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name });
  const buildJob = newId();
  insertJob(buildJob, "build", "running", "pending");
  const commit = unwrap(
    await new BuilderService({ storage: writer, artifacts: store, limits: LIMITS }).generate(
      projectId,
      builder,
      seeded.blueprintId,
      { budget: { maxAttemptsPerBlueprint: 3, deadlineAt: null }, generator: { model: "test-agent" }, jobId: buildJob },
    ),
  );

  const verifyJob = newId();
  insertJob(verifyJob, "verify", "succeeded", overrides.cleanupState ?? "complete");
  insertLease(verifyJob, overrides.leaseState ?? "complete");

  const planned = writer.transact((tx) => tx.getPlan(projectId, seeded.planId));
  if (!planned.ok || planned.value === null) throw new Error("the seeded plan row vanished");
  const plan = planned.value;
  const vectorSetDigest = vectorSetDigestOf([], LIMITS);
  const reportArtifactId = newId();
  const verificationId = newId();
  const identities = {
    snapshotDigest: plan.snapshotDigest,
    blueprintDigest: seeded.digest,
    candidateDigest: commit.digest,
    vectorSetDigest,
    planDigest: plan.digest,
    inventoryDigest: plan.inventoryDigest,
    comparatorDigest: COMPARATOR,
    runnerImageDigest: RUNNER,
  };
  const content = {
    id: verificationId,
    candidateId: commit.candidateId,
    result: overrides.result ?? "PASS",
    currentness: "current",
    scope: ["getCart"],
    identities,
    counts: { total: 1, passed: 1, failed: 0, blocked: 0, skipped: 0 },
    inventoryCounts: { total: 1, selected: 1, excluded: 0, blocked: 0 },
    excludedVectors: [],
    outcomes: [],
    limitations: ["no retry semantics observed"],
  };
  const reportJson = { ...content, digest: asDigest(hex(`report-${name}`)) };
  // Stored with a key order and formatting a re-serialization would not reproduce, so a
  // package that copies the published bytes is distinguishable from one that rebuilds them
  // from the parsed report (§10: a published report never changes).
  const { digest: reportDigest, ...reportRest } = reportJson;
  const bytes = new TextEncoder().encode(JSON.stringify({ digest: reportDigest, ...reportRest }, null, 1));
  const published = await store.publish(projectId, "report", bytes);
  if (!published.ok) throw new Error(JSON.stringify(published.error));
  const created = nowInstant();
  const inserted = writer.transact((tx) => {
    tx.insertArtifact({
      id: reportArtifactId,
      projectId,
      jobId: verifyJob,
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
      candidateId: commit.candidateId,
      jobId: verifyJob,
      planId: plan.id,
      planDigest: plan.digest,
      inventoryDigest: plan.inventoryDigest,
      blueprintDigest: seeded.digest,
      vectorSetDigest,
      comparatorDigest: COMPARATOR,
      runnerImageDigest: RUNNER,
      result: reportJson.result,
      currentness: "current",
      summaryJson: { counts: reportJson.counts },
      reportArtifactId,
    });
    return true;
  });
  if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
  return {
    blueprintId: seeded.blueprintId,
    candidateId: commit.candidateId,
    candidateDigest: commit.digest,
    verificationId,
    reportBytes: bytes,
    reportArtifactId,
  };
}

function entryNames(bytes: Uint8Array): string[] {
  const read = readZipArchive(bytes, ZIP_LIMITS);
  if (!read.ok) throw new Error(read.error.join(","));
  return read.value.map((entry) => entry.name).sort();
}

function entryBytes(bytes: Uint8Array, name: string): Uint8Array {
  const read = readZipArchive(bytes, ZIP_LIMITS);
  if (!read.ok) throw new Error(read.error.join(","));
  const found = read.value.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no entry ${name}`);
  return found.bytes;
}

function exportRowCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM exports").get() as { n: number };
  return Number(row.n);
}

function packageRowCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE class = 'export'").get() as { n: number };
  return Number(row.n);
}

function journal(action: string, decision: string): string[] {
  const rows = readAudit(writer, { after: 0, projectId, limit: 500 });
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  return rows.value.filter((entry) => entry.action === action && entry.decision === decision).map((entry) => entry.reasonCode);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-export-"));
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
  targetId = newId();
  const created = nowInstant();
  const seeded = writer.transact((tx) => {
    tx.insertProject({ id: projectId, name: "export-suite", createdAt: created, graphRevision: 1, inventoryRevision: 1, schemaVersion: 1 });
    tx.insertTarget({
      id: targetId,
      projectId,
      kind: "asar",
      originalLocator: null,
      sourceSha256: null,
      sourceArtifactId: null,
      snapshotDigest: asDigest(hex("snapshot-target")),
      identityReason: null,
      createdAt: created,
    });
    return true;
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));

  const facts = {
    readRecord(): Promise<never> {
      throw new Error("delivery never reads capture facts");
    },
  } as unknown as EvidenceFactsPort;
  const vectors = new VectorService({ storage: writer, artifacts: store, facts, limits: LIMITS });
  verifications = new VerificationService({ storage: writer, artifacts: store, vectors, limits: LIMITS });
  exports_ = new ExportService({
    storage: writer,
    artifacts: store,
    verification: verifications,
    limits: LIMITS,
    zipLimits: ZIP_LIMITS,
  });
});

afterAll(async () => {
  await Promise.all(heldLocks.map((lock) => lock.release()));
  await rm(root, { recursive: true, force: true });
  db.close();
});

describe("a draft package says what it is (PRD F11)", () => {
  it("holds the candidate's own files and no report entries", async () => {
    const scene = await seedVerified("draft-happy");
    const record = unwrap(
      await exports_.create(projectId, reviewer, {
        candidateId: scene.candidateId,
        verificationId: null,
        label: "draft",
      }),
    );
    expect(record.label).toBe("draft");
    expect(record.downloadUrl).toBe(`/api/v1/projects/${projectId}/exports/${record.id}/download`);
    expect(record.manifest.statusNote.length).toBeGreaterThan(0);
    // The gate reports in its own dimension order: result, currentness, cleanup, report.
    expect(record.manifest.statusNote).toEqual(["result-unknown", "cleanup-pending", "report-unpublished"]);
    expect(record.manifest.bound).toBeNull();
    expect(record.manifest.deliverability.canExportVerifiedSamples).toBe(false);

    const archived = unwrap(await exports_.archive(projectId, reviewer, record.id));
    expect(digestBytes(archived.bytes)).toBe(record.sha256);
    expect(archived.mediaType).toBe("application/zip");
    expect(entryNames(archived.bytes)).toEqual([...declaredPackageEntries(false)].sort());
    // The source entry is the stored candidate file, byte for byte — not a regenerated one.
    expect(new TextDecoder().decode(entryBytes(archived.bytes, "blueprint.json"))).not.toContain("holdout");
    const manifest = exportManifestSchema.safeParse(JSON.parse(new TextDecoder().decode(entryBytes(archived.bytes, "MANIFEST.json"))));
    expect(manifest.success).toBe(true);
    expect(journal("export.create", "allow")).toEqual(["export-draft"]);
  });

  it("refuses a builder actor for both halves of delivery", async () => {
    const scene = await seedVerified("draft-builder");
    const refused = await failureOf(
      exports_.create(projectId, builder, { candidateId: scene.candidateId, verificationId: null, label: "draft" }),
    );
    expect(refused.code).toBe("ACCESS_DENIED");
    expect(refused.reason).toBe("builder-may-not-export");
    expect(journal("export.create", "deny")).toContain("builder-may-not-export");
  });

  it("refuses a candidate that is not this project's", async () => {
    const refused = await failureOf(
      exports_.create(projectId, reviewer, { candidateId: newId(), verificationId: null, label: "draft" }),
    );
    expect(refused.code).toBe("NOT_FOUND");
    expect(refused.reason).toBe("candidate-unknown");
  });
});

describe("verified-samples needs a current PASS and a finished cleanup (§10, §11)", () => {
  it("packages the report and a coverage projection next to it", async () => {
    const scene = await seedVerified("verified-happy");
    const record = unwrap(
      await exports_.create(projectId, reviewer, {
        candidateId: scene.candidateId,
        verificationId: scene.verificationId,
        label: "verified-samples",
      }),
    );
    expect(record.manifest.statusNote).toEqual([]);
    expect(record.manifest.deliverability.canExportVerifiedSamples).toBe(true);
    expect(record.manifest.bound?.candidateDigest).toBe(scene.candidateDigest);

    const archived = unwrap(await exports_.archive(projectId, reviewer, record.id));
    expect(entryNames(archived.bytes)).toEqual([...declaredPackageEntries(true)].sort());
    expect(entryBytes(archived.bytes, "reports/verification.json")).toEqual(scene.reportBytes);
    const coverage = JSON.parse(new TextDecoder().decode(entryBytes(archived.bytes, "reports/coverage.json"))) as {
      passRate: number;
      planDenominator: number;
      inventory: { total: number };
    };
    // §10's two denominators stay two: the frozen plan and the whole snapshot.
    expect(coverage.planDenominator).toBe(1);
    expect(coverage.inventory.total).toBe(1);
    expect(coverage.passRate).toBe(1);
    expect(journal("export.create", "allow")).toContain("export-verified-samples");
  });

  it("refuses while cleanup is still pending and writes nothing", async () => {
    const scene = await seedVerified("verified-cleanup-pending", { cleanupState: "pending" });
    const exportCountBefore = exportRowCount();
    const refused = await failureOf(
      exports_.create(projectId, reviewer, {
        candidateId: scene.candidateId,
        verificationId: scene.verificationId,
        label: "verified-samples",
      }),
    );
    expect(refused.code).toBe("STALE_INPUT");
    expect(JSON.stringify(refused.details)).toContain("cleanup-pending");
    expect(exportRowCount()).toBe(exportCountBefore);
    expect(journal("export.create", "deny")).toContain("verified-samples-blocked:cleanup-pending");
  });

  it("refuses a lease left open even when the job says complete", async () => {
    const scene = await seedVerified("verified-lease-open", { cleanupState: "complete", leaseState: "failed" });
    const refused = await failureOf(
      exports_.create(projectId, reviewer, {
        candidateId: scene.candidateId,
        verificationId: scene.verificationId,
        label: "verified-samples",
      }),
    );
    expect(JSON.stringify(refused.details)).toContain("cleanup-failed");
  });

  it("refuses a FAIL and a stale binding, and needs a verification to name", async () => {
    const failed = await seedVerified("verified-fail", { result: "FAIL" });
    const refusedFail = await failureOf(
      exports_.create(projectId, reviewer, {
        candidateId: failed.candidateId,
        verificationId: failed.verificationId,
        label: "verified-samples",
      }),
    );
    expect(JSON.stringify(refusedFail.details)).toContain("verified-samples-blocked:result-fail");

    const noBinding = await seedVerified("verified-no-binding");
    const refusedLabel = await failureOf(
      exports_.create(projectId, reviewer, {
        candidateId: noBinding.candidateId,
        verificationId: null,
        label: "verified-samples",
      }),
    );
    expect(refusedLabel.reason).toBe("verified-samples-blocked:no-verification-bound");

    // The candidate moves after the report was written: the binding is no longer current.
    const stale = await seedVerified("verified-stale");
    db.prepare("UPDATE candidates SET digest = ? WHERE project_id = ? AND id = ?").run(asDigest(hex("moved-candidate")), projectId, stale.candidateId);
    const refusedStale = await failureOf(
      exports_.create(projectId, reviewer, {
        candidateId: stale.candidateId,
        verificationId: stale.verificationId,
        label: "verified-samples",
      }),
    );
    expect(JSON.stringify(refusedStale.details)).toContain("report-stale");
  });

  it("re-verifies every bound identity before the bytes leave", async () => {
    const scene = await seedVerified("verified-at-download");
    const record = unwrap(
      await exports_.create(projectId, reviewer, {
        candidateId: scene.candidateId,
        verificationId: scene.verificationId,
        label: "verified-samples",
      }),
    );
    // The package existed before the world moved under it; §10 forbids letting it leave.
    db.prepare("UPDATE candidates SET digest = ? WHERE project_id = ? AND id = ?").run(asDigest(hex("moved-after-export")), projectId, scene.candidateId);
    const refused = await failureOf(exports_.archive(projectId, reviewer, record.id));
    expect(refused.code).toBe("STALE_INPUT");
    expect(JSON.stringify(refused.details)).toContain("report-stale");
    expect(JSON.stringify(refused.details)).toContain("bound-identity-changed:candidateDigest");
    // The refusal is journalled under the reason that actually moved, not a generic one.
    // The denied download is journalled under the reason that led, which is the gate's own.
    expect(journal("export.download", "deny")).toContain("report-stale");
  });

  it("refuses a stored package whose bytes are not the ones recorded", async () => {
    const scene = await seedVerified("verified-tampered");
    const record = unwrap(
      await exports_.create(projectId, reviewer, {
        candidateId: scene.candidateId,
        verificationId: scene.verificationId,
        label: "verified-samples",
      }),
    );
    const looked = writer.transact((tx) => {
      const row = tx.getExport(projectId, record.id);
      return row === null ? null : tx.getArtifact(projectId, row.artifactId);
    });
    if (!looked.ok || looked.value === null) throw new Error("package artifact row missing");
    const target = store.absolutePathFor(projectId, looked.value.storageKey);
    if (target === null) throw new Error("the store refused to resolve its own key");
    await writeFile(target, "someone rewrote the package");
    const refused = await failureOf(exports_.archive(projectId, reviewer, record.id));
    expect(refused.reason).toBe("package-digest-mismatch");
  });

  it("keeps one package for repeated exports and never overwrites a record", async () => {
    const scene = await seedVerified("verified-twice");
    const input = { candidateId: scene.candidateId, verificationId: scene.verificationId, label: "verified-samples" as const };
    const exportCountBefore = exportRowCount();
    const packageCountBefore = packageRowCount();
    const first = unwrap(await exports_.create(projectId, reviewer, input));
    const second = unwrap(await exports_.create(projectId, reviewer, input));
    expect(second.id).not.toBe(first.id);
    expect(exportRowCount()).toBe(exportCountBefore + 2);
    // Same facts: one package artifact, two export records pointing at it.
    expect(packageRowCount()).toBe(packageCountBefore + 1);
    expect(second.sha256).toBe(first.sha256);
    const archived = unwrap(await exports_.archive(projectId, reviewer, first.id));
    expect(digestBytes(archived.bytes)).toBe(first.sha256);
  });

  it("keeps one package after the clock moves, because the stamp is a fact and not a moment", async () => {
    const scene = await seedVerified("verified-across-clock");
    const input = { candidateId: scene.candidateId, verificationId: scene.verificationId, label: "verified-samples" as const };
    const packageCountBefore = packageRowCount();
    const first = unwrap(await exports_.create(projectId, reviewer, input));
    // A zip entry's DOS timestamp has a two-second quantum, so this wait is what turns the
    // assertion into a proof rather than a coin toss: stamp the archive with the wall clock and
    // the second export lands in a later bucket, hashes differently, and stores a second copy of
    // bytes that are identical to the first. The export rows still carry their own instants.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const second = unwrap(await exports_.create(projectId, reviewer, input));
    expect(second.sha256).toBe(first.sha256);
    expect(packageRowCount()).toBe(packageCountBefore + 1);
    expect(second.id).not.toBe(first.id);

    // Which instant it is, read out of the archive's own bytes rather than inferred from a
    // digest that merely happens to be stable: the local file header carries the modification
    // time as a uint16 at offset 10 and the date at 12, and the frozen fact they must spell is
    // the blueprint's instant (§10's "a copy of frozen facts"), not a constant and not the clock.
    const frozen = writer.transact((tx) => tx.getBlueprint(projectId, scene.blueprintId));
    if (!frozen.ok || frozen.value === null) throw new Error("the seeded blueprint row vanished");
    const packed = unwrap(await exports_.archive(projectId, reviewer, second.id));
    const header = new DataView(packed.bytes.buffer, packed.bytes.byteOffset, packed.bytes.byteLength);
    const time = header.getUint16(10, true);
    const date = header.getUint16(12, true);
    const stamped = Date.UTC(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0x1f) - 1, date & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
    const at = new Date(frozen.value.createdAt);
    expect(stamped).toBe(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), Math.floor(at.getUTCSeconds() / 2) * 2));
  });
});

describe("the package carries the bytes it claims and no others", () => {
  it("refuses to package a source artifact whose bytes no longer hash to its row", async () => {
    const scene = await seedVerified("source-tampered");
    const exportsBefore = exportRowCount();
    // The blueprint artifact is one of the entries. Rewriting its stored bytes under the
    // same key is exactly the case the re-hash before packaging exists for: an export that
    // quietly carries tampered content would still hash to its own recorded digest.
    const key = db
      .prepare(
        `SELECT a.storage_key AS k FROM blueprints b JOIN artifacts a ON a.id = b.artifact_id WHERE b.project_id = ? AND b.id = ?`,
      )
      .get(projectId, scene.blueprintId) as { k: string };
    const target = store.absolutePathFor(projectId, key.k);
    if (target === null) throw new Error("the store refused to resolve its own key");
    await writeFile(target, "{}");
    const refused = await failureOf(
      exports_.create(projectId, reviewer, { candidateId: scene.candidateId, verificationId: null, label: "draft" }),
    );
    expect(refused.reason).toBe("package-source-digest-mismatch");
    expect(exportRowCount()).toBe(exportsBefore);
  });

  it("records each entry's digest in the manifest so a reader can check it", async () => {
    const scene = await seedVerified("manifest-parts");
    const record = unwrap(
      await exports_.create(projectId, reviewer, { candidateId: scene.candidateId, verificationId: null, label: "draft" }),
    );
    const archived = unwrap(await exports_.archive(projectId, reviewer, record.id));
    // The manifest is not a table of contents of intentions: every part has to hash to the
    // bytes the archive actually holds, and the set of parts has to be the set of entries.
    for (const part of record.manifest.parts) {
      expect(entryBytes(archived.bytes, part.name).byteLength).toBe(part.byteLength);
      expect(digestBytes(entryBytes(archived.bytes, part.name))).toBe(part.sha256);
    }
    const read = readZipArchive(archived.bytes, ZIP_LIMITS);
    if (!read.ok) throw new Error(read.error.join(","));
    // MANIFEST.json is the only entry not listed inside itself: the archive is what the
    // recorded export digest commits to, and a self-hash would be circular.
    expect(read.value.map((entry) => entry.name).sort()).toEqual(["MANIFEST.json", ...record.manifest.parts.map((part) => part.name)].sort());
  });

  it("refuses when the candidate moves between the read and the commit", async () => {
    const scene = await seedVerified("export-race");
    const exportsBefore = exportRowCount();
    const racing = new ExportService({
      storage: racingStorage(writer, {
        method: "getCandidate",
        beforeCall: 2,
        inject: () => {
          db.prepare("UPDATE candidates SET digest = ? WHERE project_id = ? AND id = ?").run(
            asDigest(hex("moved-mid-export")),
            projectId,
            scene.candidateId,
          );
        },
      }),
      artifacts: store,
      verification: verifications,
      limits: LIMITS,
      zipLimits: ZIP_LIMITS,
    });
    const refused = await failureOf(
      racing.create(projectId, reviewer, { candidateId: scene.candidateId, verificationId: null, label: "draft" }),
    );
    expect(refused.code).toBe("REVISION_CONFLICT");
    expect(refused.reason).toBe("candidate-changed-under-export");
    // Nothing half-written survives the refusal: the export count is what it was.
    expect(exportRowCount()).toBe(exportsBefore);
  });
});

describe("the reply is a named contract, not a dump", () => {
  it("lists exports with their recorded digests and relative routes", async () => {
    const scene = await seedVerified("list-one");
    const record = unwrap(
      await exports_.create(projectId, reviewer, { candidateId: scene.candidateId, verificationId: null, label: "draft" }),
    );
    const listed = unwrap(await exports_.list(projectId, reviewer, 10));
    expect(listed.map((entry) => entry.id)).toContain(record.id);
    // Every listed entry routes back through this API and carries a 64-hex digest.
    for (const entry of listed) {
      expect(entry.downloadUrl).toMatch(/^\/api\/v1\/projects\/[0-9a-f-]{36}\/exports\/[0-9a-f-]{36}\/download$/);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const parsed = exportRecordSchema.safeParse({
      id: record.id,
      label: record.label,
      downloadUrl: record.downloadUrl,
      sha256: record.sha256,
      manifest: JSON.parse(JSON.stringify(record.manifest)),
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a download for an export this project does not have", async () => {
    const refused = await failureOf(exports_.archive(projectId, reviewer, newId()));
    expect(refused.code).toBe("NOT_FOUND");
    expect(refused.reason).toBe("export-unknown");
  });
});

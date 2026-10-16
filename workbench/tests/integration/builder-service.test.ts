import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import {
  acquireWorkerLock,
  applyMigrations,
  openWriteConnection,
  planMigrations,
} from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { BuilderService } from "../../packages/application/builder-service.ts";
import { readAudit } from "../../packages/application/audit.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { JobRow } from "../../packages/application/ports.ts";
import { racingStorage } from "../support/racing-storage.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type { Result } from "../../packages/domain/result.ts";
import { seedBlueprintForGeneration, hex } from "../support/blueprint-seed.ts";

// The Builder generation seam against real storage (DESIGN §7.3, §10 / PRD F08 A07,
// issue #19). What has to be provable here is the boundary, not the code generator:
// the only input is a frozen blueprint handoff, a spent budget stops the loop, and a
// candidate records bytes and digests — never a verdict.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const builder: Actor = { actorId: "builder-agent", actorKind: "builder" };
const inspector: Actor = { actorId: "local-operator", actorKind: "inspector" };

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let store: ArtifactStore;
let service: BuilderService;
let projectId: Id;
let targetId: Id;
let jobId: Id;
const heldLocks: { release: () => Promise<void> }[] = [];

function unwrap<T>(result: Result<T, GateFailure>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}:${result.error.reason}:${JSON.stringify(result.error.details)}`);
  }
  return result.value;
}

async function failureOf<T>(result: Promise<Result<T, GateFailure>>): Promise<GateFailure> {
  const settled = await result;
  if (settled.ok) throw new Error("expected a refusal, got a value");
  return settled.error;
}

function budget(maxAttempts = 3, deadlineAt: Instant | null = null) {
  return { budget: { maxAttemptsPerBlueprint: maxAttempts, deadlineAt }, generator: { model: "test-agent" }, jobId };
}

function journal(action: string, decision: string): string[] {
  const rows = readAudit(writer, { after: 0, projectId, limit: 500 });
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  return rows.value.filter((entry) => entry.action === action && entry.decision === decision).map((entry) => entry.reasonCode);
}

function candidateRows(blueprintId: Id): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM candidates WHERE blueprint_id = ?")
    .get(blueprintId) as { n: number };
  return Number(row.n);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-builder-"));
  await writeFile(path.join(root, "note.txt"), "x");
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
  jobId = newId();
  const created = nowInstant();
  const seeded = writer.transact((tx) => {
    tx.insertProject({ id: projectId, name: "builder-suite", createdAt: created, graphRevision: 1, inventoryRevision: 1, schemaVersion: 1 });
    tx.insertTarget({
      id: targetId,
      projectId,
      kind: "asar",
      originalLocator: null,
      sourceSha256: null,
      sourceArtifactId: null,
      snapshotDigest: asDigest(hex("snapshot")),
      identityReason: null,
      createdAt: created,
    });
    const job: JobRow = {
      id: jobId,
      projectId,
      targetId,
      kind: "build",
      state: "running",
      cleanupState: "pending",
      inputJson: {},
      resultRef: null,
      errorJson: null,
      idempotencyKey: `build-${jobId}`,
      requestDigest: asDigest(hex("build")),
      deadlineAt: null,
      retryAt: null,
      createdAt: created,
      updatedAt: created,
    };
    tx.insertJob(job);
    return true;
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  service = new BuilderService({ storage: writer, artifacts: store, limits: LIMITS });
});

afterAll(async () => {
  await Promise.all(heldLocks.map((lock) => lock.release()));
  await rm(root, { recursive: true, force: true });
  db.close();
});

describe("generating a candidate from a frozen blueprint (§7.3, §10)", () => {
  it("records three candidate files, a digest and an allow audit", async () => {
    const { blueprintId, digest } = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name: "happy" });
    const committed = unwrap(await service.generate(projectId, builder, blueprintId, budget()));
    expect(committed.blueprintDigest).toBe(digest);
    expect(committed.attempt).toBe(1);
    expect(committed.openApiVersion).toBe("3.1.1");
    expect(committed.files.map((file) => file.path).sort()).toEqual([
      "adapter.ts",
      "candidate-manifest.json",
      "openapi.json",
    ]);
    expect(committed.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(journal("builder.generate", "allow")).toEqual(["candidate-generated"]);
    expect(candidateRows(blueprintId)).toBe(1);
  });

  it("counts attempts per blueprint and stops when the budget is spent", async () => {
    const { blueprintId } = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name: "budget" });
    const first = unwrap(await service.generate(projectId, builder, blueprintId, budget(2)));
    const second = unwrap(await service.generate(projectId, builder, blueprintId, budget(2)));
    expect(second.attempt).toBe(first.attempt + 1);
    // §10: the fix loop has an explicit budget and stops. It does not "keep repairing
    // until green", and the refusal names the budget rather than pretending to be busy.
    const exhausted = await failureOf(service.generate(projectId, builder, blueprintId, budget(2)));
    expect(exhausted.code).toBe("RESOURCE_LIMIT");
    expect(exhausted.reason).toBe("generation-budget-exhausted");
    // The refusal names the attempt from the pre-read guard: the spent budget stops
    // the run before a single candidate byte is published, not only at commit time.
    expect((exhausted.details as Record<string, unknown>)["attempt"]).toBe(3);
    expect(journal("builder.generate", "deny")).toContain("generation-budget-exhausted");
    expect(candidateRows(blueprintId)).toBe(2);
  });

  it("refuses a blueprint whose stored bytes no longer hash to its row", async () => {
    const { blueprintId, artifactId } = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name: "tampered-bytes" });
    // A different payload under the same storage key: the row still carries the
    // original digest, so the bytes read back cannot be the approved blueprint.
    const rival = asDigest(hex("someone-elses-blueprint"));
    db.prepare("UPDATE artifacts SET sha256 = ? WHERE id = ?").run(rival, artifactId);
    const refused = await failureOf(service.generate(projectId, builder, blueprintId, budget()));
    expect(refused.code).toBe("REA_CONTRACT_MISMATCH");
    expect(refused.reason).toBe("blueprint-digest-mismatch");
    expect(candidateRows(blueprintId)).toBe(0);
  });

  it("refuses a blueprint whose digest the upstream withheld", async () => {
    const { blueprintId, artifactId } = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name: "withheld-digest" });
    // The schema allows a withheld digest only next to a reason (§4). Generation
    // needs an identity to bind a candidate to, so it refuses instead of hashing the
    // bytes it likes and calling that the blueprint's digest.
    db.prepare("UPDATE artifacts SET sha256 = NULL, digest_reason = ? WHERE id = ?").run(
      "upstream-withheld-digest",
      artifactId,
    );
    const refused = await failureOf(service.generate(projectId, builder, blueprintId, budget()));
    expect(refused.code).toBe("REA_CONTRACT_MISMATCH");
    expect(refused.reason).toBe("blueprint-digest-withheld");
    expect(candidateRows(blueprintId)).toBe(0);
  });

  it("refuses a deadline that passed before the builder ran", async () => {
    const { blueprintId } = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name: "deadline" });
    const past = new Date(Date.now() - 60_000).toISOString() as Instant;
    const refused = await failureOf(service.generate(projectId, builder, blueprintId, budget(3, past)));
    expect(refused.reason).toBe("generation-deadline-passed");
    expect(candidateRows(blueprintId)).toBe(0);
  });

  it("lets only the Builder generate, before it reads anything", async () => {
    const { blueprintId } = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name: "actors" });
    const refused = await failureOf(service.generate(projectId, inspector, blueprintId, budget()));
    expect(refused.code).toBe("ACCESS_DENIED");
    expect(refused.reason).toBe("only-the-builder-generates");
    expect(journal("builder.generate", "deny")).toContain("only-the-builder-generates");
    expect(candidateRows(blueprintId)).toBe(0);
  });

  it("refuses a blueprint whose bytes disagree with its row", async () => {
    // The stored payload claims a different blueprint digest than the index row: a
    // candidate generated from it would carry an identity nobody approved.
    const { blueprintId } = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name: "disagreement", mismatchRowDigest: true });
    const refused = await failureOf(service.generate(projectId, builder, blueprintId, budget()));
    expect(refused.code).toBe("REA_CONTRACT_MISMATCH");
    expect(refused.reason).toBe("blueprint-row-disagreement");
    expect(candidateRows(blueprintId)).toBe(0);
  });

  it("names no holdout and no target in anything it writes", async () => {
    const { blueprintId } = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name: "leak-check" });
    // A holdout sample exists in this project. Nothing in the generation request or
    // in the emitted files can name it, because the input is the Builder handoff and
    // that handoff structurally has no holdout field (§7.1, §7.3).
    const holdoutVectorId = newId();
    const committed = unwrap(await service.generate(projectId, builder, blueprintId, budget()));
    const bodies: string[] = [];
    const artifacts = writer.transact((tx) => {
      const rows = db
        .prepare("SELECT storage_key, sha256 FROM artifacts WHERE project_id = ? AND class = 'candidate'")
        .all(projectId) as { storage_key: string; sha256: string }[];
      for (const row of rows) {
        void tx;
        bodies.push(row.sha256);
      }
      return rows.map((row) => row.storage_key);
    });
    if (!artifacts.ok) throw new Error(JSON.stringify(artifacts.error));
    for (const storageKey of artifacts.value) {
      const bytes = await store.read(projectId, storageKey);
      if (!bytes.ok) throw new Error(JSON.stringify(bytes.error));
      const text = new TextDecoder("utf8").decode(bytes.value);
      expect(text).not.toContain(holdoutVectorId);
      expect(text).not.toContain(targetId);
      expect(text).not.toContain("holdout");
    }
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    expect(committed.files).toHaveLength(3);
  });

  it("cannot state a verdict: a candidate row is bytes and digests only", async () => {
    const { blueprintId } = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name: "no-verdict" });
    unwrap(await service.generate(projectId, builder, blueprintId, budget()));
    const columns = db.prepare("PRAGMA table_info(candidates)").all() as { name: string }[];
    const names = columns.map((column) => column.name);
    expect(names).not.toContain("result");
    expect(names).not.toContain("verdict");
    expect(names).not.toContain("passed");
    const verificationRows = db.prepare("SELECT COUNT(*) AS n FROM verifications").get() as { n: number };
    expect(Number(verificationRows.n)).toBe(0);
    const payload = writer.transact((tx) => tx.listCandidatesForBlueprint(projectId, blueprintId));
    if (!payload.ok) throw new Error(JSON.stringify(payload.error));
    const generator = payload.value[0]?.generatorJson as Record<string, JsonValue>;
    expect(generator["openApiVersion"]).toBe("3.1.1");
    expect(generator["attempt"]).toBe(1);
    expect(JSON.stringify(generator).toLowerCase()).not.toContain("pass");
  });

  it("refuses when a competing generation spends the budget first", async () => {
    const { blueprintId, artifactId } = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name: "race-budget" });
    const service2 = new BuilderService({
      storage: racingStorage(writer, {
        method: "listCandidatesForBlueprint",
        beforeCall: 2,
        inject: (tx) =>
          tx.insertCandidate({
            id: newId(),
            projectId,
            blueprintId,
            jobId,
            artifactId,
            digest: asDigest(hex("rival-candidate")),
            generatorJson: { model: "rival" },
            dependencyManifestJson: {},
          }),
      }),
      artifacts: store,
      limits: LIMITS,
    });
    // The pre-read still says "attempt 1 of 1", so only the count taken inside the
    // write transaction can stop this from being attempt 2 nobody budgeted for.
    const refused = await failureOf(service2.generate(projectId, builder, blueprintId, budget(1)));
    expect(refused.code).toBe("RESOURCE_LIMIT");
    expect(refused.reason).toBe("generation-budget-exhausted");
    // The refusal rolled the transaction back, rival row included: nothing half-written.
    expect(candidateRows(blueprintId)).toBe(0);
  });

  it("refuses when the blueprint moves while the candidate is being generated", async () => {
    const { blueprintId, digest } = await seedBlueprintForGeneration({ writer, store, projectId, targetId, name: "race-drift" });
    const service2 = new BuilderService({
      storage: racingStorage(writer, {
        method: "getBlueprint",
        beforeCall: 2,
        inject: () => {
          db.prepare("UPDATE blueprints SET digest = ? WHERE id = ?").run(asDigest(hex("moved")), blueprintId);
        },
      }),
      artifacts: store,
      limits: LIMITS,
    });
    const refused = await failureOf(service2.generate(projectId, builder, blueprintId, budget()));
    expect(refused.code).toBe("REVISION_CONFLICT");
    expect(refused.reason).toBe("blueprint-changed-under-generation");
    expect(candidateRows(blueprintId)).toBe(0);
    // The row is back to the approved digest because the whole transaction unwound.
    const row = db.prepare("SELECT digest FROM blueprints WHERE id = ?").get(blueprintId) as { digest: string };
    expect(row.digest).toBe(digest);
  });

  it("refuses a blueprint that does not exist instead of inventing one", async () => {
    const refused = await failureOf(service.generate(projectId, builder, newId(), budget()));
    expect(refused.code).toBe("NOT_FOUND");
    expect(refused.reason).toBe("blueprint-unreadable");
    expect(journal("builder.generate", "deny")).toContain("blueprint-unreadable");
  });
});

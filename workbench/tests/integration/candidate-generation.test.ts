import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asId, instantToEpochMs, newId } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import { apiErrorSchema } from "../../packages/contracts/errors.ts";
import { eventPageSchema } from "../../packages/contracts/events.ts";
import { jobRecordSchema } from "../../packages/contracts/jobs.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { seedBlueprintForGeneration } from "../support/blueprint-seed.ts";
import { seedVerifiedScenario } from "../support/verification-seed.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { COMMAND_NAMES, bootWorker } from "../../apps/worker/composition.ts";
import type { WorkerHandle } from "../../apps/worker/composition.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type { Result } from "../../packages/domain/result.ts";

// Generation as a job the worker owns (§8 line 294, §11, §7.3, §10 / issue #57).
//
// This file is the other half of the rig `worker-composition.test.ts` boots: here the model endpoint
// IS declared, so the refusals that sit behind the capability become reachable - the actor rule, the
// closed request shape, and the whole point of the change, which is that a queued `build` row now has
// something that runs it. The budget comes from the profile (two attempts), and the third request is
// what proves the number travelled from the file rather than from the wire.

const inspector: Actor = { actorId: "local-operator", actorKind: "inspector" };
const builder: Actor = { actorId: "builder-agent", actorKind: "builder" };
const QUEUE_WAIT_MS = 30_000;
const PROFILE_ATTEMPTS = 2;

let dataDir = "";
let worker: WorkerHandle;
let brokerListener: net.Server;

function profileJson(): JsonValue {
  return {
    id: "har-capture",
    schemaVersion: 1,
    reaPackageDigest: "0".repeat(64),
    reaContainerEntrypoint: "/usr/local/bin/rea",
    browserImageDigest: "b".repeat(64),
    browserVersion: "141.0.7390.107",
    limits: {
      cpuCores: 2,
      memoryBytes: 2147483648,
      pids: 128,
      diskBytes: 10737418240,
      maxExpandedBytes: 67108864,
      queueWaitMs: QUEUE_WAIT_MS,
      timeoutMs: 120000,
      maxGenerationAttempts: PROFILE_ATTEMPTS,
    },
    networkPolicyId: "deny-egress",
  };
}

function ask(name: string, payload: JsonValue, actor: Actor = inspector): Promise<Result<JsonValue, GateFailure>> {
  return worker.dispatch(name, payload, actor);
}

function unwrap<T>(result: Result<T, GateFailure>): T {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.reason}:${result.error.message}`);
  return result.value;
}

async function newProject(name: string): Promise<Id> {
  const created = unwrap(await ask("project.create", { name })) as { id: string };
  return asId(created.id);
}

// A target for the seeded blueprint, written through the worker's own connection because the
// blueprint fixture takes a target id rather than creating one.
function insertTarget(projectId: Id): Id {
  const targetId = newId();
  const at = new Date().toISOString() as Instant;
  const outcome = worker.writeConnection.transact((tx) => {
    tx.insertTarget({
      id: targetId,
      projectId,
      kind: "url",
      originalLocator: null,
      sourceSha256: null,
      sourceArtifactId: null,
      snapshotDigest: null,
      identityReason: "seeded-for-generation",
      createdAt: at,
    });
    return true;
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return targetId;
}

async function seedBlueprint(projectId: Id, targetId: Id, name: string, withPost = false): Promise<Id> {
  const seeded = await seedBlueprintForGeneration({
    writer: worker.writeConnection,
    store: new ArtifactStore(dataDir),
    projectId,
    targetId,
    name,
    withPost,
  });
  return seeded.blueprintId;
}

function askForCandidate(projectId: Id, blueprintId: Id, key: string, actor: Actor = inspector): Promise<Result<JsonValue, GateFailure>> {
  return ask("candidate.request", { projectId, idempotencyKey: key, request: { blueprintId } }, actor);
}

// The queue is the worker's, not a test's: it is scanned oldest-first across every project (§11 never
// promised per-project fairness). A runner test therefore starts by settling whatever an earlier door
// test left queued, so "the job this test asked for" is also "the job this turn runs".
async function drainQueue(): Promise<void> {
  for (let turns = 0; turns < 40; turns += 1) {
    const turn = await worker.runJobs();
    if (!turn.ok) throw new Error(`${turn.error.code}:${turn.error.reason}`);
    if (turn.value.kind === "idle") return;
  }
  throw new Error("queue did not drain within 40 turns");
}

function eventsFor(projectId: Id): { type: string; payload: JsonValue }[] {
  const read = worker.writeConnection.transact((tx) =>
    tx.eventsAfter(projectId, 0, 100).map((event) => ({ type: event.type, payload: event.payloadJson })),
  );
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  return read.value;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "rea-wb-runner-"));
  mkdirSync(path.join(dataDir, "profiles"), { recursive: true });
  const { chmodSync } = await import("node:fs");
  chmodSync(dataDir, 0o700);

  const packageRoot = path.join(dataDir, "package");
  mkdirSync(path.join(packageRoot, "infra", "profiles"), { recursive: true });
  writeFileSync(path.join(packageRoot, "infra", "profiles", "har-capture.json"), JSON.stringify(profileJson()));

  const reaEntrypoint = path.join(dataDir, "rea-entry.mjs");
  writeFileSync(reaEntrypoint, "// placeholder identity file; the fixture is what actually answers\n");
  const brokerSocket = path.join(dataDir, "broker.sock");
  brokerListener = net.createServer();
  brokerListener.on("connection", (socket) => socket.destroy());
  await new Promise<void>((resolve) => brokerListener.listen({ path: brokerSocket, exclusive: true }, () => resolve()));

  const booted = await bootWorker({
    env: {
      WB_HOST: "127.0.0.1",
      WB_PORT: "4319",
      WB_DATA_DIR: dataDir,
      WB_REA_ENTRYPOINT: reaEntrypoint,
      // Declared, so §3's capability gate opens and the checks behind it become observable. The
      // resolver insists on loopback http without userinfo (§14: no implicit cloud endpoint), so the
      // value names a local proxy rather than a vendor URL.
      WB_MODEL_ENDPOINT: "http://127.0.0.1:9977/v1",
      WB_SANDBOX_PROFILE: "har-capture",
      WB_BROKER_SOCKET: brokerSocket,
    },
    installedDefaults: {},
    profileDir: path.join(packageRoot, "infra", "profiles"),
    toolchain: { nodeVersion: "24.18.0", requiredNodeVersion: "24.18.0" },
  });
  if (!booted.ok) throw new Error(JSON.stringify(booted.error));
  worker = booted.value;
});

afterAll(async () => {
  await worker.shutdown();
  brokerListener.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the generation door writes a job and nothing else (§8 line 294, §10)", () => {
  it("answers with the queued build row, its deadline derived from the profile", async () => {
    const projectId = await newProject("runner-1");
    const blueprintId = await seedBlueprint(projectId, insertTarget(projectId), "runner-1");
    const asked = await askForCandidate(projectId, blueprintId, "3c1d2e4f-6a8b-4c0d-9e1f-2a4c6e8f0b13");
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;

    // The body is a JobRecord, and the strict schema is the check: a door that answered a candidate
    // summary here would be answering with a fact that does not exist yet (§10).
    const parsed = jobRecordSchema.safeParse(asked.value);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.kind).toBe("build");
    expect(parsed.data.state).toBe("queued");
    expect(parsed.data.resultRef).toBeNull();
    expect(parsed.data.error).toBeNull();
    // The deadline is not a free-floating caller value: absent means `queueWaitMs` from the enqueue
    // moment, and a door that left it null would be a job with no bound at all.
    expect(parsed.data.deadlineAt).not.toBeNull();
    const deadline = parsed.data.deadlineAt as string;
    const ahead = instantToEpochMs(deadline as Instant) - Date.now();
    expect(ahead).toBeGreaterThan(QUEUE_WAIT_MS - 5_000);
    expect(ahead).toBeLessThanOrEqual(QUEUE_WAIT_MS + 5_000);
    const queued = eventsFor(projectId).filter((event) => event.type === "job.updated");
    expect(queued.map((event) => (event.payload as { state?: string }).state)).toEqual(["queued"]);
  });

  it("replays one key to the same row and refuses a second request under it", async () => {
    const projectId = await newProject("runner-2");
    const targetId = insertTarget(projectId);
    const first = await seedBlueprint(projectId, targetId, "runner-2-a");
    const second = await seedBlueprint(projectId, targetId, "runner-2-b");
    const key = "4d6e8f0a-2b4c-4e6f-8a0b-2c4e6f8a0b24";

    const asked = unwrap(await askForCandidate(projectId, first, key)) as { id: string };
    const replay = unwrap(await askForCandidate(projectId, first, key)) as { id: string };
    expect(replay.id).toBe(asked.id);
    // The replay is not a state change: one `job.updated` for the first request, none for the second.
    expect(eventsFor(projectId).filter((event) => event.type === "job.updated")).toHaveLength(1);

    const divergent = await askForCandidate(projectId, second, key);
    expect(divergent.ok).toBe(false);
    if (divergent.ok) return;
    expect(divergent.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(divergent.error.reason).toBe("idempotency-key-reused");
  });

  it("refuses a wire shape that still carries the worker's own facts", async () => {
    const projectId = await newProject("runner-3");
    const blueprintId = await seedBlueprint(projectId, insertTarget(projectId), "runner-3");
    const forged = await ask("candidate.request", {
      projectId,
      idempotencyKey: "5e7f9a1b-3c5d-4f7a-9b1c-3d5f7a9b1c35",
      request: {
        blueprintId,
        jobId: newId(),
        budget: { maxAttemptsPerBlueprint: 9 },
        generator: { model: "whatever" },
      },
    }, inspector);
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.error.code).toBe("INVALID_INPUT");
    expect(forged.error.reason).toBe("candidate-request");
    // Named, not swallowed: the three fields are the ones issue #57 took off the wire, and a refusal
    // that does not say which keys it rejected is how a client learns nothing from a 400.
    const named = JSON.stringify(forged.error.details);
    for (const field of ["jobId", "budget", "generator"]) expect(named).toContain(field);
  });

  it("keeps the Builder out of the queue it executes and the blueprint list out of the request", async () => {
    const projectId = await newProject("runner-4");
    const blueprintId = await seedBlueprint(projectId, insertTarget(projectId), "runner-4");
    const wrongRole = await askForCandidate(projectId, blueprintId, "6f8a0b2c-4d6f-4a8b-0c2d-4f6a8b0c2d46", builder);
    expect(wrongRole.ok).toBe(false);
    if (wrongRole.ok) return;
    expect(wrongRole.error.code).toBe("ACCESS_DENIED");
    expect(wrongRole.error.reason).toBe("role-may-not-request-generation");

    const unknown = await askForCandidate(projectId, newId(), "7a9b1c3d-5e7f-4a9b-1c3d-5e7f9a1b3c57");
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("NOT_FOUND");
    expect(unknown.error.reason).toBe("blueprint-unknown");
  });
});

describe("the runner executes the queue it finds (§11)", () => {
  it("takes a queued build job through running into a candidate the read doors answer with", async () => {
    await drainQueue();
    const projectId = await newProject("runner-5");
    const blueprintId = await seedBlueprint(projectId, insertTarget(projectId), "runner-5");
    const jobId = asId((unwrap(await askForCandidate(projectId, blueprintId, "8b0c2d4e-6f8a-4b2c-4d6f-8a0b2c4e6f80")) as { id: string }).id);

    const turn = await worker.runJobs();
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    expect(turn.value.kind).toBe("succeeded");
    if (turn.value.kind !== "succeeded") return;
    expect(turn.value.jobId).toBe(jobId);

    // The row is read back through the same projection the page uses, and §8 line 294's promise is
    // the assertion: a successful generation's resultRef is the candidate id.
    const read = unwrap(await ask("job.get", { projectId, jobId })) as JsonValue;
    const record = jobRecordSchema.parse(read);
    expect(record.state).toBe("succeeded");
    expect(record.resultRef).toBe(turn.value.candidateId);
    expect(record.error).toBeNull();

    // And the candidate is readable - which is the code tab's whole discovery path, now reachable
    // from a browser request rather than a seeding script.
    const candidate = await ask("candidate.get", { projectId, request: { candidateId: turn.value.candidateId } });
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const view = candidate.value as { id: string; blueprintId: string; files: { path: string }[] };
    expect(view.id).toBe(turn.value.candidateId);
    expect(view.blueprintId).toBe(blueprintId);
    expect(view.files.map((file) => file.path)).toContain("adapter.ts");

    const states = eventsFor(projectId)
      .filter((event) => event.type === "job.updated")
      .map((event) => (event.payload as { state?: string }).state);
    expect(states).toEqual(["queued", "running", "succeeded"]);

    // The queue is empty now, and an empty queue is an idle turn rather than an error.
    const idle = await worker.runJobs();
    expect(idle.ok).toBe(true);
    if (!idle.ok) return;
    expect(idle.value.kind).toBe("idle");
  });

  it("spends the profile's budget, not the caller's, and reports the third attempt as spent (§10)", async () => {
    await drainQueue();
    const projectId = await newProject("runner-6");
    const targetId = insertTarget(projectId);
    const blueprintId = await seedBlueprint(projectId, targetId, "runner-6");

    const attempts: string[] = [];
    for (const index of [0, 1]) {
      const asked = unwrap(await askForCandidate(projectId, blueprintId, `9c1d3e5f-7a9b-4c1d-3e5f-7a9b1c3d5e${String(index)}`)) as { id: string };
      const turn = await worker.runJobs();
      expect(turn.ok).toBe(true);
      if (!turn.ok) return;
      expect(turn.value.kind).toBe("succeeded");
      if (turn.value.kind !== "succeeded") return;
      expect(turn.value.jobId).toBe(asked.id);
      attempts.push(String(turn.value.attempt));
    }
    // The profile says two. A handler that forwarded a fixed number, or one that read the request,
    // would not stop here.
    expect(attempts).toEqual(["1", "2"]);

    const third = unwrap(await askForCandidate(projectId, blueprintId, "0d2e4f6a-8b0c-4d2e-4f6a-8b0c2d4e6f81")) as { id: string };
    const refused = await worker.runJobs();
    expect(refused.ok).toBe(true);
    if (!refused.ok) return;
    expect(refused.value.kind).toBe("failed");

    const row = jobRecordSchema.parse(unwrap(await ask("job.get", { projectId, jobId: asId(third.id) })));
    expect(row.state).toBe("failed");
    expect(row.resultRef).toBeNull();
    // The failure is reportable: the stored error is the same ApiError shape a synchronous refusal
    // answers with, and the two numbers that make it actionable are the ones §12.1 declares safe.
    const error = row.error;
    expect(error).not.toBeNull();
    if (error === null) return;
    expect(apiErrorSchema.safeParse(error).success).toBe(true);
    expect(error.code).toBe("RESOURCE_LIMIT");
    expect(error.message).toBe("generation-budget-exhausted");
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ attempt: 3, maxAttempts: PROFILE_ATTEMPTS });
    // The request this failure answers is the key the caller carried - not a number the runner made
    // up, and not the row's own id, which would say nothing about which request is being answered.
    expect(error.requestId).toBe("0d2e4f6a-8b0c-4d2e-4f6a-8b0c2d4e6f81");

    // The event the same settle wrote has to stay inside §8.1's payload contract. This is not
    // cosmetic: the backlog read parses every row, so one event carrying a key the contract does not
    // name makes `GET /events` refuse the project's whole stream from then on - a failed job would
    // silently kill the feed every later job depends on.
    const page = unwrap(await ask("events.after", { projectId, afterSeq: 0, limit: 100 }, inspector));
    const parsedPage = eventPageSchema.safeParse(page);
    expect(parsedPage.success).toBe(true);
    if (!parsedPage.success) return;
    const states = parsedPage.data.events
      .filter((event) => event.type === "job.updated" && event.aggregateId === third.id)
      .map((event) => [event.payload.state, event.payload.reasonCode]);
    expect(states).toEqual([["queued", undefined], ["running", undefined], ["failed", "generation-budget-exhausted"]]);
  });

  it("leaves a cancelled job alone instead of resurrecting it (§11 终态不复活)", async () => {
    await drainQueue();
    const projectId = await newProject("runner-7");
    const blueprintId = await seedBlueprint(projectId, insertTarget(projectId), "runner-7");
    const jobId = asId((unwrap(await askForCandidate(projectId, blueprintId, "1e3f5a7b-9c1d-4e3f-5a7b-9c1d3e5f7a91")) as { id: string }).id);

    const cancelled = unwrap(await ask("job.cancel", { projectId, jobId })) as { state: string };
    expect(cancelled.state).toBe("cancelled");

    const turn = await worker.runJobs();
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    // The queue holds only `queued` rows, so a cancelled job is not even offered to the runner: the
    // turn is idle because there was nothing to run, not because the run was refused.
    expect(turn.value.kind).toBe("idle");
    const row = jobRecordSchema.parse(unwrap(await ask("job.get", { projectId, jobId })));
    expect(row.state).toBe("cancelled");
    expect(row.resultRef).toBeNull();
  });

  it("settles a blueprint that disagrees with its own index row as a failure the page can read", async () => {
    await drainQueue();
    const projectId = await newProject("runner-8");
    const targetId = insertTarget(projectId);
    const seeded = await seedBlueprintForGeneration({
      writer: worker.writeConnection,
      store: new ArtifactStore(dataDir),
      projectId,
      targetId,
      name: "runner-8",
      // The row claims a digest the payload does not: the Builder refuses to generate from it rather
      // than treating the approved identity as good enough.
      mismatchRowDigest: true,
    });
    const jobId = asId((unwrap(await askForCandidate(projectId, seeded.blueprintId, "2f4a6b8c-0d2e-4f4a-6b8c-0d2e4f6a8b02")) as { id: string }).id);

    const turn = await worker.runJobs();
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    expect(turn.value.kind).toBe("failed");
    const row = jobRecordSchema.parse(unwrap(await ask("job.get", { projectId, jobId })));
    expect(row.state).toBe("failed");
    const error = row.error;
    expect(error).not.toBeNull();
    if (error === null) return;
    expect(error.code).toBe("REA_CONTRACT_MISMATCH");
    expect(error.message).toBe("blueprint-row-disagreement");
    // A code §8 does not model would have become this name rather than an invented status: the
    // failure still has to be reportable, and it must not pretend to be something the table knows.
    expect(error.details).toEqual({});
  });
});

describe("what the runner refuses to run (§11, §7.3)", () => {
  it("leaves a queued verify job for the evaluator that does not exist in this build (#75)", async () => {
    await drainQueue();
    const projectId = await newProject("runner-9");
    const verified = await seedVerifiedScenario({
      writer: worker.writeConnection,
      store: new ArtifactStore(dataDir),
      projectId,
      targetId: insertTarget(projectId),
      name: "runner-9",
    });
    const asked = unwrap(await ask("verification.request", {
      projectId,
      idempotencyKey: "3a5c7e9f-1b3d-4f5a-7c9e-1b3d5f7a9c13",
      request: { candidateId: verified.candidateId, comparatorPolicyId: "exact-http-v1" },
    }, inspector)) as { id: string };

    // The row is queued and stays queued: the runner's kind list is the honest boundary, and a
    // handler that guessed what "ran" means for a verification would show up here as a turn.
    const turn = await worker.runJobs();
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    expect(turn.value.kind).toBe("idle");
    const row = jobRecordSchema.parse(unwrap(await ask("job.get", { projectId, jobId: asId(asked.id) })));
    expect(row.state).toBe("queued");
    expect(row.kind).toBe("verify");
  });

  it("settles a job whose own row does not name a blueprint, instead of looping on it", async () => {
    await drainQueue();
    const projectId = await newProject("runner-10");
    const jobId = newId();
    const at = new Date().toISOString() as Instant;
    const inserted = worker.writeConnection.transact((tx) => {
      tx.insertJob({
        id: jobId,
        projectId,
        targetId: null,
        kind: "build",
        state: "queued",
        cleanupState: "pending",
        // The row a door cannot write any more: a build job with no handoff named.
        inputJson: {},
        resultRef: null,
        errorJson: null,
        idempotencyKey: `hand-seeded-${jobId}`,
        requestDigest: "d".repeat(64) as Digest,
        deadlineAt: null,
        retryAt: null,
        createdAt: at,
        updatedAt: at,
      });
      return true;
    });
    if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));

    const turn = await worker.runJobs();
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    expect(turn.value.kind).toBe("failed");
    const row = jobRecordSchema.parse(unwrap(await ask("job.get", { projectId, jobId })));
    expect(row.state).toBe("failed");
    const error = row.error;
    expect(error).not.toBeNull();
    if (error === null) return;
    expect(error.message).toBe("build-job-input-unreadable");
    // The next turn is idle rather than the same failure again: a row that cannot run has to stop
    // being offered, or one bad row becomes the queue's only content.
    const next = await worker.runJobs();
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.value.kind).toBe("idle");
  });

  it("fails a job whose queue wait ran out before it started (§11)", async () => {
    await drainQueue();
    const projectId = await newProject("runner-11");
    const blueprintId = await seedBlueprint(projectId, insertTarget(projectId), "runner-11");
    const past = new Date(Date.now() - 1_000).toISOString() as Instant;
    unwrap(await ask("candidate.request", {
      projectId,
      idempotencyKey: "4b6d8f0a-2c4e-4a6d-8f0a-2c4e6a8f0b24",
      request: { blueprintId, deadlineAt: past },
    }, inspector));

    const turn = await worker.runJobs();
    expect(turn.ok).toBe(true);
    if (!turn.ok) return;
    expect(turn.value.kind).toBe("failed");
    const row = jobRecordSchema.parse(unwrap(await ask("job.get", { projectId, jobId: asId((turn.value as { jobId: string }).jobId) })));
    expect(row.state).toBe("failed");
    const error = row.error;
    expect(error).not.toBeNull();
    if (error === null) return;
    // §11's own words for this: the wait budget, not the Builder, ended the job.
    expect(error.message).toBe("deadline-expired");
    expect(error.code).toBe("RESOURCE_LIMIT");
    expect(error.retryable).toBe(false);
  });

  // §14's rule at the one place it can be broken quietly: a worker started against a profile name
  // with no file behind it has no attempt budget, and the honest answer is a refusal. The rig is a
  // second boot in a directory of its own because the profile is process configuration, not a
  // per-request field, and no request can change it.
  it("refuses to invent a budget when the installed profile name matches nothing", async () => {
    const otherDir = await mkdtemp(path.join(tmpdir(), "rea-wb-noprofile-"));
    mkdirSync(path.join(otherDir, "profiles"), { recursive: true });
    const { chmodSync } = await import("node:fs");
    chmodSync(otherDir, 0o700);
    const socket = path.join(otherDir, "broker.sock");
    const listener = net.createServer();
    listener.on("connection", (entry) => entry.destroy());
    await new Promise<void>((resolve) => listener.listen({ path: socket, exclusive: true }, () => resolve()));
    const entry = path.join(otherDir, "rea-entry.mjs");
    writeFileSync(entry, "// placeholder entry\n");

    const second = await bootWorker({
      env: {
        WB_HOST: "127.0.0.1",
        WB_PORT: "4320",
        WB_DATA_DIR: otherDir,
        WB_REA_ENTRYPOINT: entry,
        WB_MODEL_ENDPOINT: "http://127.0.0.1:9977/v1",
        WB_SANDBOX_PROFILE: "profile-without-a-file",
        WB_BROKER_SOCKET: socket,
      },
      installedDefaults: {},
      profileDir: path.join(otherDir, "infra", "profiles"),
      toolchain: { nodeVersion: "24.18.0", requiredNodeVersion: "24.18.0" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    try {
      const created = unwrap(await second.value.dispatch("project.create", { name: "no-profile" }, inspector)) as { id: string };
      const projectId = asId(created.id);
      const asked = await second.value.dispatch(
        "candidate.request",
        { projectId, idempotencyKey: "5c7e9f1b-3d5f-4a7c-9e1b-3d5f7a9c1e35", request: { blueprintId: newId() } },
        inspector,
      );
      expect(asked.ok).toBe(false);
      if (asked.ok) return;
      expect(asked.error.code).toBe("CAPABILITY_UNAVAILABLE");
      expect(asked.error.reason).toBe("generation-budget-unknown");

      // The same guard one step later, where it is not the door's: a `build` row that was already in
      // the queue when the profile went away. The runner re-reads the budget per turn, so the row
      // stops with that name rather than running uncapped or being tried again forever.
      const queued = newId();
      const at = new Date().toISOString() as Instant;
      const inserted = second.value.writeConnection.transact((tx) => {
        tx.insertJob({
          id: queued,
          projectId,
          targetId: null,
          kind: "build",
          state: "queued",
          cleanupState: "pending",
          inputJson: { blueprintId: newId() },
          resultRef: null,
          errorJson: null,
          idempotencyKey: `hand-seeded-${queued}`,
          requestDigest: "a".repeat(64) as Digest,
          deadlineAt: null,
          retryAt: null,
          createdAt: at,
          updatedAt: at,
        });
        return true;
      });
      if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
      const turn = await second.value.runJobs();
      expect(turn.ok).toBe(true);
      if (!turn.ok) return;
      expect(turn.value.kind).toBe("failed");
      const row = jobRecordSchema.parse(
        unwrap(await second.value.dispatch("job.get", { projectId, jobId: queued }, inspector)),
      );
      expect(row.state).toBe("failed");
      expect(row.error?.message).toBe("generation-budget-unknown");
      expect(row.error?.retryable).toBe(true);
    } finally {
      await second.value.shutdown();
      listener.close();
      await rm(otherDir, { recursive: true, force: true });
    }
  });
});

describe("nothing may ask the worker to run its own queue", () => {
  it("keeps the runner off the command surface and inside the process", () => {
    // A client that could trigger a run could choose *when* the budget is spent and which profile
    // numbers apply, so the runner is reached only from the worker's own loop.
    const executable = COMMAND_NAMES.filter((name) => /^jobs?\.(run|pump|claim|execute)$/.test(name));
    expect(executable).toEqual([]);
    // The name issue #57 retired: no command may take a job id from a caller any more.
    expect(COMMAND_NAMES).not.toContain("candidate.generate");
    const main = readFileSync(new URL("../../apps/worker/main.ts", import.meta.url), "utf8");
    expect(main).toContain("await worker.runJobs();");
    // The in-flight turn settles before the sockets close: cutting it off mid-generation is how a
    // job ends up `interrupted` when the work actually finished.
    expect(main.indexOf("await pumping;")).toBeLessThan(main.indexOf("await started.value.close();"));
  });
});

// The adapter ABI §7.3 fixes is `invoke(operationId, sdkInput, {baseUrl})`. Until this block nothing
// had ever **run** a generated candidate: the file list, the digests and the manifest were all
// asserted, and the README said out loud that "the SDK really can be called" was not a proven fact.
// Running it is the difference, and the first run found a defect no assertion could see - the emitted
// code passed `body` on every method, so a generated GET died inside `fetch`
// (`Request with GET/HEAD method cannot have body`) before a byte left the process.
//
// Everything below therefore loads the bytes the *read door* hands back (`candidate.file`, the same
// path the 代码 tab uses), writes them to a real ESM module, imports that, and calls it against a
// loopback HTTP server that records what actually arrived.
describe("the generated adapter is executed, not just hashed (§7.3's adapter ABI)", () => {
  type LoadedAdapter = { invoke: (operationId: string, sdkInput: Record<string, unknown>, context: { baseUrl: string }) => Promise<unknown> };
  type Seen = { method: string; url: string; body: string; contentType: string | undefined };

  async function generatedAdapter(name: string, withPost: boolean): Promise<{ source: string; manifest: Record<string, unknown>; sha256: string }> {
    await drainQueue();
    const projectId = await newProject(name);
    const blueprintId = await seedBlueprint(projectId, insertTarget(projectId), name, withPost);
    unwrap(await askForCandidate(projectId, blueprintId, newId()));
    const turn = await worker.runJobs();
    if (!turn.ok) throw new Error(JSON.stringify(turn.error));
    if (turn.value.kind !== "succeeded") throw new Error(`the build did not succeed: ${turn.value.kind}`);
    // Hoisted, not read through the closure below: TypeScript drops the `succeeded` narrowing inside a
    // nested function, and re-checking the discriminant in three places is how a copy starts drifting.
    const candidateId = turn.value.candidateId;
    const view = unwrap(await ask("candidate.get", { projectId, request: { candidateId } })) as {
      files: { id: string; path: string }[];
    };
    const read = async (wanted: string): Promise<{ content?: string; sha256?: string }> => {
      const file = view.files.find((entry) => entry.path === wanted);
      if (file === undefined) throw new Error(`${wanted} is not in the candidate`);
      return unwrap(await ask("candidate.file", { projectId, request: { candidateId, fileId: asId(file.id) } })) as { content?: string; sha256?: string };
    };
    const adapter = await read("adapter.ts");
    const manifest = await read("candidate-manifest.json");
    if (typeof adapter.content !== "string" || typeof adapter.sha256 !== "string") throw new Error("the adapter read lost its content or digest");
    return { source: adapter.content, sha256: adapter.sha256, manifest: JSON.parse(String(manifest.content)) as Record<string, unknown> };
  }

  async function load(source: string, stem: string): Promise<{ module: LoadedAdapter; exports: string[] }> {
    const dir = await mkdtemp(path.join(tmpdir(), `rea-wb-adapter-${stem}-`));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const file = path.join(dir, "adapter.ts");
    writeFileSync(file, source);
    const { pathToFileURL } = await import("node:url");
    const loaded = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const invoke = loaded["invoke"];
    if (typeof invoke !== "function") throw new Error("the candidate exports no callable invoke");
    return {
      module: { invoke: invoke as LoadedAdapter["invoke"] },
      exports: Object.keys(loaded).sort(),
    };
  }

  async function withStub(onRequest: (seen: Seen) => { status: number; body: unknown }): Promise<{ baseUrl: string; seen: Seen[]; close: () => Promise<void> }> {
    const http = await import("node:http");
    const seen: Seen[] = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const entry: Seen = { method: String(request.method), url: String(request.url), body, contentType: request.headers["content-type"] };
        seen.push(entry);
        const answer = onRequest(entry);
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => { server.listen({ host: "127.0.0.1", port: 0 }, () => resolve()); });
    const address = server.address() as { port: number };
    return {
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      seen,
      close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
    };
  }

  it("runs a reviewed GET and returns what the server answered", async () => {
    const generated = await generatedAdapter("exec-get", false);
    const stub = await withStub(() => ({ status: 200, body: { items: ["widget", "gizmo"], include: "items" } }));
    const { module: adapter } = await load(generated.source, "get");
    try {
      const outcome = await adapter.invoke("getCart", {}, { baseUrl: stub.baseUrl });
      // The value came off the wire: an assertion on a literal the test itself served would be true
      // whatever the adapter did.
      expect(outcome).toEqual({ items: ["widget", "gizmo"], include: "items" });
      expect(stub.seen).toEqual([{ method: "GET", url: "/api/cart/42", body: "", contentType: undefined }]);
    } finally {
      await stub.close();
    }
  });

  it("runs a reviewed POST with the input as its JSON body, typed as such", async () => {
    const generated = await generatedAdapter("exec-post", true);
    const stub = await withStub(() => ({ status: 201, body: { added: true } }));
    const { module: adapter } = await load(generated.source, "post");
    try {
      const outcome = await adapter.invoke("addCartItem", { sku: "A-1", quantity: 2 }, { baseUrl: stub.baseUrl });
      expect(outcome).toEqual({ added: true });
      expect(stub.seen).toHaveLength(1);
      const request = stub.seen[0];
      expect(request?.method).toBe("POST");
      expect(request?.url).toBe("/api/cart/items");
      // Parsed back rather than compared as text: the point is that the input survives the round trip,
      // and a byte-for-byte string check would also pin key order nobody promised.
      expect(JSON.parse(String(request?.body))).toEqual({ sku: "A-1", quantity: 2 });
      expect(request?.contentType).toBe("application/json");
    } finally {
      await stub.close();
    }
  });

  it("refuses to lose part of the input on a method that carries no body, without reaching the network", async () => {
    const generated = await generatedAdapter("exec-get-refused", false);
    const stub = await withStub(() => ({ status: 200, body: {} }));
    const { module: adapter } = await load(generated.source, "getrefused");
    try {
      // Dropping `include` and answering 200 would be worse than the crash this replaces: the caller
      // would believe a reviewed input was sent. So the named refusal is the assertion, and so is the
      // empty `seen` - the mistake has to die in the process, not on the wire.
      const message = await adapter.invoke("getCart", { include: "items" }, { baseUrl: stub.baseUrl }).then(
        () => "resolved - it silently dropped the input",
        (error: unknown) => String((error as Error).message),
      );
      expect(message).toContain("can carry no request body");
      expect(message).toContain("getCart");
      expect(message).toContain("1 field");
      expect(stub.seen).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("sends the method exactly as the reviewed contract stated it, on the request line", async () => {
    // The stub server above cannot see this: Node's HTTP parser hands `req.method` back upper-cased
    // whatever the client sent, so a generator that lower-cased `GET` looked fine to every test here
    // while a proxy in front of a real target would answer 501 (RFC 9110 makes method names
    // case-sensitive). So this one reads the bytes off the socket instead of a parsed request.
    const generated = await generatedAdapter("exec-raw", false);
    const net = await import("node:net");
    const lines: string[] = [];
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        lines.push(String(chunk).split("\r\n")[0] ?? "");
        socket.end("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}");
      });
    });
    await new Promise<void>((resolve) => { server.listen({ host: "127.0.0.1", port: 0 }, () => resolve()); });
    const address = server.address() as { port: number };
    const { module: adapter } = await load(generated.source, "raw");
    try {
      await adapter.invoke("getCart", {}, { baseUrl: `http://127.0.0.1:${String(address.port)}` });
      expect(lines).toEqual(["GET /api/cart/42 HTTP/1.1"]);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  it("keeps the manifest's declared ABI and operation list exactly as wide as what really runs", async () => {
    const generated = await generatedAdapter("exec-abi", true);
    const abi = generated.manifest["adapterAbi"] as { export?: string; parameters?: string[] } | undefined;
    const declared = generated.manifest["operationIds"] as string[];
    expect(abi?.export).toBe("invoke");
    expect(abi?.parameters).toEqual(["operationId", "sdkInput", "context"]);
    const stub = await withStub(() => ({ status: 200, body: { ok: true } }));
    const { module: adapter, exports } = await load(generated.source, "abi");
    try {
      // The manifest says three parameters; the function that answers has that arity. This is what
      // "the candidate provides a fixed adapter ABI" (§7.3) has to mean beyond a text field.
      expect(exports).toEqual(["invoke"]);
      expect(adapter.invoke.length).toBe(3);
      // Every declared id is callable...
      for (const operationId of declared) {
        await adapter.invoke(operationId, {}, { baseUrl: stub.baseUrl });
      }
      // The manifest sorts its operation ids (one order for the same candidate, whatever order the
      // contract revision listed them in), so the calls happen in that order - asserted rather than assumed.
      expect(declared).toEqual(["addCartItem", "getCart"]);
      expect(stub.seen.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /api/cart/items", "GET /api/cart/42"]);
      // ...and one that is not, is refused by name without touching the base URL at all.
      const message = await adapter.invoke("deleteCart", {}, { baseUrl: stub.baseUrl }).then(
        () => "resolved",
        (error: unknown) => String((error as Error).message),
      );
      expect(message).toBe("operation deleteCart is not part of the reviewed contract");
      expect(stub.seen).toHaveLength(2);
    } finally {
      await stub.close();
    }
  });
});

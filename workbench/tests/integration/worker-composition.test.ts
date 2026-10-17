import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asId, newId } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { bootWorker, COMMAND_NAMES } from "../../apps/worker/composition.ts";
import { parseFrame, startWorkerRpc } from "../../apps/worker/rpc-server.ts";
import { Terminal } from "../../apps/worker/terminal.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type { Result } from "../../packages/domain/result.ts";

// The worker composition root, its local RPC and the boundaries that make them
// safe to expose (DESIGN §2, §3, §11, §12.1, §14; issue #16).

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const inspector: Actor = { actorId: "local-operator", actorKind: "inspector" };
const builder: Actor = { actorId: "builder-agent", actorKind: "builder" };
const evaluator: Actor = { actorId: "trusted-evaluator", actorKind: "evaluator" };

// The worker's whole command surface, written out here so a reviewer sees a new name
// as an edit to a boundary rather than as a line in a handler table (DESIGN §14).
const EXPECTED_COMMANDS: readonly string[] = [
  "project.create",
  "project.get",
  "projects.list",
  "capture.importHar",
  "target.create",
  "target.read",
  "job.get",
  "jobs.list",
  "job.cancel",
  "job.cleanupRetry",
  "audit.list",
  "audit.listGlobal",
  "evidence.get",
  "vector.create",
  "vector.read",
  "vector.list",
  "vector.review",
  "contract.create",
  "contract.review",
  "contract.read",
  "plan.build",
  "plan.review",
  "plan.read",
  "verification.read",
  "verification.request",
  "verification.complete",
  "blueprint.freeze",
  "blueprint.handoff",
  "blueprint.manifest",
  "blueprint.read",
  "candidate.request",
  "export.create",
  "export.download",
  "export.list",
  "graph.read",
  "candidate.get",
  "candidate.file",
  "health.effectiveProfiles",
  "doctor.run",
  "jobs.recover",
  "session.pair",
  "session.read",
  "session.revoke",
  "events.after",
];

let dataDir: string;
let packageRoot: string;
let brokerSocket: string;
let reaEntrypoint: string;
let brokerListener: net.Server;
type Handle = Awaited<ReturnType<typeof bootWorker>> extends Result<infer T, unknown> ? T : never;
let worker: Handle;
const startedPeers: { close: () => Promise<void> }[] = [];

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
      queueWaitMs: 30000,
      timeoutMs: 120000,
      maxGenerationAttempts: 3,
    },
    networkPolicyId: "deny-egress",
  };
}

// The broker's own socket is held open for the whole run: the resolver checks
// that the path *is* a socket, and node removes a socket file when its listener
// closes, so a short-lived probe would leave the path absent.
async function holdSocket(target: string): Promise<net.Server> {
  const server = net.createServer();
  server.on("connection", (socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen({ path: target, exclusive: true }, () => resolve()));
  return server;
}

function env(): Record<string, string | undefined> {
  return {
    WB_HOST: "127.0.0.1",
    WB_PORT: "4310",
    WB_DATA_DIR: dataDir,
    WB_REA_ENTRYPOINT: reaEntrypoint,
    WB_MODEL_ENDPOINT: "",
    WB_SANDBOX_PROFILE: "har-capture",
    WB_BROKER_SOCKET: brokerSocket,
  };
}

function request(name: string, payload: JsonValue, actor: Actor): Promise<Result<JsonValue, GateFailure>> {
  return worker.dispatch(name, payload, actor);
}

function unwrap<T>(result: Result<T, GateFailure>): T {
  if (!result.ok) throw new Error(`${result.error.code}:${result.error.reason}:${result.error.message}`);
  return result.value;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "rea-wb-worker-"));
  // Private, or the boot resolver refuses it on purpose.
  mkdirSync(path.join(dataDir, "profiles"), { recursive: true });
  const { chmodSync, statSync } = await import("node:fs");
  chmodSync(dataDir, 0o700);
  expect(statSync(dataDir).mode & 0o077).toBe(0);

  packageRoot = path.join(dataDir, "package");
  mkdirSync(path.join(packageRoot, "infra", "profiles"), { recursive: true });
  mkdirSync(path.join(packageRoot, "infra", "config"), { recursive: true });
  writeFileSync(path.join(packageRoot, "infra", "profiles", "har-capture.json"), JSON.stringify(profileJson()));
  writeFileSync(
    path.join(packageRoot, "infra", "config", "installed-defaults.json"),
    JSON.stringify({ WB_PORT: 4311, WB_SANDBOX_PROFILE: "har-capture" }),
  );
  reaEntrypoint = path.join(dataDir, "rea-entry.mjs");
  writeFileSync(reaEntrypoint, "// placeholder identity file; the real entrypoint is FIXTURE\n");
  brokerSocket = path.join(dataDir, "broker.sock");
  brokerListener = await holdSocket(brokerSocket);

  const booted = await bootWorker({
    env: { ...env(), WB_PORT: "4312" },
    installedDefaults: {},
    profileDir: path.join(packageRoot, "infra", "profiles"),
    toolchain: { nodeVersion: "24.18.0", requiredNodeVersion: "24.18.0" },
  });
  if (!booted.ok) throw new Error(JSON.stringify(booted.error));
  worker = booted.value;
});

afterAll(async () => {
  await new Promise<void>((resolve) => brokerListener.close(() => resolve()));
  await worker.shutdown();
  await Promise.all(startedPeers.map((peer) => peer.close()));
  await rm(dataDir, { recursive: true, force: true });
});

describe("composition root refuses to start unsafely (DESIGN §14)", () => {
  it("reports config failures by field and reason", async () => {
    const booted = await bootWorker({
      env: { ...env(), WB_HOST: "0.0.0.0", WB_DATA_DIR: dataDir },
      installedDefaults: {},
      profileDir: path.join(packageRoot, "infra", "profiles"),
      toolchain: { nodeVersion: "24.18.0", requiredNodeVersion: "24.18.0" },
    });
    expect(booted.ok).toBe(false);
    if (booted.ok) return;
    expect(booted.error.kind).toBe("config");
    expect(booted.error.reasons.join(",")).toContain("WB_HOST:only-the-loopback-literal-is-accepted");
  });

  it("loses to the process that already holds the worker lock", async () => {
    const second = await bootWorker({
      env: env(),
      installedDefaults: {},
      profileDir: path.join(packageRoot, "infra", "profiles"),
      toolchain: { nodeVersion: "24.18.0", requiredNodeVersion: "24.18.0" },
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe("lock");
  });

  it("applies migrations once and reports the installed profile without a host path", async () => {
    const report = await worker.doctor();
    expect(report.ready).toBe(true);
    expect(report.degraded).toBe(true);
    const names = report.checks.map((check) => check.name);
    // Two different checks must not answer to the same name: the lookup below finds the
    // first of them and the second would be unreadable from the terminal.
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("storage-layout");
    const storage = report.checks.find((check) => check.name === "storage-layout");
    const sandbox = report.checks.find((check) => check.name === "sandbox-profile");
    if (storage === undefined || sandbox === undefined) throw new Error("doctor omitted a required check");
    // Exact, not a subset: the layout check is where the boot-time reclaim of an orphaned
    // Builder role run is reported, and a fact that silently disappears from a doctor report
    // is how a leftover staging directory stops being anybody's business.
    expect(storage.facts).toEqual({ migrationsApplied: 7, sweptRoleRuns: 0 });
    expect(sandbox.state).toBe("degraded");
    expect(JSON.stringify(report)).not.toContain(dataDir);
  });
});

describe("named commands and the local RPC (§14)", () => {
  it("exposes only the registered commands", async () => {
    expect(worker.commands).toEqual([...COMMAND_NAMES]);
    // §14 makes the command table a boundary: a new name has to be written down here
    // as well, so a handler cannot become reachable without a reviewer noticing.
    expect([...COMMAND_NAMES].sort()).toEqual([...EXPECTED_COMMANDS].sort());
    const unknown = await request("sql.exec", { statement: "SELECT 1" }, inspector);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.reason).toBe("unknown-command");
  });

  it("creates and reads a project through the RPC socket", async () => {
    const started = await startWorkerRpc(worker);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    startedPeers.push(started.value);

    const reply = await roundTrip(started.value.socketPath, [
      { id: 1, command: "project.create", payload: { name: "cart" }, actor: inspector },
    ]);
    expect(reply[0]?.["ok"]).toBe(true);
    const created = reply[0]?.["value"] as { id: string };
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    const read = await roundTrip(started.value.socketPath, [
      { id: 2, command: "project.get", payload: { projectId: created.id }, actor: inspector },
    ]);
    const first = read[0];
    if (first === undefined) throw new Error("no reply arrived for project.get");
    expect((first["value"] as { name: string } | undefined)?.name).toBe("cart");

    await started.value.close();
  });

  it("refuses malformed frames before they reach a handler", async () => {
    expect(parseFrame("not json").ok).toBe(false);
    expect(parseFrame('{"id":1,"command":"project.get","payload":{}}').ok).toBe(false);
    expect(
      parseFrame('{"id":1,"command":"project.get","payload":{},"actor":{"actorId":"x","actorKind":"wizard"}}').ok,
    ).toBe(false);
    const ok = parseFrame('{"id":1,"command":"project.get","payload":{},"actor":{"actorId":"x","actorKind":"inspector"}}');
    expect(ok.ok).toBe(true);
  });

  it("keeps a builder away from the control-plane commands it has no right to", async () => {
    const created = unwrap(await request("project.create", { name: "cart-2" }, inspector)) as { id: string };
    const projectId = asId(created.id);
    const listed = await request("vector.list", { projectId, request: { targetId: newId() } }, builder);
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error.code).toBe("ACCESS_DENIED");
    const handed = await request("blueprint.handoff", { projectId, blueprintId: newId() }, builder);
    expect(handed.ok).toBe(false);
    if (handed.ok) return;
    // Handoff itself is the one Builder read path; it fails here for an unknown
    // blueprint, not for the actor.
    expect(handed.error.reason).toBe("blueprint-unknown");
  });

  it("answers the contract and report reads for the control plane and refuses a Builder by name (§8 lines 288, 298)", async () => {
    const created = unwrap(await request("project.create", { name: "read-commands" }, inspector)) as { id: string };
    const projectId = asId(created.id);
    const cases = [
      { command: "contract.read", key: "contractId", reason: "builder-has-no-contract-permission" },
      { command: "verification.read", key: "verificationId", reason: "builder-may-not-read-report" },
    ] as const;
    for (const one of cases) {
      const refused = await request(one.command, { projectId, [one.key]: newId() }, builder);
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.code).toBe("ACCESS_DENIED");
      // The named reason, not a generic one: the page's disabled control quotes it, and a
      // paraphrase here would make two spellings of one §7.3 boundary.
      expect(refused.error.reason).toBe(one.reason);
      // The same command for the control plane gets past the role gate and into the lookup, so
      // the refusal above cannot be a missing row wearing the role's clothes.
      const looked = await request(one.command, { projectId, [one.key]: newId() }, inspector);
      expect(looked.ok).toBe(false);
      if (looked.ok) continue;
      expect(looked.error.code).toBe("NOT_FOUND");
    }
  });

  it("keeps the project page off every role but the control plane (§8 line 270)", async () => {
    const refused = await request("projects.list", { request: {} }, builder);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("ACCESS_DENIED");
    expect(refused.error.reason).toBe("role-may-not-list-projects");
    // The same command for the local operator answers, so the refusal is the role rule.
    const listed = unwrap(await request("projects.list", { request: { limit: 1 } }, inspector)) as { items: unknown[]; nextCursor: string | null };
    expect(Array.isArray(listed.items)).toBe(true);
  });

  it("refuses the two lifecycle commands for a Builder and answers them for the control plane (§8 lines 278-279)", async () => {
    const created = unwrap(await request("project.create", { name: "lifecycle-roles" }, inspector)) as { id: string };
    const projectId = asId(created.id);
    for (const one of [
      { command: "job.cancel", reason: "role-may-not-cancel-jobs" },
      { command: "job.cleanupRetry", reason: "role-may-not-retry-cleanup" },
    ] as const) {
      const refused = await request(one.command, { projectId, jobId: newId() }, builder);
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.code).toBe("ACCESS_DENIED");
      expect(refused.error.reason).toBe(one.reason);
      // The same command for a control-plane role gets past the gate and into the lookup, so the
      // refusal above is the role rule rather than a missing row.
      const looked = await request(one.command, { projectId, jobId: newId() }, inspector);
      expect(looked.ok).toBe(false);
      if (looked.ok) continue;
      expect(looked.error.code).toBe("NOT_FOUND");
    }
  });

  // §8 line 297's key is enforced here rather than only at the HTTP gate, because the jobs row's
  // own uniqueness lives on this side of the socket: an unkeyed frame would write an empty key
  // that every later unkeyed request collides with.
  it("refuses an unkeyed verification request at the command boundary (§8 line 297)", async () => {
    const created = unwrap(await request("project.create", { name: "verify-key" }, inspector)) as { id: string };
    const projectId = asId(created.id);
    const base: Record<string, JsonValue> = {
      projectId,
      request: { candidateId: newId(), comparatorPolicyId: "exact-http-v1" },
    };
    for (const key of ["", "x".repeat(201)]) {
      const refused = await request("verification.request", { ...base, idempotencyKey: key }, inspector);
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.code).toBe("INVALID_INPUT");
      expect(refused.error.reason).toBe("idempotency-key-required");
    }
    const nameless = await request("verification.request", base, inspector);
    expect(nameless.ok).toBe(false);
    if (nameless.ok) return;
    expect(nameless.error.reason).toBe("idempotency-key-required");
    // With a key the very same frame reaches the service's own question about the candidate, so
    // the refusals above are the key rule and not a missing row wearing the key's clothes.
    const keyed = await request("verification.request", { ...base, idempotencyKey: "key-composition" }, inspector);
    expect(keyed.ok).toBe(false);
    if (keyed.ok) return;
    expect(keyed.error.reason).toBe("candidate-unknown");
    // The Builder is refused by the service, and for its own named reason.
    const builders = await request("verification.request", { ...base, idempotencyKey: "key-builder" }, builder);
    expect(builders.ok).toBe(false);
    if (builders.ok) return;
    expect(builders.error.code).toBe("ACCESS_DENIED");
    expect(builders.error.reason).toBe("role-may-not-request-verification");
  });

  it("marks a lost executor interrupted and keeps its evidence", async () => {
    const created = unwrap(await request("project.create", { name: "recovery" }, inspector)) as { id: string };
    const projectId = asId(created.id);
    const inserted = workerInsertRunningJob(projectId);
    expect(inserted).toBe(true);
    const recovered = unwrap(await request("jobs.recover", { projectId }, inspector)) as {
      interruptedJobIds: string[];
      unprovableLeaseIds: string[];
    };
    expect(recovered.interruptedJobIds.length).toBe(1);
    expect(recovered.unprovableLeaseIds).toEqual([]);
    const after = worker.writeConnection.transact((tx) => tx.listJobsByStates(["interrupted"], 50));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.length).toBe(1);
    expect(after.value[0]?.id).toBe(RECOVERY_JOB_ID);
    // The lease it left behind is still owned and still pending: recovery marks
    // the executor lost, it does not clean up on a guess.
    const lease = worker.writeConnection.transact((tx) => tx.getLeaseByJob(projectId, RECOVERY_JOB_ID));
    if (!lease.ok || lease.value === null) throw new Error("lease missing");
    expect(lease.value.cleanupState).toBe("pending");

    // The mark is a fact §13 has to carry, not just a row this process re-reads: recovery runs in a
    // process whose subscribers were open before the crash, so the outbox is the only thing that can
    // tell them the row moved (issue #85).
    const events = worker.writeConnection.transact((tx) => tx.eventsAfter(projectId, 0, 10));
    if (!events.ok) throw new Error(JSON.stringify(events.error));
    const announced = events.value
      .filter((row) => row.type === "job.updated" && row.aggregateId === RECOVERY_JOB_ID)
      // The port types `payloadJson` as a JsonValue, so naming the state has to say which shape the
      // read expects instead of assuming the column is an object.
      .map((row) => (row.payloadJson !== null && typeof row.payloadJson === "object" && !Array.isArray(row.payloadJson) ? row.payloadJson["state"] : null));
    expect(announced).toEqual(["interrupted"]);
  });

  // §8 line 294 as issue #57 redrew it: the request may name a blueprint and at most a deadline, and
  // every fact the old `candidate.generate` command took from the caller - a job id, a budget, a
  // generator - is now a name this schema has no field for. This rig declares no model endpoint, so
  // what it can prove is the *order*: the key, then the deployment's own capability, and only then
  // the service's questions about actor and shape. The refusals that sit behind the capability are
  // asserted in `candidate-generation.test.ts`, which boots a worker with an endpoint. Saying which
  // check runs first is the point: a door that answered "your body is malformed" while generation is
  // off would be sending an operator to fix the wrong thing.
  it("refuses a generation request at the declared capability, in the stated order (§3, §8 line 261)", async () => {
    const created = unwrap(await request("project.create", { name: "build-1" }, inspector)) as { id: string };
    const projectId = asId(created.id);
    const key = "2f2a3c1e-7d5b-4e2a-9f1c-6b8d3e5a7c01";

    const noKey = await request("candidate.request", { projectId, request: { blueprintId: newId() } }, inspector);
    expect(noKey.ok).toBe(false);
    if (noKey.ok) return;
    expect(noKey.error.reason).toBe("idempotency-key-required");

    const off = await request("candidate.request", { projectId, idempotencyKey: key, request: { blueprintId: newId() } }, inspector);
    expect(off.ok).toBe(false);
    if (off.ok) return;
    expect(off.error.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(off.error.reason).toBe("generation-endpoint-not-configured");

    // The same answer for a body that would otherwise be refused by name: the capability is not
    // behind a blueprint lookup either, so nothing is read before the deployment says it cannot run.
    const forged = await request(
      "candidate.request",
      { projectId, idempotencyKey: key, request: { blueprintId: newId(), jobId: newId(), budget: { maxAttemptsPerBlueprint: 9 } } },
      inspector,
    );
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.error.reason).toBe("generation-endpoint-not-configured");
  });

  // §10's 具名 completion RPC, given a name (issue #75). An evaluator is not a browser, so §8's 40
  // routes have no line for it and the closed command table *is* its wire surface. What is provable
  // from here is the two things that were missing: that the name exists, and that the roles stay
  // outside it - the service answers for the rest (comparator policy, transcript re-hash, identity
  // binding), and its own suite covers those rules.
  it("names the evaluator's completion and keeps every other role out of it (§10)", async () => {
    const created = unwrap(await request("project.create", { name: "verify-completion" }, inspector)) as { id: string };
    const projectId = asId(created.id);

    // The role rule runs before the schema: the same well-formed-looking body from a builder is
    // refused for who sent it, not for what it typed, and the two refusals must not be confusable.
    const builderRole = await request("verification.complete", { projectId, request: { candidateId: newId() } }, builder);
    expect(builderRole.ok).toBe(false);
    if (builderRole.ok) return;
    expect(builderRole.error.code).toBe("ACCESS_DENIED");
    expect(builderRole.error.reason).toBe("builder-may-not-record-a-verification");

    const inspectorRole = await request("verification.complete", { projectId, request: {} }, inspector);
    expect(inspectorRole.ok).toBe(false);
    if (inspectorRole.ok) return;
    expect(inspectorRole.error.reason).toBe("only-the-evaluator-records-a-verification");

    // The evaluator reaches the schema. A body missing every required field is refused with the names
    // of what is absent...
    const empty = await request("verification.complete", { projectId, request: {} }, evaluator);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.code).toBe("INVALID_INPUT");
    expect(empty.error.reason).toBe("completion-schema");
    expect(JSON.stringify(empty.error.details)).toContain("candidateId");

    // ...and one that has all of them plus a key §10 does not name is refused for the extra key:
    // §7.3's handoff is the whole input, so a completion carrying an unlisted field (here a
    // self-declared verdict) is rejected by name rather than ignored or honoured.
    const whole = {
      candidateId: newId(),
      jobId: newId(),
      blueprintId: newId(),
      planId: newId(),
      comparatorPolicyId: "exact-http-v1",
      runnerImageDigest: "1".repeat(64),
      observations: [],
      reportStagingId: "12345678-1234-1234-1234-123456789012",
      reportSha256: "2".repeat(64),
      limitations: [],
      nonsense: "self-declared",
    };
    const extra = await request("verification.complete", { projectId, request: whole }, evaluator);
    expect(extra.ok).toBe(false);
    if (extra.ok) return;
    expect(extra.error.reason).toBe("completion-schema");
    expect(JSON.stringify(extra.error.details)).toContain("nonsense");
  });

  // The absence this issue is about has to be sayable: a `verify` row sits in the queue and nothing
  // in this build takes it (the runner's kind list is deliberately `build` only). The doctor is the
  // surface for "this capability is not here", and it must not warn about work nobody is waiting on.
  it("says out loud when a queued verification has no executor (§10, issue #75)", async () => {
    const quiet = (await worker.doctor()).checks.find((check) => check.name === "verification-executor");
    expect(quiet?.state).toBe("ok");
    expect(quiet?.facts).toEqual({ queuedVerifyCount: 0 });

    const created = unwrap(await request("project.create", { name: "verify-waiting" }, inspector)) as { id: string };
    const projectId = asId(created.id);
    const jobId = newId();
    const at = new Date().toISOString() as Instant;
    // A queued `build` row is not waiting on an evaluator - that one has an executor since #57 - so
    // it goes in first and the check has to stay quiet past it. Without this the warning would be
    // "there are queued jobs", which is a different claim than the one §10 needs made.
    const buildJob = newId();
    const seeded = worker.writeConnection.transact((tx) => {
      tx.insertJob({
        id: buildJob,
        projectId,
        targetId: null,
        kind: "build",
        state: "queued",
        cleanupState: "pending",
        inputJson: { blueprintId: newId() },
        resultRef: null,
        errorJson: null,
        idempotencyKey: `build-${buildJob}`,
        requestDigest: ("6".repeat(64)) as Digest,
        deadlineAt: null,
        retryAt: null,
        createdAt: at,
        updatedAt: at,
      });
      return true;
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const stillQuiet = (await worker.doctor()).checks.find((check) => check.name === "verification-executor");
    expect(stillQuiet?.state).toBe("ok");
    expect(stillQuiet?.facts).toEqual({ queuedVerifyCount: 0 });

    const inserted = worker.writeConnection.transact((tx) => {
      tx.insertJob({
        id: jobId,
        projectId,
        targetId: null,
        kind: "verify",
        state: "queued",
        cleanupState: "pending",
        inputJson: { candidateId: newId(), comparatorPolicyId: "exact-http-v1" },
        resultRef: null,
        errorJson: null,
        idempotencyKey: `verify-${jobId}`,
        requestDigest: ("7".repeat(64)) as Digest,
        deadlineAt: null,
        retryAt: null,
        createdAt: at,
        updatedAt: at,
      });
      return true;
    });
    if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));

    const loud = (await worker.doctor()).checks.find((check) => check.name === "verification-executor");
    expect(loud?.state).toBe("degraded");
    expect(loud?.reasons).toEqual(["verification-executor-not-installed"]);
  });

  it("carries a generation frame through the local RPC and answers with the worker's own refusal", async () => {
    const started = await startWorkerRpc(worker);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const created = unwrap(await request("project.create", { name: "build-2" }, inspector)) as { id: string };
    const replies = await roundTrip(started.value.socketPath, [
      {
        id: 7,
        command: "candidate.request",
        payload: {
          projectId: created.id,
          idempotencyKey: "1b7c9d2e-4a6f-48b0-9c1d-2e4f6a8b0c12",
          request: { blueprintId: newId() },
        },
        actor: { actorId: "local-operator", actorKind: "inspector" },
      },
    ]);
    await started.value.close();
    // The frame is accepted and the refusal that comes back is the service's own, with a named code
    // rather than a transport error.
    expect(replies[0]?.["ok"]).toBe(false);
    const error = replies[0]?.["error"] as { reason?: string } | undefined;
    expect(error?.reason).toBe("generation-endpoint-not-configured");
  });

  it("reads configuration only from the declared names and the installed package", () => {
    const composition = readFileSync(path.join(ROOT, "apps/worker/composition.ts"), "utf8");
    const main = readFileSync(path.join(ROOT, "apps/worker/main.ts"), "utf8");
    const resolver = readFileSync(path.join(ROOT, "packages/application/boot-config.ts"), "utf8");
    // The resolver has no filesystem and no ambient environment at all, so it
    // cannot read a target directory's dotfile: only imports and call sites count,
    // which is why the patterns below are anchored to code shapes, not words.
    for (const pattern of [/^\s*import[^\n]*node:fs/m, /readFileSync\s*\(/, /readdirSync\s*\(/, /process\.env/]) {
      expect(pattern.test(resolver), `boot-config reaches ${String(pattern)}`).toBe(false);
    }
    // The entrypoint reads only the declared names, never the whole environment.
    expect(main).toContain("BOOT_CONFIG_FIELDS");
    expect(composition).toContain("for (const field of BOOT_CONFIG_FIELDS) env[field] = request.env[field]");
    // Structural rather than textual: the process has exactly one file read, and
    // it is the installed package's own defaults file. A target directory cannot
    // be reached because no path from outside the package root is ever opened.
    expect((main.match(/readFileSync\(/g) ?? []).length).toBe(1);
    expect(main).toContain('readJson(path.join(packageRoot, "infra", "config", "installed-defaults.json"))');
    expect((composition.match(/readFileSync\(/g) ?? []).length).toBe(2);
    expect(composition).toContain("readFileSync(path.join(profileDir, name)");
    expect(composition).toContain("readFileSync(target)");
    // The package root has to be a real path, not a URL's percent-encoded pathname: an
    // install under a directory with a space or a CJK name would otherwise resolve to a
    // path that does not exist, `readJson` would return `{}`, and the process would boot
    // with no installed defaults while still printing a pairing code.
    expect(main).toContain('fileURLToPath(new URL("../..", import.meta.url))');
    expect(main).not.toContain("import.meta.url).pathname");
    // The provider child gets an explicit environment, not the ambient one (D21).
    expect(composition).toContain("env: { PATH: ");
  });

  it("prints only filtered lines to the terminal", () => {
    const written: string[] = [];
    const terminal = new Terminal({ writeLine: (text) => written.push(text) });
    terminal.print("rpc", "listening=worker.rpc.sock");
    terminal.print("pair", "Bearer abcdefghijklmnop");
    expect(written).toEqual(["rpc listening=worker.rpc.sock\n"]);
    expect(JSON.stringify(terminal.lines)).not.toContain("abcdefghijklmnop");
  });
});

async function roundTrip(socketPath: string, frames: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const socket = net.connect(socketPath);
  const replies: Record<string, unknown>[] = [];
  const done = new Promise<void>((resolve, reject) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length === 0) continue;
        replies.push(JSON.parse(line) as Record<string, unknown>);
        if (replies.length >= frames.length) resolve();
      }
    });
    socket.on("error", reject);
  });
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  for (const frame of frames) socket.write(`${JSON.stringify(frame)}\n`);
  await Promise.race([
    done,
    new Promise<void>((resolve) => setTimeout(resolve, 4000)),
  ]);
  socket.destroy();
  return replies;
}

let RECOVERY_JOB_ID: Id = newId();

function workerInsertRunningJob(projectId: Id): boolean {
  // A job left `running` by a crashed executor is exactly what recovery must
  // find; it is written through the worker's own connection because no command
  // creates one without going through the state machine.
  const outcome = worker.writeConnection.transact((tx) => {
    const targetId = newId();
    const jobId = RECOVERY_JOB_ID;
    const created = new Date().toISOString();
    tx.insertTarget({
      id: targetId,
      projectId,
      kind: "har",
      originalLocator: null,
      sourceSha256: null,
      sourceArtifactId: null,
      snapshotDigest: null,
      identityReason: "seeded-for-recovery",
      createdAt: created as never,
    });
    tx.insertJob({
      id: jobId,
      projectId,
      targetId,
      kind: "inspect",
      state: "running",
      cleanupState: "pending",
      inputJson: {},
      resultRef: null,
      errorJson: null,
      idempotencyKey: `recovery-${jobId}`,
      requestDigest: ("f".repeat(64)) as never,
      deadlineAt: null,
      retryAt: null,
      createdAt: created as never,
      updatedAt: created as never,
    });
    tx.insertLease({
      id: newId(),
      jobId,
      kind: "har-staging",
      resourceIdentityJson: { storageKey: "projects/x/artifacts/inspector/y.bin" },
      ownershipProofJson: { mintedBy: "har-import", jobId },
      cleanupState: "pending",
      lastErrorJson: null,
      retryAt: null,
      retryCount: 0,
    });
    return true;
  });
  return outcome.ok;
}

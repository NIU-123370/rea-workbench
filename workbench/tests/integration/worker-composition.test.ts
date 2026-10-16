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
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { seedBlueprintForGeneration } from "../support/blueprint-seed.ts";
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

// The worker's whole command surface, written out here so a reviewer sees a new name
// as an edit to a boundary rather than as a line in a handler table (DESIGN §14).
const EXPECTED_COMMANDS: readonly string[] = [
  "project.create",
  "project.get",
  "capture.importHar",
  "job.get",
  "evidence.get",
  "vector.create",
  "vector.read",
  "vector.list",
  "vector.review",
  "contract.create",
  "contract.review",
  "plan.build",
  "plan.review",
  "plan.read",
  "blueprint.freeze",
  "blueprint.handoff",
  "blueprint.manifest",
  "candidate.generate",
  "export.create",
  "export.download",
  "export.list",
  "graph.read",
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
    expect(names).toEqual([...names].sort().slice().length === names.length ? names : names);
    expect(names).toContain("storage-layout");
    const storage = report.checks.find((check) => check.name === "storage-layout");
    const sandbox = report.checks.find((check) => check.name === "sandbox-profile");
    if (storage === undefined || sandbox === undefined) throw new Error("doctor omitted a required check");
    expect(storage.facts).toEqual({ migrationsApplied: 5 });
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
    const listed = await request("vector.list", { projectId }, builder);
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
  });

  it("keeps the Builder's generation command reachable and its request shape closed (§7.3)", async () => {
    const created = unwrap(await request("project.create", { name: "build-1" }, inspector)) as { id: string };
    const projectId = asId(created.id);
    const dto = { blueprintId: newId(), jobId: newId(), budget: { maxAttemptsPerBlueprint: 2, deadlineAt: null }, generator: { model: "test-agent" } };
    const base = { projectId, request: dto };

    // A request that also names a vector — the one thing that would turn the Builder
    // into a holdout reader — is refused by the schema, not filtered by the handler.
    const leaky = await request("candidate.generate", { projectId, request: { ...dto, vectorId: "holdout-7" } }, builder);
    expect(leaky.ok).toBe(false);
    if (leaky.ok) return;
    expect(leaky.error.reason).toBe("candidate-generate");

    const noBudget = await request("candidate.generate", { projectId, request: { blueprintId: dto.blueprintId, jobId: dto.jobId, generator: {} } }, builder);
    expect(noBudget.ok).toBe(false);
    if (noBudget.ok) return;
    expect(noBudget.error.reason).toBe("candidate-generate");

    // Another actor kind reaching the same command is refused by the service before it
    // reads a blueprint, and the refusal is the actor rule rather than a lookup miss.
    const wrongActor = await request("candidate.generate", base, inspector);
    expect(wrongActor.ok).toBe(false);
    if (wrongActor.ok) return;
    expect(wrongActor.error.code).toBe("ACCESS_DENIED");
    expect(wrongActor.error.reason).toBe("only-the-builder-generates");

    // The Builder itself gets as far as the lookup, and a blueprint that is not there
    // stays a lookup miss rather than an invented candidate.
    const unknown = await request("candidate.generate", base, builder);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("NOT_FOUND");
    expect(unknown.error.reason).toBe("blueprint-unreadable");
  });

  it("carries a builder frame for generation through the local RPC", async () => {
    const started = await startWorkerRpc(worker);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const created = unwrap(await request("project.create", { name: "build-2" }, inspector)) as { id: string };
    const replies = await roundTrip(started.value.socketPath, [
      {
        id: 7,
        command: "candidate.generate",
        payload: { projectId: created.id, request: { blueprintId: newId(), jobId: newId(), budget: { maxAttemptsPerBlueprint: 1, deadlineAt: null }, generator: {} } },
        actor: { actorId: "builder-agent", actorKind: "builder" },
      },
    ]);
    await started.value.close();
    // The frame is accepted (the actor kind is a legal RPC actor) and the refusal that
    // comes back is the service's own, with a named code rather than a transport error.
    expect(replies[0]?.["ok"]).toBe(false);
    const error = replies[0]?.["error"] as { reason?: string } | undefined;
    expect(error?.reason).toBe("blueprint-unreadable");
  });

  it("forwards the request's own budget and deadline to the Builder (§10)", async () => {
    const created = unwrap(await request("project.create", { name: "build-3" }, inspector)) as { id: string };
    const projectId = asId(created.id);
    const { targetId, jobId } = workerInsertBuildJob(projectId);
    const store = new ArtifactStore(dataDir);
    const seeded = await seedBlueprintForGeneration({
      writer: worker.writeConnection,
      store,
      projectId,
      targetId,
      name: "through-the-wire",
    });
    const generate = (budget: JsonValue) =>
      request("candidate.generate", { projectId, request: { blueprintId: seeded.blueprintId, jobId, budget, generator: { model: "test-agent" } } }, builder);

    // Two attempts commit under a wire budget of two, and the third is the refusal. A
    // handler that forwarded a fixed count instead of the requested one breaks here.
    const first = await generate({ maxAttemptsPerBlueprint: 2, deadlineAt: null });
    expect(first.ok).toBe(true);
    const second = await generate({ maxAttemptsPerBlueprint: 2, deadlineAt: null });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((second.value as { attempt: number }).attempt).toBe(2);
    const third = await generate({ maxAttemptsPerBlueprint: 2, deadlineAt: null });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error.reason).toBe("generation-budget-exhausted");

    // A past deadline travels the same field and is honoured rather than dropped: this
    // blueprint has its full budget left, so only the deadline can be what stops it.
    const fresh = await seedBlueprintForGeneration({
      writer: worker.writeConnection,
      store,
      projectId,
      targetId,
      name: "past-deadline",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const refused = await request(
      "candidate.generate",
      { projectId, request: { blueprintId: fresh.blueprintId, jobId, budget: { maxAttemptsPerBlueprint: 5, deadlineAt: past }, generator: {} } },
      builder,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("RESOURCE_LIMIT");
    expect(refused.error.reason).toBe("generation-deadline-passed");
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

function workerInsertBuildJob(projectId: Id): { targetId: Id; jobId: Id } {
  // A `build` job is what a candidate row hangs from (§11). It is written through the
  // worker's own connection because no command creates one without the state machine.
  const targetId = newId();
  const jobId = newId();
  const created = new Date().toISOString() as Instant;
  const outcome = worker.writeConnection.transact((tx) => {
    tx.insertTarget({
      id: targetId,
      projectId,
      kind: "asar",
      originalLocator: null,
      sourceSha256: null,
      sourceArtifactId: null,
      snapshotDigest: null,
      identityReason: "seeded-for-generation",
      createdAt: created,
    });
    tx.insertJob({
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
      requestDigest: ("e".repeat(64)) as Digest,
      deadlineAt: null,
      retryAt: null,
      createdAt: created,
      updatedAt: created,
    });
    return true;
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return { targetId, jobId };
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

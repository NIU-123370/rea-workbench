import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import {
  ISOLATION_CONDITIONS,
  MAX_BROKER_FRAME_BYTES,
  brokerResponseSchema,
  encodeBrokerFrame,
} from "../../packages/contracts/sandbox.ts";
import type {
  EgressPolicy,
  SandboxHostFacts,
  SandboxProfileDescriptor,
} from "../../packages/contracts/sandbox.ts";
import { BrokerClient, encodeBrokerRequest } from "../../packages/adapters/sandbox/broker-client.ts";
import { SocketBrokerExchange } from "../../packages/adapters/sandbox/broker-socket.ts";
import { bootBroker, decideBoot } from "../../apps/broker/main.ts";
import { classifyBrokerProbe } from "../../apps/worker/composition.ts";
import type { BrokerBootResult } from "../../apps/broker/main.ts";
import type { HostObservation, OwnedRecord, BrokerEnginePort } from "../../apps/broker/supervision.ts";
import { BROKER_SOCKET_ENV } from "../../apps/broker/main.ts";

// The broker process (§3 line 74, issue #121) over **a real unix socket**. The whole
// isolation line used to be exercised only through an injected fake transport, which is
// how a protocol with no server at all stayed green. Nothing here starts a container:
// the engine is a scripted port, so what this file proves is the shape - the four
// commands, the ownership credential, and the named refusals.

const ALL_CONDITIONS = [...ISOLATION_CONDITIONS];

type EngineScript = {
  startOk: boolean;
  present: boolean;
  running: boolean;
  cancelled: boolean;
  cleaned: boolean;
  cleanFailed: boolean;
};

function unwrap<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  if (result.ok) return result.value;
  throw new Error(JSON.stringify(result.error));
}

function listening(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
}

function writeFrame(socketPath: string, bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const connection = net.connect({ path: socketPath });
    let answer = "";
    connection.setTimeout(2_000, () => {
      connection.destroy();
      reject(new Error("broker-answer-timeout"));
    });
    connection.on("error", () => {
      connection.destroy();
      reject(new Error("broker-socket-error"));
    });
    connection.on("close", () => resolve(answer));
    connection.on("data", (chunk: Uint8Array) => {
      answer += new TextDecoder("utf-8").decode(chunk);
    });
    connection.write(bytes);
  });
}

const profile: SandboxProfileDescriptor = {
  profileId: "web-target",
  schemaVersion: 1,
  limits: {
    cpuCores: 4,
    memoryBytes: 4_000_000_000,
    pids: 256,
    diskBytes: 10_000_000_000,
    maxExpandedBytes: 1_000_000_000,
    queueWaitMs: 30_000,
    timeoutMs: 600_000,
  },
  networkPolicyId: "np-1",
  isolation: {
    nonRoot: true,
    runAsUserId: 1000,
    runAsGroupId: 1000,
    readOnlyRootfs: true,
    noNewPrivileges: true,
    droppedCapabilities: ["ALL"],
    keptCapabilities: [],
    browserSandbox: true,
    privileged: false,
    hostNamespaces: [],
    dockerSocketAccess: false,
    seccomp: { policyId: "p", digest: ("a" as string).repeat(64) as never, verified: true },
  },
  scratch: [{ scratchId: newId(), purpose: "workdir", sizeLimitBytes: 4096, readOnly: false }],
};

const egress: EgressPolicy = { policyId: "np-1", defaultAction: "deny", networkNamespace: "isolated", grants: [] };

const LINUX_HOST: HostObservation = {
  facts: {
    platform: "linux",
    arch: "x64",
    enforcedConditions: ALL_CONDITIONS,
    capacity: { cpuCores: 8, memoryBytes: 8_000_000_000, pids: 512, diskBytes: 20_000_000_000 },
  } satisfies SandboxHostFacts,
  engine: "bwrap",
  reasons: [],
};

function scriptedEngine(script: EngineScript, seen: string[] = []): BrokerEnginePort {
  return {
    name: "bwrap",
    start: (record: OwnedRecord) => {
      seen.push(`start:${record.jobId}`);
      return Promise.resolve(
        script.startOk
          ? { ok: true as const, resourceId: `container-${String(record.handle)}`, enforcedConditions: [...ALL_CONDITIONS] }
          : { ok: false as const, reasons: ["engine-refused-start"], enforcedConditions: [] },
      );
    },
    inspect: () => Promise.resolve({ present: script.present, running: script.running }),
    cancel: () => Promise.resolve({ cancelled: script.cancelled }),
    cleanup: () => Promise.resolve({ done: !script.cleanFailed, failed: script.cleanFailed }),
  };
}

let root = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-broker-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the broker refuses before it listens (§3, §14, D18)", () => {
  it("names the host and the engine it does not have, and creates no socket", async () => {
    const socketPath = path.join(root, "refused.sock");
    const decided = decideBoot({ env: { [BROKER_SOCKET_ENV]: socketPath } });
    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    // This machine is not the one the isolation path was verified on, so the honest
    // answer is a refusal that names both halves of why.
    expect(decided.reasons.some((reason) => reason.startsWith("host-platform-unverified-for-sandbox"))).toBe(true);
    expect(decided.reasons).toContain("no-known-container-engine");
    const booted = bootBroker({ env: { [BROKER_SOCKET_ENV]: socketPath } });
    expect(booted.ok).toBe(false);
    if (booted.ok) return;
    expect(booted.exitCode).toBe(78);
    // Refusing means the file is not there either - a half-started supervisor would be
    // the "假装起来了" this case exists to prevent.
    await expect(writeFrame(socketPath, new TextEncoder().encode("{}\n"))).rejects.toThrow();
  });

  it("refuses each wrong shape of WB_BROKER_SOCKET by name", () => {
    const cases: [string, string][] = [
      ["", "broker-socket-not-declared"],
      ["./relative.sock", "absolute-socket-path-required"],
      ["tcp://127.0.0.1:9999", "tcp-url-is-not-a-broker-socket"],
    ];
    for (const [value, reason] of cases) {
      const decided = decideBoot({ env: { [BROKER_SOCKET_ENV]: value }, host: LINUX_HOST });
      expect(decided.ok, `${value} → ${JSON.stringify(decided)}`).toBe(false);
      if (decided.ok) return;
      expect(decided.reasons).toContain(reason);
    }
  });
});

describe("a real broker answers the four commands over a unix socket (§12.1, §11)", () => {
  let socketPath = "";
  let booted: Extract<BrokerBootResult, { ok: true }>;
  const seen: string[] = [];
  const script: EngineScript = {
    startOk: true,
    present: true,
    running: true,
    cancelled: true,
    cleaned: true,
    cleanFailed: false,
  };

  beforeAll(async () => {
    socketPath = path.join(root, "live.sock");
    const result = bootBroker({
      env: { [BROKER_SOCKET_ENV]: socketPath },
      host: LINUX_HOST,
      engine: scriptedEngine(script, seen),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.reasons));
    booted = result;
    await listening(booted.server);
  });

  afterAll(async () => {
    booted.server.close();
    await new Promise((resolve) => booted.server.once("close", resolve));
  });

  function client(): BrokerClient {
    return new BrokerClient({ exchange: new SocketBrokerExchange({ socketPath }) });
  }

  it("mints one ownership handle per started profile and answers with what it enforces", async () => {
    const jobId = newId();
    const requestId = newId();
    const started = unwrap(await client().startProfile({ command: "startProfile", requestId, jobId, taskId: null, profile, egress }));
    expect(started.status).toBe("started");
    expect(started.handle).not.toBeNull();
    expect(started.refusalReasons).toEqual([]);
    // Re-reported from the supervisor's own list, not echoed back from the request.
    expect(started.enforcedConditions).toEqual(ALL_CONDITIONS);
    expect(started.cleanupState).toBe("pending");
    expect(seen).toContain(`start:${String(jobId)}`);
  });

  it("scopes every follow-up to the job the handle was minted for", async () => {
    const jobId = newId();
    const started = unwrap(await client().startProfile({ command: "startProfile", requestId: newId(), jobId, taskId: null, profile, egress }));
    const handle = started.handle;
    if (handle === null) throw new Error("a started answer needs a handle");

    const mine = unwrap(await client().inspectOwned({ command: "inspectOwned", requestId: newId(), jobId, handle }));
    expect(mine.owned).toBe(true);
    expect(mine.presence).toBe("present");
    expect(mine.exitState).toBe("running");

    // Another job holding the same string proves nothing: the authority is the record,
    // not the token (§11: 不按 PID/path 猜测).
    const foreign = unwrap(await client().inspectOwned({ command: "inspectOwned", requestId: newId(), jobId: newId(), handle }));
    expect(foreign.owned).toBe(false);
    expect(foreign.presence).toBe("unknown");
    expect(foreign.exitState).toBe("unknown");
    expect(foreign.editable).toBe(false);
  });

  it("runs cancel, then cleanup, and the revoked handle answers as unowned", async () => {
    const jobId = newId();
    const started = unwrap(await client().startProfile({ command: "startProfile", requestId: newId(), jobId, taskId: null, profile, egress }));
    const handle = started.handle;
    if (handle === null) throw new Error("a started answer needs a handle");

    const cancelled = unwrap(await client().cancelOwned({ command: "cancelOwned", requestId: newId(), jobId, handle }));
    expect(cancelled.owned).toBe(true);
    expect(cancelled.status).toBe("cancelling");

    const cleaned = unwrap(await client().cleanupOwned({ command: "cleanupOwned", requestId: newId(), jobId, handle }));
    expect(cleaned.status).toBe("complete");
    expect(cleaned.cleanupState).toBe("complete");
    expect(cleaned.retryAt).toBeNull();

    // Revocation is a fact with an observable consequence: the credential is gone, so a
    // later request cannot address the resource even though it names the same handle.
    const after = unwrap(await client().inspectOwned({ command: "inspectOwned", requestId: newId(), jobId, handle }));
    expect(after.owned).toBe(false);

    const lateCancel = unwrap(await client().cancelOwned({ command: "cancelOwned", requestId: newId(), jobId, handle }));
    expect(lateCancel.status).toBe("refused");
    expect(lateCancel.refusalReasons).toEqual(["handle-not-owned"]);

    // Counted from the supervisor's own table rather than inferred from the answers above:
    // §11's 「只清理 owned 资源」 only means something if the credential really is gone from
    // the authority that minted it.
    expect(booted.protocol.ownership.records.has(String(handle))).toBe(false);
  });

  it("keeps a failed cleanup pending with a retry time rather than reporting it done", async () => {
    const failingSocket = path.join(root, "clean-fail.sock");
    const failing = bootBroker({
      env: { [BROKER_SOCKET_ENV]: failingSocket },
      host: LINUX_HOST,
      engine: scriptedEngine({ ...script, cleanFailed: true }),
    });
    if (!failing.ok) throw new Error(JSON.stringify(failing.reasons));
    await listening(failing.server);
    const jobId = newId();
    const started = unwrap(
      await new BrokerClient({ exchange: new SocketBrokerExchange({ socketPath: failingSocket }) }).startProfile({
        command: "startProfile",
        requestId: newId(),
        jobId,
        taskId: null,
        profile,
        egress,
      }),
    );
    const handle = started.handle;
    if (handle === null) throw new Error("a started answer needs a handle");
    const cleaned = unwrap(
      await new BrokerClient({ exchange: new SocketBrokerExchange({ socketPath: failingSocket }) }).cleanupOwned({
        command: "cleanupOwned",
        requestId: newId(),
        jobId,
        handle,
      }),
    );
    expect(cleaned.status).toBe("failed");
    expect(cleaned.cleanupState).toBe("failed");
    expect(cleaned.retryAt).not.toBeNull();
    // And the credential survives a failed cleanup: retrying needs something to retry on.
    const still = unwrap(
      await new BrokerClient({ exchange: new SocketBrokerExchange({ socketPath: failingSocket }) }).inspectOwned({
        command: "inspectOwned",
        requestId: newId(),
        jobId,
        handle,
      }),
    );
    expect(still.owned).toBe(true);
    expect(still.cleanupState).toBe("failed");
    failing.server.close();
  });

  it("refuses a start the engine will not honour, and keeps no credential for it", async () => {
    const refusingSocket = path.join(root, "start-refused.sock");
    const refusing = bootBroker({
      env: { [BROKER_SOCKET_ENV]: refusingSocket },
      host: LINUX_HOST,
      engine: scriptedEngine({ ...script, startOk: false }),
    });
    if (!refusing.ok) throw new Error(JSON.stringify(refusing.reasons));
    await listening(refusing.server);
    const answer = unwrap(
      await new BrokerClient({ exchange: new SocketBrokerExchange({ socketPath: refusingSocket }) }).startProfile({
        command: "startProfile",
        requestId: newId(),
        jobId: newId(),
        taskId: null,
        profile,
        egress,
      }),
    );
    expect(answer.status).toBe("refused");
    expect(answer.handle).toBeNull();
    expect(answer.refusalReasons).toContain("engine-refused-start");
    expect(refusing.protocol.ownership.records.size).toBe(0);
    refusing.server.close();
  });

  it("answers nothing to a frame outside the four commands, and says why in its own log", async () => {
    const forged = new TextEncoder().encode('{"command":"execShell","requestId":"x"}\n');
    const closed = await writeFrame(socketPath, forged);
    expect(closed).toBe("");
    expect(booted.protocol.log.filter((line) => line.reason === "broker-request-rejected").length).toBeGreaterThan(0);

    // The same refusal read from the caller's side. A request the contract will not accept
    // gets **no answer frame at all** - the broker cannot echo a `requestId` for a record it
    // never parsed - so the client's own transport reason is what surfaces, and it never
    // carries the peer's text.
    const unanswered = await client().startProfile({
      command: "startProfile",
      requestId: newId(),
      jobId: newId(),
      taskId: null,
      // A profile the contract will not accept never reaches the engine either.
      profile: { ...profile, profileId: "" },
      egress,
    });
    expect(unanswered.ok).toBe(false);
    if (unanswered.ok) return;
    expect(unanswered.error.reason).toBe("broker-unreachable");
  });

  // The client's own encoder against the broker's own reader: if these two drift apart on
  // the frame, every command in the protocol fails somewhere between the two processes, and
  // this is the case that says they are the same bytes.
  it("answers the client's own encoded request over a raw connection", async () => {
    const jobId = newId();
    const requestId = newId();
    const answer = await writeFrame(socketPath, encodeBrokerRequest({ command: "startProfile", requestId, jobId, taskId: null, profile, egress }));
    const parsed = brokerResponseSchema.safeParse(JSON.parse(answer) as JsonValue);
    expect(parsed.success, answer).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.requestId).toBe(requestId);
    // Narrowed by the discriminant the protocol carries, the way the client does: a
    // `started` answer without a handle is the pair the schema refuses, so reading the
    // handle here means reading it through the branch that may have one.
    if (parsed.data.command !== "startProfile") throw new Error(`answered ${parsed.data.command}`);
    expect(parsed.data.status).toBe("started");
    expect(parsed.data.handle).not.toBeNull();
  });

  it("refuses an oversized frame without reading it", async () => {
    const oversized = new Uint8Array(MAX_BROKER_FRAME_BYTES + 16);
    oversized.fill(0x20);
    oversized[oversized.byteLength - 1] = 0x0a;
    const logged = booted.protocol.log.length;
    const answer = await booted.protocol.answerFrame(oversized);
    expect(answer).toBeNull();
    expect(booted.protocol.log.length).toBe(logged + 1);
    expect(booted.protocol.log[logged]?.reason).toBe("broker-frame-too-large");
  });

  it("refuses a second broker on the same path instead of unlinking the live one", async () => {
    const again = bootBroker({
      env: { [BROKER_SOCKET_ENV]: socketPath },
      host: LINUX_HOST,
      engine: scriptedEngine(script),
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reasons).toEqual(["broker-socket-already-listening"]);
    expect(again.exitCode).toBe(73);
  });

  it("will not start where the profile's ceilings exceed what the host reports", async () => {
    const tightSocket = path.join(root, "tight.sock");
    const tight = bootBroker({
      env: { [BROKER_SOCKET_ENV]: tightSocket },
      host: {
        ...LINUX_HOST,
        facts: { ...LINUX_HOST.facts, capacity: { cpuCores: 1, memoryBytes: 1024, pids: 16, diskBytes: 1024 } },
      },
      engine: scriptedEngine(script),
    });
    if (!tight.ok) throw new Error(JSON.stringify(tight.reasons));
    await listening(tight.server);
    const answer = unwrap(
      await new BrokerClient({ exchange: new SocketBrokerExchange({ socketPath: tightSocket }) }).startProfile({
        command: "startProfile",
        requestId: newId(),
        jobId: newId(),
        taskId: null,
        profile,
        egress,
      }),
    );
    expect(answer.status).toBe("refused");
    expect(answer.refusalReasons).toContain("resource-limit-unavailable:memoryBytes");
    tight.server.close();
  });
});

// The doctor's sentence about the supervisor (§14 line 477), driven from the three answers
// it can actually receive. Each one is a different state, so a check that collapsed them -
// or that reported `ok` from the file existing alone - is caught here.
describe("the worker's doctor asks the broker, not the filesystem, what is available (§14)", () => {
  it("reports the three answers as three different states", async () => {
    const quietSocket = path.join(root, "doctor-quiet.sock");
    const quiet = net.createServer();
    quiet.on("connection", (peer) => peer.destroy());
    await new Promise<void>((resolve) => quiet.listen(quietSocket, resolve));

    const silent = await classifyBrokerProbe(
      true,
      new BrokerClient({ exchange: new SocketBrokerExchange({ socketPath: quietSocket, timeoutMs: 300 }) }),
    );
    expect(silent).toEqual({ state: "degraded", reasons: ["broker-socket-not-answering-the-protocol"] });

    const lyingSocket = path.join(root, "doctor-lying.sock");
    const lying = net.createServer((peer) => {
      peer.on("data", (chunk: Uint8Array) => {
        const request = JSON.parse(new TextDecoder().decode(chunk)) as { requestId: string };
        peer.end(
          encodeBrokerFrame({
            command: "inspectOwned",
            requestId: request.requestId,
            owned: true,
            presence: "present",
            exitState: "running",
            cleanupState: "pending",
            editable: true,
          } as JsonValue),
        );
      });
    });
    await new Promise<void>((resolve) => lying.listen(lyingSocket, resolve));
    const claims = await classifyBrokerProbe(
      true,
      new BrokerClient({ exchange: new SocketBrokerExchange({ socketPath: lyingSocket, timeoutMs: 300 }) }),
    );
    // A supervisor that owns a handle nobody minted is not "degraded": acting on that
    // answer is exactly the cleanup §11 forbids.
    expect(claims).toEqual({ state: "failed", reasons: ["broker-claimed-an-unminted-handle"] });

    // A real supervisor of its own: the honest `ok` answer must come from the process
    // under test, not from a stub that agrees with what I expect it to say.
    const honestSocket = path.join(root, "doctor-honest.sock");
    const honestBoot = bootBroker({
      env: { [BROKER_SOCKET_ENV]: honestSocket },
      host: LINUX_HOST,
      engine: scriptedEngine({ startOk: true, present: false, running: false, cancelled: true, cleaned: true, cleanFailed: false }),
    });
    if (!honestBoot.ok) throw new Error(JSON.stringify(honestBoot.reasons));
    await listening(honestBoot.server);
    const honest = await classifyBrokerProbe(
      true,
      new BrokerClient({ exchange: new SocketBrokerExchange({ socketPath: honestSocket, timeoutMs: 1_000 }) }),
    );
    expect(honest).toEqual({ state: "ok", facts: { reachable: true, protocol: "answered", presence: "unknown" } });

    const absent = await classifyBrokerProbe(
      false,
      new BrokerClient({ exchange: new SocketBrokerExchange({ socketPath: path.join(root, "nothing.sock") }) }),
    );
    expect(absent).toEqual({ state: "failed", reasons: ["broker-socket-absent-or-not-a-socket"] });

    lying.close();
    quiet.close();
    honestBoot.close();
  });
});

describe("the broker's answers are the contract's answers, not a superset", () => {
  it("refuses an answer that carries a field the protocol never declared", async () => {
    // A broker that grows a field (a PID, a container name, a host path) is refused by
    // the client's strict read - which is the only reason §11's "no PID on the wire"
    // holds outside this repository.
    const smuggled = { command: "startProfile", requestId: newId(), status: "refused", handle: null, refusalReasons: ["x"], enforcedConditions: [], cleanupState: "pending", containerName: "not-ours" } as JsonValue;
    const parsed = brokerResponseSchema.safeParse(smuggled);
    expect(parsed.success).toBe(false);
  });
});

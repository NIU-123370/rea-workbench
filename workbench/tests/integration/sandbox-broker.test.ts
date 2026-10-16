import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { acquireWorkerLock, applyMigrations, openWriteConnection, planMigrations } from "../../packages/adapters/storage/database.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { sandboxEgressPolicy } from "../../packages/adapters/sandbox/egress.ts";
import { SandboxService } from "../../packages/application/sandbox-service.ts";
import type { Actor } from "../../packages/application/actor.ts";
import { readAudit } from "../../packages/application/audit.ts";
import type {
  BrokerTransportFailure,
  CommittedAudit,
  SandboxBrokerTransportPort,
  SandboxHostProbePort,
  StoragePortError,
  StorageTransaction,
  StorageWriterPort,
} from "../../packages/application/ports.ts";
import type { SensitiveDeclaration } from "../../packages/application/sanitizer.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type { Result } from "../../packages/domain/result.ts";
import type {
  BrokerCommand,
  CancelOwnedBrokerRequest,
  CancelOwnedBrokerResponse,
  CleanupOwnedBrokerRequest,
  CleanupOwnedBrokerResponse,
  EgressDestination,
  EgressGrant,
  EgressPolicy,
  InspectOwnedBrokerRequest,
  InspectOwnedBrokerResponse,
  SandboxHostFacts,
  SandboxProfileDescriptor,
  StartProfileBrokerRequest,
  StartProfileBrokerResponse,
} from "../../packages/contracts/sandbox.ts";
import { ISOLATION_CONDITIONS, unsupportedPlatformSchema } from "../../packages/contracts/sandbox.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";

// The service↔broker seam with a FAKE transport (issue #21). This machine has no
// Docker, so nothing here claims to have started a container: what is proven is the
// control-plane contract — that a start which would need a fallback journals a deny
// and answers CAPABILITY_UNAVAILABLE, that the unsupported-platform path is driven by
// an injected probe rather than `process.platform`, and that no refusal can leave a
// business row behind.

const DIGEST_A = ("a" as const).repeat(64) as Digest;
const ALL_CONDITIONS = [...ISOLATION_CONDITIONS];

const inspector: Actor = { actorId: "local-operator", actorKind: "inspector" };
const builder: Actor = { actorId: "builder-agent", actorKind: "builder" };
const NO_SECRETS: SensitiveDeclaration = { declaredValues: [] };
const SECRET = "sup3r-s3cret-broker-text";

let root: string;
let db: DatabaseSync;
let writer: SqliteStorageWriter;
let projectId: Id;
let heldLock: { release: () => Promise<void> } | null = null;

// The probe is a mutable script, never a read of the real host: checkbox 4 requires
// the unsupported-platform path to be drivable from the test.
let hostFacts: SandboxHostFacts = {
  platform: "linux",
  arch: "x64",
  enforcedConditions: ALL_CONDITIONS,
  capacity: { cpuCores: 8, memoryBytes: 8_000_000_000, pids: 512, diskBytes: 20_000_000_000 },
};
const probe: SandboxHostProbePort = { observeHost: () => hostFacts };

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

// Every test reads only the rows its own call produced: the journal and the outbox
// are project-wide and append-only, so a count assertion without a high-water mark
// would describe the whole file rather than the case under test.
let auditMark = 0;
let eventMark = 0;

function maxSeq(table: "events" | "audit_entries"): number {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM ${table}`).get() as { n: number };
  return Number(row.n);
}

function journal(
  action: string,
  decision: "allow" | "deny",
  reason?: string,
): CommittedAudit[] {
  const rows = readAudit(writer, { after: auditMark, projectId, limit: 500 });
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  return rows.value.filter(
    (entry) =>
      entry.action === action &&
      entry.decision === decision &&
      (reason === undefined || entry.reasonCode === reason),
  );
}

function eventsOfType(type: string): JsonValue[] {
  const rows = writer.transact((tx) => tx.eventsAfter(projectId, eventMark, 500));
  if (!rows.ok) throw new Error(JSON.stringify(rows.error));
  return rows.value.filter((entry) => entry.type === type).map((entry) => entry.payloadJson);
}

function profile(): SandboxProfileDescriptor {
  return {
    profileId: "target-chromium",
    schemaVersion: 1,
    limits: {
      cpuCores: 2,
      memoryBytes: 2_000_000_000,
      pids: 128,
      diskBytes: 4_000_000_000,
      maxExpandedBytes: 64_000_000,
      queueWaitMs: 30_000,
      timeoutMs: 120_000,
    },
    networkPolicyId: "deny-all",
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
      seccomp: { policyId: "workbench-target-v1", digest: DIGEST_A, verified: true },
    },
    scratch: [
      { scratchId: newId(), purpose: "workdir", sizeLimitBytes: 1_000_000, readOnly: false },
    ],
  };
}

function egress(overrides: Partial<EgressPolicy> = {}): EgressPolicy {
  return { policyId: "deny-all", defaultAction: "deny", networkNamespace: "isolated", grants: [], ...overrides };
}

function publicGrant(destination: EgressDestination): EgressGrant {
  return {
    grantId: newId(),
    destination,
    port: 443,
    purpose: "the operator-selected origin under study",
    kind: "publicDestination",
    fixtureId: null,
  };
}

function startInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { jobId: newId(), taskId: null, profile: profile(), egress: egress(), ...overrides };
}

// The fake broker. Every answer is scriptable per command, and every call is
// recorded so a refusal can be proven to have reached nothing.
type StartAnswer = Result<StartProfileBrokerResponse, BrokerTransportFailure>;
type InspectAnswer = Result<InspectOwnedBrokerResponse, BrokerTransportFailure>;
type CancelAnswer = Result<CancelOwnedBrokerResponse, BrokerTransportFailure>;
type CleanupAnswer = Result<CleanupOwnedBrokerResponse, BrokerTransportFailure>;

const calls: { command: BrokerCommand; requestId: string; jobId: string }[] = [];

const answers = {
  start: null as StartAnswer | null,
  inspect: null as InspectAnswer | null,
  cancel: null as CancelAnswer | null,
  cleanup: null as CleanupAnswer | null,
};

function startedResponse(request: StartProfileBrokerRequest, enforced: string[] = ALL_CONDITIONS): StartProfileBrokerResponse {
  return {
    command: "startProfile",
    requestId: request.requestId,
    status: "started",
    handle: newId(),
    refusalReasons: [],
    enforcedConditions: enforced as never,
    cleanupState: "pending",
  };
}

function failureOf(reason: string, message: string, retryable: boolean): BrokerTransportFailure {
  return { code: "CAPABILITY_UNAVAILABLE", reason, message, retryable, retryAt: null };
}

function resetFake(): void {
  calls.length = 0;
  answers.start = null;
  answers.inspect = null;
  answers.cancel = null;
  answers.cleanup = null;
}

const fakeTransport: SandboxBrokerTransportPort = {
  async startProfile(request) {
    calls.push({ command: "startProfile", requestId: request.requestId, jobId: request.jobId });
    if (answers.start !== null) return answers.start;
    return { ok: true, value: startedResponse(request) };
  },
  async inspectOwned(request: InspectOwnedBrokerRequest) {
    calls.push({ command: "inspectOwned", requestId: request.requestId, jobId: request.jobId });
    if (answers.inspect !== null) return answers.inspect;
    return {
      ok: true,
      value: {
        command: "inspectOwned",
        requestId: request.requestId,
        owned: true,
        presence: "present",
        exitState: "running",
        cleanupState: "pending",
        editable: false,
      },
    };
  },
  async cancelOwned(request: CancelOwnedBrokerRequest) {
    calls.push({ command: "cancelOwned", requestId: request.requestId, jobId: request.jobId });
    if (answers.cancel !== null) return answers.cancel;
    return {
      ok: true,
      value: {
        command: "cancelOwned",
        requestId: request.requestId,
        owned: true,
        status: "cancelling",
        refusalReasons: [],
      },
    };
  },
  async cleanupOwned(request: CleanupOwnedBrokerRequest) {
    calls.push({ command: "cleanupOwned", requestId: request.requestId, jobId: request.jobId });
    if (answers.cleanup !== null) return answers.cleanup;
    return {
      ok: true,
      value: {
        command: "cleanupOwned",
        requestId: request.requestId,
        owned: true,
        status: "complete",
        cleanupState: "complete",
        retryAt: null,
        refusalReasons: [],
      },
    };
  },
};

let service: SandboxService;

function makeService(storage: StorageWriterPort): SandboxService {
  return new SandboxService({
    storage,
    transport: fakeTransport,
    host: probe,
    egress: sandboxEgressPolicy,
  });
}

function supportedHost(): SandboxHostFacts {
  return {
    platform: "linux",
    arch: "x64",
    enforcedConditions: ALL_CONDITIONS,
    capacity: { cpuCores: 8, memoryBytes: 8_000_000_000, pids: 512, diskBytes: 20_000_000_000 },
  };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-sandbox-"));
  const lock = await acquireWorkerLock(root);
  if (!lock.ok) throw new Error(JSON.stringify(lock.error));
  const opened = openWriteConnection(root);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  db = opened.value.db;
  writer = new SqliteStorageWriter(db);
  const plan = planMigrations(db);
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  applyMigrations(db, plan.value);
  projectId = newId();
  const created = writer.transact((tx) =>
    tx.insertProject({
      id: projectId,
      name: "sandbox",
      createdAt: nowInstant(),
      graphRevision: 0,
      inventoryRevision: 0,
      schemaVersion: 1,
    }),
  );
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  service = makeService(writer);
  heldLock = lock.value;
});

afterAll(async () => {
  db.close();
  await heldLock?.release();
  heldLock = null;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  resetFake();
  hostFacts = supportedHost();
  auditMark = maxSeq("audit_entries");
  eventMark = maxSeq("events");
});

describe("a start that would need a fallback is refused (issue #21 checkbox 2)", () => {
  it("records the allow and the resource event when the broker enforces everything", async () => {
    const started = unwrap(await service.startProfile(projectId, inspector, startInput(), NO_SECRETS));
    expect(started.handle).toBeTypeOf("string");
    expect(calls.length).toBe(1);
    expect(journal("sandbox.startProfile", "allow").map((row) => row.reasonCode)).toEqual([
      "isolation-conditions-met",
    ]);
    expect(journal("sandbox.startProfile", "deny")).toEqual([]);
    const events = eventsOfType("resource.started");
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ profileId: "target-chromium", cleanupState: "pending" });
  });

  it("journals a deny and answers CAPABILITY_UNAVAILABLE when the broker refuses to degrade", async () => {
    answers.start = {
      ok: true,
      value: {
        command: "startProfile",
        requestId: "unused",
        status: "refused",
        handle: null,
        refusalReasons: ["seccomp-profile-unavailable", "would-need-no-sandbox"],
        enforcedConditions: ALL_CONDITIONS as never,
        cleanupState: "pending",
      },
    };
    const input = startInput();
    const failure = errorOf(await service.startProfile(projectId, inspector, input, NO_SECRETS));
    expect(failure.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(failure.reason).toBe("broker-refused-isolation");
    expect(failure.details["reasons"]).toEqual(["seccomp-profile-unavailable", "would-need-no-sandbox"]);
    expect(failure.details["retryable"]).toBe(false);
    const denies = journal("sandbox.startProfile", "deny");
    expect(denies.length).toBe(1);
    expect(denies[0]?.reasonCode).toBe("broker-refused-isolation");
    // The refusal wrote no resource row: the deny is the only thing that landed.
    expect(eventsOfType("resource.started")).toEqual([]);
  });

  it("refuses a broker that started with fewer conditions than the profile requires", async () => {
    answers.start = {
      ok: true,
      value: {
        command: "startProfile",
        requestId: "unused",
        status: "started",
        handle: newId(),
        refusalReasons: [],
        enforcedConditions: ALL_CONDITIONS.filter((entry) => entry !== "browserSandbox") as never,
        cleanupState: "pending",
      },
    };
    const failure = errorOf(await service.startProfile(projectId, inspector, startInput(), NO_SECRETS));
    expect(failure.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(failure.reason).toBe("broker-degraded-isolation");
    expect(failure.details["reasons"]).toEqual(["not-enforced:browserSandbox"]);
    expect(journal("sandbox.startProfile", "deny").length).toBe(1);
    expect(eventsOfType("resource.started")).toEqual([]);
    // The resource exists, so it is reclaimed instead of being left running (§11).
    expect(calls.map((call) => call.command)).toEqual(["startProfile", "cleanupOwned"]);
    expect(journal("sandbox.cleanupOwned", "allow").length).toBe(1);
    expect(eventsOfType("resource.cleanupRequested").length).toBe(1);
  });

  it("refuses when the host cannot prove any isolation condition, without calling the broker", async () => {
    hostFacts = { ...supportedHost(), enforcedConditions: [] };
    const failure = errorOf(await service.startProfile(projectId, inspector, startInput(), NO_SECRETS));
    expect(failure.code).toBe("CAPABILITY_UNAVAILABLE");
    expect((failure.details["reasons"] as string[]).length).toBe(ISOLATION_CONDITIONS.length);
    expect(calls).toEqual([]);
    expect(journal("sandbox.startProfile", "deny")[0]?.reasonCode).toBe("isolation-conditions-unmet");
  });
});

describe("the unsupported-platform path comes from the injected probe (issue #21 checkbox 4)", () => {
  it("refuses on a macOS arm64 probe and discloses the platform honestly", async () => {
    hostFacts = { ...supportedHost(), platform: "darwin", arch: "arm64" };
    const failure = errorOf(await service.startProfile(projectId, inspector, startInput(), NO_SECRETS));
    expect(failure.code).toBe("CAPABILITY_UNAVAILABLE");
    const denies = journal("sandbox.startProfile", "deny");
    expect(denies.length).toBe(1);
    expect(denies[0]?.reasonCode).toBe("platform-unsupported");
    const metadata = denies[0]?.safeMetadataJson as Record<string, JsonValue>;
    expect(metadata["unmet"]).toEqual(expect.arrayContaining(["platform-unsupported:linux/x64"]));
    const disclosure = unsupportedPlatformSchema.safeParse(metadata["unsupportedPlatform"]);
    expect(disclosure.success).toBe(true);
    if (!disclosure.success) return;
    expect(disclosure.data.requiredPlatform).toBe("linux");
    expect(disclosure.data.requiredArch).toBe("x64");
    expect(disclosure.data.observedPlatform).toBe("darwin");
    expect(disclosure.data.verifiedOnHost).toBe(false);
    expect(calls).toEqual([]);
  });

  it("keeps cleanup reachable on an unsupported host so a resource is never stranded", async () => {
    hostFacts = { ...supportedHost(), platform: "darwin", arch: "arm64" };
    const response = unwrap(
      await service.cleanupOwned(projectId, inspector, { jobId: newId(), handle: newId() }, NO_SECRETS),
    );
    expect(response.status).toBe("complete");
    expect(calls.map((call) => call.command)).toEqual(["cleanupOwned"]);
    expect(journal("sandbox.cleanupOwned", "allow").length).toBe(1);
  });

  it("never reads the real platform inside the policy", () => {
    // The seam is structural, not a promise in a comment: if a policy file starts
    // asking `process.platform` or importing `node:os`, this test fails. Comments are
    // stripped first, because this very file explains the rule in prose.
    const sources = [
      "packages/application/sandbox-service.ts",
      "packages/contracts/sandbox.ts",
      "packages/adapters/sandbox/broker.ts",
      "packages/adapters/sandbox/egress.ts",
      "packages/adapters/sandbox/broker-client.ts",
    ];
    const repoRoot = process.cwd();
    for (const file of sources) {
      const code = readFileSync(path.join(repoRoot, file), "utf8")
        .split("\n")
        .filter((line: string) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code).not.toMatch(/process\.platform|os\.platform|from "node:os"/);
    }
  });
});

describe("the four-command allowlist at the seam (issue #21 checkbox 1)", () => {
  it("refuses any command name outside the four and journals it", async () => {
    for (const command of ["execShell", "runImage", "dockerRun", "startContainer", "", "StartProfile"]) {
      const failure = errorOf(
        await service.dispatch(projectId, inspector, command, startInput(), NO_SECRETS),
      );
      expect(failure.code).toBe("ACCESS_DENIED");
      expect(failure.reason).toBe("command-outside-broker-allowlist");
    }
    expect(calls).toEqual([]);
    expect(journal("sandbox.unknown", "deny").length).toBe(6);
    expect(journal("sandbox.execShell", "deny")).toEqual([]);
  });

  it("routes each of the four commands by name", async () => {
    const started = unwrap(await service.dispatch(projectId, inspector, "startProfile", startInput(), NO_SECRETS));
    expect(started.command).toBe("startProfile");
    for (const command of ["inspectOwned", "cancelOwned", "cleanupOwned"] as const) {
      const dispatched = unwrap(
        await service.dispatch(
          projectId,
          inspector,
          command,
          { jobId: newId(), handle: newId() },
          NO_SECRETS,
        ),
      );
      expect(dispatched.command).toBe(command);
    }
    expect(calls.map((call) => call.command)).toEqual([
      "startProfile",
      "inspectOwned",
      "cancelOwned",
      "cleanupOwned",
    ]);
  });

  it("refuses a request that carries an image, a shell, a host path or docker arguments", async () => {
    for (const forged of [
      startInput({ image: "python:3" }),
      startInput({ shell: "sh" }),
      startInput({ hostPath: "/Users/niuruibo" }),
      startInput({ dockerArgs: ["--privileged"] }),
      startInput({ profile: { ...profile(), image: "python:3" } }),
      startInput({ profile: { ...profile(), isolation: { ...profile().isolation, privileged: true } } }),
      startInput({ egress: { ...egress(), defaultAction: "allow" } }),
    ]) {
      const failure = errorOf(await service.startProfile(projectId, inspector, forged, NO_SECRETS));
      expect(failure.code).toBe("INVALID_INPUT");
      expect(failure.reason).toBe("request-outside-broker-contract");
    }
    expect(calls).toEqual([]);
    const denies = journal("sandbox.startProfile", "deny");
    expect(denies.length).toBe(7);
    const first = denies[0];
    if (first === undefined) throw new Error("the forged request was not journalled");
    expect((first.safeMetadataJson as Record<string, JsonValue>)["issues"]).toEqual(
      expect.arrayContaining(["image"]),
    );
  });

  it("mints the request id instead of adopting one from the caller", async () => {
    const supplied = newId();
    unwrap(await service.startProfile(projectId, inspector, startInput({ requestId: supplied }), NO_SECRETS));
    expect(calls.length).toBe(1);
    // A caller-supplied id would otherwise let a forged echo satisfy the client's
    // request-matching check in broker-client.ts.
    expect(calls[0]?.requestId).not.toBe(supplied);
  });

  it("keeps Builder away from every command", async () => {
    for (const command of ["startProfile", "inspectOwned", "cancelOwned", "cleanupOwned"]) {
      const failure = errorOf(
        await service.dispatch(projectId, builder, command, startInput(), NO_SECRETS),
      );
      expect(failure.code).toBe("ACCESS_DENIED");
      expect(failure.reason).toBe("builder-has-no-sandbox-permission");
    }
    expect(calls).toEqual([]);
    expect(journal("sandbox.startProfile", "deny").length).toBe(1);
  });
});

describe("ownership and the broker's answers (DESIGN §11)", () => {
  it("refuses to report anything about a handle the broker does not own", async () => {
    answers.inspect = {
      ok: true,
      value: {
        command: "inspectOwned",
        requestId: "unused",
        owned: false,
        presence: "unknown",
        exitState: "unknown",
        cleanupState: "pending",
        editable: false,
      },
    };
    const failure = errorOf(
      await service.inspectOwned(projectId, inspector, { jobId: newId(), handle: newId() }, NO_SECRETS),
    );
    expect(failure.code).toBe("ACCESS_DENIED");
    expect(failure.reason).toBe("ownership-unproven");
    expect(journal("sandbox.inspectOwned", "deny").length).toBe(1);
    expect(journal("sandbox.inspectOwned", "allow")).toEqual([]);
    // An inspect is a read: it journals a decision and no state-change event.
    expect(eventsOfType("resource.cancelRequested")).toEqual([]);
  });

  it("reports the separate presence, exit, ownership and editability facts when owned", async () => {
    const response = unwrap(
      await service.inspectOwned(projectId, inspector, { jobId: newId(), handle: newId() }, NO_SECRETS),
    );
    expect(response).toMatchObject({
      command: "inspectOwned",
      owned: true,
      presence: "present",
      exitState: "running",
      editable: false,
    });
    expect(journal("sandbox.inspectOwned", "allow")[0]?.reasonCode).toBe("owned-resource-observed");
  });

  it("journals a cancel and a cleanup as separate facts", async () => {
    const jobId = newId();
    const handle = newId();
    unwrap(await service.cancelOwned(projectId, inspector, { jobId, handle }, NO_SECRETS));
    unwrap(await service.cleanupOwned(projectId, inspector, { jobId, handle }, NO_SECRETS));
    expect(eventsOfType("resource.cancelRequested").length).toBe(1);
    expect(eventsOfType("resource.cleanupRequested").length).toBe(1);
    expect(journal("sandbox.cancelOwned", "allow").length).toBe(1);
    expect(journal("sandbox.cleanupOwned", "allow").length).toBe(1);
  });

  it("keeps a failed cleanup journaled without rerunning any business work", async () => {
    const retryAt = new Date(Date.parse(nowInstant()) + 60_000).toISOString() as Instant;
    answers.cleanup = {
      ok: true,
      value: {
        command: "cleanupOwned",
        requestId: "unused",
        owned: true,
        status: "failed",
        cleanupState: "failed",
        retryAt,
        refusalReasons: ["resource-still-attached"],
      },
    };
    const response = unwrap(
      await service.cleanupOwned(projectId, inspector, { jobId: newId(), handle: newId() }, NO_SECRETS),
    );
    expect(response.status).toBe("failed");
    expect(response.retryAt).toBe(retryAt);
    expect(journal("sandbox.cleanupOwned", "allow").length).toBe(1);
    // Only the four named commands were ever sent, so nothing was re-executed.
    expect(calls.every((call) => call.command === "cleanupOwned")).toBe(true);
  });
});

describe("default-deny egress reaches the decision (issue #21 checkbox 3)", () => {
  it("refuses a start whose grant widens a public exception to a private range", async () => {
    const widened = egress({ grants: [publicGrant({ kind: "ipv4Prefix", address: "10.0.0.0", prefixLength: 8 })] });
    const failure = errorOf(
      await service.startProfile(projectId, inspector, startInput({ egress: widened }), NO_SECRETS),
    );
    expect(failure.code).toBe("CAPABILITY_UNAVAILABLE");
    expect((failure.details["reasons"] as string[]).join(",")).toContain("egress:grant-class-blocked");
    expect(calls).toEqual([]);
    expect(journal("sandbox.startProfile", "deny").length).toBe(1);
  });

  it("accepts an explicit grant for a public destination", async () => {
    const allowed = egress({
      grants: [publicGrant({ kind: "ipv4Host", address: "93.184.216.34" })],
    });
    unwrap(await service.startProfile(projectId, inspector, startInput({ egress: allowed }), NO_SECRETS));
    expect(calls.length).toBe(1);
    const allow = journal("sandbox.startProfile", "allow")[0];
    if (allow === undefined) throw new Error("the admitted start was not journalled");
    expect((allow.safeMetadataJson as Record<string, JsonValue>)["egressGrantCount"]).toBe(1);
  });

  it("lets a fixture name one host in its own network", async () => {
    const fixture = egress({
      networkNamespace: "fixture",
      grants: [
        {
          grantId: newId(),
          destination: { kind: "ipv4Host", address: "127.0.0.1" },
          port: 8080,
          purpose: "the local fixture under test",
          kind: "localFixture",
          fixtureId: newId(),
        },
      ],
    });
    unwrap(await service.startProfile(projectId, inspector, startInput({ egress: fixture }), NO_SECRETS));
    expect(calls.length).toBe(1);
  });
});

describe("the broker's text goes through the diagnostics owner (DESIGN §12.1)", () => {
  it("never journals or returns a declared value carried in a broker message", async () => {
    answers.start = { ok: false, error: failureOf("broker-socket-closed", `docker: ${SECRET} leaked`, true) };
    const declaration: SensitiveDeclaration = { declaredValues: [SECRET] };
    const failure = errorOf(
      await service.startProfile(projectId, inspector, startInput(), declaration),
    );
    expect(failure.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(failure.message).not.toContain(SECRET);
    const serialized = JSON.stringify([...journal("sandbox.startProfile", "deny"), ...eventsOfType("resource.started")]);
    expect(serialized).not.toContain(SECRET);
    expect(failure.message).toBe("docker:  leaked");
  });

  it("falls back to a fixed diagnostic marker when the filter leaves nothing", async () => {
    answers.start = { ok: false, error: failureOf("broker-socket-closed", SECRET, true) };
    const failure = errorOf(
      await service.startProfile(
        projectId,
        inspector,
        startInput(),
        { declaredValues: [SECRET] },
      ),
    );
    expect(failure.message).toBe("diagnostic_unavailable");
  });

  it("refuses to journal a request that carries a declared value", async () => {
    const leaky = startInput({ profile: { ...profile(), networkPolicyId: `policy-${SECRET}` } });
    const failure = errorOf(
      await service.startProfile(projectId, inspector, leaky, { declaredValues: [SECRET] }),
    );
    expect(failure.code).toBe("SENSITIVE_CONTENT_BLOCKED");
    expect(calls).toEqual([]);
    expect(journal("sandbox.startProfile", "deny")[0]?.reasonCode).toBe("declared-value-present");
    expect(JSON.stringify(journal("sandbox.startProfile", "deny"))).not.toContain(SECRET);
  });

  it("survives an unreadable audit store without releasing the request", async () => {
    // §12.2: a refusal stands even when the journal cannot be written. A writer whose
    // transactions always fail is the injected fault.
    const broken: StorageWriterPort = {
      transact<T>(_work: (tx: StorageTransaction) => T): Result<T, StoragePortError> {
        return { ok: false, error: { code: "SQLITE_FAILURE", message: "disk full" } };
      },
    };
    const stranded = makeService(broken);
    hostFacts = { ...supportedHost(), enforcedConditions: [] };
    const failure = errorOf(await stranded.startProfile(projectId, inspector, startInput(), NO_SECRETS));
    expect(failure.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(calls).toEqual([]);
  });
});

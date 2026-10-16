import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { asId, asInstant, newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type { Result } from "../../packages/domain/result.ts";

import { BOOT_CONFIG_FIELDS, WORKER_RPC_SOCKET_NAME } from "../../packages/contracts/boot.ts";
import { bootstrapExchangeSchema } from "../../packages/contracts/session.ts";
import type { BootConfig, ConfigInput } from "../../packages/application/boot-config.ts";
import { ProfileRegistry, resolveBootConfig } from "../../packages/application/boot-config.ts";
import { runDoctor } from "../../packages/application/doctor.ts";
import type { CheckName, CheckOutcome, DoctorReport } from "../../packages/application/doctor.ts";
import { recoverJobs } from "../../packages/application/recovery.ts";
import type { RecoveryReport } from "../../packages/application/recovery.ts";
import type { Actor } from "../../packages/application/actor.ts";
import { gateFail, type GateFailure } from "../../packages/application/gate-failure.ts";
import { commitDecision, recordDeny } from "../../packages/application/decision.ts";
import type { Step } from "../../packages/application/decision.ts";
import { BootstrapTokenVault, SessionService } from "../../packages/application/session.ts";
import type { PairingCode } from "../../packages/application/session.ts";
import { normalizeEventLimit, toStreamEvents } from "../../packages/application/event-stream.ts";
import { VectorService } from "../../packages/application/vector-service.ts";
import { ContractService } from "../../packages/application/contract-service.ts";
import { PlanService } from "../../packages/application/plan-service.ts";
import { BlueprintService } from "../../packages/application/blueprint-service.ts";
import { BuilderService } from "../../packages/application/builder-service.ts";
import { HarIngestionService } from "../../packages/application/har-ingestion.ts";

import { acquireWorkerLock, applyMigrations, openWriteConnection, planMigrations } from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { connectReaStdio } from "../../packages/adapters/rea/protocol.ts";
import { ReaSession } from "../../packages/adapters/rea/session.ts";
import { ReaCaptureInspector } from "../../packages/adapters/rea/capture-inspection.ts";
import { WebCaptureEvidenceFacts } from "../../packages/adapters/rea/web-capture-records.ts";
import { createProjectRequestSchema } from "../../packages/contracts/resources.ts";
import { candidateGenerateRequestSchema } from "../../packages/contracts/candidate.ts";

// The worker composition root (DESIGN §2, §3, §14; issue #16).
//
// One object holds the single write connection, the worker lock, the resolved
// BootConfig and the services; every other process reaches it through a named
// command. There is deliberately no catch-all handler and no SQL surface: an
// unknown command name is a refusal, and the web process cannot open this database
// even if it were asked to.

const LIMITS = { maxDepth: 24, maxCodeUnits: 2_000_000 };
const RECOVERY_SCAN_LIMIT = 500;

export type CompositionRequest = {
  env: Readonly<Record<string, string | undefined>>;
  installedDefaults: Readonly<Record<string, string | undefined>>;
  // The installed package's profile directory — never a target upload (§14).
  profileDir: string;
  toolchain: { nodeVersion: string; requiredNodeVersion: string };
  // A host that can enforce a container sandbox reports true; this build cannot
  // claim it on macOS, and the doctor says so instead of assuming it (§14).
  sandboxEnforced?: boolean;
  // §14 gives these two lifetimes an expiry but no number; the application module
  // holds the defaults, and a caller that wants a shorter life passes one here.
  sessionTtlMs?: number;
  bootstrapTtlMs?: number;
};

export const COMMAND_NAMES = [
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
  // The Builder's own operation (§7.3, §10 / issue #19). It is a command like any
  // other, so the actor kind arrives on the frame and the service — not this table —
  // decides whether that kind may generate.
  "candidate.generate",
  "health.effectiveProfiles",
  "doctor.run",
  "jobs.recover",
  // Session pairing and the event read (DESIGN §8, §14; issue #17). The web process
  // holds no session store of its own: §14 puts sessions in the worker's memory, so
  // a worker restart drops every cookie in circulation and the API cannot outlive the
  // authority that issued it.
  "session.pair",
  "session.read",
  "session.revoke",
  "events.after",
] as const;

// Commands that legitimately name no project (§12.2: local pairing, revocation and
// the health surfaces are project-less, not project-unknown).
const PROJECTLESS_COMMANDS: readonly string[] = [
  "project.create",
  "health.effectiveProfiles",
  "doctor.run",
  "jobs.recover",
  "session.pair",
  "session.read",
  "session.revoke",
];

export type CommandName = (typeof COMMAND_NAMES)[number];
export type CommandOutcome = Result<JsonValue, GateFailure>;

// What `session.pair` hands back to the HTTP adapter: the cookie value, the local
// review identifier and the CSRF secret. The adapter puts exactly two of those in a
// body and one in a Set-Cookie, and stores none of them anywhere else (§14).
type PairedSession = {
  sessionKey: string;
  reviewerId: Id;
  csrfToken: string;
  expiresAt: Instant;
};

export type BootFailure = {
  kind: "config" | "lock" | "storage";
  reasons: string[];
};

export type WorkerHandle = {
  config: BootConfig;
  registry: ProfileRegistry;
  // The worker's own write connection. It is on the handle because the
  // composition root is the only owner of it: `apps/web` may not import the
  // storage adapter at all (the dependency-direction test enforces that), so no
  // request path can reach SQLite through here.
  writeConnection: SqliteStorageWriter;
  rpcSocketPath: string;
  commands: readonly CommandName[];
  dispatch: (name: string, payload: JsonValue, actor: Actor) => Promise<CommandOutcome>;
  doctor: () => Promise<DoctorReport>;
  recovery: () => Result<RecoveryReport, GateFailure>;
  // The one-time pairing code this start command minted (§14). It is reachable only
  // from the local process: there is no command that asks the worker for a code, so
  // a web request cannot mint one, and `mintPairingCode` is how the operator asks for
  // a replacement in person.
  pairingCode: () => PairingCode;
  mintPairingCode: () => PairingCode;
  activeSessions: () => number;
  shutdown: () => Promise<void>;
};

export function filesystemProbe(): ConfigInput["filesystem"] {
  return {
    isDirectory(target: string): boolean {
      try {
        return statSync(target).isDirectory();
      } catch {
        return false;
      }
    },
    isFile(target: string): boolean {
      try {
        return statSync(target).isFile();
      } catch {
        return false;
      }
    },
    isSocket(target: string): boolean {
      try {
        return lstatSync(target).isSocket();
      } catch {
        return false;
      }
    },
    isWriteable(target: string): boolean {
      const probe = path.join(target, `.wb-write-probe-${String(process.pid)}`);
      try {
        const fd = openSync(probe, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        closeSync(fd);
        unlinkSync(probe);
        return true;
      } catch {
        try {
          unlinkSync(probe);
        } catch {
          // Nothing to remove: the probe never landed.
        }
        return false;
      }
    },
    // Private means no group or other access bits: a data directory readable by
    // others would expose every artifact behind the worker lock.
    isPrivateDirectory(target: string): boolean {
      try {
        return (statSync(target).mode & 0o077) === 0;
      } catch {
        return false;
      }
    },
  };
}

function readProfiles(profileDir: string): { label: string; json: JsonValue }[] {
  let names: string[];
  try {
    names = readdirSync(profileDir);
  } catch {
    return [];
  }
  const entries: { label: string; json: JsonValue }[] = [];
  for (const name of names.filter((file) => file.endsWith(".json")).sort()) {
    const label = path.basename(name, ".json");
    try {
      entries.push({ label, json: JSON.parse(readFileSync(path.join(profileDir, name), "utf8")) as JsonValue });
    } catch {
      entries.push({ label, json: "unreadable" });
    }
  }
  return entries;
}

function digestOfFile(target: string): Digest | null {
  try {
    return asDigest(createHash("sha256").update(readFileSync(target)).digest("hex"));
  } catch {
    return null;
  }
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}

function pickId(value: JsonValue, field: string): Id | null {
  const raw = asRecord(value)[field];
  return typeof raw === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)
    ? asId(raw)
    : null;
}

function pickString(value: JsonValue, field: string): string | null {
  const raw = asRecord(value)[field];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function stringList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string") as string[];
}

// An upload arrives as base64 in one frame; the canonical-form check is the same
// one the vector layer applies, so a second spelling of the same bytes is refused
// before it can become a stored artifact.
function pickBase64(value: JsonValue, field: string): Uint8Array | null {
  const raw = asRecord(value)[field];
  if (typeof raw !== "string" || raw.length === 0 || raw.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return null;
  try {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

// `commitDecision` answers with the decided value *and* the journal sequence it
// wrote. The sequence is this process's bookkeeping, not part of the caller's
// contract, so a command that returns a decision unwraps it here rather than
// handing the adapter an envelope the reply schema then refuses.
function relayDecision<T>(
  result: Result<{ value: T; auditSeq: number }, GateFailure>,
): CommandOutcome {
  if (!result.ok) return result;
  return { ok: true, value: result.value.value as unknown as JsonValue };
}

function relay<T>(result: Result<T, GateFailure>): CommandOutcome {
  if (!result.ok) return result;
  return { ok: true, value: result.value as unknown as JsonValue };
}

// A port error is never forwarded verbatim: it is a storage or artifact failure,
// and the caller only ever sees a named API code with a safe message.
function relayPort<T>(result: Result<T, { code: string; message: string }>): CommandOutcome {
  if (!result.ok) return gateFail("INVALID_INPUT", result.error.code, result.error.message);
  return { ok: true, value: result.value as unknown as JsonValue };
}

function missing(...ids: readonly (Id | null)[]): CommandOutcome | null {
  return ids.some((id) => id === null)
    ? gateFail("INVALID_INPUT", "command-ids", "the command is missing a required opaque id")
    : null;
}

export async function bootWorker(request: CompositionRequest): Promise<Result<WorkerHandle, BootFailure>> {
  // Exactly the declared names are read out of the environment. Whatever else
  // `process.env` holds stays out of the resolved configuration (§14).
  const env: Record<string, string | undefined> = {};
  for (const field of BOOT_CONFIG_FIELDS) env[field] = request.env[field];

  const resolved = resolveBootConfig({
    env,
    installedDefaults: request.installedDefaults,
    filesystem: filesystemProbe(),
  });
  if (resolved.kind === "invalid") {
    return {
      ok: false,
      error: { kind: "config", reasons: resolved.failures.map((failure) => `${failure.field}:${failure.reason}`) },
    };
  }
  const config = resolved.config;

  const lock = await acquireWorkerLock(config.dataDir);
  if (!lock.ok) {
    return { ok: false, error: { kind: "lock", reasons: ["worker-lock-held-by-another-process"] } };
  }
  const held = lock.value;

  const opened = openWriteConnection(config.dataDir);
  if (!opened.ok) {
    await held.release();
    return { ok: false, error: { kind: "storage", reasons: ["write-connection-refused"] } };
  }
  const db = opened.value.db;
  const planned = planMigrations(db);
  if (!planned.ok) {
    db.close();
    await held.release();
    return { ok: false, error: { kind: "storage", reasons: ["migration-plan-rejected"] } };
  }
  const applied = applyMigrations(db, planned.value);
  const migrationsApplied = applied.ok ? applied.value.length : 0;
  if (!applied.ok) {
    db.close();
    await held.release();
    return { ok: false, error: { kind: "storage", reasons: ["migration-apply-failed"] } };
  }

  const writer = new SqliteStorageWriter(db);
  const store = new ArtifactStore(config.dataDir);
  // §14: the pairing code and the sessions are this process's memory and nothing
  // else. They are minted here, at the same moment the write lock is taken, so the
  // code the terminal is about to show belongs to the worker that will honour it.
  const bootstraps = new BootstrapTokenVault();
  const sessions = new SessionService();
  // One live code per start command: minting a replacement destroys the previous one,
  // and nothing on the RPC surface can ask for either.
  let currentPairing: PairingCode = bootstraps.mint(Date.now(), request.bootstrapTtlMs ?? undefined);
  const sessionTtl = (): number | undefined => request.sessionTtlMs;
  const profiles = new ProfileRegistry(readProfiles(request.profileDir), {
    supportedPlatform: process.platform === "linux" && process.arch === "x64",
    canEnforceSandbox: request.sandboxEnforced === true,
    reaPackageDigest: digestOfFile(config.reaEntrypoint),
  });

  const vectors = new VectorService({
    storage: writer,
    artifacts: store,
    facts: new WebCaptureEvidenceFacts({ storage: writer, artifacts: store, limits: LIMITS }),
    limits: LIMITS,
  });
  const contracts = new ContractService({ storage: writer, limits: LIMITS, vectors });
  const plans = new PlanService({ storage: writer, limits: LIMITS });
  const blueprints = new BlueprintService({ storage: writer, artifacts: store, vectors, limits: LIMITS });
  const builder = new BuilderService({ storage: writer, artifacts: store, limits: LIMITS });

  let session: ReaSession | null = null;
  function providerSession(): Result<ReaSession, GateFailure> {
    if (session !== null) return { ok: true, value: session };
    const connected = connectReaStdio(process.execPath, [config.reaEntrypoint], {
      timeoutMs: 15_000,
      // The child receives an explicit environment: nothing ambient is forwarded
      // into an analysis process (§12, D21).
      env: { PATH: "/usr/bin:/bin" },
    });
    if (!connected.ok) return gateFail("CAPABILITY_UNAVAILABLE", "provider-connect-failed", connected.error.message);
    const created = new ReaSession(connected.value);
    session = created;
    return { ok: true, value: created };
  }

  function ingestionService(): Result<HarIngestionService, GateFailure> {
    const peer = providerSession();
    if (!peer.ok) return peer;
    return {
      ok: true,
      value: new HarIngestionService({
        storage: writer,
        artifacts: store,
        inspector: new ReaCaptureInspector({ session: peer.value }),
        ledger: peer.value,
        limits: LIMITS,
      }),
    };
  }

  const handlers: Record<CommandName, (payload: JsonValue, actor: Actor) => Promise<CommandOutcome> | CommandOutcome> = {
    "project.create": (payload) => {
      const parsed = createProjectRequestSchema.safeParse(payload);
      if (!parsed.success) return gateFail("INVALID_INPUT", "project-create", "project create request rejected");
      const id = newId();
      const created = writer.transact((tx) => {
        tx.insertProject({
          id,
          name: parsed.data.name,
          createdAt: nowInstant(),
          graphRevision: 0,
          inventoryRevision: 0,
          schemaVersion: 1,
        });
        return tx.getProject(id);
      });
      if (!created.ok) return relayPort(created);
      if (created.value === null) return gateFail("NOT_FOUND", "project-vanished", "the created project row is missing");
      const project = created.value;
      return relay({
        ok: true,
        value: { id: project.id, name: project.name, graphRevision: project.graphRevision, inventoryRevision: project.inventoryRevision, createdAt: project.createdAt },
      });
    },
    "project.get": (payload) => {
      const projectId = pickId(payload, "projectId");
      const refused = missing(projectId);
      if (refused !== null) return refused;
      const read = writer.transact((tx) => tx.getProject(projectId as Id));
      if (!read.ok) return relayPort(read);
      if (read.value === null) return gateFail("NOT_FOUND", "project-unknown", "project not found");
      return relay({ ok: true, value: { id: read.value.id, name: read.value.name, inventoryRevision: read.value.inventoryRevision } });
    },
    "capture.importHar": async (payload, actor) => {
      const projectId = pickId(payload, "projectId");
      const bytes = pickBase64(payload, "bytesBase64");
      const refused = missing(projectId);
      if (refused !== null) return refused;
      if (bytes === null) return gateFail("INVALID_INPUT", "import-bytes", "the upload must be canonical base64");
      const service = ingestionService();
      if (!service.ok) return service;
      const fields = asRecord(payload);
      return relay(
        await service.value.importCapture(projectId as Id, actor, fields["command"] ?? {}, bytes, {
          sensitive: { declaredValues: stringList(fields["sensitiveValues"]) },
        }),
      );
    },
    "job.get": (payload) => {
      const projectId = pickId(payload, "projectId");
      const jobId = pickId(payload, "jobId");
      const refused = missing(projectId, jobId);
      if (refused !== null) return refused;
      const read = writer.transact((tx) => tx.getJob(projectId as Id, jobId as Id));
      if (!read.ok) return relayPort(read);
      const job = read.value;
      if (job === null) return gateFail("NOT_FOUND", "job-unknown", "job not found");
      return relay({
        ok: true,
        value: {
          id: job.id,
          kind: job.kind,
          state: job.state,
          cleanupState: job.cleanupState,
          deadlineAt: job.deadlineAt,
          retryAt: job.retryAt,
          resultRef: job.resultRef,
        },
      });
    },
    "evidence.get": async (payload) => {
      const projectId = pickId(payload, "projectId");
      const evidenceId = pickString(payload, "evidenceId");
      if (projectId === null || evidenceId === null) return gateFail("INVALID_INPUT", "evidence-ids", "projectId and evidenceId are required");
      const read = writer.transact((tx) => {
        const row = tx.getEvidence(projectId, evidenceId);
        return row === null ? null : tx.getArtifact(projectId, row.artifactId);
      });
      if (!read.ok) return relayPort(read);
      if (read.value === null) return gateFail("NOT_FOUND", "evidence-unknown", "evidence not found");
      const bytes = await store.read(projectId, read.value.storageKey);
      if (!bytes.ok) return relayPort(bytes);
      try {
        return relay({ ok: true, value: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes.value)) as JsonValue });
      } catch {
        return gateFail("REA_CONTRACT_MISMATCH", "evidence-unreadable", "the stored envelope is not JSON");
      }
    },
    "vector.create": async (payload, actor) => {
      const projectId = pickId(payload, "projectId");
      const refused = missing(projectId);
      if (refused !== null) return refused;
      const fields = asRecord(payload);
      return relay(
        await vectors.create(projectId as Id, actor, fields["request"] ?? {}, {
          sensitive: { declaredValues: stringList(fields["sensitiveValues"]) },
        }),
      );
    },
    "vector.read": async (payload, actor) => {
      const projectId = pickId(payload, "projectId");
      const vectorId = pickId(payload, "vectorId");
      const refused = missing(projectId, vectorId);
      if (refused !== null) return refused;
      return relay(await vectors.read(projectId as Id, actor, vectorId as Id));
    },
    "vector.list": (payload, actor) => relay(vectors.list(projectIdOr(payload), actor, pickId(payload, "targetId"))),
    "vector.review": async (payload, actor) => {
      const projectId = pickId(payload, "projectId");
      const vectorId = pickId(payload, "vectorId");
      const refused = missing(projectId, vectorId);
      if (refused !== null) return refused;
      const fields = asRecord(payload);
      return relay(
        await vectors.review(projectId as Id, actor, vectorId as Id, fields["request"] ?? {}, {
          sensitive: { declaredValues: stringList(fields["sensitiveValues"]) },
        }),
      );
    },
    "contract.create": (payload, actor) => relay(contracts.createDraft(projectIdOr(payload), actor, asRecord(payload)["request"] ?? {})),
    "contract.review": async (payload, actor) => {
      const contractId = pickId(payload, "contractId");
      const refused = missing(contractId);
      if (refused !== null) return refused;
      return relay(await contracts.review(projectIdOr(payload), actor, contractId as Id, asRecord(payload)["request"] ?? {}));
    },
    "plan.build": (payload, actor) => relay(plans.build(projectIdOr(payload), actor, asRecord(payload)["request"] ?? {})),
    "plan.review": (payload, actor) => {
      const planId = pickId(payload, "planId");
      const refused = missing(planId);
      if (refused !== null) return refused;
      return relay(plans.review(projectIdOr(payload), actor, planId as Id, asRecord(payload)["request"] ?? {}));
    },
    "plan.read": (payload, actor) => {
      const planId = pickId(payload, "planId");
      const refused = missing(planId);
      if (refused !== null) return refused;
      return relay(plans.read(projectIdOr(payload), actor, planId as Id));
    },
    "blueprint.freeze": async (payload, actor) =>
      relay(await blueprints.freeze(projectIdOr(payload), actor, asRecord(payload)["request"] ?? {})),
    "blueprint.handoff": async (payload) => {
      const blueprintId = pickId(payload, "blueprintId");
      const refused = missing(blueprintId);
      if (refused !== null) return refused;
      return relay(await blueprints.handoff(projectIdOr(payload), blueprintId as Id));
    },
    "blueprint.manifest": async (payload, actor) => {
      const blueprintId = pickId(payload, "blueprintId");
      const refused = missing(blueprintId);
      if (refused !== null) return refused;
      return relay(await blueprints.readSourceManifest(projectIdOr(payload), actor, blueprintId as Id));
    },
    "candidate.generate": async (payload, actor) => {
      // The command carries a blueprint id, a job id and a budget — nothing else. A
      // request that tried to name a vector, a target or an artifact key would be
      // refused by the strict schema before the Builder saw it (§7.3: the handoff is
      // the whole input). `projectId` stays outside the DTO, as with the other
      // service-backed commands, because it selects the owner rather than the input.
      const parsed = candidateGenerateRequestSchema.safeParse(asRecord(payload)["request"] ?? {});
      if (!parsed.success) return gateFail("INVALID_INPUT", "candidate-generate", "the generation request was rejected");
      const deadline = parsed.data.budget.deadlineAt;
      return relay(
        await builder.generate(projectIdOr(payload), actor, asId(parsed.data.blueprintId), {
          budget: {
            maxAttemptsPerBlueprint: parsed.data.budget.maxAttemptsPerBlueprint,
            deadlineAt: deadline === null ? null : asInstant(deadline),
          },
          generator: parsed.data.generator,
          jobId: asId(parsed.data.jobId),
        }),
      );
    },
    "health.effectiveProfiles": () => relay({ ok: true, value: profiles.healthView() }),
    "doctor.run": async () => relay({ ok: true, value: (await doctorReport()) as unknown as JsonValue }),
    "jobs.recover": () => relay(recovery()),
    // Pairing (DESIGN §8, §14). The code is consumed before anything is granted, the
    // grant is journalled inside the transaction, and a journal that cannot be written
    // takes the session back — §12.2 says a decision that cannot be journalled must not
    // happen, and pairing is the widest decision this workbench makes.
    "session.pair": (payload, actor) => {
      const parsed = bootstrapExchangeSchema.safeParse(payload);
      if (!parsed.success) return gateFail("INVALID_INPUT", "pair-payload", "the pairing request was rejected");
      const nowMs = Date.now();
      const redeemed = bootstraps.redeem(parsed.data.bootstrapToken, nowMs);
      if (!redeemed.ok) {
        recordDeny(writer, {
          projectId: null,
          actor,
          resourceType: "session",
          action: "session.pair",
          resourceId: null,
          decision: "deny",
          reasonCode: `pairing-${redeemed.error}`,
          // Nothing about the attempted value is recorded, not even its length (§12.1).
          metadata: {},
        });
        return gateFail("SESSION_REQUIRED", `pairing-${redeemed.error}`, "the pairing code was not accepted");
      }
      const minted = sessions.mint(nowMs, sessionTtl());
      const journalled = commitDecision(writer, {
        projectId: null,
        actor,
        resourceType: "session",
        action: "session.pair",
        resourceId: minted.reviewerId,
        allowReason: "pairing-code-consumed",
        metadata: { reviewerId: minted.reviewerId, expiresAt: minted.expiresAt },
        work: (): Step<PairedSession> => ({
          kind: "committed",
          value: {
            sessionKey: minted.sessionKey,
            reviewerId: minted.reviewerId,
            csrfToken: minted.csrfToken,
            expiresAt: minted.expiresAt,
          },
        }),
      });
      if (!journalled.ok) {
        sessions.revoke(minted.sessionKey);
        return journalled;
      }
      return relayDecision(journalled);
    },
    // The adapter asks this on every authenticated request, so a worker restart or an
    // expiry is felt immediately rather than when the session table is next read.
    "session.read": (payload) => {
      const sessionKey = pickString(payload, "sessionKey");
      if (sessionKey === null) return gateFail("INVALID_INPUT", "session-key-missing", "the session read needs the cookie value");
      const found = sessions.resolve(sessionKey, Date.now());
      if (found === null) return gateFail("SESSION_REQUIRED", "session-unknown", "no live session carries that cookie");
      return relay({
        ok: true,
        value: { reviewerId: found.reviewerId, csrfToken: found.csrfToken, expiresAt: found.expiresAt },
      });
    },
    "session.revoke": (payload, actor) => {
      const sessionKey = pickString(payload, "sessionKey");
      if (sessionKey === null) return gateFail("INVALID_INPUT", "session-key-missing", "the session revoke needs the cookie value");
      const found = sessions.resolve(sessionKey, Date.now());
      if (found === null) return gateFail("SESSION_REQUIRED", "session-unknown", "no live session carries that cookie");
      // Ending access happens first and always: a journal that cannot be written may
      // not leave a session alive.
      sessions.revoke(sessionKey);
      return relayDecision(commitDecision(writer, {
        projectId: null,
        actor,
        resourceType: "session",
        action: "session.revoke",
        resourceId: found.reviewerId,
        allowReason: "session-revoked",
        metadata: { reviewerId: found.reviewerId },
        work: (): Step<JsonValue> => ({ kind: "committed", value: { revoked: true } }),
      }));
    },
    // The event read behind SSE (§8, §2: 只读查询与 SSE 由 worker 提供一致快照). The
    // closed type list is applied here, on the way out of the only process that reads
    // the outbox, so a row whose type is not one of the ten never reaches a socket.
    "events.after": (payload) => {
      const projectId = pickId(payload, "projectId");
      const refused = missing(projectId);
      if (refused !== null) return refused;
      const cursor = asRecord(payload)["afterSeq"];
      if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
        return gateFail("INVALID_INPUT", "cursor-seq", "the event cursor must be a non-negative sequence number");
      }
      const requestedLimit = asRecord(payload)["limit"];
      if (requestedLimit !== null && requestedLimit !== undefined && typeof requestedLimit !== "number") {
        return gateFail("INVALID_INPUT", "cursor-limit", "the event limit must be an integer");
      }
      const pageLimit = normalizeEventLimit(typeof requestedLimit === "number" ? requestedLimit : null);
      if (!pageLimit.ok) return pageLimit;
      const read = writer.transact((tx) => {
        const head = tx.eventsAfter(projectId as Id, 0, 1)[0];
        return {
          rows: tx.eventsAfter(projectId as Id, cursor, pageLimit.value),
          oldestSeq: head === undefined ? null : head.seq,
          latestSeq: tx.latestSeq(projectId as Id),
        };
      });
      if (!read.ok) return relayPort(read);
      const validated = toStreamEvents(read.value.rows);
      if (!validated.ok) return validated;
      return relay({
        ok: true,
        value: {
          events: validated.value as unknown as JsonValue,
          oldestSeq: read.value.oldestSeq,
          latestSeq: read.value.latestSeq,
        },
      });
    },
  };

  function projectIdOr(payload: JsonValue): Id {
    return pickId(payload, "projectId") ?? ("" as Id);
  }

  function recovery(): Result<RecoveryReport, GateFailure> {
    const report = writer.transact((tx) => recoverJobs(tx, RECOVERY_SCAN_LIMIT));
    if (!report.ok) return gateFail("INVALID_INPUT", report.error.code, report.error.message);
    return { ok: true, value: report.value };
  }

  async function doctorReport(): Promise<DoctorReport> {
    const profile = profiles.get(config.sandboxProfile);
    return await runDoctor([
      {
        name: "toolchain",
        run: () =>
          request.toolchain.nodeVersion === request.toolchain.requiredNodeVersion
            ? { state: "ok", facts: { nodeMajor: request.toolchain.nodeVersion } }
            : { state: "failed", reasons: ["node-version-mismatch"] },
      },
      {
        name: "rea-package",
        run: () =>
          existsSync(config.reaEntrypoint)
            ? { state: "ok", facts: { entrypointPresent: true, digestRecorded: digestOfFile(config.reaEntrypoint) !== null } }
            : { state: "failed", reasons: ["entrypoint-missing"] },
      },
      {
        name: "rea-identity",
        run: () =>
          session === null
            ? { state: "degraded", reasons: ["no-active-provider-session"] }
            : { state: "ok", facts: { retainedEvidence: session.retained.size } },
      },
      {
        name: "sandbox-profile",
        run: (): CheckOutcome =>
          profile === null
            ? { state: "failed", reasons: ["profile-not-installed"] }
            : profile.available
              ? { state: "ok", facts: { id: profile.profile.id } }
              : { state: "degraded", reasons: profile.unavailableReasons },
      },
      {
        name: "broker-socket",
        run: (): CheckOutcome =>
          filesystemProbe().isSocket(config.brokerSocket)
            ? { state: "ok", facts: { reachable: true } }
            : { state: "failed", reasons: ["broker-socket-absent-or-not-a-socket"] },
      },
      {
        name: "network-lockdown",
        run: (): CheckOutcome =>
          profile?.available === true
            ? { state: "ok", facts: { policy: profile.profile.networkPolicyId } }
            : { state: "degraded", reasons: ["egress-policy-not-enforced-on-this-host"] },
      },
      { name: "storage-layout", run: (): CheckOutcome => ({ state: "ok", facts: { migrationsApplied } }) },
      { name: "worker-lock", run: (): CheckOutcome => ({ state: "ok", facts: { held: true } }) },
      {
        name: "limits",
        run: (): CheckOutcome =>
          profile === null
            ? { state: "failed", reasons: ["limits-unknown-no-profile"] }
            : { state: "ok", facts: profile.profile.limits as unknown as JsonValue },
      },
    ]);
  }

  return {
    ok: true,
    value: {
      config,
      registry: profiles,
      writeConnection: writer,
      rpcSocketPath: path.join(config.dataDir, WORKER_RPC_SOCKET_NAME),
      commands: COMMAND_NAMES,
      async dispatch(name, payload, actor) {
        const handler = (handlers as Record<string, ((p: JsonValue, a: Actor) => Promise<CommandOutcome> | CommandOutcome) | undefined>)[name];
        // A name that is not registered is refused rather than routed: this is the
        // only place the worker's command surface is decided.
        if (handler === undefined) return gateFail("INVALID_INPUT", "unknown-command", `no handler is registered for ${name}`);
        if (projectIdOr(payload) === ("" as Id) && !PROJECTLESS_COMMANDS.includes(name)) {
          return gateFail("INVALID_INPUT", "missing-project", "every command except project and health lookups names a project");
        }
        return await handler(payload, actor);
      },
      doctor: doctorReport,
      recovery,
      pairingCode: () => currentPairing,
      mintPairingCode: () => {
        currentPairing = bootstraps.mint(Date.now(), request.bootstrapTtlMs ?? undefined);
        return currentPairing;
      },
      activeSessions: () => sessions.activeCount(),
      async shutdown() {
        // Sessions die with the process, and saying so here keeps the promise in one
        // place: a caller that reuses the handle cannot present a live cookie after a
        // shutdown (§14: 重启也使全部会话失效).
        sessions.revokeAll();
        if (session !== null) await session.close();
        db.close();
        await held.release();
      },
    },
  };
}

export type { CheckName };

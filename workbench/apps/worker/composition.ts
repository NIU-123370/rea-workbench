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
import { fileURLToPath } from "node:url";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { asId, newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import type { JsonObject, JsonValue } from "../../packages/domain/json-value.ts";
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
import { isIdempotencyKey } from "../../packages/application/idempotency.ts";
import { BootstrapTokenVault, SessionService } from "../../packages/application/session.ts";
import type { PairingCode } from "../../packages/application/session.ts";
import { normalizeEventLimit, toStreamEvents } from "../../packages/application/event-stream.ts";
import { VectorService } from "../../packages/application/vector-service.ts";
import { ContractService } from "../../packages/application/contract-service.ts";
import { TargetService } from "../../packages/application/target-service.ts";
import { ProjectReadService } from "../../packages/application/project-read.ts";
import { JobLifecycleService } from "../../packages/application/job-lifecycle.ts";
import { JobRequestService } from "../../packages/application/job-request.ts";
import { PlanService } from "../../packages/application/plan-service.ts";
import { BlueprintService } from "../../packages/application/blueprint-service.ts";
import { BuilderService } from "../../packages/application/builder-service.ts";
import { BUILDER_STAGING_DIRNAME, makeBuilderProcessProducer, sweepRoleStaging } from "./builder-process.ts";
import { ExportService } from "../../packages/application/export-service.ts";
import { GraphReadService } from "../../packages/application/graph-read.ts";
import { CandidateReadService } from "../../packages/application/candidate-read.ts";
import { JobReadService } from "../../packages/application/job-read.ts";
import { AuditReadService } from "../../packages/application/audit-read.ts";
import { HarIngestionService } from "../../packages/application/har-ingestion.ts";
import { VerificationService } from "../../packages/application/verification-service.ts";
import { createJobRunner } from "../../packages/application/job-runner.ts";
import type { RunnerOutcome } from "../../packages/application/job-runner.ts";

import { acquireWorkerLock, applyMigrations, openWriteConnection, planMigrations } from "../../packages/adapters/storage/database.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { SqliteStorageWriter } from "../../packages/adapters/storage/writer.ts";
import { connectReaStdio } from "../../packages/adapters/rea/protocol.ts";
import { ReaSession } from "../../packages/adapters/rea/session.ts";
import { ReaCaptureInspector } from "../../packages/adapters/rea/capture-inspection.ts";
import { WebCaptureEvidenceFacts } from "../../packages/adapters/rea/web-capture-records.ts";
import { createProjectRequestSchema, projectListQuerySchema } from "../../packages/contracts/resources.ts";
import { exportCreateRequestSchema, exportReadRequestSchema } from "../../packages/contracts/export.ts";
import { graphReadRequestSchema } from "../../packages/contracts/graph.ts";
import { jobListRequestSchema } from "../../packages/contracts/jobs.ts";
import { auditListRequestSchema } from "../../packages/contracts/audit.ts";
import { vectorPageQuerySchema } from "../../packages/contracts/vectors.ts";
import { candidateFileRequestSchema, candidateReadRequestSchema } from "../../packages/contracts/candidate.ts";

// The worker composition root (DESIGN §2, §3, §14; issue #16).
//
// One object holds the single write connection, the worker lock, the resolved
// BootConfig and the services; every other process reaches it through a named
// command. There is deliberately no catch-all handler and no SQL surface: an
// unknown command name is a refusal, and the web process cannot open this database
// even if it were asked to.

const LIMITS = { maxDepth: 24, maxCodeUnits: 2_000_000 };
const RECOVERY_SCAN_LIMIT = 500;
// §8 line 271's two id lists are "the recent ones", not the whole project: a bounded newest
// first page is what keeps a screen input from becoming a table dump.
const PROJECT_VIEW_LIST_BOUND = 20;
// §8 line 281 caps the evidence body the same way and names the alternative (a download
// reference). That alternative does not exist yet, so over the cap this refuses by name
// rather than truncating a provider envelope or inventing a route outside §14.
export const EVIDENCE_INLINE_LIMIT_BYTES = 1024 * 1024;

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
  // The project page (§8 line 270): control-plane inventory only, and the cursor is the
  // server's own encoding of the last row shown.
  "projects.list",
  "capture.importHar",
  // The two target routes (§8 lines 273-274). Declaring a URL target and reading one back are
  // commands like any other, so the actor kind arrives on the frame and the service decides.
  "target.create",
  "target.read",
  "job.get",
  // The project's job page (§8 line 277): the documented way to recover a build or
  // verification resource id, because each row carries its persisted resultRef.
  "jobs.list",
  // The two job lifecycle writes (§8 lines 278-279). `job.cancel` moves the row along §11's
  // machine; `job.cleanupRetry` re-schedules owned cleanup and nothing else.
  "job.cancel",
  "job.cleanupRetry",
  // Asking for work against a target (§8 line 275). It is a *creation*, so §8 line 261 gives it an
  // Idempotency-Key, and it is the last row in §8's table that this build can mount: the body is the
  // named `CaptureTask | InspectTask` union, the answer is the queued row, and nothing in it can
  // produce a conclusion - §10. What runs the row is issue #75's other half, and the doctor says so.
  "job.request",
  // The two audit windows (§8 lines 302-303). They are separate names because the rows they
  // read are separate: one project's decisions, and the entries that belong to no project.
  "audit.list",
  "audit.listGlobal",
  "evidence.get",
  "vector.create",
  "vector.read",
  "vector.list",
  "vector.review",
  "contract.create",
  "contract.review",
  // The contract read (§8 line 288). The service has owned this rule since #12 — including the
  // Builder refusal — but until the door existed nothing outside a test could ask for it, so the
  // rule was never on the wire (issue #58).
  "contract.read",
  "plan.build",
  "plan.review",
  "plan.read",
  // The report read (§8 line 298). One name for the control-plane view of a stored report;
  // `blueprint.handoff`'s Builder-facing summary is a different projection with different rules.
  "verification.read",
  // Asking for a verification (§8 line 297). Separate from `candidate.generate` because it is a
  // different actor's decision: the Builder submits, the control plane decides what is compared
  // and against which named comparator.
  "verification.request",
  // The other half of the same row: what a verify job is *waiting for*. §10 gives the trusted
  // evaluator the completion, and §14 makes it a named command on the worker's private socket -
  // there is no §8 route for it, because an evaluator is not a browser (issue #75). The service
  // behind it owns every rule (role, named comparator policy, transcript re-hash, identity binding);
  // this name is what puts it on the wire instead of only in a test.
  "verification.complete",
  "blueprint.freeze",
  "blueprint.handoff",
  "blueprint.manifest",
  // The blueprint read (§8 line 293). `blueprint.handoff` already served the same bundle to a
  // Builder; this is the control-plane door over that one body, with the plan id added for the
  // roles §8 names - and still no way to reach the source manifest or the holdout list.
  "blueprint.read",
  // The Builder's own operation (§7.3, §10 / issue #19), asked for as work (§8 line 294 /
  // issue #57): the door enqueues a build job and the worker's runner is what executes it. There is
  // no `candidate.generate` command any more - it took a `jobId` and a budget from the caller, which
  // made the client the owner of a row §11's recovery and §12.2's journal both assume the worker
  // created.
  "candidate.request",
  // Delivery (§8 lines 299-300 / issue #22). The ZIP leaves through a named command that
  // re-runs the verified-samples gate; there is no path output parameter anywhere in it.
  "export.create",
  "export.download",
  "export.list",
  // The canvas read (§6 / F04 / issue #18): claims, edges and their stored evidence ids, with no
  // status computed here.
  "graph.read",
  // The candidate file read (§8 lines 295-296 / F08, issue #19). `:f` resolves a manifest
  // file id, never a path, so no string a client sends can reach the filesystem.
  "candidate.get",
  "candidate.file",
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
  "audit.listGlobal",
  "session.pair",
  "session.read",
  "session.revoke", "projects.list"];

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
  // One turn of the job runner (§11 / issue #57). It is on the handle rather than behind a command
  // because nothing may *ask* the worker to run a job: the queue is the worker's, the doors that
  // filled it are the only client-facing surface, and `apps/worker/main.ts` is what pumps this on a
  // timer. A test that wants a deterministic turn calls it directly.
  runJobs: () => Promise<Result<RunnerOutcome, GateFailure>>;
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

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function limitOf(payload: JsonValue): number {
  const raw = asRecord(payload)["limit"];
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? Math.min(raw, 500) : 50;
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
  // A role run that outlived its worker is staging this code owns, and §5 says crash
  // recovery may reclaim exactly that. It happens before the first command is served, so no
  // live run can be mistaken for an orphan.
  const builderStagingRoot = path.join(config.dataDir, BUILDER_STAGING_DIRNAME);
  const sweptRoleRuns = sweepRoleStaging(builderStagingRoot);

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
  const targets = new TargetService({ storage: writer });
  const projectPage = new ProjectReadService({ storage: writer });
  const lifecycle = new JobLifecycleService({ storage: writer });
  // Asking for work against a target (§8 line 275). The one thing this service cannot own is the
  // profile registry: §14 makes the installed profile the only source of a job's wait budget, and a
  // capture task names that profile by id. So the registry is handed down as a question - "is there a
  // profile under this name, and what is its queue wait" - and a name with no profile behind it is a
  // refusal rather than a number invented here. Like `generationContext`, this asks `get` rather than
  // `availableFor`: whether this host can enforce the sandbox is the doctor's sentence, not a claim
  // about the numbers in the file.
  const jobRequests = new JobRequestService({
    storage: writer,
    limits: LIMITS,
    profiles: {
      resolve: (profileId) => {
        const entry = profiles.get(profileId);
        return entry === null ? null : { queueWaitMs: entry.profile.limits.queueWaitMs };
      },
    },
  });
  const contracts = new ContractService({ storage: writer, limits: LIMITS, vectors });
  const plans = new PlanService({ storage: writer, limits: LIMITS });
  const blueprints = new BlueprintService({ storage: writer, artifacts: store, vectors, limits: LIMITS });
  // §2 and §5 line 425 put the Builder in its own process with its own file view, so the
  // worker hands the role one handoff file in a directory the role owns and verifies what
  // comes back. The service still owns publishing and the candidate identity.
  const builder = new BuilderService({
    storage: writer,
    artifacts: store,
    limits: LIMITS,
    produce: makeBuilderProcessProducer({
      stagingRoot: builderStagingRoot,
      entryFile: fileURLToPath(new URL("builder-child.ts", import.meta.url)),
    }),
  });
  const verifications = new VerificationService({ storage: writer, artifacts: store, vectors, limits: LIMITS });
  const graph = new GraphReadService({ storage: writer });
  const candidateRead = new CandidateReadService({ storage: writer, artifacts: store });
  const jobRead = new JobReadService({ storage: writer });
  const auditRead = new AuditReadService({ storage: writer });
  const exports_ = new ExportService({
    storage: writer,
    artifacts: store,
    verification: verifications,
    limits: LIMITS,
    zipLimits: { maxEntries: 16, maxUncompressedBytes: 32_000_000, maxArchiveBytes: 34_000_000 },
  });

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

  // The two profile facts generation needs. `get` rather than `availableFor` is the deliberate part:
  // `available` answers "can this host enforce the sandbox", which the doctor reports and the Builder
  // child's seccomp profile decides — it is not a statement about the numbers in the file. Requiring
  // it here would make generation impossible on every host that is not verified Linux x64, which is a
  // claim §7.3 does not make. What is still refused is the thing §14 cares about: a profile that did
  // not parse has no numbers, and no number is invented in its place (§7.3, §10, issue #57).
  function generationContext(): Result<{ queueWaitMs: number; maxGenerationAttempts: number }, GateFailure> {
    if (config.modelEndpoint === null) {
      return gateFail(
        "CAPABILITY_UNAVAILABLE",
        "generation-endpoint-not-configured",
        "generation is off while no model endpoint is declared (§3: 缺省即关闭，不回落到隐式端点)",
      );
    }
    const entry = profiles.get(config.sandboxProfile);
    if (entry === null) {
      return gateFail("CAPABILITY_UNAVAILABLE", "generation-budget-unknown", "no profile is installed under the name that carries the generation budget");
    }
    return { ok: true, value: { queueWaitMs: entry.profile.limits.queueWaitMs, maxGenerationAttempts: entry.profile.limits.maxGenerationAttempts } };
  }

  // The identity the runner generates under (§7.3: only the Builder role may). It is minted here and
  // reachable from nowhere else - no frame, no row, no response. `generatorJson` on the candidate is
  // the same story in the other direction: it names who ran, and a model endpoint or a host path
  // would be a §12.1 leak into a row other roles read (§12.1: 记名字不记值).
  const runnerActor: Actor = { actorId: "worker-job-runner", actorKind: "builder" };
  const runnerGenerator: JsonObject = { mintedBy: "job-runner", profileId: config.sandboxProfile };
  const jobRunner = createJobRunner({
    storage: writer,
    // The same bounded worker-wide scan recovery uses: both ask "what is in the queue" without a
    // project id to narrow by, and a second limit number here would be a second thing to measure.
    scanLimit: RECOVERY_SCAN_LIMIT,
    now: nowInstant,
    builds: {
      actor: runnerActor,
      generator: runnerGenerator,
      budget: () => {
        const context = generationContext();
        return context.ok ? { ok: true, value: context.value.maxGenerationAttempts } : { ok: false, error: [context.error.reason] };
      },
      generate: (projectId, actor, blueprintId, input) => builder.generate(projectId, actor, blueprintId, input),
    },
  });

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
      // §8 line 271 names six fields, and `projectViewSchema` has carried that shape since
      // the contracts were written while no command served it: `project.get` answered three.
      // The two id lists are what makes the view a way *into* the project rather than a
      // receipt, so they come from the project's own newest rows under a bound (§8's reads are
      // screen inputs, not table dumps).
      const read = writer.transact((tx) => {
        const project = tx.getProject(projectId as Id);
        if (project === null) return null;
        return {
          project,
          targetIds: tx.listTargetsForProject(projectId as Id, PROJECT_VIEW_LIST_BOUND).map((row) => row.id),
          recentJobIds: tx
            .listJobsAfter(projectId as Id, { cursor: null, limit: PROJECT_VIEW_LIST_BOUND })
            .map((row) => row.id),
        };
      });
      if (!read.ok) return relayPort(read);
      if (read.value === null) return gateFail("NOT_FOUND", "project-unknown", "project not found");
      return relay({
        ok: true,
        value: {
          id: read.value.project.id,
          name: read.value.project.name,
          graphRevision: read.value.project.graphRevision,
          inventoryRevision: read.value.project.inventoryRevision,
          targetIds: read.value.targetIds,
          recentJobIds: read.value.recentJobIds,
        },
      });
    },
    "target.create": (payload, actor) => relay(
      targets.declare(projectIdOr(payload), actor, asRecord(payload)["request"] ?? {}),
    ),
    "target.read": (payload, actor) => {
      const targetId = pickId(payload, "targetId");
      const refused = missing(targetId);
      if (refused !== null) return refused;
      return relay(targets.read(projectIdOr(payload), actor, targetId as Id));
    },
    "projects.list": (payload, actor) => {
      const parsed = projectListQuerySchema.safeParse(asRecord(payload)["request"] ?? {});
      if (!parsed.success) return gateFail("INVALID_INPUT", "projects-list", "the project page request was rejected");
      return relay(projectPage.list(actor, { cursor: parsed.data.cursor ?? null, limit: parsed.data.limit ?? null }));
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
    "job.cancel": (payload, actor) => {
      const jobId = pickId(payload, "jobId");
      const refused = missing(jobId);
      if (refused !== null) return refused;
      return relay(lifecycle.cancel(projectIdOr(payload), actor, jobId as Id));
    },
    "job.cleanupRetry": (payload, actor) => {
      const jobId = pickId(payload, "jobId");
      const refused = missing(jobId);
      if (refused !== null) return refused;
      return relay(lifecycle.retryCleanup(projectIdOr(payload), actor, jobId as Id));
    },
    // §8 line 275. The key is required here for the same reason it is required on the other
    // creations: the jobs row carries it, and §5's unique (project, idempotency_key) index is what
    // makes a retry land on one row rather than two pieces of queued work.
    "job.request": (payload, actor) => {
      const key = pickString(payload, "idempotencyKey");
      if (key === null || !isIdempotencyKey(key)) {
        return gateFail("INVALID_INPUT", "idempotency-key-required", "a job request carries an Idempotency-Key (§8 line 261)");
      }
      return relay(
        jobRequests.request(projectIdOr(payload), actor, asRecord(payload)["request"] ?? {}, key, {
          defaultProfileId: config.sandboxProfile,
        }),
      );
    },
    "job.get": (payload, actor) => {
      const projectId = pickId(payload, "projectId");
      const jobId = pickId(payload, "jobId");
      const refused = missing(projectId, jobId);
      if (refused !== null) return refused;
      return relay(jobRead.get(projectId as Id, actor, jobId as Id));
    },
    "jobs.list": (payload, actor) => {
      const parsed = jobListRequestSchema.safeParse(asRecord(payload)["request"] ?? {});
      if (!parsed.success) return gateFail("INVALID_INPUT", "jobs-list", "the job page request was rejected");
      return relay(
        jobRead.list(projectIdOr(payload), actor, {
          cursor: parsed.data.cursor ?? null,
          limit: parsed.data.limit,
        }),
      );
    },
    "audit.list": (payload, actor) => {
      const parsed = auditListRequestSchema.safeParse(asRecord(payload)["request"] ?? {});
      if (!parsed.success) return gateFail("INVALID_INPUT", "audit-list", "the audit page request was rejected");
      return relay(auditRead.listProject(projectIdOr(payload), actor, { after: parsed.data.after ?? null, limit: parsed.data.limit }));
    },
    "audit.listGlobal": (payload, actor) => {
      const parsed = auditListRequestSchema.safeParse(asRecord(payload)["request"] ?? {});
      if (!parsed.success) return gateFail("INVALID_INPUT", "audit-list", "the audit page request was rejected");
      // No project id is accepted here at all: the strict request shape has none, and the
      // rows this reads are the ones whose `project_id` is NULL (§8 line 303). A caller that
      // wanted another project's journal has to use the project-scoped route and be judged
      // against that project.
      return relay(auditRead.listGlobal(actor, { after: parsed.data.after ?? null, limit: parsed.data.limit }));
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
      const artifact = read.value;
      if (artifact.byteLength > EVIDENCE_INLINE_LIMIT_BYTES) {
        return gateFail(
          "RESOURCE_LIMIT",
          "evidence-over-inline-limit",
          `this envelope is ${String(artifact.byteLength)} bytes and the inline body caps at ${String(EVIDENCE_INLINE_LIMIT_BYTES)}`,
          { byteLength: artifact.byteLength, limit: EVIDENCE_INLINE_LIMIT_BYTES },
        );
      }
      const bytes = await store.read(projectId, artifact.storageKey);
      if (!bytes.ok) return relayPort(bytes);
      // The stored bytes are the provider envelope; §8 line 281 puts it under `evidence`
      // rather than loose at the top level, so the reply says which of its own fields it is.
      try {
        const envelope = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes.value)) as JsonValue;
        return relay({ ok: true, value: { evidence: envelope, mediaType: artifact.mediaType, byteLength: artifact.byteLength, sha256: artifact.sha256 } });
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
    "vector.list": (payload, actor) => {
      // The inventory page (§8 line 283). A target is required: an inventory is per capture
      // snapshot, and a page across all of a project's targets would mix two denominators.
      const parsed = vectorPageQuerySchema.safeParse(asRecord(payload)["request"] ?? {});
      if (!parsed.success) return gateFail("INVALID_INPUT", "vector-list", "the inventory page request was rejected");
      const targetId = parsed.data.targetId;
      return relay(
        vectors.page(projectIdOr(payload), actor, {
          targetId: asId(targetId),
          cursor: parsed.data.cursor ?? null,
          limit: parsed.data.limit,
        }),
      );
    },
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
    // §8 line 288: the stored revision, projected through the same schema the review answers
    // with. The service owns the role rule (a Builder reads blueprint projections only).
    "contract.read": (payload, actor) => {
      const contractId = pickId(payload, "contractId");
      const refused = missing(contractId);
      if (refused !== null) return refused;
      return relay(contracts.read(projectIdOr(payload), actor, contractId as Id));
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
    // §8 line 298. The service answers with the report *and* the staleness it re-derived from
    // the rows that exist now; the route's documented body is the report, so the view crosses the
    // socket whole and the door picks the half §8 names. Dropping it here instead would leave the
    // command unable to say what it measured.
    "verification.read": async (payload, actor) => {
      const verificationId = pickId(payload, "verificationId");
      const refused = missing(verificationId);
      if (refused !== null) return refused;
      return relay(await verifications.read(projectIdOr(payload), actor, verificationId as Id));
    },
    // §8 line 297. The key travels on the frame rather than being minted here because the jobs row
    // is what enforces it: §5 gives (project, idempotency_key) a unique index, so the worker owns
    // the replay and a second caller cannot slip an unkeyed verification past it.
    "verification.request": (payload, actor) => {
      const key = pickString(payload, "idempotencyKey");
      if (key === null || !isIdempotencyKey(key)) {
        return gateFail("INVALID_INPUT", "idempotency-key-required", "a verification request carries an Idempotency-Key (§8 line 261)");
      }
      return relay(verifications.request(projectIdOr(payload), actor, asRecord(payload)["request"] ?? {}, key));
    },
    // The evaluator's completion (§10's 具名 completion RPC). The frame's actor is what the service
    // gates on - a builder or an inspector reaching this name is refused there with its own reason,
    // not filtered here - and the payload is passed as the service's own schema reads it, so the
    // staging bytes stay an opaque id plus a digest rather than a path or a storage key.
    "verification.complete": async (payload, actor) =>
      relay(await verifications.complete(projectIdOr(payload), actor, asRecord(payload)["request"] ?? {})),
    "blueprint.freeze": async (payload, actor) =>
      relay(await blueprints.freeze(projectIdOr(payload), actor, asRecord(payload)["request"] ?? {})),
    "blueprint.read": async (payload, actor) => {
      const blueprintId = pickId(payload, "blueprintId");
      const refused = missing(blueprintId);
      if (refused !== null) return refused;
      return relay(await blueprints.read(projectIdOr(payload), actor, blueprintId as Id));
    },
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
    // §8 line 294 with issue #57's shape: the request names a blueprint and at most a deadline, the
    // key is required (§8 line 261's creation list), and the answer is the job row this call wrote.
    // The two profile facts it needs - the queue wait and the attempt budget - are read through
    // `availableFor`, so an unavailable profile is a named refusal here rather than a job that runs
    // uncapped or a number this file invented. The same `generationContext` backs the runner.
    "candidate.request": (payload, actor) => {
      const key = pickString(payload, "idempotencyKey");
      if (key === null || !isIdempotencyKey(key)) {
        return gateFail("INVALID_INPUT", "idempotency-key-required", "a generation request carries an Idempotency-Key (§8 line 261)");
      }
      const context = generationContext();
      if (!context.ok) return context;
      return relay(
        builder.request(projectIdOr(payload), actor, asRecord(payload)["request"] ?? {}, key, {
          queueWaitMs: context.value.queueWaitMs,
        }),
      );
    },
    "export.create": async (payload, actor) => {
      const parsed = exportCreateRequestSchema.safeParse(asRecord(payload)["request"] ?? {});
      if (!parsed.success) return gateFail("INVALID_INPUT", "export-create", "the export request was rejected");
      const verificationId = parsed.data.verificationId ?? null;
      return relay(
        await exports_.create(projectIdOr(payload), actor, {
          candidateId: asId(parsed.data.candidateId),
          verificationId: verificationId === null ? null : asId(verificationId),
          label: parsed.data.label,
        }),
      );
    },
    "export.download": async (payload, actor) => {
      const parsed = exportReadRequestSchema.safeParse(asRecord(payload)["request"] ?? {});
      if (!parsed.success) return gateFail("INVALID_INPUT", "export-download", "the download request was rejected");
      const archived = await exports_.archive(projectIdOr(payload), actor, asId(parsed.data.exportId));
      if (!archived.ok) return archived;
      // The bytes cross the private RPC as base64 in one frame because the web process may
      // not open the artifact store (§8). The reply is the archive plus the digest the row
      // recorded, so a client can check what it got before it hands it to a browser.
      return relay({
        ok: true,
        value: {
          exportId: archived.value.exportId,
          sha256: archived.value.sha256,
          byteLength: archived.value.byteLength,
          mediaType: archived.value.mediaType,
          bytesBase64: toBase64(archived.value.bytes),
        },
      });
    },
    "export.list": async (payload, actor) =>
      relay(await exports_.list(projectIdOr(payload), actor, limitOf(payload))),
    "graph.read": (payload, actor) => {
      const parsed = graphReadRequestSchema.safeParse(asRecord(payload)["request"] ?? {});
      if (!parsed.success) return gateFail("INVALID_INPUT", "graph-read", "the graph read request was rejected");
      const target = parsed.data.targetId;
      return relay(
        target === undefined
          ? graph.read(projectIdOr(payload), actor)
          : graph.read(projectIdOr(payload), actor, asId(target)),
      );
    },
    "candidate.get": (payload, actor) => {
      const parsed = candidateReadRequestSchema.safeParse(asRecord(payload)["request"] ?? {});
      if (!parsed.success) return gateFail("INVALID_INPUT", "candidate-read", "the candidate read request was rejected");
      return relay(candidateRead.get(projectIdOr(payload), actor, asId(parsed.data.candidateId)));
    },
    "candidate.file": async (payload, actor) => {
      const parsed = candidateFileRequestSchema.safeParse(asRecord(payload)["request"] ?? {});
      if (!parsed.success) return gateFail("INVALID_INPUT", "candidate-file-read", "the candidate file request was rejected");
      return relay(await candidateRead.file(projectIdOr(payload), actor, asId(parsed.data.candidateId), asId(parsed.data.fileId)));
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
      { name: "storage-layout", run: (): CheckOutcome => ({ state: "ok", facts: { migrationsApplied, sweptRoleRuns } }) },
      { name: "worker-lock", run: (): CheckOutcome => ({ state: "ok", facts: { held: true } }) },
      {
        name: "limits",
        run: (): CheckOutcome =>
          profile === null
            ? { state: "failed", reasons: ["limits-unknown-no-profile"] }
            : { state: "ok", facts: profile.profile.limits as unknown as JsonValue },
      },
      {
        // §10's evaluator is a separate trusted process this build does not ship, and the runner
        // deliberately does not take `verify` rows (issue #75). The check stays quiet while nothing
        // is waiting on that absent executor and says so in the surface built for it as soon as
        // something is - which is what keeps a `queued` verification from reading as "in progress".
        name: "verification-executor",
        run: (): CheckOutcome => {
          const waiting = writer.transact((tx) => tx.listJobsByStates(["queued"], RECOVERY_SCAN_LIMIT).filter((job) => job.kind === "verify").length);
          if (!waiting.ok) return { state: "failed", reasons: [`verification-queue-read-${waiting.error.code}`] };
          return waiting.value === 0
            ? { state: "ok", facts: { queuedVerifyCount: 0 } }
            : { state: "degraded", reasons: ["verification-executor-not-installed"] };
        },
      },
      {
        // The same sentence for the two kinds §8 line 275 can now queue. The runner takes `build` rows
        // only (issue #57's shape), and nothing in this build drives a browser or decodes an archive,
        // so a `capture` or `inspect` row sits at `queued` until an executor exists. Without this cell
        // the door would be the only place that ever claimed the work was on its way.
        name: "target-work-executor",
        run: (): CheckOutcome => {
          const waiting = writer.transact((tx) => {
            const queued = tx.listJobsByStates(["queued"], RECOVERY_SCAN_LIMIT);
            return {
              captures: queued.filter((job) => job.kind === "capture").length,
              inspects: queued.filter((job) => job.kind === "inspect").length,
            };
          });
          if (!waiting.ok) return { state: "failed", reasons: [`target-work-queue-read-${waiting.error.code}`] };
          return waiting.value.captures + waiting.value.inspects === 0
            ? { state: "ok", facts: { queuedCaptureCount: waiting.value.captures, queuedInspectCount: waiting.value.inspects } }
            : { state: "degraded", reasons: ["target-work-executor-not-installed"] };
        },
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
      runJobs: () => jobRunner.runOnce(),
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

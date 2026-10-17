import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asId, newId } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { digestBytes } from "../../packages/domain/canonical-json.ts";
import { jobRecordSchema } from "../../packages/contracts/jobs.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { WORKER_SCHEDULER_MS, bootWorker } from "../../apps/worker/composition.ts";
import type { WorkerHandle } from "../../apps/worker/composition.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type { RunnerOutcome } from "../../packages/application/job-runner.ts";
import type { Result } from "../../packages/domain/result.ts";

// §11's executor half, extended to the second kind this build can actually run (issue #108).
//
// `POST /projects/:p/imports` has had a browser door since round seven, and every reading taken
// through it stopped at the queued row: `HarIngestionService.runInspection` - the code that turns the
// uploaded bytes into an evidence record - had no production caller at all. This file is the proof
// that the row now has a driver: an upload, one runner turn, and §8 line 281's evidence read answers
// for something a request made rather than something a test inserted.
//
// The provider here is `tests/fixtures/rea-mcp-fixture.mjs` in its `har_records` case, the same one
// `har-import.test.ts` drives the service against directly. Composition spawns the entrypoint with an
// explicit environment (§12: nothing ambient is forwarded), so the case is selected by a wrapper that
// sets it in-process rather than by an env var the child would never receive.

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "rea-mcp-fixture.mjs");
const SECRET = "sup3r-secret-token-value";
const EVIDENCE_ID = `ev_${"a".repeat(64)}`;
const QUEUE_WAIT_MS = 30_000;

const inspector: Actor = { actorId: "local-operator", actorKind: "inspector" };

let dataDir = "";
let packageRoot = "";
let brokerListener: net.Server;
let worker: WorkerHandle;

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
      maxGenerationAttempts: 2,
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

// One HAR entry whose URL carries the declared literal, so the filter D25 protects has something to
// hide on this path rather than passing vacuously.
const harBytes = new TextEncoder().encode(
  JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "chrome", version: "141" },
      entries: [
        {
          request: { method: "GET", url: `http://127.0.0.1:9/card?token=${SECRET}` },
          response: { status: 200, content: { size: 2, text: "{}" } },
        },
      ],
    },
  }),
);

function importPayload(projectId: Id, key: string, declared: readonly string[] = [SECRET]): JsonValue {
  return {
    projectId,
    command: {
      filename: "captures/cart-session.har",
      mediaType: "application/json",
      format: "har",
      byteLength: harBytes.byteLength,
      sourceSha256: digestBytes(harBytes),
      idempotencyKey: key,
    },
    bytesBase64: Buffer.from(harBytes).toString("base64"),
    sensitiveValues: [...declared],
  };
}

async function turn(): Promise<RunnerOutcome> {
  const outcome = await worker.runJobs();
  if (!outcome.ok) throw new Error(`${outcome.error.code}:${outcome.error.reason}`);
  return outcome.value;
}

// Each test's row is the oldest thing in a shared queue, and two of them survive their own test
// (§11's wait, §8 line 310's investigation). Draining is therefore the only way to ask "what did this
// run do" without depending on which project an earlier turn happened to leave behind.
async function drain(maxTurns = 12): Promise<RunnerOutcome[]> {
  const seen: RunnerOutcome[] = [];
  for (let index = 0; index < maxTurns; index += 1) {
    const outcome = await turn();
    seen.push(outcome);
    if (outcome.kind === "idle") break;
  }
  return seen;
}

async function readJob(projectId: Id, jobId: Id): Promise<ReturnType<typeof jobRecordSchema.parse>> {
  return jobRecordSchema.parse(unwrap(await ask("job.get", { projectId, jobId })));
}

function eventsFor(projectId: Id): { type: string; payload: JsonValue }[] {
  const read = worker.writeConnection.transact((tx) =>
    tx.eventsAfter(projectId, 0, 200).map((event) => ({ type: event.type, payload: event.payloadJson })),
  );
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  return read.value;
}

// Boots the worker against either the answering fixture or a file that cannot speak MCP. Which one is
// a parameter because the two requeue-vs-refuse readings depend on it: with a provider that will not
// start, §11 says wait; with a provider that works and a declaration the process no longer holds, the
// service says the checks cannot run at all.
async function boot(entrypointKind: "fixture" | "constraint" | "mute", port: string): Promise<{ handle: WorkerHandle; entry: string }> {
  const entry = path.join(dataDir, `rea-entry-${entrypointKind}-${port}.mjs`);
  writeFileSync(
    entry,
    entrypointKind !== "mute"
      ? `process.env.FIXTURE_CASE = ${JSON.stringify(entrypointKind === "constraint" ? "resource_constraint" : "har_records")};\nawait import(${JSON.stringify(FIXTURE)});\n`
      : "// not an MCP server: the identity probe cannot complete, so the provider is unreachable\n",
  );
  const booted = await bootWorker({
    env: {
      WB_HOST: "127.0.0.1",
      WB_PORT: port,
      WB_DATA_DIR: dataDir,
      WB_REA_ENTRYPOINT: entry,
      WB_SANDBOX_PROFILE: "har-capture",
      WB_BROKER_SOCKET: path.join(dataDir, "broker.sock"),
    },
    installedDefaults: {},
    profileDir: path.join(packageRoot, "infra", "profiles"),
    toolchain: { nodeVersion: "24.18.0", requiredNodeVersion: "24.18.0" },
  });
  if (!booted.ok) throw new Error(JSON.stringify(booted.error));
  return { handle: booted.value, entry };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "rea-wb-inspect-runner-"));
  mkdirSync(path.join(dataDir, "profiles"), { recursive: true });
  const { chmodSync } = await import("node:fs");
  chmodSync(dataDir, 0o700);
  packageRoot = path.join(dataDir, "package");
  mkdirSync(path.join(packageRoot, "infra", "profiles"), { recursive: true });
  writeFileSync(path.join(packageRoot, "infra", "profiles", "har-capture.json"), JSON.stringify(profileJson()));

  brokerListener = net.createServer();
  brokerListener.on("connection", (socket) => socket.destroy());
  await new Promise<void>((resolve) => brokerListener.listen({ path: path.join(dataDir, "broker.sock"), exclusive: true }, () => resolve()));

  worker = (await boot("fixture", "4327")).handle;
});

afterAll(async () => {
  await worker.shutdown();
  brokerListener.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the runner drives the ingestion row an upload left (§8 line 272, §11)", () => {
  it("turns a queued inspect row into an evidence record the read door answers", async () => {
    const projectId = await newProject("inspect-exec-1");
    const asked = unwrap(await ask("capture.importHar", importPayload(projectId, "import-exec-one"))) as {
      targetId: string;
      job: { id: string; state: string; kind: string };
    };
    expect(asked.job.kind).toBe("inspect");
    expect(asked.job.state).toBe("queued");
    const jobId = asId(asked.job.id);
    // The captured half of §8 line 272: same field, real value. Without this paired assertion the
    // nullable above would just look like a broken projection.
    expect((await ask("capture.importHar", importPayload(projectId, "import-exec-one")) as { value?: { snapshotDigest?: string | null } }).value?.snapshotDigest).not.toBeNull();

    // Before the turn, §8 line 281's door has nothing to answer: this is the reading that shows the
    // row was genuinely un-driven rather than the evidence arriving some other way.
    const missing = await ask("evidence.get", { projectId, evidenceId: EVIDENCE_ID });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.reason).toBe("evidence-unknown");

    const outcome = await turn();
    expect(outcome.kind).toBe("inspected");
    if (outcome.kind !== "inspected") return;
    expect(outcome.jobId).toBe(jobId);
    expect(outcome.jobState).toBe("succeeded");
    expect(outcome.evidenceIds).toEqual([EVIDENCE_ID]);

    const row = await readJob(projectId, jobId);
    expect(row.state).toBe("succeeded");
    // §8 line 277's promise about `resultRef`: the row points at the resource the run produced.
    expect(row.resultRef).toBe(EVIDENCE_ID);
    expect(row.cleanupState).toBe("complete");
    expect(row.error).toBeNull();

    // And the same evidence id now reads back through the door - the envelope is the provider's, put
    // under `evidence` as §8 line 281 says rather than loose.
    const read = unwrap(await ask("evidence.get", { projectId, evidenceId: EVIDENCE_ID })) as { evidence: JsonValue };
    const envelope = read.evidence as { evidence_id: string; operation: string };
    expect(envelope.evidence_id).toBe(EVIDENCE_ID);
    expect(typeof envelope.operation).toBe("string");

    const types = eventsFor(projectId).map((event) => event.type);
    expect(types).toContain("evidence.committed");
    expect(types).toContain("job.updated");
    const states = eventsFor(projectId)
      .filter((event) => event.type === "job.updated")
      .map((event) => (event.payload as { state?: string }).state);
    expect(states).toContain("succeeded");

    // The declared literal never reached a stored row: the persisted input is the filtered
    // projection, and a run that left the secret in the row would be §12.1's failure, not a pass.
    const stored = worker.writeConnection.transact((tx) => tx.getJob(projectId, jobId));
    if (!stored.ok) throw new Error(JSON.stringify(stored.error));
    expect(JSON.stringify(stored.value?.inputJson ?? "")).not.toContain(SECRET);

    // The queue is empty for this kind now, and an empty queue is an idle turn rather than an error.
    expect((await turn()).kind).toBe("idle");
  });

  it("replays the same key without a second job and drives only the one row", async () => {
    const projectId = await newProject("inspect-exec-2");
    const first = unwrap(await ask("capture.importHar", importPayload(projectId, "import-exec-two"))) as { job: { id: string } };
    const replay = unwrap(await ask("capture.importHar", importPayload(projectId, "import-exec-two"))) as { job: { id: string } };
    // §8 line 261's key: the replay is the same decision, so it names the same row rather than
    // queueing a second parse of the same bytes.
    expect(replay.job.id).toBe(first.job.id);

    const outcomes = [await turn(), await turn(), await turn()];
    expect(outcomes.filter((outcome) => outcome.kind === "inspected")).toHaveLength(1);
    // One row, one run: the turns after the row settled invent nothing for the replay.
    expect(outcomes[2]?.kind).toBe("idle");
    const row = await readJob(projectId, asId(first.job.id));
    expect(row.state).toBe("succeeded");
  });

  it("fails a row whose input names neither projection, by name", async () => {
    const projectId = await newProject("inspect-exec-3");
    const jobId = newId();
    const at = new Date().toISOString() as Instant;
    const seeded = worker.writeConnection.transact((tx) => {
      tx.insertJob({
        id: jobId,
        projectId,
        targetId: null,
        kind: "inspect",
        state: "queued",
        cleanupState: "pending",
        inputJson: { seededFor: "no-projection" },
        resultRef: null,
        errorJson: null,
        idempotencyKey: `unreadable-${jobId}`,
        requestDigest: ("9".repeat(64)) as Digest,
        deadlineAt: null,
        retryAt: null,
        createdAt: at,
        updatedAt: at,
      });
      return true;
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));

    const outcome = await turn();
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBe("inspect-job-input-unreadable");
    const row = await readJob(projectId, jobId);
    expect(row.state).toBe("failed");
    expect(row.error?.message).toBe("inspect-job-input-unreadable");
    expect(row.error?.code).toBe("INVALID_INPUT");
    // A broken row is refused, not handed to whichever service happens to be wired: no evidence read
    // was attempted, so nothing was consumed from the provider.
    expect((await ask("evidence.get", { projectId, evidenceId: EVIDENCE_ID })).ok).toBe(false);
  });

  it("reads the producer choice off the stored row, not off a re-declared kind (§8 line 272, issue #113)", async () => {
    const projectId = await newProject("inspect-exec-asar");
    const asarBytes = new TextEncoder().encode(JSON.stringify({ fake: "archive bytes" }));
    const asked = unwrap(await ask("capture.importHar", {
      projectId,
      command: {
        filename: "app.asar",
        mediaType: "application/octet-stream",
        format: "asar",
        byteLength: asarBytes.byteLength,
        sourceSha256: digestBytes(asarBytes),
        idempotencyKey: "import-exec-asar",
      },
      bytesBase64: Buffer.from(asarBytes).toString("base64"),
    })) as { targetId: string; job: { id: string }; snapshotDigest: string | null };
    // The receipt reads the row's own answer. It used to re-derive the content digest here, which
    // made it claim a snapshot §5 says an archive cannot have - two answers about one fact.
    expect(asked.snapshotDigest).toBeNull();

    const outcome = await turn();
    expect(outcome.kind).toBe("inspected");
    if (outcome.kind !== "inspected") return;
    expect(outcome.jobState).toBe("succeeded");

    // The row is the authority for both halves of §5's line: kind asar, source digest yes,
    // deployment snapshot no, and the envelope is the analyser's, not the capture tool's.
    const target = unwrap(await ask("target.read", { projectId, targetId: asked.targetId })) as {
      kind: string;
      snapshotDigest: string | null;
      identityReason: string | null;
      evidenceIds: string[];
    };
    expect(target.kind).toBe("asar");
    expect(target.snapshotDigest).toBeNull();
    expect(target.identityReason).toBe("file-import-without-capture");
    expect(target.evidenceIds).toEqual([EVIDENCE_ID]);
    const envelope = unwrap(await ask("evidence.get", { projectId, evidenceId: EVIDENCE_ID })) as { evidence: JsonValue };
    const record = envelope.evidence as { operation: string; parameters: { format?: string } };
    expect(record.operation).toBe("analyze_javascript_application");
    expect(record.parameters.format).toBe("asar");
  });

  it("refuses the two combinations no door should be able to ask a producer for", async () => {
    const projectId = await newProject("inspect-exec-refusals");
    const asarBytes = new TextEncoder().encode(JSON.stringify({ fake: "archive bytes" }));
    const withSelection = await ask("capture.importHar", {
      projectId,
      command: {
        filename: "app.asar",
        mediaType: "application/octet-stream",
        format: "asar",
        byteLength: asarBytes.byteLength,
        sourceSha256: digestBytes(asarBytes),
        idempotencyKey: "import-exec-asar-selection",
        // The command schema admits a selection; the analyser has no records to select. Only the
        // worker's own socket can pair the two, and this is the case that says it is refused rather
        // than silently analysed whole.
        recordOrdinals: [0],
      },
      bytesBase64: Buffer.from(asarBytes).toString("base64"),
    });
    expect(withSelection.ok).toBe(true);
    const stopped = await turn();
    expect(stopped.kind).toBe("failed");
    if (stopped.kind !== "failed") return;
    expect(stopped.reason).toBe("inspection-record-ordinals-for-archive");

  });

  it("leaves §8 line 310's investigation row queued and untouched", async () => {
    const projectId = await newProject("inspect-exec-4");
    // An inspect reads imported bytes - the door refuses a URL target with `inspect-needs-file-target`
    // - so the inquiry is asked against a target this project really uploaded, and the import's own
    // row is what the drain below settles.
    const imported = unwrap(await ask("capture.importHar", importPayload(projectId, "import-exec-four"))) as { targetId: string };
    const asked = unwrap(await ask("job.request", {
      projectId,
      idempotencyKey: "inquiry-exec-four",
      request: {
        targetId: imported.targetId,
        expectedGraphRevision: 0,
        task: { kind: "inspect", claimIds: [], question: "what answers /api/cart", scope: "captured-runtime" },
      },
    })) as { id: string };
    const jobId = asId(asked.id);

    // The runner turns the sibling row over and says nothing about this one: the row is neither
    // runnable here nor broken, and failing it would blame the operator for a capability this build
    // does not have. That sentence is the doctor's (`inspect-inquiry-executor-not-installed`).
    await drain();
    const row = await readJob(projectId, jobId);
    expect(row.state).toBe("queued");
    expect(row.error).toBeNull();
    expect(row.retryAt).toBeNull();

    // And the ingestion row beside it did run, so "untouched" is a statement about the inquiry and not
    // about a runner that never looked at the queue at all.
    const driven = await readJob(projectId, asId((unwrap(await ask("capture.importHar", importPayload(projectId, "import-exec-four"))) as { job: { id: string } }).job.id));
    expect(driven.state).toBe("succeeded");
  });

  it("refuses to re-drive a row whose declaration the restart lost (D25, §12.1)", async () => {
    const projectId = await newProject("inspect-exec-6");
    const asked = unwrap(await ask("capture.importHar", importPayload(projectId, "import-exec-six"))) as { job: { id: string } };
    const jobId = asId(asked.job.id);

    // A restart with the *working* provider: the wait branch is not taken, so the row reaches the
    // service, and the service asks for the literals the previous process held. It does not have them,
    // and it says so instead of running the filter with nothing to filter.
    await worker.shutdown();
    worker = (await boot("fixture", "4331")).handle;

    const outcomes = await drain();
    expect(outcomes.some((outcome) => outcome.kind === "failed" && outcome.reason === "declaration-context-unavailable")).toBe(true);

    const row = await readJob(projectId, jobId);
    expect(row.state).toBe("failed");
    expect(row.error?.message).toBe("declaration-context-unavailable");
    expect(row.error?.code).toBe("SENSITIVE_CONTENT_BLOCKED");
    const read = await ask("evidence.get", { projectId, evidenceId: EVIDENCE_ID });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.reason).toBe("evidence-unknown");
  });
});
  it("stops a retained-reference run where it is, through the runner (§9 item 7)", async () => {
    // The producer kept the record and told the workbench to consume it by reference. Re-running it is
    // forbidden, so the row has to end stopped-and-named rather than retried-and-duplicated - and the
    // runner's own line has to carry that, not flatten every receipt into success.
    await worker.shutdown();
    worker = (await boot("constraint", "4333")).handle;

    const projectId = await newProject("inspect-exec-7");
    const asked = unwrap(await ask("capture.importHar", importPayload(projectId, "import-exec-seven"))) as { job: { id: string } };
    const jobId = asId(asked.job.id);

    const outcomes = await drain(4);
    const inspected = outcomes.find((outcome) => outcome.kind === "inspected");
    expect(inspected?.kind).toBe("inspected");
    if (inspected?.kind !== "inspected") return;
    expect(inspected.jobState).toBe("failed");
    expect(inspected.evidenceIds).toEqual([]);

    const row = await readJob(projectId, jobId);
    expect(row.state).toBe("failed");
    expect(row.error?.message).toBe("resource-constraint-reference-retained");
    // §11 keeps the two states apart, and this is the reading that shows they are not the same field:
    // the job's own `cleanupState` is untouched by a stop that ran no business logic, while the
    // obligation this run left - a lease still owned, still failed - is what `cleanupRetryAt`
    // projects. A row that said "complete" here would be claiming a retained record was discharged.
    expect(row.cleanupState).toBe("pending");
    expect(row.cleanupRetryAt).not.toBeNull();
    // And the refused record is not silently dropped from the row's own page.
    expect((await ask("evidence.get", { projectId, evidenceId: EVIDENCE_ID })).ok).toBe(false);
  });

  it("keeps §11's wait visible when the provider cannot be reached", async () => {
    const projectId = await newProject("inspect-exec-5");
    const asked = unwrap(await ask("capture.importHar", importPayload(projectId, "import-exec-five"))) as { job: { id: string } };
    const jobId = asId(asked.job.id);

    // Restart against an entrypoint that cannot complete the identity probe: the row survives, the
    // provider does not, and §11 says that is a wait with a retry time rather than a failure.
    await worker.shutdown();
    // A §11 wait, not a failure: the entrypoint that the fresh process would spawn is removed before
    // the turn, so the provider is simply unreachable. The declaration is gone too (same restart the
    // D25 case reads), and the wait still comes first - the row is not blamed for a host that is down.
    const mute = await boot("mute", "4329");
    worker = mute.handle;
    const { unlinkSync } = await import("node:fs");
    unlinkSync(mute.entry);

    const outcomes = await drain();
    const requeues = outcomes.filter((outcome) => outcome.kind === "skipped" && outcome.reason === "start-requeued").length;
    const idles = outcomes.filter((outcome) => outcome.kind === "idle").length;
    // §11: 暂时 broker 不可用时保留 queued —— no turn here is allowed to call it a failure.
    expect(outcomes.some((outcome) => outcome.kind === "failed")).toBe(false);
    expect(requeues).toBeGreaterThan(0);
    // The retry time is a wait the runner keeps, not a flag it re-reads: exactly one turn requeues the
    // row, and the turn right after it finds nothing to do. Without that gate every poll spawns a
    // provider that is down - the difference between waiting and spinning, and the only reading that
    // makes `retryAt` more than a number nobody reads.
    expect(requeues).toBe(1);
    expect(idles).toBe(1);
    expect(outcomes.length).toBe(2);

    // And the wait is not a stranding: after the window the row is looked at again.
    await new Promise((resolve) => setTimeout(resolve, WORKER_SCHEDULER_MS + 60));
    const later = await drain(2);
    expect(later.some((outcome) => outcome.kind === "skipped" && outcome.reason === "start-requeued")).toBe(true);

    const row = await readJob(projectId, jobId);
    expect(row.state).toBe("queued");
    expect(row.error).toBeNull();
    // The number is on the projection the page reads, not only in a log line.
    expect(row.retryAt).not.toBeNull();
    const doctor = (await worker.doctor()).checks.find((check) => check.name === "target-work-executor");
    expect(doctor?.reasons).toContain("provider-session-unavailable");
  });


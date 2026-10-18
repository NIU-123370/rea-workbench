import { chmodSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootWorker, type WorkerHandle } from "../../apps/worker/composition.ts";
import { startWorkerRpc, type RpcServer } from "../../apps/worker/rpc-server.ts";
import { createWorkerClient } from "../../apps/web/worker-client.ts";
import { API_PREFIX, createApiHandler, routeTemplates } from "../../apps/web/api.ts";
import { startWebServer, type WebServer } from "../../apps/web/server.ts";
import { AccessLog } from "../../apps/web/access-log.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { IdempotencyJournal } from "../../packages/application/idempotency.ts";
import type { ListenAddress } from "../../packages/application/session.ts";
import { asId } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { seedReviewChain } from "../support/review-chain.ts";
import { seedVerifiedScenario } from "../support/verification-seed.ts";
import { currentSessionSchema, sessionViewSchema } from "../../packages/contracts/session.ts";
import { healthResponseSchema } from "../../packages/contracts/health.ts";
import { createdProjectSchema, evidenceViewSchema, projectPageSchema, projectViewSchema, targetCreatedSchema, targetViewSchema } from "../../packages/contracts/resources.ts";
import { graphViewSchema } from "../../packages/contracts/graph.ts";
import { auditPageSchema } from "../../packages/contracts/audit.ts";
import { jobPageSchema, jobRecordSchema, cleanupRetryReceiptSchema } from "../../packages/contracts/jobs.ts";
import { testVectorSchema, vectorCommitReceiptSchema, vectorPageSchema } from "../../packages/contracts/vectors.ts";
import { contractCommitReceiptSchema, contractRevisionSchema, planCommitReceiptSchema, verificationPlanSchema } from "../../packages/contracts/behaviors.ts";
import { blueprintFreezeReceiptSchema, blueprintReadSchema } from "../../packages/contracts/blueprint.ts";
import { candidateFileContentSchema, candidateViewSchema } from "../../packages/contracts/candidate.ts";
import { comparatorPolicyReadSchema, verificationReportSchema } from "../../packages/contracts/verification.ts";
import { exportListSchema, exportRecordSchema } from "../../packages/contracts/export.ts";
import { harImportHttpResponseSchema } from "../../packages/contracts/imports.ts";

// The other half of issue #58's first condition. `docs:check` now proves the *mounted set* equals
// §8's table, and `web-api.test.ts` walks each door it was written for — but nothing proved that
// every mounted door has ever answered with the status §8 declares. That gap is not hypothetical:
// `GET /health` sat mounted and could only ever answer 503 (round 25), and the run of this file is
// the witness for five doors that had never returned a success over HTTP at all.
//
// So one walk drives every door in dependency order, records what it answered, and each door then
// gets its own case over the recorded reply. The guard case compares the recorded set against
// `routeTemplates()` — the same list the server dispatches from — so a new mounted door cannot be
// merged without saying what its success looks like.

type Session = { cookie: string; csrf: string };
type Reply = { status: number; text: string; headers: Headers };
type Shape = { safeParse: (value: unknown) => { success: boolean } };
type Door = { status: number; shape?: Shape; note?: string; asksFor?: Shape; why?: string };

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROFILE = {
  id: "har-capture",
  schemaVersion: 1,
  reaPackageDigest: "a".repeat(64),
  reaContainerEntrypoint: "/usr/local/bin/rea",
  browserImageDigest: "b".repeat(64),
  browserVersion: "141.0.7390.107",
  limits: {
    cpuCores: 2, memoryBytes: 2147483648, pids: 128, diskBytes: 10737418240,
    maxExpandedBytes: 67108864, queueWaitMs: 30000, timeoutMs: 120000, maxGenerationAttempts: 3,
  },
  networkPolicyId: "deny-egress",
};
const HAR_BYTES = new TextEncoder().encode(JSON.stringify({
  log: {
    version: "1.2",
    creator: { name: "chrome", version: "141" },
    entries: [{ request: { method: "GET", url: "https://shop.example/api/cart" }, response: { status: 200, content: { size: 2, text: "{}" } } }],
  },
}));

// §8's own status for each door, plus the contract that parses the body it promises. `shape` is
// omitted only for the two replies that are not JSON at all: the event stream (whose frames are
// `encodeSseFrame`'s grammar) and the package download (whose body is bytes). Both are still
// asserted, by header and by the first bytes, in the case bodies.
const DOORS: Record<string, Door> = {
  "POST /session": { status: 201, shape: sessionViewSchema },
  "GET /session": { status: 200, shape: currentSessionSchema },
  // §8 answers 204 with no body, so there is nothing of the door's to parse. The shape is omitted
  // on purpose rather than borrowed from the worker's internal receipt.
  "DELETE /session": { status: 204, note: "204, no body" },
  "GET /health": { status: 200, shape: healthResponseSchema },
  "POST /projects": { status: 201, shape: createdProjectSchema },
  "GET /projects": { status: 200, shape: projectPageSchema },
  "GET /projects/:projectId": { status: 200, shape: projectViewSchema },
  "GET /projects/:projectId/events": { status: 200, note: "text/event-stream, first frame `: stream-open`" },
  "GET /projects/:projectId/graph": { status: 200, shape: graphViewSchema },
  "GET /projects/:projectId/jobs": { status: 200, shape: jobPageSchema },
  "GET /projects/:projectId/jobs/:jobId": { status: 200, shape: jobRecordSchema },
  "GET /projects/:projectId/audit": { status: 200, shape: auditPageSchema },
  "GET /audit": { status: 200, shape: auditPageSchema },
  "GET /comparator-policies": { status: 200, shape: comparatorPolicyReadSchema },
  "GET /projects/:projectId/evidence/:evidenceId": { status: 200, shape: evidenceViewSchema },
  "GET /projects/:projectId/vectors": { status: 200, shape: vectorPageSchema },
  "GET /projects/:projectId/vectors/:vectorId": { status: 200, shape: testVectorSchema },
  "GET /projects/:projectId/contracts/:contractId": { status: 200, shape: contractRevisionSchema },
  "GET /projects/:projectId/verification-plans/:planId": { status: 200, shape: verificationPlanSchema },
  "GET /projects/:projectId/blueprints/:blueprintId": { status: 200, shape: blueprintReadSchema },
  "GET /projects/:projectId/candidates/:candidateId": { status: 200, shape: candidateViewSchema },
  "GET /projects/:projectId/candidates/:candidateId/files/:fileId": { status: 200, shape: candidateFileContentSchema },
  "GET /projects/:projectId/verifications/:verificationId": { status: 200, shape: verificationReportSchema },
  "GET /projects/:projectId/exports": { status: 200, shape: exportListSchema },
  "GET /projects/:projectId/exports/:exportId/download": { status: 200, note: "application/zip bytes with the digest the row recorded" },
  "POST /projects/:projectId/targets": { status: 201, shape: targetCreatedSchema },
  "GET /projects/:projectId/targets/:targetId": { status: 200, shape: targetViewSchema },
  "POST /projects/:projectId/vectors": { status: 201, shape: vectorCommitReceiptSchema },
  "POST /projects/:projectId/contracts": { status: 201, shape: contractCommitReceiptSchema },
  "POST /projects/:projectId/verification-plans": { status: 201, shape: planCommitReceiptSchema },
  "POST /projects/:projectId/blueprints": { status: 201, shape: blueprintFreezeReceiptSchema },
  "POST /projects/:projectId/candidates": { status: 202, shape: jobRecordSchema },
  "POST /projects/:projectId/verifications": { status: 202, shape: jobRecordSchema },
  "POST /projects/:projectId/imports": { status: 202, shape: harImportHttpResponseSchema },
  "POST /projects/:projectId/jobs": { status: 202, shape: jobRecordSchema },
  "POST /projects/:projectId/exports": { status: 201, shape: exportRecordSchema },
  "POST /projects/:projectId/jobs/:jobId/cancel": { status: 202, shape: jobRecordSchema },
  "POST /projects/:projectId/jobs/:jobId/cleanup-retry": { status: 202, shape: cleanupRetryReceiptSchema },
  // §8's three review rows each promise the *record* back; the doors answer the commit they made
  // (a receipt: id, digest, reviewStatus, the two sequence numbers). That gap is recorded on #58 -
  // `asksFor` keeps it provable: the day a review door answers the record itself, the case below
  // goes red and the note has to be deleted rather than left to rot.
  "POST /projects/:projectId/vectors/:vectorId/review": { status: 200, shape: vectorCommitReceiptSchema, asksFor: testVectorSchema, why: "§8 line 285 asks for the TestVector" },
  "POST /projects/:projectId/contracts/:contractId/review": { status: 200, shape: contractCommitReceiptSchema, asksFor: contractRevisionSchema, why: "§8 line 287 asks for the ContractRevision" },
  "POST /projects/:projectId/verification-plans/:planId/review": { status: 200, shape: planCommitReceiptSchema, asksFor: verificationPlanSchema, why: "§8 line 291 asks for the VerificationPlan" },
};

const answered = new Map<string, Reply>();
const stream = { headers: new Headers(), text: "" };

let dataDir: string;
let worker: WorkerHandle;
let rpc: RpcServer;
let server: WebServer;
let address: ListenAddress;
let baseUrl = "";
let brokerListener: import("node:net").Server;
let packageContentType = "";

function host(): string {
  return `127.0.0.1:${String(address.port)}`;
}

async function call(method: string, target: string, init: { body?: string | FormData; headers?: Record<string, string> } = {}): Promise<Reply> {
  const response = await fetch(`${baseUrl}${target}`, {
    method,
    headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: init.body as string | FormData }),
    redirect: "manual",
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function readHeaders(session: Session): Record<string, string> {
  return { host: host(), cookie: session.cookie };
}

function writeHeaders(session: Session, extra: Record<string, string> = {}): Record<string, string> {
  return { host: host(), origin: `http://${host()}`, cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrf, ...extra };
}

function payload(reply: Reply): Record<string, JsonValue> {
  const parsed = JSON.parse(reply.text) as Record<string, JsonValue>;
  return (parsed["data"] ?? parsed) as Record<string, JsonValue>;
}

/** §5: creating *and* reviewing a sample increments the inventory revision, so a door that names
 * one re-reads the live number rather than reusing the one from the previous step. */
async function revision(session: Session, at: (tail: string) => string, targetId: Id): Promise<number> {
  const page = payload(await call("GET", at(`/vectors?targetId=${String(targetId)}`), { headers: readHeaders(session) }));
  return Number(page["inventoryRevision"]);
}

async function post(session: Session, target: string, body: Record<string, JsonValue>, key: string | null = null): Promise<Reply> {  return call("POST", target, { body: JSON.stringify(body), headers: writeHeaders(session, key === null ? {} : { "idempotency-key": key }) });
}

async function mintSession(): Promise<Session> {
  const code = worker.mintPairingCode();
  const paired = await call("POST", `${API_PREFIX}/session`, {
    body: JSON.stringify({ bootstrapToken: code.token }),
    headers: { host: host(), origin: `http://${host()}`, "content-type": "application/json" },
  });
  if (paired.status !== 201) throw new Error(`pairing failed -> ${String(paired.status)} ${paired.text}`);
  const body = payload(paired);
  return { cookie: (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "", csrf: String(body["csrfToken"]) };
}

async function record(key: string, reply: Reply): Promise<Reply> {
  const door = DOORS[key];
  if (door === undefined) throw new Error(`the walk drove "${key}", which the table does not declare`);
  if (reply.status !== door.status) {
    throw new Error(`${key} answered ${String(reply.status)} where §8 says ${String(door.status)}: ${reply.text.slice(0, 500)}`);
  }
  answered.set(key, reply);
  return reply;
}

beforeAll(async () => {
  const seed = await mkdtemp(path.join(tmpdir(), "rea-wb-census-"));
  await rm(seed, { recursive: true, force: true });
  mkdirSync(seed, { recursive: true });
  chmodSync(seed, 0o700);
  dataDir = seed;
  const packageRoot = path.join(dataDir, "package");
  mkdirSync(path.join(packageRoot, "infra", "profiles"), { recursive: true });
  await writeFile(path.join(packageRoot, "infra", "profiles", "har-capture.json"), JSON.stringify(PROFILE));
  await writeFile(path.join(dataDir, "rea-entry.mjs"), "// placeholder identity file\n");
  brokerListener = await holdSocket(path.join(dataDir, "broker.sock"));

  const booted = await bootWorker({
    env: {
      WB_HOST: "127.0.0.1",
      WB_PORT: "4313",
      WB_DATA_DIR: dataDir,
      WB_REA_ENTRYPOINT: path.join(ROOT, "tests", "fixtures", "rea-mcp-fixture.mjs"),
      // The generation door is refused by name while this is empty; nothing dials the address -
      // the Builder child emits deterministic files - but the door will not queue a job without it.
      WB_MODEL_ENDPOINT: "http://127.0.0.1:9977/v1",
      WB_SANDBOX_PROFILE: "har-capture",
      WB_BROKER_SOCKET: path.join(dataDir, "broker.sock"),
    },
    installedDefaults: {},
    profileDir: path.join(packageRoot, "infra", "profiles"),
    toolchain: { nodeVersion: "24.18.0", requiredNodeVersion: "24.18.0" },
  });
  if (!booted.ok) throw new Error(JSON.stringify(booted.error));
  worker = booted.value;

  const started = await startWorkerRpc(worker);
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  rpc = started.value;

  address = { host: "127.0.0.1", port: 0, secure: false };
  const handler = createApiHandler({
    address,
    worker: createWorkerClient({ socketPath: rpc.socketPath, dataDir }),
    journal: new IdempotencyJournal(),
    limits: LIMITS,
    access: new AccessLog(),
    stream: { pollMs: 5, sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) },
  });
  server = await startWebServer({ handler, host: "127.0.0.1", port: 0, onError: () => undefined });
  address.port = server.port;
  baseUrl = `http://127.0.0.1:${String(server.port)}`;

  await walk();
});

afterAll(async () => {
  await server?.close();
  await rpc?.close();
  await brokerListener?.close();
  await worker?.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

async function holdSocket(target: string) {
  const net = await import("node:net");
  const listener = net.createServer();
  listener.on("connection", (socket) => socket.destroy());
  await new Promise<void>((resolve) => listener.listen({ path: target, exclusive: true }, () => resolve()));
  return listener;
}

/** Every door, in the order its inputs come into existence. */
async function walk(): Promise<void> {
  // The three session doors get a session of their own; revoking it must not take the walk's with it.
  const code = worker.mintPairingCode();
  await record("POST /session", await call("POST", `${API_PREFIX}/session`, {
    body: JSON.stringify({ bootstrapToken: code.token }),
    headers: { host: host(), origin: `http://${host()}`, "content-type": "application/json" },
  }));
  const throwaway = answered.get("POST /session") as Reply;
  const throwawaySession: Session = {
    cookie: (throwaway.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "",
    csrf: String(payload(throwaway)["csrfToken"]),
  };
  await record("GET /session", await call("GET", `${API_PREFIX}/session`, { headers: { host: host(), cookie: throwawaySession.cookie } }));
  await record("DELETE /session", await call("DELETE", `${API_PREFIX}/session`, { headers: writeHeaders(throwawaySession) }));

  const session = await mintSession();
  await record("GET /health", await call("GET", `${API_PREFIX}/health`, { headers: readHeaders(session) }));

  const created = await record("POST /projects", await post(session, `${API_PREFIX}/projects`, { name: "census" }, "census-project"));
  const projectId = asId(String(payload(created)["id"]));
  const at = (tail: string) => `${API_PREFIX}/projects/${String(projectId)}${tail}`;
  await record("GET /projects", await call("GET", `${API_PREFIX}/projects?limit=50`, { headers: readHeaders(session) }));
  await record("GET /projects/:projectId", await call("GET", at(""), { headers: readHeaders(session) }));

  const declared = await record("POST /projects/:projectId/targets", await post(session, at("/targets"), { kind: "url", url: "https://shop.example/cart" }));
  const urlTargetId = asId(String(payload(declared)["id"]));
  await record("GET /projects/:projectId/targets/:targetId", await call("GET", at(`/targets/${String(urlTargetId)}`), { headers: readHeaders(session) }));

  const seeded = await seedReviewChain({ writer: worker.writeConnection, store: new ArtifactStore(dataDir), projectId, name: "census-chain" });
  await record("GET /projects/:projectId/evidence/:evidenceId", await call("GET", at(`/evidence/${seeded.evidenceId}`), { headers: readHeaders(session) }));

  await record("GET /projects/:projectId/vectors", await call("GET", at(`/vectors?targetId=${String(seeded.targetId)}`), { headers: readHeaders(session) }));
  await record("GET /projects/:projectId/vectors/:vectorId", await call("GET", at(`/vectors/${String(seeded.vectorId)}`), { headers: readHeaders(session) }));
  await record("GET /projects/:projectId/contracts/:contractId", await call("GET", at(`/contracts/${String(seeded.contractId)}`), { headers: readHeaders(session) }));
  await record("GET /projects/:projectId/verification-plans/:planId", await call("GET", at(`/verification-plans/${String(seeded.planId)}`), { headers: readHeaders(session) }));
  await record("GET /projects/:projectId/graph", await call("GET", at("/graph"), { headers: readHeaders(session) }));

  // The three creation doors next, while the chain is still all drafts: each answers with the
  // commit it made, and the plan is built from a contract this walk approved through its own door.
  const madeVector = await record("POST /projects/:projectId/vectors", await post(session, at("/vectors"), {
    targetId: String(seeded.targetId),
    snapshotDigest: seeded.snapshotDigest,
    source: { evidenceId: seeded.evidenceId, captureId: null, recordOrdinal: 0, pointer: "/records/0/reported", transactionId: null },
    operationId: "getCart",
    caseKey: "census-created",
    sdkInput: { include: "items" },
    expectedOutcome: { kind: "return", value: { items: [] } },
    visibility: "public",
    replacesId: null,
  }, "census-vector"));
  const extraVectorId = String(payload(madeVector)["vectorId"]);
  await record("POST /projects/:projectId/contracts", await post(session, at("/contracts"), {
    contractKey: "census-contract",
    targetId: String(seeded.targetId),
    scope: { snapshotDigest: seeded.snapshotDigest, operationIds: ["getCart"], excludedBehaviors: [] },
    behaviorSpec: "GET /api/cart returns the item list",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    httpOperations: [{ operationId: "getCart", method: "GET", path: "/api/cart", requestMediaType: null, responses: [{ status: 200, mediaType: "application/json", schema: { type: "object" } }] }],
    errorCases: [],
    limitations: [],
    unknowns: [],
    sourceClaimIds: [String(seeded.claimId)],
    requiredCases: [{ caseKey: "cart-ok", claimId: String(seeded.claimId), kind: "success", vectorIds: [String(seeded.vectorId)] }],
  }));

  await record("POST /projects/:projectId/vectors/:vectorId/review", await post(session, at(`/vectors/${String(seeded.vectorId)}/review`), {
    decision: "approved", expectedDigest: seeded.vectorDigest, expectedInventoryRevision: await revision(session, at, seeded.targetId),
  }));
  const approvedContract = await record("POST /projects/:projectId/contracts/:contractId/review", await post(session, at(`/contracts/${String(seeded.contractId)}/review`), {
    decision: "approved", expectedDigest: seeded.contractDigest,
  }));
  // The approved row is the one the door was pointed at; §8 has the review answer the record,
  // so the id does not need to come back out of the reply.
  void approvedContract;
  const approvedContractId = String(seeded.contractId);

  // §7.4: a plan selects what the approved contracts' requiredCases cover and must account for the
  // rest by name, so the vector this walk added is excluded rather than silently left out. Each
  // inventory-sensitive door re-reads the live revision: §5 has 创建 *和* 审阅 increment it, so the
  // number from the last step is already stale by the time the next one asks.
  const planRevision = await revision(session, at, seeded.targetId);
  const builtPlan = await record("POST /projects/:projectId/verification-plans", await post(session, at("/verification-plans"), {
    targetId: String(seeded.targetId),
    snapshotDigest: seeded.snapshotDigest,
    contractRevisionIds: [approvedContractId],
    exclusions: [{ vectorId: extraVectorId, reasonCode: "outside-scope", reason: "the census walk's second sample exercises no required case", excludedBehavior: "GET /api/cart", supersededBy: null }],
    expectedInventoryRevision: planRevision,
  }, "census-plan"));
  const planId = String(payload(builtPlan)["planId"]);
  await record("POST /projects/:projectId/verification-plans/:planId/review", await post(session, at(`/verification-plans/${planId}/review`), {
    decision: "approved", expectedDigest: String(payload(builtPlan)["digest"]), expectedInventoryRevision: await revision(session, at, seeded.targetId),
  }));

  // The freeze door *refuses* `targetId` and `contractRevisionIds` (§8's row names them): the plan
  // already derives both, and a caller restating them is a second source for one fact. The census
  // learned that shape from the door's own 400, which is the point of driving every door.
  const frozen = await record("POST /projects/:projectId/blueprints", await post(session, at("/blueprints"), {
    verificationPlanId: planId,
  }, "census-freeze"));
  const blueprintId = String(payload(frozen)["blueprintId"]);
  await record("GET /projects/:projectId/blueprints/:blueprintId", await call("GET", at(`/blueprints/${blueprintId}`), { headers: readHeaders(session) }));

  const queued = await record("POST /projects/:projectId/candidates", await post(session, at("/candidates"), { blueprintId }, "census-generate"));
  const buildJobId = String(payload(queued)["id"]);
  let candidateId = "";
  for (let turn = 0; turn < 60 && candidateId === ""; turn += 1) {
    await worker.runJobs();
    const row = payload(await call("GET", at(`/jobs/${buildJobId}`), { headers: readHeaders(session) }));
    if (row["state"] === "succeeded") candidateId = String(row["resultRef"]);
    if (row["state"] === "failed") throw new Error(`the generation job failed: ${JSON.stringify(row["error"])}`);
  }
  if (candidateId === "") throw new Error("the runner never settled the generation job");
  const candidate = await record("GET /projects/:projectId/candidates/:candidateId", await call("GET", at(`/candidates/${candidateId}`), { headers: readHeaders(session) }));
  const fileId = String((payload(candidate)["files"] as Record<string, JsonValue>[])[0]?.["id"]);
  await record("GET /projects/:projectId/candidates/:candidateId/files/:fileId", await call("GET", at(`/candidates/${candidateId}/files/${fileId}`), { headers: readHeaders(session) }));

  await record("POST /projects/:projectId/verifications", await post(session, at("/verifications"), { candidateId, comparatorPolicyId: "exact-http-v1" }, "census-verify"));
  const verified = await seedVerifiedScenario({ writer: worker.writeConnection, store: new ArtifactStore(dataDir), projectId, targetId: seeded.targetId, name: "census-verified" });
  await record("GET /projects/:projectId/verifications/:verificationId", await call("GET", at(`/verifications/${String(verified.verificationId)}`), { headers: readHeaders(session) }));

  // A capture is bound to the URL target (the door refuses a file target by name), so the walk
  // points at the row its own declare door made, not at the seeded file target.
  const capture = await record("POST /projects/:projectId/jobs", await post(session, at("/jobs"), {
    targetId: String(urlTargetId), expectedGraphRevision: Number(payload(await call("GET", at(""), { headers: readHeaders(session) }))["graphRevision"]),
    task: {
      kind: "capture", profileId: "har-capture",
      scenario: { startUrl: "https://shop.example/cart", actions: [{ kind: "click", locator: { kind: "testId", value: "add-to-cart" } }] },
      network: { requestBody: true, responseBody: true, headerValues: false },
    },
  }, "census-capture"));
  await record("GET /projects/:projectId/jobs/:jobId", await call("GET", at(`/jobs/${String(payload(capture)["id"])}`), { headers: readHeaders(session) }));

  // A verification job is not runnable in this build, so the door queues it and this cancels that
  // queued row - the one state §11 lets a cancel move.
  const verifyJobs = payload(await call("GET", at("/jobs?limit=50"), { headers: readHeaders(session) }));
  const queuedVerify = (verifyJobs["items"] as Record<string, JsonValue>[]).find((row) => row["kind"] === "verify" && row["state"] === "queued");
  if (queuedVerify === undefined) throw new Error("no queued verify job to cancel");
  await record("POST /projects/:projectId/jobs/:jobId/cancel", await post(session, at(`/jobs/${String(queuedVerify["id"])}/cancel`), {}));

  const imported = await record("POST /projects/:projectId/imports", await upload(session, projectId, formOf(), "census-import"));
  const importJob = payload(imported)["job"] as Record<string, JsonValue> | undefined;
  const importJobId = String(importJob?.["id"]);
  await record("POST /projects/:projectId/jobs/:jobId/cleanup-retry", await post(session, at(`/jobs/${importJobId}/cleanup-retry`), {}, "census-cleanup"));
  await record("GET /projects/:projectId/jobs", await call("GET", at("/jobs?limit=50"), { headers: readHeaders(session) }));

  await record("GET /projects/:projectId/audit", await call("GET", at("/audit?limit=50"), { headers: readHeaders(session) }));
  await record("GET /audit", await call("GET", `${API_PREFIX}/audit?limit=50`, { headers: readHeaders(session) }));
  await record("GET /comparator-policies", await call("GET", `${API_PREFIX}/comparator-policies`, { headers: readHeaders(session) }));

  const packaged = await record("POST /projects/:projectId/exports", await post(session, at("/exports"), { candidateId, label: "draft" }));
  const exportId = String(payload(packaged)["id"]);
  await record("GET /projects/:projectId/exports", await call("GET", at("/exports"), { headers: readHeaders(session) }));
  const download = await fetch(`${baseUrl}${at(`/exports/${exportId}/download`)}`, { headers: readHeaders(session) });
  const bytes = new Uint8Array(await download.arrayBuffer());
  packageContentType = String(download.headers.get("content-type"));
  answered.set("GET /projects/:projectId/exports/:exportId/download", {
    status: download.status, text: JSON.stringify({ byteLength: bytes.byteLength, zipMagic: bytes[0] === 0x50 && bytes[1] === 0x4b }), headers: download.headers,
  });
  if (download.status !== 200) throw new Error(`download answered ${String(download.status)}`);

  const events = await fetch(`${baseUrl}${at("/events?after=0")}`, { headers: readHeaders(session) });
  const reader = events.body?.getReader();
  const first = reader === undefined ? undefined : await reader.read();
  await reader?.cancel().catch(() => undefined);
  stream.headers = events.headers;
  stream.text = first === undefined ? "" : new TextDecoder().decode(first.value);
  answered.set("GET /projects/:projectId/events", { status: events.status, text: stream.text, headers: events.headers });
}

function formOf(): FormData {
  const form = new FormData();
  form.set("file", new File([HAR_BYTES], "cart.har", { type: "application/json" }));
  form.set("kind", "har");
  return form;
}

async function upload(session: Session, projectId: Id, form: FormData, key: string): Promise<Reply> {
  const headers = writeHeaders(session, { "idempotency-key": key });
  // The boundary belongs to the platform's multipart encoder; a hand-written content-type would
  // test this file's guesswork instead of the door's parser.
  delete headers["content-type"];
  return call("POST", `${API_PREFIX}/projects/${String(projectId)}/imports`, { body: form, headers });
}

describe("every mounted door has answered with the status §8 declares (issue #58, condition 1)", () => {
  it("drives exactly the table the server dispatches from", () => {
    const mounted = routeTemplates().map((template) => template.replace(API_PREFIX, "")).sort();
    expect(Object.keys(DOORS).sort()).toEqual(mounted);
    // Declaring a door is not driving it: the walk has to have an answer for each.
    expect([...answered.keys()].sort()).toEqual(mounted);
  });

  for (const [key, door] of Object.entries(DOORS)) {
    it(`${key} -> ${String(door.status)}${door.shape === undefined ? " (no JSON body contract)" : ""}`, () => {
      const reply = answered.get(key);
      if (reply === undefined) throw new Error("the walk never drove this door");
      expect(reply.status, reply.text.slice(0, 400)).toBe(door.status);
      if (door.shape !== undefined) {
        expect(door.shape.safeParse(payload(reply) as JsonValue).success, reply.text.slice(0, 400)).toBe(true);
      }
      if (key === "GET /projects/:projectId/events") {
        expect(reply.headers.get("content-type")).toContain("text/event-stream");
        expect(reply.text.startsWith(": stream-open"), reply.text).toBe(true);
      }
      if (key === "GET /projects/:projectId/exports/:exportId/download") {
        expect(packageContentType).toBe("application/zip");
        expect(JSON.parse(reply.text)["zipMagic"]).toBe(true);
        expect(String(reply.headers.get("x-rea-export-sha256"))).toMatch(/^[0-9a-f]{64}$/);
      }
      if (door.asksFor !== undefined) {
        // The deviation is asserted, not mentioned: the reply must still fail the record's own
        // contract, which is the only reading that says the gap is open right now.
        expect(door.asksFor.safeParse(payload(reply) as JsonValue).success, door.why ?? "").toBe(false);
      }
      if (key === "POST /projects/:projectId/jobs") {
        expect(reply.headers.get("location"), "§8's row for this door names a Location header").toContain("/jobs/");
      }
    });
  }
});

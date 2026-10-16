import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { request as rawRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootWorker, EVIDENCE_INLINE_LIMIT_BYTES, type WorkerHandle } from "../../apps/worker/composition.ts";
import { ArtifactStore } from "../../packages/adapters/storage/artifacts.ts";
import { startWorkerRpc, type RpcServer } from "../../apps/worker/rpc-server.ts";
import { createWorkerClient } from "../../apps/web/worker-client.ts";
import { createApiHandler, API_PREFIX } from "../../apps/web/api.ts";
import { runWebProcess } from "../../apps/web/main.ts";
import { startWebServer, type WebServer } from "../../apps/web/server.ts";
import { AccessLog } from "../../apps/web/access-log.ts";
import { graphViewSchema } from "../../packages/contracts/graph.ts";
import { evidenceViewSchema, projectViewSchema } from "../../packages/contracts/resources.ts";
import { AUDIT_LIST_MAX_LIMIT, auditPageSchema } from "../../packages/contracts/audit.ts";
import { vectorPageSchema, vectorReviewReceiptSchema } from "../../packages/contracts/vectors.ts";
import { contractReviewReceiptSchema, planReviewReceiptSchema } from "../../packages/contracts/behaviors.ts";
import { JOB_LIST_MAX_LIMIT, jobPageSchema, jobRecordSchema } from "../../packages/contracts/jobs.ts";
import { IdempotencyJournal } from "../../packages/application/idempotency.ts";
import type { ListenAddress } from "../../packages/application/session.ts";
import { SESSION_COOKIE_NAME } from "../../packages/application/session.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { asId, asInstant, newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import { asDigest } from "../../packages/domain/canonical-json.ts";
import { hex } from "../support/blueprint-seed.ts";
import { seedReviewChain } from "../support/review-chain.ts";

// The session, CSRF/idempotency and SSE contracts of the local HTTP API, over a real
// loopback server, a real worker process object and a real Unix socket to a real
// SQLite writer (DESIGN §8, §14 / D30, PRD A04 A05, issue #17).
//
// Nothing here mocks HTTP: `node:http` listens, `fetch` speaks to it, and the API
// reaches the worker only through the RPC socket the worker itself opened. A test
// double would have proven the handler's branches, not the seam the design says the
// browser actually crosses.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

let dataDir: string;
let packageRoot: string;
let brokerSocket: string;
let worker: WorkerHandle;
let rpc: RpcServer;
let server: WebServer;
let address: ListenAddress;
const journal = new IdempotencyJournal();
const access = new AccessLog();
let baseUrl = "";

const PROFILE = {
  schemaVersion: 1,
  id: "har-capture",
  label: "har-capture",
  image: { ref: "example.invalid/har@sha256:" + "a".repeat(64), digest: "sha256:" + "a".repeat(64) },
  capabilities: ["har-capture"],
  limits: {
    memoryBytes: 512 * 1024 * 1024,
    cpuShares: 1,
    pids: 128,
    wallClockMs: 600_000,
    maxUploadBytes: 128 * 1024 * 1024,
    maxArtifactBytes: 512 * 1024 * 1024,
    maxEvidenceRecords: 20_000,
    maxConcurrency: 1,
  },
  network: "none",
  hostMounts: [],
  devices: [],
};

// undici (global `fetch`) sets Host from the URL and refuses a caller-supplied one,
// so the Host gate can only be exercised with a client that will send what it is told.
function hostile(host: string, path: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const request = rawRequest(
      { host: "127.0.0.1", port: address.port, method: "POST", path, headers: { host, origin: `http://127.0.0.1:${String(address.port)}`, "content-type": "application/json" } },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    request.on("error", () => resolve({ status: 0, text: "transport-error" }));
    request.end(body);
  });
}

async function holdSocket(target: string) {
  const net = await import("node:net");
  const listener = net.createServer();
  listener.on("connection", (socket) => socket.destroy());
  await new Promise<void>((resolve) => listener.listen({ path: target, exclusive: true }, () => resolve()));
  return listener;
}

let brokerListener: Awaited<ReturnType<typeof holdSocket>>;

function env(): Record<string, string | undefined> {
  return {
    WB_HOST: "127.0.0.1",
    WB_PORT: "4313",
    WB_DATA_DIR: dataDir,
    WB_REA_ENTRYPOINT: path.join(dataDir, "rea-entry.mjs"),
    WB_MODEL_ENDPOINT: "",
    WB_SANDBOX_PROFILE: "har-capture",
    WB_BROKER_SOCKET: brokerSocket,
  };
}

async function call(method: string, target: string, init: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}${target}`, {
    method,
    headers: (init.headers as Record<string, string>) ?? {},
    ...(init.body === undefined ? {} : { body: init.body as string }),
    redirect: "manual",
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

beforeAll(async () => {
  // mkdtemp creates the directory; it is not private, and the boot resolver
  // refuses a world-accessible data dir on purpose (§12).
  const seed = await mkdtemp(path.join(tmpdir(), "rea-wb-web-"));
  await rm(seed, { recursive: true, force: true });
  mkdirSync(seed, { recursive: true });
  chmodSync(seed, 0o700);
  dataDir = seed;
  mkdirSync(path.join(dataDir, "profiles"), { recursive: true });
  packageRoot = path.join(dataDir, "package");
  mkdirSync(path.join(packageRoot, "infra", "profiles"), { recursive: true });
  mkdirSync(path.join(packageRoot, "infra", "config"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "infra", "profiles", "har-capture.json"),
    JSON.stringify(PROFILE),
  );
  await writeFile(
    path.join(packageRoot, "infra", "config", "installed-defaults.json"),
    JSON.stringify({ WB_PORT: 4313, WB_SANDBOX_PROFILE: "har-capture" }),
  );
  await writeFile(path.join(dataDir, "rea-entry.mjs"), "// placeholder identity file\n");
  brokerSocket = path.join(dataDir, "broker.sock");
  brokerListener = await holdSocket(brokerSocket);

  const booted = await bootWorker({
    env: env(),
    installedDefaults: {},
    profileDir: path.join(packageRoot, "infra", "profiles"),
    toolchain: { nodeVersion: "24.18.0", requiredNodeVersion: "24.18.0" },
  });
  if (!booted.ok) throw new Error(JSON.stringify(booted.error));
  worker = booted.value;

  const started = await startWorkerRpc(worker);
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  rpc = started.value;

  const client = createWorkerClient({ socketPath: rpc.socketPath, dataDir });
  // Bound on an ephemeral port; the address object the API validates against is the
  // one this server actually reported, so a stale literal can never pass.
  address = { host: "127.0.0.1", port: 0, secure: false };
  const handler = createApiHandler({
    address,
    worker: client,
    journal,
    limits: LIMITS,
    access,
    stream: { pollMs: 5, sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) },
  });
  server = await startWebServer({ handler, host: "127.0.0.1", port: 0, onError: () => undefined });
  address.port = server.port;
  baseUrl = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  await server?.close();
  await rpc?.close();
  await brokerListener.close();
  await worker.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

describe("pairing a local session (DESIGN §14, D30)", () => {
  it("refuses an unpaired or wrongly-hosted request without leaking the reason", async () => {
    const missing = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: "" }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(missing.status).toBe(400);

    const wrongHost = await hostile("localhost:4313", `${API_PREFIX}/session`, JSON.stringify({ bootstrapToken: "anything" }));
    expect(wrongHost.status, wrongHost.text).toBe(403);
    const wrongPort = await hostile("127.0.0.1:1", `${API_PREFIX}/session`, JSON.stringify({ bootstrapToken: "anything" }));
    expect(wrongPort.status, wrongPort.text).toBe(403);

    const badCode = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: "0".repeat(64) }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(badCode.status).toBe(401);
    expect(badCode.text).not.toContain("0".repeat(64));
  });

  it("exchanges the code the start command minted for a HttpOnly cookie and a CSRF token", async () => {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const setCookie = paired.headers.getSetCookie()[0] ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    // The body is for page script, so the cookie value must not be in it; the token
    // is for the terminal, so it must not be in the body either.
    const body = JSON.parse(paired.text) as { csrfToken: string; reviewerId: string; data?: unknown };
    const view = (body.data ?? body) as { csrfToken: string; reviewerId: string };
    expect(view.csrfToken.length).toBeGreaterThan(16);
    expect(paired.text).not.toContain(code.token);
    expect(paired.text).not.toContain(setCookie.split("=")[1] ?? "no-cookie-value");

    // The same code cannot be spent twice, even in the same process.
    const replay = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(replay.status).toBe(401);

    // No access log line carries either the pairing code or the cookie value.
    expect(JSON.stringify(access.lines)).not.toContain(code.token);

    const read = await call("GET", `${API_PREFIX}/session`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: setCookie.split(";")[0] ?? "" },
    });
    expect(read.status).toBe(200);
    expect(read.text).toContain("local-controller");

    const revoked = await call("DELETE", `${API_PREFIX}/session`, {
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        cookie: setCookie.split(";")[0] ?? "",
        "x-csrf-token": view.csrfToken,
      },
    });
    // 204: the answer is "no longer", and a body would only invite a claim about
    // what the session used to be.
    expect(revoked.status).toBe(204);
    const afterRevoke = await call("GET", `${API_PREFIX}/session`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: setCookie.split(";")[0] ?? "" },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("requires the CSRF header on a mutating request and the session before that", async () => {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    const setCookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const body = JSON.parse(paired.text) as Record<string, JsonValue>;
    const view = (body["data"] ?? body) as Record<string, string>;
    const csrf = view["csrfToken"] ?? "";

    const noCookie = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name: "cart" }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        "idempotency-key": "key-nocookie",
      },
    });
    expect(noCookie.status).toBe(401);

    const noCsrf = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name: "cart" }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        cookie: setCookie,
        "idempotency-key": "key-nocsrf",
      },
    });
    expect(noCsrf.status).toBe(403);

    const crossOrigin = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name: "cart" }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: "http://evil.example",
        cookie: setCookie,
        "x-csrf-token": csrf,
        "idempotency-key": "key-cross",
      },
    });
    expect(crossOrigin.status).toBe(403);

    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name: "cart" }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        cookie: setCookie,
        "x-csrf-token": csrf,
        "idempotency-key": "key-create",
      },
    });
    expect(created.status).toBe(201);

    const replay = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name: "cart" }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        cookie: setCookie,
        "x-csrf-token": csrf,
        "idempotency-key": "key-create",
      },
    });
    // The original result, not a second project.
    expect(replay.status).toBe(201);
    expect(replay.text).toBe(created.text);

    const divergent = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name: "different" }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        cookie: setCookie,
        "x-csrf-token": csrf,
        "idempotency-key": "key-create",
      },
    });
    expect(divergent.status).toBe(409);
    expect(divergent.text).toContain("IDEMPOTENCY_CONFLICT");
  });

  it("never consumes a code that arrived in the query string", async () => {
    // §14: the token may not travel in a URL, a query, a referrer or a log line.
    // The route reads the body only, so a query value is not a pairing attempt — and
    // what *was* attempted in the body is refused. Neither value may surface in an
    // access line, which records the matched template rather than the target.
    const live = worker.mintPairingCode();
    const linesBefore = access.lines.length;
    const refused = await call("POST", `${API_PREFIX}/session?bootstrapToken=${live.token}`, {
      body: JSON.stringify({ bootstrapToken: `deadbeef-no-such-code` }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(refused.status).toBe(401);
    expect(access.lines.slice(linesBefore).join("\n")).not.toContain(live.token);
    expect(access.lines.join("\n")).not.toContain("bootstrapToken=");
    // The live code is still live: nothing in the query spent it.
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: live.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(paired.status, paired.text).toBe(201);
  });
});

describe("the SSE read side (§8)", () => {
  it("streams committed events in sequence and refuses an unrecoverable cursor", async () => {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    const setCookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const body = JSON.parse(paired.text) as Record<string, JsonValue>;
    const view = (body["data"] ?? body) as Record<string, string>;

    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name: "streamed" }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        cookie: setCookie,
        "x-csrf-token": view["csrfToken"] ?? "",
        "idempotency-key": "key-stream",
      },
    });
    expect(created.status, created.text).toBe(201);
    const project = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    const projectId = (project.data?.id ?? project.id) as string;
    if (typeof projectId !== "string") throw new Error("no project id came back");

    // The closed §8 type list has no project event, so a freshly created project
    // legitimately has an empty outbox. Two committed events are appended through
    // the worker's own writer — the only owner of the outbox — so the stream has
    // something to order.
    const appended = worker.writeConnection.transact((tx) => {
      const first = tx.appendEvent({
        projectId: projectId as never,
        type: "job.updated",
        aggregateId: newId(),
        payloadJson: { state: "running" },
        createdAt: nowInstant(),
      });
      const second = tx.appendEvent({
        projectId: projectId as never,
        type: "evidence.committed",
        aggregateId: `ev_${"a".repeat(64)}`,
        payloadJson: { state: "succeeded" },
        createdAt: nowInstant(),
      });
      return [first, second];
    });
    if (!appended.ok) throw new Error(JSON.stringify(appended.error));

    const stale = await call("GET", `${API_PREFIX}/projects/${projectId}/events?after=999999`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: setCookie },
    });
    expect(stale.status).toBe(409);
    expect(stale.text).toContain("EVENT_CURSOR_EXPIRED");

    const conflicting = await call("GET", `${API_PREFIX}/projects/${projectId}/events?after=3`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: setCookie, "last-event-id": "4" },
    });
    expect(conflicting.status).toBe(409);

    const stream = await fetch(`${baseUrl}${API_PREFIX}/projects/${projectId}/events?after=0`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: setCookie },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const text = await stream.text();
    expect(text).toContain("id: ");
    expect(text).toContain("event: job.updated");
    const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);
    // The data line is exactly the six §8 names, and no body text rides along.
    const dataLines = [...text.matchAll(/^data: (.*)$/gm)].map((match) => match[1]);
    for (const line of dataLines) {
      expect(Object.keys(JSON.parse(line ?? "{}") as Record<string, JsonValue>).sort()).toEqual([
        "aggregateId",
        "createdAt",
        "payload",
        "projectId",
        "seq",
        "type",
      ]);
    }
  });
});

describe("the export routes (§8 lines 299-300 / issue #22)", () => {
  async function pairSession(): Promise<{ cookie: string; csrf: string }> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const setCookie = paired.headers.getSetCookie()[0] ?? "";
    const body = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    return { cookie: setCookie.split(";")[0] ?? "", csrf: body.data?.csrfToken ?? body.csrfToken ?? "" };
  }

  function headersFor(session: { cookie: string; csrf: string }, extra: Record<string, string> = {}): Record<string, string> {
    return {
      host: `127.0.0.1:${String(address.port)}`,
      origin: `http://127.0.0.1:${String(address.port)}`,
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
      "content-type": "application/json",
      ...extra,
    };
  }

  it("mounts exactly three export routes and holds every one behind a session", async () => {
    const project = newId();
    // A caller with neither cookie nor CSRF token is stopped at the CSRF check, which runs
    // first for a mutating route (§14 order); with a token and no session it is the session
    // check that answers. Both refusals come before the worker is asked anything.
    const anonymous = await call("POST", `${API_PREFIX}/projects/${project}/exports`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, "content-type": "application/json" },
      body: JSON.stringify({ candidateId: newId(), label: "draft" }),
    });
    expect(anonymous.status).toBe(403);
    const noSession = await call("POST", `${API_PREFIX}/projects/${project}/exports`, {
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        "x-csrf-token": "not-a-session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ candidateId: newId(), label: "draft" }),
    });
    expect(noSession.status).toBe(401);
    const list = await call("GET", `${API_PREFIX}/projects/${project}/exports`);
    expect(list.status).toBe(401);
    const download = await call("GET", `${API_PREFIX}/projects/${project}/exports/${newId()}/download`);
    expect(download.status).toBe(401);
  });

  it("keeps the mutating create behind the CSRF header and a strict body", async () => {
    const session = await pairSession();
    const project = newId();
    const body = JSON.stringify({ candidateId: newId(), label: "draft" });
    const noCsrf = await call("POST", `${API_PREFIX}/projects/${project}/exports`, {
      headers: { ...headersFor(session), "x-csrf-token": "" },
      body,
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.text).toContain("csrf-token-missing");

    // A body that names a field the contract does not have is refused before the worker
    // is asked — including the field that would point a package at a path.
    const extraField = await call("POST", `${API_PREFIX}/projects/${project}/exports`, {
      headers: headersFor(session),
      body: JSON.stringify({ candidateId: newId(), label: "draft", output: `${dataDir}/evil.zip` }),
    });
    expect(extraField.status).toBe(400);
    // The refusal names the shape problem without echoing the value it rejected.
    expect(extraField.text).not.toContain("evil.zip");
    expect(extraField.text).not.toContain(dataDir);
  });

  it("relays the worker's refusals onto named codes and answers the list with a contract", async () => {
    const session = await pairSession();
    const project = newId();
    const unknown = await call("POST", `${API_PREFIX}/projects/${project}/exports`, {
      headers: headersFor(session),
      body: JSON.stringify({ candidateId: newId(), label: "draft" }),
    });
    expect(unknown.status).toBe(404);
    expect(unknown.text).toContain("candidate-unknown");
    expect(unknown.text).not.toContain(dataDir);

    const listed = await call("GET", `${API_PREFIX}/projects/${project}/exports`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(listed.status, listed.text).toBe(200);
    expect(JSON.parse(listed.text) as unknown[]).toEqual([]);

    const download = await call("GET", `${API_PREFIX}/projects/${project}/exports/${newId()}/download`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(download.status).toBe(404);
    expect(download.text).toContain("export-unknown");

    // A path id that is not an opaque id never reaches a command at all.
    const badId = await call("GET", `${API_PREFIX}/projects/${project}/exports/not-a-uuid/download`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(badId.status).toBe(404);
    expect(badId.text).toContain("export-unknown");
  });
});

describe("the graph read the three columns are built from (DESIGN §6, §8 / issue #18)", () => {
  async function pairSession(): Promise<{ cookie: string; csrf: string }> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const body = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    return {
      cookie: (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "",
      csrf: body.data?.csrfToken ?? body.csrfToken ?? "",
    };
  }

  async function createProject(session: { cookie: string; csrf: string }, key: string): Promise<string> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name: "graph-view" }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": key,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const project = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    const projectId = (project.data?.id ?? project.id) as string | undefined;
    if (typeof projectId !== "string") throw new Error("no project id came back");
    return projectId;
  }

  it("holds the route behind a session and inside the closed command surface", async () => {
    const anonymous = await call("GET", `${API_PREFIX}/projects/${newId()}/graph`);
    expect(anonymous.status).toBe(401);
    // A near-miss path is not a route: §8's surface is named, and the graph read does
    // not open a "read anything under projects/" door on the way in.
    const neighbour = await call("GET", `${API_PREFIX}/projects/${newId()}/graph/all`);
    expect(neighbour.status, neighbour.text).toBe(404);
    expect(neighbour.text).toContain("route-unknown");
  });

  it("answers a fresh project with the stored view, and an empty project is a note rather than an error", async () => {
    const session = await pairSession();
    const projectId = await createProject(session, "key-graph-empty");
    const read = await call("GET", `${API_PREFIX}/projects/${projectId}/graph`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(read.status, read.text).toBe(200);
    const parsed = graphViewSchema.safeParse(JSON.parse(read.text) as unknown);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    if (!parsed.success) return;
    // The read names the project it answered, says no target was imported, and brings
    // back nothing that has been decided for the screen.
    expect(parsed.data.projectId).toBe(projectId);
    expect(parsed.data.targetId).toBeNull();
    expect(parsed.data.note).toBe("no-target-imported-yet");
    expect(parsed.data.nodes).toEqual([]);
    expect(parsed.data.edges).toEqual([]);
    expect(parsed.data.claims).toEqual([]);
    expect(parsed.data.truncated).toBe(false);
  });

  it("refuses a query target that is not an opaque id before any command runs", async () => {
    const session = await pairSession();
    const projectId = await createProject(session, "key-graph-badtarget");
    const bad = await call("GET", `${API_PREFIX}/projects/${projectId}/graph?targetId=../../etc/passwd`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(bad.status, bad.text).toBe(400);
    expect(bad.text).toContain("graph-target-id-malformed");
    // The refused value is a path, and a refusal that repeats it would put a host path
    // into a log line and into the page (§12.1).
    expect(bad.text).not.toContain("etc/passwd");

    const unknown = await call("GET", `${API_PREFIX}/projects/${projectId}/graph?targetId=${newId()}`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    // A well-formed id that names nothing is the read's own answer, not a shape refusal.
    expect(unknown.status, unknown.text).toBe(200);
    expect(unknown.text).toContain("target-unknown");
  });

  it("carries the claim's stored fields and no status string, so the colour stays owned by the domain", async () => {
    const session = await pairSession();
    const projectId = await createProject(session, "key-graph-shape");
    // One target and one claim through the worker's own writer, because the claim rows
    // have exactly one owner (§5) and a second writer would be a second truth.
    const targetId = newId();
    const claimId = newId();
    const entityKey = "GET /api/cart";
    const created = nowInstant();
    const seeded = worker.writeConnection.transact((tx) => {
      tx.insertTarget({
        id: targetId,
        projectId: projectId as Id,
        kind: "har",
        originalLocator: null,
        sourceSha256: null,
        sourceArtifactId: null,
        snapshotDigest: asDigest(hex("web-graph-target")),
        identityReason: null,
        createdAt: created,
      });
      tx.insertClaim({
        id: claimId,
        projectId: projectId as Id,
        targetId,
        entityKey,
        claimKey: "route-exists",
        assertion: "the cart route answers with the requested include set",
        scopeJson: { sourceEvidenceIds: [] },
        basis: "observed",
        sourceState: "retained",
        coverageJson: { state: "unknown", examined: null, total: null, reasons: [] },
        validity: "current",
        revision: 1,
        unknownReasonsJson: [],
      });
      return true;
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const read = await call("GET", `${API_PREFIX}/projects/${projectId}/graph`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(read.status, read.text).toBe(200);
    const view = graphViewSchema.parse(JSON.parse(read.text) as unknown);
    expect(view.nodes.map((node) => node.entityKey)).toContain(entityKey);
    expect(view.claims).toHaveLength(1);
    const claim = view.claims[0];
    if (claim === undefined) throw new Error("the seeded claim did not come back");
    // What the screen judges on: the four stored deciders plus the evidence ids, and no
    // derived colour, severity or status word anywhere in the body.
    expect(Object.keys(claim.state).sort()).toEqual([
      "authorityApplies",
      "basis",
      "coverage",
      "sourceEvidenceIds",
      "validity",
    ]);
    expect(claim.state.basis).toBe("observed");
    expect(claim.state.validity).toBe("current");
    expect(read.text).not.toMatch(/"(colour|color|triColour|status)"/);
    expect(view.targetId).toBe(targetId);
  });
});

describe("the web process entrypoint (DESIGN §3, §14 / issue #18)", () => {
  async function freePort(): Promise<number> {
    const net = await import("node:net");
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  function webEnv(port: number): Record<string, string | undefined> {
    return { WB_HOST: "127.0.0.1", WB_PORT: String(port), WB_DATA_DIR: dataDir };
  }

  it("refuses a toolchain it was not built for, and a config that names nothing usable", async () => {
    const wrongNode = await runWebProcess({
      env: webEnv(4399),
      nodeVersion: "22.12.0",
      log: () => undefined,
    });
    expect(wrongNode).toEqual({ ok: false, exitCode: 73, reasons: ["node-24.18.0-required"] });

    // A missing data directory is a named field failure, and a field this process has no
    // business reading never rides along into the reason list with a host path in it.
    const lines: string[] = [];
    const missing = await runWebProcess({
      env: { WB_HOST: "127.0.0.1", WB_PORT: "4399", WB_REA_ENTRYPOINT: "/host/private/rea.mjs", HOME: "/host/private" },
      nodeVersion: "24.18.0",
      log: (line) => lines.push(line),
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.exitCode).toBe(78);
    expect(missing.reasons).toContain("WB_DATA_DIR:required-and-no-installed-default");
    expect(JSON.stringify(missing.reasons)).not.toContain("host/private");
    expect(JSON.stringify(lines)).not.toContain("host/private");
  });

  it("serves the browser's own request sequence over a real bind and the worker's socket", async () => {
    const port = await freePort();
    const run = await runWebProcess({ env: webEnv(port), nodeVersion: "24.18.0", log: () => undefined, pollMs: 5 });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.port).toBe(port);
    const origin = `http://127.0.0.1:${String(port)}`;
    try {
      // Exactly what the UI relay sends after `decideProxy` stamped the API's own origin:
      // the page lives on another port, so the API's §14 same-source rule is satisfied by
      // the proxy's assertion rather than by the browser's value.
      const code = worker.mintPairingCode();
      const paired = await fetch(`${origin}${API_PREFIX}/session`, {
        method: "POST",
        headers: { host: `127.0.0.1:${String(port)}`, origin, "content-type": "application/json" },
        body: JSON.stringify({ bootstrapToken: code.token }),
        redirect: "manual",
      });
      const pairedText = await paired.text();
      expect(paired.status, pairedText).toBe(201);
      const cookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
      expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
      const pairedBody = JSON.parse(pairedText) as Record<string, JsonValue>;
      const csrf = ((pairedBody["data"] ?? pairedBody) as Record<string, string>)["csrfToken"] ?? "";
      expect(csrf.length).toBeGreaterThan(16);

      const created = await fetch(`${origin}${API_PREFIX}/projects`, {
        method: "POST",
        headers: { host: `127.0.0.1:${String(port)}`, origin, cookie, "x-csrf-token": csrf, "idempotency-key": "entrypoint-create", "content-type": "application/json" },
        body: JSON.stringify({ name: "via-entrypoint" }),
      });
      const createdText = await created.text();
      expect(created.status, createdText).toBe(201);
      const createdBody = JSON.parse(createdText) as { id?: string; data?: { id: string } };
      const projectId = createdBody.data?.id ?? createdBody.id ?? "";

      const graph = await fetch(`${origin}${API_PREFIX}/projects/${projectId}/graph`, {
        headers: { host: `127.0.0.1:${String(port)}`, cookie },
      });
      const graphText = await graph.text();
      expect(graph.status, graphText).toBe(200);
      expect(graphViewSchema.safeParse(JSON.parse(graphText) as unknown).success).toBe(true);

      // The page's own origin is not the API's, and the entrypoint's server says so: this
      // is the refusal the relay exists to prevent rather than a door it opens.
      const pageOrigin = await fetch(`${origin}${API_PREFIX}/projects`, {
        method: "POST",
        headers: { host: `127.0.0.1:${String(port)}`, origin: "http://localhost:3000", cookie, "x-csrf-token": csrf, "idempotency-key": "entrypoint-page", "content-type": "application/json" },
        body: JSON.stringify({ name: "should-not-exist" }),
      });
      const pageOriginText = await pageOrigin.text();
      expect(pageOrigin.status, pageOriginText).toBe(403);
      expect(pageOriginText).toContain("origin-not-same-source");

      // An SSE route through this process still streams: the entrypoint's poll is not a
      // buffer, and a browser tab that asked for events would otherwise hang.
      const events = await fetch(`${origin}${API_PREFIX}/projects/${projectId}/events`, {
        headers: { host: `127.0.0.1:${String(port)}`, cookie, accept: "text/event-stream" },
      });
      expect(events.status).toBe(200);
      expect(events.headers.get("content-type")).toContain("text/event-stream");
      await events.body?.cancel();
    } finally {
      await run.close();
    }
  });

  it("reads only the three §14 names this process is given, from one declared list", () => {
    const source = readFileSync(path.join(ROOT, "apps/web/main.ts"), "utf8");
    const named = [...source.matchAll(/WB_[A-Z_]+/g)].map((match) => match[0]);
    expect([...new Set(named)].sort()).toEqual(["WB_DATA_DIR", "WB_HOST", "WB_PORT"]);
    // No filesystem, no child process, no database: the worker owns all three (§3).
    // Anchored to the import form rather than the words, because this file's own prose
    // names those modules to explain why it must not use them.
    expect(source).not.toMatch(/from\s*["']node:(fs|sqlite|child_process|net|process)["']/);
    expect(source).not.toContain('from "node:fs"');
    expect(source).toContain('const WEB_CONFIG_FIELDS: readonly BootConfigField[] = ["WB_HOST", "WB_PORT", "WB_DATA_DIR"]');
  });
});

describe("degraded behaviour (§14)", () => {
  it("answers health through the worker and refuses an unpaired caller", async () => {
    const refused = await call("GET", `${API_PREFIX}/health`, {
      headers: { host: `127.0.0.1:${String(address.port)}` },
    });
    expect(refused.status).toBe(401);
  });
});

describe("the candidate file routes (§8 lines 295-296 / issue #19)", () => {
  async function pairSession(): Promise<{ cookie: string; csrf: string }> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const body = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    return {
      cookie: (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "",
      csrf: body.data?.csrfToken ?? body.csrfToken ?? "",
    };
  }

  it("mounts exactly two candidate routes and holds both behind a session", async () => {
    const project = newId();
    const candidate = newId();
    const anonymousList = await call("GET", `${API_PREFIX}/projects/${project}/candidates/${candidate}`);
    expect(anonymousList.status).toBe(401);
    const anonymousFile = await call("GET", `${API_PREFIX}/projects/${project}/candidates/${candidate}/files/${newId()}`);
    expect(anonymousFile.status).toBe(401);
    // A near-miss path is not a route: these two GETs do not open a read-anything door
    // under `/candidates/`.
    const neighbour = await call("GET", `${API_PREFIX}/projects/${project}/candidates/${candidate}/source`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: (await pairSession()).cookie },
    });
    expect(neighbour.status, neighbour.text).toBe(404);
    expect(neighbour.text).toContain("route-unknown");
  });

  it("refuses a path segment that is not an opaque id before asking the worker", async () => {
    const session = await pairSession();
    const bad = await call("GET", `${API_PREFIX}/projects/${newId()}/candidates/not-a-uuid/files/not-a-uuid`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(bad.status, bad.text).toBe(404);
    expect(bad.text).toContain("candidate-file-unknown");
    // The refused text was a path-shaped string; repeating it would put it in a log line
    // and back into the page (§12.1).
    expect(bad.text).not.toContain("not-a-uuid");
  });

  it("relays the worker's named refusals onto the closed codes", async () => {
    const session = await pairSession();
    const missing = await call("GET", `${API_PREFIX}/projects/${newId()}/candidates/${newId()}`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(missing.status, missing.text).toBe(404);
    expect(missing.text).toContain("candidate-unknown");

    const missingFile = await call("GET", `${API_PREFIX}/projects/${newId()}/candidates/${newId()}/files/${newId()}`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(missingFile.status, missingFile.text).toBe(404);
    expect(missingFile.text).toContain("candidate-unknown");
  });
});

// GET /projects/:p/jobs over the real socket (§8 line 277 / issue #55).
//
// The page itself is exercised against real rows in tests/integration/job-read.test.ts; what
// this route has to prove is the HTTP half: it is a named route behind a session, its query
// parameters are refused at the edge rather than coerced, and the worker's bound refusal
// arrives as a status rather than as a silently smaller page.

describe("the job page route (§8 line 277 / issue #55)", () => {
  async function pairSession(): Promise<{ cookie: string; csrf: string }> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const body = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    return {
      cookie: (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "",
      csrf: body.data?.csrfToken ?? body.csrfToken ?? "",
    };
  }

  it("holds the route behind a session and does not open the projects namespace", async () => {
    const anonymous = await call("GET", `${API_PREFIX}/projects/${newId()}/jobs`);
    expect(anonymous.status).toBe(401);
    const session = await pairSession();
    // One segment deeper than any §8 job route is not a route at all: `/jobs/` does not open
    // a "read anything under it" door.
    const neighbour = await call("GET", `${API_PREFIX}/projects/${newId()}/jobs/${newId()}/log`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(neighbour.status, neighbour.text).toBe(404);
    expect(neighbour.text).toContain("route-unknown");
    // `GET /jobs/:j` IS a §8 template, so a non-identifier in that slot is not a routing
    // miss: it is a malformed request, refused before the worker is asked, and the refused
    // string never comes back into the page or a log line (§12.1).
    const malformed = await call("GET", `${API_PREFIX}/projects/${newId()}/jobs/all`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(malformed.status, malformed.text).toBe(400);
    expect(malformed.text).toContain("job-id-malformed");
    expect(malformed.text).not.toContain("/jobs/all");
  });

  it("answers a project with no jobs as an empty page, not as an error", async () => {
    const session = await pairSession();
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name: "jobs-route" }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `jobs-route-${String(newId())}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const project = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    const projectId = (project.data?.id ?? project.id) as string;
    const listed = await call("GET", `${API_PREFIX}/projects/${projectId}/jobs`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(listed.status, listed.text).toBe(200);
    const page = jobPageSchema.safeParse(JSON.parse(listed.text) as JsonValue);
    if (!page.success) throw new Error(`the page reply did not match the contract: ${listed.text}`);
    expect(page.data.items).toEqual([]);
    expect(page.data.nextCursor).toBeNull();
  });

  it("refuses a query it cannot read as a number at the edge, before any command runs", async () => {
    const session = await pairSession();
    for (const limit of ["abc", "1.5", "-3", ""]) {
      const bad = await call("GET", `${API_PREFIX}/projects/${newId()}/jobs?limit=${limit}`, {
        headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
      });
      expect(bad.status, `${limit}: ${bad.text}`).toBe(400);
      expect(bad.text).toContain("jobs-limit-malformed");
    }
  });

  it("relays the page bound as a refusal rather than serving a quietly smaller page", async () => {
    const session = await pairSession();
    const over = await call("GET", `${API_PREFIX}/projects/${newId()}/jobs?limit=${String(JOB_LIST_MAX_LIMIT + 1)}`, {
      headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie },
    });
    expect(over.status, over.text).toBe(413);
    expect(over.text).toContain("jobs-limit");
  });

  it("relays a cursor this server never issued as a named refusal", async () => {
    const session = await pairSession();
    const forged = await call(
      "GET",
      `${API_PREFIX}/projects/${newId()}/jobs?cursor=${encodeURIComponent("not-a-cursor")}`,
      { headers: { host: `127.0.0.1:${String(address.port)}`, cookie: session.cookie } },
    );
    expect(forged.status, forged.text).toBe(400);
    expect(forged.text).toContain("jobs-cursor");
  });
});

// The five §8 reads that had a worker command and no HTTP door (issue #58).
//
// Real data, real socket, real SQLite: the project arrives through `POST /projects`, and the
// job, artifact and evidence rows through the worker's own write connection - the same rows
// a HAR import would leave behind. The point is not that a handler exists but that what the
// command answers is what §8 says the route returns, checked by parsing the HTTP body with
// the schema the route itself uses.

describe("the §8 read routes (issue #58)", () => {
  async function pairSession(): Promise<{ cookie: string; csrf: string }> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const body = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    return {
      cookie: (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "",
      csrf: body.data?.csrfToken ?? body.csrfToken ?? "",
    };
  }

  async function freshProject(session: { cookie: string; csrf: string }, name: string): Promise<string> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `read-route-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return (body.data?.id ?? body.id) as string;
  }

  function get(pathname: string, cookie: string) {
    return call("GET", pathname, { headers: { host: `127.0.0.1:${String(address.port)}`, cookie } });
  }

  it("mounts exactly the five documented reads and refuses each one unpaired", async () => {
    const id = newId();
    for (const pathname of [
      `${API_PREFIX}/projects/${id}`,
      `${API_PREFIX}/projects/${id}/jobs/${id}`,
      `${API_PREFIX}/projects/${id}/evidence/${"ev_" + "1".repeat(64)}`,
      `${API_PREFIX}/projects/${id}/vectors/${id}`,
      `${API_PREFIX}/projects/${id}/verification-plans/${id}`,
    ]) {
      const anonymous = await call("GET", pathname);
      expect(`${pathname}:${String(anonymous.status)}`).toContain("401");
    }
    // And a sixth segment under `/vectors/` is not a door: §8 names one resource per path.
    const session = await pairSession();
    const deeper = await get(`${API_PREFIX}/projects/${id}/vectors/${id}/body`, session.cookie);
    expect(deeper.status, deeper.text).toBe(404);
    expect(deeper.text).toContain("route-unknown");
  });

  it("answers the project view with the six fields §8 line 271 names", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "read-project");
    const listed = await get(`${API_PREFIX}/projects/${projectId}`, session.cookie);
    expect(listed.status, listed.text).toBe(200);
    const parsed = projectViewSchema.safeParse(JSON.parse(listed.text) as JsonValue);
    if (!parsed.success) throw new Error(`the route refused its own schema: ${listed.text}`);
    expect(parsed.data.id).toBe(projectId);
    expect(parsed.data.name).toBe("read-project");
    expect(parsed.data.graphRevision).toBe(0);
    expect(parsed.data.inventoryRevision).toBe(0);
    expect(parsed.data.targetIds).toEqual([]);
    expect(parsed.data.recentJobIds).toEqual([]);
  });

  it("reads one job back as a full JobRecord, including the fields the page reports", async () => {
    const session = await pairSession();
    const projectId = (await freshProject(session, "read-job")) as Id;
    const jobId = newId();
    const created = nowInstant();
    const seeded = worker.writeConnection.transact((tx) => {
      tx.insertJob({
        id: jobId,
        projectId,
        targetId: null,
        kind: "build",
        state: "succeeded",
        cleanupState: "pending",
        inputJson: {},
        resultRef: "candidate-from-read-route",
        errorJson: null,
        idempotencyKey: `read-route-${String(jobId)}`,
        requestDigest: asDigest(hex("read-job")),
        deadlineAt: null,
        retryAt: null,
        createdAt: created,
        updatedAt: created,
      });
      tx.insertLease({
        id: newId(),
        jobId,
        kind: "staging-dir",
        resourceIdentityJson: { path: "runs/x" },
        ownershipProofJson: { marker: "owned" },
        cleanupState: "pending",
        lastErrorJson: null,
        retryAt: created,
        retryCount: 0,
      });
      return true;
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));

    // The same project's view has to name that job: §8 line 271's two id lists are what makes
    // the view a way *into* a project rather than a receipt for its name.
    const viewOfIt = await get(`${API_PREFIX}/projects/${projectId}`, session.cookie);
    expect(viewOfIt.status, viewOfIt.text).toBe(200);
    expect((JSON.parse(viewOfIt.text) as { recentJobIds?: string[] }).recentJobIds).toContain(jobId);

    const single = await get(`${API_PREFIX}/projects/${projectId}/jobs/${jobId}`, session.cookie);
    expect(single.status, single.text).toBe(200);
    const record = jobRecordSchema.safeParse(JSON.parse(single.text) as JsonValue);
    if (!record.success) throw new Error(`the job route refused its own schema: ${single.text}`);
    expect(record.data.resultRef).toBe("candidate-from-read-route");
    expect(record.data.cleanupState).toBe("pending");
    // The same row read through the page must be byte-identical, because both reads run the
    // one projection (§8: GET job, GET jobs and job.updated share the named time fields).
    const page = await get(`${API_PREFIX}/projects/${projectId}/jobs`, session.cookie);
    expect(page.status, page.text).toBe(200);
    const listed = jobPageSchema.safeParse(JSON.parse(page.text) as JsonValue);
    if (!listed.success) throw new Error(`the page route refused its own schema: ${page.text}`);
    expect(listed.data.items.find((item) => item.id === jobId)).toEqual(record.data);
  });

  it("caps the project view's recent list instead of dumping the table", async () => {
    // One project, 23 jobs a second apart. The view must answer with the bound, and with the
    // newest ones: an unbounded list would grow with the project forever, and a wrong order
    // would quietly serve the oldest work as "recent".
    const session = await pairSession();
    const projectId = (await freshProject(session, "read-bound")) as Id;
    const base = Date.parse("2026-10-16T00:00:00.000Z");
    const ids: Id[] = [];
    for (let index = 0; index < 23; index += 1) {
      const id = newId();
      ids.push(id);
      const at = asInstant(new Date(base + index * 1000).toISOString());
      const seeded = worker.writeConnection.transact((tx) => {
        tx.insertJob({
          id,
          projectId,
          targetId: null,
          kind: "inspect",
          state: "succeeded",
          cleanupState: "complete",
          inputJson: {},
          resultRef: null,
          errorJson: null,
          idempotencyKey: `bound-${String(index)}`,
          requestDigest: asDigest(hex(`bound-${String(index)}`)),
          deadlineAt: null,
          retryAt: null,
          createdAt: at,
          updatedAt: at,
        });
        return true;
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    }
    const listed = await get(`${API_PREFIX}/projects/${projectId}`, session.cookie);
    expect(listed.status, listed.text).toBe(200);
    const view = projectViewSchema.safeParse(JSON.parse(listed.text) as JsonValue);
    if (!view.success) throw new Error(listed.text);
    expect(view.data.recentJobIds.length).toBe(20);
    // Newest first, so the tail of the seeded run is what the head of the list must show.
    expect(view.data.recentJobIds.slice(0, 3)).toEqual([...ids].reverse().slice(0, 3));
  });

  it("reads a stored evidence envelope back under `evidence`, with what the store knew about it", async () => {
    const session = await pairSession();
    const projectId = (await freshProject(session, "read-evidence")) as Id;
    const targetId = newId();
    const jobId = newId();
    const artifactId = newId();
    const evidenceId = `ev_${"7".repeat(64)}`;
    const created = nowInstant();
    const envelope = { evidence_id: evidenceId, operation: "inspect_web_network_capture", detail: { status: 200 } };
    const store = new ArtifactStore(dataDir);
    const published = await store.publish(projectId, "inspector", new TextEncoder().encode(JSON.stringify(envelope)));
    if (!published.ok) throw new Error(JSON.stringify(published.error));
    const seeded = worker.writeConnection.transact((tx) => {
      tx.insertTarget({
        id: targetId,
        projectId,
        kind: "har",
        originalLocator: null,
        sourceSha256: null,
        sourceArtifactId: null,
        snapshotDigest: asDigest(hex("read-evidence-snapshot")),
        identityReason: null,
        createdAt: created,
      });
      tx.insertJob({
        id: jobId,
        projectId,
        targetId,
        kind: "capture",
        state: "succeeded",
        cleanupState: "complete",
        inputJson: {},
        resultRef: evidenceId,
        errorJson: null,
        idempotencyKey: `read-evidence-${String(jobId)}`,
        requestDigest: asDigest(hex("read-evidence-job")),
        deadlineAt: null,
        retryAt: null,
        createdAt: created,
        updatedAt: created,
      });
      tx.insertArtifact({
        id: artifactId,
        projectId,
        jobId,
        class: "inspector",
        sha256: published.value.sha256,
        digestReason: null,
        byteLength: published.value.byteLength,
        storageKey: published.value.storageKey,
        mediaType: "application/json",
        createdAt: created,
      });
      tx.insertEvidence({
        projectId,
        id: evidenceId,
        targetId,
        jobId,
        artifactId,
        providerJson: { id: "rea", name: "rea", version: "6.4.0" },
        operation: "inspect_web_network_capture",
        confidence: "observed",
        authority: "shipped-artifact",
        createdAt: created,
      });
      return true;
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));

    const read = await get(`${API_PREFIX}/projects/${projectId}/evidence/${evidenceId}`, session.cookie);
    expect(read.status, read.text).toBe(200);
    const view = evidenceViewSchema.safeParse(JSON.parse(read.text) as JsonValue);
    if (!view.success) throw new Error(`the evidence route refused its own schema: ${read.text}`);
    // The envelope is passed through verbatim, under `evidence` (§4: a schema object travels
    // as the source stated it), and the companion fields are the store's own facts.
    expect(view.data.evidence).toEqual(envelope);
    expect(view.data.byteLength).toBe(new TextEncoder().encode(JSON.stringify(envelope)).length);
    expect(view.data.sha256).toBe(published.value.sha256);
    // The project view has to name that target too: an empty list would read as "this
    // project has nothing in it" while the evidence row says otherwise.
    const viewOfProject = await get(`${API_PREFIX}/projects/${projectId}`, session.cookie);
    const parsedView = projectViewSchema.safeParse(JSON.parse(viewOfProject.text) as JsonValue);
    if (!parsedView.success) throw new Error(viewOfProject.text);
    expect(parsedView.data.targetIds).toContain(targetId);

    const otherProject = await freshProject(session, "read-evidence-other");
    const crossProject = await get(`${API_PREFIX}/projects/${otherProject}/evidence/${evidenceId}`, session.cookie);
    expect(crossProject.status, crossProject.text).toBe(404);
    expect(crossProject.text).toContain("evidence-unknown");
  });

  it("refuses an evidence body over the inline cap by name, with the numbers to quote", async () => {
    const session = await pairSession();
    const projectId = (await freshProject(session, "read-evidence-big")) as Id;
    const targetId = newId();
    const jobId = newId();
    const artifactId = newId();
    const evidenceId = `ev_${"8".repeat(64)}`;
    const created = nowInstant();
    const store = new ArtifactStore(dataDir);
    const bytes = new Uint8Array(EVIDENCE_INLINE_LIMIT_BYTES + 1).fill(123);
    const published = await store.publish(projectId, "inspector", bytes);
    if (!published.ok) throw new Error(JSON.stringify(published.error));
    const seeded = worker.writeConnection.transact((tx) => {
      tx.insertTarget({
        id: targetId,
        projectId,
        kind: "har",
        originalLocator: null,
        sourceSha256: null,
        sourceArtifactId: null,
        snapshotDigest: asDigest(hex("big-snapshot")),
        identityReason: null,
        createdAt: created,
      });
      tx.insertJob({
        id: jobId,
        projectId,
        targetId,
        kind: "capture",
        state: "succeeded",
        cleanupState: "complete",
        inputJson: {},
        resultRef: evidenceId,
        errorJson: null,
        idempotencyKey: `big-${String(jobId)}`,
        requestDigest: asDigest(hex("big-job")),
        deadlineAt: null,
        retryAt: null,
        createdAt: created,
        updatedAt: created,
      });
      tx.insertArtifact({
        id: artifactId,
        projectId,
        jobId,
        class: "inspector",
        sha256: published.value.sha256,
        digestReason: null,
        byteLength: published.value.byteLength,
        storageKey: published.value.storageKey,
        mediaType: "application/octet-stream",
        createdAt: created,
      });
      tx.insertEvidence({
        projectId,
        id: evidenceId,
        targetId,
        jobId,
        artifactId,
        providerJson: {},
        operation: "inspect_web_network_capture",
        confidence: "observed",
        authority: "shipped-artifact",
        createdAt: created,
      });
      return true;
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));

    const read = await get(`${API_PREFIX}/projects/${projectId}/evidence/${evidenceId}`, session.cookie);
    // The cap is a cap, not a tripwire: this file is one byte past it.
    expect(read.status, read.text).toBe(413);
    expect(read.text).toContain("evidence-over-inline-limit");
    // The refusal quotes the cap instead of truncating an envelope: a page that showed half a
    // provider record would read as a record.
    expect(read.text).toContain(String(EVIDENCE_INLINE_LIMIT_BYTES));
    expect(read.text).toContain(String(EVIDENCE_INLINE_LIMIT_BYTES + 1));
    // Issue #59, now closed: the numbers travel. They crossed two filters to get here - the
    // worker applied the declared-key list at its own socket boundary, this side re-checked
    // the frame - and both of the values the refusal named arrive as themselves.
    const refusal = JSON.parse(read.text) as { error: { details: Record<string, unknown> } };
    expect(refusal.error.details["limit"]).toBe(EVIDENCE_INLINE_LIMIT_BYTES);
    expect(refusal.error.details["byteLength"]).toBe(EVIDENCE_INLINE_LIMIT_BYTES + 1);
    expect(refusal.error.details["reason"]).toBe("evidence-over-inline-limit");
    // None of the stored bytes ride along in the refusal.
    expect(read.text).not.toContain("{{{");

    // The other side of the same line: a file of exactly the cap is a read, not a refusal.
    // Without this half the test only proves the number appears in a message.
    const exactId = newId();
    const exactEvidence = `ev_${"9".repeat(64)}`;
    // Valid JSON of exactly the cap: `{"pad":"` + padding + `"}` is the envelope, so the only
    // thing at the boundary is its length.
    const padLength = EVIDENCE_INLINE_LIMIT_BYTES - '{"pad":"'.length - '"}'.length;
    const exactBytes = new TextEncoder().encode(`{"pad":"${"x".repeat(padLength)}"}`);
    expect(exactBytes.length).toBe(EVIDENCE_INLINE_LIMIT_BYTES);
    const exact = await store.publish(projectId, "inspector", exactBytes);
    if (!exact.ok) throw new Error(JSON.stringify(exact.error));
    const seededExact = worker.writeConnection.transact((tx) => {
      tx.insertArtifact({
        id: exactId,
        projectId,
        jobId,
        class: "inspector",
        sha256: exact.value.sha256,
        digestReason: null,
        byteLength: exact.value.byteLength,
        storageKey: exact.value.storageKey,
        mediaType: "application/octet-stream",
        createdAt: created,
      });
      tx.insertEvidence({
        projectId,
        id: exactEvidence,
        targetId,
        jobId,
        artifactId: exactId,
        providerJson: {},
        operation: "inspect_web_network_capture",
        confidence: "observed",
        authority: "shipped-artifact",
        createdAt: created,
      });
      return true;
    });
    if (!seededExact.ok) throw new Error(JSON.stringify(seededExact.error));
    const atCap = await get(`${API_PREFIX}/projects/${projectId}/evidence/${exactEvidence}`, session.cookie);
    expect(atCap.status, atCap.text).toBe(200);
    const atCapBody = JSON.parse(atCap.text) as { byteLength: number; mediaType: string };
    expect(atCapBody.byteLength).toBe(EVIDENCE_INLINE_LIMIT_BYTES);
    // The media type is the artifact row's, not the route's guess: two envelopes stored under
    // this project differ in exactly that field.
    expect(atCapBody.mediaType).toBe("application/octet-stream");
  });

  it("refuses a path segment that is not an identifier, naming the resource rather than the project", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "read-malformed");
    const cases: [string, string][] = [
      ["jobs", "job-id-malformed"],
      ["vectors", "vector-id-malformed"],
      ["verification-plans", "plan-id-malformed"],
      ["evidence", "evidence-id-malformed"],
    ];
    for (const [segment, reason] of cases) {
      const bad = await get(`${API_PREFIX}/projects/${projectId}/${segment}/not-an-id`, session.cookie);
      // A typo in the id slot is 400, and a well-formed id that names nothing is 404: an
      // operator fixing a broken link has to be able to tell those two apart.
      expect(`${segment}:${String(bad.status)}`).toContain("400");
      expect(`${segment}:${bad.text}`).toContain(reason);
      expect(bad.text).not.toContain("not-an-id");
    }
  });

  it("relays the worker's own not-found for a vector and a plan that is not this project's", async () => {
    const session = await pairSession();
    const mine = await freshProject(session, "read-unknown-vector");
    const other = await freshProject(session, "read-unknown-plan");
    const vector = await get(`${API_PREFIX}/projects/${mine}/vectors/${newId()}`, session.cookie);
    expect(vector.status, vector.text).toBe(404);
    const plan = await get(`${API_PREFIX}/projects/${other}/verification-plans/${newId()}`, session.cookie);
    expect(plan.status, plan.text).toBe(404);
    expect(plan.text).toContain("plan-unknown");
  });
});

// The two audit windows over HTTP (§8 lines 302-303 / issue #58).
//
// The journal this reads is the one the suite itself wrote: every pairing above journaled a
// `session.pair`, and every project creation journaled a project row. That is the point of
// doing it here rather than with fixtures - the split between "this project's decisions" and
// "the entries that belong to no project" is checked against rows neither test authored.

describe("the audit routes (§8 lines 302-303)", () => {
  async function pairSession(): Promise<{ cookie: string; csrf: string }> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const body = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    return {
      cookie: (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "",
      csrf: body.data?.csrfToken ?? body.csrfToken ?? "",
    };
  }

  async function freshProject(session: { cookie: string; csrf: string }, name: string): Promise<string> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `audit-route-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return (body.data?.id ?? body.id) as string;
  }

  function get(pathname: string, cookie: string) {
    return call("GET", pathname, { headers: { host: `127.0.0.1:${String(address.port)}`, cookie } });
  }

  // Rows written straight through the worker's own connection. This suite is about the two
  // windows' selectors and the cursor, not about who journalled what - and §12.2's list of
  // journalled actions does not include creating a project, so a fresh project's window is
  // legitimately empty. Asserting against an empty page would certify any selector at all.
  function seedProjectAudit(projectId: string, count: number): number[] {
    const seqs: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const written = worker.writeConnection.transact((tx) =>
        tx.insertAudit({
          projectId: projectId as Id,
          actorId: "local-reviewer",
          actorKind: "reviewer",
          action: "vector.review",
          resourceType: "vector",
          resourceId: String(newId()),
          decision: index % 2 === 0 ? "allow" : "deny",
          reasonCode: index % 2 === 0 ? "vector-approved" : "vector-rejected",
          safeMetadataJson: { attempt: index },
          createdAt: nowInstant(),
        }),
      );
      if (!written.ok) throw new Error(JSON.stringify(written.error));
      seqs.push(written.value);
    }
    return seqs;
  }

  it("holds both windows behind a session and does not invent neighbours", async () => {
    const anonymousGlobal = await call("GET", `${API_PREFIX}/audit`);
    expect(anonymousGlobal.status).toBe(401);
    const anonymousScoped = await call("GET", `${API_PREFIX}/projects/${newId()}/audit`);
    expect(anonymousScoped.status).toBe(401);
    const session = await pairSession();
    const neighbour = await get(`${API_PREFIX}/audit/entries`, session.cookie);
    expect(neighbour.status, neighbour.text).toBe(404);
    expect(neighbour.text).toContain("route-unknown");
  });

  it("keeps the unrooted journal to the rows that belong to no project", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "audit-global-window");
    const global = await get(`${API_PREFIX}/audit?limit=500`, session.cookie);
    expect(global.status, global.text).toBe(200);
    const parsed = auditPageSchema.safeParse(JSON.parse(global.text) as JsonValue);
    if (!parsed.success) throw new Error(`the unrooted window refused its own schema: ${global.text}`);
    expect(parsed.data.entries.every((entry) => entry.projectId === null)).toBe(true);
    // Pairing is what this suite did to get here, and §12.2 lists it among the project-less
    // entries. An empty journal would mean the window reads a different table than the writes.
    expect(parsed.data.entries.some((entry) => entry.action === "session.pair")).toBe(true);
    const seeded = seedProjectAudit(projectId, 3);
    const scoped = await get(`${API_PREFIX}/projects/${projectId}/audit?limit=500`, session.cookie);
    expect(scoped.status, scoped.text).toBe(200);
    const own = auditPageSchema.safeParse(JSON.parse(scoped.text) as JsonValue);
    if (!own.success) throw new Error(scoped.text);
    expect(own.data.entries.length).toBeGreaterThanOrEqual(3);
    expect(own.data.entries.every((entry) => entry.projectId === projectId)).toBe(true);
    expect(own.data.entries.map((entry) => entry.seq)).toEqual(expect.arrayContaining(seeded));
    const globalSeqs = new Set(parsed.data.entries.map((entry) => entry.seq));
    expect(own.data.entries.filter((entry) => globalSeqs.has(entry.seq))).toEqual([]);
  });

  it("refuses a query it cannot read as a number, and accepts the one value that looks like a typo", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "audit-bad-query");
    for (const bad of ["abc", "-1", "1.5", ""]) {
      const after = await get(`${API_PREFIX}/projects/${projectId}/audit?after=${encodeURIComponent(bad)}`, session.cookie);
      expect(`after=${bad}:${String(after.status)}`).toContain("400");
      expect(after.text).toContain("audit-after-malformed");
      const limit = await get(`${API_PREFIX}/projects/${projectId}/audit?limit=${encodeURIComponent(bad)}`, session.cookie);
      expect(`limit=${bad}:${String(limit.status)}`).toContain("400");
      expect(limit.text).toContain("audit-limit-malformed");
    }
    // `after=0` is the beginning of the journal, not a missing value: the edge test above has
    // to refuse text without swallowing the legal zero, or a page could never ask from start.
    const zero = await get(`${API_PREFIX}/projects/${projectId}/audit?after=0`, session.cookie);
    expect(zero.status, zero.text).toBe(200);
  });

  it("refuses a page past the bound instead of serving a quieter smaller one", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "audit-over-bound");
    const over = await get(`${API_PREFIX}/projects/${projectId}/audit?limit=${String(AUDIT_LIST_MAX_LIMIT + 1)}`, session.cookie);
    expect(over.status, over.text).toBe(413);
    expect(over.text).toContain("audit-limit");
  });

  it("follows the integer cursor to the end of the journal through HTTP without repeating a seq", async () => {
    const session = await pairSession();
    await freshProject(session, "audit-cursor-a");
    await freshProject(session, "audit-cursor-b");
    const projectId = (await freshProject(session, "audit-cursor-c")) as Id;
    seedProjectAudit(projectId, 5);
    const seen: number[] = [];
    let after: number | null = 0;
    for (let pages = 0; pages < 200; pages += 1) {
      const page = await get(`${API_PREFIX}/projects/${projectId}/audit?limit=2&after=${String(after ?? 0)}`, session.cookie);
      expect(page.status, page.text).toBe(200);
      const parsed = auditPageSchema.safeParse(JSON.parse(page.text) as JsonValue);
      if (!parsed.success) throw new Error(page.text);
      seen.push(...parsed.data.entries.map((entry) => entry.seq));
      if (parsed.data.nextCursor === null) break;
      after = parsed.data.nextCursor;
    }
    // More than one page, or "I followed the cursor" is a sentence about one request.
    expect(seen.length).toBeGreaterThan(2);
    expect(new Set(seen).size).toBe(seen.length);
    const whole = await get(`${API_PREFIX}/projects/${projectId}/audit`, session.cookie);
    const all = auditPageSchema.safeParse(JSON.parse(whole.text) as JsonValue);
    if (!all.success) throw new Error(whole.text);
    expect(seen.sort((left, right) => left - right)).toEqual(all.data.entries.map((entry) => entry.seq).sort((left, right) => left - right));
  });
});

// The inventory page route (§8 line 283 / issue #58).
//
// The HTTP half is what is tested here - the query's three slots, the session gate, and the
// worker's refusals arriving as the statuses §8 names them. The page's *body* and the stale
// cursor are proven where the rows exist: tests/integration/vector-service.test.ts walks a real
// inventory, and duplicating that seeding behind this socket would test the relay twice and
// the inventory once.

describe("the inventory page route (§8 line 283)", () => {
  async function pairSession(): Promise<{ cookie: string; csrf: string }> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const body = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    return {
      cookie: (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "",
      csrf: body.data?.csrfToken ?? body.csrfToken ?? "",
    };
  }

  async function freshProject(session: { cookie: string; csrf: string }, name: string): Promise<string> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: `127.0.0.1:${String(address.port)}`,
        origin: `http://127.0.0.1:${String(address.port)}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `vectors-route-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return (body.data?.id ?? body.id) as string;
  }

  function get(pathname: string, cookie: string) {
    return call("GET", pathname, { headers: { host: `127.0.0.1:${String(address.port)}`, cookie } });
  }

  it("holds the page behind a session", async () => {
    const anonymous = await call("GET", `${API_PREFIX}/projects/${newId()}/vectors?targetId=${newId()}`);
    expect(anonymous.status).toBe(401);
  });

  it("requires a target before asking the worker, and never echoes the rejected segment", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "vectors-need-target");
    for (const url of [`${API_PREFIX}/projects/${projectId}/vectors`, `${API_PREFIX}/projects/${projectId}/vectors?targetId=not-a-uuid`]) {
      const missing = await get(url, session.cookie);
      expect(missing.status, missing.text).toBe(400);
      expect(missing.text).toContain("vectors-target-required");
      expect(missing.text).not.toContain("not-a-uuid");
    }
  });

  it("answers a target with no samples as an empty page at the live revision", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "vectors-empty");
    const page = await get(`${API_PREFIX}/projects/${projectId}/vectors?targetId=${newId()}`, session.cookie);
    expect(page.status, page.text).toBe(200);
    const parsed = vectorPageSchema.safeParse(JSON.parse(page.text) as JsonValue);
    if (!parsed.success) throw new Error(page.text);
    expect(parsed.data.items).toEqual([]);
    expect(parsed.data.nextCursor).toBeNull();
    // The revision is reported even when nothing is shown: it is what a later cursor will be
    // compared against, and a page that omitted it could not be invalidated.
    expect(parsed.data.inventoryRevision).toBe(0);
  });

  it("refuses a page past the bound and a cursor that was never issued", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "vectors-bounds");
    const target = newId();
    const over = await get(`${API_PREFIX}/projects/${projectId}/vectors?targetId=${target}&limit=201`, session.cookie);
    expect(over.status, over.text).toBe(413);
    expect(over.text).toContain("vector-limit");
    const badLimit = await get(`${API_PREFIX}/projects/${projectId}/vectors?targetId=${target}&limit=1.5`, session.cookie);
    expect(badLimit.status, badLimit.text).toBe(400);
    expect(badLimit.text).toContain("vectors-limit-malformed");
    const badCursor = await get(`${API_PREFIX}/projects/${projectId}/vectors?targetId=${target}&cursor=${encodeURIComponent("!!!!")}`, session.cookie);
    expect(badCursor.status, badCursor.text).toBe(400);
    expect(badCursor.text).toContain("vector-cursor");
  });

  it("answers a well-formed target that is not this project's as nothing, not as a difference", async () => {
    const session = await pairSession();
    const mine = await freshProject(session, "vectors-mine");
    const other = await freshProject(session, "vectors-other");
    // A target id belonging to another project is a *shape* the route cannot tell apart from
    // one that simply has no samples. Both read as an empty page at this project's revision:
    // 404-for-foreign / 200-for-mine would turn the route into an oracle for "does that id
    // exist somewhere else", which is what §5's (project, target) composite key is for.
    const foreign = await get(`${API_PREFIX}/projects/${mine}/vectors?targetId=${other}`, session.cookie);
    const unknown = await get(`${API_PREFIX}/projects/${mine}/vectors?targetId=${newId()}`, session.cookie);
    expect(foreign.status, foreign.text).toBe(200);
    expect(unknown.status, unknown.text).toBe(200);
    expect(foreign.text).toBe(unknown.text);
    const parsed = vectorPageSchema.safeParse(JSON.parse(foreign.text) as JsonValue);
    if (!parsed.success) throw new Error(foreign.text);
    expect(parsed.data.items).toEqual([]);
    expect(parsed.data.inventoryRevision).toBe(0);
  });
});

describe("the three review routes (§8 lines 285, 287, 291 / issue #58)", () => {
  // The door is what this module owns: a decision expressed over HTTP has to reach the service
  // that stores it, under the session that made it. The rows behind it are seeded to the edge of
  // being approvable by `seedReviewChain`, so a 200 here is the service's own judgement, not a
  // fixture agreeing with itself.
  const host = () => `127.0.0.1:${String(address.port)}`;

  type Session = { cookie: string; csrf: string; reviewerId: string };

  async function pairSession(): Promise<Session> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const issued = JSON.parse(paired.text) as { csrfToken?: string; reviewerId?: string; data?: { csrfToken?: string; reviewerId?: string } };
    const cookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const current = await call("GET", `${API_PREFIX}/session`, { headers: { host: host(), cookie } });
    const view = JSON.parse(current.text) as { reviewerId?: string; data?: { reviewerId?: string } };
    return {
      cookie,
      csrf: issued.data?.csrfToken ?? issued.csrfToken ?? "",
      // Read back over HTTP rather than assumed: this is the id the route must store, and the
      // test only means something if it is the one the session actually holds.
      reviewerId: view.data?.reviewerId ?? issued.reviewerId ?? "",
    };
  }

  async function freshProject(session: Session, name: string): Promise<Id> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `review-route-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return asId((body.data?.id ?? body.id) as string);
  }

  function post(session: Session, pathname: string, payload: Record<string, JsonValue>, withCsrf = true) {
    const headers: Record<string, string> = {
      host: host(),
      origin: `http://${host()}`,
      cookie: session.cookie,
      "content-type": "application/json",
    };
    if (withCsrf) headers["x-csrf-token"] = session.csrf;
    return call("POST", pathname, { body: JSON.stringify(payload), headers });
  }

  async function chain(name: string): Promise<{ session: Session; projectId: Id; seeded: Awaited<ReturnType<typeof seedReviewChain>> }> {
    const session = await pairSession();
    const projectId = await freshProject(session, name);
    const seeded = await seedReviewChain({ writer: worker.writeConnection, store: new ArtifactStore(dataDir), projectId, name });
    const project = worker.writeConnection.transact((tx) => tx.getProject(projectId));
    if (!project.ok || project.value === null) throw new Error("project missing after seeding");
    return { session, projectId, seeded };
  }

  function rejectedKeys(text: string): string[] {
    const body = JSON.parse(text) as { error: { details: { rejectedKeys?: string[] } } };
    return body.error.details.rejectedKeys ?? [];
  }

  function inventoryRevision(projectId: Id): number {
    const project = worker.writeConnection.transact((tx) => tx.getProject(projectId));
    if (!project.ok || project.value === null) throw new Error("project missing");
    return project.value.inventoryRevision;
  }

  it("keeps all three doors shut without a session and without the CSRF header", async () => {
    const id = newId();
    for (const pathname of [
      `${API_PREFIX}/projects/${id}/vectors/${id}/review`,
      `${API_PREFIX}/projects/${id}/contracts/${id}/review`,
      `${API_PREFIX}/projects/${id}/verification-plans/${id}/review`,
    ]) {
      // The three doors, in the order the pipeline meets them: §14's same-origin check, then the
      // session cookie, then the CSRF token the session carries. Each one is refused for the thing
      // that is missing rather than the next one, so a page can tell which it has to fix.
      const foreign = await call("POST", pathname, { body: "{}", headers: { host: host(), origin: "http://elsewhere.invalid", "content-type": "application/json" } });
      expect(foreign.status, `${pathname}: ${foreign.text}`).toBe(403);
      expect(foreign.text).toContain("origin-not-same-source");
      const anonymous = await call("POST", pathname, { body: "{}", headers: { host: host(), origin: `http://${host()}`, "content-type": "application/json" } });
      expect(anonymous.status, `${pathname}: ${anonymous.text}`).toBe(401);
      expect(anonymous.text).toContain("cookie-absent");
    }
    const seeded = await chain("review-csrf");
    const bare = await post(seeded.session, `${API_PREFIX}/projects/${String(seeded.projectId)}/contracts/${String(seeded.seeded.contractId)}/review`, { decision: "rejected", expectedDigest: null }, false);
    expect(bare.status, bare.text).toBe(403);
    expect(bare.text).toContain("csrf");
  });

  it("stores the session's reviewer and refuses a body that names someone else", async () => {
    const seeded = await chain("review-who");
    const projectId = String(seeded.projectId);
    const spoofed = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/vectors/${String(seeded.seeded.vectorId)}/review`, {
      decision: "approved",
      expectedDigest: seeded.seeded.vectorDigest,
      expectedInventoryRevision: inventoryRevision(seeded.projectId),
      // The name the service would store, sent by a caller that would rather it were another.
      reviewerId: "someone-else",
    });
    expect(spoofed.status, spoofed.text).toBe(400);
    expect(rejectedKeys(spoofed.text)).toContain("reviewerId");
    expect(spoofed.text).not.toContain("someone-else");

    const approved = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/vectors/${String(seeded.seeded.vectorId)}/review`, {
      decision: "approved",
      expectedDigest: seeded.seeded.vectorDigest,
      expectedInventoryRevision: inventoryRevision(seeded.projectId),
    });
    expect(approved.status, approved.text).toBe(200);

    const read = await call("GET", `${API_PREFIX}/projects/${projectId}/vectors/${String(seeded.seeded.vectorId)}`, { headers: { host: host(), cookie: seeded.session.cookie } });
    const view = JSON.parse(read.text) as { review?: { reviewerId?: string; status?: string; approvedDigest?: string } };
    expect(view.review?.reviewerId, read.text).toBe(seeded.session.reviewerId);
    // Two durable places record who decided, so the identity is pinned from both: the review
    // record the freeze cites, and §12.2's journal.
    const journal = await call("GET", `${API_PREFIX}/projects/${projectId}/audit?limit=50`, { headers: { host: host(), cookie: seeded.session.cookie } });
    const page = JSON.parse(journal.text) as { data?: { entries?: { action: string; actorId: string; decision: string }[] }; entries?: { action: string; actorId: string; decision: string }[] };
    const entries = page.data?.entries ?? page.entries ?? [];
    const reviews = entries.filter((entry) => entry.action === "vector.review" && entry.decision === "allow");
    expect(reviews.map((entry) => entry.actorId), journal.text).toEqual([seeded.session.reviewerId]);
    // The two have to agree with each other, not only with the session: a route that wrote a
    // different name into the review record than the one the journal credits would otherwise
    // still pass one of the two checks.
    expect(view.review?.reviewerId, read.text).toBe(reviews[0]?.actorId);
    expect(view.review?.status).toBe("approved");
    expect(view.review?.approvedDigest).toBe(seeded.seeded.vectorDigest);
  });

  it("refuses §8's `note` instead of pretending to have kept it", async () => {
    const seeded = await chain("review-note");
    const withNote = await post(seeded.session, `${API_PREFIX}/projects/${String(seeded.projectId)}/contracts/${String(seeded.seeded.contractId)}/review`, {
      decision: "rejected",
      expectedDigest: null,
      note: "why the reviewer said no",
    });
    // Nothing in the storage model or §12.2's journal has a field for it, so the route says so
    // rather than accepting a reason that would vanish.
    expect(withNote.status, withNote.text).toBe(400);
    expect(rejectedKeys(withNote.text)).toContain("note");
    expect(withNote.text).not.toContain("why the reviewer said no");
  });

  it("walks the chain over HTTP: sample, then contract, then plan", async () => {
    const seeded = await chain("review-chain");
    const projectId = String(seeded.projectId);

    const vector = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/vectors/${String(seeded.seeded.vectorId)}/review`, {
      decision: "approved",
      expectedDigest: seeded.seeded.vectorDigest,
      expectedInventoryRevision: inventoryRevision(seeded.projectId),
    });
    expect(vector.status, vector.text).toBe(200);
    const vectorReceipt = vectorReviewReceiptSchema.safeParse(JSON.parse(vector.text) as JsonValue);
    if (!vectorReceipt.success) throw new Error(vector.text);
    expect(vectorReceipt.data.eligibility).toBe("usable");
    // The approval is what moved the inventory, and the receipt reports the revision after it.
    expect(vectorReceipt.data.inventoryRevision).toBe(inventoryRevision(seeded.projectId));

    const contract = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/contracts/${String(seeded.seeded.contractId)}/review`, {
      decision: "approved",
      expectedDigest: seeded.seeded.contractDigest,
    });
    expect(contract.status, contract.text).toBe(200);
    const contractReceipt = contractReviewReceiptSchema.safeParse(JSON.parse(contract.text) as JsonValue);
    if (!contractReceipt.success) throw new Error(contract.text);
    expect(contractReceipt.data.contractId).toBe(String(seeded.seeded.contractId));
    expect(contractReceipt.data.reviewStatus).toBe("approved");

    const plan = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/verification-plans/${String(seeded.seeded.planId)}/review`, {
      decision: "approved",
      expectedDigest: seeded.seeded.planDigest,
      expectedInventoryRevision: inventoryRevision(seeded.projectId),
    });
    expect(plan.status, plan.text).toBe(200);
    const planReceipt = planReviewReceiptSchema.safeParse(JSON.parse(plan.text) as JsonValue);
    if (!planReceipt.success) throw new Error(plan.text);
    expect(planReceipt.data.selectedCount).toBe(1);
    expect(planReceipt.data.reviewStatus).toBe("approved");
  });

  it("answers a stale digest and a moved inventory with a conflict, and stores neither", async () => {
    const seeded = await chain("review-conflict");
    const projectId = String(seeded.projectId);

    const wrongDigest = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/contracts/${String(seeded.seeded.contractId)}/review`, {
      decision: "approved",
      expectedDigest: asDigest(hex("a-digest-nobody-recorded")),
    });
    expect(wrongDigest.status, wrongDigest.text).toBe(409);
    expect(wrongDigest.text).toContain("approved-digest-mismatch");

    const staleRevision = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/vectors/${String(seeded.seeded.vectorId)}/review`, {
      decision: "approved",
      expectedDigest: seeded.seeded.vectorDigest,
      expectedInventoryRevision: inventoryRevision(seeded.projectId) + 5,
    });
    expect(staleRevision.status, staleRevision.text).toBe(409);
    // The numbers the refusal named now reach the caller (issue #59): both sides of the
    // disagreement, read out of the body rather than out of a log.
    const body = JSON.parse(staleRevision.text) as { error: { details: Record<string, unknown> } };
    expect(body.error.details["expected"]).toBe(inventoryRevision(seeded.projectId) + 5);
    expect(body.error.details["actual"]).toBe(inventoryRevision(seeded.projectId));

    // A refused review changes nothing, so the good one still fits the revision it was prepared
    // against.
    const good = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/vectors/${String(seeded.seeded.vectorId)}/review`, {
      decision: "approved",
      expectedDigest: seeded.seeded.vectorDigest,
      expectedInventoryRevision: inventoryRevision(seeded.projectId),
    });
    expect(good.status, good.text).toBe(200);

    const twice = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/contracts/${String(seeded.seeded.contractId)}/review`, {
      decision: "approved",
      expectedDigest: seeded.seeded.contractDigest,
    });
    expect(twice.status, twice.text).toBe(200);
    const replay = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/contracts/${String(seeded.seeded.contractId)}/review`, {
      decision: "rejected",
      expectedDigest: null,
    });
    expect(replay.status, replay.text).toBe(409);
    expect(replay.text).toContain("contract-already-reviewed");
  });

  it("names which path segment was not an id, without echoing what was sent", async () => {
    const seeded = await chain("review-segments");
    const projectId = String(seeded.projectId);
    for (const [pathname, reason] of [
      [`${API_PREFIX}/projects/${projectId}/vectors/not-a-uuid/review`, "vector-id-malformed"],
      [`${API_PREFIX}/projects/${projectId}/contracts/not-a-uuid/review`, "contract-id-malformed"],
      [`${API_PREFIX}/projects/${projectId}/verification-plans/not-a-uuid/review`, "plan-id-malformed"],
    ] as const) {
      const refused = await post(seeded.session, pathname, { decision: "rejected", expectedDigest: null, expectedInventoryRevision: 0 });
      expect(refused.status, refused.text).toBe(400);
      expect(refused.text).toContain(reason);
      expect(refused.text).not.toContain("not-a-uuid");
    }
  });
});

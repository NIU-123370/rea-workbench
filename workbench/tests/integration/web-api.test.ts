import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { request as rawRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootWorker, type WorkerHandle } from "../../apps/worker/composition.ts";
import { startWorkerRpc, type RpcServer } from "../../apps/worker/rpc-server.ts";
import { createWorkerClient } from "../../apps/web/worker-client.ts";
import { createApiHandler, API_PREFIX } from "../../apps/web/api.ts";
import { runWebProcess } from "../../apps/web/main.ts";
import { startWebServer, type WebServer } from "../../apps/web/server.ts";
import { AccessLog } from "../../apps/web/access-log.ts";
import { graphViewSchema } from "../../packages/contracts/graph.ts";
import { IdempotencyJournal } from "../../packages/application/idempotency.ts";
import type { ListenAddress } from "../../packages/application/session.ts";
import { SESSION_COOKIE_NAME } from "../../packages/application/session.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import { asDigest } from "../../packages/domain/canonical-json.ts";
import { hex } from "../support/blueprint-seed.ts";

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

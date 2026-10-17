import { chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
import { createApiHandler, API_PREFIX, MAX_UPLOAD_FILE_BYTES } from "../../apps/web/api.ts";
import { runWebProcess } from "../../apps/web/main.ts";
import { startWebServer, type WebServer } from "../../apps/web/server.ts";
// The page's own draft builders, driven from real replies: a test of the door alone cannot show that
// what this UI would send is something the door accepts, and a unit test of the builders alone cannot
// show that the three reads they consume say what the page assumes they say.
import { approvedContractIds, CAPTURE_TARGET_NOT_URL_LINE, captureDraftOf, captureProfileOptionsOf, inspectDraftOf, inspectSubjectOf, inspectTargetReadOf, INSPECT_TARGET_URL_LINE, journalEntriesOf, NO_SESSION_LINE, planBuildLine, planDraftOf, relayData, samplesPageOf, targetDraftOf, targetReceiptLine } from "../../apps/web/ui/view-model.ts";
import { AccessLog } from "../../apps/web/access-log.ts";
import { graphViewSchema } from "../../packages/contracts/graph.ts";
import { evidenceViewSchema, projectPageSchema, projectViewSchema } from "../../packages/contracts/resources.ts";
import { AUDIT_LIST_MAX_LIMIT, auditPageSchema } from "../../packages/contracts/audit.ts";
import { vectorCommitReceiptSchema, vectorPageSchema } from "../../packages/contracts/vectors.ts";
import { contractCommitReceiptSchema, contractRevisionSchema, planCommitReceiptSchema } from "../../packages/contracts/behaviors.ts";
import { targetCreatedSchema, targetViewSchema } from "../../packages/contracts/resources.ts";
import { comparatorPolicyReadSchema, INSTALLED_COMPARATOR_POLICIES, verificationReportSchema } from "../../packages/contracts/verification.ts";
import { blueprintFreezeReceiptSchema, blueprintReadSchema } from "../../packages/contracts/blueprint.ts";
import { cleanupRetryReceiptSchema, JOB_LIST_MAX_LIMIT, jobPageSchema, jobRecordSchema } from "../../packages/contracts/jobs.ts";
import { harImportHttpResponseSchema } from "../../packages/contracts/imports.ts";
import { IdempotencyJournal, MAX_IDEMPOTENCY_KEY_LENGTH } from "../../packages/application/idempotency.ts";
import type { ListenAddress } from "../../packages/application/session.ts";
import { SESSION_COOKIE_NAME } from "../../packages/application/session.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { asId, asInstant, newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import { asDigest, digestBytes } from "../../packages/domain/canonical-json.ts";
import { hex } from "../support/blueprint-seed.ts";
import { seedReviewChain } from "../support/review-chain.ts";
import { seedVerifiedScenario } from "../support/verification-seed.ts";

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

// The rig's installed profile, written in the shape `profileSchema` actually parses (§14). What this
// fixture used to write named `image`, `network`, `hostMounts` and a `wallClockMs` - keys the contract
// has never had - so the registry read the file, refused it, and every profile-dependent number in
// this suite resolved to "no profile". Nothing here asked, because every door that needs a number was
// refused for a different reason first. The job door (§8 line 275) does ask: a capture's deadline
// comes from the installed profile's queue wait, so a rig whose profile never parsed could only ever
// test the refusal.
const PROFILE = {
  id: "har-capture",
  schemaVersion: 1,
  reaPackageDigest: "a".repeat(64),
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
    maxGenerationAttempts: 1,
  },
  networkPolicyId: "deny-egress",
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
    // The upload door needs the worker's ingestion service, and that service is only built once a
    // provider session exists (`ingestionService` -> `providerSession`). This is the recorded-shape
    // MCP fixture rather than a real provider: it makes the *transport and projection* under test
    // real, and it says nothing about REA itself (issue #14's fixture/real split still stands).
    WB_REA_ENTRYPOINT: path.join(ROOT, "tests", "fixtures", "rea-mcp-fixture.mjs"),
    WB_MODEL_ENDPOINT: "",
    WB_SANDBOX_PROFILE: "har-capture",
    WB_BROKER_SOCKET: brokerSocket,
  };
}

async function call(method: string, target: string, init: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}${target}`, {
    method,
    headers: (init.headers as Record<string, string>) ?? {},
    // `BodyInit` rather than a string, because one route takes a file: a FormData body is what the
    // browser sends, and hand-writing the boundary would test my own parser's guesswork instead of
    // the platform's multipart encoder meeting the platform's multipart decoder.
    ...(init.body === undefined ? {} : { body: init.body as string | FormData }),
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
    // The query name alone ends the request now (§14's ban on a token in a URL is enforced at the edge
    // as "this route takes no query", which refuses before the body is read at all). The body's own
    // bogus code still gets its 401 further down, and neither path may spend the live code or print it.
    expect(refused.status).toBe(400);
    expect(refused.text).toContain("query-not-accepted");
    expect(refused.text).not.toContain(live.token);
    const bodyOnly = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: "deadbeef-no-such-code" }),
      headers: { host: `127.0.0.1:${String(address.port)}`, origin: `http://127.0.0.1:${String(address.port)}` },
    });
    expect(bodyOnly.status).toBe(401);
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
    // Reading this body to its end is no longer what a stream does (§13, issue #85): the backlog is
    // followed by an open tail, so the chunks are collected until both committed events have arrived
    // and then the caller closes the connection itself.
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("the stream carried no body");
    const decoder = new TextDecoder();
    let text = "";
    let ended = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const got = await Promise.race([reader.read(), new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 500))]);
      if (got === "idle") continue;
      if (got.done === true) {
        ended = true;
        break;
      }
      text += decoder.decode(got.value, { stream: true });
      if (text.includes("id: 1\n") && text.includes("id: 2\n")) break;
    }
    expect(text).toContain("id: ");
    expect(text).toContain("event: job.updated");
    // The first bytes on any stream are the comment that flushes the head through the UI relay, and
    // it carries no event name: a client must be able to ignore it.
    expect(text.startsWith(": stream-open\n\n")).toBe(true);
    const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);
    // The tail: after the backlog, an empty poll is silence rather than an end of body. Before the
    // loop in `event-stream.ts` this is where every idle subscriber was closed.
    expect(ended, "the stream ended while it should have kept tailing").toBe(false);
    const idle = await Promise.race([reader.read(), new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 600))]);
    expect(idle).toBe("idle");
    await reader.cancel();
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

  // §13's stream is what changed how this process stops (issue #85's blast radius): a response whose
  // lifetime the client decides is not an idle keep-alive socket, so `server.close()` waited for a
  // browser tab that had no reason to close - the old process printed nothing and stayed. A stop has
  // to end the responses it opened.
  it("ends a live stream when the process is stopped, instead of waiting for the client", async () => {
    const port = await freePort();
    const run = await runWebProcess({ env: webEnv(port), nodeVersion: "24.18.0", log: () => undefined, pollMs: 5 });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const origin = `http://127.0.0.1:${String(port)}`;
    const code = worker.mintPairingCode();
    const paired = await fetch(`${origin}${API_PREFIX}/session`, {
      method: "POST",
      headers: { host: `127.0.0.1:${String(port)}`, origin, "content-type": "application/json" },
      body: JSON.stringify({ bootstrapToken: code.token }),
    });
    expect(paired.status).toBe(201);
    const cookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const pairedBody = JSON.parse(await paired.text()) as Record<string, JsonValue>;
    const csrf = ((pairedBody["data"] ?? pairedBody) as Record<string, string>)["csrfToken"] ?? "";
    const created = await fetch(`${origin}${API_PREFIX}/projects`, {
      method: "POST",
      headers: { host: `127.0.0.1:${String(port)}`, origin, cookie, "x-csrf-token": csrf, "idempotency-key": "stop-with-stream", "content-type": "application/json" },
      body: JSON.stringify({ name: "stop-with-stream" }),
    });
    expect(created.status).toBe(201);
    const project = JSON.parse(await created.text()) as { id?: string; data?: { id: string } };
    const projectId = project.data?.id ?? project.id ?? "";

    const stream = await fetch(`${origin}${API_PREFIX}/projects/${projectId}/events`, {
      headers: { host: `127.0.0.1:${String(port)}`, cookie, accept: "text/event-stream" },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("the stream carried no body");
    // Read the preamble so the tail is genuinely open, then leave the connection exactly as a
    // subscribed page leaves it: held.
    const stalled = new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 2000));
    const opened = await Promise.race([reader.read(), stalled]);
    expect(opened === "stalled" ? "no head" : "head").toBe("head");

    const pending = reader.read();
    const startedAt = Date.now();
    await run.close();
    const stopMs = Date.now() - startedAt;
    expect(stopMs, `the stop waited ${String(stopMs)}ms for the client`).toBeLessThan(2000);
    // A fresh deadline: a race against a timer that already fired would report a stall no client hit.
    const stillOpen = new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 2000));
    const got = await Promise.race([pending, stillOpen]);
    expect(got === "stalled" ? "the client's stream stayed open after the stop" : "ended").toBe("ended");
    if (got === "stalled") return;
    // The body ends with the process that opened it, and the client is told so rather than left
    // holding a socket: `done`, not a refusal and not a truncation it cannot see.
    expect(got.done).toBe(true);
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

  it("mounts exactly the nine documented reads and refuses each one unpaired", async () => {
    const id = newId();
    for (const pathname of [
      `${API_PREFIX}/projects/${id}`,
      `${API_PREFIX}/projects/${id}/jobs/${id}`,
      `${API_PREFIX}/projects/${id}/evidence/${"ev_" + "1".repeat(64)}`,
      `${API_PREFIX}/projects/${id}/vectors/${id}`,
      `${API_PREFIX}/projects/${id}/verification-plans/${id}`,
      `${API_PREFIX}/projects/${id}/contracts/${id}`,
      `${API_PREFIX}/projects/${id}/verifications/${id}`,
      `${API_PREFIX}/projects/${id}/blueprints/${id}`,
      `${API_PREFIX}/projects/${id}/targets/${id}`,
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
    const vectorReceipt = vectorCommitReceiptSchema.safeParse(JSON.parse(vector.text) as JsonValue);
    if (!vectorReceipt.success) throw new Error(vector.text);
    expect(vectorReceipt.data.eligibility).toBe("usable");
    // The approval is what moved the inventory, and the receipt reports the revision after it.
    expect(vectorReceipt.data.inventoryRevision).toBe(inventoryRevision(seeded.projectId));

    const contract = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/contracts/${String(seeded.seeded.contractId)}/review`, {
      decision: "approved",
      expectedDigest: seeded.seeded.contractDigest,
    });
    expect(contract.status, contract.text).toBe(200);
    const contractReceipt = contractCommitReceiptSchema.safeParse(JSON.parse(contract.text) as JsonValue);
    if (!contractReceipt.success) throw new Error(contract.text);
    expect(contractReceipt.data.contractId).toBe(String(seeded.seeded.contractId));
    expect(contractReceipt.data.reviewStatus).toBe("approved");

    const plan = await post(seeded.session, `${API_PREFIX}/projects/${projectId}/verification-plans/${String(seeded.seeded.planId)}/review`, {
      decision: "approved",
      expectedDigest: seeded.seeded.planDigest,
      expectedInventoryRevision: inventoryRevision(seeded.projectId),
    });
    expect(plan.status, plan.text).toBe(200);
    const planReceipt = planCommitReceiptSchema.safeParse(JSON.parse(plan.text) as JsonValue);
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

describe("the freeze route (§8 line 292 / issue #58)", () => {
  // The last step of the chain the three review doors opened: an approved plan becomes the
  // blueprint the Builder may be handed. This route is a creation, so §8 line 261 gives it an
  // Idempotency-Key, and the tests below are mostly about what that key must NOT do - replay a
  // refusal as if it were a result, or let a second body reuse a committed freeze.
  const host = () => `127.0.0.1:${String(address.port)}`;
  type Session = { cookie: string; csrf: string; reviewerId: string };

  async function pairSession(): Promise<Session> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const issued = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    const cookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const current = await call("GET", `${API_PREFIX}/session`, { headers: { host: host(), cookie } });
    const view = JSON.parse(current.text) as { reviewerId?: string; data?: { reviewerId?: string } };
    return { cookie, csrf: issued.data?.csrfToken ?? issued.csrfToken ?? "", reviewerId: view.data?.reviewerId ?? "" };
  }

  async function freshProject(session: Session, name: string): Promise<Id> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `freeze-project-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return asId((body.data?.id ?? body.id) as string);
  }

  type FreezeSession = Session & { projectId: Id };

  function send(session: FreezeSession, payload: Record<string, JsonValue>, key: string | null) {
    const headers: Record<string, string> = {
      host: host(),
      origin: `http://${host()}`,
      cookie: session.cookie,
      "content-type": "application/json",
      "x-csrf-token": session.csrf,
    };
    if (key !== null) headers["idempotency-key"] = key;
    return call("POST", `${API_PREFIX}/projects/${session.projectId}/blueprints`, { body: JSON.stringify(payload), headers });
  }

  async function chain(name: string, approve: boolean): Promise<{ session: FreezeSession; seeded: Awaited<ReturnType<typeof seedReviewChain> > }> {
    const paired = await pairSession();
    const projectId = await freshProject(paired, name);
    const session: FreezeSession = { ...paired, projectId };
    const seeded = await seedReviewChain({ writer: worker.writeConnection, store: new ArtifactStore(dataDir), projectId, name });
    if (approve) {
      // The inventory revision is re-read before each inventory-bound step: approving the sample
      // moves the inventory, so the plan review has to name the one it was prepared against. The
      // 409 this fixture used to hit is now legible because both sides of it ride the wire
      // (issue #59).
      const live = () => {
        const project = worker.writeConnection.transact((tx) => tx.getProject(projectId));
        if (!project.ok || project.value === null) throw new Error("project missing");
        return project.value.inventoryRevision;
      };
      const steps: readonly (readonly [string, () => Record<string, JsonValue>])[] = [
        [`vectors/${String(seeded.vectorId)}/review`, () => ({ decision: "approved", expectedDigest: seeded.vectorDigest, expectedInventoryRevision: live() })],
        [`contracts/${String(seeded.contractId)}/review`, () => ({ decision: "approved", expectedDigest: seeded.contractDigest })],
        [`verification-plans/${String(seeded.planId)}/review`, () => ({ decision: "approved", expectedDigest: seeded.planDigest, expectedInventoryRevision: live() })],
      ];
      for (const [path, build] of steps) {
        const step = await call("POST", `${API_PREFIX}/projects/${String(projectId)}/${path}`, {
          body: JSON.stringify(build()),
          headers: { host: host(), origin: `http://${host()}`, cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" },
        });
        expect(step.status, `${path}: ${step.text}`).toBe(200);
      }
    }
    return { session, seeded };
  }

  it("freezes an approved chain and gives the counts the gate proved", async () => {
    const { session, seeded } = await chain("freeze-ok", true);
    const frozen = await send(session, { verificationPlanId: String(seeded.planId) }, "freeze-key-1");
    expect(frozen.status, frozen.text).toBe(201);
    const receipt = blueprintFreezeReceiptSchema.safeParse(JSON.parse(frozen.text) as JsonValue);
    if (!receipt.success) throw new Error(frozen.text);
    expect(receipt.data.planId).toBe(String(seeded.planId));
    // The freeze is where §7.4's denominator becomes visible: one public sample, no holdout, and
    // the one contract this plan binds. A receipt that reported zero here would still be a 201.
    expect(receipt.data.publicVectorCount).toBe(1);
    expect(receipt.data.holdoutVectorCount).toBe(0);
    expect(receipt.data.contractCount).toBe(1);
    expect(receipt.data.digest).not.toBe(receipt.data.manifestDigest);

    // Same key, same body: the original 201 field for field, with a fresh request id of its own,
    // and the worker is not asked a second time (the blueprint would be a second row).
    const again = await send(session, { verificationPlanId: String(seeded.planId) }, "freeze-key-1");
    expect(again.status, again.text).toBe(201);
    expect(JSON.parse(again.text)).toEqual(JSON.parse(frozen.text));
    // The id is a response header on a success (§8's ApiError carries it in the body only for a
    // failure), so the replay's freshness is read from there.
    const replayedId = again.headers.get("x-request-id") ?? "";
    const originalId = frozen.headers.get("x-request-id") ?? "";
    expect(replayedId).not.toBe("");
    expect(replayedId).not.toBe(originalId);

    // The journal is the independent count: a replay that reached the worker a second time would
    // leave a second allow row for the same action. (My first version of this assertion asked the
    // writer for a method it does not have and passed on `undefined ?? null` - a vacuous green,
    // which is why it is replaced by a count over a surface that exists.)
    const journal = await call("GET", `${API_PREFIX}/projects/${String(session.projectId)}/audit?limit=50`, { headers: { host: host(), cookie: session.cookie } });
    const page = JSON.parse(journal.text) as { data?: { entries?: { action: string; decision: string }[] }; entries?: { action: string; decision: string }[] };
    const entries = page.data?.entries ?? page.entries ?? [];
    expect(entries.filter((entry) => entry.action === "blueprint.freeze" && entry.decision === "allow")).toHaveLength(1);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("refuses a caller that restates what the plan already derives", async () => {
    const { session, seeded } = await chain("freeze-derive", true);
    const overreaching = await send(session, {
      verificationPlanId: String(seeded.planId),
      // §8 line 292 names all four; §7.4 makes the first three functions of the approved plan and
      // the sensitive list belongs to the capture, not to a freeze.
      targetId: String(seeded.targetId),
      contractRevisionIds: [String(seeded.contractId)],
      expectedGraphRevision: 0,
      sensitiveValues: ["hunter2"],
    }, "freeze-key-2");
    expect(overreaching.status, overreaching.text).toBe(400);
    const keys = ((JSON.parse(overreaching.text) as { error: { details: { rejectedKeys?: string[] } } }).error.details.rejectedKeys ?? []).sort();
    expect(keys).toEqual(["contractRevisionIds", "expectedGraphRevision", "sensitiveValues", "targetId"]);
    // The declared sensitive value is a *value*, and §12.1 keeps it out of the echo.
    expect(overreaching.text).not.toContain("hunter2");
  });

  it("keeps the key honest: required, and not reusable for a different request", async () => {
    const { session, seeded } = await chain("freeze-key", true);
    const missing = await send(session, { verificationPlanId: String(seeded.planId) }, null);
    expect(missing.status, missing.text).toBe(400);
    expect(missing.text).toContain("idempotency-key-required");

    const committed = await send(session, { verificationPlanId: String(seeded.planId) }, "freeze-key-3");
    expect(committed.status, committed.text).toBe(201);
    const divergent = await send(session, { verificationPlanId: String(newId()) }, "freeze-key-3");
    expect(divergent.status, divergent.text).toBe(409);
    expect(divergent.text).toContain("idempotency-key-reused");
  });

  it("a plan nobody approved does not become a blueprint, and the refusal counts its reasons", async () => {
    const { session, seeded } = await chain("freeze-blocked", false);
    const blocked = await send(session, { verificationPlanId: String(seeded.planId) }, "freeze-key-4");
    expect(blocked.status, blocked.text).toBe(422);
    const body = JSON.parse(blocked.text) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe("BLUEPRINT_BLOCKED");
    // Issue #59 in the wild: the count of blocking reasons crosses the socket, the list of them
    // does not, and the reason that names the gate is the one the service put first.
    expect(body.error.details["reasonCount"]).toBe(1);
    expect(body.error.details["reason"]).toBe("plan-not-approved");
    expect(JSON.stringify(body.error.details)).not.toContain("contract-not-approved");
  });

  function declareTarget(session: FreezeSession, body: Record<string, JsonValue>) {
    return call("POST", `${API_PREFIX}/projects/${String(session.projectId)}/targets`, {
      body: JSON.stringify(body),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "content-type": "application/json",
        "x-csrf-token": session.csrf,
      },
    });
  }

  it("declares a URL target and reads its unknown identity back (§8 lines 273-274)", async () => {
    const paired = await pairSession();
    const projectId = await freshProject(paired, "door-target");
    const session: FreezeSession = { ...paired, projectId };
    const path = `${API_PREFIX}/projects/${String(projectId)}/targets`;
    const created = await declareTarget(session, { kind: "url", url: "https://shop.example/cart" });
    expect(created.status, created.text).toBe(201);
    const declared = targetCreatedSchema.safeParse(JSON.parse(created.text) as JsonValue);
    if (!declared.success) throw new Error(created.text);
    expect(declared.data.kind).toBe("url");
    expect(declared.data.snapshotDigest).toBeNull();
    expect(declared.data.identityReason).toBe("url-declared-not-captured");
    expect(declared.data.auditSeq).toBeGreaterThan(0);

    const read = await call("GET", `${path}/${declared.data.id}`, { headers: { host: host(), cookie: session.cookie } });
    expect(read.status, read.text).toBe(200);
    const view = targetViewSchema.safeParse(JSON.parse(read.text) as JsonValue);
    if (!view.success) throw new Error(read.text);
    // Nothing has been captured, so every identity column stays null and both lists are empty -
    // and the reason string is what says "declared", not "the capture could not identify it".
    expect(view.data.sourceSha256).toBeNull();
    expect(view.data.evidenceIds).toEqual([]);
    expect(view.data.importJobId).toBeNull();
    // §5: the stored locator does not come back out through this surface.
    expect(JSON.stringify(view.data)).not.toContain("shop.example");

    const journal = await call("GET", `${API_PREFIX}/projects/${String(projectId)}/audit?limit=20`, { headers: { host: host(), cookie: session.cookie } });
    const journalBody = JSON.parse(journal.text) as { entries?: { action: string }[]; data?: { entries?: { action: string }[] } };
    const actions = ((journalBody.data?.entries ?? journalBody.entries) ?? []).map((entry) => entry.action);
    expect(actions).toContain("target.create");

    // A retried declaration makes a second row. §8 line 261 does not name targets among the
    // creations that carry an Idempotency-Key, so this door honours the document literally and
    // records the replay question as a deviation on issue #58 rather than inventing a key.
    const again = await declareTarget(session, { kind: "url", url: "https://shop.example/cart" });
    expect(again.status, again.text).toBe(201);
    const againBody = JSON.parse(again.text) as { id?: string; data?: { id: string } };
    expect((againBody.data?.id ?? againBody.id) as string).not.toBe(declared.data.id);
  });

  it("refuses each target declaration with the reason that explains it", async () => {
    const paired = await pairSession();
    const projectId = await freshProject(paired, "door-target-refused");
    const session: FreezeSession = { ...paired, projectId };
    const path = `${API_PREFIX}/projects/${String(projectId)}/targets`;
    const detailsOf = async (body: Record<string, JsonValue>) => {
      const response = await declareTarget(session, body);
      expect(response.status, response.text).toBe(400);
      return (JSON.parse(response.text) as { error: { details: { reason?: string; fields?: string[] } } }).error.details;
    };
    // A file target comes from the import that brought the file; the door says that instead of
    // answering "bad value in field kind".
    expect((await detailsOf({ kind: "har", url: "https://shop.example/cart" })).reason).toBe("target-kind-needs-import");
    expect((await detailsOf({ kind: "url", url: "https://user:token@shop.example/cart" })).reason).toBe("url-credentials-forbidden");
    expect((await detailsOf({ kind: "url", url: "file:///etc/passwd" })).reason).toBe("url-scheme-not-http:file");
    expect((await detailsOf({ kind: "url", url: "https://shop.example/x#access_token=1" })).reason).toBe("url-fragment-forbidden");
    expect((await detailsOf({ kind: "url" })).fields).toContain("url");

    const malformed = await call("GET", `${path}/not-an-id`, { headers: { host: host(), cookie: session.cookie } });
    expect(malformed.status, malformed.text).toBe(400);
    expect((JSON.parse(malformed.text) as { error: { details: { reason: string } } }).error.details.reason).toBe("target-id-malformed");
    const unknown = await call("GET", `${path}/${String(newId())}`, { headers: { host: host(), cookie: session.cookie } });
    expect(unknown.status, unknown.text).toBe(404);
    expect((JSON.parse(unknown.text) as { error: { details: { reason: string } } }).error.details.reason).toBe("target-unknown");

    // The POST gate order, on this door: no cookie is 401, and a session without its CSRF header
    // is 403 rather than a row.
    const anonymous = await call("POST", path, {
      body: JSON.stringify({ kind: "url", url: "https://shop.example/cart" }),
      headers: { host: host(), origin: `http://${host()}`, "content-type": "application/json" },
    });
    expect(anonymous.status, anonymous.text).toBe(401);
    expect(anonymous.text).toContain("cookie-absent");
    const noCsrf = await call("POST", path, {
      body: JSON.stringify({ kind: "url", url: "https://shop.example/cart" }),
      headers: { host: host(), origin: `http://${host()}`, cookie: session.cookie, "content-type": "application/json" },
    });
    expect(noCsrf.status, noCsrf.text).toBe(403);
    expect(noCsrf.text).toContain("csrf-token-missing");
  });

  // The same reconciliation the other doors get: the page's own builder, fed from what the page can
  // actually read (a csrf token from its own session and a typed address), must produce the body this
  // door takes - and where the page refuses, the reason it prints has to be the *door's* reason name,
  // not a second rule that happens to agree today. `urlLocatorDefects` is the shared owner.
  it("accepts the body the declare control builds, and refuses the same defects the page names", async () => {
    const paired = await pairSession();
    const projectId = await freshProject(paired, "door-target-page-draft");
    const session: FreezeSession = { ...paired, projectId };

    const drafted = targetDraftOf({ csrf: session.csrf, url: "  https://shop.example/cart  " });
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    // Two keys, and the trimmed address: §8 line 273's body names `kind` and `url` and nothing else,
    // so a third field would be this page inventing an input the door cannot store.
    expect(Object.keys(drafted.body).sort()).toEqual(["kind", "url"]);
    expect(drafted.body).toEqual({ kind: "url", url: "https://shop.example/cart" });

    const created = await declareTarget(session, drafted.body as unknown as Record<string, JsonValue>);
    expect(created.status, created.text).toBe(201);
    const receipt = targetCreatedSchema.safeParse(JSON.parse(created.text) as JsonValue);
    if (!receipt.success) throw new Error(created.text);
    const line = targetReceiptLine(relayData(JSON.parse(created.text) as JsonValue));
    expect(line).toContain(receipt.data.id);
    expect(line).toContain("身份未知");
    expect(line).toContain("url-declared-not-captured");
    expect(line).toContain(`日志 seq ${String(receipt.data.auditSeq)}`);
    // The sentence must not promise a snapshot: §8 line 273 says a declared URL's identity is unknown
    // until a capture runs, and a receipt that read like "已就绪" would be the page claiming an
    // observation nobody made.
    expect(line).not.toContain("undefined");

    // Each address the page would refuse, asked of the door instead: the name in the page's sentence and
    // the name in the door's refusal are one vocabulary.
    for (const url of ["https://user:token@shop.example/cart", "file:///etc/passwd", "https://shop.example/x#access_token=1"]) {
      const page = targetDraftOf({ csrf: session.csrf, url });
      expect(page.ok).toBe(false);
      if (page.ok) return;
      const door = await declareTarget(session, { kind: "url", url });
      expect(door.status, door.text).toBe(400);
      const reason = (JSON.parse(door.text) as { error: { details: { reason: string } } }).error.details.reason;
      expect(page.line).toContain(reason);
      // The refused address is not echoed by the page either - the field that failed is the one that may
      // carry the credential (§5).
      expect(page.line).not.toContain("token");
      expect(page.line).not.toContain("access_token");
    }

    // And an unpaired page refuses before anything reaches this door: the project still has no targets,
    // which is the observable difference between "the control refused" and "the door refused".
    const cold = targetDraftOf({ csrf: "", url: "https://shop.example/cart" });
    expect(cold.ok).toBe(false);
    if (cold.ok) return;
    expect(cold.line).toBe(NO_SESSION_LINE);
    const view = await call("GET", `${API_PREFIX}/projects/${String(projectId)}`, { headers: { host: host(), cookie: session.cookie } });
    // One row - the 201 above. The three defects the page refused were also refused by the door when
    // asked directly, and the unpaired draft never reached it at all, so this project has exactly the
    // target it was granted: a page-side refusal that still wrote a row would show up here as two.
    expect(((relayData(JSON.parse(view.text) as JsonValue) as { targetIds: string[] }).targetIds).length).toBe(1);
  });

  // §8 line 289 from the page's own builders (issue #58's next handle). The three reads this control
  // depends on are the ones the page already performs - the target row (whose snapshot digest names the
  // inventory the plan binds), §8 line 302's journal (which contracts are approved; §8 has no contract
  // list route) and the sample page (the inventory revision and the rows an exclusion may name) - so the
  // body below is assembled exactly the way a click would assemble it and then sent through the real door.
  it("builds a plan the door accepts from the reads the page makes, and lets the door own requiredCases", async () => {
    // The fixture walks the chain over HTTP: seed, then approve sample / contract / plan through the
    // three review doors. What the page then finds is only the *contract* approval, and a second plan
    // over an already-planned contract is a new row, not a rewrite (§7.4).
    const { session, seeded } = await chain("plan-page-draft", true);

    const journalRead = await call("GET", `${API_PREFIX}/projects/${String(session.projectId)}/audit?limit=100`, { headers: { host: host(), cookie: session.cookie } });
    expect(journalRead.status, journalRead.text).toBe(200);
    const contracts = approvedContractIds(journalEntriesOf(JSON.parse(journalRead.text) as JsonValue));
    // Read back, not remembered: the page finds the contract from the journal's own `contract-approved`
    // allows, and the plan approval in the same window must not leak into this list.
    expect(contracts).toEqual([String(seeded.contractId)]);

    const targetRead = await call("GET", `${API_PREFIX}/projects/${String(session.projectId)}/targets/${String(seeded.targetId)}`, { headers: { host: host(), cookie: session.cookie } });
    expect(targetRead.status, targetRead.text).toBe(200);
    const target = inspectTargetReadOf(JSON.parse(targetRead.text) as JsonValue, seeded.targetId);
    // The snapshot digest travels in the same read as the kind, because they are one record: an imported
    // target carries the digest a plan binds, and §8 line 274's `null` is what a declared URL gives back.
    expect(target).toEqual({ ok: true, kind: "har", snapshotDigest: seeded.snapshotDigest });
    if (!target.ok) return;

    const vectorsRead = await call("GET", `${API_PREFIX}/projects/${String(session.projectId)}/vectors?targetId=${String(seeded.targetId)}`, { headers: { host: host(), cookie: session.cookie } });
    expect(vectorsRead.status, vectorsRead.text).toBe(200);
    const listed = samplesPageOf(JSON.parse(vectorsRead.text) as JsonValue);
    expect(listed.rows.map((row) => row.vectorId)).toEqual([String(seeded.vectorId)]);

    const drafted = planDraftOf({
      csrf: session.csrf,
      targetId: String(seeded.targetId),
      target,
      inventoryRevision: listed.inventoryRevision,
      contracts,
      chosenContractIds: [String(seeded.contractId)],
      inventoryIds: listed.rows.map((row) => row.vectorId),
      rows: [],
    });
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    // Five keys, and they are the door's five: §8 line 289 names `expectedGraphRevision` (which the door
    // refuses by name - §7.4 makes the plan bind the graph the service reads) and does not name
    // `snapshotDigest` (which the door requires). The composer follows the door, and the deviation is
    // recorded on #58 rather than papered over by sending a field nothing reads.
    expect(Object.keys(drafted.body).sort()).toEqual(["contractRevisionIds", "exclusions", "expectedInventoryRevision", "snapshotDigest", "targetId"]);

    const built = await call("POST", `${API_PREFIX}/projects/${String(session.projectId)}/verification-plans`, {
      body: JSON.stringify(drafted.body),
      headers: { host: host(), origin: `http://${host()}`, cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrf, "idempotency-key": "plan-page-draft-1" },
    });
    expect(built.status, built.text).toBe(201);
    const receipt = planCommitReceiptSchema.safeParse(relayData(JSON.parse(built.text) as JsonValue));
    if (!receipt.success) throw new Error(built.text);
    expect(receipt.data.reviewStatus).toBe("draft");
    expect(receipt.data.selectedCount).toBe(1);
    expect(receipt.data.excludedCount).toBe(0);
    const line = planBuildLine(receipt.data);
    expect(line).toContain(String(receipt.data.planId));
    expect(line).toContain("草稿（还要 §8 line 291 的批准）");
    expect(line).toContain("选中 1");
    expect(line).not.toContain("undefined");

    // The other half of the split: which cases a plan *requires* is a function of the approved contracts
    // (§7.4), and nothing the page reads discloses that set - so an exclusion that names a required case
    // cannot be honestly pre-checked by the composer. It sends, and the door answers with the vector's
    // own id. This is the same division of labour as the capture's start-URL scope rule.
    const against = planDraftOf({
      csrf: session.csrf,
      targetId: String(seeded.targetId),
      target,
      inventoryRevision: listed.inventoryRevision,
      contracts,
      chosenContractIds: [String(seeded.contractId)],
      inventoryIds: listed.rows.map((row) => row.vectorId),
      rows: [{ vectorId: String(seeded.vectorId), reasonCode: "outside-scope", reason: "这一版不算它", excludedBehavior: "GET /api/cart", supersededBy: "" }],
    });
    expect(against.ok).toBe(true);
    if (!against.ok) return;
    const refused = await call("POST", `${API_PREFIX}/projects/${String(session.projectId)}/verification-plans`, {
      body: JSON.stringify(against.body),
      headers: { host: host(), origin: `http://${host()}`, cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrf, "idempotency-key": "plan-page-draft-2" },
    });
    expect(refused.status, refused.text).toBe(422);
    expect(refused.text).toContain(`vector-both-selected-and-excluded:${String(seeded.vectorId)}`);
  });

  it("reads a frozen blueprint back over HTTP with the plan id for this role (§8 line 293)", async () => {
    const { session, seeded } = await chain("freeze-read", true);
    const frozen = await send(session, { verificationPlanId: String(seeded.planId) }, "freeze-read-1");
    expect(frozen.status, frozen.text).toBe(201);
    const receipt = blueprintFreezeReceiptSchema.safeParse(JSON.parse(frozen.text) as JsonValue);
    if (!receipt.success) throw new Error(frozen.text);

    const read = await call("GET", `${API_PREFIX}/projects/${String(session.projectId)}/blueprints/${receipt.data.blueprintId}`, { headers: { host: host(), cookie: session.cookie } });
    expect(read.status, read.text).toBe(200);
    const body = blueprintReadSchema.safeParse(JSON.parse(read.text) as JsonValue);
    if (!body.success) throw new Error(`${JSON.stringify(body.error.issues)}\n${read.text}`);
    // The same digest the freeze committed, and the plan the freeze named: this is the read that
    // lets a page re-open a blueprint it was told about rather than being shown a new claim.
    expect(body.data.id).toBe(receipt.data.blueprintId);
    expect(body.data.digest).toBe(receipt.data.digest);
    expect(body.data.verificationPlanId).toBe(String(seeded.planId));
    expect(body.data.bundle.blueprintId).toBe(receipt.data.blueprintId);
    // §8 says no role reads a source manifest or a holdout list through this interface, and the
    // reply has nowhere to put them.
    expect(JSON.stringify(body.data)).not.toMatch(/manifest|holdout/i);

    const malformed = await call("GET", `${API_PREFIX}/projects/${String(session.projectId)}/blueprints/not-an-id`, { headers: { host: host(), cookie: session.cookie } });
    expect(malformed.status, malformed.text).toBe(400);
    expect((JSON.parse(malformed.text) as { error: { details: { reason: string } } }).error.details.reason).toBe("blueprint-id-malformed");
    const unknown = await call("GET", `${API_PREFIX}/projects/${String(session.projectId)}/blueprints/${String(newId())}`, { headers: { host: host(), cookie: session.cookie } });
    expect(unknown.status, unknown.text).toBe(404);
    expect((JSON.parse(unknown.text) as { error: { details: { reason: string } } }).error.details.reason).toBe("blueprint-unknown");
  });

  it("holds the door behind the session and the CSRF header", async () => {
    const id = newId();
    const anonymous = await call("POST", `${API_PREFIX}/projects/${String(id)}/blueprints`, {
      body: "{}",
      headers: { host: host(), origin: `http://${host()}`, "content-type": "application/json", "idempotency-key": "freeze-anon" },
    });
    expect(anonymous.status, anonymous.text).toBe(401);
    expect(anonymous.text).toContain("cookie-absent");
  });

  it("a refusal does not burn the key: the blocked freeze succeeds on retry once the plan is approved", async () => {
    const { session, seeded } = await chain("freeze-retry", false);
    const blocked = await send(session, { verificationPlanId: String(seeded.planId) }, "freeze-key-6");
    expect(blocked.status, blocked.text).toBe(422);

    // Same key, same body, one correction in between: the key was given back by the failed
    // attempt, so this second call is a fresh creation rather than a replay of the refusal.
    const project = worker.writeConnection.transact((tx) => tx.getProject(session.projectId));
    if (!project.ok || project.value === null) throw new Error("project missing");
    const at = project.value.inventoryRevision;
    for (const [path, payload] of [
      [`vectors/${String(seeded.vectorId)}/review`, { decision: "approved", expectedDigest: seeded.vectorDigest, expectedInventoryRevision: at }],
      [`contracts/${String(seeded.contractId)}/review`, { decision: "approved", expectedDigest: seeded.contractDigest }],
      [`verification-plans/${String(seeded.planId)}/review`, { decision: "approved", expectedDigest: seeded.planDigest, expectedInventoryRevision: at + 1 }],
    ] as const) {
      const step = await call("POST", `${API_PREFIX}/projects/${String(session.projectId)}/${path}`, {
        body: JSON.stringify(payload),
        headers: { host: host(), origin: `http://${host()}`, cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" },
      });
      expect(step.status, `${path}: ${step.text}`).toBe(200);
    }

    const frozen = await send(session, { verificationPlanId: String(seeded.planId) }, "freeze-key-6");
    expect(frozen.status, frozen.text).toBe(201);
    const body = JSON.parse(blocked.text) as { error: { requestId?: string } };
    const replayHeaders = frozen.headers.get("x-request-id") ?? "";
    // A 201 with a fresh id, and not the refusal's: the second call really ran.
    expect(replayHeaders).not.toBe("");
    expect(replayHeaders).not.toBe(body.error.requestId);
  });

  it("scopes the same key to one project, not to the reviewer's whole session", async () => {
    // One session, two projects: two sessions would put a different reviewer id in each journal
    // scope and hide the project dimension entirely (which is exactly how a first version of this
    // test stayed green against a scope that had dropped it).
    const paired = await pairSession();
    const projectA = await freshProject(paired, "freeze-scope-a");
    const projectB = await freshProject(paired, "freeze-scope-b");
    const first: FreezeSession = { ...paired, projectId: projectA };
    const second: FreezeSession = { ...paired, projectId: projectB };
    const seededA = await seedReviewChain({ writer: worker.writeConnection, store: new ArtifactStore(dataDir), projectId: projectA, name: "freeze-scope-a" });
    const seededB = await seedReviewChain({ writer: worker.writeConnection, store: new ArtifactStore(dataDir), projectId: projectB, name: "freeze-scope-b" });
    for (const [session, seeded] of [[first, seededA], [second, seededB]] as const) {
      for (const path of [`vectors/${String(seeded.vectorId)}/review`, `contracts/${String(seeded.contractId)}/review`, `verification-plans/${String(seeded.planId)}/review`]) {
        const project = worker.writeConnection.transact((tx) => tx.getProject(session.projectId));
        if (!project.ok || project.value === null) throw new Error("project missing");
        const at = project.value.inventoryRevision;
        const payload: Record<string, JsonValue> = path.startsWith("contracts/")
          ? { decision: "approved", expectedDigest: seeded.contractDigest }
          : {
              decision: "approved",
              expectedDigest: path.startsWith("vectors/") ? seeded.vectorDigest : seeded.planDigest,
              expectedInventoryRevision: at,
            };
        const step = await call("POST", `${API_PREFIX}/projects/${String(session.projectId)}/${path}`, {
          body: JSON.stringify(payload),
          headers: { host: host(), origin: `http://${host()}`, cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" },
        });
        expect(step.status, `${path}: ${step.text}`).toBe(200);
      }
    }
    const a = await send(first, { verificationPlanId: String(seededA.planId) }, "shared-key");
    expect(a.status, a.text).toBe(201);
    // Same reviewer, same key, a different project: a second creation, not a
    // `idempotency-key-reused` conflict - and not a replay of the first blueprint either, which
    // would name a plan from the other project.
    const b = await send(second, { verificationPlanId: String(seededB.planId) }, "shared-key");
    expect(b.status, b.text).toBe(201);
    const bodyA = JSON.parse(a.text) as Record<string, JsonValue>;
    const bodyB = JSON.parse(b.text) as Record<string, JsonValue>;
    expect(bodyB["planId"]).toBe(String(seededB.planId));
    expect(bodyA["planId"]).toBe(String(seededA.planId));
    expect(bodyB["blueprintId"]).not.toBe(bodyA["blueprintId"]);
  });

  it("refuses an over-long key at the shape the route table declares", async () => {
    const { session, seeded } = await chain("freeze-long-key", true);
    const tooLong = await send(session, { verificationPlanId: String(seeded.planId) }, "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1));
    expect(tooLong.status, tooLong.text).toBe(400);
    expect(tooLong.text).toContain("idempotency-key-required");
    // The freeze never reached the worker, so nothing was committed under the rejected key.
    const good = await send(session, { verificationPlanId: String(seeded.planId) }, "freeze-key-7");
    expect(good.status, good.text).toBe(201);
  });

  it("an unparseable plan id in the body is a refusal, not a lookup miss", async () => {
    const { session } = await chain("freeze-bad-id", false);
    const bad = await send(session, { verificationPlanId: "not-a-uuid" }, "freeze-key-5");
    expect(bad.status, bad.text).toBe(400);
    expect(bad.text).not.toContain("not-a-uuid");
  });
});

describe("the three creation doors (§8 lines 282, 286, 289 / issue #58)", () => {
  // What a door owns is the mapping and the journal, so these tests ask each one for a real
  // creation and then read the record back through the door that already existed for it. The
  // evidence behind them is a real REA capture envelope (`seedReviewChain`), which is what
  // `vector.create` re-hashes and parses - a fixture that faked it would be refused, and that
  // refusal would prove nothing about this door.
  const host = () => `127.0.0.1:${String(address.port)}`;
  type Session = { cookie: string; csrf: string; reviewerId: string };

  async function pairSession(): Promise<Session> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const issued = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    const cookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const current = await call("GET", `${API_PREFIX}/session`, { headers: { host: host(), cookie } });
    const view = JSON.parse(current.text) as { reviewerId?: string; data?: { reviewerId?: string } };
    return { cookie, csrf: issued.data?.csrfToken ?? issued.csrfToken ?? "", reviewerId: view.data?.reviewerId ?? "" };
  }

  async function freshProject(session: Session, name: string): Promise<Id> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `create-project-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return asId((body.data?.id ?? body.id) as string);
  }

  function post(session: Session, pathname: string, payload: Record<string, JsonValue>, key: string | null) {
    const headers: Record<string, string> = {
      host: host(),
      origin: `http://${host()}`,
      cookie: session.cookie,
      "content-type": "application/json",
      "x-csrf-token": session.csrf,
    };
    if (key !== null) headers["idempotency-key"] = key;
    return call("POST", pathname, { body: JSON.stringify(payload), headers });
  }

  function rejected(text: string): string[] {
    return ((JSON.parse(text) as { error: { details: { rejectedKeys?: string[] } } }).error.details.rejectedKeys ?? []).sort();
  }

  async function seeded(name: string): Promise<{ session: Session; projectId: Id; seeded: Awaited<ReturnType<typeof seedReviewChain>> }> {
    const session = await pairSession();
    const projectId = await freshProject(session, name);
    return { session, projectId, seeded: await seedReviewChain({ writer: worker.writeConnection, store: new ArtifactStore(dataDir), projectId, name }) };
  }

  function vectorBody(fix: { projectId: Id; seeded: Awaited<ReturnType<typeof seedReviewChain>> }, caseKey: string): Record<string, JsonValue> {
    return {
      targetId: String(fix.seeded.targetId),
      snapshotDigest: fix.seeded.snapshotDigest,
      source: { evidenceId: fix.seeded.evidenceId, captureId: null, recordOrdinal: 0, pointer: "/records/0/reported", transactionId: null },
      operationId: "getCart",
      caseKey,
      sdkInput: { include: "items" },
      expectedOutcome: { kind: "return", value: { items: [] } },
      visibility: "public",
      replacesId: null,
    };
  }

  it("creates a vector from the stored capture and reads it back as a draft sample", async () => {
    const fix = await seeded("door-vector");
    const created = await post(fix.session, `${API_PREFIX}/projects/${String(fix.projectId)}/vectors`, vectorBody(fix, "cart-door"), "vector-door-1");
    expect(created.status, created.text).toBe(201);
    const receipt = vectorCommitReceiptSchema.safeParse(JSON.parse(created.text) as JsonValue);
    if (!receipt.success) throw new Error(created.text);
    expect(receipt.data.eligibility).toBe("usable");
    expect(receipt.data.inventoryRevision).toBe(2);
    // The digest is the service's own over the record it read, so a door that re-used the
    // evidence digest would still be a 201 and a wrong answer.
    expect(receipt.data.digest).not.toBe(fix.seeded.vectorDigest);

    const read = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/vectors/${String(receipt.data.vectorId)}`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(read.status, read.text).toBe(200);
    const view = JSON.parse(read.text) as { review?: { status?: string }; digest?: string };
    expect(view.review?.status).toBe("draft");
    expect(view.digest).toBe(receipt.data.digest);

    // Same key, same body: the original 201, and the sample inventory moved exactly once.
    const replay = await post(fix.session, `${API_PREFIX}/projects/${String(fix.projectId)}/vectors`, vectorBody(fix, "cart-door"), "vector-door-1");
    expect(replay.status, replay.text).toBe(201);
    expect(JSON.parse(replay.text)).toEqual(JSON.parse(created.text));
  });

  it("keeps the vector door shut on the key, the session and a restated sensitive list", async () => {
    const fix = await seeded("door-vector-guard");
    const anonymous = await call("POST", `${API_PREFIX}/projects/${String(fix.projectId)}/vectors`, {
      body: JSON.stringify(vectorBody(fix, "cart-anon")),
      headers: { host: host(), origin: `http://${host()}`, "content-type": "application/json", "idempotency-key": "vector-anon" },
    });
    expect(anonymous.status, anonymous.text).toBe(401);

    const noKey = await post(fix.session, `${API_PREFIX}/projects/${String(fix.projectId)}/vectors`, vectorBody(fix, "cart-no-key"), null);
    expect(noKey.status, noKey.text).toBe(400);
    expect(noKey.text).toContain("idempotency-key-required");

    // §8 line 282 offers `sensitiveValues` to a vector create; nothing in the create path or the
    // stored sample has an owner for it (the declaration belongs to the capture), so the door
    // names it rather than dropping it.
    const withSensitive = await post(fix.session, `${API_PREFIX}/projects/${String(fix.projectId)}/vectors`, { ...vectorBody(fix, "cart-sensitive"), sensitiveValues: ["hunter2"] }, "vector-sensitive");
    expect(withSensitive.status, withSensitive.text).toBe(400);
    expect(rejected(withSensitive.text)).toEqual(["sensitiveValues"]);
    expect(withSensitive.text).not.toContain("hunter2");
  });

  it("creates a contract draft and reports the revision the service chose", async () => {
    const fix = await seeded("door-contract");
    const body: Record<string, JsonValue> = {
      contractKey: "cart-door",
      targetId: String(fix.seeded.targetId),
      scope: { snapshotDigest: fix.seeded.snapshotDigest, operationIds: ["getCart"], excludedBehaviors: [] },
      behaviorSpec: "GET /api/cart returns the item list",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      httpOperations: [
        {
          operationId: "getCart",
          method: "GET",
          path: "/api/cart",
          requestMediaType: null,
          responses: [{ status: 200, mediaType: "application/json", schema: { type: "object" } }],
        },
      ],
      errorCases: [],
      limitations: [],
      unknowns: [],
      sourceClaimIds: [String(fix.seeded.claimId)],
      requiredCases: [{ caseKey: "cart-ok", claimId: String(fix.seeded.claimId), kind: "success", vectorIds: [String(fix.seeded.vectorId)] }],
    };
    const path = `${API_PREFIX}/projects/${String(fix.projectId)}/contracts`;
    // A state change without the session's CSRF token is refused even with the cookie present:
    // the door is `mutating`, and that flag is what this assertion makes load-bearing.
    const noCsrf = await call("POST", path, {
      body: JSON.stringify(body),
      headers: { host: host(), origin: `http://${host()}`, cookie: fix.session.cookie, "content-type": "application/json" },
    });
    expect(noCsrf.status, noCsrf.text).toBe(403);
    expect(noCsrf.text).toContain("csrf-token-missing");

    const created = await post(fix.session, path, body, null);
    expect(created.status, created.text).toBe(201);
    const receipt = contractCommitReceiptSchema.safeParse(JSON.parse(created.text) as JsonValue);
    if (!receipt.success) throw new Error(created.text);
    expect(receipt.data.revision).toBe(1);
    expect(receipt.data.reviewStatus).toBe("draft");

    // §8 line 261 does not list contracts among the keyed creations, so a repeat is the
    // service's own question about content, not this process replaying a body. Recorded on #58:
    // what actually happens here is a second revision, which is what §8 line 286 describes.
    const again = await post(fix.session, path, body, null);
    expect(again.status, again.text).toBe(201);
    const second = contractCommitReceiptSchema.safeParse(JSON.parse(again.text) as JsonValue);
    if (!second.success) throw new Error(again.text);
    expect(second.data.contractId).not.toBe(receipt.data.contractId);
    expect(second.data.revision).toBe(2);
  });

  it("builds a plan from §8's `exclusions` name and reports the derived counts", async () => {
    const fix = await seeded("door-plan");
    // §8 line 289's plan is a function of the *approved* contracts, so the door is tested on a
    // chain where that is true rather than on one where the build is legitimately refused.
    const approved = await post(fix.session, `${API_PREFIX}/projects/${String(fix.projectId)}/contracts/${String(fix.seeded.contractId)}/review`, { decision: "approved", expectedDigest: fix.seeded.contractDigest }, null);
    expect(approved.status, approved.text).toBe(200);
    const body: Record<string, JsonValue> = {
      targetId: String(fix.seeded.targetId),
      snapshotDigest: fix.seeded.snapshotDigest,
      contractRevisionIds: [String(fix.seeded.contractId)],
      exclusions: [],
      expectedInventoryRevision: 1,
    };
    const path = `${API_PREFIX}/projects/${String(fix.projectId)}/verification-plans`;
    const built = await post(fix.session, path, body, "plan-door-1");
    expect(built.status, built.text).toBe(201);
    const receipt = planCommitReceiptSchema.safeParse(JSON.parse(built.text) as JsonValue);
    if (!receipt.success) throw new Error(built.text);
    // selected is derived from the approved contracts' requiredCases (§7.4), never sent: the
    // seeded contract requires the seeded vector, so a build sees exactly one.
    expect(receipt.data.selectedCount).toBe(1);
    expect(receipt.data.excludedCount).toBe(0);
    expect(receipt.data.reviewStatus).toBe("draft");

    const read = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/verification-plans/${String(receipt.data.planId)}`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(read.status, read.text).toBe(200);

    // §8 line 289 also names `expectedGraphRevision`; the plan binds the graph revision the
    // server reads, so a caller-supplied one is refused by name rather than accepted and ignored.
    const withGraphRevision = await post(fix.session, path, { ...body, expectedGraphRevision: 7 }, "plan-door-2");
    expect(withGraphRevision.status, withGraphRevision.text).toBe(400);
    expect(rejected(withGraphRevision.text)).toEqual(["expectedGraphRevision"]);

    // A stale inventory revision is the service's own conflict, and both sides of it arrive
    // (issue #59) rather than a bare reason code. The live number is read rather than written
    // down, so this stays true when the fixture's own bumps change.
    const live = worker.writeConnection.transact((tx) => tx.getProject(fix.projectId));
    if (!live.ok || live.value === null) throw new Error("project missing");
    const stale = await post(fix.session, path, { ...body, expectedInventoryRevision: live.value.inventoryRevision + 40 }, "plan-door-3");
    expect(stale.status, stale.text).toBe(409);
    const details = (JSON.parse(stale.text) as { error: { details: Record<string, unknown> } }).error.details;
    expect(details["expected"]).toBe(live.value.inventoryRevision + 40);
    expect(details["actual"]).toBe(live.value.inventoryRevision);
  });

  it("reads a stored contract revision back over HTTP (§8 line 288)", async () => {
    const fix = await seeded("door-contract-read");
    const path = `${API_PREFIX}/projects/${String(fix.projectId)}/contracts/${String(fix.seeded.contractId)}`;
    const read = await call("GET", path, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(read.status, read.text).toBe(200);
    const revision = contractRevisionSchema.safeParse(JSON.parse(read.text) as JsonValue);
    if (!revision.success) throw new Error(`${JSON.stringify(revision.error.issues)}\n${read.text}`);
    // The row the fixture wrote, not a re-derivation: the digest is the same one the review door
    // has to be given, so a page can read a contract and then decide on it without a second
    // source of truth.
    expect(revision.data.id).toBe(fix.seeded.contractId);
    expect(revision.data.digest).toBe(fix.seeded.contractDigest);
    // The status lives under `review`, the same shape the inventory summary uses - reading a flat
    // `reviewStatus` off this body is the mistake that made the 样本 tab render an empty list
    // while every test stayed green (issue #58's browser pass).
    expect(revision.data.review.status).toBe("draft");

    // A segment that is not an id is refused here rather than looked up: "you typed it wrong"
    // must not arrive as "there is no such contract" (the same rule the candidate and evidence
    // reads use, and the one a mutation taught me to prefer).
    const malformed = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/contracts/not-an-id`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(malformed.status, malformed.text).toBe(400);
    expect((JSON.parse(malformed.text) as { error: { details: { reason: string } } }).error.details.reason).toBe("contract-id-malformed");

    const unknown = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/contracts/${String(newId())}`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(unknown.status, unknown.text).toBe(404);
    // Another project's real contract answers identically: the route cannot be used to find out
    // whether an id exists somewhere else.
    const other = await seeded("door-contract-other");
    // Another project's real contract answers identically: the route cannot be used to find out
    // whether an id exists somewhere else. `requestId` is per-request, so the comparison is of
    // everything the answer *claims*.
    const claim = (text: string) => {
      const error = (JSON.parse(text) as { error: Record<string, unknown> }).error;
      // What the answer asserts, leaving out only the per-request id every response carries.
      return JSON.stringify({ code: error["code"], message: error["message"], retryable: error["retryable"], details: error["details"] });
    };
    const crossProject = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/contracts/${String(other.seeded.contractId)}`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(crossProject.status, crossProject.text).toBe(404);
    expect(claim(crossProject.text)).toBe(claim(unknown.text));
  });

  it("reads a stored verification report as the body §8 names (§8 line 298)", async () => {
    const fix = await seeded("door-verification-read");
    const verified = await seedVerifiedScenario({
      writer: worker.writeConnection,
      store: new ArtifactStore(dataDir),
      projectId: fix.projectId,
      targetId: fix.seeded.targetId,
      name: "door-verification-read",
    });
    const read = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/verifications/${String(verified.verificationId)}`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(read.status, read.text).toBe(200);
    const report = verificationReportSchema.safeParse(JSON.parse(read.text) as JsonValue);
    if (!report.success) throw new Error(`${JSON.stringify(report.error.issues)}\n${read.text}`);
    expect(report.data.id).toBe(verified.verificationId);
    expect(report.data.identities.candidateDigest).toBe(verified.candidateDigest);
    // The service also re-derives staleness for its own callers; §8 names the report as this
    // route's body, so nothing beside it may leak into the reply.
    expect(Object.keys(JSON.parse(read.text) as Record<string, unknown>)).not.toContain("staleness");

    const malformed = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/verifications/not-an-id`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(malformed.status, malformed.text).toBe(400);
    expect((JSON.parse(malformed.text) as { error: { details: { reason: string } } }).error.details.reason).toBe("verification-id-malformed");
    const unknown = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/verifications/${String(newId())}`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(unknown.status, unknown.text).toBe(404);
  });
});

describe("the job lifecycle doors (§8 lines 278-279 / issue #58)", () => {
  const host = () => `127.0.0.1:${String(address.port)}`;
  type Session = { cookie: string; csrf: string };

  async function pairSession(): Promise<Session> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const issued = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    const cookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    return { cookie, csrf: issued.data?.csrfToken ?? issued.csrfToken ?? "" };
  }

  async function freshProject(session: Session, name: string): Promise<Id> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `create-project-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return asId((body.data?.id ?? body.id) as string);
  }

  function post(session: Session, pathname: string, payload: Record<string, JsonValue>, key: string | null) {
    const headers: Record<string, string> = {
      host: host(),
      origin: `http://${host()}`,
      cookie: session.cookie,
      "content-type": "application/json",
      "x-csrf-token": session.csrf,
    };
    if (key !== null) headers["idempotency-key"] = key;
    return call("POST", pathname, { body: JSON.stringify(payload), headers });
  }

  function details(text: string): Record<string, unknown> {
    return (JSON.parse(text) as { error: { details: Record<string, unknown> } }).error.details;
  }

  function insertJob(projectId: Id, state: "queued" | "running" | "succeeded", cleanupState: "pending" | "complete" | "failed" = "pending"): Id {
    const jobId = newId();
    const at = nowInstant();
    const inserted = worker.writeConnection.transact((tx) => {
      const outcome = tx.insertJob({
        id: jobId,
        projectId,
        targetId: null,
        kind: "capture",
        state,
        cleanupState,
        inputJson: {},
        resultRef: null,
        errorJson: null,
        idempotencyKey: `lifecycle-${jobId}`,
        requestDigest: asDigest("a".repeat(64)),
        deadlineAt: null,
        retryAt: null,
        createdAt: at,
        updatedAt: at,
      });
      if (outcome.outcome !== "inserted") throw new Error(`job ${outcome.outcome}`);
      return true;
    });
    if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
    return jobId;
  }

  function insertLease(jobId: Id, owned: boolean, cleanupState: "pending" | "complete" | "failed" = "failed"): Id {
    const leaseId = newId();
    const inserted = worker.writeConnection.transact((tx) => {
      tx.insertLease({
        id: leaseId,
        jobId,
        kind: "har-staging",
        resourceIdentityJson: { storageKey: "projects/x/staging/y" },
        ownershipProofJson: owned ? { mintedBy: "verify-runner", jobId } : {},
        cleanupState,
        lastErrorJson: null,
        retryAt: null,
        retryCount: 0,
      });
      return true;
    });
    if (!inserted.ok) throw new Error(JSON.stringify(inserted.error));
    return leaseId;
  }

  it("cancels a queued job and answers with §8's JobRecord", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "lifecycle-cancel");
    const jobId = insertJob(projectId, "queued");
    const path = `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(jobId)}/cancel`;
    const cancelled = await post(session, path, {}, null);
    expect(cancelled.status, cancelled.text).toBe(202);
    const record = jobRecordSchema.safeParse(JSON.parse(cancelled.text) as JsonValue);
    if (!record.success) throw new Error(cancelled.text);
    expect(record.data.id).toBe(jobId);
    expect(record.data.state).toBe("cancelled");

    // §11: 终态不复活. A second cancel cannot move it anywhere, and the row still says cancelled.
    const again = await post(session, path, {}, null);
    expect(again.status, again.text).toBe(202);
    expect((jobRecordSchema.parse(JSON.parse(again.text) as JsonValue) as { state: string }).state).toBe("cancelled");
  });

  // §13's push is what makes the page's sentence "作业状态由 job.updated 推送" true, and the sentence is
  // only true if every door that moves a row commits the event rather than only the runner. Found by
  // the browser pass: the cancelled row refreshed because the *click* re-read, while the open stream
  // sat at the same seq - a second tab would have kept showing `queued` and claimed it was pushed.
  it("a cancel is delivered to an open stream, and a cancel that moved nothing is not", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "lifecycle-cancel-stream");
    const jobId = insertJob(projectId, "queued");
    const path = `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(jobId)}/cancel`;
    const silence = (ms: number) => new Promise<"silent">((resolve) => setTimeout(() => resolve("silent"), ms));

    const stream = await fetch(`${baseUrl}${API_PREFIX}/projects/${String(projectId)}/events`, {
      headers: { host: host(), cookie: session.cookie },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("the stream carried no body");

    const cancelled = await post(session, path, {}, null);
    expect(cancelled.status, cancelled.text).toBe(202);

    const decoder = new TextDecoder();
    let text = "";
    for (let attempt = 0; attempt < 20 && !text.includes('"state":"cancelled"'); attempt += 1) {
      const got = await Promise.race([reader.read(), silence(400)]);
      if (got === "silent") continue;
      if (got.done === true) break;
      text += decoder.decode(got.value, { stream: true });
    }
    expect(text, "the open stream never heard about the cancel").toContain('"state":"cancelled"');
    expect(text).toContain("event: job.updated");
    // One frame, naming the row that moved, carrying only fields §8.1 knows.
    const framed = [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1] ?? "{}") as { aggregateId: string; payload: Record<string, JsonValue> });
    expect(framed.map((row) => row.aggregateId)).toEqual([jobId]);
    expect(framed[0]?.payload).toEqual({ resourceIds: [jobId], state: "cancelled" });

    // The row did not move the second time, so the outbox stays quiet: an event for a state that did
    // not change would tell the subscriber a transition happened that §11 refused.
    const again = await post(session, path, {}, null);
    expect(again.status, again.text).toBe(202);
    expect(await Promise.race([reader.read(), silence(600)])).toBe("silent");
    await reader.cancel();
  });

  it("a running job is asked to stop, not declared dead", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "lifecycle-running");
    const jobId = insertJob(projectId, "running");
    const cancelled = await post(session, `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(jobId)}/cancel`, {}, null);
    expect(cancelled.status, cancelled.text).toBe(202);
    // `cancelling` is the request; only the executor that owns the run reports an interruption.
    expect((jobRecordSchema.parse(JSON.parse(cancelled.text) as JsonValue) as { state: string }).state).toBe("cancelling");
  });

  it("a finished job answers with its current state and stays finished", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "lifecycle-terminal");
    const jobId = insertJob(projectId, "succeeded", "complete");
    const cancelled = await post(session, `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(jobId)}/cancel`, {}, null);
    expect(cancelled.status, cancelled.text).toBe(202);
    const record = jobRecordSchema.parse(JSON.parse(cancelled.text) as JsonValue) as { state: string; cleanupState: string };
    expect(record.state).toBe("succeeded");
    expect(record.cleanupState).toBe("complete");

    // The row is not rewritten either. §11's terminality is enforced by the state machine, so a
    // guard that only avoided a *write* would otherwise be invisible from the reply - and a cancel
    // that touched a finished job's row would be the beginning of 终态复活.
    const before = worker.writeConnection.transact((tx) => tx.getJob(projectId, jobId));
    if (!before.ok) throw new Error(JSON.stringify(before.error));
    if (before.value === null) throw new Error("before row missing");
    const later = await post(session, `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(jobId)}/cancel`, {}, null);
    expect(later.status, later.text).toBe(202);
    const after = worker.writeConnection.transact((tx) => tx.getJob(projectId, jobId));
    if (!after.ok) throw new Error(JSON.stringify(after.error));
    if (after.value === null) throw new Error("after row missing");
    expect(after.value.updatedAt).toBe(before.value.updatedAt);
    expect(after.value.state).toBe("succeeded");
  });

  it("refuses a cancel body that carries a field and a path segment that is not an id", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "lifecycle-refused");
    const jobId = insertJob(projectId, "queued");
    const withField = await post(session, `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(jobId)}/cancel`, { reason: "because" }, null);
    expect(withField.status, withField.text).toBe(400);
    expect(details(withField.text)["rejectedKeys"]).toEqual(["reason"]);

    const malformed = await post(session, `${API_PREFIX}/projects/${String(projectId)}/jobs/not-an-id/cancel`, {}, null);
    expect(malformed.status, malformed.text).toBe(400);
    expect(details(malformed.text)["reason"]).toBe("job-id-malformed");
    const unknown = await post(session, `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(newId())}/cancel`, {}, null);
    expect(unknown.status, unknown.text).toBe(404);
    expect(details(unknown.text)["reason"]).toBe("job-unknown");

    // The gate order, on this door: no cookie is 401, and a session without CSRF is 403.
    const anonymous = await call("POST", `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(jobId)}/cancel`, {
      body: "{}",
      headers: { host: host(), origin: `http://${host()}`, "content-type": "application/json" },
    });
    expect(anonymous.status, anonymous.text).toBe(401);
    const noCsrf = await call("POST", `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(jobId)}/cancel`, {
      body: "{}",
      headers: { host: host(), origin: `http://${host()}`, cookie: session.cookie, "content-type": "application/json" },
    });
    expect(noCsrf.status, noCsrf.text).toBe(403);
  });

  it("re-schedules only owned, unfinished cleanup and replays the same key to the same answer", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "lifecycle-cleanup");
    const jobId = insertJob(projectId, "succeeded", "failed");
    const owned = insertLease(jobId, true);
    // A second job whose only lease carries no ownership proof: §5 lets this workbench reclaim
    // only what it can show it minted, so the door must answer "nothing to schedule" for it.
    const unowned = insertJob(projectId, "succeeded", "failed");
    const unownedLease = insertLease(unowned, false);
    const path = `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(jobId)}/cleanup-retry`;

    const noKey = await post(session, path, {}, null);
    expect(noKey.status, noKey.text).toBe(400);
    expect(details(noKey.text)["reason"]).toBe("idempotency-key-required");

    const first = await post(session, path, {}, "cleanup-key-1");
    expect(first.status, first.text).toBe(202);
    const receipt = cleanupRetryReceiptSchema.safeParse(JSON.parse(first.text) as JsonValue);
    if (!receipt.success) throw new Error(first.text);
    expect(receipt.data.jobId).toBe(jobId);
    expect(receipt.data.cleanupState).toBe("pending");
    // The lease this workbench cannot prove it minted is left exactly where it is.
    expect(receipt.data.leaseIds).toEqual([owned]);
    expect(receipt.data.retryAt).not.toBeNull();
    expect(receipt.data.auditSeq).toBeGreaterThan(0);

    const replay = await post(session, path, {}, "cleanup-key-1");
    expect(replay.status, replay.text).toBe(202);
    expect(replay.text).toBe(first.text);

    const journal = await call("GET", `${API_PREFIX}/projects/${String(projectId)}/audit?limit=20`, { headers: { host: host(), cookie: session.cookie } });
    const actions = (((JSON.parse(journal.text) as { entries?: { action: string }[] }).entries) ?? []).map((entry) => entry.action);
    expect(actions.filter((action) => action === "job.cleanup-retry")).toHaveLength(1);

    // The row, not the reply: the lease really was put back on the schedule with a counted retry.
    const stored = worker.writeConnection.transact((tx) => tx.getLeaseByJob(projectId, jobId));
    if (!stored.ok) throw new Error(JSON.stringify(stored.error));
    if (stored.value === null) throw new Error("stored row missing");
    expect(stored.value.cleanupState).toBe("pending");
    expect(stored.value.retryCount).toBe(1);
    expect(stored.value.retryAt).not.toBeNull();

    const skipped = await post(session, `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(unowned)}/cleanup-retry`, {}, "cleanup-key-2");
    expect(skipped.status, skipped.text).toBe(202);
    expect((cleanupRetryReceiptSchema.parse(JSON.parse(skipped.text) as JsonValue) as { leaseIds: string[] }).leaseIds).toEqual([]);
    const untouched = worker.writeConnection.transact((tx) => tx.getLeaseByJob(projectId, unowned));
    if (!untouched.ok) throw new Error(JSON.stringify(untouched.error));
    if (untouched.value === null) throw new Error("untouched row missing");
    expect(untouched.value.id).toBe(unownedLease);
    expect(untouched.value.cleanupState).toBe("failed");
    expect(untouched.value.retryCount).toBe(0);
  });
});

describe("the project page (§8 line 270 / issue #58)", () => {
  const host = () => `127.0.0.1:${String(address.port)}`;

  async function pairSession(): Promise<{ cookie: string; csrf: string }> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const issued = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    const cookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    return { cookie, csrf: issued.data?.csrfToken ?? issued.csrfToken ?? "" };
  }

  async function createProject(session: { cookie: string; csrf: string }, name: string): Promise<Id> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `page-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return asId((body.data?.id ?? body.id) as string);
  }

  function get(session: { cookie: string }, query: string) {
    return call("GET", `${API_PREFIX}/projects${query}`, { headers: { host: host(), cookie: session.cookie } });
  }

  function reason(text: string): string {
    return (JSON.parse(text) as { error: { details: { reason: string } } }).error.details.reason;
  }

  it("walks every project exactly once and names the cursor it issued", async () => {
    const session = await pairSession();
    const mine = [
      await createProject(session, "page-alpha"),
      await createProject(session, "page-beta"),
      await createProject(session, "page-gamma"),
    ];

    const first = await get(session, "?limit=1");
    expect(first.status, first.text).toBe(200);
    const page1 = projectPageSchema.safeParse(JSON.parse(first.text) as JsonValue);
    if (!page1.success) throw new Error(page1.error.issues.map((i) => i.message).join("; ") + first.text);
    expect(page1.data.items).toHaveLength(1);
    expect(page1.data.nextCursor).not.toBeNull();
    // The cursor names the last row this page actually showed - not the one after it, which is
    // how a caller can tell a page from a promise.
    const shown = page1.data.items[0];
    expect(Buffer.from(String(page1.data.nextCursor), "base64url").toString("utf8")).toBe(shown?.id);
    expect(Object.keys(shown ?? {}).sort()).toEqual(["graphRevision", "id", "inventoryRevision", "name"]);

    const seen: string[] = [];
    let cursor: string | null = page1.data.nextCursor;
    let pages = 1;
    while (cursor !== null && pages < 80) {
      const next = await get(session, `?limit=5&cursor=${cursor}`);
      expect(next.status, next.text).toBe(200);
      const parsed = projectPageSchema.safeParse(JSON.parse(next.text) as JsonValue);
      if (!parsed.success) throw new Error(next.text);
      // A cursor that leads to an empty page is a server that promised a next page it could not
      // deliver: `hasMore` is decided by the extra row the read asked for, and this is what makes
      // that decision observable rather than a flag nothing can contradict.
      expect(parsed.data.items.length, `page ${String(pages)} came back empty`).toBeGreaterThan(0);
      seen.push(...parsed.data.items.map((item) => item.id));
      cursor = parsed.data.nextCursor;
      pages += 1;
    }
    // No repeats across pages, and every project this test made is reachable.
    expect(new Set(seen).size).toBe(seen.length);
    const everyPage = [shown?.id as string, ...seen];
    expect(new Set(everyPage).size).toBe(everyPage.length);
    for (const id of mine) expect(everyPage).toContain(id);
  });

  it("refuses a cursor this server did not issue and a limit that is not a number", async () => {
    const session = await pairSession();
    const forged = Buffer.from("not-a-project-id").toString("base64url");
    const refused = await get(session, `?cursor=${forged}`);
    expect(refused.status, refused.text).toBe(400);
    expect(reason(refused.text)).toBe("projects-cursor");

    const notANumber = await get(session, "?limit=abc");
    expect(notANumber.status, notANumber.text).toBe(400);
    expect(reason(notANumber.text)).toBe("projects-limit-malformed");

    const tooMany = await get(session, "?limit=5000");
    expect([413, 429]).toContain(tooMany.status);
    const details = (JSON.parse(tooMany.text) as { error: { details: Record<string, number> } }).error.details;
    expect(details["maxLimit"]).toBe(200);
    expect(details["limit"]).toBe(5000);

    const anonymous = await call("GET", `${API_PREFIX}/projects`, { headers: { host: host() } });
    expect(anonymous.status, anonymous.text).toBe(401);
  });
});


// §8 line 297 over HTTP: the operator asks for a verification and gets a *queued job* back, 202.
// The door is where two things get proved at once — that this creation honours §8's Idempotency-Key
// (both the 400 for its absence and the replay of an answer already given), and that the job it
// makes is the same row the job read door reads, because the two answer through one schema.
describe("the verification request door (§8 line 297 / issue #58)", () => {
  const host = () => `127.0.0.1:${String(address.port)}`;
  type Session = { cookie: string; csrf: string };

  async function pairSession(): Promise<Session> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const issued = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    const cookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    return { cookie, csrf: issued.data?.csrfToken ?? issued.csrfToken ?? "" };
  }

  async function freshProject(session: Session, name: string): Promise<Id> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `create-project-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return asId((body.data?.id ?? body.id) as string);
  }

  function post(session: Session, pathname: string, payload: Record<string, JsonValue>, key: string | null) {
    const headers: Record<string, string> = {
      host: host(),
      origin: `http://${host()}`,
      cookie: session.cookie,
      "content-type": "application/json",
      "x-csrf-token": session.csrf,
    };
    if (key !== null) headers["idempotency-key"] = key;
    return call("POST", pathname, { body: JSON.stringify(payload), headers });
  }

  function errorOf(text: string): { code: string; message: string; details: Record<string, unknown> } {
    return (JSON.parse(text) as { error: { code: string; message: string; details: Record<string, unknown> } }).error;
  }

  // A real candidate, from the real Builder, on a target this API itself declared. Seeding one by
  // hand would let the door pass against a row its own `candidates` read could not name.
  async function seeded(name: string): Promise<{ session: Session; projectId: Id; candidateId: Id; path: string }> {
    const session = await pairSession();
    const projectId = await freshProject(session, name);
    const declared = await post(session, `${API_PREFIX}/projects/${String(projectId)}/targets`, { kind: "url", url: "https://shop.example/cart" }, null);
    expect(declared.status, declared.text).toBe(201);
    const targetId = asId((targetCreatedSchema.parse(JSON.parse(declared.text) as JsonValue) as { id: string }).id);
    const verified = await seedVerifiedScenario({
      writer: worker.writeConnection,
      store: new ArtifactStore(dataDir),
      projectId,
      targetId,
      name,
    });
    return { session, projectId, candidateId: verified.candidateId, path: `${API_PREFIX}/projects/${String(projectId)}/verifications` };
  }


  it("queues a verification and answers 202 with the same record the job read gives", async () => {
    const fix = await seeded("verify-door-queued");
    const before = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/jobs`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(before.status, before.text).toBe(200);
    const beforeJobs = ((JSON.parse(before.text) as { items: { id: string }[] }).items ?? []).length;

    const asked = await post(fix.session, fix.path, { candidateId: fix.candidateId, comparatorPolicyId: "exact-http-v1" }, "verify-key-1");
    expect(asked.status, asked.text).toBe(202);
    const record = jobRecordSchema.safeParse(JSON.parse(asked.text) as JsonValue);
    if (!record.success) throw new Error(asked.text);
    expect(record.data.kind).toBe("verify");
    expect(record.data.state).toBe("queued");
    expect(record.data.resultRef).toBeNull();
    // §10: the report is the evaluator's to produce. A request that could put a row in
    // `verifications` would be a self-declared verdict wearing a job id.
    const stored = worker.writeConnection.transact((tx) => tx.getJob(fix.projectId, asId(record.data.id)));
    if (!stored.ok) throw new Error(JSON.stringify(stored.error));
    if (stored.value === null) throw new Error("the queued job is not in the store");
    expect(stored.value.state).toBe("queued");
    expect(stored.value.idempotencyKey).toBe("verify-key-1");

    // The same row through the read door, agreeing with what the request answered.
    const readBack = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/jobs/${String(record.data.id)}`, {
      headers: { host: host(), cookie: fix.session.cookie },
    });
    expect(readBack.status, readBack.text).toBe(200);
    expect(jobRecordSchema.parse(JSON.parse(readBack.text) as JsonValue)).toMatchObject({ id: record.data.id, kind: "verify", state: "queued" });

    const after = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/jobs`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(((JSON.parse(after.text) as { items: { id: string }[] }).items ?? []).length).toBe(beforeJobs + 1);
  });

  it("replays the key to the byte-identical answer and runs the command once", async () => {
    const fix = await seeded("verify-door-replay");
    const first = await post(fix.session, fix.path, { candidateId: fix.candidateId, comparatorPolicyId: "exact-http-v1" }, "verify-key-2");
    expect(first.status, first.text).toBe(202);
    const again = await post(fix.session, fix.path, { candidateId: fix.candidateId, comparatorPolicyId: "exact-http-v1" }, "verify-key-2");
    expect(again.status, again.text).toBe(202);
    expect(again.text).toBe(first.text);

    // One job row, and one journal entry for the decision: the HTTP journal answers the replay
    // without re-running the command, so a retried request cannot pile up queued work. The seed
    // itself leaves a `verify` job behind (it is the job the stored report was produced under), so
    // the count is of *queued* rows - the state this door is the only writer of.
    const jobs = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/jobs`, { headers: { host: host(), cookie: fix.session.cookie } });
    const verifyJobs = ((JSON.parse(jobs.text) as { items: { kind: string; state: string }[] }).items ?? []).filter(
      (job) => job.kind === "verify" && job.state === "queued",
    );
    expect(verifyJobs).toHaveLength(1);
    const audit = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/audit?limit=50`, { headers: { host: host(), cookie: fix.session.cookie } });
    const actions = ((JSON.parse(audit.text) as { entries?: { action: string }[] }).entries ?? []).map((entry) => entry.action);
    expect(actions.filter((action) => action === "verification.request")).toHaveLength(1);
  });

  it("takes the key before the body, and the session before both", async () => {
    const fix = await seeded("verify-door-gates");
    const noKey = await post(fix.session, fix.path, { candidateId: fix.candidateId, comparatorPolicyId: "exact-http-v1" }, null);
    expect(noKey.status, noKey.text).toBe(400);
    expect(errorOf(noKey.text).details["reason"]).toBe("idempotency-key-required");
    // The pipeline's own wording, not the worker's. Both owners refuse a keyless request with the
    // same code and reason, and that equivalence is exactly what a mutation exposed: with the
    // route's `requiresIdempotencyKey` flag switched off the request still came back 400, because
    // the command boundary refused it later. §14's gate order says the HTTP pipeline answers first.
    expect(errorOf(noKey.text).message).toBe("this creation needs an Idempotency-Key header");

    const anonymous = await call("POST", fix.path, {
      body: JSON.stringify({ candidateId: fix.candidateId, comparatorPolicyId: "exact-http-v1" }),
      headers: { host: host(), origin: `http://${host()}`, "content-type": "application/json", "idempotency-key": "verify-key-3" },
    });
    expect(anonymous.status, anonymous.text).toBe(401);

    const noCsrf = await call("POST", fix.path, {
      body: JSON.stringify({ candidateId: fix.candidateId, comparatorPolicyId: "exact-http-v1" }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: fix.session.cookie,
        "content-type": "application/json",
        "idempotency-key": "verify-key-3",
      },
    });
    expect(noCsrf.status, noCsrf.text).toBe(403);

    // After the key: a body that names a fourth field is refused by name (§8 offers no code, and
    // the schema has nowhere to put one).
    const smuggled = await post(fix.session, fix.path, { candidateId: fix.candidateId, comparatorPolicyId: "exact-http-v1", comparatorCode: "return a === b" }, "verify-key-4");
    expect(smuggled.status, smuggled.text).toBe(400);
    expect(JSON.stringify(errorOf(smuggled.text).details)).toContain("comparatorCode");
  });

  it("refuses a candidate it cannot name and a comparator it does not install", async () => {
    const fix = await seeded("verify-door-refused");
    const unknown = await post(fix.session, fix.path, { candidateId: newId(), comparatorPolicyId: "exact-http-v1" }, "verify-key-5");
    expect(unknown.status, unknown.text).toBe(404);
    expect(errorOf(unknown.text).details["reason"]).toBe("candidate-unknown");

    const notInstalled = await post(fix.session, fix.path, { candidateId: fix.candidateId, comparatorPolicyId: "close-enough-v0" }, "verify-key-6");
    expect(notInstalled.status, notInstalled.text).toBe(400);
    expect(errorOf(notInstalled.text).details["reason"]).toBe("comparator-policy-not-installed");

    // Neither refusal queued anything: the job page still holds only the rows the seed wrote.
    const jobs = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/jobs`, { headers: { host: host(), cookie: fix.session.cookie } });
    const queued = ((JSON.parse(jobs.text) as { items: { kind: string; state: string }[] }).items ?? []).filter(
      (job) => job.kind === "verify" && job.state === "queued",
    );
    expect(queued).toHaveLength(0);
  });
});


// §8 line 272 over HTTP: a multipart upload that atomically lands a file target, an inspect job and
// an owned staging lease, and answers 202 with `{targetId, job}`. The rig's provider is the recorded
// -shape MCP fixture, so the rows, the digests and the projections below are real while nothing here
// claims anything about REA itself (issue #14's split still holds: `capture.importHar` has never
// been driven against a live provider, and these tests do not change that).
describe("the import door (§8 line 272 / issue #58)", () => {
  const host = () => `127.0.0.1:${String(address.port)}`;
  type Session = { cookie: string; csrf: string };

  async function pairSession(): Promise<Session> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const issued = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    const cookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    return { cookie, csrf: issued.data?.csrfToken ?? issued.csrfToken ?? "" };
  }

  async function freshProject(session: Session, name: string): Promise<Id> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `create-project-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return asId((body.data?.id ?? body.id) as string);
  }

  const ASAR_EVIDENCE_ID = `ev_${"a".repeat(64)}`;
  const HAR_TEXT = JSON.stringify({ log: { version: "1.2", creator: { name: "fixture", version: "1" }, entries: [] } });
  const uploadPath = (projectId: Id) => `${API_PREFIX}/projects/${String(projectId)}/imports`;

  function formOf(fields: {
    bytes?: Uint8Array | string;
    filename?: string;
    mediaType?: string;
    kind?: string;
    deadlineAt?: string;
    sensitiveValues?: string[];
    extra?: Record<string, string>;
    fileAsText?: string;
    twoFiles?: boolean;
    noFile?: boolean;
  }): FormData {
    const form = new FormData();
    if (fields.noFile !== true) {
      if (fields.fileAsText !== undefined) {
        form.set("file", fields.fileAsText);
      } else {
        const bytes = typeof fields.bytes === "string" ? new TextEncoder().encode(fields.bytes) : (fields.bytes ?? new TextEncoder().encode(HAR_TEXT));
        const file = new File([bytes], fields.filename ?? "cart.har", { type: fields.mediaType ?? "application/json" });
        form.set("file", file);
        if (fields.twoFiles === true) form.append("file", new File([bytes], "second.har", { type: "application/json" }));
      }
    }
    if (fields.kind !== undefined) form.set("kind", fields.kind);
    if (fields.deadlineAt !== undefined) form.set("deadlineAt", fields.deadlineAt);
    for (const value of fields.sensitiveValues ?? []) form.append("sensitiveValues", value);
    for (const [name, value] of Object.entries(fields.extra ?? {})) form.set(name, value);
    return form;
  }

  function upload(session: Session, projectId: Id, form: FormData, key: string | null) {
    const headers: Record<string, string> = {
      host: host(),
      origin: `http://${host()}`,
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
    };
    if (key !== null) headers["idempotency-key"] = key;
    // No content-type is set on purpose: the platform's fetch writes the boundary, and a hand-made
    // header would test my guess about the framing instead of the parser meeting the encoder.
    return call("POST", uploadPath(projectId), { body: form, headers });
  }

  function reasonOf(text: string): Record<string, unknown> {
    return (JSON.parse(text) as { error: { details: Record<string, unknown> } }).error.details;
  }

  // Names anywhere under the data directory. Used to show a caller-named file was never created:
  // the assertion is about the absence of a name, so it has to walk the tree rather than trust a key.
  function walkNames(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      found.push(entry.name);
      if (entry.isDirectory()) found.push(...walkNames(path.join(dir, entry.name)));
    }
    return found;
  }

  function rowCount(table: string, projectId: Id): number {
    const outcome = worker.writeConnection.transact((tx) => tx.listJobsByStates(["queued", "running", "succeeded"], 10_000));
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    if (table === "jobs") return outcome.value.filter((job) => job.projectId === projectId).length;
    throw new Error(`unsupported table ${table}`);
  }

  it("lands the target, the job and the owned lease, and answers 202 with §8's two fields", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "import-happy");
    const uploaded = await upload(session, projectId, formOf({ kind: "har" }), "import-key-1");
    expect(uploaded.status, uploaded.text).toBe(202);
    const parsed = harImportHttpResponseSchema.safeParse(JSON.parse(uploaded.text) as JsonValue);
    if (!parsed.success) throw new Error(`${JSON.stringify(parsed.error.issues)}\n${uploaded.text}`);
    expect(parsed.data.job.kind).toBe("inspect");
    expect(parsed.data.job.state).toBe("queued");
    expect(parsed.data.job.cleanupState).toBe("pending");
    // §8's third column names exactly `{targetId,job}`: the lease and the source artifact the
    // service also minted are real, but they do not leave this door.
    expect(Object.keys(JSON.parse(uploaded.text) as Record<string, unknown>).sort()).toEqual(["job", "targetId"]);

    const targetId = asId(parsed.data.targetId);
    const target = worker.writeConnection.transact((tx) => tx.getTarget(projectId, targetId));
    if (!target.ok || target.value === null) throw new Error("the target row is missing");
    expect(target.value.kind).toBe("har");
    // §4: for a file target the snapshot identity is the content digest of what arrived.
    expect(target.value.snapshotDigest).toBe(digestBytes(new TextEncoder().encode(HAR_TEXT)));
    // A *file* target's locator is the display name the caller chose, run through the store's own
    // basename rule - this is the row, not the view (§5 keeps `locator` out of the view for every
    // kind, and the test below the door reads that separately).
    expect(target.value.originalLocator).toBe("cart.har");

    const job = worker.writeConnection.transact((tx) => tx.getJob(projectId, asId(parsed.data.job.id)));
    if (!job.ok || job.value === null) throw new Error("the job row is missing");
    expect(job.value.targetId).toBe(targetId);
    expect(job.value.idempotencyKey).toBe("import-key-1");

    // The lease is the third thing §8 line 272 says this call allocates, and §5 is what makes it
    // *owned*: a cleanup may only reclaim staging this workbench can show it minted.
    const lease = worker.writeConnection.transact((tx) => tx.getLeaseByJob(projectId, asId(parsed.data.job.id)));
    if (!lease.ok || lease.value === null) throw new Error("the staging lease is missing");
    expect(JSON.stringify(lease.value.ownershipProofJson)).toContain("har-import");

    const evidence = worker.writeConnection.transact((tx) => tx.listEvidenceIdsForTarget(projectId, targetId, 10));
    if (!evidence.ok) throw new Error(JSON.stringify(evidence.error));
    // Import stages and indexes; it does not decode. Evidence arrives with the inspection.
    expect(evidence.value).toEqual([]);
  });

  it("answers the same job the job read door reads (§8's one projection)", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "import-cross-door");
    const uploaded = await upload(session, projectId, formOf({ kind: "har" }), "import-key-2");
    const body = JSON.parse(uploaded.text) as { job: Record<string, unknown>; targetId: string };
    const read = await call("GET", `${uploadPath(projectId).replace("/imports", "")}/jobs/${String(body["job"]?.["id"])}`, {
      headers: { host: host(), cookie: session.cookie },
    });
    expect(read.status, read.text).toBe(200);
    expect(read.text).toBe(JSON.stringify(body["job"]));

    // And the target read door names the job it imported with.
    const targetRead = await call("GET", `${API_PREFIX}/projects/${String(projectId)}/targets/${body.targetId}`, {
      headers: { host: host(), cookie: session.cookie },
    });
    expect(targetRead.status, targetRead.text).toBe(200);
    const view = targetViewSchema.safeParse(JSON.parse(targetRead.text) as JsonValue);
    if (!view.success) throw new Error(targetRead.text);
    expect(view.data.importJobId).toBe(String(body["job"]?.["id"]));
    expect(view.data.evidenceIds).toEqual([]);
    expect(view.data.snapshotDigest).not.toBeNull();
  });

  it("replays the key to the same answer and imports once", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "import-replay");
    const first = await upload(session, projectId, formOf({ kind: "har" }), "import-key-3");
    expect(first.status, first.text).toBe(202);
    const jobs = rowCount("jobs", projectId);
    const again = await upload(session, projectId, formOf({ kind: "har" }), "import-key-3");
    expect(again.status, again.text).toBe(202);
    expect(again.text).toBe(first.text);
    expect(rowCount("jobs", projectId)).toBe(jobs);

    const audit = await call("GET", `${API_PREFIX}/projects/${String(projectId)}/audit?limit=50`, { headers: { host: host(), cookie: session.cookie } });
    const actions = ((JSON.parse(audit.text) as { entries?: { action: string }[] }).entries ?? []).map((entry) => entry.action);
    expect(actions.filter((action) => action === "har.import")).toHaveLength(1);

    // The same key with different bytes is a different request: §8 line 261 says 不同非敏感 payload
    // 返回 409, and the file's digest is the part that says which upload this is.
    const other = await upload(session, projectId, formOf({ kind: "har", bytes: '{"log":{"version":"1.2"}}' }), "import-key-3");
    expect(other.status, other.text).toBe(409);
    expect(reasonOf(other.text)["reason"]).toBe("idempotency-key-reused");
  });

  it("refuses a body that is not a single readable file part", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "import-shapes");

    const jsonBody = await call("POST", uploadPath(projectId), {
      body: JSON.stringify({ kind: "har" }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
        "idempotency-key": "import-key-4",
      },
    });
    expect(jsonBody.status, jsonBody.text).toBe(400);
    expect(reasonOf(jsonBody.text)["reason"]).toBe("import-multipart-required");

    const malformed = await call("POST", uploadPath(projectId), {
      body: "this is not multipart at all",
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "multipart/form-data; boundary=none",
        "idempotency-key": "import-key-5",
      },
    });
    expect(malformed.status, malformed.text).toBe(400);
    expect(reasonOf(malformed.text)["reason"]).toBe("import-multipart-malformed");

    for (const [fields, reason] of [
      [{ noFile: true }, "import-file-part-missing"],
      [{ fileAsText: "just a text field" }, "import-file-part-not-file"],
      [{ twoFiles: true }, "import-file-part-duplicated"],
    ] as const) {
      const refused = await upload(session, projectId, formOf(fields), `import-key-${reason}`);
      expect(refused.status, refused.text).toBe(400);
      expect(reasonOf(refused.text)["reason"]).toBe(reason);
    }
    expect(rowCount("jobs", projectId)).toBe(0);
  });

  it("refuses what §8 line 272 does not name, by name and without values", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "import-names");

    // The worker's own command accepts a `recordOrdinals` selection; this route's row does not
    // list it, so the door refuses it rather than becoming where undocumented fields arrive.
    const extra = await upload(session, projectId, formOf({ kind: "har", extra: { recordOrdinals: "1" } }), "import-key-6");
    expect(extra.status, extra.text).toBe(400);
    expect(reasonOf(extra.text)["rejectedKeys"]).toEqual(["recordOrdinals"]);

    const noKind = await upload(session, projectId, formOf({}), "import-key-7");
    expect(noKind.status, noKind.text).toBe(400);
    expect(JSON.stringify(reasonOf(noKind.text)["allowed"])).toContain("har");

    const wrongKind = await upload(session, projectId, formOf({ kind: "pcap" }), "import-key-8");
    expect(wrongKind.status, wrongKind.text).toBe(400);
    expect(reasonOf(wrongKind.text)["reason"]).toBe("import-kind-unsupported");

    const wrongMedia = await upload(session, projectId, formOf({ kind: "har", mediaType: "image/png" }), "import-key-9");
    expect(wrongMedia.status, wrongMedia.text).toBe(422);
    expect(reasonOf(wrongMedia.text)["mediaType"]).toBe("image/png");
    expect(JSON.stringify(reasonOf(wrongMedia.text)["allowed"])).toContain("application/x-ndjson");

    const badDeadline = await upload(session, projectId, formOf({ kind: "har", deadlineAt: "tomorrow" }), "import-key-10");
    expect(badDeadline.status, badDeadline.text).toBe(400);
    expect(reasonOf(badDeadline.text)["reason"]).toBe("import-deadline-malformed");
    // The rejected text is named as a shape, never echoed.
    expect(badDeadline.text).not.toContain("tomorrow");
  });

  it("ingests an ASAR upload the way §8 line 272 states it, and drives it to evidence (issue #113)", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "import-asar");
    const headers = { host: host(), origin: `http://${host()}`, cookie: session.cookie };
    const readTarget = async (targetId: string) => {
      const got = await call("GET", `${API_PREFIX}/projects/${String(projectId)}/targets/${targetId}`, { headers });
      expect(got.status, got.text).toBe(200);
      return targetViewSchema.parse(JSON.parse(got.text) as JsonValue);
    };

    const bare = await upload(
      session,
      projectId,
      formOf({ kind: "asar", filename: "app.asar", mediaType: "application/octet-stream" }),
      "import-key-11",
    );
    // This used to answer 503 `import-asar-not-wired`: the door named two kinds and only one of them
    // had an ingestion loop behind it, so F12's whole static branch could only ever be exercised by
    // a test that seeded its own envelope. §8 line 272's `kind:'har'|'asar'` is now literally true.
    expect(bare.status, bare.text).toBe(202);
    const receipt = harImportHttpResponseSchema.parse(JSON.parse(bare.text) as JsonValue);
    expect(receipt.job.kind).toBe("inspect");
    expect(receipt.job.state).toBe("queued");

    const before = await readTarget(receipt.targetId);
    expect(before.kind).toBe("asar");
    // §5 draws the line §4 does not: an archive is never captured, so it has a source digest and no
    // deployment snapshot - and the difference has to be readable, not inferred from a null.
    expect(before.sourceSha256).not.toBeNull();
    expect(before.snapshotDigest).toBeNull();
    expect(before.identityReason).toBe("file-import-without-capture");
    expect(before.evidenceIds).toEqual([]);

    // §8 line 272 names this 422 itself (ASAR 携带 sensitiveValues 返回 422, 不伪称上游支持), and it
    // is the answer the caller can act on, so it comes before "this build has no ASAR path at all".
    // §8 line 272's own 422 stays in front of everything: upstream has no sensitive projection for
    // this tool, and "remove the declaration" is a different instruction from "this path is missing".
    const declared = await upload(session, projectId, formOf({ kind: "asar", sensitiveValues: ["sesecret"] }), "import-key-12");
    expect(declared.status, declared.text).toBe(422);
    expect(reasonOf(declared.text)["reason"]).toBe("import-asar-sensitive-values-unsupported");
    expect(declared.text).not.toContain("sesecret");

    // §11's other half of #108: an ASAR row is an `inspect` row, so the same runner drives it, and
    // the tool it asks for is chosen by the stored target - not by anything a caller re-declares.
    for (let turns = 0; turns < 40; turns += 1) {
      const outcome = await worker.runJobs();
      if (!outcome.ok) throw new Error(`${outcome.error.code}:${outcome.error.reason}`);
      if (outcome.value.kind === "idle") break;
    }

    const job = jobRecordSchema.parse(JSON.parse((await call("GET", `${API_PREFIX}/projects/${String(projectId)}/jobs/${receipt.job.id}`, { headers })).text) as JsonValue);
    expect(job.state).toBe("succeeded");
    expect(job.resultRef).toBe(ASAR_EVIDENCE_ID);

    const after = await readTarget(receipt.targetId);
    expect(after.evidenceIds).toEqual([ASAR_EVIDENCE_ID]);

    // The envelope is about *this* archive: the producer's answer names the path the store minted, so
    // a fixture that echoed a recorded path could never satisfy this. Read back from disk, the same
    // bytes are still there and still hash to the target's source digest.
    const evidence = await call("GET", `${API_PREFIX}/projects/${String(projectId)}/evidence/${ASAR_EVIDENCE_ID}`, { headers });
    expect(evidence.status, evidence.text).toBe(200);
    const view = evidenceViewSchema.safeParse(JSON.parse(evidence.text) as JsonValue);
    if (!view.success) throw new Error(`the evidence route refused its own schema: ${evidence.text}`);
    const envelope = view.data.evidence as unknown as {
      operation: string;
      parameters: { input_path?: string | null; format?: string };
    };
    expect(envelope.operation).toBe("analyze_javascript_application");
    expect(envelope.parameters.format).toBe("asar");
    const namedPath = envelope.parameters.input_path;
    expect(typeof namedPath).toBe("string");
    const readBack = readFileSync(namedPath as string);
    expect(digestBytes(new Uint8Array(readBack))).toBe(after.sourceSha256);
  });

  it("measures the upload before it allocates: empty, oversized and beyond the transport", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "import-sizes");

    const empty = await upload(session, projectId, formOf({ kind: "har", bytes: new Uint8Array(0) }), "import-key-13");
    expect(empty.status, empty.text).toBe(400);
    expect(reasonOf(empty.text)["reason"]).toBe("import-file-empty");

    const oversize = new Uint8Array(MAX_UPLOAD_FILE_BYTES + 1).fill(97);
    const tooBig = await upload(session, projectId, formOf({ kind: "har", bytes: oversize }), "import-key-14");
    expect(tooBig.status, tooBig.text).toBe(413);
    const details = reasonOf(tooBig.text);
    expect(details["reason"]).toBe("import-file-too-large");
    // Both numbers, so the operator can decide instead of guessing which limit was hit.
    expect(details["byteLength"]).toBe(MAX_UPLOAD_FILE_BYTES + 1);
    expect(details["maxBytes"]).toBe(MAX_UPLOAD_FILE_BYTES);

    // Above the multipart budget the request never reaches any door: the transport counts while it
    // reads (§12), which is the only reason a 6 MiB body cannot become a 6 MiB allocation first.
    // Big enough that the *whole* multipart body passes the transport's own budget, so this is the
    // limit that answers first - and the door never runs.
    const huge = new Uint8Array(MAX_UPLOAD_FILE_BYTES + 1_600_000).fill(98);
    const overTransport = await upload(session, projectId, formOf({ kind: "har", bytes: huge }), "import-key-15");
    expect(overTransport.status, overTransport.text).toBe(413);
    expect(overTransport.text).toContain("body-too-large");

    expect(rowCount("jobs", projectId)).toBe(0);
  });

  it("treats the filename as display text and the declaration as short-lived", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "import-names-are-text");

    const traversing = await upload(session, projectId, formOf({ kind: "har", filename: "../../../../etc/passwd" }), "import-key-16");
    expect(traversing.status, traversing.text).toBe(202);
    const targetId = asId((JSON.parse(traversing.text) as { targetId: string }).targetId);
    const target = worker.writeConnection.transact((tx) => tx.getTarget(projectId, targetId));
    if (!target.ok || target.value === null) throw new Error("the target row is missing");
    const sourceArtifactId = target.value.sourceArtifactId;
    if (sourceArtifactId === null) throw new Error("the target names no source artifact");
    const artifact = worker.writeConnection.transact((tx) => tx.getArtifact(projectId, sourceArtifactId));
    if (!artifact.ok || artifact.value === null) throw new Error("the artifact row is missing");
    // The stored key is content-addressed inside the project, and the name the caller typed is not
    // in it - which is the checkable form of §5's "the bytes arrive here, the name is display text".
    expect(artifact.value.storageKey).toBe(`projects/${String(projectId)}/artifacts/inspector/${artifact.value.sha256}.bin`);
    expect(artifact.value.storageKey).not.toContain("passwd");
    expect(walkNames(dataDir).some((name) => name.includes("passwd"))).toBe(false);

    // A declared value that also appears in the filename is refused by the diagnostic filter, and
    // the answer never repeats the value (§5: 声明只在任务内存; §12.1 publishes names, not values).
    const leaked = await upload(session, projectId, formOf({ kind: "har", filename: "sesecret-cart.har", sensitiveValues: ["sesecret"] }), "import-key-17");
    expect(leaked.status, leaked.text).toBe(422);
    expect(leaked.text).not.toContain("sesecret");
    expect(reasonOf(leaked.text)["reason"]).not.toBeUndefined();
    // And the refused upload left nothing behind.
    expect(rowCount("jobs", projectId)).toBe(1);
  });

  // The reason this route reads `bodyBytes` and not `body`: a file part is arbitrary bytes, and
  // every sequence that is not valid UTF-8 would already be a replacement character by the time a
  // text view reached the worker. §8 line 272's `application/octet-stream` is that case by name.
  it("carries a binary upload through without rewriting it", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "import-binary");
    const raw = new Uint8Array(65_536);
    for (let index = 0; index < raw.length; index += 1) raw[index] = index % 256;
    const uploaded = await upload(session, projectId, formOf({ kind: "har", bytes: raw, mediaType: "application/octet-stream", filename: "sample.asar-ish.bin" }), "import-key-binary");
    expect(uploaded.status, uploaded.text).toBe(202);
    const targetId = asId((JSON.parse(uploaded.text) as { targetId: string }).targetId);
    const target = worker.writeConnection.transact((tx) => tx.getTarget(projectId, targetId));
    if (!target.ok || target.value === null) throw new Error("the target row is missing");
    // The digest the store holds is the digest of the bytes that were sent - not of the text they
    // would have become, which is the difference between an archive and a guess about one.
    expect(target.value.sourceSha256).toBe(digestBytes(raw));
    expect(target.value.snapshotDigest).toBe(digestBytes(raw));
    const sourceArtifactId = target.value.sourceArtifactId;
    if (sourceArtifactId === null) throw new Error("the target names no source artifact");
    const artifact = worker.writeConnection.transact((tx) => tx.getArtifact(projectId, sourceArtifactId));
    if (!artifact.ok || artifact.value === null) throw new Error("the artifact row is missing");
    expect(artifact.value.byteLength).toBe(raw.byteLength);
    expect(artifact.value.mediaType).toBe("application/octet-stream");
  });

  // §12.1: a declared value is filtered out of every message, detail and log line the request can
  // produce. This door's own refusal repeats the media type it rejected, so a caller who declared
  // that string as sensitive has to be able to trust it does not come back.
  it("never echoes a value the caller declared sensitive", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "import-echo");
    const refusedUpload = await upload(session, projectId, formOf({
      kind: "har",
      mediaType: "image/png",
      sensitiveValues: ["image/png"],
    }), "import-key-echo");
    expect(refusedUpload.status, refusedUpload.text).toBeLessThan(500);
    expect(refusedUpload.text).not.toContain("image/png");
  });

  it("keeps §14's gate order in front of the upload", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "import-gates");

    const anonymous = await call("POST", uploadPath(projectId), {
      body: formOf({ kind: "har" }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(anonymous.status, anonymous.text).toBe(401);

    const noCsrf = await call("POST", uploadPath(projectId), {
      body: formOf({ kind: "har" }),
      headers: { host: host(), origin: `http://${host()}`, cookie: session.cookie, "idempotency-key": "import-key-18" },
    });
    expect(noCsrf.status, noCsrf.text).toBe(403);

    const noKey = await upload(session, projectId, formOf({ kind: "har" }), null);
    expect(noKey.status, noKey.text).toBe(400);
    expect(reasonOf(noKey.text)["reason"]).toBe("idempotency-key-required");
    // The key's own wording belongs to the pipeline, not to the worker behind it.
    expect((JSON.parse(noKey.text) as { error: { message: string } }).error.message).toBe("this creation needs an Idempotency-Key header");

    const unknownProject = await upload(session, asId(newId()), formOf({ kind: "har" }), "import-key-19");
    expect(unknownProject.status, unknownProject.text).toBe(404);
  });

  it("drives the row this door queued, and the evidence door then answers it (§8 lines 272+276+281 / issue #108)", async () => {
    // The upload door has been here since round seven and the executor since PR #109; this case is the
    // one that goes through **this** transport for both halves, so the queued row a browser leaves
    // behind is proven drivable from the same side a browser sits on - not only from `worker.dispatch`.
    const session = await pairSession();
    const projectId = await freshProject(session, "import-driven");
    const declared = "sesame-driven-value";
    const uploaded = await upload(session, projectId, formOf({ kind: "har", sensitiveValues: [declared] }), "import-driven-1");
    expect(uploaded.status, uploaded.text).toBe(202);
    const receipt = harImportHttpResponseSchema.parse(JSON.parse(uploaded.text) as JsonValue);
    const jobId = asId(receipt.job.id);
    // The fixture's own evidence id, named here rather than read out of the reply: §8 line 281 is
    // addressed by id, and the row's `resultRef` is the field that has to agree with it.
    const evidenceId = `ev_${"a".repeat(64)}`;
    const evidencePath = `${API_PREFIX}/projects/${String(projectId)}/evidence/${evidenceId}`;
    const headers = { host: host(), origin: `http://${host()}`, cookie: session.cookie };

    // Before the runner looks at it the door says "no such evidence" - and it says that sentence, not a
    // generic failure, so "not yet" stays distinguishable from "not yours".
    const before = await call("GET", evidencePath, { headers });
    expect(before.status, before.text).toBe(404);
    expect(((JSON.parse(before.text) as { error: { details: Record<string, unknown> } }).error.details)["reason"]).toBe("evidence-unknown");

    for (let turns = 0; turns < 40; turns += 1) {
      const outcome = await worker.runJobs();
      if (!outcome.ok) throw new Error(`${outcome.error.code}:${outcome.error.reason}`);
      if (outcome.value.kind === "idle") break;
    }

    const readBack = await call("GET", `${API_PREFIX}/projects/${String(projectId)}/jobs/${String(jobId)}`, { headers });
    expect(readBack.status, readBack.text).toBe(200);
    const row = jobRecordSchema.parse(JSON.parse(readBack.text) as JsonValue);
    expect(row.state).toBe("succeeded");
    expect(row.resultRef).toBe(evidenceId);
    expect(row.cleanupState).toBe("complete");
    expect(row.error).toBeNull();

    const after = await call("GET", evidencePath, { headers });
    expect(after.status, after.text).toBe(200);
    const view = evidenceViewSchema.safeParse(JSON.parse(after.text) as JsonValue);
    if (!view.success) throw new Error(`the evidence route refused its own schema: ${after.text}`);
    expect((view.data.evidence as unknown as { evidence_id: string }).evidence_id).toBe(evidenceId);
    // And the literal this caller declared is not in the body the door just handed back.
    expect(after.text).not.toContain(declared);
  });

});

// §8 line 294 over HTTP (issue #57). This rig declares no model endpoint, so the happy path is the
// worker's own integration file and what is proved here is the door: §14's gate order in front of it,
// a body that cannot carry the worker's facts, and the capability refusal arriving as the named 503
// rather than as a 202 with an invented job or a 404 with a swallowed reason.
describe("the generation door (§8 line 294 / issue #57)", () => {
  const host = () => `127.0.0.1:${String(address.port)}`;
  type Session = { cookie: string; csrf: string };

  async function pairSession(): Promise<Session> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const issued = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    const cookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    return { cookie, csrf: issued.data?.csrfToken ?? issued.csrfToken ?? "" };
  }

  async function freshProject(session: Session, name: string): Promise<Id> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `create-project-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return asId((body.data?.id ?? body.id) as string);
  }

  function door(projectId: Id): string {
    return `${API_PREFIX}/projects/${String(projectId)}/candidates`;
  }

  function ask(session: Session, projectId: Id, payload: JsonValue, key: string | null) {
    const headers: Record<string, string> = {
      host: host(),
      origin: `http://${host()}`,
      cookie: session.cookie,
      "content-type": "application/json",
      "x-csrf-token": session.csrf,
    };
    if (key !== null) headers["idempotency-key"] = key;
    return call("POST", door(projectId), { body: JSON.stringify(payload), headers });
  }

  function refusal(text: string): { code: string; message: string; details: Record<string, unknown> } {
    return (JSON.parse(text) as { error: { code: string; message: string; details: Record<string, unknown> } }).error;
  }

  it("answers the anonymous, the wrong-origin and the unkeyed before anything is read", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "generate-gates");

    const anonymous = await call("POST", door(projectId), {
      body: JSON.stringify({ blueprintId: newId() }),
      headers: { host: host(), origin: `http://${host()}`, "content-type": "application/json", "idempotency-key": "generate-key-1" },
    });
    expect(anonymous.status, anonymous.text).toBe(401);

    const noCsrf = await call("POST", door(projectId), {
      body: JSON.stringify({ blueprintId: newId() }),
      headers: { host: host(), origin: `http://${host()}`, cookie: session.cookie, "content-type": "application/json", "idempotency-key": "generate-key-2" },
    });
    expect(noCsrf.status, noCsrf.text).toBe(403);

    const noKey = await ask(session, projectId, { blueprintId: newId() }, null);
    expect(noKey.status, noKey.text).toBe(400);
    expect(refusal(noKey.text).details["reason"]).toBe("idempotency-key-required");
  });

  it("refuses a body that names the facts the worker owns, and names what it rejected", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "generate-shape");
    const forged = await ask(session, projectId, { blueprintId: newId(), jobId: newId(), budget: { maxAttemptsPerBlueprint: 4 } }, "generate-key-3");
    expect(forged.status, forged.text).toBe(400);
    const details = JSON.stringify(refusal(forged.text).details);
    expect(details).toContain("jobId");
    expect(details).toContain("budget");
  });

  it("keeps a malformed deadline out of the worker and reports the field", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "generate-deadline");
    const malformed = await ask(session, projectId, { blueprintId: newId(), deadlineAt: "tomorrow-ish" }, "generate-key-4");
    expect(malformed.status, malformed.text).toBe(400);
    expect(JSON.stringify(refusal(malformed.text).details)).toContain("deadlineAt");
  });

  it("relays the deployment's own capability refusal instead of inventing a job", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "generate-off");
    const asked = await ask(session, projectId, { blueprintId: newId() }, "generate-key-5");
    expect(asked.status, asked.text).toBe(503);
    expect(refusal(asked.text).details["reason"]).toBe("generation-endpoint-not-configured");
    // Nothing was created: the project's job page is still empty, so a refusal cannot leave a
    // half-made row behind (§10: 一次请求不产出结论，被拒的请求连作业都不排).
    const page = await call("GET", `${API_PREFIX}/projects/${String(projectId)}/jobs`, { headers: { host: host(), cookie: session.cookie } });
    expect(page.status, page.text).toBe(200);
    const listed = (JSON.parse(page.text) as { data?: { items?: unknown[] } }).data ?? (JSON.parse(page.text) as { items?: unknown[] });
    expect(listed.items ?? []).toEqual([]);
  });
});

// §8 line 275 over HTTP: the last row in the document's table, and the only creation whose body is a
// *task* rather than a reference. The tests below are grouped by the owner of each rule, because the
// door has several: the key belongs to the journal, the shape to the schema, the scope and the budget
// to the service, and the secret to §12.1.
describe("the job request door (§8 line 275 / issue #58)", () => {
  const host = () => `127.0.0.1:${String(address.port)}`;
  type Session = { cookie: string; csrf: string };

  async function pairSession(): Promise<Session> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const issued = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    const cookie = (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    return { cookie, csrf: issued.data?.csrfToken ?? issued.csrfToken ?? "" };
  }

  async function freshProject(session: Session, name: string): Promise<Id> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `create-project-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return asId((body.data?.id ?? body.id) as string);
  }

  function post(session: Session, pathname: string, payload: Record<string, JsonValue>, key: string | null) {
    const headers: Record<string, string> = {
      host: host(),
      origin: `http://${host()}`,
      cookie: session.cookie,
      "content-type": "application/json",
      "x-csrf-token": session.csrf,
    };
    if (key !== null) headers["idempotency-key"] = key;
    return call("POST", pathname, { body: JSON.stringify(payload), headers });
  }

  function errorOf(text: string): { code: string; message: string; details: Record<string, unknown> } {
    return (JSON.parse(text) as { error: { code: string; message: string; details: Record<string, unknown> } }).error;
  }

  async function urlTarget(session: Session, projectId: Id, url = "https://shop.example/cart"): Promise<Id> {
    const declared = await post(session, `${API_PREFIX}/projects/${String(projectId)}/targets`, { kind: "url", url }, null);
    expect(declared.status, declared.text).toBe(201);
    return asId((targetCreatedSchema.parse(JSON.parse(declared.text) as JsonValue) as { id: string }).id);
  }

  // A capture task in the shape §8's paragraph under the table draws. `profileId` names the one
  // profile this rig installs, and the start URL is the declared target's own host.
  function captureTask(targetUrl = "https://shop.example/cart"): Record<string, JsonValue> {
    return {
      kind: "capture",
      profileId: "har-capture",
      scenario: { startUrl: targetUrl, actions: [{ kind: "click", locator: { kind: "testId", value: "add-to-cart" } }] },
      network: { requestBody: true, responseBody: true, headerValues: false },
    };
  }

  function inspectTask(claimIds: string[] = [], question = "does the cart route answer with the include set?"): Record<string, JsonValue> {
    return { kind: "inspect", claimIds, question, scope: "static" };
  }

  async function rig(name: string, url = "https://shop.example/cart"): Promise<{ session: Session; projectId: Id; targetId: Id; path: string }> {
    const session = await pairSession();
    const projectId = await freshProject(session, name);
    const targetId = await urlTarget(session, projectId, url);
    return { session, projectId, targetId, path: `${API_PREFIX}/projects/${String(projectId)}/jobs` };
  }

  // A file target on the same project, written through the only owner of target rows: §5's table
  // requires a target to carry either a measured snapshot or a stated identity reason, so an
  // "imported bytes" row here is one that has been digested.
  function fileTarget(projectId: Id): Id {
    const targetId = newId();
    const seeded = worker.writeConnection.transact((tx) => {
      tx.insertTarget({
        id: targetId,
        projectId,
        kind: "har",
        originalLocator: null,
        sourceSha256: null,
        sourceArtifactId: null,
        snapshotDigest: asDigest(hex(`job-door-file-${String(targetId)}`)),
        identityReason: null,
        createdAt: nowInstant(),
      });
      return true;
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    return targetId;
  }

  function claimRow(projectId: Id, targetId: Id): Id {
    const claimId = newId();
    const seeded = worker.writeConnection.transact((tx) => {
      tx.insertClaim({
        id: claimId,
        projectId,
        targetId,
        entityKey: "GET /api/cart",
        claimKey: "route-exists",
        assertion: "the cart route answers",
        scopeJson: { sourceEvidenceIds: [] },
        basis: "observed",
        sourceState: null,
        coverageJson: { state: "unknown", examined: null, total: null, reasons: [] },
        validity: "current",
        revision: 1,
        unknownReasonsJson: [],
      });
      return true;
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    return claimId;
  }

  function queuedJob(projectId: Id, jobId: Id): { inputJson: JsonValue; requestDigest: string; targetId: Id | null; kind: string; state: string } | null {
    const read = worker.writeConnection.transact((tx) => tx.getJob(projectId, jobId));
    if (!read.ok) throw new Error(JSON.stringify(read.error));
    return read.value as unknown as ReturnType<typeof queuedJob>;
  }

  function eventCount(projectId: Id): number {
    const read = worker.writeConnection.transact((tx) => tx.eventsAfter(projectId, 0, 50));
    if (!read.ok) throw new Error(JSON.stringify(read.error));
    return read.value.length;
  }

  it("queues a capture against the declared URL target and answers 202 with the row and its Location", async () => {
    const fix = await rig("job-door-capture");
    const asked = await post(fix.session, fix.path, { targetId: fix.targetId, expectedGraphRevision: 0, task: captureTask() }, "job-key-capture");
    expect(asked.status, asked.text).toBe(202);
    const record = jobRecordSchema.safeParse(JSON.parse(asked.text) as JsonValue);
    if (!record.success) throw new Error(asked.text);
    expect(record.data.kind).toBe("capture");
    expect(record.data.state).toBe("queued");
    expect(record.data.resultRef).toBeNull();
    // §14: the deadline is the installed profile's queue wait, not a number this file or the door
    // invented - so an absent `deadlineAt` still produces a real, bounded one.
    expect(record.data.deadlineAt).not.toBeNull();

    // §8's third column names a `Location` header, and it must address the very row in the body.
    const location = asked.headers.get("location") ?? "";
    expect(location).toBe(`${API_PREFIX}/projects/${String(fix.projectId)}/jobs/${String(record.data.id)}`);
    const readBack = await call("GET", location, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(readBack.status, readBack.text).toBe(200);
    expect(jobRecordSchema.parse(JSON.parse(readBack.text) as JsonValue)).toEqual(record.data);

    const row = queuedJob(fix.projectId, asId(record.data.id));
    expect(row?.targetId).toBe(fix.targetId);
    expect(row?.kind).toBe("capture");
    // The outbox carries the queueing, so the page's stream can show this row move without a reload.
    expect(eventCount(fix.projectId)).toBe(1);
  });

  it("honours an explicit deadline instead of overwriting it with the profile's wait", async () => {
    const fix = await rig("job-door-deadline");
    const stated = new Date(Date.now() + 600_000).toISOString();
    const asked = await post(fix.session, fix.path, { targetId: fix.targetId, expectedGraphRevision: 0, deadlineAt: stated, task: captureTask() }, "job-key-deadline");
    expect(asked.status, asked.text).toBe(202);
    expect(jobRecordSchema.parse(JSON.parse(asked.text) as JsonValue).deadlineAt).toBe(stated);
  });

  it("replays one key to the same row, the same Location and no second event", async () => {
    const fix = await rig("job-door-replay");
    const body = { targetId: fix.targetId, expectedGraphRevision: 0, task: captureTask() };
    const first = await post(fix.session, fix.path, body, "job-key-replay");
    const second = await post(fix.session, fix.path, body, "job-key-replay");
    expect(first.status, first.text).toBe(202);
    expect(second.status, second.text).toBe(202);
    expect(JSON.parse(second.text)).toEqual(JSON.parse(first.text));
    // A replay answers the header too: the journal stored the body, and the address is derived from
    // it, so the two cannot name different rows.
    expect(second.headers.get("location")).toBe(first.headers.get("location"));
    const page = await call("GET", fix.path, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(((JSON.parse(page.text) as { items: unknown[] }).items ?? []).length).toBe(1);
    expect(eventCount(fix.projectId)).toBe(1);
  });

  it("refuses the same key carrying a different task, and asks for the key when none is sent", async () => {
    const fix = await rig("job-door-divergent");
    const first = await post(fix.session, fix.path, { targetId: fix.targetId, expectedGraphRevision: 0, task: captureTask() }, "job-key-divergent");
    expect(first.status, first.text).toBe(202);
    const other = await post(fix.session, fix.path, { targetId: fix.targetId, expectedGraphRevision: 0, task: inspectTask() }, "job-key-divergent");
    expect(other.status, other.text).toBe(409);
    expect(errorOf(other.text).details["reason"]).toBe("idempotency-key-reused");

    const noKey = await post(fix.session, fix.path, { targetId: fix.targetId, expectedGraphRevision: 0, task: captureTask() }, null);
    expect(noKey.status, noKey.text).toBe(400);
    expect(errorOf(noKey.text).details["reason"]).toBe("idempotency-key-required");
  });

  // §12.1: 认证与显式敏感原文不进入持久 request_digest. Two requests that differ *only* in their
  // short-lived secrets are the same safe request, so they are the same job - and nothing in the row
  // remembers the secret. This is the pair that makes both halves readable at once: a digest that
  // included the secret would answer 409 here, and a stored input that included it would show up below.
  it("keeps a capture's sensitive values out of the stored row and out of both digests", async () => {
    const fix = await rig("job-door-secrets");
    const withSecret = { ...captureTask(), sensitiveValues: ["hunter2-session-token"] } as Record<string, JsonValue>;
    const first = await post(fix.session, fix.path, { targetId: fix.targetId, expectedGraphRevision: 0, task: withSecret }, "job-key-secrets");
    expect(first.status, first.text).toBe(202);
    const again = await post(fix.session, fix.path, { targetId: fix.targetId, expectedGraphRevision: 0, task: { ...captureTask(), sensitiveValues: ["different-secret"] } }, "job-key-secrets");
    expect(again.status, again.text).toBe(202);
    expect(JSON.parse(again.text)).toEqual(JSON.parse(first.text));

    const record = jobRecordSchema.parse(JSON.parse(first.text) as JsonValue);
    const row = queuedJob(fix.projectId, asId(record.id));
    const persisted = JSON.stringify(row?.inputJson ?? {});
    expect(persisted).not.toContain("hunter2-session-token");
    expect(persisted).not.toContain("different-secret");
    // The task itself is still there in the half that may be written down, so an executor can act.
    expect(persisted).toContain("add-to-cart");

    // The replay above was answered by the journal, which never reached the row's own digest column.
    // A second key does: §12.1 says 显式敏感原文不进入持久 request_digest, so two rows asked for the
    // same work under two different secrets have to store the *same* digest. A digest that covered
    // the secret would split them, and the split is the leak wearing a hash.
    const separate = await post(fix.session, fix.path, { targetId: fix.targetId, expectedGraphRevision: 0, task: { ...captureTask(), sensitiveValues: ["third-secret"] } }, "job-key-secrets-separate");
    expect(separate.status, separate.text).toBe(202);
    const firstId = asId(jobRecordSchema.parse(JSON.parse(first.text) as JsonValue).id);
    const separateId = asId(jobRecordSchema.parse(JSON.parse(separate.text) as JsonValue).id);
    expect(separateId).not.toBe(firstId);
    expect(queuedJob(fix.projectId, separateId)?.requestDigest).toBe(row?.requestDigest);
  });

  it("answers a moved graph with the two revisions it compared", async () => {
    const fix = await rig("job-door-stale");
    const stale = await post(fix.session, fix.path, { targetId: fix.targetId, expectedGraphRevision: 7, task: captureTask() }, "job-key-stale");
    expect(stale.status, stale.text).toBe(409);
    const refusal = errorOf(stale.text);
    expect(refusal.code).toBe("REVISION_CONFLICT");
    expect(refusal.details["reason"]).toBe("graph-revision-changed");
    expect(refusal.details["expected"]).toBe(7);
    expect(refusal.details["actual"]).toBe(0);
    expect(eventCount(fix.projectId)).toBe(0);
  });

  it("keeps each half of the task union on the kind of target §8 names", async () => {
    const fix = await rig("job-door-kinds");
    const inspectOnUrl = await post(fix.session, fix.path, { targetId: fix.targetId, expectedGraphRevision: 0, task: inspectTask() }, "job-key-inspect-url");
    expect(inspectOnUrl.status, inspectOnUrl.text).toBe(400);
    expect(errorOf(inspectOnUrl.text).details["reason"]).toBe("inspect-needs-file-target");

    // A file target on the same project: §8 puts an inspect on imported bytes, and a capture on a URL.
    const file = fileTarget(fix.projectId);
    const captureOnFile = await post(fix.session, fix.path, { targetId: file, expectedGraphRevision: 0, task: captureTask() }, "job-key-capture-file");
    expect(captureOnFile.status, captureOnFile.text).toBe(400);
    expect(errorOf(captureOnFile.text).details["reason"]).toBe("capture-needs-url-target");
  });

  it("refuses a capture that jumps to another host, and names nothing but the rule", async () => {
    const fix = await rig("job-door-scope");
    const jumped = await post(fix.session, fix.path, { targetId: fix.targetId, expectedGraphRevision: 0, task: captureTask("https://other.example/cart") }, "job-key-jump");
    expect(jumped.status, jumped.text).toBe(403);
    expect(errorOf(jumped.text).details["reason"]).toBe("start-url-outside-target-scope");
    // The two hostnames stay out of the answer (§12.1), and no row was made.
    expect(jumped.text).not.toContain("other.example");
    expect(jumped.text).not.toContain("shop.example");
    const page = await call("GET", fix.path, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(((JSON.parse(page.text) as { items: unknown[] }).items ?? []).length).toBe(0);
  });

  it("refuses a task that names a profile nobody installed, before any row exists", async () => {
    const fix = await rig("job-door-profile");
    const unknown = await post(fix.session, fix.path, {
      targetId: fix.targetId,
      expectedGraphRevision: 0,
      task: { ...captureTask(), profileId: "made-up-profile" },
    }, "job-key-profile");
    expect(unknown.status, unknown.text).toBe(503);
    expect(errorOf(unknown.text).details["reason"]).toBe("task-profile-not-installed");
    const page = await call("GET", fix.path, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(((JSON.parse(page.text) as { items: unknown[] }).items ?? []).length).toBe(0);
  });

  it("lets an inspect name only claims the project already holds, and only skip the list on a first read", async () => {
    const fix = await rig("job-door-claims");
    const file = fileTarget(fix.projectId);
    const invented = newId();
    const unknownClaim = await post(fix.session, fix.path, { targetId: file, expectedGraphRevision: 0, task: inspectTask([invented]) }, "job-key-unknown-claim");
    expect(unknownClaim.status, unknownClaim.text).toBe(404);
    expect(errorOf(unknownClaim.text).details["reason"]).toBe("claim-unknown");

    // One claim row makes this target no longer a first analysis, so an empty list stops being legal.
    const claimId = claimRow(fix.projectId, file);
    const empty = await post(fix.session, fix.path, { targetId: file, expectedGraphRevision: 0, task: inspectTask() }, "job-key-empty-claims");
    expect(empty.status, empty.text).toBe(400);
    expect(errorOf(empty.text).details["reason"]).toBe("directed-inspect-needs-claims");

    const directed = await post(fix.session, fix.path, { targetId: file, expectedGraphRevision: 0, task: inspectTask([claimId]) }, "job-key-directed");
    expect(directed.status, directed.text).toBe(202);
    expect(jobRecordSchema.parse(JSON.parse(directed.text) as JsonValue).kind).toBe("inspect");

    // And the first analysis is still legal where nothing has been claimed yet: the rule is about this
    // target's claims, not about the project having any.
    const second = fileTarget(fix.projectId);
    const firstRead = await post(fix.session, fix.path, { targetId: second, expectedGraphRevision: 0, task: inspectTask() }, "job-key-first-read");
    expect(firstRead.status, firstRead.text).toBe(202);
  });

  it("refuses the fields §8 does not list on this route, by name", async () => {
    const fix = await rig("job-door-shape");
    const forged = await post(fix.session, fix.path, {
      targetId: fix.targetId,
      expectedGraphRevision: 0,
      // Both of these are the shape of the request the closed command table used to take from a
      // caller (issue #57): a job id and an attempt budget. Neither is in §8's line 275.
      jobId: newId(),
      maxAttempts: 3,
      task: captureTask(),
    }, "job-key-forged");
    expect(forged.status, forged.text).toBe(400);
    expect(JSON.stringify(errorOf(forged.text).details)).toContain("jobId");
    expect(JSON.stringify(errorOf(forged.text).details)).toContain("maxAttempts");

    const unknownAction = await post(fix.session, fix.path, {
      targetId: fix.targetId,
      expectedGraphRevision: 0,
      task: { ...captureTask(), scenario: { startUrl: "https://shop.example/cart", actions: [{ kind: "eval", script: "window.x = 1" }] } },
    }, "job-key-js");
    expect(unknownAction.status, unknownAction.text).toBe(400);
    expect(unknownAction.text).not.toContain("window.x");
  });

  it("refuses a target this project does not have", async () => {
    const fix = await rig("job-door-target");
    const missingTarget = await post(fix.session, fix.path, { targetId: newId(), expectedGraphRevision: 0, task: captureTask() }, "job-key-no-target");
    expect(missingTarget.status, missingTarget.text).toBe(404);
    expect(errorOf(missingTarget.text).details["reason"]).toBe("target-unknown");
  });

  // The page and the door have to agree, and a unit test of the page's builders cannot prove it: the
  // draft is built out of three replies, and only this socket decides what they say. So the reads the
  // browser makes are made here for real, fed through the same owners the component calls, and what
  // comes out is sent. A body the door refuses is a page that can only ever be refused.
  it("accepts the body the page's own draft builders produce from the three reads it makes", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "job-door-page-draft");
    const file = fileTarget(projectId);
    const claimId = claimRow(projectId, file);

    const projectRead = await call("GET", `${API_PREFIX}/projects/${String(projectId)}`, { headers: { host: host(), cookie: session.cookie } });
    expect(projectRead.status, projectRead.text).toBe(200);
    const graphRead = await call("GET", `${API_PREFIX}/projects/${String(projectId)}/graph`, { headers: { host: host(), cookie: session.cookie } });
    expect(graphRead.status, graphRead.text).toBe(200);
    const targetRead = await call("GET", `${API_PREFIX}/projects/${String(projectId)}/targets/${String(file)}`, { headers: { host: host(), cookie: session.cookie } });
    expect(targetRead.status, targetRead.text).toBe(200);

    const graph = relayData(JSON.parse(graphRead.text) as JsonValue) as { targetId: string | null; claims: { claimId: string }[] };
    const project = relayData(JSON.parse(projectRead.text) as JsonValue) as { graphRevision: number };
    const facts = { targetId: graph.targetId, claimIds: graph.claims.map((claim) => claim.claimId) };
    const target = inspectTargetReadOf(JSON.parse(targetRead.text) as JsonValue, file);

    const subject = inspectSubjectOf({ graph: facts, target, graphRevision: project.graphRevision });
    expect(subject.ok).toBe(true);
    if (!subject.ok) return;
    // Reading the door's own inputs back: the graph named the imported target, the row said which kind,
    // and the claim this rig wrote is one the page can actually check.
    expect(subject.targetId).toBe(file);
    expect(subject.claimIds).toContain(claimId);

    const draft = inspectDraftOf({
      csrf: session.csrf,
      graph: facts,
      target,
      graphRevision: project.graphRevision,
      chosen: [claimId],
      question: "这个响应在什么条件下会缺字段",
      scope: "captured-runtime",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const asked = await post(session, `${API_PREFIX}/projects/${String(projectId)}/jobs`, draft.body as unknown as Record<string, JsonValue>, "job-key-page-draft");
    expect(asked.status, asked.text).toBe(202);
    const record = jobRecordSchema.safeParse(relayData(JSON.parse(asked.text) as JsonValue));
    if (!record.success) throw new Error(asked.text);
    expect(record.data.kind).toBe("inspect");
    expect(record.data.state).toBe("queued");

    // The row carries the question and the claim the operator chose, so what an executor will read is
    // what this page asked - not a body the door reinterpreted.
    const row = queuedJob(projectId, asId(record.data.id));
    expect(JSON.stringify(row?.inputJson)).toContain(claimId);
    expect(JSON.stringify(row?.inputJson)).toContain("这个响应在什么条件下会缺字段");
  });

  // The other half of the same reconciliation: a *legal-looking* page state that the door would refuse
  // must not be reachable from the builders. This is the state a stale graph read leaves behind - the
  // operator checked a claim the current view no longer names.
  it("does not let the page send an inspect against the URL target the graph may name", async () => {
    const fix = await rig("job-door-page-url-target");
    const graphRead = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/graph`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(graphRead.status, graphRead.text).toBe(200);
    const graph = relayData(JSON.parse(graphRead.text) as JsonValue) as { targetId: string | null; claims: { claimId: string }[] };
    const targetRead = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/targets/${String(fix.targetId)}`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(targetRead.status, targetRead.text).toBe(200);

    const facts = { targetId: fix.targetId, claimIds: graph.claims.map((claim) => claim.claimId) };
    const target = inspectTargetReadOf(JSON.parse(targetRead.text) as JsonValue, fix.targetId);
    expect(target).toEqual({ ok: true, kind: "url", snapshotDigest: null });
    const draft = inspectDraftOf({
      csrf: fix.session.csrf,
      graph: facts,
      target,
      graphRevision: 0,
      chosen: [],
      question: "这个路由到底存不存在",
      scope: "static",
    });
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.line).toBe(INSPECT_TARGET_URL_LINE);

    // And the door agrees, with its own named reason: the page's sentence and the worker's refusal are
    // two views of one rule, not two rules that happen to match today.
    const asked = await post(fix.session, fix.path, {
      targetId: fix.targetId,
      expectedGraphRevision: 0,
      task: { kind: "inspect", claimIds: [], question: "这个路由到底存不存在", scope: "static" },
    }, "job-key-page-url-target");
    expect(asked.status, asked.text).toBe(400);
    expect(errorOf(asked.text).details["reason"]).toBe("inspect-needs-file-target");
  });

  // The capture half of the same reconciliation (issue #58's last handle): the composer's body is built
  // from the three reads the page really makes - health for the profile name, the project row for the
  // target id and concurrency token, the target row for its kind - and what comes out has to be the
  // body this door takes. A composer whose output the door refuses is a control that can only ever be
  // refused, which is the thing these two sections keep getting told about.
  it("accepts the capture body the composer builds from the reads the page makes", async () => {
    const fix = await rig("job-door-page-capture");
    const healthRead = await call("GET", `${API_PREFIX}/health`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(healthRead.status, healthRead.text).toBe(200);
    const targetRead = await call("GET", `${API_PREFIX}/projects/${String(fix.projectId)}/targets/${String(fix.targetId)}`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(targetRead.status, targetRead.text).toBe(200);

    // Read back through the page's own owners: the health list has to actually name the profile this rig
    // installs, and the row has to say `url`, or the draft below is being asked to accept a state the
    // composer would never see.
    const profiles = captureProfileOptionsOf(relayData(JSON.parse(healthRead.text) as JsonValue));
    expect(profiles?.map((option) => option.id)).toContain("har-capture");
    const target = inspectTargetReadOf(JSON.parse(targetRead.text) as JsonValue, fix.targetId);
    expect(target).toEqual({ ok: true, kind: "url", snapshotDigest: null });
    if (profiles === null) throw new Error(healthRead.text);

    const draft = captureDraftOf({
      csrf: fix.session.csrf,
      targetId: fix.targetId,
      target,
      graphRevision: 0,
      profiles,
      profileId: "har-capture",
      startUrl: "https://shop.example/cart",
      rows: [
        { kind: "click", locatorKind: "testId", role: "", name: "", testId: "add-to-cart", value: "", waitState: "" },
        { kind: "waitFor", locatorKind: "role", role: "status", name: "购物车", testId: "", value: "", waitState: "visible" },
      ],
      requestBody: true,
      responseBody: false,
      headerValues: false,
      timeoutMs: "45000",
      sensitiveValues: "hunter2",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const asked = await post(fix.session, fix.path, draft.body as unknown as Record<string, JsonValue>, "job-key-page-capture");
    expect(asked.status, asked.text).toBe(202);
    const record = jobRecordSchema.safeParse(relayData(JSON.parse(asked.text) as JsonValue));
    if (!record.success) throw new Error(asked.text);
    expect(record.data.kind).toBe("capture");
    expect(record.data.state).toBe("queued");

    // The row carries the sequence and the profile the operator chose - the door did not reinterpret the
    // body it was given.
    const row = queuedJob(fix.projectId, asId(record.data.id));
    expect(JSON.stringify(row?.inputJson)).toContain("add-to-cart");
    expect(JSON.stringify(row?.inputJson)).toContain("购物车");
    expect(JSON.stringify(row?.inputJson)).toContain("har-capture");
  });

  // The one rule the composer deliberately does **not** own: §8 says the start address must match the
  // target's authorised scope, and `GET /projects/:p/targets/:t` carries no locator to compare against,
  // so the page cannot honestly decide it and a guess would be a rule with no owner. The door answers
  // with the named reason, and the two together are what makes the split sayable rather than silent.
  it("lets the door own the scope rule the page has no read for", async () => {
    const fix = await rig("job-door-page-capture-scope");
    const healthRead = await call("GET", `${API_PREFIX}/health`, { headers: { host: host(), cookie: fix.session.cookie } });
    expect(healthRead.status, healthRead.text).toBe(200);
    const profiles = captureProfileOptionsOf(relayData(JSON.parse(healthRead.text) as JsonValue));
    if (profiles === null) throw new Error(healthRead.text);

    const draft = captureDraftOf({
      csrf: fix.session.csrf,
      targetId: fix.targetId,
      target: { ok: true, kind: "url", snapshotDigest: null },
      graphRevision: 0,
      profiles,
      profileId: "har-capture",
      // The same well-formed, credential-free, fragment-free address - on a host the target does not name.
      startUrl: "https://other.example/cart",
      rows: [],
      requestBody: false,
      responseBody: false,
      headerValues: false,
      timeoutMs: "",
      sensitiveValues: "",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const asked = await post(fix.session, fix.path, draft.body as unknown as Record<string, JsonValue>, "job-key-page-capture-scope");
    expect(asked.status, asked.text).toBe(403);
    expect(errorOf(asked.text).details["reason"]).toBe("start-url-outside-target-scope");
  });

  // And the disagreement the page *can* see: a capture against imported bytes has no address to visit,
  // so the composer refuses before the socket and the door refuses with its own name for the same rule.
  it("refuses a capture against a file target with the same rule on both sides", async () => {
    const session = await pairSession();
    const projectId = await freshProject(session, "job-door-page-capture-file");
    const file = fileTarget(projectId);
    const targetRead = await call("GET", `${API_PREFIX}/projects/${String(projectId)}/targets/${String(file)}`, { headers: { host: host(), cookie: session.cookie } });
    expect(targetRead.status, targetRead.text).toBe(200);
    const healthRead = await call("GET", `${API_PREFIX}/health`, { headers: { host: host(), cookie: session.cookie } });
    expect(healthRead.status, healthRead.text).toBe(200);
    const profiles = captureProfileOptionsOf(relayData(JSON.parse(healthRead.text) as JsonValue));
    if (profiles === null) throw new Error("health lost its profile list");

    const draft = captureDraftOf({
      csrf: session.csrf,
      targetId: file,
      target: inspectTargetReadOf(JSON.parse(targetRead.text) as JsonValue, file),
      graphRevision: 0,
      profiles,
      profileId: "har-capture",
      startUrl: "https://shop.example/cart",
      rows: [],
      requestBody: false,
      responseBody: false,
      headerValues: false,
      timeoutMs: "",
      sensitiveValues: "",
    });
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.line).toBe(CAPTURE_TARGET_NOT_URL_LINE);

    const asked = await post(session, `${API_PREFIX}/projects/${String(projectId)}/jobs`, {
      targetId: file,
      expectedGraphRevision: 0,
      task: captureTask(),
    }, "job-key-page-capture-file");
    expect(asked.status, asked.text).toBe(400);
    expect(errorOf(asked.text).details["reason"]).toBe("capture-needs-url-target");
  });
});

// The comparator read (issue #82): a door §8's table does not list, mounted because §8 line 297
// demands a name from a list nothing could read. What these cases hold is not "the list is there" but
// what the answer may not do with it: pick a default, reorder it, or name a policy the worker's own
// gate would reject.
describe("the comparator policy read (issue #82)", () => {
  const host = () => `127.0.0.1:${String(address.port)}`;

  async function pairCookie(): Promise<string> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(paired.status, paired.text).toBe(201);
    return (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  }

  it("holds the read behind a session and answers with the names this build installed", async () => {
    const unpaired = await call("GET", `${API_PREFIX}/comparator-policies`, { headers: { host: host() } });
    expect(unpaired.status, unpaired.text).toBe(401);

    const cookie = await pairCookie();
    const read = await call("GET", `${API_PREFIX}/comparator-policies`, { headers: { host: host(), cookie } });
    expect(read.status, read.text).toBe(200);
    const parsed = comparatorPolicyReadSchema.safeParse(JSON.parse(read.text) as JsonValue);
    if (!parsed.success) throw new Error(`the read refused its own contract: ${read.text}`);
    // The very table the write gate consults, in the order it is written in. A filtered or sorted
    // copy would still be "a list of policies" and still be wrong: alphabetically the looser policy
    // sorts first, and first is what a screen reads as suggested.
    expect(parsed.data.policies.map((policy) => policy.policyId)).toEqual(INSTALLED_COMPARATOR_POLICIES.map((policy) => policy.policyId));
    expect(parsed.data.policies.map((policy) => policy.normalization)).toEqual(INSTALLED_COMPARATOR_POLICIES.map((policy) => policy.normalization));
  });

  it("answers with names and normalizations only - no default, no recommendation, no version guess", async () => {
    const cookie = await pairCookie();
    const read = await call("GET", `${API_PREFIX}/comparator-policies`, { headers: { host: host(), cookie } });
    expect(read.status, read.text).toBe(200);
    const body = JSON.parse(read.text) as { policies: Record<string, unknown>[] };
    for (const policy of body.policies) {
      expect(Object.keys(policy).sort()).toEqual(["normalization", "policyId", "version"]);
    }
    // The negative half, stated on the bytes rather than on the parsed keys: a field added upstream
    // would have to arrive here too before the door could strip it.
    expect(read.text).not.toContain("default");
    expect(read.text).not.toContain("recommended");
  });

  it("is the same answer for two sessions and carries no project state", async () => {
    const first = await call("GET", `${API_PREFIX}/comparator-policies`, { headers: { host: host(), cookie: await pairCookie() } });
    const second = await call("GET", `${API_PREFIX}/comparator-policies`, { headers: { host: host(), cookie: await pairCookie() } });
    expect(first.status, first.text).toBe(200);
    expect(second.status, second.text).toBe(200);
    // What it reports is this build, so two sessions must not be able to read two answers - and the
    // route takes no project segment, which is why no project's data can ride along with it.
    expect(second.text).toBe(first.text);
  });
});

// The query surface (§8's rows, issue #63). What the table names is what a route takes: a name it does
// not implement is refused by name instead of being dropped on the way to a full answer, because an
// unanswered filter that reads as an answered one is the same mistake §14 already forbids for
// `limit=1.5`. Values never come back - only the offending names and a count.
describe("the query surface takes what §8 names and nothing else (issue #63)", () => {
  const host = () => `127.0.0.1:${String(address.port)}`;

  async function pair(): Promise<{ cookie: string; csrf: string }> {
    const code = worker.mintPairingCode();
    const paired = await call("POST", `${API_PREFIX}/session`, {
      body: JSON.stringify({ bootstrapToken: code.token }),
      headers: { host: host(), origin: `http://${host()}` },
    });
    expect(paired.status, paired.text).toBe(201);
    const issued = JSON.parse(paired.text) as { csrfToken?: string; data?: { csrfToken?: string } };
    return {
      cookie: (paired.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "",
      csrf: issued.data?.csrfToken ?? issued.csrfToken ?? "",
    };
  }

  async function project(session: { cookie: string; csrf: string }, name: string): Promise<string> {
    const created = await call("POST", `${API_PREFIX}/projects`, {
      body: JSON.stringify({ name }),
      headers: {
        host: host(),
        origin: `http://${host()}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": `query-${name}`,
        "content-type": "application/json",
      },
    });
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { id?: string; data?: { id: string } };
    return (body.data?.id ?? body.id) as string;
  }

  const get = (path: string, session: { cookie: string }) =>
    call("GET", path, { headers: { host: host(), cookie: session.cookie } });

  it("refuses a filter §8 does not give the vectors page a slot for", async () => {
    const session = await pair();
    const projectId = await project(session, "query-vectors");
    const allowed = await get(`${API_PREFIX}/projects/${projectId}/vectors?targetId=${String(newId())}`, session);
    expect(allowed.status, allowed.text).toBe(200);

    const invented = await get(`${API_PREFIX}/projects/${projectId}/vectors?targetId=${String(newId())}&visibility=holdout-SECRET-VALUE`, session);
    expect(invented.status).toBe(400);
    const refusal = (JSON.parse(invented.text) as { error: { details: Record<string, unknown> } }).error.details;
    expect(refusal["reason"]).toBe("vectors-query-unknown");
    expect(JSON.stringify(refusal)).toContain("visibility");
    // The value behind the name is not published: the name is the fact, the value is the caller's.
    expect(invented.text).not.toContain("holdout-SECRET-VALUE");
    // and nothing about the page moved: the refusal happened before any read
    expect(refusal["unknownCount"]).toBe(1);
  });

  it("refuses a filter on the job page that §8 line 277 does not name", async () => {
    const session = await pair();
    const projectId = await project(session, "query-jobs");
    // The two names §8 line 277 gives, exactly as it gives them. An empty `cursor=` is a *malformed*
    // cursor, not an absent one, so it is not part of what this case is proving.
    expect((await get(`${API_PREFIX}/projects/${projectId}/jobs?limit=10`, session)).status).toBe(200);
    const filtered = await get(`${API_PREFIX}/projects/${projectId}/jobs?state=queued`, session);
    expect(filtered.status).toBe(400);
    expect(JSON.stringify(filtered.text)).toContain("jobs-query-unknown");
  });

  it("refuses §8's own graph slot rather than answering an unfiltered graph", async () => {
    const session = await pair();
    const projectId = await project(session, "query-graph");
    // `afterRevision` is the name §8 line 280 lists. Nothing in this build reads a graph as of a
    // revision, so the honest answer is a refusal that says so - not the whole graph with a 200 that
    // looks like the filter worked. (This is the second half of issue #63's shape: an unused name in
    // the contract and an unimplemented name in the doc are the same failure wearing different clothes.)
    const revision = await get(`${API_PREFIX}/projects/${projectId}/graph?afterRevision=3`, session);
    expect(revision.status).toBe(400);
    expect(JSON.stringify(revision.text)).toContain("graph-query-unknown");

    // `targetId` is the deviation the other way: implemented by the worker's own request schema and
    // listed nowhere in that row, so it is allowed here and said out loud in the README and in #63.
    const named = newId();
    const target = await get(`${API_PREFIX}/projects/${projectId}/graph?targetId=${named}`, session);
    expect(target.status, target.text).toBe(200);
    // A project with no rows answers with an empty view rather than an error, and says which target it
    // read - the reply is honest about the miss instead of pretending the name was a filter.
    const view = JSON.parse(target.text) as { data?: { targetId: string | null } } & { targetId?: string | null };
    expect((view.data ?? view).targetId).toBeNull();
  });

  it("takes no query at all on the routes that name none", async () => {
    const session = await pair();
    const projectId = await project(session, "query-none");
    expect((await get(`${API_PREFIX}/projects/${projectId}`, session)).status).toBe(200);
    const withQuery = await get(`${API_PREFIX}/projects/${projectId}?limit=5`, session);
    expect(withQuery.status).toBe(400);
    expect(JSON.stringify(withQuery.text)).toContain("query-not-accepted");
    // Both audit pages (§8 line 301-303) do take their two names, and nothing else.
    expect((await get(`${API_PREFIX}/projects/${projectId}/audit?after=0&limit=5`, session)).status).toBe(200);
    expect((await get(`${API_PREFIX}/projects/${projectId}/audit?since=yesterday`, session)).status).toBe(400);

    // The order is §14's: who you are is answered before what you asked. An anonymous request with a
    // bad parameter learns it has no session, not that the parameter is unknown - the query gate runs
    // after the session and CSRF gates, so a refused query never becomes a free probe of what exists.
    const anonymous = await call("GET", `${API_PREFIX}/projects/${projectId}/vectors?visibility=public`, { headers: { host: host() } });
    expect(anonymous.status).toBe(401);
    expect(anonymous.text).toContain("cookie-absent");
  });
});

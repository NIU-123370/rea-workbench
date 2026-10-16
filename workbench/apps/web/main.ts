import path from "node:path";

import { resolveWebListen } from "../../packages/application/boot-config.ts";
import { IdempotencyJournal } from "../../packages/application/idempotency.ts";
import { WORKER_RPC_SOCKET_NAME, type BootConfigField } from "../../packages/contracts/boot.ts";
import { createApiHandler } from "./api.ts";
import { AccessLog } from "./access-log.ts";
import type { ListenAddress } from "../../packages/application/session.ts";
import { startWebServer } from "./server.ts";
import { createWorkerClient } from "./worker-client.ts";
import type { CanonicalLimits } from "../../packages/domain/canonical-json.ts";

// The web process entrypoint (DESIGN §3, §8, §14 / issue #18).
//
// Two processes run a workbench: the worker owns the database, the profile and the
// pairing code, and this one owns the loopback the browser talks to. `§14` gives the
// web half exactly three configuration fields, and `resolveWebListen` is the only place
// that reads them - this file passes the environment through that resolver field by
// field, so no ambient variable is ever captured, and it touches no filesystem at all
// (§3 leaves the data directory, the profile and the lock to the worker).
//
// That is also why the UI needs the two things this file does *not* do: it cannot mint a
// session (the worker holds the code) and it cannot read a package (the artifact store is
// the worker's). Every request it serves is answered by a named RPC command over the
// worker's private socket.

const REQUIRED_NODE_VERSION = "24.18.0";

// The three names §14 allows this process, written out rather than imported from the
// resolver's private list so the boundary is visible at the entrypoint. A guard in
// tests/integration/web-process.test.ts re-reads this file to prove nothing else is.
const WEB_CONFIG_FIELDS: readonly BootConfigField[] = ["WB_HOST", "WB_PORT", "WB_DATA_DIR"];

// The canonical budget for request-side digests (idempotency replay keys). It is a
// declaration, not a runtime guess: the API's own body cap is 64 KiB, so this is the
// budget that cap was written against, and a payload that does not fit it is refused
// rather than hashed twice under two different budgets.
const REQUEST_LIMITS: CanonicalLimits = { maxDepth: 24, maxCodeUnits: 200_000 };

const STREAM_POLL_MS = 250;

export type WebRun =
  | { ok: true; port: number; close: () => Promise<void> }
  | { ok: false; exitCode: number; reasons: readonly string[] };

export type WebRunInput = {
  env: Readonly<Record<string, string | undefined>>;
  nodeVersion: string;
  log: (line: string) => void;
  pollMs?: number;
};

function declaredEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const field of WEB_CONFIG_FIELDS) picked[field] = env[field];
  return picked;
}

export async function runWebProcess(input: WebRunInput): Promise<WebRun> {
  // The toolchain check happens before anything is read: an unsupported runtime would
  // otherwise fail somewhere inside `node:sqlite` in the worker, and the operator would
  // spend the afternoon debugging the wrong process.
  if (input.nodeVersion !== REQUIRED_NODE_VERSION) {
    return { ok: false, exitCode: 73, reasons: [`node-${REQUIRED_NODE_VERSION}-required`] };
  }
  const resolved = resolveWebListen({ env: declaredEnv(input.env), installedDefaults: {} });
  if (resolved.kind === "invalid") {
    // Reasons only. A configuration failure must not echo the value it rejected, because
    // one of those fields is a host path.
    return { ok: false, exitCode: 78, reasons: resolved.failures.map((failure) => `${failure.field}:${failure.reason}`) };
  }
  const config = resolved.config;
  const worker = createWorkerClient({
    socketPath: path.join(config.dataDir, WORKER_RPC_SOCKET_NAME),
    dataDir: config.dataDir,
  });
  const journal = new IdempotencyJournal();
  const access = new AccessLog();
  const address: ListenAddress = { host: config.host, port: config.port, secure: false };
  const handler = createApiHandler({
    address,
    worker,
    journal,
    limits: REQUEST_LIMITS,
    access,
    stream: { pollMs: input.pollMs ?? STREAM_POLL_MS, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  });
  const server = await startWebServer({
    handler,
    host: config.host,
    port: config.port,
    onError: (reason) => input.log(`server-error ${reason}`),
  });
  // The Host and Origin gates compare against the address the server *reported*, so the
  // one number that decides them is read back rather than believed from the config.
  address.port = server.port;
  input.log(`listening http://${config.host}:${String(server.port)}`);
  return {
    ok: true,
    port: server.port,
    close: async () => {
      await server.close();
      await worker.close();
    },
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  if (argv.includes("--help")) {
    log("usage: WB_DATA_DIR=<worker's data dir> [WB_PORT=<port>] node apps/web/main.ts");
    log("the web process answers the browser on loopback and reaches the worker only");
    log("through its private RPC socket; it reads no files and mints no session.");
    return 0;
  }
  const run = await runWebProcess({ env: process.env, nodeVersion: process.versions.node, log });
  if (!run.ok) {
    for (const reason of run.reasons) log(`config-error ${reason}`);
    return run.exitCode;
  }
  log(`pair at http://localhost:3000 with the code the worker's terminal printed`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await run.close();
  log("web stopped");
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

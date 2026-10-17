import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCK_FILE } from "../../packages/adapters/storage/database.ts";
import { WORKER_RPC_SOCKET_NAME } from "../../packages/contracts/boot.ts";

// The operator's view of issue #72: after a SIGKILL, `npm run worker` again.
//
// Both halves of the restart run the real command line rather than an in-process call, because what
// has to be proved is that a *second process* can start on the leftovers of the first. An in-process
// boot would share a pid namespace with its own fixture, and a takeover that works in-process can
// still fail for the reason that matters here: the recorded pid belongs to a process that is really
// gone.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROFILE = {
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
    queueWaitMs: 30000,
    timeoutMs: 120000,
  },
  networkPolicyId: "deny-egress",
};

let dataDir: string;
let packageRoot: string;
let brokerSocket: string;
let brokerListener: net.Server;
const children: { kill: (signal?: NodeJS.Signals | number) => void }[] = [];

type Booted = {
  child: ReturnType<typeof spawn>;
  // The pairing code this worker printed - the only thing §14 lets leave the terminal.
  code: () => Promise<string>;
};

function boot(dir: string): Booted {
  const child = spawn(process.execPath, [path.join(ROOT, "apps", "worker", "main.ts"), packageRoot], {
    env: {
      ...process.env,
      WB_HOST: "127.0.0.1",
      // One port for the whole file: the second starter only reaches it after the first has been
      // killed, which is the situation under test rather than a coincidence to rely on.
      WB_PORT: "4325",
      WB_DATA_DIR: dir,
      WB_REA_ENTRYPOINT: path.join(dataDir, "rea-entry.mjs"),
      WB_MODEL_ENDPOINT: "",
      WB_SANDBOX_PROFILE: "har-capture",
      WB_BROKER_SOCKET: brokerSocket,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const buffer = { out: "", err: "" };
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer.out += String(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    buffer.err += String(chunk);
  });
  return {
    child,
    code: () =>
      new Promise<string>((resolve, reject) => {
        const poll = (): void => {
          const match = /pair code=([^ ]+)/.exec(buffer.out);
          if (match !== null) {
            resolve(match[1] ?? "");
            return;
          }
          if (exited) {
            reject(new Error(`worker exited before pairing: stdout=${buffer.out.slice(0, 400)} stderr=${buffer.err.slice(0, 400)}`));
            return;
          }
          setTimeout(poll, 25);
        };
        let exited = false;
        child.once("exit", () => {
          exited = true;
        });
        const deadline = setTimeout(() => {
          reject(new Error(`no pairing code within 30s: stdout=${buffer.out.slice(0, 400)}`));
        }, 30_000);
        child.once("exit", () => clearTimeout(deadline));
        poll();
      }),
  };
}

function exitOf(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "rea-wb-unclean-"));
  chmodSync(dataDir, 0o700);
  packageRoot = path.join(dataDir, "package");
  mkdirSync(path.join(packageRoot, "infra", "profiles"), { recursive: true });
  mkdirSync(path.join(packageRoot, "infra", "config"), { recursive: true });
  writeFileSync(path.join(packageRoot, "infra", "profiles", "har-capture.json"), JSON.stringify(PROFILE));
  writeFileSync(path.join(packageRoot, "infra", "config", "installed-defaults.json"), JSON.stringify({}));
  writeFileSync(path.join(dataDir, "rea-entry.mjs"), "// placeholder identity file\n");
  brokerSocket = path.join(dataDir, "broker.sock");
  brokerListener = await new Promise<net.Server>((resolve) => {
    const server = net.createServer();
    server.listen(brokerSocket, () => resolve(server));
  });
});

afterAll(async () => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await new Promise<void>((resolve) => brokerListener.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

describe("restarting the worker command after an unclean death (issue #72)", () => {
  it("the second start takes over the lock and socket the first one left", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rea-wb-unclean-data-"));
    chmodSync(dir, 0o700);
    const lock = path.join(dir, LOCK_FILE);
    const socket = path.join(dir, WORKER_RPC_SOCKET_NAME);
    try {
      const first = boot(dir);
      expect((await first.code()).length).toBeGreaterThan(16);
      // The files exist while the holder is live - that is the §2 rule, not the defect.
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(socket)).toBe(true);
      expect(Number(readFileSync(lock, "utf8").trim())).toBe(first.child.pid);

      // The death the issue is about: no handler runs, so nothing removes what this process made.
      const gone = exitOf(first.child);
      first.child.kill("SIGKILL");
      await gone;
      expect(existsSync(lock), "a SIGKILLed worker leaves its lock behind").toBe(true);
      expect(existsSync(socket), "a SIGKILLed worker leaves its socket behind").toBe(true);
      expect(lstatSync(socket).isSocket()).toBe(true);

      const second = boot(dir);
      const secondCode = await second.code();
      // A fresh code, not a handover: §14 keeps sessions in the worker's memory, and a restart
      // invalidates every cookie in circulation along with them.
      expect(secondCode.length).toBeGreaterThan(16);
      expect(Number(readFileSync(lock, "utf8").trim())).toBe(second.child.pid);
      expect(lstatSync(socket).isSocket()).toBe(true);

      // And a graceful stop cleans up again, which is the half an operator can rely on afterwards.
      const stopped = exitOf(second.child);
      second.child.kill("SIGTERM");
      await stopped;
      expect(existsSync(lock), "the graceful path still removes the lock").toBe(false);
      expect(existsSync(socket), "the graceful path still removes the socket").toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

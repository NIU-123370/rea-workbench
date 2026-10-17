import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireWorkerLock, LOCK_FILE, lockHolderState } from "../../packages/adapters/storage/database.ts";
import { startWorkerRpc, staleSocketGuard } from "../../apps/worker/rpc-server.ts";
import { WORKER_RPC_SOCKET_NAME } from "../../packages/contracts/boot.ts";
import { bootWorker, type WorkerHandle } from "../../apps/worker/composition.ts";
import type { Result } from "../../packages/domain/result.ts";

// Restarting after an unclean death (issue #72; DESIGN §2's single writer, §14's private RPC).
//
// A worker that is SIGKILLed never reaches `release()` or the socket's `close()`, so it leaves two
// files behind in the data directory: `worker.lock` naming a pid that no longer exists, and
// `worker.rpc.sock` with nothing listening on it. Before this file, both stopped the next worker
// from starting at all - the socket guard refused while *claiming* a listener existed, without ever
// asking one - and the operator's only way back was to delete files the workbench itself wrote.
//
// What the tests below pin is the distinction that makes takeover safe instead of a second writer:
// a holder that can be *shown* not to exist may be replaced, and one that cannot be read at all may
// not. The end-to-end case kills a real child process rather than hand-writing the leftovers, so
// what the next worker inherits is the state an operator would actually find.

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
const spawned: { kill: (signal?: NodeJS.Signals | number) => void }[] = [];

async function privateDir(prefix: string): Promise<string> {
  const seed = await mkdtemp(path.join(tmpdir(), prefix));
  await rm(seed, { recursive: true, force: true });
  mkdirSync(seed, { recursive: true });
  chmodSync(seed, 0o700);
  // The boot resolver refuses a world-accessible data directory, so a fixture that forgot the
  // chmod would fail for a reason that has nothing to do with the assertion under test.
  expect(statSync(seed).mode & 0o077).toBe(0);
  return seed;
}

function envFor(dir: string, entrypoint: string, port: string): Record<string, string> {
  return {
    WB_HOST: "127.0.0.1",
    WB_PORT: port,
    WB_DATA_DIR: dir,
    WB_REA_ENTRYPOINT: entrypoint,
    WB_MODEL_ENDPOINT: "",
    WB_SANDBOX_PROFILE: "har-capture",
    WB_BROKER_SOCKET: brokerSocket,
  };
}

// A pid that is guaranteed to be gone: a child that has already exited and been reaped. This is the
// same pid the takeover path will probe, so the fixture does not have to guess at a free number.
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  await new Promise<number>((resolve, reject) => {
    child.once("exit", (code) => resolve(code ?? -1));
    child.once("error", reject);
  });
  const pid = child.pid ?? 0;
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}

function holdSocket(target: string): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer();
    // Nothing in this suite ever speaks the broker protocol, but a client may still
    // connect to the path - the worker's doctor does exactly that to ask whether a broker
    // is answering (§14 line 477). A server that takes a connection and never ends it also
    // never finishes `close()`, so the held socket has to drop peers it cannot serve; this
    // is the same line `candidate-generation.test.ts` and `inspect-execution.test.ts`
    // already carry.
    server.on("connection", (socket) => socket.destroy());
    server.listen(target, () => resolve(server));
  });
}

/** A child that binds a unix socket and never closes it; killed so the file is left behind. */
async function spawnHolder(target: string, signal: NodeJS.Signals | null): Promise<void> {
  const child = spawn(
    process.execPath,
    ["-e", `const net=require("node:net");net.createServer().listen(${JSON.stringify(target)},()=>console.log("up"));`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  spawned.push(child);
  await new Promise<void>((resolve, reject) => {
    let done = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!done && String(chunk).includes("up")) {
        done = true;
        resolve();
      }
    });
    child.once("error", reject);
    setTimeout(() => {
      if (!done) reject(new Error("the socket child never came up"));
    }, 5000);
  });
  if (signal === null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill(signal);
  await exited;
}

beforeAll(async () => {
  dataDir = await privateDir("rea-wb-restart-");
  packageRoot = path.join(dataDir, "package");
  mkdirSync(path.join(packageRoot, "infra", "profiles"), { recursive: true });
  mkdirSync(path.join(packageRoot, "infra", "config"), { recursive: true });
  writeFileSync(path.join(packageRoot, "infra", "profiles", "har-capture.json"), JSON.stringify(PROFILE));
  writeFileSync(path.join(packageRoot, "infra", "config", "installed-defaults.json"), JSON.stringify({}));
  brokerSocket = path.join(dataDir, "broker.sock");
  brokerListener = await holdSocket(brokerSocket);
  await writeFile(path.join(dataDir, "rea-entry.mjs"), "// placeholder identity file\n");
});

afterAll(async () => {
  for (const child of spawned) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await new Promise<void>((resolve) => brokerListener.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

describe("who the lock believes is holding it (issue #72)", () => {
  it("reads a pid, and calls anything else unknowable", () => {
    // A real live pid, and the probe's own verdicts, kept separate: a number in the file is not a
    // proof of anything, so the injected probe is what shows the table reading the text correctly
    // (including the whitespace a `writeFile` of `${pid}\n` leaves behind).
    expect(lockHolderState(`${process.pid}\n`)).toBe("alive");
    const seen: number[] = [];
    const probe = (answer: "alive" | "dead") => (pid: number) => {
      seen.push(pid);
      return answer;
    };
    expect(lockHolderState("  42  ", probe("alive"))).toBe("alive");
    expect(lockHolderState("4242", probe("dead"))).toBe("dead");
    expect(lockHolderState("1.5")).toBe("unknown");
    expect(lockHolderState("")).toBe("unknown");
    expect(lockHolderState("not-a-pid\n")).toBe("unknown");
    expect(lockHolderState("0")).toBe("unknown");
    expect(lockHolderState("-1")).toBe("unknown");
    expect(lockHolderState("   \n")).toBe("unknown");
    // Nothing is probed when the text is not a positive integer - that is the point of `unknown`.
    // Zero is not "some process": signalling pid 0 means the whole process group, so it must never
    // reach the probe at all.
    expect(lockHolderState("0")).toBe("unknown");
    expect(seen).toEqual([42, 4242]);
  });

  it("counts a holder it may not signal as alive", () => {
    // pid 1 is the case that is always present: as a non-root user the probe gets EPERM for it, and
    // as root it gets a plain success. Either answer means "a process is there", and the one answer
    // that would be wrong is `dead` - that is the branch that lets a live worker's lock be stolen.
    expect(lockHolderState("1\n")).toBe("alive");
    const dead = Number.MAX_SAFE_INTEGER - 1;
    expect(lockHolderState(`${String(dead)}\n`)).toBe("dead");
  });

  it("takes the lock over once the recorded holder is provably gone", async () => {
    const dir = await privateDir("rea-wb-restart-lock-");
    try {
      const dead = await exitedPid();
      writeFileSync(path.join(dir, LOCK_FILE), `${dead}\n`);
      const held = await acquireWorkerLock(dir);
      expect(held.ok).toBe(true);
      if (!held.ok) return;
      // The taken-over file names *this* process, so the next starter sees a live holder.
      expect(readFileSync(held.value.lockPath, "utf8").trim()).toBe(String(process.pid));
      expect(held.value.dataDir).toBe(dir);
      await held.value.release();
      expect(existsSync(held.value.lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a live holder and an unreadable one, and deletes neither file", async () => {
    const dir = await privateDir("rea-wb-restart-live-");
    try {
      const livePath = path.join(dir, LOCK_FILE);
      writeFileSync(livePath, `${process.pid}\n`);
      const refused = await acquireWorkerLock(dir);
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.code).toBe("DATA_DIR_LOCKED");
      expect(refused.error.message).toContain(String(process.pid));
      expect(readFileSync(livePath, "utf8")).toBe(`${process.pid}\n`);

      // A holder nobody can identify is not a holder that can be replaced: taking it over would be
      // the second writer §2 forbids, on the strength of a file with no name in it.
      writeFileSync(livePath, "truncated by a crash\n");
      const unknown = await acquireWorkerLock(dir);
      expect(unknown.ok).toBe(false);
      if (unknown.ok) return;
      expect(unknown.error.message).toContain("names no readable holder");
      expect(readFileSync(livePath, "utf8")).toBe("truncated by a crash\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets exactly one of two starters take a dead holder over", async () => {
    const dir = await privateDir("rea-wb-restart-race-");
    try {
      writeFileSync(path.join(dir, LOCK_FILE), `${await exitedPid()}\n`);
      const both = (await Promise.all([acquireWorkerLock(dir), acquireWorkerLock(dir)])) as Result<
        { dataDir: string; lockPath: string; release: () => Promise<void> },
        { code: string; message: string }
      >[];
      const won = both.filter((outcome) => outcome.ok).length;
      expect(won).toBe(1);
      const loser = both.find((outcome) => !outcome.ok);
      if (loser === undefined || loser.ok) throw new Error("one of the two must be refused");
      // The loser is refused by the file system, not by a guess: the winner's pid is in the file and
      // it is this process, so `alive` is the true answer rather than a fallback.
      expect(loser.error.code).toBe("DATA_DIR_LOCKED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the rpc socket a killed worker leaves behind (issue #72)", () => {
  it("refuses a path something is actually listening on, and keeps that file", async () => {
    const target = path.join(dataDir, "live.sock");
    await spawnHolder(target, null);
    try {
      const guarded = await staleSocketGuard(target);
      expect(guarded.ok).toBe(false);
      if (guarded.ok) return;
      expect(guarded.error.reason).toBe("socket-path-held-by-another-listener");
      // Someone else's listener owns that file; clearing it would cut them off from their own socket.
      expect(existsSync(target)).toBe(true);
    } finally {
      await rm(target, { force: true });
    }
  });

  it("clears a socket nobody answers, which is what lets the next bind succeed", async () => {
    const target = path.join(dataDir, "stale.sock");
    // A real SIGKILL of a real listener, not a hand-made file: this is exactly the leftover an
    // operator finds, because a killed process does not get to unlink anything.
    await spawnHolder(target, "SIGKILL");
    expect(existsSync(target)).toBe(true);

    const guarded = await staleSocketGuard(target);
    expect(guarded.ok).toBe(true);
    expect(existsSync(target)).toBe(false);

    // And the path is bindable again, which is the whole point of clearing it.
    const rebound = await holdSocket(target);
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
  });

  it("says by name when a leftover it may clear is a leftover it cannot remove", async () => {
    const cage = path.join(dataDir, "read-only-dir");
    mkdirSync(cage, { recursive: true });
    const target = path.join(cage, "stale.sock");
    // Bind it while the directory still allows that, then take the write bit away: the leftover is a
    // real socket file, and the only thing denied is removing it.
    await spawnHolder(target, "SIGKILL");
    chmodSync(cage, 0o500);
    try {
      const guarded = await staleSocketGuard(target);
      // Whether the removal is even permitted depends on who runs the suite: an ordinary user is
      // denied by the directory's mode and must be told so by name, while root is not, and then the
      // takeover simply succeeds.
      if (guarded.ok) {
        expect(existsSync(target)).toBe(false);
      } else {
        expect(guarded.error.reason).toBe("socket-stale-removal-failed");
        expect(existsSync(target), "a file this process could not delete must still be there").toBe(true);
      }
    } finally {
      chmodSync(cage, 0o700);
      await rm(cage, { recursive: true, force: true });
    }
  });

  it("will not remove a path that is not a socket", async () => {
    const target = path.join(dataDir, "not-a-socket.txt");
    writeFileSync(target, "someone else's file\n");
    const guarded = await staleSocketGuard(target);
    expect(guarded.ok).toBe(false);
    if (guarded.ok) return;
    expect(guarded.error.reason).toBe("socket-path-exists-and-is-not-a-socket");
    expect(readFileSync(target, "utf8")).toBe("someone else's file\n");
    await rm(target, { force: true });
  });

  it("starts cleanly on the two files a SIGKILLed worker left in the data directory", async () => {
    const dir = await privateDir("rea-wb-restart-e2e-");
    const entrypoint = path.join(dir, "rea-entry.mjs");
    writeFileSync(entrypoint, "// placeholder identity file\n");
    const childDir = path.join(dir, "child");
    mkdirSync(childDir, { recursive: true });
    chmodSync(childDir, 0o700);
    try {
      // Phase 1: a real `npm run worker` in a real data directory, stopped the way the issue says.
      const child = spawn(
        process.execPath,
        [path.join(ROOT, "apps", "worker", "main.ts"), packageRoot],
        {
          env: { ...process.env, ...envFor(childDir, entrypoint, "4319") },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      spawned.push(child);
      await new Promise<void>((resolve, reject) => {
        let seen = false;
        child.stdout?.on("data", (chunk: Buffer) => {
          if (!seen && String(chunk).includes("pair code=")) {
            seen = true;
            resolve();
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (!seen) reject(new Error(`the child worker failed: ${String(chunk).slice(0, 400)}`));
        });
        child.once("error", reject);
        setTimeout(() => {
          if (!seen) reject(new Error("the child worker never printed a pairing code"));
        }, 20000);
      });
      const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await stopped;

      const leftovers = {
        lock: path.join(childDir, LOCK_FILE),
        socket: path.join(childDir, WORKER_RPC_SOCKET_NAME),
      };
      // The state the issue describes, read rather than assumed.
      expect(existsSync(leftovers.lock), "the killed worker should leave its lock").toBe(true);
      expect(existsSync(leftovers.socket), "the killed worker should leave its socket").toBe(true);
      expect(Number(readFileSync(leftovers.lock, "utf8").trim())).toBe(child.pid);

      // Phase 2: the same start an operator would run. Nothing was deleted by hand.
      const booted = await bootWorker({
        env: envFor(childDir, entrypoint, "4320"),
        installedDefaults: {},
        profileDir: path.join(packageRoot, "infra", "profiles"),
        toolchain: { nodeVersion: "24.18.0", requiredNodeVersion: "24.18.0" },
      });
      if (!booted.ok) throw new Error(`restart after SIGKILL refused: ${JSON.stringify(booted.error)}`);
      const worker = booted.value as WorkerHandle;
      try {
        expect(readFileSync(leftovers.lock, "utf8").trim()).toBe(String(process.pid));
        const started = await startWorkerRpc(worker);
        expect(started.ok).toBe(true);
        if (!started.ok) return;
        const rpc = started.value;
        expect(rpc.socketPath).toBe(leftovers.socket);
        // The restarted worker answers, which is the only proof that matters to an operator.
        const health = await worker.dispatch("health.effectiveProfiles", {}, { actorId: "restart-probe", actorKind: "system" });
        expect(health.ok).toBe(true);
        await rpc.close();
      } finally {
        await worker.shutdown();
      }
      // And a graceful stop cleans up again, so the loop closes the way §14 says it should.
      expect(existsSync(leftovers.lock)).toBe(false);
      expect(existsSync(leftovers.socket)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

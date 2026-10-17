import { existsSync, lstatSync, unlinkSync } from "node:fs";
import net from "node:net";

import type { Actor, ActorKind } from "../../packages/application/actor.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type { Result } from "../../packages/domain/result.ts";
import type { WorkerHandle } from "./composition.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import { safeFailureDetails } from "../../packages/contracts/errors.ts";

// The worker's local RPC (DESIGN §14: 本机 RPC 提供具名命令与查询).
//
// One frame, one command, one reply. The server has no query language, no SQL and
// no shell: a frame that does not name a registered command is refused, and the
// bytes of a frame are counted before any of it is allocated, so a huge upload
// cannot become memory pressure on the way in (§12).

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const ACTOR_KINDS: readonly string[] = ["inspector", "reviewer", "builder", "system"];

export type RpcFrame = {
  id: number;
  command: string;
  payload: JsonValue;
  actor: Actor;
};

export type RpcReply =
  | { id: number; ok: true; value: JsonValue }
  // `details` is already the declared-safe subset: filtering at the boundary that leaves
  // the process means no consumer of this socket has to remember to sanitise.
  | { id: number; ok: false; error: { code: string; reason: string; message: string; details: Record<string, number | boolean> } };

export type RpcServer = {
  socketPath: string;
  close: () => Promise<void>;
};

export type RpcFailure = { reason: string };

function refused(reason: string): Result<never, RpcFailure> {
  return { ok: false, error: { reason } };
}

export function parseFrame(text: string): Result<RpcFrame, { reason: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return refused("frame-not-json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return refused("frame-not-object");
  const frame = parsed as Record<string, unknown>;
  if (typeof frame["id"] !== "number" || !Number.isInteger(frame["id"]) || frame["id"] < 0) return refused("frame-id-invalid");
  if (typeof frame["command"] !== "string" || frame["command"].length === 0) return refused("frame-command-missing");
  const actor = frame["actor"];
  if (actor === null || typeof actor !== "object" || Array.isArray(actor)) return refused("frame-actor-missing");
  const record = actor as Record<string, unknown>;
  if (typeof record["actorId"] !== "string" || record["actorId"].length === 0) return refused("frame-actor-id-missing");
  if (typeof record["actorKind"] !== "string" || !ACTOR_KINDS.includes(record["actorKind"])) {
    return refused("frame-actor-kind-unknown");
  }
  return {
    ok: true,
    value: {
      id: frame["id"],
      command: frame["command"],
      payload: (frame["payload"] ?? null) as JsonValue,
      actor: { actorId: record["actorId"], actorKind: record["actorKind"] as ActorKind },
    },
  };
}

// A socket left behind by a crashed run is not deleted on a guess: the path is
// reported, and the operator decides (§11 — ownership before removal).
// The socket path exists before this server binds it in exactly two situations: another listener is
// up, or a previous worker died without reaching `close()` (a SIGKILL never does). The guard used to
// refuse both while naming only the first - it reported `socket-path-held-by-another-listener`
// without ever asking a listener (issue #72). The probe is a connect: if it completes, that reason
// is earned and the worker refuses; if nothing answers, the file is this workbench's own leftover
// and removing it is the only way back to a startable data directory.
export async function staleSocketGuard(target: string): Promise<Result<true, { reason: string }>> {
  if (!existsSync(target)) return { ok: true, value: true };
  let isSocket = false;
  try {
    isSocket = lstatSync(target).isSocket();
  } catch {
    return refused("socket-path-unstatable");
  }
  // A regular file or a directory at this path is not something this workbench wrote, so it is not
  // something this workbench deletes.
  if (!isSocket) return refused("socket-path-exists-and-is-not-a-socket");
  if (await listenerAnswers(target)) return refused("socket-path-held-by-another-listener");
  try {
    unlinkSync(target);
  } catch {
    return refused("socket-stale-removal-failed");
  }
  return { ok: true, value: true };
}

// A unix socket whose owning process is gone answers a connect with ECONNREFUSED (or ENOENT once
// the kernel has dropped it); a live listener completes the handshake. Only a completed handshake
// counts as "someone is home", so a wedged listener is not treated as one - the bind below would
// then fail with EADDRINUSE and say so by name.
function listenerAnswers(target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(target);
    let settled = false;
    const settle = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(500, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("close", () => settle(false));
  });
}

export async function startWorkerRpc(worker: WorkerHandle): Promise<Result<RpcServer, RpcFailure>> {
  const socketPath = worker.rpcSocketPath;
  const guarded = await staleSocketGuard(socketPath);
  if (!guarded.ok) return guarded;

  const listening = await new Promise<Result<net.Server, RpcFailure>>((resolve) => {
    const server = net.createServer();
    server.on("error", (error) => {
      void error;
      resolve(refused("socket-listen-failed"));
    });
    server.listen({ path: socketPath, exclusive: true }, () => resolve({ ok: true, value: server }));
  });
  if (!listening.ok) return listening;
  const server = listening.value;

  server.on("connection", (socket) => {
    socket.setNoDelay(true);
    let buffer = "";
    let overflow = false;
    socket.on("data", async (chunk: Buffer) => {
      // Counted before buffered: a frame larger than the budget is refused whole
      // rather than assembled in memory first.
      if (buffer.length + chunk.byteLength > MAX_FRAME_BYTES) {
        overflow = true;
        socket.write(`${JSON.stringify({ id: -1, ok: false, error: { code: "RESOURCE_LIMIT", reason: "frame-too-large", message: "the request frame exceeds the byte budget", details: {} } })}\n`);
        socket.end();
        return;
      }
      buffer += chunk.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length === 0) continue;
        await answer(worker, socket, line);
      }
      if (overflow) socket.end();
    });
    socket.on("error", () => {
      // A dropped local connection is not a worker failure; nothing was written
      // that the caller did not ask for.
    });
  });

  return {
    ok: true,
    value: {
      socketPath,
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          unlinkSync(socketPath);
        } catch {
          // Already gone: the listener removed it on close.
        }
      },
    },
  };
}

async function answer(worker: WorkerHandle, socket: net.Socket, line: string): Promise<void> {
  const frame = parseFrame(line);
  if (!frame.ok) {
    const reply: RpcReply = {
      id: -1,
      ok: false,
      error: { code: "INVALID_INPUT", reason: frame.error.reason, message: "the frame was not a valid request", details: {} },
    };
    socket.write(`${JSON.stringify(reply)}\n`);
    return;
  }
  const reply = await replyFor(worker, frame.value);
  socket.write(`${JSON.stringify(reply)}\n`);
}

// The one place a refusal becomes wire bytes. Filtering here, at the boundary that leaves the
// process, is what lets every consumer of this socket (the web API today, an operator tool
// tomorrow) treat `details` as already-safe without having remembered to check.
export function errorFrame(id: number, failure: GateFailure): RpcReply {
  return {
    id,
    ok: false,
    error: {
      code: failure.code,
      reason: failure.reason,
      message: failure.message,
      details: safeFailureDetails(failure.details),
    },
  };
}

// The worker reference is bound when the server starts, so a request never
// resolves a global at call time.
async function replyFor(worker: WorkerHandle, frame: RpcFrame): Promise<RpcReply> {
  const outcome = await worker.dispatch(frame.command, frame.payload, frame.actor);
  if (!outcome.ok) return errorFrame(frame.id, outcome.error);
  return { id: frame.id, ok: true, value: outcome.value };
}

import net from "node:net";
import path from "node:path";

import { decodeRpcReply, encodeRpcFrame } from "../../packages/contracts/rpc.ts";
import { RPC_ACTOR_KINDS } from "../../packages/contracts/rpc.ts";
import type { RpcActorKind, RpcFrameWire, RpcReplyWire } from "../../packages/contracts/rpc.ts";
import { isNamedErrorCode } from "../../packages/contracts/errors.ts";
import type { NamedErrorCode } from "../../packages/contracts/errors.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type { Result } from "../../packages/domain/result.ts";

// The web process's client of the worker's private local RPC (DESIGN §2, §14).
//
// There is one dialect and its frame shape lives in `packages/contracts/rpc.ts`, so
// this file encodes exactly what `apps/worker/rpc-server.ts` parses rather than
// inventing a second protocol. Three properties are load-bearing:
//   * the peer must be the socket inside WB_DATA_DIR. A path outside it, or a TCP
//     address, is refused before a connection is attempted: the channel is private
//     because of where it is, and this is the client's share of checking that.
//   * the reply is counted before it is buffered, so a worker that said something
//     enormous cannot become memory pressure here (§12).
//   * a lost or broken worker is a *stated* outage. It comes back as
//     CAPABILITY_UNAVAILABLE, which the adapter turns into 503, and no request path
//     has a fallback that writes anything itself (§14: 不绕过 worker 自行写库).

export const MAX_RPC_REPLY_BYTES = 8 * 1024 * 1024;
export const RPC_TIMEOUT_MS = 5_000;

export type WorkerFailure = {
  code: NamedErrorCode;
  reason: string;
  message: string;
};

export type WorkerCaller = {
  call: (command: string, payload: JsonValue, actor: Actor) => Promise<Result<JsonValue, WorkerFailure>>;
};

export type WorkerClientOptions = {
  socketPath: string;
  // The data directory the worker owns; the socket must be directly inside it.
  dataDir: string;
  timeoutMs?: number;
  maxReplyBytes?: number;
};

function unreachable(reason: string): WorkerFailure {
  return {
    code: "CAPABILITY_UNAVAILABLE",
    reason,
    message: "the worker is not answering on its private local socket",
  };
}

// The socket path is derived, never taken from a request: `..`, an absolute path from
// somewhere else, or a `host:port` spelling all mean "this is not the worker's socket".
export function assertPrivateSocketPath(socketPath: string, dataDir: string): boolean {
  if (/^[a-z]+:\/\//i.test(socketPath)) return false;
  if (!path.isAbsolute(socketPath) || !path.isAbsolute(dataDir)) return false;
  return path.dirname(socketPath) === dataDir;
}

export function createWorkerClient(options: WorkerClientOptions): WorkerCaller & { close: () => Promise<void> } {
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
  const maxReplyBytes = options.maxReplyBytes ?? MAX_RPC_REPLY_BYTES;
  if (!assertPrivateSocketPath(options.socketPath, options.dataDir)) {
    // Constructing the client at all is a composition-root decision, so a wrong path
    // is a hard stop rather than a per-request 503 someone might learn to ignore.
    throw new TypeError("the worker RPC socket must be the file directly inside WB_DATA_DIR");
  }
  const sockets: net.Socket[] = [];
  return {
    async call(command, payload, actor) {
      // The RPC wire carries the operator vocabulary only. An evaluator capability is
      // issued by the worker for named operations and DESIGN §14 forbids exchanging it
      // for an operator session, so it must not be put on this frame at all — the
      // worker's own frame parser enforces the same list, and refusing here keeps a
      // caller from learning that distinction by trying.
      if (!RPC_ACTOR_KINDS.includes(actor.actorKind as RpcActorKind)) {
        return {
          ok: false,
          error: {
            code: "ACCESS_DENIED",
            reason: "actor-kind-not-accepted-over-rpc",
            message: "this actor kind has no place on the operator RPC channel",
          },
        };
      }
      const frame: RpcFrameWire = {
        id: nextId(),
        command,
        payload,
        actor: { actorId: actor.actorId, actorKind: actor.actorKind as RpcActorKind },
      };
      const reply = await roundTrip(options.socketPath, frame, timeoutMs, maxReplyBytes, sockets);
      if (!reply.ok) return reply;
      if (reply.value.ok === true) return { ok: true, value: reply.value.value };
      const failure = reply.value.error;
      // An error code the contract does not name is not forwarded: the adapter maps
      // named codes onto statuses, and an unmodelled string has no status (§8).
      if (!isNamedErrorCode(failure.code)) return { ok: false, error: unreachable("worker-code-unmodelled") };
      return { ok: false, error: { code: failure.code, reason: failure.reason, message: failure.message } };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.length = 0;
    },
  };
}

let frameId = 0;

function nextId(): number {
  frameId = frameId + 1 > Number.MAX_SAFE_INTEGER ? 1 : frameId + 1;
  return frameId;
}

function roundTrip(
  socketPath: string,
  frame: RpcFrameWire,
  timeoutMs: number,
  maxReplyBytes: number,
  tracked: net.Socket[],
): Promise<Result<RpcReplyWire, WorkerFailure>> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });
    tracked.push(socket);
    let buffer = "";
    let settled = false;
    const finish = (outcome: Result<RpcReplyWire, WorkerFailure>): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const index = tracked.indexOf(socket);
      if (index >= 0) tracked.splice(index, 1);
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: unreachable("worker-timeout") }));
    socket.on("error", () => finish({ ok: false, error: unreachable("worker-connect-failed") }));
    socket.on("close", () => finish({ ok: false, error: unreachable("worker-closed-without-reply") }));
    socket.on("data", (chunk: Buffer) => {
      // Counted before buffered, the same rule the server applies to a request frame.
      if (buffer.length + chunk.byteLength > maxReplyBytes) {
        finish({ ok: false, error: { code: "RESOURCE_LIMIT", reason: "reply-too-large", message: "the worker reply exceeds the byte budget" } });
        return;
      }
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      const decoded = decodeRpcReply(line);
      if (!decoded.ok) {
        finish({ ok: false, error: { code: "REA_CONTRACT_MISMATCH", reason: decoded.error.reason, message: "the worker reply did not match the RPC contract" } });
        return;
      }
      if (decoded.value.id !== frame.id) {
        // A reply for another frame is not this request's answer; guessing would let
        // one command's result be read as another's.
        finish({ ok: false, error: { code: "REA_CONTRACT_MISMATCH", reason: "reply-id-mismatch", message: "the worker answered a different request id" } });
        return;
      }
      finish({ ok: true, value: decoded.value });
    });
    socket.on("connect", () => {
      socket.write(encodeRpcFrame(frame));
    });
  });
}

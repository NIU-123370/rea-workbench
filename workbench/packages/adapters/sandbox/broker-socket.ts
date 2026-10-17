import { connect } from "node:net";
import type { Socket } from "node:net";

import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { MAX_BROKER_FRAME_BYTES } from "../../contracts/sandbox.ts";
import type { BrokerFrameExchange } from "./broker-client.ts";

// The byte exchange `BrokerClient` was written against: one encoded request frame in,
// one answer frame out, over the private unix socket §14 line 473 declares. Until this
// file existed the only implementation of the port lived in a test, which is why the
// whole isolation line had no production caller (issue #121).
//
// What it does not do: it never spawns a process, never interprets the answer, and
// never hands the peer's text to a log. A failure is reported as one of the named
// reasons below, and `broker-client.ts` turns any of them into `broker-unreachable`.
//
// One requirement the socket puts on the *other* side, learned by measuring it: a
// `net.createServer()` that takes a connection and never ends it also never finishes
// `close()`, so anything that holds a broker path must destroy peers it will not serve
// (`resetAndDestroy()` is not available on a unix socket - it throws
// ERR_INVALID_HANDLE_TYPE). `apps/broker` ends the peer after the one answer it owes, and
// the rigs that hold a path without speaking the protocol carry that line.

// A connection that has not answered by then is treated as unreachable rather than
// queued: §11 keeps a stalled broker as `queued` with a visible retryAt, and that
// decision belongs to the queue, not to a socket read.
export const DEFAULT_BROKER_TIMEOUT_MS = 2_000;

export type SocketExchangeDeps = {
  socketPath: string;
  timeoutMs?: number;
};

export class SocketBrokerExchange implements BrokerFrameExchange {
  readonly socketPath: string;
  readonly timeoutMs: number;

  constructor(deps: SocketExchangeDeps) {
    this.socketPath = deps.socketPath;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS;
  }

  transmit(frame: Uint8Array): Promise<Result<Uint8Array, string>> {
    if (frame.byteLength > MAX_BROKER_FRAME_BYTES) {
      // Refused before it leaves: an oversized request would be a frame this client
      // cannot read the answer to, and the cap is the protocol's own.
      return Promise.resolve(err("outgoing-frame-over-budget"));
    }
    return new Promise((resolve) => {
      let settled = false;
      let buffered = new Uint8Array(0);
      const connection: Socket = connect({ path: this.socketPath });
      const finish = (outcome: Result<Uint8Array, string>): void => {
        if (settled) return;
        settled = true;
        connection.destroy();
        resolve(outcome);
      };
      connection.setTimeout(this.timeoutMs, () => {
        finish(err("broker-answer-timeout"));
      });
      connection.on("error", () => {
        // The socket's own message can carry a host path; it is dropped here rather
        // than passed along as a reason (§12.1: 不回显宿主路径).
        finish(err("broker-socket-connect-failed"));
      });
      connection.on("close", () => {
        finish(err("broker-closed-before-answer"));
      });
      connection.on("data", (chunk: Uint8Array) => {
        const merged = new Uint8Array(buffered.byteLength + chunk.byteLength);
        merged.set(buffered, 0);
        merged.set(chunk, buffered.byteLength);
        buffered = merged;
        if (!buffered.includes(0x0a)) {
          if (buffered.byteLength > MAX_BROKER_FRAME_BYTES) finish(err("broker-answer-over-frame-budget"));
          return;
        }
        // The frame keeps its trailing newline: `decodeBrokerResponse` reads the
        // terminator as part of the frame contract instead of re-adding one here.
        finish(ok(buffered));
      });
      connection.write(frame);
    });
  }
}

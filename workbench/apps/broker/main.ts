import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { isAbsolute } from "node:path";

import { isSupportedSandboxHost, SANDBOX_HOST_REQUIREMENTS } from "../../packages/contracts/sandbox.ts";
import { BrokerProtocol } from "./protocol.ts";
import type { BrokerEnginePort } from "./supervision.ts";
import { OwnershipRegistry, observeHost } from "./supervision.ts";
import type { HostObservation } from "./supervision.ts";

// `apps/broker` - DESIGN §3 line 74's host supervisor, and the only process in this
// build that may hold container management (§55: 目标与 Agent 不挂 Docker socket, Web 服务也不持有).
//
// What it deliberately is not: it does not open the SQLite write connection (§55 names
// the worker as the only writer), it does not import an application service or an
// adapter (§3's own module rule), and it does not answer anything the four-command
// protocol cannot name. Everything the caller may ask for arrives as a profile
// descriptor, so there is no argument left to forge.

// The one configuration this process reads (§14 line 473). A TCP URL is refused by
// name because a network-listening supervisor would widen the surface §3 closed.
export const BROKER_SOCKET_ENV = "WB_BROKER_SOCKET";

// Frames accumulate per connection until a newline arrives, and the cap is the
// protocol's own (§3 gives both halves the same bytes).
export const CHUNK_LIMIT = 8 * 1024;

export type BrokerBootResult =
  | {
      ok: true;
      server: Server;
      socketPath: string;
      protocol: BrokerProtocol;
      // The shutdown the process owns: end live peers, stop listening, remove the socket
      // file. Left in one place so a caller cannot close the listener and keep the file.
      close: () => void;
    }
  | { ok: false; reasons: string[]; exitCode: number };

export type BrokerBootInput = {
  env: Readonly<Record<string, string | undefined>>;
  host?: HostObservation;
  engine?: BrokerEnginePort | null;
  // The socket file's ownership/mode checks are the operator's, not this file's
  // business; the test injects a directory and the process uses what §14 declared.
  onError?: (line: string) => void;
};

function socketPathProblem(value: string | undefined): string | null {
  if (value === undefined || value === "") return "broker-socket-not-declared";
  // Checked before absoluteness on purpose: `tcp://host:9999` is not absolute either, and
  // the operator who typed a URL needs the reason that names what they wrote, not a
  // generic path complaint that sends them looking for a missing slash (§14 line 473).
  if (value.includes("://")) return "tcp-url-is-not-a-broker-socket";
  if (!isAbsolute(value)) return "absolute-socket-path-required";
  return null;
}

// Boot is a *decision*, not a listen call: §14's profile gate and D18 both say a host
// that cannot enforce isolation gets a refusal, never a weaker start. Reporting
// "broker is up" while it can only ever refuse a start would be the same lie the
// sandbox doctor check was written to prevent.
export function decideBoot(input: BrokerBootInput): { ok: true; socketPath: string; observation: HostObservation } | { ok: false; reasons: string[] } {
  const declared = input.env[BROKER_SOCKET_ENV];
  const problem = socketPathProblem(declared);
  if (problem !== null || declared === undefined) {
    return { ok: false, reasons: [problem ?? "broker-socket-not-declared"] };
  }
  const observation = input.host ?? observeHost();
  const reasons: string[] = [...observation.reasons];
  // The platform question is exactly that: which machine this is. Enforcement is a
  // separate report (`enforcedConditions`, empty until a probe proves each one), so the
  // two are never collapsed into one optimistic answer.
  const supported = isSupportedSandboxHost({
    platform: observation.facts.platform,
    arch: observation.facts.arch,
  });
  if (!supported) {
    reasons.push(
      `host-platform-unverified-for-sandbox:${observation.facts.platform}/${observation.facts.arch}`,
      `required:${SANDBOX_HOST_REQUIREMENTS.platform}/${SANDBOX_HOST_REQUIREMENTS.arch}`,
    );
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, socketPath: declared, observation };
}

export function bootBroker(input: BrokerBootInput): BrokerBootResult {
  const decided = decideBoot(input);
  if (!decided.ok) {
    return { ok: false, reasons: decided.reasons, exitCode: 78 };
  }
  const socketPath = decided.socketPath;
  if (existsSync(socketPath)) {
    let isSocket = false;
    try {
      isSocket = lstatSync(socketPath).isSocket();
    } catch {
      isSocket = false;
    }
    // A live socket means another supervisor already owns this path; a regular file
    // at that name is a misconfiguration this process must not silently overwrite.
    return {
      ok: false,
      reasons: [isSocket ? "broker-socket-already-listening" : "broker-path-is-not-a-socket"],
      exitCode: 73,
    };
  }

  const protocol = new BrokerProtocol({
    engine: input.engine ?? null,
    ownership: new OwnershipRegistry(),
    host: decided.observation.facts,
  });

  // Tracked by hand rather than with `server.closeAllConnections()`: that method is not in
  // the `net` typings this build compiles against, and a shutdown that silently skipped the
  // live peers would leave the process holding a socket file nobody can use.
  const peers = new Set<Socket>();
  const server = createServer((connection: Socket) => {
    peers.add(connection);
    connection.on("close", () => peers.delete(connection));
    let buffered: Uint8Array = new Uint8Array(0);
    connection.on("data", (chunk: Uint8Array) => {
      // One request per frame, and the answer is written as soon as a newline lands.
      // An unterminated accumulation past the chunk limit is a stuck or hostile peer,
      // not a big request: the frame budget is checked in `answerFrame`.
      if (chunk.byteLength > CHUNK_LIMIT) {
        connection.destroy();
        return;
      }
      const merged = new Uint8Array(buffered.byteLength + chunk.byteLength);
      merged.set(buffered, 0);
      merged.set(chunk, buffered.byteLength);
      buffered = merged;
      if (!buffered.includes(0x0a)) return;
      const frame = buffered;
      buffered = new Uint8Array(0);
      void protocol
        .answerFrame(frame)
        .then((answer) => {
          if (answer === null) {
            // No answer for a frame we cannot name: the peer asked for something the
            // protocol does not have. Closing is the honest read of that.
            connection.end();
            return;
          }
          // One request, one answer, then the connection is ended: the protocol has no
          // session, so keeping a peer open would be a second way to address resources
          // outside the four named commands.
          connection.end(answer);
        })
        .catch(() => {
          connection.destroy();
        });
    });
    connection.on("error", () => {
      connection.destroy();
    });
  });

  server.listen({ path: socketPath, exclusive: true });
  const close = (): void => {
    // Tracked peers are ended before the listener is closed: a live connection would keep
    // `close()` from finishing, and a leftover socket file would make the next start read
    // as `broker-socket-already-listening` on a path nobody owns.
    for (const peer of peers) peer.destroy();
    server.close();
    try {
      unlinkSync(socketPath);
    } catch {
      // The operator may have removed it already; a failed cleanup at exit must not turn a
      // clean shutdown into a stack trace.
    }
  };
  return { ok: true, server, socketPath, protocol, close };
}

export function main(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const write = (line: string): void => {
    // Fixed strings and named reasons only - the broker's log line never carries a
    // value, a host path beyond the socket it was configured with, or engine output
    // (§12.1 lists 运行日志 as a filtered face, and this process keeps it out of the
    // line rather than filtering it after the fact).
    process.stdout.write(`${line}\n`);
  };
  const booted = bootBroker({
    env,
    // No engine is shipped inside this repository: the supervisor that would drive
    // `bwrap`/`docker` belongs to the installed host package, and an absent engine is
    // reported as its own named reason rather than started around.
    engine: null,
  });
  if (!booted.ok) {
    for (const reason of booted.reasons) write(`broker-refused:${reason}`);
    return booted.exitCode;
  }
  write(`broker-listening:${booted.socketPath}`);
  const shutdown = (): void => {
    booted.close();
    write("broker-stopped");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return 0;
}

if (process.argv[1]?.endsWith("apps/broker/main.ts")) {
  process.exit(main());
}

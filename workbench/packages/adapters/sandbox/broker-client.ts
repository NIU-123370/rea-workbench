import { parseStrict } from "../../contracts/parse.ts";
import type {
  BrokerCommand,
  BrokerRequest,
  BrokerResponse,
  CancelOwnedBrokerRequest,
  CleanupOwnedBrokerRequest,
  InspectOwnedBrokerRequest,
  StartProfileBrokerRequest,
} from "../../contracts/sandbox.ts";
import { brokerResponseSchema } from "../../contracts/sandbox.ts";
import { err, ok } from "../../domain/result.ts";
import type { Err, Result } from "../../domain/result.ts";
import type { BrokerTransportFailure, SandboxBrokerTransportPort } from "../../application/ports.ts";

// The broker client: one named command in, one named response out, over a byte
// exchange this module does not own (DESIGN §3, D17).
//
// Two deliberate absences. First, no process is spawned and no socket is opened
// here: the byte exchange is injected, so this repository ships no unexercised I/O
// path and the privileged half stays in `apps/broker` (§3). Second, the reply is
// parsed from `unknown` by a strict schema, so a broker that starts carrying an
// extra field — a container name, a PID, a path, a stderr blob — is refused rather
// than tolerated. A protocol you do not parse is a protocol you do not control.

// A frame is one command plus one record. The cap is small on purpose: nothing the
// broker legitimately answers is large, and an oversized frame is either a bug or
// an attempt to make the control plane buffer untrusted bytes.
export const MAX_BROKER_FRAME_BYTES = 64 * 1024;

const FRAME_SEPARATOR = 0x0a;

export type FrameFailure = {
  code: "CAPABILITY_UNAVAILABLE";
  reason: string;
  message: string;
};

export function encodeBrokerRequest(request: BrokerRequest): Uint8Array {
  // The receiver re-validates everything, so the encoding only has to stay small,
  // newline-free inside the record, and single-valued.
  return new TextEncoder().encode(`${JSON.stringify(request)}\n`);
}

function failure(reason: string, message: string): Err<FrameFailure> {
  return err({ code: "CAPABILITY_UNAVAILABLE", reason, message });
}

export function decodeBrokerResponse(
  frame: Uint8Array,
  expected: { command: BrokerCommand; requestId: string },
): Result<BrokerResponse, FrameFailure> {
  if (frame.byteLength === 0) return failure("broker-frame-empty", "the broker answered with no bytes");
  if (frame.byteLength > MAX_BROKER_FRAME_BYTES) {
    return failure("broker-frame-too-large", "the broker answered above the frame budget");
  }
  if (frame[frame.byteLength - 1] !== FRAME_SEPARATOR) {
    return failure("broker-frame-unterminated", "the broker frame is not newline terminated");
  }
  const body = frame.subarray(0, -1);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (text.includes("\n")) {
    return failure("broker-frame-concatenated", "one frame must carry exactly one response");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return failure("broker-frame-not-json", "the broker answer is not JSON");
  }
  const parsed = parseStrict(brokerResponseSchema, value);
  if (!parsed.ok) {
    // Unrecognised keys land here: the response schema is strict, so a broker that
    // grows a field the contract never declared cannot smuggle it into the worker.
    return failure("broker-response-rejected", "the broker answer does not match the contract");
  }
  if (parsed.value.command !== expected.command) {
    return failure("broker-command-mismatch", "the answer names a different command");
  }
  if (parsed.value.requestId !== expected.requestId) {
    return failure("broker-request-mismatch", "the answer belongs to a different request");
  }
  return ok(parsed.value);
}

export function transportFailure(
  reason: string,
  message: string,
  retryable: boolean,
): BrokerTransportFailure {
  return { code: "CAPABILITY_UNAVAILABLE", reason, message, retryable, retryAt: null };
}

// The injected half: hand it one encoded request frame, get one answer frame (or a
// named transport reason) back. `apps/broker` supplies the socket; a test supplies a
// scripted answer. Neither can introduce a command this client was not asked to send.
export type BrokerFrameExchange = {
  transmit(frame: Uint8Array): Promise<Result<Uint8Array, string>>;
};

export class BrokerClient implements SandboxBrokerTransportPort {
  readonly exchange: BrokerFrameExchange;

  constructor(deps: { exchange: BrokerFrameExchange }) {
    this.exchange = deps.exchange;
  }

  private async call(request: BrokerRequest): Promise<Result<BrokerResponse, BrokerTransportFailure>> {
    const answered = await this.exchange.transmit(encodeBrokerRequest(request));
    if (!answered.ok) {
      // The reason is a fixed name, never the peer's text: supervisor stderr must not
      // reach a log or an audit row unfiltered (§12.1).
      return err(transportFailure("broker-unreachable", "the broker did not answer", true));
    }
    const decoded = decodeBrokerResponse(answered.value, {
      command: request.command,
      requestId: request.requestId,
    });
    if (!decoded.ok) {
      return err(transportFailure(decoded.error.reason, decoded.error.message, false));
    }
    return ok(decoded.value);
  }

  // One method per command, each narrowing the answer on its discriminant: the client
  // cannot return a startProfile answer to an inspect, and there is no generic
  // `invoke` for a caller to abuse.
  async startProfile(request: StartProfileBrokerRequest) {
    const answered = await this.call(request);
    if (!answered.ok) return answered;
    const value = answered.value;
    if (value.command !== "startProfile") return this.mismatched("startProfile");
    return ok(value);
  }

  async inspectOwned(request: InspectOwnedBrokerRequest) {
    const answered = await this.call(request);
    if (!answered.ok) return answered;
    const value = answered.value;
    if (value.command !== "inspectOwned") return this.mismatched("inspectOwned");
    return ok(value);
  }

  async cancelOwned(request: CancelOwnedBrokerRequest) {
    const answered = await this.call(request);
    if (!answered.ok) return answered;
    const value = answered.value;
    if (value.command !== "cancelOwned") return this.mismatched("cancelOwned");
    return ok(value);
  }

  async cleanupOwned(request: CleanupOwnedBrokerRequest) {
    const answered = await this.call(request);
    if (!answered.ok) return answered;
    const value = answered.value;
    if (value.command !== "cleanupOwned") return this.mismatched("cleanupOwned");
    return ok(value);
  }

  private mismatched(command: BrokerCommand): Err<BrokerTransportFailure> {
    return err(
      transportFailure(
        "broker-command-mismatch",
        `the answer is not a ${command} response`,
        false,
      ),
    );
  }
}

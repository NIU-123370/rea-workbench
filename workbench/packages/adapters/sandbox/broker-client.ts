import type { JsonValue } from "../../domain/json-value.ts";
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
import {
  MAX_BROKER_FRAME_BYTES,
  encodeBrokerFrame,
  readBrokerFrameRecord,
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

// The cap, the separator and the single-record rule are the protocol's, so they live
// in `contracts/sandbox.ts` where `apps/broker` may also read them (§3 gives the same
// bytes to both halves). Re-exported here because this is the module the control plane
// names when it talks about the frame budget.
export { MAX_BROKER_FRAME_BYTES };

export type FrameFailure = {
  code: "CAPABILITY_UNAVAILABLE";
  reason: string;
  message: string;
};

export function encodeBrokerRequest(request: BrokerRequest): Uint8Array {
  return encodeBrokerFrame(request as unknown as JsonValue);
}

function failure(reason: string, message: string): Err<FrameFailure> {
  return err({ code: "CAPABILITY_UNAVAILABLE", reason, message });
}

export function decodeBrokerResponse(
  frame: Uint8Array,
  expected: { command: BrokerCommand; requestId: string },
): Result<BrokerResponse, FrameFailure> {
  const read = readBrokerFrameRecord(frame);
  if (!read.ok) return failure(read.failure.reason, read.failure.message);
  const parsed = parseStrict(brokerResponseSchema, read.record);
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

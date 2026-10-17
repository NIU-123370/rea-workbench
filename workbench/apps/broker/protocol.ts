import { asId, nowInstant } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type {
  BrokerRequest,
  BrokerResponse,
  CancelOwnedBrokerRequest,
  CleanupOwnedBrokerRequest,
  InspectOwnedBrokerRequest,
  OwnedScopeFields,
  SandboxHostFacts,
  StartProfileBrokerRequest,
} from "../../packages/contracts/sandbox.ts";
import {
  BROKER_COMMANDS,
  brokerRequestSchema,
  encodeBrokerFrame,
  isBrokerCommand,
  readBrokerFrameRecord,
  unmetIsolationConditions,
} from "../../packages/contracts/sandbox.ts";
import { parseStrict } from "../../packages/contracts/parse.ts";
import type { BrokerEnginePort, OwnedRecord, OwnershipRegistry } from "./supervision.ts";

// The broker's whole exposed surface (§3 line 74: 独立受限协议；不接受 Agent 工具调用).
//
// What the protocol cannot carry is the design: there is no image name, no shell, no
// host path and no engine argument anywhere in `contracts/sandbox.ts`, so a caller that
// reaches this socket cannot ask for anything the profile descriptor does not already
// name. The four commands are the only entry points, and each of the three `*Owned`
// ones is scoped by a handle *this process minted* - that is the authority §11 needs
// for "只清理 owned 资源".

export type BrokerLogLine = { level: "refused" | "answered"; reason: string };

export type BrokerProtocolDeps = {
  engine: BrokerEnginePort | null;
  ownership: OwnershipRegistry;
  // The host report the supervision half observed at boot, passed in rather than
  // re-read, so a start decision and a later inspect cannot be comparing two
  // different snapshots of the machine.
  host: SandboxHostFacts;
};

// The answer for a handle this process does not acknowledge. Every fact §11 names
// stays `unknown` and `owned` is false: not-knowing is not the same as absent, and a
// caller must not be able to read this answer as permission to act.
// Only the three `*Owned` commands can be refused this way: a `startProfile` has no handle
// to be unowned by, and a branch for it here would be a path nothing reaches.
function notOwned(
  request: InspectOwnedBrokerRequest | CancelOwnedBrokerRequest | CleanupOwnedBrokerRequest,
): BrokerResponse {
  if (request.command === "inspectOwned") {
    return {
      command: "inspectOwned",
      requestId: request.requestId,
      owned: false,
      presence: "unknown",
      exitState: "unknown",
      cleanupState: "pending",
      editable: false,
    };
  }
  if (request.command === "cancelOwned") {
    return { command: "cancelOwned", requestId: request.requestId, owned: false, status: "refused", refusalReasons: ["handle-not-owned"] };
  }
  return {
    command: "cleanupOwned",
    requestId: request.requestId,
    owned: false,
    status: "refused",
    cleanupState: "pending",
    retryAt: null,
    refusalReasons: ["handle-not-owned"],
  };
}

export class BrokerProtocol {
  readonly engine: BrokerEnginePort | null;
  readonly ownership: OwnershipRegistry;
  readonly host: SandboxHostFacts;
  // Kept for the integration test and for the broker's own log line: the reasons this
  // process said no, in the order it said them.
  readonly log: BrokerLogLine[] = [];

  constructor(deps: BrokerProtocolDeps) {
    this.engine = deps.engine;
    this.ownership = deps.ownership;
    this.host = deps.host;
  }

  // One frame in, at most one frame out. A frame this process cannot turn into one of
  // the four named commands gets **no answer** rather than an invented one: every
  // response schema requires the `command` and `requestId` of the request it answers,
  // so a malformed frame has no identity to answer under, and inventing one would be
  // the protocol breaking its own rule. The caller then sees the transport-level
  // reason (`broker-unreachable`), which is the truth.
  async answerFrame(frame: Uint8Array): Promise<Uint8Array | null> {
    const read = readBrokerFrameRecord(frame);
    if (!read.ok) {
      this.log.push({ level: "refused", reason: read.failure.reason });
      return null;
    }
    const parsed = parseStrict(brokerRequestSchema, read.record);
    if (!parsed.ok) {
      this.log.push({ level: "refused", reason: "broker-request-rejected" });
      return null;
    }
    const response = await this.dispatch(parsed.value);
    this.log.push({ level: "answered", reason: response.command });
    return encodeBrokerFrame(response as unknown as JsonValue);
  }

  dispatch(request: BrokerRequest): Promise<BrokerResponse> {
    switch (request.command) {
      case "startProfile":
        return this.startProfile(request);
      case "inspectOwned":
        return this.inspectOwned(request);
      case "cancelOwned":
        return this.cancelOwned(request);
      case "cleanupOwned":
        return this.cleanupOwned(request);
    }
  }

  private async startProfile(request: StartProfileBrokerRequest): Promise<BrokerResponse> {
    const refusalReasons: string[] = [];
    if (this.engine === null) refusalReasons.push("broker-engine-not-configured");
    // D18: conditions that cannot be met produce a refusal, and nothing here may
    // "try anyway, weaker". The derivation is the contract's own, so the control plane
    // and the supervisor cannot hold two different readings of the same profile.
    refusalReasons.push(...unmetIsolationConditions({ host: this.host, profile: request.profile }));
    if (refusalReasons.length > 0) {
      return {
        command: "startProfile",
        requestId: request.requestId,
        status: "refused",
        handle: null,
        refusalReasons,
        enforcedConditions: [],
        cleanupState: "pending",
      };
    }
    const engine = this.engine;
    if (engine === null) throw new Error("broker-engine-null-after-preflight");

    // The wire types these as strings; the registry keys on the domain's branded identity,
    // so the turn happens here and nowhere else.
    const handle = this.ownership.mint({ jobId: asId(request.jobId), profileId: request.profile.profileId });
    const record = this.ownership.lookup(handle);
    if (record === null) {
      return {
        command: "startProfile",
        requestId: request.requestId,
        status: "refused",
        handle: null,
        refusalReasons: ["ownership-record-unreadable"],
        enforcedConditions: [],
        cleanupState: "pending",
      };
    }
    const started = await engine.start(record, request.profile, request.egress);
    if (!started.ok) {
      // A start that did not happen leaves no credential behind: keeping the handle
      // would let a later request address a resource that was never created.
      this.ownership.revoke(handle);
      return {
        command: "startProfile",
        requestId: request.requestId,
        status: "refused",
        handle: null,
        refusalReasons: started.reasons,
        enforcedConditions: started.enforcedConditions,
        cleanupState: "pending",
      };
    }
    return {
      command: "startProfile",
      requestId: request.requestId,
      status: "started",
      handle,
      refusalReasons: [],
      // Re-reported, not echoed: what the supervisor can prove it enforces is the
      // answer, and the control plane refuses when that is a subset of the request.
      enforcedConditions: started.enforcedConditions,
      cleanupState: "pending",
    };
  }

  private recordFor(request: OwnedScopeFields): OwnedRecord | null {
    return this.ownership.ownedBy(request.handle, request.jobId);
  }

  private async inspectOwned(request: InspectOwnedBrokerRequest): Promise<BrokerResponse> {
    const record = this.recordFor(request);
    if (record === null) return notOwned(request);
    if (this.engine === null) {
      return {
        command: "inspectOwned",
        requestId: request.requestId,
        owned: true,
        presence: "unknown",
        exitState: "unknown",
        cleanupState: record.cleanupState,
        editable: record.cleanupState !== "complete",
      };
    }
    const inspected = await this.engine.inspect(record);
    return {
      command: "inspectOwned",
      requestId: request.requestId,
      owned: true,
      presence: inspected.present ? "present" : "absent",
      exitState: inspected.present ? (inspected.running ? "running" : "exited") : "unknown",
      cleanupState: record.cleanupState,
      editable: record.cleanupState !== "complete" && !record.cancelRequested,
    };
  }

  private async cancelOwned(request: CancelOwnedBrokerRequest): Promise<BrokerResponse> {
    const record = this.recordFor(request);
    if (record === null) return notOwned(request);
    if (record.cleanupState === "complete") {
      return { command: "cancelOwned", requestId: request.requestId, owned: true, status: "alreadyTerminal", refusalReasons: [] };
    }
    if (this.engine === null) {
      return { command: "cancelOwned", requestId: request.requestId, owned: true, status: "refused", refusalReasons: ["broker-engine-not-configured"] };
    }
    const cancelled = await this.engine.cancel(record);
    if (!cancelled.cancelled) {
      return { command: "cancelOwned", requestId: request.requestId, owned: true, status: "refused", refusalReasons: ["engine-cancel-rejected"] };
    }
    this.ownership.markCancelled(request.handle);
    return { command: "cancelOwned", requestId: request.requestId, owned: true, status: "cancelling", refusalReasons: [] };
  }

  private async cleanupOwned(request: CleanupOwnedBrokerRequest): Promise<BrokerResponse> {
    const record = this.recordFor(request);
    if (record === null) return notOwned(request);
    if (this.engine === null) {
      // A cleanup that cannot run stays `pending` with a retry time the caller can
      // show. It never reports complete: "we did not try" and "it is gone" have to stay
      // different facts (§11, D20).
      return {
        command: "cleanupOwned",
        requestId: request.requestId,
        owned: true,
        status: "failed",
        cleanupState: "pending",
        retryAt: nowInstant(),
        refusalReasons: ["broker-engine-not-configured"],
      };
    }
    const cleaned = await this.engine.cleanup(record);
    if (cleaned.failed) {
      // The failed attempt is recorded, not just answered: a later `inspectOwned` has to
      // report the same `failed` the caller was told, or the retry door would be reading a
      // state that never existed.
      this.ownership.markCleanup(request.handle, "failed");
      return {
        command: "cleanupOwned",
        requestId: request.requestId,
        owned: true,
        status: "failed",
        cleanupState: "failed",
        retryAt: nowInstant(),
        refusalReasons: ["engine-cleanup-failed"],
      };
    }
    this.ownership.markCleanup(request.handle, "complete");
    this.ownership.revoke(request.handle);
    return {
      command: "cleanupOwned",
      requestId: request.requestId,
      owned: true,
      status: "complete",
      cleanupState: "complete",
      retryAt: null,
      refusalReasons: [],
    };
  }
}

// The closed command list as a runtime check: a frame naming a fifth command is
// refused by the schema above, and this is what any later code path asks first.
export function knowsCommand(value: string): boolean {
  return isBrokerCommand(value);
}

export const BROKER_COMMAND_NAMES = BROKER_COMMANDS;

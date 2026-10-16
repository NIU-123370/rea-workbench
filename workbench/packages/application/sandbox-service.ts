import { isBuilder } from "./actor.ts";
import type { Actor } from "./actor.ts";
import { commitDecision, recordDeny, type Step } from "./decision.ts";
import { blockedByReasons, gateFail, issueNames, type GateFailure } from "./gate-failure.ts";
import { assertPayloadClean, redactText, type SensitiveDeclaration } from "./sanitizer.ts";
import { newId, nowInstant } from "../domain/identity.ts";
import type { Id, Instant } from "../domain/identity.ts";
import { asId } from "../domain/identity.ts";
import type { JsonObject } from "../domain/json-value.ts";
import type { Err, Result } from "../domain/result.ts";
import type { NamedErrorCode } from "../contracts/errors.ts";
import type {
  BrokerCommand,
  CancelOwnedBrokerResponse,
  CleanupOwnedBrokerResponse,
  EgressPolicy,
  InspectOwnedBrokerResponse,
  PreflightVerdict,
  SandboxHostFacts,
  SandboxProfileDescriptor,
  StartProfileBrokerRequest,
  StartProfileBrokerResponse,
} from "../contracts/sandbox.ts";
import {
  BROKER_COMMANDS,
  ISOLATION_CONDITIONS,
  cancelOwnedBrokerRequestSchema,
  cleanupOwnedBrokerRequestSchema,
  describeUnsupportedPlatform,
  inspectOwnedBrokerRequestSchema,
  isBrokerCommand,
  startProfileBrokerRequestSchema,
  unmetIsolationConditions,
  UNSUPPORTED_PLATFORM_REASON,
} from "../contracts/sandbox.ts";
import type {
  BrokerTransportFailure,
  EgressPolicyPort,
  SandboxBrokerTransportPort,
  SandboxHostProbePort,
  StorageWriterPort,
} from "./ports.ts";

// SandboxService is the control-plane owner of the broker seam (DESIGN §3, §11,
// §12 / D17, D18, issue #21). It is the only place that decides whether a profile
// may run, and the only place that journals that decision.
//
// Three properties the rest of the module leans on:
//
//   1. Closed command surface. A caller names a command as a string; unless it is one
//      of the four in `BROKER_COMMANDS` it is refused before a request object exists.
//      There is no fallthrough handler and no generic passthrough, and the transport
//      port itself has exactly four methods.
//   2. One refusal point. `preflight()` is the sole derivation of "may this run", and
//      every branch that answers no consumes its verdict instead of re-checking a
//      condition locally. The same invariant tested at several exits is exactly how a
//      fallback creeps back in, so it is derived once and read everywhere else.
//   3. Refuse, never degrade. A broker that would have to weaken isolation answers
//      `refused`; a broker that claims it started while enforcing less than the
//      profile required is still refused, its resource released, and the refusal
//      journalled. Neither path can yield a running, less-isolated target.

export const SANDBOX_RESOURCE_TYPE = "sandbox-profile";

export type SandboxStartOutcome = {
  handle: Id;
  jobId: Id;
  profileId: string;
  auditSeq: number;
  eventSeq: number;
};

export type BrokerCallOutcome =
  | { command: "startProfile"; started: SandboxStartOutcome }
  | { command: "inspectOwned"; response: InspectOwnedBrokerResponse }
  | { command: "cancelOwned"; response: CancelOwnedBrokerResponse }
  | { command: "cleanupOwned"; response: CleanupOwnedBrokerResponse };

type StartRefusal = {
  kind: "refusal";
  code: NamedErrorCode;
  reason: string;
  message: string;
  reasons: string[];
  retryable: boolean;
  retryAt: Instant | null;
  // Set when the broker did start something before the refusal was noticed: §11
  // forbids leaving an owned resource unreclaimed. A wire handle, validated by the
  // response schema, so it is checked rather than trusted here.
  releaseHandle: string | null;
};

type StartVerdict = { kind: "started"; response: StartProfileBrokerResponse } | StartRefusal;

// The broker's answer is untrusted text, so only a filtered form of it may be
// journalled, returned or logged (§12.1). Text that filtered away to nothing becomes
// `diagnostic_unavailable` rather than a guess that the remainder was safe.
function safeMessage(text: string, declaration: SensitiveDeclaration): string {
  const redacted = redactText(text, declaration);
  return redacted.text === "" ? "diagnostic_unavailable" : redacted.text;
}

function unmetNamesPlatform(unmet: readonly string[]): boolean {
  // A read of the verdict, not a second derivation of the platform rule.
  return unmet.some((entry: string) => entry.startsWith(`${UNSUPPORTED_PLATFORM_REASON}:`));
}

function startAuditMetadata(
  request: StartProfileBrokerRequest,
  verdict: PreflightVerdict,
): JsonObject {
  // Named, non-body facts only (§12.2): the shape of the request, never its text.
  return {
    profileId: request.profile.profileId,
    jobId: request.jobId,
    networkPolicyId: request.profile.networkPolicyId,
    egressPolicyId: request.egress.policyId,
    egressGrantCount: request.egress.grants.length,
    scratchCount: request.profile.scratch.length,
    seccompPolicyId: request.profile.isolation.seccomp.policyId,
    conditionCount: ISOLATION_CONDITIONS.length,
    unmetCount: verdict.unmet.length,
  };
}

const OWNED_ALLOW_REASONS: Record<Exclude<BrokerCommand, "startProfile">, string> = {
  inspectOwned: "owned-resource-observed",
  cancelOwned: "owned-resource-cancel-requested",
  cleanupOwned: "owned-resource-cleanup-requested",
};

function fieldsOf(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  return payload as Record<string, unknown>;
}

// A payload handed over by the router is untyped content. Something that is not an
// object has no fields at all, which the request schema then refuses as missing
// keys; nothing here guesses a shape or adopts a default. The caller's own fields are
// kept verbatim — including one that has no place in the contract, which is how an
// `image`, a `shell` or a `dockerArgs` key gets refused instead of quietly dropped.
// Only `requestId` is replaced: it is minted here from node:crypto, so no client text
// can become a request identity (§4) and no forged value can satisfy the client's
// echo check (§12).
function mintedRequest(command: BrokerCommand, payload: unknown): Record<string, unknown> {
  const fields = { ...fieldsOf(payload) };
  delete fields["requestId"];
  return { command, ...fields, requestId: newId() };
}

function decideStartAnswer(
  answered: Result<StartProfileBrokerResponse, BrokerTransportFailure>,
  declaration: SensitiveDeclaration,
): StartVerdict {
  if (!answered.ok) {
    const failure = answered.error;
    return {
      kind: "refusal",
      code: failure.code,
      reason: failure.reason,
      message: safeMessage(failure.message, declaration),
      reasons: [failure.reason],
      retryable: failure.retryable,
      retryAt: failure.retryAt,
      releaseHandle: null,
    };
  }
  const response = answered.value;
  if (response.status === "refused") {
    // D18: the broker refuses instead of falling back. That is a permanent capability
    // failure, so the queue fails the job instead of requeueing it (§11).
    return {
      kind: "refusal",
      code: "CAPABILITY_UNAVAILABLE",
      reason: "broker-refused-isolation",
      message: "the broker refuses to start this profile as specified",
      reasons: response.refusalReasons,
      retryable: false,
      retryAt: null,
      releaseHandle: null,
    };
  }
  const enforced = new Set<string>(response.enforcedConditions);
  const missing = ISOLATION_CONDITIONS.filter((condition: string) => !enforced.has(condition));
  if (missing.length > 0) {
    // Started with less isolation than the profile requires is a degradation, and this
    // module has no representation for one: refuse, release, journal. A `--no-sandbox`
    // outcome is never reachable from here.
    return {
      kind: "refusal",
      code: "CAPABILITY_UNAVAILABLE",
      reason: "broker-degraded-isolation",
      message: "the broker enforced fewer isolation conditions than the profile requires",
      reasons: missing.map((condition: string) => `not-enforced:${condition}`),
      retryable: false,
      retryAt: null,
      releaseHandle: response.handle,
    };
  }
  return { kind: "started", response };
}

export class SandboxService {
  readonly storage: StorageWriterPort;
  readonly transport: SandboxBrokerTransportPort;
  readonly host: SandboxHostProbePort;
  readonly egress: EgressPolicyPort;

  constructor(deps: {
    storage: StorageWriterPort;
    transport: SandboxBrokerTransportPort;
    host: SandboxHostProbePort;
    egress: EgressPolicyPort;
  }) {
    this.storage = deps.storage;
    this.transport = deps.transport;
    this.host = deps.host;
    this.egress = deps.egress;
  }

  // The single decision point (issue #21 checkbox 2). Everything it lists as unmet
  // blocks `runnable`, and nothing outside it decides whether isolation holds. The
  // host facts are an argument rather than a `process.platform` read, so the same
  // rule is provable on a machine with no Docker at all (checkbox 4).
  preflight(input: {
    host: SandboxHostFacts;
    profile: SandboxProfileDescriptor;
    egress: EgressPolicy;
  }): PreflightVerdict {
    const derived = unmetIsolationConditions({ host: input.host, profile: input.profile });
    const reviewed = this.egress.review(input.egress);
    const unmet = [...derived, ...reviewed.reasons.map((reason: string) => `egress:${reason}`)];
    return { unmet, runnable: unmet.length === 0 };
  }

  // The closed door the worker's command router calls. A name outside the four is
  // refused here, before any request object exists, and the refusal is journalled.
  // There is no default branch to fall through to: the switch answers every member of
  // `BrokerCommand`, so a fifth command in the contract stops compiling instead of
  // quietly reaching some other handler.
  async dispatch(
    projectId: Id,
    actor: Actor,
    command: string,
    payload: unknown,
    declaration: SensitiveDeclaration,
  ): Promise<Result<BrokerCallOutcome, GateFailure>> {
    const authorized = this.authorize(projectId, actor, command);
    if (!authorized.ok) return authorized;
    switch (authorized.value) {
      case "startProfile": {
        const started = await this.startProfile(projectId, actor, payload, declaration);
        if (!started.ok) return started;
        return { ok: true, value: { command: "startProfile", started: started.value } };
      }
      case "inspectOwned": {
        const response = await this.inspectOwned(projectId, actor, payload, declaration);
        if (!response.ok) return response;
        return { ok: true, value: { command: "inspectOwned", response: response.value } };
      }
      case "cancelOwned": {
        const response = await this.cancelOwned(projectId, actor, payload, declaration);
        if (!response.ok) return response;
        return { ok: true, value: { command: "cancelOwned", response: response.value } };
      }
      case "cleanupOwned": {
        const response = await this.cleanupOwned(projectId, actor, payload, declaration);
        if (!response.ok) return response;
        return { ok: true, value: { command: "cleanupOwned", response: response.value } };
      }
    }
  }

  private refuseCommand(projectId: Id, actor: Actor, command: string): Err<GateFailure> {
    // The journalled action never echoes arbitrary caller text; an unknown command is
    // recorded under a fixed name (§12.1).
    const safe = isBrokerCommand(command) ? command : "unknown";
    recordDeny(this.storage, {
      projectId,
      actor,
      resourceType: SANDBOX_RESOURCE_TYPE,
      action: `sandbox.${safe}`,
      resourceId: null,
      decision: "deny",
      reasonCode: "command-outside-broker-allowlist",
      metadata: { allowed: [...BROKER_COMMANDS] },
    });
    return gateFail(
      "ACCESS_DENIED",
      "command-outside-broker-allowlist",
      "the broker exposes four named commands and this is not one of them",
      { allowed: [...BROKER_COMMANDS] },
    );
  }

  private refuseActor(projectId: Id, actor: Actor, command: BrokerCommand): Err<GateFailure> {
    recordDeny(this.storage, {
      projectId,
      actor,
      resourceType: SANDBOX_RESOURCE_TYPE,
      action: `sandbox.${command}`,
      resourceId: null,
      decision: "deny",
      reasonCode: "builder-has-no-sandbox-permission",
      metadata: {},
    });
    return gateFail(
      "ACCESS_DENIED",
      "builder-has-no-sandbox-permission",
      "Builder never schedules a target container (D11, D12, D17)",
    );
  }

  // The command allowlist is checked before the actor, so a made-up command is refused
  // as a command instead of being journalled as an actor problem.
  private authorize(projectId: Id, actor: Actor, command: string): Result<BrokerCommand, GateFailure> {
    if (!isBrokerCommand(command)) {
      return this.refuseCommand(projectId, actor, command);
    }
    if (isBuilder(actor)) {
      return this.refuseActor(projectId, actor, command);
    }
    return { ok: true, value: command };
  }

  private refuseParse(
    projectId: Id,
    actor: Actor,
    command: BrokerCommand,
    issues: string[],
  ): Err<GateFailure> {
    // A request that named an image, a shell, a host path or engine arguments lands
    // here: the contract has no field for them, so the unrecognised key *is* the
    // refusal and the reason that reaches the journal (issue #21 checkbox 1).
    recordDeny(this.storage, {
      projectId,
      actor,
      resourceType: SANDBOX_RESOURCE_TYPE,
      action: `sandbox.${command}`,
      resourceId: null,
      decision: "deny",
      reasonCode: "request-outside-broker-contract",
      metadata: { issues },
    });
    return gateFail(
      "INVALID_INPUT",
      "request-outside-broker-contract",
      "the request does not match the broker contract",
      { issues },
    );
  }

  async startProfile(
    projectId: Id,
    actor: Actor,
    payload: unknown,
    declaration: SensitiveDeclaration,
  ): Promise<Result<SandboxStartOutcome, GateFailure>> {
    const authorized = this.authorize(projectId, actor, "startProfile");
    if (!authorized.ok) return authorized;

    // A job asks for a profile plus the egress policy that job was queued with. The
    // request identity is minted here, and every other field is passed through
    // untouched so the strict schema — not this method — is what refuses an unknown
    // field such as an image name or a host path.
    const parsed = startProfileBrokerRequestSchema.safeParse(
      mintedRequest("startProfile", payload),
    );
    if (!parsed.success) {
      return this.refuseParse(projectId, actor, "startProfile", issueNames(parsed.error.issues));
    }
    const request = parsed.data;

    // One probe read, one verdict, consumed by every branch below.
    const host = this.host.observeHost();
    const verdict = this.preflight({ host, profile: request.profile, egress: request.egress });
    if (!verdict.runnable) {
      // D18 and checkbox 2: unmet conditions refuse the start. The job fails before it
      // can run; nothing about the profile is quietly relaxed.
      return this.refuseUnmet(projectId, actor, request, verdict, host);
    }

    const metadata = startAuditMetadata(request, verdict);
    const clean = assertPayloadClean(metadata, declaration);
    if (!clean.ok) {
      return this.refuseSensitive(projectId, actor, request, clean.reason);
    }

    const answered = await this.transport.startProfile(request);
    const decision = decideStartAnswer(answered, declaration);

    const committed = commitDecision<{ handle: string; eventSeq: number }>(this.storage, {
      projectId,
      actor,
      resourceType: SANDBOX_RESOURCE_TYPE,
      action: "sandbox.startProfile",
      resourceId: request.jobId,
      allowReason: "isolation-conditions-met",
      metadata,
      work: (tx): Step<{ handle: string; eventSeq: number }> => {
        if (decision.kind === "refusal") {
          return {
            kind: "failure",
            failure: gateFail(decision.code, decision.reason, decision.message, {
              reasons: decision.reasons,
              retryable: decision.retryable,
              jobId: request.jobId,
              profileId: request.profile.profileId,
            }),
          };
        }
        const handle = decision.response.handle;
        if (handle === null) {
          // The response schema already forbids this pairing; keeping the check means a
          // broker cannot start a container the control plane could never own.
          return {
            kind: "failure",
            failure: gateFail(
              "CAPABILITY_UNAVAILABLE",
              "broker-handle-missing",
              "the broker reported a start without minting an ownership handle",
              { jobId: request.jobId },
            ),
          };
        }
        const eventSeq = tx.appendEvent({
          projectId,
          type: "resource.started",
          aggregateId: request.jobId,
          payloadJson: {
            handle,
            profileId: request.profile.profileId,
            cleanupState: decision.response.cleanupState,
          },
          createdAt: nowInstant(),
        });
        return { kind: "committed", value: { handle, eventSeq } };
      },
    });

    if (decision.kind === "refusal" && decision.releaseHandle !== null) {
      // The resource exists, so it is reclaimed before the refusal is reported. This is
      // not a rerun of business work: cleanup is its own fact (D20, §11).
      await this.cleanupOwned(
        projectId,
        actor,
        {
          jobId: request.jobId,
          handle: decision.releaseHandle,
        },
        declaration,
      );
    }

    if (!committed.ok) return committed;
    return {
      ok: true,
      value: {
        handle: asId(committed.value.value.handle),
        jobId: asId(request.jobId),
        profileId: request.profile.profileId,
        auditSeq: committed.value.auditSeq,
        eventSeq: committed.value.value.eventSeq,
      },
    };
  }

  private refuseUnmet(
    projectId: Id,
    actor: Actor,
    request: StartProfileBrokerRequest,
    verdict: PreflightVerdict,
    host: SandboxHostFacts,
  ): Err<GateFailure> {
    const unsupported = unmetNamesPlatform(verdict.unmet);
    const metadata: JsonObject = {
      profileId: request.profile.profileId,
      unmet: verdict.unmet,
      unmetCount: verdict.unmet.length,
    };
    if (unsupported) {
      // Checkbox 4: the refusal names the platform this module has never been verified
      // on, so nobody can read the gap as a transient failure.
      metadata.unsupportedPlatform = { ...describeUnsupportedPlatform(host) };
    }
    recordDeny(this.storage, {
      projectId,
      actor,
      resourceType: SANDBOX_RESOURCE_TYPE,
      action: "sandbox.startProfile",
      resourceId: request.jobId,
      decision: "deny",
      reasonCode: unsupported ? UNSUPPORTED_PLATFORM_REASON : "isolation-conditions-unmet",
      metadata,
    });
    return blockedByReasons(verdict.unmet, "CAPABILITY_UNAVAILABLE", "the target profile");
  }

  private refuseSensitive(
    projectId: Id,
    actor: Actor,
    request: StartProfileBrokerRequest,
    reason: string,
  ): Err<GateFailure> {
    recordDeny(this.storage, {
      projectId,
      actor,
      resourceType: SANDBOX_RESOURCE_TYPE,
      action: "sandbox.startProfile",
      resourceId: request.jobId,
      decision: "deny",
      reasonCode: reason,
      metadata: { profileId: request.profile.profileId },
    });
    return gateFail(
      "SENSITIVE_CONTENT_BLOCKED",
      reason,
      "the sandbox request carries content the diagnostics owner must not journal",
      { jobId: request.jobId },
    );
  }

  async inspectOwned(
    projectId: Id,
    actor: Actor,
    payload: unknown,
    declaration: SensitiveDeclaration,
  ): Promise<Result<InspectOwnedBrokerResponse, GateFailure>> {
    const authorized = this.authorize(projectId, actor, "inspectOwned");
    if (!authorized.ok) return authorized;
    const parsed = inspectOwnedBrokerRequestSchema.safeParse(
      mintedRequest("inspectOwned", payload),
    );
    if (!parsed.success) {
      return this.refuseParse(
        projectId,
        actor,
        "inspectOwned",
        issueNames(parsed.error.issues),
      );
    }
    const answered = await this.transport.inspectOwned(parsed.data);
    return this.journalOwned(
      projectId,
      actor,
      "inspectOwned",
      parsed.data.jobId,
      answered,
      declaration,
    );
  }

  async cancelOwned(
    projectId: Id,
    actor: Actor,
    payload: unknown,
    declaration: SensitiveDeclaration,
  ): Promise<Result<CancelOwnedBrokerResponse, GateFailure>> {
    const authorized = this.authorize(projectId, actor, "cancelOwned");
    if (!authorized.ok) return authorized;
    const parsed = cancelOwnedBrokerRequestSchema.safeParse(mintedRequest("cancelOwned", payload));
    if (!parsed.success) {
      return this.refuseParse(projectId, actor, "cancelOwned", issueNames(parsed.error.issues));
    }
    const answered = await this.transport.cancelOwned(parsed.data);
    return this.journalOwned(
      projectId,
      actor,
      "cancelOwned",
      parsed.data.jobId,
      answered,
      declaration,
    );
  }

  async cleanupOwned(
    projectId: Id,
    actor: Actor,
    payload: unknown,
    declaration: SensitiveDeclaration,
  ): Promise<Result<CleanupOwnedBrokerResponse, GateFailure>> {
    const authorized = this.authorize(projectId, actor, "cleanupOwned");
    if (!authorized.ok) return authorized;
    const parsed = cleanupOwnedBrokerRequestSchema.safeParse(mintedRequest("cleanupOwned", payload));
    if (!parsed.success) {
      return this.refuseParse(projectId, actor, "cleanupOwned", issueNames(parsed.error.issues));
    }
    const answered = await this.transport.cleanupOwned(parsed.data);
    return this.journalOwned(
      projectId,
      actor,
      "cleanupOwned",
      parsed.data.jobId,
      answered,
      declaration,
    );
  }

  // Preflight deliberately does not gate these three. §11 forbids a cleanup from being
  // blocked by the same condition that made the start fail: an unmet isolation
  // condition must never strand an owned resource. What still gates them is the command
  // allowlist, the contract, and the broker's ownership answer.
  private journalOwned<Response extends InspectOwnedBrokerResponse | CancelOwnedBrokerResponse | CleanupOwnedBrokerResponse>(
    projectId: Id,
    actor: Actor,
    command: Exclude<BrokerCommand, "startProfile">,
    jobId: string,
    answered: Result<Response, BrokerTransportFailure>,
    declaration: SensitiveDeclaration,
  ): Result<Response, GateFailure> {
    const outcome = commitDecision<Response>(this.storage, {
      projectId,
      actor,
      resourceType: SANDBOX_RESOURCE_TYPE,
      action: `sandbox.${command}`,
      resourceId: jobId,
      allowReason: OWNED_ALLOW_REASONS[command],
      metadata: { jobId, command },
      work: (tx): Step<Response> => {
        if (!answered.ok) {
          return {
            kind: "failure",
            failure: gateFail(answered.error.code, answered.error.reason, safeMessage(answered.error.message, declaration), {
              command,
              jobId,
              retryable: answered.error.retryable,
            }),
          };
        }
        const response = answered.value;
        if (!response.owned) {
          // The broker does not acknowledge this handle as belonging to this job, so
          // nothing about the resource is reported and the refusal is journalled
          // (§11: 不按 PID/path 猜测所有权).
          return {
            kind: "failure",
            failure: gateFail(
              "ACCESS_DENIED",
              "ownership-unproven",
              "the broker does not acknowledge this handle as owned by the job",
              { command },
            ),
          };
        }
        if (command !== "inspectOwned") {
          // A read journals a decision but no event; a state change journals both.
          // `status` belongs to the two commands that change state, and an inspect
          // answer carries presence/exit facts instead.
          const status: string = "status" in response ? response.status : "observed";
          tx.appendEvent({
            projectId,
            type:
              command === "cancelOwned" ? "resource.cancelRequested" : "resource.cleanupRequested",
            aggregateId: jobId,
            payloadJson: { command, status },
            createdAt: nowInstant(),
          });
        }
        return { kind: "committed", value: response };
      },
    });
    if (!outcome.ok) return outcome;
    return { ok: true, value: outcome.value.value };
  }
}

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import type {
  EgressPolicy,
  IsolationCondition,
  SandboxHostCapacity,
  SandboxHostFacts,
  SandboxProfileDescriptor,
} from "../../packages/contracts/sandbox.ts";

// The broker's own half of §3 line 74: it observes the host, mints the ownership
// credential, and drives one engine. Nothing here reaches a database, an
// application service or another adapter - the protocol in `protocol.ts` is the only
// way in, and this module is the only way out.

// §11's rule that a platform verdict must come from an injected probe rather than
// `process.platform` is kept literally: the facts are read from `uname`, and the
// strategy below never opens `process.platform` at all (the architecture test that
// watches the sandbox sources for that reads this directory too).
export const UNAME_ARGS = ["-s", "-m"] as const;

// The engines this build knows how to supervise. A name here is a *path check*, not
// a claim that the container works: `enforcedConditions` stays empty until a probe
// proves each condition, and an empty list is a refusal, not a weaker start (D18).
export const KNOWN_ENGINES = ["bwrap", "docker"] as const;

export type EngineName = (typeof KNOWN_ENGINES)[number];

export type HostObservation = {
  facts: SandboxHostFacts;
  engine: EngineName | null;
  // Named reasons the operator sees in the broker's own log line: the shape of "this
  // host cannot run the supervision", never a stack or a host path.
  reasons: string[];
};

function unameFacts(): { platform: string; arch: string } | null {
  try {
    const out = execFileSync("uname", [...UNAME_ARGS], { encoding: "utf8" });
    const [platform, arch] = out.trim().split(/\s+/u);
    if (typeof platform !== "string" || typeof arch !== "string") return null;
    return { platform: platform.toLowerCase(), arch };
  } catch {
    return null;
  }
}

// Exported so the test can ask the same question the probe asks, instead of re-listing the
// directories and passing while the probe looks somewhere else.
export const ENGINE_DIRECTORIES = ["/usr/bin", "/bin", "/usr/local/bin"] as const;

export function enginePath(name: EngineName): string | null {
  for (const dir of ENGINE_DIRECTORIES) {
    const candidate = `${dir}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Capacity defaults are *measured* values, never guesses: the profile registry (§14
// line 475) refuses a profile whose ceiling exceeds what this report can grant, so
// an optimistic number here would turn into a start that the kernel refuses later.
// Until a supervisor capability probe exists, every ceiling reports zero and the
// honest consequence is that no profile is runnable.
export const UNPROBED_CAPACITY: SandboxHostCapacity = {
  cpuCores: 0,
  memoryBytes: 0,
  pids: 0,
  diskBytes: 0,
};

export function observeHost(): HostObservation {
  const observed = unameFacts();
  const reasons: string[] = [];
  if (observed === null) reasons.push("host-identity-unobservable");
  const engineNames = KNOWN_ENGINES.filter((name) => enginePath(name) !== null);
  const engine = engineNames.length > 0 ? (engineNames[0] as EngineName) : null;
  if (engine === null) reasons.push("no-known-container-engine");
  return {
    facts: {
      platform: observed?.platform ?? "unknown",
      arch: observed?.arch ?? "unknown",
      // Proven enforcement is a separate claim from engine presence; with no probe
      // that has run, the honest list is empty and every condition reads as unmet.
      enforcedConditions: [],
      capacity: UNPROBED_CAPACITY,
    },
    engine,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Ownership credential
// ---------------------------------------------------------------------------

// The handle is minted here and nowhere else. §11 says cleanup may only touch
// resources this workbench owns, and "this workbench owns it" has to be an answer
// the broker can give from its own record - not a PID, container name or path a
// caller could guess or forge.
export type OwnedRecord = {
  handle: Id;
  jobId: Id;
  profileId: string;
  startedAt: Instant;
  cancelRequested: boolean;
  cleanupState: "pending" | "complete" | "failed";
};

export class OwnershipRegistry {
  readonly records = new Map<string, OwnedRecord>();

  mint(input: { jobId: Id; profileId: string }): Id {
    const handle = newId();
    this.records.set(handle, {
      handle,
      jobId: input.jobId,
      profileId: input.profileId,
      startedAt: nowInstant(),
      cancelRequested: false,
      cleanupState: "pending",
    });
    return handle;
  }

  // The naming matters: `lookup` answers "is this mine, and is it yours", so a
  // request for another job's handle reads as not-owned rather than as a conflict.
  lookup(handle: string): OwnedRecord | null {
    return this.records.get(handle) ?? null;
  }

  ownedBy(handle: string, jobId: string): OwnedRecord | null {
    const record = this.records.get(handle) ?? null;
    if (record === null || record.jobId !== jobId) return null;
    return record;
  }

  markCancelled(handle: string): void {
    const record = this.records.get(handle);
    if (record === undefined) return;
    record.cancelRequested = true;
  }

  markCleanup(handle: string, state: OwnedRecord["cleanupState"]): void {
    const record = this.records.get(handle);
    if (record === undefined) return;
    record.cleanupState = state;
  }

  // Revocation is the end of the credential's life: after cleanup completes the
  // handle proves nothing, and keeping it would let a later request address a
  // resource that no longer exists as if it were still owned.
  revoke(handle: string): void {
    this.records.delete(handle);
  }
}

// ---------------------------------------------------------------------------
// Engine port
// ---------------------------------------------------------------------------

export type EngineStart = {
  ok: true;
  // The engine's own resource id. It never crosses the protocol: `inspectOwned`
  // answers with presence and exit state, and a caller has no way to name a
  // resource it does not hold a handle for.
  resourceId: string;
  enforcedConditions: IsolationCondition[];
};

export type EngineFailure = {
  ok: false;
  reasons: string[];
  enforcedConditions: IsolationCondition[];
};

export type EngineInspect = {
  present: boolean;
  running: boolean;
};

export type BrokerEnginePort = {
  name: EngineName;
  start(record: OwnedRecord, profile: SandboxProfileDescriptor, egress: EgressPolicy): Promise<EngineStart | EngineFailure>;
  inspect(record: OwnedRecord): Promise<EngineInspect>;
  cancel(record: OwnedRecord): Promise<{ cancelled: boolean }>;
  cleanup(record: OwnedRecord): Promise<{ done: boolean; failed: boolean }>;
};

export function randomScratchToken(): string {
  // 16 random bytes, hex: a directory name that a caller cannot guess and that never
  // travels on the protocol.
  return randomBytes(16).toString("hex");
}

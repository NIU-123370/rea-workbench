import { z } from "zod";

import { profileLimitsSchema } from "./health.ts";
import { digestSchema, idSchema, instantSchema, nonEmptyString } from "./primitives.ts";

// The host broker's whole wire surface (DESIGN §12, §3, D17/D18).
//
// D17 puts container scheduling in a restricted broker that the UI, the Agents
// and the target never touch; the broker in turn never touches the Docker socket
// on behalf of a caller-supplied argument. That only holds if the protocol has
// nowhere to *put* an image name, a shell, a host path or engine arguments, so
// this file is written as a closed vocabulary rather than a permissive one:
//
//   * exactly four named commands exist;
//   * every object is a strictObject, so an extra `image` / `shell` / `hostPath`
//     / `dockerArgs` field is an unrecognised key, not a silently accepted one;
//   * the profile descriptor carries *requirements* (uid, caps, tmpfs sizes,
//     seccomp digest) and no transport-level knob at all — the renderer mints the
//     engine arguments and the container paths from these facts;
//   * egress is default-deny plus explicitly named grants, each with a purpose.
//
// Isolation conditions that cannot be met produce a refusal (D18: 不回退到
// `--no-sandbox`); nothing in these schemas can express "try anyway, weaker".

export const BROKER_COMMANDS = [
  "startProfile",
  "inspectOwned",
  "cancelOwned",
  "cleanupOwned",
] as const;

export type BrokerCommand = (typeof BROKER_COMMANDS)[number];

export const brokerCommandSchema = z.enum(BROKER_COMMANDS);

export function isBrokerCommand(value: string): value is BrokerCommand {
  return (BROKER_COMMANDS as readonly string[]).includes(value);
}

// The conditions DESIGN §12 lists for a target profile. They are named here once
// so the host report, the preflight verdict and the renderer cannot each invent
// their own spelling of "isolated enough".
export const ISOLATION_CONDITIONS = [
  "nonRoot",
  "readOnlyRootfs",
  "privateTmpfs",
  "capDropAll",
  "noNewPrivileges",
  "browserSandbox",
  "seccompVerified",
  "defaultDenyEgress",
] as const;

export type IsolationCondition = (typeof ISOLATION_CONDITIONS)[number];

export const isolationConditionSchema = z.enum(ISOLATION_CONDITIONS);

export const CAP_DROP_ALL = "ALL";

// The broker supervises containers through one engine on one host type. This is
// a claim about *this* repository's verification state, not a general Docker
// requirement: the module has only ever been exercised on Linux x64 hosts in CI
// and nothing here has run a container on another platform (issue #21).
export const SANDBOX_HOST_REQUIREMENTS = {
  platform: "linux",
  arch: "x64",
  // Honest status of the isolation path: no container, seccomp load or network
  // namespace has been executed by this repository's gates.
  verified: false,
  advisory:
    "sandbox isolation is unverified outside a Linux x64 host and must not be advertised as a supported platform until T19 isolation acceptance has run",
} as const;

export const UNSUPPORTED_PLATFORM_REASON = "platform-unsupported";

export const RESOURCE_LIMIT_DIMENSIONS = [
  "cpuCores",
  "memoryBytes",
  "pids",
  "diskBytes",
] as const;

export type ResourceLimitDimension = (typeof RESOURCE_LIMIT_DIMENSIONS)[number];

export const sandboxHostCapacitySchema = z.strictObject({
  cpuCores: z.int().positive(),
  memoryBytes: z.int().positive(),
  pids: z.int().positive(),
  diskBytes: z.int().positive(),
});

// What the host supervisor reports about itself. The workbench never derives
// this from `process.platform` inside a policy: it is passed in by the assembly
// seam (apps/worker) or by a probe, so the same rule can be exercised on any
// host (issue #21 checkbox 4).
export const sandboxHostFactsSchema = z.strictObject({
  platform: nonEmptyString,
  arch: nonEmptyString,
  // Only conditions the supervisor can *prove* it enforces belong here.
  enforcedConditions: z.array(isolationConditionSchema),
  capacity: sandboxHostCapacitySchema,
});

export type SandboxHostFacts = z.infer<typeof sandboxHostFactsSchema>;
export type SandboxHostCapacity = z.infer<typeof sandboxHostCapacitySchema>;

export const unsupportedPlatformSchema = z.strictObject({
  code: z.literal("CAPABILITY_UNAVAILABLE"),
  reason: z.literal(UNSUPPORTED_PLATFORM_REASON),
  requiredPlatform: nonEmptyString,
  requiredArch: nonEmptyString,
  observedPlatform: nonEmptyString,
  observedArch: nonEmptyString,
  // A host that has not run the isolation acceptance cannot claim it is
  // supported, so this stays literal `false` for every host today.
  verifiedOnHost: z.literal(false),
  advisory: nonEmptyString,
});

export type UnsupportedPlatform = z.infer<typeof unsupportedPlatformSchema>;

export function isSupportedSandboxHost(facts: {
  platform: string;
  arch: string;
}): boolean {
  return (
    facts.platform === SANDBOX_HOST_REQUIREMENTS.platform &&
    facts.arch === SANDBOX_HOST_REQUIREMENTS.arch
  );
}

export function describeUnsupportedPlatform(facts: SandboxHostFacts): UnsupportedPlatform {
  return {
    code: "CAPABILITY_UNAVAILABLE",
    reason: UNSUPPORTED_PLATFORM_REASON,
    requiredPlatform: SANDBOX_HOST_REQUIREMENTS.platform,
    requiredArch: SANDBOX_HOST_REQUIREMENTS.arch,
    observedPlatform: facts.platform,
    observedArch: facts.arch,
    verifiedOnHost: false,
    advisory: SANDBOX_HOST_REQUIREMENTS.advisory,
  };
}

// ---------------------------------------------------------------------------
// Profile descriptor
// ---------------------------------------------------------------------------

// A scratch area is identified, never addressed: the renderer mints the
// container path from `scratchId`, so there is no field on this protocol that
// could carry a host path (D17: 禁止任意宿主 mount).
export const sandboxScratchSchema = z.strictObject({
  scratchId: idSchema,
  purpose: z.enum(["workdir", "browser-profile", "download"]),
  sizeLimitBytes: z.int().min(4096).max(1_000_000_000_000),
  // A writable tmpfs that is also mounted read-only somewhere else is a
  // contradiction, so the flag is explicit instead of implied.
  readOnly: z.boolean(),
});

export type SandboxScratch = z.infer<typeof sandboxScratchSchema>;

// DESIGN §12 requires a *verified* seccomp profile. A policy the operator has
// not pinned by digest is therefore not expressible here at all.
export const sandboxSeccompSchema = z.strictObject({
  policyId: nonEmptyString,
  digest: digestSchema,
  verified: z.literal(true),
});

export type SandboxSeccomp = z.infer<typeof sandboxSeccompSchema>;

export const sandboxIsolationSchema = z.strictObject({
  // Each requirement is a literal: a profile cannot ask for a weaker target and
  // have the workbench quietly agree. `privileged` and host namespaces have no
  // admissible value at all.
  nonRoot: z.literal(true),
  runAsUserId: z.int().min(1).max(65_534),
  runAsGroupId: z.int().min(1).max(65_534),
  readOnlyRootfs: z.literal(true),
  noNewPrivileges: z.literal(true),
  droppedCapabilities: z
    .array(nonEmptyString)
    .refine((caps: string[]) => caps.includes(CAP_DROP_ALL), {
      message: "a target profile must drop all capabilities",
    }),
  // Re-admitting a capability after `ALL` would be the fallback this design
  // refuses, so the keep list exists only to be empty.
  keptCapabilities: z
    .array(nonEmptyString)
    .refine((caps: string[]) => caps.length === 0, {
      message: "no capability may be kept after dropping all",
    }),
  browserSandbox: z.literal(true),
  privileged: z.literal(false),
  hostNamespaces: z
    .array(z.enum(["network", "pid", "ipc", "mount", "user", "uts", "cgroup"]))
    .refine((list: string[]) => list.length === 0, {
      message: "host namespaces are forbidden for target profiles",
    }),
  dockerSocketAccess: z.literal(false),
  seccomp: sandboxSeccompSchema,
});

export type SandboxIsolation = z.infer<typeof sandboxIsolationSchema>;

// The profile the control plane sends to the broker. Note what is absent: no
// image name or tag (only the digests health already reports), no entrypoint,
// no shell, no command line, no volume list, no engine arguments.
export const sandboxProfileDescriptorSchema = z.strictObject({
  profileId: nonEmptyString,
  schemaVersion: z.int().positive(),
  limits: profileLimitsSchema,
  networkPolicyId: nonEmptyString,
  isolation: sandboxIsolationSchema,
  // Controlled writable tmpfs is a requirement, so an empty list is refused
  // rather than read as "no scratch needed".
  scratch: z.array(sandboxScratchSchema).min(1),
});

export type SandboxProfileDescriptor = z.infer<typeof sandboxProfileDescriptorSchema>;

// ---------------------------------------------------------------------------
// Egress policy
// ---------------------------------------------------------------------------

// The classes DESIGN §12 blocks outright: 宿主控制面、loopback、私网、link-local
// 与元数据地址. `public` is the only class a grant may name.
export const EGRESS_ADDRESS_CLASSES = [
  "loopback",
  "private",
  "link-local",
  "metadata",
  "unspecified",
  "multicast",
  "reserved",
  "carrier-nat",
  "public",
] as const;

export type EgressAddressClass = (typeof EGRESS_ADDRESS_CLASSES)[number];

export const egressAddressClassSchema = z.enum(EGRESS_ADDRESS_CLASSES);

export const BLOCKED_EGRESS_CLASSES: readonly EgressAddressClass[] = [
  "loopback",
  "private",
  "link-local",
  "metadata",
  "unspecified",
  "multicast",
  "reserved",
  "carrier-nat",
];

// Destinations are structured addresses, never strings to be prefix-matched:
// `10.0.0.0/8` and `10.x` text lookups are exactly the bug class this policy has
// to get right, so the adapter does byte and mask arithmetic on these values.
export const egressDestinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ipv4Host"),
    address: z.ipv4(),
  }),
  z.strictObject({
    kind: z.literal("ipv6Host"),
    address: z.ipv6(),
  }),
  z.strictObject({
    kind: z.literal("ipv4Prefix"),
    address: z.ipv4(),
    prefixLength: z.int().min(0).max(32),
  }),
  z.strictObject({
    kind: z.literal("ipv6Prefix"),
    address: z.ipv6(),
    prefixLength: z.int().min(0).max(128),
  }),
]);

export type EgressDestination = z.infer<typeof egressDestinationSchema>;

export const EGRESS_GRANT_KINDS = ["publicDestination", "localFixture"] as const;

export const egressGrantSchema = z
  .strictObject({
    grantId: idSchema,
    destination: egressDestinationSchema,
    port: z.int().min(1).max(65_535),
    // §12: an exception is only ever an exception for a named reason. A grant
    // without a purpose is a wildcard with extra steps.
    purpose: nonEmptyString,
    kind: z.enum(EGRESS_GRANT_KINDS),
    fixtureId: idSchema.nullable(),
  })
  .refine(
    (grant: { kind: string; fixtureId: unknown }) =>
      grant.kind === "localFixture" ? grant.fixtureId !== null : true,
    { message: "a local fixture grant must name the fixture it exists for" },
  );

export type EgressGrant = z.infer<typeof egressGrantSchema>;

export const egressPolicySchema = z
  .strictObject({
    policyId: nonEmptyString,
    // Deny is the only default this protocol can carry; `allow` has no
    // representation, so "open the network a bit" is not a thing a caller can ask for.
    defaultAction: z.literal("deny"),
    // `fixture` is the separate network a local test fixture lives on (§12:
    // 测试用本地 fixture 使用专用 profile 和独立网络显式例外).
    networkNamespace: z.enum(["isolated", "fixture"]),
    grants: z.array(egressGrantSchema),
  })
  .refine(
    (policy: { networkNamespace: string; grants: { kind: string }[] }) =>
      policy.grants.some((grant) => grant.kind === "localFixture")
        ? policy.networkNamespace === "fixture"
        : true,
    { message: "a fixture grant requires the dedicated fixture network, not the isolated one" },
  );

export type EgressPolicy = z.infer<typeof egressPolicySchema>;

// A destination the policy denies outright, before any grant is consulted.
export function isBlockedClass(value: EgressAddressClass): boolean {
  return BLOCKED_EGRESS_CLASSES.includes(value);
}

// ---------------------------------------------------------------------------
// The four commands
// ---------------------------------------------------------------------------

export const startProfileBrokerRequestSchema = z.strictObject({
  command: z.literal("startProfile"),
  // Minted by the control plane from node:crypto; never caller-supplied text.
  requestId: idSchema,
  jobId: idSchema,
  taskId: idSchema.nullable(),
  profile: sandboxProfileDescriptorSchema,
  egress: egressPolicySchema,
});

export const startProfileBrokerResponseSchema = z
  .strictObject({
    command: z.literal("startProfile"),
    requestId: idSchema,
    status: z.enum(["started", "refused"]),
    // The broker-minted ownership handle. Nothing on this protocol carries a
    // PID, a container name or a path, because those are exactly what a caller
    // could later forge or guess at (§11: 不按 PID/path 猜测).
    handle: idSchema.nullable(),
    refusalReasons: z.array(nonEmptyString),
    // Re-reported by the broker: what it actually enforced, which may be a
    // subset of what the profile asked for. A subset is a refusal, not a note.
    enforcedConditions: z.array(isolationConditionSchema),
    cleanupState: z.enum(["pending", "complete", "failed"]),
  })
  .refine(
    (response: { status: string; handle: unknown; refusalReasons: string[] }) =>
      response.status === "started"
        ? response.handle !== null && response.refusalReasons.length === 0
        : response.handle === null && response.refusalReasons.length > 0,
    { message: "a started response needs a handle, a refused response needs named reasons" },
  );

export type StartProfileBrokerRequest = z.infer<typeof startProfileBrokerRequestSchema>;
export type StartProfileBrokerResponse = z.infer<typeof startProfileBrokerResponseSchema>;

// The three `*Owned` commands are scoped by the handle the broker minted, so
// "inspect", "cancel" and "cleanup" can only ever address a resource this job
// owns (issue #21 checkbox 1).
const ownedScopeFields = {
  requestId: idSchema,
  jobId: idSchema,
  handle: idSchema,
};

export const inspectOwnedBrokerRequestSchema = z.strictObject({
  command: z.literal("inspectOwned"),
  ...ownedScopeFields,
});

// §11 requires these four facts to be modelled separately and to stay `unknown`
// when they cannot be proven; a boolean guess is not acceptable here.
export const resourcePresenceSchema = z.enum(["present", "absent", "unknown"]);
export const resourceExitStateSchema = z.enum(["exited", "running", "unknown"]);

export const inspectOwnedBrokerResponseSchema = z.strictObject({
  command: z.literal("inspectOwned"),
  requestId: idSchema,
  // False means the broker does not acknowledge this handle as belonging to the
  // job; the control plane must then refuse to act on the resource at all.
  owned: z.boolean(),
  presence: resourcePresenceSchema,
  exitState: resourceExitStateSchema,
  cleanupState: z.enum(["pending", "complete", "failed"]),
  editable: z.boolean(),
});

export type InspectOwnedBrokerRequest = z.infer<typeof inspectOwnedBrokerRequestSchema>;
export type InspectOwnedBrokerResponse = z.infer<typeof inspectOwnedBrokerResponseSchema>;

export const cancelOwnedBrokerRequestSchema = z.strictObject({
  command: z.literal("cancelOwned"),
  ...ownedScopeFields,
});

export const cancelOwnedBrokerResponseSchema = z.strictObject({
  command: z.literal("cancelOwned"),
  requestId: idSchema,
  owned: z.boolean(),
  status: z.enum(["cancelling", "cancelled", "alreadyTerminal", "refused"]),
  refusalReasons: z.array(nonEmptyString),
});

export type CancelOwnedBrokerRequest = z.infer<typeof cancelOwnedBrokerRequestSchema>;
export type CancelOwnedBrokerResponse = z.infer<typeof cancelOwnedBrokerResponseSchema>;

export const cleanupOwnedBrokerRequestSchema = z.strictObject({
  command: z.literal("cleanupOwned"),
  ...ownedScopeFields,
});

// Cleanup is a separate fact from the job result (D20): a successful cleanup
// never reruns the business work, and a failed one keeps the lease and reports
// the next retry time instead of deleting the record.
export const cleanupOwnedBrokerResponseSchema = z.strictObject({
  command: z.literal("cleanupOwned"),
  requestId: idSchema,
  owned: z.boolean(),
  status: z.enum(["complete", "failed", "refused"]),
  cleanupState: z.enum(["pending", "complete", "failed"]),
  retryAt: instantSchema.nullable(),
  refusalReasons: z.array(nonEmptyString),
});

export type CleanupOwnedBrokerRequest = z.infer<typeof cleanupOwnedBrokerRequestSchema>;
export type CleanupOwnedBrokerResponse = z.infer<typeof cleanupOwnedBrokerResponseSchema>;

export const brokerRequestSchema = z.discriminatedUnion("command", [
  startProfileBrokerRequestSchema,
  inspectOwnedBrokerRequestSchema,
  cancelOwnedBrokerRequestSchema,
  cleanupOwnedBrokerRequestSchema,
]);

export const brokerResponseSchema = z.discriminatedUnion("command", [
  startProfileBrokerResponseSchema,
  inspectOwnedBrokerResponseSchema,
  cancelOwnedBrokerResponseSchema,
  cleanupOwnedBrokerResponseSchema,
]);

export type BrokerRequest = z.infer<typeof brokerRequestSchema>;
export type BrokerResponse = z.infer<typeof brokerResponseSchema>;

// ---------------------------------------------------------------------------
// Preflight verdict
// ---------------------------------------------------------------------------

// One DTO for "can this profile run on this host as specified". Both the control
// plane and the renderer consume this verdict; neither re-derives the rule, which
// is why the same invariant cannot drift between two exits.
export const preflightVerdictSchema = z
  .strictObject({
    unmet: z.array(nonEmptyString),
    runnable: z.boolean(),
  })
  .refine(
    (verdict: { unmet: string[]; runnable: boolean }) =>
      // A verdict may not claim "runnable" while still listing a gap: that pair
      // is how a fallback sneaks back in behind an otherwise honest refusal.
      verdict.runnable === (verdict.unmet.length === 0),
    { message: "a verdict with unmet conditions cannot report itself runnable" },
  );

export type PreflightVerdict = z.infer<typeof preflightVerdictSchema>;

// The single derivation of the unmet list. Deliberately total: it reports every
// gap at once, because "one more edit will pass" is the worst possible reading of
// a partial list (see gate-failure.ts, which makes the same choice for the gates
// that came before this one).
export function unmetIsolationConditions(input: {
  host: SandboxHostFacts;
  profile: SandboxProfileDescriptor;
}): string[] {
  const unmet: string[] = [];
  if (!isSupportedSandboxHost(input.host)) {
    unmet.push(
      `${UNSUPPORTED_PLATFORM_REASON}:${SANDBOX_HOST_REQUIREMENTS.platform}/${SANDBOX_HOST_REQUIREMENTS.arch}`,
    );
  }
  const enforced = new Set<string>(input.host.enforcedConditions);
  for (const condition of ISOLATION_CONDITIONS) {
    if (!enforced.has(condition)) {
      unmet.push(`isolation-condition-unmet:${condition}`);
    }
  }
  // D18 pins explicit resource limits: a profile whose ceiling exceeds what the
  // supervisor can grant is unrunnable, not "best effort within reach".
  for (const dimension of RESOURCE_LIMIT_DIMENSIONS) {
    if (input.profile.limits[dimension] > input.host.capacity[dimension]) {
      unmet.push(`resource-limit-unavailable:${dimension}`);
    }
  }
  return unmet;
}

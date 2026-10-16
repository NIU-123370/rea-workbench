import { describe, expect, it } from "vitest";

import { newId } from "../../packages/domain/identity.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import type { Result } from "../../packages/domain/result.ts";
import {
  BROKER_COMMANDS,
  ISOLATION_CONDITIONS,
  brokerCommandSchema,
  cancelOwnedBrokerResponseSchema,
  cleanupOwnedBrokerRequestSchema,
  describeUnsupportedPlatform,
  egressPolicySchema,
  inspectOwnedBrokerResponseSchema,
  isBrokerCommand,
  isSupportedSandboxHost,
  preflightVerdictSchema,
  sandboxProfileDescriptorSchema,
  sandboxScratchSchema,
  startProfileBrokerRequestSchema,
  startProfileBrokerResponseSchema,
  unmetIsolationConditions,
  unsupportedPlatformSchema,
} from "../../packages/contracts/sandbox.ts";
import type {
  EgressDestination,
  EgressGrant,
  EgressPolicy,
  SandboxHostFacts,
  SandboxProfileDescriptor,
  StartProfileBrokerRequest,
} from "../../packages/contracts/sandbox.ts";
import { parseStrict } from "../../packages/contracts/parse.ts";
import {
  SandboxEgressPolicy,
  classifyAddress,
  expandIpv6Bytes,
  matchesPrefix,
  parseDestination,
  parseIpv4Bytes,
} from "../../packages/adapters/sandbox/egress.ts";
import {
  FORBIDDEN_ENGINE_ARGUMENTS,
  SCRATCH_ROOT,
  assertArgsAdmissible,
  isRenderableLabel,
  mintScratchPath,
  networkModeFor,
  renderStartPlan,
} from "../../packages/adapters/sandbox/broker.ts";
import type {
  ContainerSpec,
  SandboxImageAllowlist,
} from "../../packages/adapters/sandbox/broker.ts";
import {
  BrokerClient,
  MAX_BROKER_FRAME_BYTES,
  decodeBrokerResponse,
  encodeBrokerRequest,
} from "../../packages/adapters/sandbox/broker-client.ts";
import { SandboxService } from "../../packages/application/sandbox-service.ts";
import { issueNames } from "../../packages/application/gate-failure.ts";
import type {
  StoragePortError,
  StorageTransaction,
  StorageWriterPort,
} from "../../packages/application/ports.ts";

// Policy coverage for issue #21 with no Docker anywhere in sight: the four-command
// allowlist, the isolation conditions that must block a start, and the egress
// equivalence classes. Every case here is a pure data decision, which is exactly why
// the module can be proven on a machine that cannot run a container.

const DIGEST_A = ("a" as const).repeat(64) as Digest;
const DIGEST_B = ("b" as const).repeat(64) as Digest;
const ALL_CONDITIONS = [...ISOLATION_CONDITIONS];

function hostFacts(overrides: Partial<SandboxHostFacts> = {}): SandboxHostFacts {
  return {
    platform: "linux",
    arch: "x64",
    enforcedConditions: ALL_CONDITIONS,
    capacity: { cpuCores: 8, memoryBytes: 8_000_000_000, pids: 512, diskBytes: 20_000_000_000 },
    ...overrides,
  };
}

function profileDescriptor(
  overrides: Partial<SandboxProfileDescriptor> = {},
): SandboxProfileDescriptor {
  return {
    profileId: "target-chromium",
    schemaVersion: 1,
    limits: {
      cpuCores: 2,
      memoryBytes: 2_000_000_000,
      pids: 128,
      diskBytes: 4_000_000_000,
      maxExpandedBytes: 64_000_000,
      queueWaitMs: 30_000,
      timeoutMs: 120_000,
    },
    networkPolicyId: "deny-all",
    isolation: {
      nonRoot: true,
      runAsUserId: 1000,
      runAsGroupId: 1000,
      readOnlyRootfs: true,
      noNewPrivileges: true,
      droppedCapabilities: ["ALL"],
      keptCapabilities: [],
      browserSandbox: true,
      privileged: false,
      hostNamespaces: [],
      dockerSocketAccess: false,
      seccomp: { policyId: "workbench-target-v1", digest: DIGEST_A, verified: true },
    },
    scratch: [
      { scratchId: newId(), purpose: "workdir", sizeLimitBytes: 1_000_000, readOnly: false },
    ],
    ...overrides,
  };
}

function denyAllPolicy(overrides: Partial<EgressPolicy> = {}): EgressPolicy {
  return {
    policyId: "deny-all",
    defaultAction: "deny",
    networkNamespace: "isolated",
    grants: [],
    ...overrides,
  };
}

function grant(overrides: Partial<EgressGrant> = {}): EgressGrant {
  return {
    grantId: newId(),
    destination: { kind: "ipv4Host", address: "93.184.216.34" },
    port: 443,
    purpose: "the operator-selected origin under study",
    kind: "publicDestination",
    fixtureId: null,
    ...overrides,
  };
}

function v4Host(address: string): EgressDestination {
  return { kind: "ipv4Host", address };
}

function v6Host(address: string): EgressDestination {
  return { kind: "ipv6Host", address };
}

function classOf(destination: EgressDestination): string {
  const parsed = parseDestination(destination);
  if (parsed === null) return "unparseable";
  return classifyAddress(parsed);
}

function startRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: "startProfile",
    requestId: newId(),
    jobId: newId(),
    taskId: null,
    profile: profileDescriptor(),
    egress: denyAllPolicy(),
    ...extra,
  };
}

function containerSpec(): ContainerSpec {
  return {
    image: { digest: DIGEST_A },
    runner: { digest: DIGEST_B },
    user: { uid: 1000, gid: 1000 },
    groupAdd: [],
    readOnlyRootfs: true,
    tmpfs: [{ containerPath: `${SCRATCH_ROOT}/one`, sizeLimitBytes: 4096, mode: "rw" }],
    bindMounts: [],
    capabilities: { drop: ["ALL"], add: [] },
    securityOpt: [`seccomp=workbench-target-v1@${DIGEST_A}`],
    browserSandbox: true,
    networkMode: "none",
    pidsLimit: 128,
    memoryBytes: 2_000_000_000,
    cpuCores: 2,
    diskQuotaBytes: 4_000_000_000,
    timeoutMs: 120_000,
  };
}

// The store is only a type obligation for the service's constructor: `preflight` is a
// pure gate and must never reach it, so the fake throws if anything calls it.
const unusedStorage: StorageWriterPort = {
  transact<T>(_work: (tx: StorageTransaction) => T): Result<T, StoragePortError> {
    throw new Error("preflight must not touch the store");
  },
};

const egress = new SandboxEgressPolicy();

function policyService(host: SandboxHostFacts): SandboxService {
  return new SandboxService({
    storage: unusedStorage,
    transport: {
      startProfile: async () => {
        throw new Error("the policy test must not call the broker");
      },
      inspectOwned: async () => {
        throw new Error("the policy test must not call the broker");
      },
      cancelOwned: async () => {
        throw new Error("the policy test must not call the broker");
      },
      cleanupOwned: async () => {
        throw new Error("the policy test must not call the broker");
      },
    },
    host: { observeHost: () => host },
    egress,
  });
}

function verdictFor(host: SandboxHostFacts, options: {
  profile?: SandboxProfileDescriptor;
  egressPolicy?: EgressPolicy;
} = {}) {
  return policyService(host).preflight({
    host,
    profile: options.profile ?? startProfileBrokerRequestSchema.parse(startRequest()).profile,
    egress: options.egressPolicy ?? denyAllPolicy(),
  });
}

describe("the broker command vocabulary (issue #21 checkbox 1)", () => {
  it("names exactly four commands", () => {
    expect(BROKER_COMMANDS).toEqual([
      "startProfile",
      "inspectOwned",
      "cancelOwned",
      "cleanupOwned",
    ]);
    expect(isBrokerCommand("startProfile")).toBe(true);
    for (const invented of [
      "execShell",
      "runImage",
      "dockerRun",
      "mountHostPath",
      "startProfile ",
      "StartProfile",
      "",
    ]) {
      expect(isBrokerCommand(invented)).toBe(false);
      expect(brokerCommandSchema.safeParse(invented).success).toBe(false);
    }
  });

  it("refuses a start request that carries an image name", () => {
    const parsed = startProfileBrokerRequestSchema.safeParse(startRequest({ image: "ubuntu:24.04" }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // `issueNames` is the same extractor the service journals with, so the refusal
      // really does name the field that has no place in the request.
      const names = issueNames(parsed.error.issues);
      expect(names.join(",")).toContain("image");
    }
  });

  it("refuses a start request that carries a shell, a host path or engine arguments", () => {
    for (const forged of [
      { shell: "/bin/sh -c id" },
      { hostPath: "/Users/niuruibo" },
      { dockerArgs: ["--privileged"] },
      { engineArgs: "--no-sandbox" },
      { bindMounts: [{ host: "/var/run/docker.sock", container: "/var/run/docker.sock" }] },
      { entrypoint: "bash" },
      { commandLine: "curl 169.254.169.254" },
      { network: "host" },
    ]) {
      expect(parseStrict(startProfileBrokerRequestSchema, startRequest(forged)).ok).toBe(false);
    }
  });

  it("has no profile field that could hold an image, a shell or a host path", () => {
    const shape = Object.keys(sandboxProfileDescriptorSchema.shape);
    expect(shape).toEqual([
      "profileId",
      "schemaVersion",
      "limits",
      "networkPolicyId",
      "isolation",
      "scratch",
    ]);
    for (const forbidden of ["image", "shell", "hostPath", "dockerArgs", "entrypoint", "volumes"]) {
      expect(shape).not.toContain(forbidden);
    }
    // A scratch area is named by an id and a size; the renderer mints its path.
    expect(Object.keys(sandboxScratchSchema.shape)).toEqual([
      "scratchId",
      "purpose",
      "sizeLimitBytes",
      "readOnly",
    ]);
  });

  it("refuses a scratch area that tries to name a container path", () => {
    const candidate = {
      ...profileDescriptor(),
      scratch: [
        {
          scratchId: newId(),
          purpose: "workdir",
          sizeLimitBytes: 4096,
          readOnly: false,
          containerPath: "/etc",
        },
      ],
    };
    expect(sandboxProfileDescriptorSchema.safeParse(candidate).success).toBe(false);
  });

  it("refuses a profile that smuggles an image into a nested descriptor", () => {
    const candidate = {
      ...profileDescriptor(),
      limits: { ...profileDescriptor().limits, imageName: "python:3" },
    };
    expect(sandboxProfileDescriptorSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("the profile cannot ask for weaker isolation (DESIGN §12, D18)", () => {
  function isolationAccepted(entry: Record<string, unknown>): boolean {
    const candidate = {
      ...profileDescriptor(),
      isolation: { ...profileDescriptor().isolation, ...entry },
    };
    return sandboxProfileDescriptorSchema.safeParse(candidate).success;
  }

  it("refuses root, privileged, a writable rootfs and a disabled browser sandbox", () => {
    expect(isolationAccepted({ nonRoot: false })).toBe(false);
    expect(isolationAccepted({ runAsUserId: 0 })).toBe(false);
    expect(isolationAccepted({ privileged: true })).toBe(false);
    expect(isolationAccepted({ readOnlyRootfs: false })).toBe(false);
    expect(isolationAccepted({ noNewPrivileges: false })).toBe(false);
    expect(isolationAccepted({ browserSandbox: false })).toBe(false);
    expect(isolationAccepted({ dockerSocketAccess: true })).toBe(false);
  });

  it("refuses keeping a capability or joining a host namespace", () => {
    expect(isolationAccepted({ droppedCapabilities: [] })).toBe(false);
    expect(isolationAccepted({ droppedCapabilities: ["NET_RAW"] })).toBe(false);
    expect(isolationAccepted({ keptCapabilities: ["SYS_ADMIN"] })).toBe(false);
    expect(isolationAccepted({ hostNamespaces: ["network"] })).toBe(false);
    expect(isolationAccepted({ hostNamespaces: ["pid", "ipc"] })).toBe(false);
  });

  it("refuses an unverified seccomp policy and a profile with no scratch space", () => {
    expect(isolationAccepted({ seccomp: { policyId: "p", digest: DIGEST_A, verified: false } })).toBe(
      false,
    );
    expect(isolationAccepted({ seccomp: { policyId: "p", digest: "nope", verified: true } })).toBe(
      false,
    );
    expect(sandboxProfileDescriptorSchema.safeParse({ ...profileDescriptor(), scratch: [] }).success).toBe(
      false,
    );
  });

  it("refuses a policy whose default is not deny or a grant without a purpose", () => {
    expect(egressPolicySchema.safeParse({ ...denyAllPolicy(), defaultAction: "allow" }).success).toBe(
      false,
    );
    expect(
      egressPolicySchema.safeParse({ ...denyAllPolicy(), grants: [{ ...grant(), purpose: "" }] }).success,
    ).toBe(false);
    expect(
      egressPolicySchema.safeParse({
        ...denyAllPolicy(),
        grants: [{ ...grant(), kind: "localFixture", fixtureId: null }],
      }).success,
    ).toBe(false);
  });

  it("keeps a fixture exception on its own network only", () => {
    const fixture = grant({
      kind: "localFixture",
      destination: v4Host("127.0.0.1"),
      port: 8080,
      purpose: "the local fixture under test",
      fixtureId: newId(),
    });
    expect(
      egressPolicySchema.safeParse({
        ...denyAllPolicy(),
        networkNamespace: "fixture",
        grants: [fixture],
      }).success,
    ).toBe(true);
    expect(
      egressPolicySchema.safeParse({
        ...denyAllPolicy(),
        networkNamespace: "isolated",
        grants: [fixture],
      }).success,
    ).toBe(false);
  });

  it("names a supported-platform predicate that is Linux x64 and nothing else", () => {
    expect(isSupportedSandboxHost({ platform: "linux", arch: "x64" })).toBe(true);
    for (const host of [
      { platform: "linux", arch: "arm64" },
      { platform: "darwin", arch: "x64" },
      { platform: "darwin", arch: "arm64" },
      { platform: "win32", arch: "x64" },
    ]) {
      expect(isSupportedSandboxHost(host)).toBe(false);
    }
    const disclosure = unsupportedPlatformSchema.safeParse(
      describeUnsupportedPlatform(hostFacts({ platform: "darwin", arch: "arm64" })),
    );
    expect(disclosure.success).toBe(true);
    if (!disclosure.success) return;
    expect(disclosure.data.verifiedOnHost).toBe(false);
    expect(disclosure.data.requiredPlatform).toBe("linux");
    expect(disclosure.data.requiredArch).toBe("x64");
    expect(disclosure.data.advisory).toContain("unverified");
  });

  it("will not let a verdict claim it is runnable while listing a gap", () => {
    expect(preflightVerdictSchema.safeParse({ unmet: [], runnable: true }).success).toBe(true);
    expect(preflightVerdictSchema.safeParse({ unmet: ["x"], runnable: false }).success).toBe(true);
    expect(preflightVerdictSchema.safeParse({ unmet: ["x"], runnable: true }).success).toBe(false);
    expect(preflightVerdictSchema.safeParse({ unmet: [], runnable: false }).success).toBe(false);
  });
});

describe("preflight is the one place that decides (issue #21 checkbox 2)", () => {
  it("reports nothing unmet for a Linux x64 host that proves every condition", () => {
    const verdict = verdictFor(hostFacts());
    expect(verdict.unmet).toEqual([]);
    expect(verdict.runnable).toBe(true);
  });

  it("blocks runnable for each unmet isolation condition, named", () => {
    for (const condition of ISOLATION_CONDITIONS) {
      const host = hostFacts({
        enforcedConditions: ALL_CONDITIONS.filter((entry) => entry !== condition),
      });
      const verdict = verdictFor(host);
      expect(verdict.unmet).toContain(`isolation-condition-unmet:${condition}`);
      expect(verdict.runnable).toBe(false);
    }
  });

  it("lists every condition when the host proves none", () => {
    const host = hostFacts({ enforcedConditions: [] });
    const verdict = verdictFor(host);
    expect(verdict.unmet.length).toBe(ISOLATION_CONDITIONS.length);
    expect(verdict.runnable).toBe(false);
  });

  it("names the unsupported platform as its own unmet condition", () => {
    const host = hostFacts({ platform: "darwin", arch: "arm64" });
    const verdict = verdictFor(host);
    expect(verdict.unmet).toContain("platform-unsupported:linux/x64");
    expect(verdict.runnable).toBe(false);
  });

  it("blocks a profile whose limits exceed what the host can grant", () => {
    const host = hostFacts();
    const overMemory = profileDescriptor({
      limits: { ...profileDescriptor().limits, memoryBytes: 99_000_000_000 },
    });
    const overPids = profileDescriptor({ limits: { ...profileDescriptor().limits, pids: 100_000 } });
    expect(unmetIsolationConditions({ host, profile: overMemory }).join(",")).toContain(
      "resource-limit-unavailable:memoryBytes",
    );
    expect(verdictFor(host, { profile: overPids }).unmet).toContain("resource-limit-unavailable:pids");
  });

  it("folds an inadmissible egress policy into the same verdict", () => {
    const host = hostFacts();
    const widened = denyAllPolicy({
      grants: [grant({ destination: { kind: "ipv4Prefix", address: "10.0.0.0", prefixLength: 8 } })],
    });
    const verdict = verdictFor(host, { egressPolicy: widened });
    expect(verdict.runnable).toBe(false);
    expect(verdict.unmet.join(",")).toContain("egress:grant-class-blocked");
  });

  it("never reaches the store while deciding", () => {
    // The throwing fake storage is the assertion: a preflight that journalled or read
    // here would crash the test instead of returning a verdict.
    const host = hostFacts({ enforcedConditions: [] });
    expect(() => verdictFor(host)).not.toThrow();
  });
});

describe("default-deny egress equivalence classes (issue #21 checkbox 3)", () => {
  const blocked: [string, EgressDestination][] = [
    ["127.0.0.0/8 head", v4Host("127.0.0.1")],
    ["127.0.0.0/8 tail", v4Host("127.255.255.254")],
    ["::1", v6Host("::1")],
    ["10/8 head", v4Host("10.0.0.1")],
    ["10/8 tail", v4Host("10.255.255.255")],
    ["172.16/12 head", v4Host("172.16.0.1")],
    ["172.16/12 tail", v4Host("172.31.255.255")],
    ["192.168/16", v4Host("192.168.1.1")],
    ["metadata", v4Host("169.254.169.254")],
    ["link-local", v4Host("169.254.1.1")],
    ["fe80::/10 head", v6Host("fe80::1")],
    ["fe80::/10 tail", v6Host("febf::1")],
    ["0.0.0.0/8 head", v4Host("0.0.0.0")],
    ["0.0.0.0/8 tail", v4Host("0.255.255.255")],
    ["v6 unspecified", v6Host("::")],
    ["carrier-nat", v4Host("100.64.0.1")],
    ["v4 multicast", v4Host("224.0.0.1")],
    ["v6 multicast", v6Host("ff02::1")],
    ["v6 ULA private", v6Host("fd12:3456::1")],
    ["benchmarking", v4Host("198.18.0.1")],
    ["reserved future", v4Host("240.0.0.1")],
    ["documentation v4", v4Host("192.0.2.1")],
    ["documentation v6", v6Host("2001:db8::1")],
  ];

  it.each(blocked)("classifies %s as a blocked class and denies it", (_label, destination) => {
    const value = classOf(destination);
    expect(value).not.toBe("public");
    expect(value).not.toBe("unparseable");
    const decided = egress.evaluate({
      policy: denyAllPolicy(),
      destination,
      port: 443,
    });
    expect(decided.decision).toBe("deny");
  });

  it("keeps the exact class the design names for each range", () => {
    expect(classOf(v4Host("127.0.0.1"))).toBe("loopback");
    expect(classOf(v4Host("10.1.2.3"))).toBe("private");
    expect(classOf(v4Host("172.16.5.4"))).toBe("private");
    expect(classOf(v4Host("192.168.0.9"))).toBe("private");
    expect(classOf(v4Host("169.254.169.254"))).toBe("metadata");
    expect(classOf(v4Host("169.254.1.1"))).toBe("link-local");
    expect(classOf(v4Host("0.1.2.3"))).toBe("unspecified");
    expect(classOf(v6Host("::1"))).toBe("loopback");
    expect(classOf(v6Host("fe80::42"))).toBe("link-local");
    expect(classOf(v6Host("::"))).toBe("unspecified");
    expect(classOf(v6Host("fc00::1"))).toBe("private");
  });

  it("sits on the 172.16/12 boundary instead of trusting a 172 prefix", () => {
    expect(classOf(v4Host("172.15.255.255"))).toBe("public");
    expect(classOf(v4Host("172.16.0.0"))).toBe("private");
    expect(classOf(v4Host("172.31.255.255"))).toBe("private");
    expect(classOf(v4Host("172.32.0.0"))).toBe("public");
  });

  it("resolves IPv4-mapped, IPv4-compatible and 6to4 forms to the inner address", () => {
    expect(classOf(v6Host("::ffff:127.0.0.1"))).toBe("loopback");
    expect(classOf(v6Host("0:0:0:0:0:ffff:10.0.0.1"))).toBe("private");
    expect(classOf(v6Host("::127.0.0.1"))).toBe("loopback");
    expect(classOf(v6Host("::ffff:169.254.169.254"))).toBe("metadata");
    expect(classOf(v6Host("2002:7f00:1::"))).toBe("loopback");
    expect(classOf(v6Host("2002:0808:0808::"))).toBe("public");
    const resolved = parseDestination(v6Host("::ffff:127.0.0.1"));
    expect(resolved?.family).toBe(4);
    expect(resolved?.bytes).toEqual([127, 0, 0, 1]);
    expect(resolved?.resolvedFrom).toBe("ipv4-mapped");
    expect(parseDestination(v6Host("2002:7f00:1::"))?.resolvedFrom).toBe("6to4");
    expect(parseDestination(v6Host("::127.0.0.1"))?.resolvedFrom).toBe("ipv4-compatible");
  });

  it("keeps :: and ::1 in v6 space", () => {
    expect(parseDestination(v6Host("::"))?.family).toBe(6);
    expect(parseDestination(v6Host("::1"))?.family).toBe(6);
    expect(parseDestination(v6Host("::1"))?.bytes.length).toBe(16);
  });

  it("allows a public destination only with an explicit grant", () => {
    const destination = v4Host("93.184.216.34");
    expect(
      egress.evaluate({ policy: denyAllPolicy(), destination, port: 443 }),
    ).toMatchObject({ decision: "deny", reasons: ["default-deny-no-grant"] });

    const named = grant({ destination });
    const withGrant = denyAllPolicy({ grants: [named] });
    expect(egress.review(withGrant).admissible).toBe(true);
    expect(egress.evaluate({ policy: withGrant, destination, port: 443 })).toMatchObject({
      decision: "allow",
      grantId: named.grantId,
      addressClass: "public",
    });
    // A grant is per port: the same address on another port stays denied.
    expect(egress.evaluate({ policy: withGrant, destination, port: 80 }).decision).toBe("deny");
  });

  it("needs its own explicit grant for a local fixture and nothing broader", () => {
    const fixture = grant({
      kind: "localFixture",
      destination: v4Host("127.0.0.1"),
      port: 8080,
      purpose: "the local fixture under test",
      fixtureId: newId(),
    });
    const policy = denyAllPolicy({ networkNamespace: "fixture", grants: [fixture] });
    expect(egress.review(policy).admissible).toBe(true);
    expect(egress.evaluate({ policy, destination: v4Host("127.0.0.1"), port: 8080 })).toMatchObject({
      decision: "allow",
      grantId: fixture.grantId,
    });
    // The exception is this host on this port: a neighbour stays denied.
    expect(egress.evaluate({ policy, destination: v4Host("127.0.0.2"), port: 8080 }).decision).toBe(
      "deny",
    );
    expect(egress.evaluate({ policy, destination: v4Host("127.0.0.1"), port: 8081 }).decision).toBe(
      "deny",
    );
    expect(egress.evaluate({ policy, destination: v4Host("10.4.5.6"), port: 8080 }).decision).toBe(
      "deny",
    );
  });

  it("refuses a fixture grant outside the fixture network namespace", () => {
    // The grant's whole justification is that the fixture host sits in its own
    // namespace, unreachable from the profile under test. Declared in any other
    // namespace it would be a plain loopback exception, so it is inadmissible and
    // it never reaches the allow branch of evaluate().
    const fixture = grant({
      kind: "localFixture",
      destination: v4Host("127.0.0.1"),
      port: 8080,
      purpose: "the local fixture under test",
      fixtureId: newId(),
    });
    const policy = denyAllPolicy({ grants: [fixture] });
    const review = egress.review(policy);
    expect(review.admissible).toBe(false);
    expect(review.reasons.join(",")).toContain("fixture-grant-requires-fixture-network");
    expect(egress.evaluate({ policy, destination: v4Host("127.0.0.1"), port: 8080 }).decision).toBe(
      "deny",
    );
  });

  it("never lets a fixture grant reach link-local or the metadata address", () => {
    for (const destination of [v4Host("169.254.169.254"), v6Host("fe80::1")]) {
      const fixture = grant({
        kind: "localFixture",
        destination,
        port: 8080,
        purpose: "the local fixture under test",
        fixtureId: newId(),
      });
      const policy = denyAllPolicy({ networkNamespace: "fixture", grants: [fixture] });
      const review = egress.review(policy);
      expect(review.admissible).toBe(false);
      expect(review.reasons.join(",")).toContain("fixture-grant-class-invalid");
      expect(egress.evaluate({ policy, destination, port: 8080 }).decision).toBe("deny");
    }
  });

  it("refuses a public grant aimed at a blocked class or a whole private range", () => {
    for (const destination of [
      { kind: "ipv4Prefix", address: "10.0.0.0", prefixLength: 8 },
      { kind: "ipv4Prefix", address: "192.168.7.0", prefixLength: 24 },
      { kind: "ipv6Prefix", address: "fd00::", prefixLength: 8 },
      { kind: "ipv4Prefix", address: "127.0.0.0", prefixLength: 8 },
      { kind: "ipv4Prefix", address: "169.254.0.0", prefixLength: 16 },
    ] as EgressDestination[]) {
      const candidate = denyAllPolicy({ grants: [grant({ destination })] });
      const review = egress.review(candidate);
      expect(review.admissible).toBe(false);
      expect(review.reasons.join(",")).toContain("grant-class-blocked");
    }
  });

  it("refuses a wildcard grant and a prefix that is not canonical", () => {
    const wildcard = denyAllPolicy({
      grants: [grant({ destination: { kind: "ipv4Prefix", address: "0.0.0.0", prefixLength: 0 } })],
    });
    expect(egress.review(wildcard).reasons.join(",")).toContain("grant-class-blocked");

    const sloppy = denyAllPolicy({
      grants: [
        grant({ destination: { kind: "ipv4Prefix", address: "93.184.216.5", prefixLength: 24 } }),
      ],
    });
    expect(egress.review(sloppy).reasons.join(",")).toContain("grant-prefix-not-canonical");

    const sloppyV6 = denyAllPolicy({
      grants: [
        grant({ destination: { kind: "ipv6Prefix", address: "2606:4700:1::", prefixLength: 32 } }),
      ],
    });
    expect(egress.review(sloppyV6).reasons.join(",")).toContain("grant-prefix-not-canonical");

    const widenedFixture = denyAllPolicy({
      networkNamespace: "fixture",
      grants: [
        grant({
          kind: "localFixture",
          destination: { kind: "ipv4Prefix", address: "127.0.0.0", prefixLength: 24 },
          fixtureId: newId(),
          purpose: "the local fixture under test",
        }),
      ],
    });
    expect(egress.review(widenedFixture).reasons.join(",")).toContain(
      "fixture-grant-must-name-one-host",
    );
  });

  it("refuses an encapsulated spelling of a fixture address", () => {
    const candidate = denyAllPolicy({
      networkNamespace: "fixture",
      grants: [
        grant({
          kind: "localFixture",
          destination: v6Host("::ffff:127.0.0.1"),
          port: 8080,
          purpose: "the local fixture under test",
          fixtureId: newId(),
        }),
      ],
    });
    expect(egress.review(candidate).reasons.join(",")).toContain("fixture-grant-encapsulated-address");
  });

  it("rejects malformed addresses instead of guessing a family", () => {
    expect(parseIpv4Bytes("10.0.0")).toBeNull();
    expect(parseIpv4Bytes("256.0.0.1")).toBeNull();
    expect(parseIpv4Bytes("010.0.0.1")).toBeNull();
    expect(parseIpv4Bytes("10.0.0.-1")).toBeNull();
    expect(parseIpv4Bytes("::1")).toBeNull();
    expect(expandIpv6Bytes("::")).not.toBeNull();
    expect(expandIpv6Bytes(":::")).toBeNull();
    expect(expandIpv6Bytes("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(expandIpv6Bytes("1:2:3:4:5:6:7:8")).not.toBeNull();
    expect(expandIpv6Bytes("fe80::1%eth0")).toBeNull();
    expect(expandIpv6Bytes("1::2::3")).toBeNull();
    expect(expandIpv6Bytes("g::1")).toBeNull();
    expect(expandIpv6Bytes("1:2:3:4:5:6:1.2.3.4")).not.toBeNull();
    expect(expandIpv6Bytes("1:2:3:4:5:6:7:1.2.3.4")).toBeNull();
    expect(parseDestination({ kind: "ipv4Prefix", address: "10.0.0.0", prefixLength: 33 })).toBeNull();
    expect(parseDestination({ kind: "ipv6Prefix", address: "::", prefixLength: 129 })).toBeNull();
    expect(parseDestination(v6Host("10.0.0.1"))).toBeNull();
    expect(parseDestination(v4Host("::1"))).toBeNull();
  });

  it("refuses to parse a dotted-quad anywhere but the last group", () => {
    // Built directly so the adapter is proven not to rely on the schema's guard.
    const smuggled = { kind: "ipv6Host", address: "1.2.3.4:2:3:4:5:6:7:8" } as EgressDestination;
    expect(parseDestination(smuggled)).toBeNull();
  });

  it("does the mask arithmetic at both ends of the range", () => {
    expect(matchesPrefix([10, 0, 0, 1], [10, 0, 0, 0], 8)).toBe(true);
    expect(matchesPrefix([10, 255, 255, 255], [10, 0, 0, 0], 8)).toBe(true);
    expect(matchesPrefix([11, 0, 0, 0], [10, 0, 0, 0], 8)).toBe(false);
    expect(matchesPrefix([172, 16, 0, 0], [172, 16, 0, 0], 12)).toBe(true);
    expect(matchesPrefix([172, 32, 0, 0], [172, 16, 0, 0], 12)).toBe(false);
    expect(matchesPrefix([192, 0, 2, 1], [192, 0, 2, 0], 24)).toBe(true);
    expect(matchesPrefix([192, 0, 3, 0], [192, 0, 2, 0], 24)).toBe(false);
    expect(matchesPrefix([1, 2, 3, 4], [0, 0, 0, 0], 0)).toBe(true);
    expect(matchesPrefix([1, 2, 3, 4], [1, 2, 3, 4], 32)).toBe(true);
    expect(matchesPrefix([1, 2, 3, 4], [1, 2, 3, 5], 32)).toBe(false);
    expect(matchesPrefix([1, 2, 3], [1, 2, 3, 4], 24)).toBe(false);
    expect(matchesPrefix([1, 2, 3, 4], [1, 2, 3, 4], 33)).toBe(false);
    const zeroes = Array.from({ length: 16 }, () => 0);
    expect(matchesPrefix(zeroes, zeroes, 128)).toBe(true);
  });

  it("grants a public prefix and matches inside it", () => {
    const prefixGrant = grant({
      destination: { kind: "ipv4Prefix", address: "93.184.216.0", prefixLength: 24 },
    });
    const candidate = denyAllPolicy({ grants: [prefixGrant] });
    expect(egress.review(candidate).admissible).toBe(true);
    expect(
      egress.evaluate({
        policy: candidate,
        destination: v4Host("93.184.216.99"),
        port: 443,
      }).decision,
    ).toBe("allow");
    expect(
      egress.evaluate({ policy: candidate, destination: v4Host("93.184.217.1"), port: 443 }).decision,
    ).toBe("deny");
  });

  it("matches a v6 grant in v6 space only", () => {
    const clean = grant({ destination: { kind: "ipv6Host", address: "2606:4700:4700::1111" } });
    const candidate = denyAllPolicy({ grants: [clean] });
    expect(egress.review(candidate).admissible).toBe(true);
    expect(
      egress.evaluate({
        policy: candidate,
        destination: v6Host("2606:4700:4700::1111"),
        port: 443,
      }).decision,
    ).toBe("allow");
    expect(
      egress.evaluate({ policy: candidate, destination: v6Host("2606:4700:1::1111"), port: 443 }).decision,
    ).toBe("deny");
    expect(
      egress.evaluate({ policy: candidate, destination: v4Host("93.184.216.34"), port: 443 }).decision,
    ).toBe("deny");
  });

  it("reports an unparseable destination as a deny, never an allow", () => {
    const broken = { kind: "ipv4Host", address: "not-an-ip" } as EgressDestination;
    const decided = egress.evaluate({ policy: denyAllPolicy(), destination: broken, port: 443 });
    expect(decided.decision).toBe("deny");
    if (decided.decision === "deny") {
      expect(decided.reasons).toContain("destination-unparseable");
    }
  });
});

describe("the broker frame codec refuses a widened answer (issue #21 checkbox 1)", () => {
  const request = startProfileBrokerRequestSchema.parse(startRequest());

  function frameOf(value: unknown): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  }

  function startAnswer(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      command: "startProfile",
      requestId: request.requestId,
      status: "started",
      handle: newId(),
      refusalReasons: [],
      enforcedConditions: ALL_CONDITIONS,
      cleanupState: "pending",
      ...extra,
    };
  }

  it("writes exactly one newline-terminated frame per command", () => {
    const frame = encodeBrokerRequest(request);
    const text = new TextDecoder().decode(frame);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n").length).toBe(2);
    expect(JSON.parse(text).command).toBe("startProfile");
  });

  it("decodes an answer that matches the contract", () => {
    const decoded = decodeBrokerResponse(frameOf(startAnswer()), {
      command: "startProfile",
      requestId: request.requestId,
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.command).toBe("startProfile");
  });

  it("refuses an answer carrying a field the contract never declared", () => {
    for (const extra of [
      { containerName: "目标容器" },
      { pidPath: "/proc/1" },
      { stderr: "docker: --no-sandbox ignored" },
      { image: "python:3" },
    ]) {
      const decoded = decodeBrokerResponse(frameOf(startAnswer(extra)), {
        command: "startProfile",
        requestId: request.requestId,
      });
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.error.reason).toBe("broker-response-rejected");
    }
  });

  it("refuses an empty, unterminated, concatenated or non-JSON frame", () => {
    const expected = { command: "startProfile" as const, requestId: request.requestId };
    const cases: [string, Uint8Array][] = [
      ["broker-frame-empty", new Uint8Array(0)],
      [
        "broker-frame-unterminated",
        new TextEncoder().encode(JSON.stringify(startAnswer())),
      ],
      [
        "broker-frame-concatenated",
        new TextEncoder().encode(`${JSON.stringify(startAnswer())}\n${JSON.stringify(startAnswer())}\n`),
      ],
      ["broker-frame-not-json", new TextEncoder().encode("not json\n")],
      [
        "broker-frame-too-large",
        new Uint8Array(MAX_BROKER_FRAME_BYTES + 8),
      ],
    ];
    for (const [reason, frame] of cases) {
      const decoded = decodeBrokerResponse(frame, expected);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.error.reason).toBe(reason);
    }
  });

  it("refuses an answer that names another command or another request", () => {
    const inspecting = {
      command: "inspectOwned",
      requestId: request.requestId,
      owned: true,
      presence: "present",
      exitState: "running",
      cleanupState: "pending",
      editable: false,
    };
    const wrongCommand = decodeBrokerResponse(frameOf(inspecting), {
      command: "startProfile",
      requestId: request.requestId,
    });
    expect(wrongCommand.ok).toBe(false);
    if (!wrongCommand.ok) expect(wrongCommand.error.reason).toBe("broker-command-mismatch");

    const wrongRequest = decodeBrokerResponse(frameOf(startAnswer()), {
      command: "startProfile",
      requestId: newId(),
    });
    expect(wrongRequest.ok).toBe(false);
    if (!wrongRequest.ok) expect(wrongRequest.error.reason).toBe("broker-request-mismatch");
  });

  it("answers each command only with that command's response", async () => {
    const sent: string[] = [];
    const client = new BrokerClient({
      exchange: {
        async transmit(frame: Uint8Array): Promise<Result<Uint8Array, string>> {
          const decoded = JSON.parse(new TextDecoder().decode(frame)) as {
            command: string;
            requestId: string;
          };
          sent.push(decoded.command);
          const base = { command: decoded.command, requestId: decoded.requestId };
          if (decoded.command === "startProfile") {
            return {
              ok: true,
              value: frameOf({
                ...base,
                status: "started",
                handle: newId(),
                refusalReasons: [],
                enforcedConditions: ALL_CONDITIONS,
                cleanupState: "pending",
              }),
            };
          }
          // Exactly the shape the contract declares for that command: the codec
          // refuses an answer with a field that belongs to a different one.
          return {
            ok: true,
            value: frameOf({
              ...base,
              owned: true,
              presence: "present",
              exitState: "exited",
              cleanupState: "complete",
              editable: false,
            }),
          };
        },
      },
    });
    const started = await client.startProfile(request);
    expect(started.ok).toBe(true);
    const inspected = await client.inspectOwned({
      command: "inspectOwned",
      requestId: newId(),
      jobId: newId(),
      handle: newId(),
    });
    expect(inspected.ok).toBe(true);
    expect(sent).toEqual(["startProfile", "inspectOwned"]);
  });

  it("turns an unreachable broker into a retryable capability failure, never its text", async () => {
    const client = new BrokerClient({
      exchange: {
        async transmit(): Promise<Result<Uint8Array, string>> {
          return { ok: false, error: "ECONNREFUSED /var/run/docker.sock" };
        },
      },
    });
    const started = await client.startProfile(request);
    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error.code).toBe("CAPABILITY_UNAVAILABLE");
      expect(started.error.reason).toBe("broker-unreachable");
      expect(started.error.retryable).toBe(true);
      // The peer's string never becomes the reason a caller sees (§12.1).
      expect(started.error.message).toBe("the broker did not answer");
    }
  });

  it("has no generic invoke to reach an unnamed command", () => {
    const names = Object.getOwnPropertyNames(BrokerClient.prototype)
      .filter((name: string) => name !== "constructor")
      .sort();
    expect(names).toEqual([
      "call",
      "cancelOwned",
      "cleanupOwned",
      "inspectOwned",
      "mismatched",
      "startProfile",
    ]);
  });
});

describe("the renderer mints the plan and refuses to degrade (issue #21 checkbox 2)", () => {
  const images: SandboxImageAllowlist = [
    { profileId: "target-chromium", imageDigest: DIGEST_A, runnerDigest: DIGEST_B },
  ];
  const runnable = { unmet: [], runnable: true };
  const linux = { platform: "linux", arch: "x64" };

  function render(egressPolicy: EgressPolicy = denyAllPolicy()) {
    const request: StartProfileBrokerRequest = {
      ...startProfileBrokerRequestSchema.parse(startRequest()),
      egress: egressPolicy,
    };
    return renderStartPlan({ request, verdict: runnable, host: linux, images });
  }

  it("emits a plan with every isolation condition visible in the arguments", () => {
    const rendered = render();
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const args = rendered.value.engineArgs.join(" ");
    expect(args).toContain("--user=1000:1000");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges:true");
    expect(args).toContain(`seccomp=workbench-target-v1@${DIGEST_A}`);
    expect(args).toContain("--env=WB_BROWSER_SANDBOX=1");
    expect(args).toContain(`--tmpfs=${SCRATCH_ROOT}`);
    expect(args).toContain("--network=none");
    expect(args).toContain(`image@sha256:${DIGEST_A}`);
    expect(rendered.value.spec.networkMode).toBe("none");
    expect(rendered.value.spec.bindMounts).toEqual([]);
    expect(rendered.value.spec.capabilities.add).toEqual([]);
    expect(rendered.value.spec.user.uid).toBe(1000);
    expect(rendered.value.spec.tmpfs[0]?.containerPath.startsWith(SCRATCH_ROOT)).toBe(true);
  });

  it("refuses to emit any forbidden engine argument", () => {
    expect(FORBIDDEN_ENGINE_ARGUMENTS).toContain("--no-sandbox");
    const spec = containerSpec();
    for (const forbidden of FORBIDDEN_ENGINE_ARGUMENTS) {
      const problems = assertArgsAdmissible([forbidden, "--tmpfs=/etc:rw"], spec);
      expect(problems.join(",")).toContain("forbidden-engine-argument");
    }
    const rendered = render();
    if (rendered.ok) {
      expect(rendered.value.engineArgs.some((arg: string) => arg.includes("--no-sandbox"))).toBe(
        false,
      );
    }
  });

  it("refuses a mount it did not mint and accepts only the scratch root", () => {
    const spec = containerSpec();
    expect(assertArgsAdmissible([`--tmpfs=${SCRATCH_ROOT}/abc:rw`], spec)).toEqual([]);
    expect(assertArgsAdmissible(["--tmpfs=/Users/niuruibo:rw"], spec).join(",")).toContain(
      "mount-not-minted-by-this-renderer",
    );
    expect(
      assertArgsAdmissible(["-v", "/var/run/docker.sock:/var/run/docker.sock"], spec).join(","),
    ).toContain("forbidden-engine-argument");
  });

  it("catches a spec that would not be a plan at all", () => {
    const spec = containerSpec();
    expect(
      assertArgsAdmissible([], { ...spec, networkMode: "workbench-egress-isolated" }).join(","),
    ).toBe("");
    expect(assertArgsAdmissible([], { ...spec, readOnlyRootfs: false as never }).join(",")).toContain(
      "rootfs-must-be-read-only",
    );
    expect(assertArgsAdmissible([], { ...spec, user: { uid: 0, gid: 0 } }).join(",")).toContain(
      "target-must-not-run-as-root",
    );
    expect(
      assertArgsAdmissible([], { ...spec, capabilities: { drop: ["ALL"], add: ["NET_RAW"] as never } })
        .join(","),
    ).toContain("capabilities-are-never-added-back");
  });

  it("refuses when the verdict says any condition is unmet", () => {
    const refused = renderStartPlan({
      request: startProfileBrokerRequestSchema.parse(startRequest()),
      verdict: { unmet: ["isolation-condition-unmet:seccompVerified"], runnable: false },
      host: linux,
      images,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("CAPABILITY_UNAVAILABLE");
      expect(refused.error.reasons).toContain("isolation-condition-unmet:seccompVerified");
    }
  });

  it("refuses a non-Linux-x64 host even with an honest-looking verdict", () => {
    const refused = renderStartPlan({
      request: startProfileBrokerRequestSchema.parse(startRequest()),
      verdict: runnable,
      host: { platform: "darwin", arch: "arm64" },
      images,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.reason).toBe("platform-unsupported");
  });

  it("refuses a profile whose image is not in the pinned manifest", () => {
    const refused = renderStartPlan({
      request: startProfileBrokerRequestSchema.parse(startRequest()),
      verdict: runnable,
      host: linux,
      images: [],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.reason).toContain("profile-image-not-pinned");
  });

  it("refuses a label that cannot be rendered as an argument", () => {
    expect(isRenderableLabel("workbench-target-v1")).toBe(true);
    expect(isRenderableLabel("--no-sandbox")).toBe(false);
    expect(isRenderableLabel("a b")).toBe(false);
    expect(isRenderableLabel("")).toBe(false);
    const request = startProfileBrokerRequestSchema.parse(startRequest());
    const refused = renderStartPlan({
      request: { ...request, egress: { ...request.egress, policyId: "--no-sandbox" } },
      verdict: runnable,
      host: linux,
      images,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.reasons.join(",")).toContain("label-unrenderable:egress-policy-id");
    }
  });

  it("mints scratch paths from the id only", () => {
    const scratch = profileDescriptor().scratch[0];
    if (scratch === undefined) throw new Error("the fixture profile needs one scratch area");
    expect(mintScratchPath(scratch)).toBe(`${SCRATCH_ROOT}/${scratch.scratchId}`);
    expect(mintScratchPath({ ...scratch, scratchId: "../../etc/passwd" })).toBeNull();
    expect(mintScratchPath({ ...scratch, scratchId: "x" })).toBeNull();
  });

  it("joins a named egress namespace only when the policy grants something", () => {
    expect(networkModeFor(denyAllPolicy())).toBe("none");
    expect(networkModeFor(denyAllPolicy({ grants: [grant()] }))).toBe("workbench-egress-isolated");
    const fixture = grant({
      kind: "localFixture",
      destination: v4Host("127.0.0.1"),
      purpose: "the local fixture under test",
      fixtureId: newId(),
      port: 8080,
    });
    expect(
      networkModeFor(denyAllPolicy({ networkNamespace: "fixture", grants: [fixture] })),
    ).toBe("workbench-egress-fixture");
    const rendered = render(denyAllPolicy({ grants: [grant()] }));
    if (rendered.ok) {
      expect(rendered.value.engineArgs.join(" ")).toContain("--network=workbench-egress-isolated");
      expect(rendered.value.engineArgs.join(" ")).toContain("--egress-default-deny=deny-all");
    }
  });
});

describe("the broker response cannot smuggle a field (issue #21 checkbox 1)", () => {
  it("requires a handle exactly when it claims the resource started", () => {
    const base = {
      requestId: newId(),
      refusalReasons: [],
      enforcedConditions: ALL_CONDITIONS,
      cleanupState: "pending",
    };
    expect(
      startProfileBrokerResponseSchema.safeParse({
        ...base,
        command: "startProfile",
        status: "started",
        handle: null,
      }).success,
    ).toBe(false);
    expect(
      startProfileBrokerResponseSchema.safeParse({
        ...base,
        command: "startProfile",
        status: "refused",
        handle: null,
        refusalReasons: ["seccomp-unavailable"],
      }).success,
    ).toBe(true);
    expect(
      startProfileBrokerResponseSchema.safeParse({
        ...base,
        command: "startProfile",
        status: "refused",
        handle: null,
        refusalReasons: [],
      }).success,
    ).toBe(false);
    expect(
      startProfileBrokerResponseSchema.safeParse({
        ...base,
        command: "startProfile",
        status: "started",
        handle: newId(),
      }).success,
    ).toBe(true);
    expect(
      startProfileBrokerResponseSchema.safeParse({
        ...base,
        command: "startProfile",
        status: "started",
        handle: newId(),
        containerName: "目标容器",
      }).success,
    ).toBe(false);
    expect(
      startProfileBrokerResponseSchema.safeParse({
        ...base,
        command: "startProfile",
        status: "started",
        handle: newId(),
        stderr: "docker: --no-sandbox ignored",
      }).success,
    ).toBe(false);
  });

  it("keeps presence, exit, ownership and editability as separate facts", () => {
    expect(
      inspectOwnedBrokerResponseSchema.safeParse({
        command: "inspectOwned",
        requestId: newId(),
        owned: false,
        presence: "unknown",
        exitState: "unknown",
        cleanupState: "pending",
        editable: false,
      }).success,
    ).toBe(true);
    expect(
      inspectOwnedBrokerResponseSchema.safeParse({
        command: "inspectOwned",
        requestId: newId(),
        owned: true,
        presence: "present",
        exitState: "running",
        cleanupState: "pending",
        editable: true,
        pidPath: "/proc/1",
      }).success,
    ).toBe(false);
  });

  it("has no field on an owned request that could name a resource directly", () => {
    expect(Object.keys(cleanupOwnedBrokerRequestSchema.shape)).toEqual([
      "command",
      "requestId",
      "jobId",
      "handle",
    ]);
    expect(cancelOwnedBrokerResponseSchema.safeParse({}).success).toBe(false);
    expect(
      cleanupOwnedBrokerRequestSchema.safeParse({
        command: "cleanupOwned",
        requestId: newId(),
        jobId: newId(),
        handle: "/var/lib/docker",
      }).success,
    ).toBe(false);
  });
});

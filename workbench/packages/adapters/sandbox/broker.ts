import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Digest } from "../../domain/canonical-json.ts";
import type { Id } from "../../domain/identity.ts";
import { asId } from "../../domain/identity.ts";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type {
  EgressPolicy,
  PreflightVerdict,
  SandboxProfileDescriptor,
  SandboxScratch,
  StartProfileBrokerRequest,
} from "../../contracts/sandbox.ts";
import { isSupportedSandboxHost, SANDBOX_HOST_REQUIREMENTS } from "../../contracts/sandbox.ts";

// The Linux x64 renderer: profile + pinned image manifest in, a fully specified
// container plan out (DESIGN §12, §3, D17/D18).
//
// What this file deliberately is not:
//   * it does not spawn anything. It emits a plan; only `apps/broker`, a separate
//     process holding the scheduling privilege, may execute it (§3, D17). Keeping
//     the renderer process-free is what lets the whole module be typechecked and
//     tested on a machine with no Docker at all.
//   * it does not accept an image, a shell, an entrypoint, a mount or an engine
//     argument from the wire. The image comes from the operator's pinned manifest
//     (§14 / D31 maps container entries from that list), everything else is minted
//     here from the profile's requirements.
//   * it never degrades. If a condition cannot be met the plan is refused; the
//     argument that would loosen Chromium's own sandbox is on the forbidden list
//     below, so `--no-sandbox` cannot be produced by this code path even by
//     accident (D18: 隔离条件不能满足则拒绝执行，不回退到 `--no-sandbox`).
//
// Honesty about verification state: the platform predicate is Linux x64 only, and
// that is a claim about where this has been *tested*, not a Docker requirement.
// No container has been started, no seccomp profile loaded and no network
// namespace enforced by this repository's gates (issue #21 checkbox 4).

// The single root every writable location inside a target lives under. Nothing
// outside it can be expressed, so there is no way to name a host directory.
export const SCRATCH_ROOT = "/workbench/scratch";

export const FORBIDDEN_ENGINE_ARGUMENTS = [
  "--no-sandbox",
  "--privileged",
  "--net=host",
  "--network=host",
  "--cap-add",
  "--pid=host",
  "--ipc=host",
  "--uts=host",
  "--userns=host",
  "--security-opt seccomp=unconfined",
  "--security-opt apparmor=unconfined",
  "--entrypoint",
  "--volume",
  "-v",
  "--mount",
  "docker.sock",
  "--network-alias",
] as const;

// Every argument this renderer is allowed to emit, listed so the admissibility
// check below is a closed comparison rather than a heuristic.
const MOUNT_FLAGS: readonly string[] = ["--tmpfs"];
const RENDERER_FLAGS: readonly string[] = [
  "--detach",
  "--user",
  "--read-only",
  "--cap-drop",
  "--security-opt",
  "--pids-limit",
  "--memory",
  "--cpus",
  "--init",
  "--env",
  "--tmpfs",
  "--network",
  "--egress-default-deny",
  "--egress-grant",
];
// The only positional tokens the plan may carry: the verb and the pinned image.
const RENDERER_POSITIONALS: readonly string[] = ["run"];

export type SandboxImageEntry = {
  profileId: string;
  imageDigest: Digest;
  // The pinned runner inside that image. The renderer never sees a command line,
  // so the entry is a digest reference only.
  runnerDigest: Digest;
};

export type SandboxImageAllowlist = readonly SandboxImageEntry[];

export type RenderedTmpfs = {
  containerPath: string;
  sizeLimitBytes: number;
  mode: "rw" | "ro";
};

export type ContainerSpec = {
  image: { digest: Digest };
  runner: { digest: Digest };
  user: { uid: number; gid: number };
  groupAdd: readonly [];
  readOnlyRootfs: true;
  tmpfs: readonly RenderedTmpfs[];
  bindMounts: readonly [];
  capabilities: { drop: readonly ["ALL"]; add: readonly [] };
  securityOpt: readonly string[];
  browserSandbox: true;
  networkMode: "none" | "workbench-egress-isolated" | "workbench-egress-fixture";
  pidsLimit: number;
  memoryBytes: number;
  cpuCores: number;
  diskQuotaBytes: number;
  timeoutMs: number;
};

// The only network modes this renderer can produce. A closed list keeps the check
// below a comparison instead of a type assertion, and `host` / `bridge` are not on it.
const ADMISSIBLE_NETWORK_MODES: readonly string[] = [
  "none",
  "workbench-egress-isolated",
  "workbench-egress-fixture",
];

export function networkModeFor(egress: EgressPolicy): ContainerSpec["networkMode"] {
  if (egress.grants.length === 0) return "none";
  return egress.networkNamespace === "fixture"
    ? "workbench-egress-fixture"
    : "workbench-egress-isolated";
}

// Identifiers that get interpolated into an argument must look like identifiers.
// `nonEmptyString` on the wire is not enough: a policyId of "--no-sandbox" would
// otherwise be echoed straight into the plan.
export function isRenderableLabel(text: string): boolean {
  return /^[a-z0-9][a-z0-9._:@-]{0,63}$/.test(text);
}

export type RenderedTargetPlan = {
  // These arrive from the parsed wire request, where the schema has already proven
  // them to be opaque UUIDs; the plan carries them as text because the renderer does
  // not mint them and must not pretend to have validated a brand.
  requestId: string;
  jobId: string;
  taskId: string | null;
  profileId: string;
  spec: ContainerSpec;
  engineArgs: readonly string[];
  egress: EgressPolicy;
};

export type RenderRefusal = {
  code: "CAPABILITY_UNAVAILABLE" | "INVALID_INPUT";
  reason: string;
  reasons: readonly string[];
};

export function mintRequestId(): Id {
  return asId(randomUUID());
}

// A scratch area's path is minted from its opaque id, never taken from the wire.
// The check is belt-and-braces on top of `idSchema`: an id that is not a bare UUID
// cannot be joined at all, and a joined path that escapes the root is refused
// instead of being mounted.
export function mintScratchPath(scratch: SandboxScratch): string | null {
  if (!/^[0-9a-f-]{36}$/.test(scratch.scratchId)) return null;
  const joined = path.posix.join(SCRATCH_ROOT, scratch.scratchId);
  const segments = joined.split("/");
  if (segments.includes("..")) return null;
  if (!joined.startsWith(`${SCRATCH_ROOT}/`)) return null;
  return joined;
}

export function renderEgressArgs(egress: EgressPolicy): string[] {
  // A policy with no grants needs no namespace at all: `--network=none` is the
  // strongest statement of default-deny available. With grants the target joins a
  // named workbench egress namespace whose only routes are the ones the supervisor
  // installed for this profile — never `host`, never `bridge`.
  const args: string[] = [];
  if (egress.grants.length === 0) {
    args.push("--network=none");
  } else {
    args.push(`--network=${networkModeFor(egress)}`);
  }
  args.push(`--egress-default-deny=${egress.policyId}`);
  for (const grant of egress.grants) {
    args.push(`--egress-grant=${grant.grantId}`);
  }
  return args;
}

export function renderEngineArgs(spec: ContainerSpec, egress: EgressPolicy): string[] {
  const args: string[] = [
    "run",
    "--detach",
    `--user=${spec.user.uid}:${spec.user.gid}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    ...spec.securityOpt.map((entry: string) => `--security-opt=${entry}`),
    `--pids-limit=${String(spec.pidsLimit)}`,
    `--memory=${String(spec.memoryBytes)}`,
    `--cpus=${String(spec.cpuCores)}`,
    "--init",
    "--env=WB_BROWSER_SANDBOX=1",
    `--env=WB_RUNNER_DIGEST=${spec.runner.digest}`,
    `--tmpfs=${SCRATCH_ROOT}:ro,size=0`,
  ];
  for (const mount of spec.tmpfs) {
    args.push(`--tmpfs=${mount.containerPath}:${mount.mode},size=${String(mount.sizeLimitBytes)},noexec,nosuid`);
  }
  args.push(...renderEgressArgs(egress));
  args.push(`image@sha256:${spec.image.digest}`);
  return args;
}

function forbiddenTokenIn(arg: string): string | null {
  for (const forbidden of FORBIDDEN_ENGINE_ARGUMENTS) {
    // A long, unmistakable token is matched anywhere inside the argument, so it
    // cannot ride in behind a legitimate-looking prefix
    // (`--tmpfs=/etc --no-sandbox`, `path/to/docker.sock`). A short flag like `-v`
    // is matched only as a whole token or after a space, because `-v` occurs inside
    // honest identifiers such as `seccomp=workbench-target-v1@…`.
    if (arg === forbidden) return forbidden;
    if (arg.startsWith(`${forbidden}=`)) return forbidden;
    if (arg.includes(` ${forbidden}`)) return forbidden;
    if (forbidden.length > 3 && arg.includes(forbidden)) return forbidden;
  }
  return null;
}

// A closed comparison over the renderer's own output. If a token here is not one
// this file minted, or it carries a forbidden argument, or it mounts anything that
// was not minted from a scratch id, the plan is refused.
export function assertArgsAdmissible(
  args: readonly string[],
  spec: ContainerSpec,
): string[] {
  const problems: string[] = [];
  for (const arg of args) {
    const forbidden = forbiddenTokenIn(arg);
    if (forbidden !== null) problems.push(`forbidden-engine-argument:${forbidden}`);

    const flag = arg.split("=")[0] as string;
    if (MOUNT_FLAGS.includes(flag)) {
      const containerPath = (arg.slice(flag.length + 1).split(":")[0] as string) ?? "";
      if (containerPath !== SCRATCH_ROOT && !containerPath.startsWith(`${SCRATCH_ROOT}/`)) {
        problems.push(`mount-not-minted-by-this-renderer:${containerPath.slice(0, 32)}`);
      }
      continue;
    }
    if (arg.startsWith("--")) {
      if (!RENDERER_FLAGS.includes(flag)) problems.push(`engine-argument-not-minted:${flag}`);
      continue;
    }
    if (!RENDERER_POSITIONALS.includes(arg) && !arg.startsWith("image@sha256:")) {
      problems.push(`positional-argument-not-minted:${arg.slice(0, 24)}`);
    }
  }
  if (spec.bindMounts.length !== 0) problems.push("bind-mounts-are-never-admissible");
  if (spec.capabilities.add.length !== 0) problems.push("capabilities-are-never-added-back");
  if (!ADMISSIBLE_NETWORK_MODES.includes(spec.networkMode)) {
    problems.push("network-mode-must-deny-egress");
  }
  if (spec.readOnlyRootfs !== true) problems.push("rootfs-must-be-read-only");
  if (spec.browserSandbox !== true) problems.push("browser-sandbox-must-be-enabled");
  if (spec.user.uid === 0 || spec.user.gid === 0) problems.push("target-must-not-run-as-root");
  return [...new Set(problems)];
}

export function renderStartPlan(input: {
  request: StartProfileBrokerRequest;
  verdict: PreflightVerdict;
  host: { platform: string; arch: string };
  images: SandboxImageAllowlist;
}): Result<RenderedTargetPlan, RenderRefusal> {
  // This is the only place the "refuse rather than degrade" question is asked: the
  // verdict arrives already computed by the control plane's single preflight, and
  // the renderer neither re-derives it nor softens it (issue #21).
  if (!input.verdict.runnable) {
    return err({
      code: "CAPABILITY_UNAVAILABLE",
      reason: "isolation-conditions-unmet",
      reasons: input.verdict.unmet,
    });
  }
  if (!isSupportedSandboxHost(input.host)) {
    // Unreachable when the verdict is honest, and cheap to keep: the alternative is
    // a renderer that could be handed a verdict from another host type.
    return err({
      code: "CAPABILITY_UNAVAILABLE",
      reason: "platform-unsupported",
      reasons: [
        `required:${SANDBOX_HOST_REQUIREMENTS.platform}/${SANDBOX_HOST_REQUIREMENTS.arch}`,
        `observed:${input.host.platform}/${input.host.arch}`,
      ],
    });
  }

  const profile: SandboxProfileDescriptor = input.request.profile;
  const entry = input.images.find((candidate) => candidate.profileId === profile.profileId);
  if (entry === undefined) {
    return err({
      code: "CAPABILITY_UNAVAILABLE",
      reason: `profile-image-not-pinned:${profile.profileId}`,
      reasons: [`profile-image-not-pinned:${profile.profileId}`],
    });
  }

  const tmpfs: RenderedTmpfs[] = [];
  const unminted: string[] = [];
  for (const scratch of profile.scratch) {
    const containerPath = mintScratchPath(scratch);
    if (containerPath === null) {
      unminted.push(`scratch-id-unusable:${scratch.scratchId.slice(0, 8)}`);
      continue;
    }
    tmpfs.push({
      containerPath,
      sizeLimitBytes: scratch.sizeLimitBytes,
      mode: scratch.readOnly ? "ro" : "rw",
    });
  }
  if (unminted.length > 0) {
    return err({ code: "INVALID_INPUT", reason: unminted[0] as string, reasons: unminted });
  }
  if (tmpfs.length === 0) {
    return err({
      code: "CAPABILITY_UNAVAILABLE",
      reason: "isolation-condition-unmet:privateTmpfs",
      reasons: ["isolation-condition-unmet:privateTmpfs"],
    });
  }

  // Anything interpolated into an argument has to look like an identifier first.
  const labels: { name: string; value: string }[] = [
    { name: "seccomp-policy-id", value: profile.isolation.seccomp.policyId },
    { name: "egress-policy-id", value: input.request.egress.policyId },
    { name: "profile-id", value: profile.profileId },
  ];
  const unrenderable = labels
    .filter((label) => !isRenderableLabel(label.value))
    .map((label) => `label-unrenderable:${label.name}`);
  if (unrenderable.length > 0) {
    return err({
      code: "INVALID_INPUT",
      reason: unrenderable[0] as string,
      reasons: unrenderable,
    });
  }

  const seccomp = profile.isolation.seccomp;
  const spec: ContainerSpec = {
    image: { digest: entry.imageDigest },
    runner: { digest: entry.runnerDigest },
    user: { uid: profile.isolation.runAsUserId, gid: profile.isolation.runAsGroupId },
    groupAdd: [],
    readOnlyRootfs: true,
    tmpfs,
    bindMounts: [],
    capabilities: { drop: ["ALL"], add: [] },
    securityOpt: [
      `seccomp=${seccomp.policyId}@${seccomp.digest}`,
      // The profile's own drop list is echoed here only to prove the value was
      // `ALL`. Some other entry has no rendering at all and is refused below.
      ...profile.isolation.droppedCapabilities.map((cap: string) => `cap-drop=${cap}`),
    ],
    browserSandbox: true,
    networkMode: networkModeFor(input.request.egress),
    pidsLimit: profile.limits.pids,
    memoryBytes: profile.limits.memoryBytes,
    cpuCores: profile.limits.cpuCores,
    diskQuotaBytes: profile.limits.diskBytes,
    timeoutMs: profile.limits.timeoutMs,
  };

  const engineArgs = renderEngineArgs(spec, input.request.egress);
  const problems = assertArgsAdmissible(engineArgs, spec);
  if (problems.length > 0) {
    return err({ code: "INVALID_INPUT", reason: problems[0] as string, reasons: problems });
  }
  return ok({
    requestId: input.request.requestId,
    jobId: input.request.jobId,
    taskId: input.request.taskId,
    profileId: profile.profileId,
    spec,
    engineArgs,
    egress: input.request.egress,
  });
}

import path from "node:path";

// The Builder's role context (DESIGN §3 `packages/adapters/agents` = 独立角色上下文与工具清单,
// §5 line 425, §7.3, §10 / PRD A07, issue #19).
//
// §5 says the Builder sees its blueprint class and its own output directory and nothing
// else - not the raw Evidence, not the original upload, not the Inspector's logs or model
// history, not a holdout, not the host HOME, not provider configuration. That is a statement
// about *what a role is handed*, so it belongs in a module that decides exactly that, and it
// is checkable without a container: the launch plan below is data, and every field of it is
// asserted in tests.
//
// What this deliberately does not claim: process isolation here is not the sandbox the broker
// will provide (§11). A separate process with a scoped file view and a rebuilt environment is
// the boundary §5 names for this role; it is not a namespace, and it does not pretend to be.

export const BUILDER_ROLE_ID = "builder";

// The role's tool manifest (§3). One entry, because one is all the blueprint handoff
// authorises: the Builder turns a frozen handoff into an HTTP SDK. There is no read tool, no
// shell, and no "ask the model for a file" - a tool list that includes retrieval is a
// different role.
export const BUILDER_ROLE_TOOLS = ["generate-http-sdk"] as const;

// The candidate's fixed file set. Named here so the parent can refuse a child that produced
// something else, rather than publishing whatever appeared.
export const BUILDER_ROLE_FILES = ["adapter.ts", "openapi.json", "candidate-manifest.json"] as const;

// Bytes a role may hand back per file. The candidate budget in §10 is about attempts and
// wall clock; this is the separate, smaller question of how much text one generated file may
// be before the parent stops trusting the child.
export const BUILDER_ROLE_MAX_FILE_BYTES = 4 * 1024 * 1024;

// The only inherited variables a role may keep, and each one is rewritten rather than
// copied: `PATH` to a fixed system pair, `HOME` into the role's own run directory. Anything
// else - `WB_*` configuration, proxy settings, provider tokens, the real host HOME - does not
// cross the boundary, so a role cannot name the data directory even to itself.
const INHERITED_ALLOWLIST = ["PATH"] as const;
const FIXED_PATH_VALUE = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export type BuilderLaunchPlan = {
  readonly roleId: typeof BUILDER_ROLE_ID;
  readonly tools: readonly string[];
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly handoffFile: string;
  readonly outputDir: string;
  readonly runDir: string;
};

export type RoleRefusal = { code: "ACCESS_DENIED" | "INVALID_INPUT"; reason: string; details: string[] };

function refuse(reason: string, details: string[] = []): { ok: false; refusal: RoleRefusal } {
  return { ok: false, refusal: { code: reason.startsWith("handoff") || reason.startsWith("run-id") ? "ACCESS_DENIED" : "INVALID_INPUT", reason, details } };
}

// Directory containment at a path boundary only: a sibling whose name merely starts with the
// prefix (`…/staging-evil`) is not inside `…/staging`.
function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function planBuilderLaunch(input: {
  nodeBin: string;
  entryFile: string;
  stagingRoot: string;
  runId: string;
  inheritedEnv: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}): { ok: true; plan: BuilderLaunchPlan } | { ok: false; refusal: RoleRefusal } {
  if (!path.isAbsolute(input.nodeBin) || !path.isAbsolute(input.entryFile)) {
    return refuse("launch-paths-must-be-absolute");
  }
  // A run id that can carry a separator or a dot-segment would let one role's directory
  // address another's. Opaque ids only.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.runId)) return refuse("run-id-not-opaque", [input.runId]);
  const runDir = path.resolve(input.stagingRoot, input.runId);
  if (!within(runDir, input.stagingRoot)) return refuse("run-dir-outside-staging", [runDir]);
  const handoffFile = path.join(runDir, "blueprint.json");
  const outputDir = path.join(runDir, "out");
  if (!within(handoffFile, input.stagingRoot) || !within(outputDir, input.stagingRoot)) {
    return refuse("handoff-outside-staging", [handoffFile]);
  }

  const env: Record<string, string> = {
    // The role's home is its own run directory: a program that reaches for `~/.config/...`
    // finds an empty directory it owns, not the host's.
    HOME: runDir,
    NODE_DISABLE_COLORS: "1",
    NO_COLOR: "1",
    LANG: "C.UTF-8",
  };
  for (const name of INHERITED_ALLOWLIST) {
    const value = input.inheritedEnv[name];
    // `PATH` is rebuilt to the fixed system pair rather than inherited, so a data directory
    // or a provider binary that someone put on PATH earlier cannot be found by name here.
    if (name === "PATH") env.PATH = FIXED_PATH_VALUE;
    else if (typeof value === "string" && value.length > 0) env[name] = value;
  }

  return {
    ok: true,
    plan: {
      roleId: BUILDER_ROLE_ID,
      tools: BUILDER_ROLE_TOOLS,
      argv: [input.nodeBin, input.entryFile, "--handoff", handoffFile, "--out", outputDir],
      env,
      cwd: runDir,
      handoffFile,
      outputDir,
      runDir,
    },
  };
}

// What the parent accepts back: exactly the declared file set, each one within budget. An
// extra file is as much a refusal as a missing one - a child that writes a fourth artifact
// is not the role this plan authorised.
export function checkRoleOutput(names: readonly string[]): { ok: true } | { ok: false; refusal: RoleRefusal } {
  const sorted = [...names].sort();
  const expected = [...BUILDER_ROLE_FILES].sort();
  if (sorted.length !== expected.length || sorted.some((name, index) => name !== expected[index])) {
    return {
      ok: false,
      refusal: {
        code: "INVALID_INPUT",
        reason: "builder-role-output-set",
        details: [`got=${sorted.join(",")}`, `expected=${expected.join(",")}`],
      },
    };
  }
  return { ok: true };
}

import { describe, expect, it } from "vitest";

import {
  BUILDER_ROLE_FILES,
  BUILDER_ROLE_TOOLS,
  checkRoleOutput,
  planBuilderLaunch,
} from "../../packages/adapters/agents/builder-role.ts";

// The Builder role's launch plan (DESIGN §5 line 425, §7.3, §10 / PRD A07, issue #19).
//
// §5's promise is about what a role is *handed*: its blueprint and its own output directory,
// and not the host HOME, not provider configuration, not the data directory. That is checkable
// as data, and every line below is a way the promise could be quietly untrue.

const BASE = {
  nodeBin: "/usr/local/bin/node",
  entryFile: "/opt/workbench/apps/worker/builder-child.ts",
  stagingRoot: "/var/lib/wb/data/builder-role",
  runId: "5b0f1a2c-0d3e-4a5b-8c9d-0e1f2a3b4c5d",
};

function plan(overrides: Partial<Parameters<typeof planBuilderLaunch>[0]> = {}) {
  return planBuilderLaunch({ ...BASE, inheritedEnv: {}, ...overrides });
}

describe("what the Builder role is handed", () => {
  it("gives it one handoff file and one output directory, both inside its own run", () => {
    const built = plan();
    if (!built.ok) throw new Error(built.refusal.reason);
    expect(built.plan.handoffFile).toBe(`${BASE.stagingRoot}/${BASE.runId}/blueprint.json`);
    expect(built.plan.outputDir).toBe(`${BASE.stagingRoot}/${BASE.runId}/out`);
    expect(built.plan.cwd).toBe(`${BASE.stagingRoot}/${BASE.runId}`);
    expect(built.plan.argv).toEqual([
      BASE.nodeBin,
      BASE.entryFile,
      "--handoff",
      built.plan.handoffFile,
      "--out",
      built.plan.outputDir,
    ]);
    // No code-injection surface: the role is started with a file, never with `-e`, `--eval`
    // or a shell string.
    expect(built.plan.argv.some((entry) => /(^-e$|--eval|--print|shell)/.test(entry))).toBe(false);
    expect(built.plan.roleId).toBe("builder");
  });

  it("rebuilds the environment instead of forwarding one", () => {
    const built = plan({
      inheritedEnv: {
        PATH: `/opt/provider/bin:${BASE.stagingRoot}/bin:/usr/bin`,
        HOME: "/Users/operator",
        WB_DATA_DIR: "/var/lib/wb/data",
        WB_REA_ENTRYPOINT: "/opt/rea/mcp.mjs",
        WB_MODEL_ENDPOINT: "https://model.internal/v1",
        WB_BROKER_SOCKET: "/var/lib/wb/data/broker.sock",
        HTTPS_PROXY: "http://127.0.0.1:7897",
        NODE_OPTIONS: "--require /Users/operator/evil.cjs",
        AWS_SECRET_ACCESS_KEY: "leak",
      },
    });
    if (!built.ok) throw new Error(built.refusal.reason);
    const env = built.plan.env;
    // Nothing named `WB_*`, no provider endpoint, no proxy, no credentials, and no
    // `NODE_OPTIONS` - the last one would let a caller inject code into the role.
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "NODE_DISABLE_COLORS", "NO_COLOR", "PATH"]);
    expect(env.HOME).toBe(`${BASE.stagingRoot}/${BASE.runId}`);
    expect(env.PATH).not.toContain(BASE.stagingRoot);
    expect(env.PATH).not.toContain("/opt/provider/bin");
    expect(JSON.stringify(env)).not.toContain("model.internal");
    expect(JSON.stringify(env)).not.toContain("mcp.mjs");
    expect(JSON.stringify(env)).not.toContain("7897");
    expect(JSON.stringify(env)).not.toContain("evil.cjs");
    expect(JSON.stringify(env)).not.toContain("leak");
    // Every path the plan carries lives under the role's own staging root. The data
    // directory is not absent by accident: there is no field in which it could appear.
    const paths = [built.plan.cwd, built.plan.handoffFile, built.plan.outputDir, built.plan.runDir];
    for (const target of paths) expect(target.startsWith(BASE.stagingRoot)).toBe(true);
    expect(built.plan.argv.filter((entry) => entry.startsWith("/"))).toEqual([
      BASE.nodeBin,
      BASE.entryFile,
      built.plan.handoffFile,
      built.plan.outputDir,
    ]);
  });

  it("refuses a run id that could address another role's directory", () => {
    for (const runId of ["../other", "a/b", "", "-x", "x".repeat(65), "with space", "."]) {
      const refused = plan({ runId });
      expect(refused.ok, runId).toBe(false);
      if (refused.ok) continue;
      expect(refused.refusal.reason).toBe("run-id-not-opaque");
    }
  });

  it("refuses relative program paths rather than resolving them later", () => {
    const relative = plan({ entryFile: "apps/worker/builder-child.ts" });
    expect(!relative.ok && relative.refusal.reason).toBe("launch-paths-must-be-absolute");
    const node = plan({ nodeBin: "node" });
    expect(!node.ok && node.refusal.reason).toBe("launch-paths-must-be-absolute");
  });

  it("accepts only the declared candidate file set back", () => {
    expect(checkRoleOutput(BUILDER_ROLE_FILES).ok).toBe(true);
    expect(checkRoleOutput([...BUILDER_ROLE_FILES].reverse()).ok).toBe(true);
    for (const names of [
      ["adapter.ts", "openapi.json"],
      [...BUILDER_ROLE_FILES, "extra.cjs"],
      ["adapter.ts", "openapi.json", "candidate-manifest.json", "../escape.json"],
      [],
    ]) {
      const refused = checkRoleOutput(names);
      expect(refused.ok, names.join(",")).toBe(false);
      if (refused.ok) continue;
      expect(refused.refusal.reason).toBe("builder-role-output-set");
    }
  });

  it("lists the role's tools as one generation entry and nothing else", () => {
    // A tool list that includes retrieval is a different role: §7.3 says the Builder reads the
    // blueprint and nothing else, so there is no "read evidence" or "run shell" to grant.
    expect(BUILDER_ROLE_TOOLS).toEqual(["generate-http-sdk"]);
    expect(BUILDER_ROLE_FILES).toHaveLength(3);
  });
});

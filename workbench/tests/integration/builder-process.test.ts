import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BUILDER_STAGING_DIRNAME, runBuilderRole, sweepRoleStaging } from "../../apps/worker/builder-process.ts";
import { planBuilderLaunch } from "../../packages/adapters/agents/builder-role.ts";
import { BuilderRoleFailure, produceCandidateFiles } from "../../packages/application/builder-service.ts";
import { asDigest } from "../../packages/domain/canonical-json.ts";
import { newId } from "../../packages/domain/identity.ts";
import { blueprintPayload } from "../support/blueprint-seed.ts";

// The Builder role as a real process (DESIGN §2, §5 line 425, §10 / PRD A07, issue #19).
//
// `worker-composition.test.ts` already generates twice through the worker's own RPC, so the
// spawning path is the production path and its happy case is covered there. This file adds the
// failures a happy path cannot reach: a role that writes an extra file, forgets one, lies about
// a digest, answers about operations it was never sent, exits nonzero, or never finishes. The
// parent has to refuse each of those and clean up after itself, because the alternative is a
// worker that publishes whatever a subprocess happened to leave behind.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const CHILD_ENTRY = fileURLToPath(new URL("../../apps/worker/builder-child.ts", import.meta.url));

const handoff = blueprintPayload(newId(), asDigest("b".repeat(64)));
let root = "";
let staging = "";

// A role program that writes the three declared files, then misbehaves in exactly one way.
// The concatenations below are written as `out + "/x"` because they belong to the child's own
// source, not to this file.
const ROLE_BASE = `
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const out = arg("--out");
mkdirSync(out, { recursive: true });
const handoff = JSON.parse(readFileSync(arg("--handoff"), "utf8"));
const operations = handoff.contractRevisions.flatMap((entry) => entry.httpOperations.map((o) => o));
const openapi = { openapi: "3.1.1", info: { title: "probe", version: "1.0.0" }, paths: {} };
const manifest = {
  schemaVersion: 1,
  entry: "adapter.ts",
  operationIds: operations.map((o) => o.operationId).sort(),
  openApiVersion: "3.1.1",
  openApiDigest: "0".repeat(64),
  adapterAbi: { exportName: "invoke", parameters: ["operationId", "sdkInput", "context"] },
};
writeFileSync(out + "/adapter.ts", "export const ROUTE = {};", { mode: 0o600 });
writeFileSync(out + "/openapi.json", JSON.stringify(openapi), { mode: 0o600 });
writeFileSync(out + "/candidate-manifest.json", JSON.stringify(manifest), { mode: 0o600 });
`;

function writeRole(name: string, source: string): string {
  const file = path.join(root, `${name}.mjs`);
  writeFileSync(file, source, { encoding: "utf8", mode: 0o600 });
  return file;
}

async function refuseFrom(entryFile: string, options: { timeoutMs?: number } = {}): Promise<BuilderRoleFailure> {
  try {
    await runBuilderRole(handoff, LIMITS, {
      stagingRoot: staging,
      entryFile,
      timeoutMs: options.timeoutMs ?? 30_000,
    });
  } catch (failure) {
    if (failure instanceof BuilderRoleFailure) return failure;
    throw failure;
  }
  throw new Error("the role produced a candidate and the parent accepted it");
}

beforeAll(async () => {
  const made = await mkdtemp(path.join(tmpdir(), "rea-wb-role-"));
  await rm(made, { recursive: true, force: true });
  mkdirSync(made, { recursive: true, mode: 0o700 });
  root = made;
  staging = path.join(made, "builder-role");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the Builder role as a separate process", () => {
  it("produces the same candidate bytes as the in-process generator", async () => {
    const files = await runBuilderRole(handoff, LIMITS, { stagingRoot: staging, entryFile: CHILD_ENTRY });
    const local = produceCandidateFiles(handoff, LIMITS).sort((left, right) => left.path.localeCompare(right.path));
    expect(files.map((file) => file.path)).toEqual(local.map((file) => file.path));
    // Byte-for-byte: the isolated role is not a second generator with its own opinions.
    expect(files).toEqual(local);
    expect(files.find((file) => file.path === "openapi.json")?.mediaType).toBe("application/json");
    expect(files.find((file) => file.path === "adapter.ts")?.body).toContain("invoke");
  });

  it("leaves no run directory behind", async () => {
    await runBuilderRole(handoff, LIMITS, { stagingRoot: staging, entryFile: CHILD_ENTRY });
    expect(readdirSync(staging)).toEqual([]);
  });

  it("reclaims a role run that outlived its worker, and only its own directories", async () => {
    // §5 line 126: orphan reclamation has to be provable, not name-based guesswork. The
    // sweep therefore removes the opaque run directories and leaves anything else it finds.
    const orphan = path.join(staging, newId());
    mkdirSync(path.join(orphan, "out"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(orphan, "blueprint.json"), "{}", { mode: 0o600 });
    // Something the role code never created, sitting in the same root: an opaque-name filter
    // is what keeps "reclaim our staging" from becoming "delete this directory tree".
    mkdirSync(path.join(staging, "kept-by-somebody-else"), { recursive: true, mode: 0o700 });
    expect(sweepRoleStaging(staging)).toBe(1);
    expect(readdirSync(staging)).toEqual(["kept-by-somebody-else"]);
    rmSync(path.join(staging, "kept-by-somebody-else"), { recursive: true, force: true });
    expect(sweepRoleStaging(path.join(root, "no-such-staging"))).toBe(0);
    expect(BUILDER_STAGING_DIRNAME).toBe("builder-role");
  });

  it("refuses a role that exits with a named reason", async () => {
    const entry = writeRole("refusing", `process.stderr.write("builder-role:handoff-rejected\\n"); process.exit(65);`);
    const failure = await refuseFrom(entry);
    expect(failure.reason).toBe("handoff-rejected");
    expect(failure.details.join(" ")).toContain("exit=65");
    expect(readdirSync(staging)).toEqual([]);
  });

  it("refuses a role that never answers", async () => {
    const entry = writeRole("hanging", "setTimeout(() => undefined, 120000);");
    const failure = await refuseFrom(entry, { timeoutMs: 500 });
    expect(failure.reason).toBe("builder-role-timeout");
    expect(failure.details.join(" ")).toContain("timeoutMs=500");
  });

  it("refuses a role that writes an extra file", async () => {
    const entry = writeRole("extra", `${ROLE_BASE}\nwriteFileSync(out + "/side-effect.sh", "echo hi");`);
    const failure = await refuseFrom(entry);
    expect(failure.reason).toBe("builder-role-output-set");
    expect(failure.details.join(" ")).toContain("side-effect.sh");
  });

  it("refuses a role that omits a file", async () => {
    const entry = writeRole("missing", `${ROLE_BASE}\nrmSync(out + "/openapi.json");`);
    const failure = await refuseFrom(entry);
    expect(failure.reason).toBe("builder-role-output-set");
  });

  it("refuses a role whose file is over the byte budget", async () => {
    const entry = writeRole(
      "huge",
      `${ROLE_BASE.replace('writeFileSync(out + "/adapter.ts", "export const ROUTE = {};", { mode: 0o600 });', 'writeFileSync(out + "/adapter.ts", "x".repeat(5 * 1024 * 1024), { mode: 0o600 });')}`,
    );
    const failure = await refuseFrom(entry);
    expect(failure.reason).toBe("builder-role-file-too-large");
    expect(failure.details.join(" ")).toContain("name=adapter.ts");
  });

  it("refuses a role that lies about the OpenAPI digest", async () => {
    const failure = await refuseFrom(writeRole("liar", ROLE_BASE));
    expect(failure.reason).toBe("builder-role-digest-mismatch");
    expect(failure.details.join(" ")).toContain("recomputed=");
  });

  it("refuses a role that answers about operations it was never sent", async () => {
    const entry = writeRole(
      "renamed",
      ROLE_BASE.replace("operations.map((o) => o.operationId).sort()", '["invented-operation"]'),
    );
    const failure = await refuseFrom(entry);
    // Scope is checked before identity, so the refusal names the scope problem rather than a
    // digest computed over the wrong document.
    expect(failure.reason).toBe("builder-role-operation-mismatch");
    expect(failure.details.join(" ")).toContain("invented-operation");
  });

  it("refuses a role that could not read its handoff", async () => {
    const entry = writeRole(
      "reader",
      `import { readFileSync } from "node:fs";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
JSON.parse(readFileSync(arg("--handoff"), "utf8")).nope.nope;`,
    );
    const failure = await refuseFrom(entry);
    expect(failure.reason).toBe("builder-role-exited");
  });

  it("hands a real child nothing but its own directory", async () => {
    // The plan is data; this applies that data to a process which reports what it can actually
    // see from the inside, so the isolation claim is read out of the child rather than asserted
    // about an object.
    const probe = writeRole(
      "probe",
      `import { writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
writeFileSync(out + "/report.json", JSON.stringify({
  env: Object.keys(process.env).sort(),
  home: process.env.HOME,
  path: process.env.PATH,
  cwd: process.cwd(),
  argv: process.argv.slice(2),
}));`,
    );
    const runId = newId();
    const planned = planBuilderLaunch({
      nodeBin: process.execPath,
      entryFile: probe,
      stagingRoot: staging,
      runId,
      inheritedEnv: {
        PATH: "/opt/provider/bin:/usr/bin",
        HOME: "/Users/operator",
        WB_DATA_DIR: "/var/lib/wb/data",
        HTTPS_PROXY: "http://127.0.0.1:7897",
      },
    });
    if (!planned.ok) throw new Error(planned.refusal.reason);
    // What the parent does before it spawns: the role's own directories and its handoff.
    mkdirSync(planned.plan.outputDir, { recursive: true, mode: 0o700 });
    writeFileSync(planned.plan.handoffFile, JSON.stringify(handoff), { encoding: "utf8", mode: 0o600 });
    const result = spawnSync(planned.plan.argv[0] as string, planned.plan.argv.slice(1), {
      cwd: planned.plan.cwd,
      env: planned.plan.env as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    try {
      expect(result.status, `${result.stderr}|${String(result.error?.message)}`).toBe(0);
      const report = JSON.parse(readFileSync(path.join(planned.plan.outputDir, "report.json"), "utf8")) as {
        env: string[];
        home: string;
        path: string;
        cwd: string;
        argv: string[];
      };
      const plannedKeys = Object.keys(planned.plan.env).sort();
      // Everything the child sees is either something the plan wrote or something the OS
      // `exec` added itself. Nothing from the inherited environment is in that residue:
      // `WB_DATA_DIR`, `HTTPS_PROXY` and the host `HOME` were all set for the parent.
      expect(report.env.filter((key) => !plannedKeys.includes(key))).toEqual(["__CF_USER_TEXT_ENCODING"]);
      for (const forbidden of ["WB_DATA_DIR", "HTTPS_PROXY", "NODE_OPTIONS", "AWS_SECRET_ACCESS_KEY"]) {
        expect(report.env).not.toContain(forbidden);
      }
      expect(JSON.stringify(report)).not.toContain("/Users/operator");
      expect(JSON.stringify(report)).not.toContain("127.0.0.1:7897");
      expect(report.home).toBe(planned.plan.runDir);
      // The OS resolves symlinks in `getcwd`, and macOS reaches the temp tree through
      // `/var -> /private/var`; the point is that the child's working directory *is* the
      // role's own run directory, so the comparison follows the same resolution.
      expect(report.cwd).toBe(realpathSync(planned.plan.runDir));
      expect(report.path).not.toContain("/opt/provider/bin");
      expect(report.argv).toEqual(["--handoff", planned.plan.handoffFile, "--out", planned.plan.outputDir]);
    } finally {
      rmSync(planned.plan.runDir, { recursive: true, force: true });
    }
  });
});

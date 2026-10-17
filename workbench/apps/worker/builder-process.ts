import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import {
  BUILDER_ROLE_MAX_FILE_BYTES,
  checkRoleOutput,
  planBuilderLaunch,
} from "../../packages/adapters/agents/builder-role.ts";
import { BuilderRoleFailure } from "../../packages/application/builder-service.ts";
import type { BuilderHandoff } from "../../packages/application/builder-service.ts";
import { openApiDigest } from "../../packages/domain/openapi.ts";
import type { CandidateFile } from "../../packages/domain/openapi.ts";
import type { CanonicalLimits } from "../../packages/domain/canonical-json.ts";
import { isId, newId } from "../../packages/domain/identity.ts";
import type { JsonObject, JsonValue } from "../../packages/domain/json-value.ts";
import { isJsonObject } from "../../packages/domain/json-value.ts";

// The parent half of the Builder role (DESIGN §2, §12 line 425, §7.3, §10 / PRD A07, issue #19).
//
// The worker writes one file - the frozen handoff - into a directory the role owns, spawns the
// role's program with an environment `planBuilderLaunch` rebuilt from scratch, waits, and then
// *verifies* what came back instead of trusting it: the exact declared file set, each file
// within budget, the OpenAPI digest recomputed here under this build's canonicalization budget,
// and the operation list matching the handoff that was sent.
//
// Verification rather than re-generation is the point. If the parent simply ran the generator
// again and compared, the child would be decoration; recomputing an identity from the bytes the
// role produced is what makes "this candidate was made elsewhere" a checkable claim. The
// service still publishes and digests the files itself, so the candidate identity comes from
// bytes that passed these checks.

// Where a role's run lives inside the data directory. Named here because both the producer
// and the boot-time sweep have to agree on it, and a stale directory nobody recognises is a
// directory nobody reclaims.
export const BUILDER_STAGING_DIRNAME = "builder-role";

// §5 line 126 allows reclaiming staging only when it is *proven* to belong to this workbench
// and unreferenced. Under this root that is decidable at boot: the directories are ones this
// code created, the worker holds the exclusive lock, and no role has been dispatched yet.
// Anything else that appears in there is left alone rather than deleted by a guess.
export function sweepRoleStaging(stagingRoot: string): number {
  if (!existsSync(stagingRoot)) return 0;
  let removed = 0;
  for (const name of readdirSync(stagingRoot)) {
    // A workbench run id, and nothing else. A looser shape - "any opaque-looking word" -
    // would let this delete a directory somebody else put in the same place, which is the
    // name-guessing §5 explicitly forbids.
    if (!isId(name)) continue;
    rmSync(path.join(stagingRoot, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export type BuilderProcessOptions = {
  stagingRoot: string;
  entryFile: string;
  nodeBin?: string;
  timeoutMs?: number;
  inheritedEnv?: Readonly<Record<string, string | undefined>>;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_CAP = 8192;

function parseObject(text: string, reason: string): JsonObject {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    throw new BuilderRoleFailure(reason);
  }
  if (!isJsonObject(parsed)) throw new BuilderRoleFailure(reason);
  return parsed;
}

export async function runBuilderRole(
  handoff: BuilderHandoff,
  limits: CanonicalLimits,
  options: BuilderProcessOptions,
): Promise<CandidateFile[]> {
  const planned = planBuilderLaunch({
    nodeBin: options.nodeBin ?? process.execPath,
    entryFile: options.entryFile,
    stagingRoot: options.stagingRoot,
    // A fresh opaque id per run: two generations of the same blueprint must not share a
    // directory, or the second one could read the first one's output.
    runId: newId(),
    inheritedEnv: options.inheritedEnv ?? process.env,
  });
  if (!planned.ok) throw new BuilderRoleFailure(planned.refusal.reason, planned.refusal.details);
  const plan = planned.plan;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  mkdirSync(plan.outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(plan.handoffFile, JSON.stringify(handoff), { encoding: "utf8", mode: 0o600 });

  try {
    const outcome = await new Promise<{ code: number | null; signal: string | null; stderr: string; timedOut: boolean }>(
      (resolve) => {
        let timedOut = false;
        const child = spawn(plan.argv[0] as string, plan.argv.slice(1), {
          cwd: plan.cwd,
          env: plan.env as NodeJS.ProcessEnv,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          // Bounded: a role that talks loudly must not be able to grow the parent's memory.
          if (stderr.length < STDERR_CAP) stderr += chunk;
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stderr, timedOut });
        });
        child.on("error", (error: Error) => {
          clearTimeout(timer);
          resolve({ code: null, signal: null, stderr: error.message, timedOut: false });
        });
      },
    );

    if (outcome.timedOut) throw new BuilderRoleFailure("builder-role-timeout", [`timeoutMs=${String(timeoutMs)}`]);
    if (outcome.code !== 0) {
      // The child's own named reason is what gets published and journalled; anything else
      // collapses to a fixed code, so a stack trace cannot ride out through an audit entry.
      const named = /builder-role:([a-z-]+)/.exec(outcome.stderr)?.[1] ?? "builder-role-exited";
      throw new BuilderRoleFailure(named, [`exit=${String(outcome.code ?? outcome.signal)}`]);
    }

    const names = readdirSync(plan.outputDir).filter((name) => statSync(path.join(plan.outputDir, name)).isFile());
    const checked = checkRoleOutput(names);
    if (!checked.ok) throw new BuilderRoleFailure(checked.refusal.reason, checked.refusal.details);

    const produced = new Map<string, CandidateFile>();
    for (const name of names) {
      const file = path.join(plan.outputDir, name);
      const size = statSync(file).size;
      if (size > BUILDER_ROLE_MAX_FILE_BYTES) {
        throw new BuilderRoleFailure("builder-role-file-too-large", [`name=${name}`, `bytes=${String(size)}`]);
      }
      produced.set(name, { path: name, body: readFileSync(file, "utf8"), mediaType: name.endsWith(".json") ? "application/json" : "text/typescript" });
    }

    const manifest = parseObject(produced.get("candidate-manifest.json")?.body ?? "", "builder-role-manifest-unparseable");
    const document = parseObject(produced.get("openapi.json")?.body ?? "", "builder-role-openapi-unparseable");

    // Scope before identity: a role that answered about operations the handoff never named
    // is the more serious failure, and checking it first means the refusal an operator reads
    // names the scope problem rather than a digest that was computed over the wrong thing.
    const sent = handoff.contractRevisions
      .flatMap((entry) => entry.httpOperations.map((operation) => operation.operationId))
      .sort();
    const returned = Array.isArray(manifest["operationIds"]) ? [...manifest["operationIds"]].map(String).sort() : [];
    if (JSON.stringify(sent) !== JSON.stringify(returned)) {
      throw new BuilderRoleFailure("builder-role-operation-mismatch", [`handoff=${sent.join(",")}`, `returned=${returned.join(",")}`]);
    }
    const promised = typeof manifest["openApiDigest"] === "string" ? manifest["openApiDigest"] : "";
    const recomputed = openApiDigest(document, limits);
    if (promised !== recomputed) {
      throw new BuilderRoleFailure("builder-role-digest-mismatch", [`promised=${promised}`, `recomputed=${recomputed}`]);
    }

    return [...produced.values()].sort((left, right) => left.path.localeCompare(right.path));
  } finally {
    // The role's scratch space goes either way: a handoff file and a candidate directory are
    // not something a workbench leaves behind after the answer came back (§5 line 126 says
    // crash recovery reclaims staging, and the tidy path should not be the only one).
    rmSync(plan.runDir, { recursive: true, force: true });
  }
}

export function makeBuilderProcessProducer(
  options: BuilderProcessOptions,
): (handoff: BuilderHandoff, limits: CanonicalLimits) => Promise<CandidateFile[]> {
  return (handoff, limits) => runBuilderRole(handoff, limits, options);
}

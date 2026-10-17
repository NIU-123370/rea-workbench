import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { builderBlueprintSchema } from "../../packages/contracts/blueprint.ts";
import { produceCandidateFiles } from "../../packages/application/builder-service.ts";
import type { CanonicalLimits } from "../../packages/domain/canonical-json.ts";
import type { JsonObject } from "../../packages/domain/json-value.ts";
import type { BlueprintPayload } from "../../packages/domain/blueprint.ts";

// The Builder role's own program (DESIGN §2 "Builder：独立进程 / 文件视图 / 无网络",
// §12 line 425, §7.3, §10 / PRD A07, issue #19).
//
// This file is what the worker spawns. It is handed two paths and nothing else: a handoff
// file containing one frozen blueprint, and an output directory it owns. It cannot open the
// database (no handle, no path), cannot read the artifact store (its `HOME` is its own run
// directory and the environment was rebuilt by `planBuilderLaunch`), and has no way to ask a
// question of the control plane - there is no RPC socket in its arguments and no token in its
// environment.
//
// It exits non-zero with a named reason on any problem, because a candidate that could not be
// produced has to arrive as a refusal, not as an empty directory the parent might publish.

// The canonicalization budget the OpenAPI digest is computed under. It is a property of the
// generation contract, not of the caller: the parent re-computes the same digest with the
// same budget before it publishes anything, so a child that hashed under a different budget
// is refused rather than trusted.
const CHILD_LIMITS: CanonicalLimits = { maxDepth: 24, maxCodeUnits: 200_000 };

// One exit path per named reason, so nothing here can accidentally `return` a value the
// process treats as a status.
function fail(reason: string, code: number): number {
  process.stderr.write(`${reason}\n`);
  return code;
}

function flag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const handoffFile = flag(argv, "--handoff");
  const outputDir = flag(argv, "--out");
  if (handoffFile === null || outputDir === null) return fail("builder-role:handoff-and-out-required", 64);
  if (!path.isAbsolute(handoffFile) || !path.isAbsolute(outputDir)) return fail("builder-role:paths-must-be-absolute", 64);

  let parsed: ReturnType<typeof builderBlueprintSchema.safeParse>;
  try {
    parsed = builderBlueprintSchema.safeParse(JSON.parse(readFileSync(handoffFile, "utf8")) as JsonObject);
  } catch {
    // The reason is named and the content is not echoed: the handoff is the only thing this
    // process was allowed to read, and a parse failure is not a licence to print it.
    return fail("builder-role:handoff-unparseable", 65);
  }
  if (!parsed.success) return fail("builder-role:handoff-rejected", 65);

  let files: ReturnType<typeof produceCandidateFiles>;
  try {
    // The wire shape is validated above; the brand is a compile-time marker, and the parent
    // re-checks the same handoff against its own index row before publishing.
    files = produceCandidateFiles(parsed.data as unknown as BlueprintPayload, CHILD_LIMITS);
  } catch {
    return fail("builder-role:generation-failed", 70);
  }
  try {
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    for (const file of files) {
      // `file.path` comes from the generator's own fixed list, not from anything the handoff
      // named, so there is no path here to escape and no guard pretending to check one.
      writeFileSync(path.join(outputDir, file.path), file.body, { encoding: "utf8", mode: 0o600 });
      chmodSync(path.join(outputDir, file.path), 0o600);
    }
  } catch {
    return fail("builder-role:output-write-failed", 73);
  }
  process.stdout.write(`builder-role:ok files=${String(files.length)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main();
}

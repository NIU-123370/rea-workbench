import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as canonicalJson from "../../packages/domain/canonical-json.ts";
import * as comparators from "../../packages/domain/comparators.ts";
import * as blueprint from "../../packages/domain/blueprint.ts";
import * as contract from "../../packages/domain/contract.ts";
import * as evidence from "../../packages/domain/evidence.ts";
import * as exportDomain from "../../packages/domain/export.ts";
import * as id from "../../packages/domain/id.ts";
import * as identity from "../../packages/domain/identity.ts";
import * as inspect from "../../packages/domain/inspect.ts";
import * as openApi from "../../packages/domain/openapi.ts";
import * as plan from "../../packages/domain/plan.ts";
import * as target from "../../packages/domain/target.ts";
import * as inventory from "../../packages/domain/inventory.ts";
import * as jobStates from "../../packages/domain/job-states.ts";
import * as jsonValue from "../../packages/domain/json-value.ts";
import * as report from "../../packages/domain/report.ts";
import * as result from "../../packages/domain/result.ts";
import * as vector from "../../packages/domain/vector.ts";
import * as zip from "../../packages/domain/zip.ts";

// DESIGN §3 keeps `packages/domain` free of UI, database, REA SDK and container
// dependencies; §6, §7.4 and §10 name the rules that must exist there. This
// guard checks both against the files on disk, so a new module cannot be added
// silently and a rule cannot be dropped while its test file still passes.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOMAIN_DIR = path.join(ROOT, "packages/domain");

const MODULES: Record<string, unknown> = {
  "canonical-json.ts": canonicalJson,
  "comparators.ts": comparators,
  "blueprint.ts": blueprint,
  "contract.ts": contract,
  "evidence.ts": evidence,
  "export.ts": exportDomain,
  "id.ts": id,
  "identity.ts": identity,
  "inspect.ts": inspect,
  "openapi.ts": openApi,
  "plan.ts": plan,
  "target.ts": target,
  "inventory.ts": inventory,
  "job-states.ts": jobStates,
  "json-value.ts": jsonValue,
  "report.ts": report,
  "result.ts": result,
  "vector.ts": vector,
  "zip.ts": zip,
};

const SPEC_NAMED_EXPORTS: [string, string][] = [
  ["canonical-json.ts", "digestCanonicalJson"],
  ["comparators.ts", "isComparatorNormalization"],
  ["inspect.ts", "isInspectScope"],
  ["target.ts", "isTargetKind"],
  ["canonical-json.ts", "digestBytes"],
  ["canonical-json.ts", "canonicalJson"],
  ["canonical-json.ts", "isDigest"],
  ["canonical-json.ts", "asDigest"],
  ["identity.ts", "newId"],
  ["identity.ts", "isId"],
  ["identity.ts", "asId"],
  ["identity.ts", "nowInstant"],
  ["identity.ts", "isInstant"],
  ["identity.ts", "asInstant"],
  ["result.ts", "ok"],
  ["result.ts", "err"],
  ["result.ts", "mapResult"],
  ["result.ts", "mapErr"],
  ["result.ts", "allResults"],
  ["evidence.ts", "coverageIsSufficient"],
  ["evidence.ts", "coverageDeficiencyReasons"],
  ["evidence.ts", "projectClaim"],
  ["evidence.ts", "projectRequiredClaims"],
  ["evidence.ts", "blocksStrictBlueprint"],
  ["inventory.ts", "inventoryCounts"],
  ["inventory.ts", "planCounts"],
  ["job-states.ts", "isTerminalJobState"],
  ["job-states.ts", "canTransitionJob"],
  ["report.ts", "determineResult"],
  ["report.ts", "passRate"],
  ["report.ts", "staleReasons"],
  ["report.ts", "deliverability"],
  ["vector.ts", "deriveEligibility"],
  ["blueprint.ts", "buildBlueprintPayload"],
  ["blueprint.ts", "blueprintDigestInput"],
  ["blueprint.ts", "blueprintDigestOf"],
  ["blueprint.ts", "publicVectorOf"],
  ["blueprint.ts", "leakReasons"],
  ["blueprint.ts", "sourceTextSuspicions"],
  ["blueprint.ts", "nonSeenClaimReasons"],
  ["blueprint.ts", "nonSeenEdgeReasons"],
  ["blueprint.ts", "sourceManifestDigestOf"],
  ["contract.ts", "contractDigest"],
  ["contract.ts", "contractDigestInput"],
  ["contract.ts", "contractGateReasons"],
  ["plan.ts", "deriveSelectedVectorIds"],
  ["plan.ts", "inventorySnapshotDigest"],
  ["plan.ts", "planDigest"],
  ["plan.ts", "planGateReasons"],
  ["vector.ts", "vectorDigest"],
  ["vector.ts", "vectorDigestInput"],
  ["vector.ts", "vectorIntegrityDefects"],
  ["vector.ts", "bodyIntegrityDefects"],
  ["vector.ts", "isCanonicalBase64"],
  ["vector.ts", "sameSourceCoordinates"],
  ["vector.ts", "draftReview"],
  ["openapi.ts", "generationDefects"],
  ["openapi.ts", "buildTargetOpenApi"],
  ["openapi.ts", "openApiDigest"],
  ["openapi.ts", "candidateManifest"],
  ["openapi.ts", "adapterSource"],
  ["zip.ts", "buildZipArchive"],
  ["zip.ts", "readZipArchive"],
  ["zip.ts", "crc32"],
  ["zip.ts", "entryNameDefects"],
  ["export.ts", "statusNoteFor"],
  ["export.ts", "exportStatusDefects"],
  ["export.ts", "downloadUrlFor"],
  ["export.ts", "isRelativeDownloadUrl"],
  ["export.ts", "declaredPackageEntries"],
  ["export.ts", "packageEntryDefects"],
  ["export.ts", "coverageOf"],
];

function domainFiles(): string[] {
  return readdirSync(DOMAIN_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

function exportedNames(file: string): string[] {
  const text = readFileSync(path.join(DOMAIN_DIR, file), "utf8");
  return [...text.matchAll(/^export (?:const|function|class|type|interface)\s+(\w+)/gm)].map(
    (match) => match[1] as string,
  );
}

describe("domain module inventory (DESIGN §3)", () => {
  it("finds the domain files on disk", () => {
    const files = domainFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("evidence.ts");
  });

  it("every domain file publishes something and cites its section", () => {
    const silent: string[] = [];
    const uncited: string[] = [];
    for (const file of domainFiles()) {
      if (exportedNames(file).length === 0) silent.push(file);
      if (!/§\s*\d/.test(readFileSync(path.join(DOMAIN_DIR, file), "utf8"))) uncited.push(file);
    }
    expect(silent).toEqual([]);
    expect(uncited).toEqual([]);
  });

  it("keeps the module list and the imported modules in step", () => {
    const onDisk = domainFiles();
    const imported = Object.keys(MODULES).sort();
    // A domain file that no test imports is untested by construction.
    expect(onDisk.filter((file) => !imported.includes(file))).toEqual([]);
    expect(imported.filter((file) => !onDisk.includes(file))).toEqual([]);
  });

  // The comparator vocabulary exists in `domain` for one reason: the page has to name what each
  // installed policy will treat as equal, and `contracts/verification.ts` is reached through zod,
  // which §3 keeps out of `apps/web`. That only holds while there is one list, so the re-export is
  // asserted here rather than trusted - a second copy in the contract would let the server accept a
  // normalization the page refuses to label, and the read door would answer "清单读不到" forever.
  it("keeps one owner of the comparator normalization vocabulary", () => {
    const contract = readFileSync(path.join(ROOT, "packages/contracts/verification.ts"), "utf8");
    expect(contract).toContain('export { COMPARATOR_NORMALIZATIONS as comparatorNormalizations } from "../domain/comparators.ts";');
    expect(contract).not.toMatch(/const comparatorNormalizations\s*=\s*\[/);
    // Browser-safe for the same reason `id.ts` is: no Node builtin, no zod.
    const source = readFileSync(path.join(DOMAIN_DIR, "comparators.ts"), "utf8");
    expect(source).not.toMatch(/from\s*["'](node:|zod)/);
    // The predicate is the owner of the closed list, so a name outside it cannot be labelled.
    expect(comparators.isComparatorNormalization("json-key-order")).toBe(true);
    expect(comparators.isComparatorNormalization("ignore-everything")).toBe(false);
  });

  // The same argument the comparator test above makes, for the two vocabularies §8 line 275 needs:
  // the screen offers inspect scopes and has to recognise a target kind to know whether the target it
  // was given can be inspected at all. Both lists are therefore in `domain`, and the contracts that
  // enforce them import them. A second inline copy would let the door accept a value the page cannot
  // name - and, for the target kinds, would let a page call an unknown kind "not a URL target" and
  // send an inspect the worker then refuses.
  it("keeps one owner of the inspect scope and target kind vocabularies", () => {
    const tasks = readFileSync(path.join(ROOT, "packages/contracts/tasks.ts"), "utf8");
    expect(tasks).toContain('export { INSPECT_SCOPES as inspectScopes, isInspectScope } from "../domain/inspect.ts";');
    expect(tasks).toContain("scope: z.enum(INSPECT_SCOPES)");
    expect(tasks).not.toMatch(/z\.enum\(\s*\[\s*"static"/);
    const resources = readFileSync(path.join(ROOT, "packages/contracts/resources.ts"), "utf8");
    expect(resources).toContain('export { TARGET_KINDS as targetKinds, isTargetKind } from "../domain/target.ts";');
    expect(resources).toContain("kind: z.enum(TARGET_KINDS)");
    expect(resources).not.toMatch(/z\.enum\(\s*\[\s*"url"/);
    for (const [file, list] of [["inspect.ts", "INSPECT_SCOPES"], ["target.ts", "TARGET_KINDS"]] as const) {
      const source = readFileSync(path.join(DOMAIN_DIR, file), "utf8");
      expect(source).toMatch(new RegExp(`export const ${list} = \\[`));
      // Browser-safe for the same reason `id.ts` is: no Node builtin, no zod.
      expect(source).not.toMatch(/from\s*["'](node:|zod)/);
    }
    expect(inspect.INSPECT_SCOPES).toEqual(["static", "captured-runtime"]);
    expect(inspect.isInspectScope("captured-runtime")).toBe(true);
    expect(inspect.isInspectScope("whatever")).toBe(false);
    expect(target.TARGET_KINDS).toEqual(["url", "har", "asar"]);
    expect(target.isTargetKind("har")).toBe(true);
    expect(target.isTargetKind("snapshot")).toBe(false);
  });

  it("keeps the id shape importable from a browser bundle", () => {
    // `id.ts` exists because a screen has to recognise an identifier without pulling
    // `node:crypto` into the bundle: `identity.ts` owns `newId()`, and importing the
    // identity module is how a client component ends up asking for a Node builtin.
    const source = readFileSync(path.join(DOMAIN_DIR, "id.ts"), "utf8");
    expect(source).not.toMatch(/from\s*["']node:/);
    // One owner of the pattern: the identity module re-exports this one rather than
    // keeping a second copy that can drift.
    expect(identity.isId).toBe(id.isId);
    expect(identity.ID_PATTERN).toBe(id.ID_PATTERN);
  });

  it("exposes each spec-named rule as a function", () => {
    const missing: string[] = [];
    for (const [file, name] of SPEC_NAMED_EXPORTS) {
      const value = (MODULES[file] as Record<string, unknown>)[name];
      if (typeof value !== "function") missing.push(`${file}:${name} (${typeof value})`);
    }
    expect(missing).toEqual([]);
  });

  it("does not let domain reach a database, UI, REA SDK or container dependency", () => {
    const offenders: string[] = [];
    for (const file of domainFiles()) {
      const text = readFileSync(path.join(DOMAIN_DIR, file), "utf8");
      for (const match of text.matchAll(/from\s*["']([^"']+)["']/g)) {
        const specifier = match[1] as string;
        const allowed = specifier.startsWith("./") || specifier === "node:crypto";
        if (!allowed) offenders.push(`${file} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as canonicalJson from "../../packages/domain/canonical-json.ts";
import * as evidence from "../../packages/domain/evidence.ts";
import * as identity from "../../packages/domain/identity.ts";
import * as inventory from "../../packages/domain/inventory.ts";
import * as jsonValue from "../../packages/domain/json-value.ts";
import * as report from "../../packages/domain/report.ts";
import * as result from "../../packages/domain/result.ts";
import * as vector from "../../packages/domain/vector.ts";

// DESIGN §3 keeps `packages/domain` free of UI, database, REA SDK and container
// dependencies; §6, §7.4 and §10 name the rules that must exist there. This
// guard checks both against the files on disk, so a new module cannot be added
// silently and a rule cannot be dropped while its test file still passes.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOMAIN_DIR = path.join(ROOT, "packages/domain");

const MODULES: Record<string, unknown> = {
  "canonical-json.ts": canonicalJson,
  "evidence.ts": evidence,
  "identity.ts": identity,
  "inventory.ts": inventory,
  "json-value.ts": jsonValue,
  "report.ts": report,
  "result.ts": result,
  "vector.ts": vector,
};

const SPEC_NAMED_EXPORTS: [string, string][] = [
  ["canonical-json.ts", "digestCanonicalJson"],
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
  ["report.ts", "determineResult"],
  ["report.ts", "passRate"],
  ["report.ts", "staleReasons"],
  ["report.ts", "deliverability"],
  ["vector.ts", "deriveEligibility"],
  ["vector.ts", "vectorDigest"],
  ["vector.ts", "vectorDigestInput"],
  ["vector.ts", "vectorIntegrityDefects"],
  ["vector.ts", "bodyIntegrityDefects"],
  ["vector.ts", "isCanonicalBase64"],
  ["vector.ts", "sameSourceCoordinates"],
  ["vector.ts", "draftReview"],
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

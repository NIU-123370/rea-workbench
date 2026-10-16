import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// DESIGN §3 fixes which module may depend on which. Import direction is the
// only way the isolation promises stay checkable without reading every file,
// so it is asserted here rather than left to review.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const MODULES = [
  "packages/domain",
  "packages/contracts",
  "packages/application",
  "packages/adapters/storage",
  "packages/adapters/rea",
  "packages/adapters/sandbox",
  "packages/adapters/agents",
  "apps/worker",
  "apps/web",
  "apps/broker",
] as const;

type Rule = {
  readonly allowedInternal: readonly string[];
  readonly allowedPackages: readonly string[];
  readonly allowedBuiltins: readonly string[];
};

const PACKAGES_ONLY = ["packages/domain", "packages/contracts", "packages/application"];

const RULES: Record<string, Rule> = {
  "packages/domain": {
    allowedInternal: ["packages/domain"],
    allowedPackages: [],
    allowedBuiltins: ["node:crypto"],
  },
  "packages/contracts": {
    allowedInternal: ["packages/domain", "packages/contracts"],
    allowedPackages: ["zod"],
    allowedBuiltins: [],
  },
  "packages/application": {
    allowedInternal: PACKAGES_ONLY,
    allowedPackages: [],
    allowedBuiltins: ["node:crypto"],
  },
  "packages/adapters/storage": {
    allowedInternal: [...PACKAGES_ONLY, "packages/adapters/storage"],
    allowedPackages: [],
    allowedBuiltins: [
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:path",
      "node:sqlite",
    ],
  },
  "packages/adapters/rea": {
    allowedInternal: [...PACKAGES_ONLY, "packages/adapters/rea"],
    allowedPackages: ["@modelcontextprotocol/sdk"],
    allowedBuiltins: ["node:crypto", "node:path", "node:child_process"],
  },
  "packages/adapters/sandbox": {
    allowedInternal: [...PACKAGES_ONLY, "packages/adapters/sandbox"],
    allowedPackages: [],
    allowedBuiltins: ["node:net", "node:path", "node:crypto"],
  },
  "packages/adapters/agents": {
    allowedInternal: [...PACKAGES_ONLY, "packages/adapters/agents"],
    allowedPackages: [],
    allowedBuiltins: ["node:path", "node:crypto"],
  },
  "apps/worker": {
    allowedInternal: ["packages/", "apps/worker"],
    allowedPackages: [],
    allowedBuiltins: [
      "node:crypto",
      // The entrypoint owns its own lifecycle: it reads the declared WB_* names
      // out of `process.env`, installs SIGTERM handlers, and reports exit codes.
      // That needs the `process` global as an explicit import rather than an
      // ambient one, which is also what keeps the no-`console` rule checkable.
      "node:process",
      "node:fs",
      "node:path",
      "node:net",
      "node:sqlite",
      "node:child_process",
      "node:readline",
    ],
  },
  "apps/web": {
    allowedInternal: ["packages/domain", "packages/contracts", "packages/application", "apps/web"],
    allowedPackages: ["next", "react", "react-dom"],
    allowedBuiltins: [],
  },
  "apps/broker": {
    // The broker is a host supervisor speaking its own restricted protocol; it
    // must not reach application services or any adapter (§3, §2).
    allowedInternal: ["packages/domain", "packages/contracts", "apps/broker"],
    allowedPackages: [],
    allowedBuiltins: ["node:child_process", "node:net", "node:fs", "node:path", "node:crypto"],
  },
};

// Anchored to the start of a line on purpose. Unanchored, the word `import`
// inside a string literal (`resourceType: "import",`) runs straight into the next
// quoted value and invents a specifier — a gate that reports what it was meant to
// prevent is worse than one that misses, because it trains everyone to trust the
// noise. Real imports in this codebase always begin a line.
const FROM_CLAUSE = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^\s*import\s*["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_CALL = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

// The gate is only as good as this extractor, so every import form the language
// allows has to land here — including a bare side-effect import, which carries
// no `from` clause at all.
function extractSpecifiers(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of [FROM_CLAUSE, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT, REQUIRE_CALL]) {
    for (const match of text.matchAll(pattern)) found.add(match[1] as string);
  }
  return [...found];
}

// The gate must see every TypeScript flavour, otherwise an all-`.tsx` module
// (planned for apps/web) silently drops out of the scan.
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function sourcesOf(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) return [];
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const full = path.join(absolute, entry.name);
    if (entry.isDirectory()) found.push(...sourcesOf(path.join(dir, entry.name)));
    else if (isSourceFile(entry.name)) found.push(full);
  }
  return found;
}

function specifiersIn(file: string): string[] {
  return extractSpecifiers(readFileSync(file, "utf8"));
}

function relativeTarget(file: string, specifier: string): string {
  return path
    .relative(ROOT, path.resolve(path.dirname(file), specifier))
    .split(path.sep)
    .join("/");
}

function packageName(specifier: string): string {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : (specifier.split("/")[0] as string);
}

// `packages/domain-adapter` must not satisfy the allowlist entry
// `packages/domain`, so prefixes only count at directory boundaries.
function withinAllowed(target: string, allowed: string): boolean {
  const prefix = allowed.endsWith("/") ? allowed : `${allowed}/`;
  return target === allowed || target.startsWith(prefix);
}

function isViolation(module: string, fileDir: string, specifier: string): boolean {
  const rule = RULES[module] as Rule;
  if (specifier.startsWith(".")) {
    const target = path
      .relative(ROOT, path.resolve(ROOT, fileDir, specifier))
      .split(path.sep)
      .join("/");
    return !rule.allowedInternal.some((allowed) => withinAllowed(target, allowed));
  }
  if (specifier.startsWith("node:")) return !rule.allowedBuiltins.includes(specifier);
  return !rule.allowedPackages.includes(packageName(specifier));
}

function violationsFor(module: string): string[] {
  const violations: string[] = [];
  for (const file of sourcesOf(module)) {
    const fileDir = path.relative(ROOT, path.dirname(file));
    for (const specifier of specifiersIn(file)) {
      if (isViolation(module, fileDir, specifier)) {
        violations.push(`${path.relative(ROOT, file)} -> ${specifier}`);
      }
    }
  }
  return violations;
}

describe("module dependency direction (DESIGN §3)", () => {
  const present = MODULES.filter((module) => sourcesOf(module).length > 0);

  it("actually finds modules to inspect", () => {
    expect(present.length).toBeGreaterThan(0);
    expect(sourcesOf("packages/domain").length).toBeGreaterThan(0);
  });

  it("has a rule for every module listed in DESIGN §3", () => {
    expect(MODULES.filter((module) => RULES[module] === undefined)).toEqual([]);
  });

  it.each(present.map((module) => [module]))("%s stays inside its allowed dependencies", (module) => {
    expect(violationsFor(module as string)).toEqual([]);
  });

  it("keeps production modules off tests and infra", () => {
    const offenders: string[] = [];
    for (const module of present) {
      for (const file of sourcesOf(module)) {
        for (const specifier of specifiersIn(file)) {
          if (!specifier.startsWith(".")) continue;
          const target = relativeTarget(file, specifier);
          if (target.startsWith("tests/") || target.startsWith("infra/")) {
            offenders.push(`${path.relative(ROOT, file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("extracts every dependency-carrying import form", () => {
    const sample = [
      'import { a } from "../domain/x.ts";',
      'import type { B } from "../domain/y.ts";',
      'import "../domain/side-effect.ts";',
      'export * from "../domain/w.ts";',
      'const c = await import("node:sqlite");',
      'const d = require("node:child_process");',
    ].join("\n");
    expect(extractSpecifiers(sample).sort()).toEqual(
      [
        "../domain/side-effect.ts",
        "../domain/w.ts",
        "../domain/x.ts",
        "../domain/y.ts",
        "node:child_process",
        "node:sqlite",
      ].sort(),
    );
  });

  it("catches a disallowed dependency and still lets an allowed one through", () => {
    // The allowlist for apps/web is deliberately empty, and the broker may not
    // reach an adapter; both must flag, while the real domain edge must not.
    expect(RULES["apps/web"]?.allowedBuiltins).toEqual([]);
    expect(isViolation("apps/web", "apps/web", "node:sqlite")).toBe(true);
    expect(isViolation("apps/broker", "apps/broker", "../packages/adapters/storage/database.ts")).toBe(
      true,
    );
    expect(isViolation("packages/domain", "packages/domain", "./identity.ts")).toBe(false);
    expect(isViolation("packages/domain", "packages/domain", "node:crypto")).toBe(false);
    expect(isViolation("packages/contracts", "packages/contracts", "zod")).toBe(false);
    expect(isViolation("packages/domain", "packages/domain", "../contracts/jobs.ts")).toBe(true);
  });

  it("scans every TypeScript flavour, not just .ts", () => {
    expect(SOURCE_EXTENSIONS).toContain(".tsx");
    for (const name of ["Page.tsx", "main.ts", "entry.mts", "shim.cts"]) {
      expect(isSourceFile(name)).toBe(true);
    }
    for (const name of ["page.js", "notes.md", "legacy.jsx", "data.json"]) {
      expect(isSourceFile(name)).toBe(false);
    }
  });

  it("only honours allowlist entries at directory boundaries", () => {
    // `packages/domain-adapter` shares a string prefix with `packages/domain`
    // but is a different module and must flag.
    expect(isViolation("packages/domain", "packages/domain", "../domain-adapter/x.ts")).toBe(true);
    expect(isViolation("packages/contracts", "packages/contracts", "../domainx/y.ts")).toBe(true);
    expect(withinAllowed("packages/domain/identity.ts", "packages/domain")).toBe(true);
    expect(withinAllowed("packages/domain", "packages/domain")).toBe(true);
    expect(withinAllowed("packages/domain-adapter/x.ts", "packages/domain")).toBe(false);
    expect(withinAllowed("packages/adapters/storage/database.ts", "packages/")).toBe(true);
  });
});

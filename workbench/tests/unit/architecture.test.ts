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
    allowedInternal: ["packages/", "apps/broker"],
    allowedPackages: [],
    allowedBuiltins: ["node:child_process", "node:net", "node:fs", "node:path", "node:crypto"],
  },
};

const IMPORT_FROM = /from\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /import\(\s*["']([^"']+)["']\s*\)/g;

function sourcesOf(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) return [];
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const full = path.join(absolute, entry.name);
    if (entry.isDirectory()) found.push(...sourcesOf(path.join(dir, entry.name)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

function specifiersIn(file: string): string[] {
  const content = readFileSync(file, "utf8");
  const found = new Set<string>();
  for (const pattern of [IMPORT_FROM, DYNAMIC_IMPORT]) {
    for (const match of content.matchAll(pattern)) found.add(match[1] as string);
  }
  return [...found];
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

function violationsFor(module: string): string[] {
  const rule = RULES[module] as Rule;
  const violations: string[] = [];
  for (const file of sourcesOf(module)) {
    for (const specifier of specifiersIn(file)) {
      const display = `${path.relative(ROOT, file)} -> ${specifier}`;
      if (specifier.startsWith(".")) {
        const target = relativeTarget(file, specifier);
        if (!rule.allowedInternal.some((allowed) => target.startsWith(allowed))) {
          violations.push(display);
        }
        continue;
      }
      if (specifier.startsWith("node:")) {
        if (!rule.allowedBuiltins.includes(specifier)) violations.push(display);
        continue;
      }
      if (!rule.allowedPackages.includes(packageName(specifier))) violations.push(display);
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
});

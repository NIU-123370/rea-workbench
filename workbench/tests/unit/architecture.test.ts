import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// DESIGN §3 fixes which module may depend on which. Import direction is the
// only way the isolation promises stay checkable without reading every file,
// so it is asserted here rather than left to review.

import { SAFE_DETAIL_KEYS } from "../../packages/contracts/errors.ts";

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

type ClientScope = {
  readonly packages: readonly string[];
  readonly directory: string;
};

type Rule = {
  readonly allowedInternal: readonly string[];
  readonly allowedPackages: readonly string[];
  readonly allowedBuiltins: readonly string[];
  // Packages that exist only inside the browser bundle. They are deliberately not
  // in `allowedPackages`: the same module also holds the server entrypoint and the
  // route handlers, and those must stay loadable by plain `node --experimental-
  // strip-types` with no bundler involved.
  readonly clientOnly?: ClientScope;
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
    // Nothing: the adapter frames the MCP wire itself, so naming the SDK here would be an
    // allowance for a package the dependency tree does not carry. It was listed on the
    // strength of a comment, and the guard below is what caught that.
    allowedPackages: [],
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
      // The offline restore stages a file and swaps it in, and it must wait for the bytes to
      // be on disk before it says so. That is the promise-based `fs`, not the sync form the
      // entrypoint has no reason to reach for.
      "node:fs/promises",
      // The entrypoint has to turn its own `file:` URL into a path to find the installed
      // package beside it. `new URL(...).pathname` is not that conversion - it hands back
      // the percent-encoded form, and a project under a path with a space or a CJK
      // character then silently reads no defaults file at all.
      "node:url",
    ],
  },
  "apps/web": {
    allowedInternal: ["packages/domain", "packages/contracts", "packages/application", "apps/web"],
    allowedPackages: ["next", "react", "react-dom"],
    // DESIGN 3 hands apps/web the HTTP/SSE transport and the private RPC client to
    // the worker, which is exactly these three modules and nothing more: no sqlite,
    // no filesystem, no child process, no zod. The API still may not open a write
    // connection - every command goes through apps/web/worker-client.ts.
    allowedBuiltins: ["node:http", "node:net", "node:path"],
    // The graph canvas is the three-column UI's own widget (S19), and it only exists in
    // the `"use client"` island. The source editor is not installed: nothing in the closed
    // §8 surface can return candidate bytes to display yet, so the shell shows a named
    // empty state instead of mounting an unused 2 MB editor (issue #19's other half).
    clientOnly: {
      packages: ["@xyflow/react"],
      directory: "apps/web/app/client",
    },
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
// Prose is not a dependency. `FROM_CLAUSE` has to span the lines of a real multi-line
// `import { ... } from "./x"`, which means `[^;]*?` walks across newlines - and without this
// strip it also walks across a comment, so a sentence that happened to read
// `export const X = [...]` … `tell "a" from "b"` in a doc comment manufactured a phantom
// dependency and turned a green module red. A gate that can be tripped by prose is a gate
// people learn to distrust, so the text is emptied of comments before any pattern sees it.
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function extractSpecifiers(text: string): string[] {
  const found = new Set<string>();
  const code = withoutComments(text);
  for (const pattern of [FROM_CLAUSE, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT, REQUIRE_CALL]) {
    for (const match of code.matchAll(new RegExp(pattern.source, "gm"))) found.add(match[1] as string);
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
  const clientOnly = rule.clientOnly;
  if (clientOnly !== undefined && clientOnly.packages.includes(packageName(specifier))) {
    // Allow the widget library for the island and refuse it everywhere else in the
    // same module, so a route handler cannot quietly become browser-only code.
    return !withinAllowed(fileDir, clientOnly.directory);
  }
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

  it("never reads a dependency out of prose, however import-shaped the sentence is", () => {
    // The real hazard this test exists for: the `from` pattern must span a genuine
    // multi-line `import { ... } from "./x"`, so it walks across newlines. Without the
    // comment strip it also walks across a doc comment, and a sentence that says
    // `tell "too big" from "not found"` after any `export` line manufactures a dependency
    // on a module called "not found" - a green module turned red by wording.
    const prose = [
      "export const SAFE_DETAIL_KEYS = [",
      '  // tell "too big" from "not found",',
      '  "limit",',
      "];",
      "/* and it arrived from \"phantom/module\" somewhere */",
      'const url = "https://example.invalid/path"; // trailing note about "other/x"',
      'import { real } from "../domain/real.ts";',
    ].join("\n");
    expect(extractSpecifiers(prose)).toEqual(["../domain/real.ts"]);
  });

  it("reads a side-effect import but never a string that merely ends in the word", () => {
    // The scanner is only trustworthy if tightening it kept the real form: a
    // space-less `import"x"` is legal JavaScript and must still be seen...
    expect(extractSpecifiers('import"./domain/real.ts";').sort()).toEqual(["./domain/real.ts"]);
    // ...while a verbatim upstream enum member and an audit resource type are
    // data, not dependencies.
    const data = ['const kinds = ["managed-pinvoke-import", "unknown"];', 'resourceType: "import",'].join(
      "\n",
    );
    expect(extractSpecifiers(data)).toEqual([]);
  });

  it("catches a disallowed dependency and still lets an allowed one through", () => {
    // apps/web is limited to the transport modules DESIGN 3 names for it; anything
    // heavier still flags, and the broker may not reach an adapter at all.
    expect(RULES["apps/web"]?.allowedBuiltins).toEqual(["node:http", "node:net", "node:path"]);
    expect(isViolation("apps/web", "apps/web", "node:http")).toBe(false);
    expect(isViolation("apps/web", "apps/web", "node:sqlite")).toBe(true);
    expect(isViolation("apps/web", "apps/web", "node:child_process")).toBe(true);
    expect(isViolation("apps/web", "apps/web", "node:fs")).toBe(true);
    expect(isViolation("apps/web", "apps/web", "../../packages/adapters/storage/writer.ts")).toBe(true);
    expect(isViolation("apps/broker", "apps/broker", "../packages/adapters/storage/database.ts")).toBe(
      true,
    );
    expect(isViolation("packages/domain", "packages/domain", "./identity.ts")).toBe(false);
    expect(isViolation("packages/domain", "packages/domain", "node:crypto")).toBe(false);
    expect(isViolation("packages/contracts", "packages/contracts", "zod")).toBe(false);
    expect(isViolation("packages/domain", "packages/domain", "../contracts/jobs.ts")).toBe(true);
  });

  it("keeps the browser-only widgets inside the client island", () => {
    // The island may import them...
    expect(isViolation("apps/web", "apps/web/app/client", "@xyflow/react")).toBe(false);
    // ...and the server half of the same module may not, even though `next`,
    // `react` and `react-dom` are allowed there.
    expect(isViolation("apps/web", "apps/web", "@xyflow/react")).toBe(true);
    expect(isViolation("apps/web", "apps/web/app/api/v1/[...path]", "@xyflow/react")).toBe(true);
    // A widget the island does not use is not permitted by its absence: the scope list is
    // the whole allowance.
    expect(isViolation("apps/web", "apps/web/app/client", "@monaco-editor/react")).toBe(true);
    expect(isViolation("apps/web", "apps/web/app/project/[projectId]", "@xyflow/react")).toBe(true);
    // A sibling package of an allowed widget is still unknown and still flags.
    expect(isViolation("apps/web", "apps/web/app/client", "@xyflow/system")).toBe(true);
    expect(isViolation("apps/web", "apps/web/app/client", "zustand")).toBe(true);
    // The rule must not leak into a module that declared no client scope.
    expect(RULES["apps/worker"]?.clientOnly).toBeUndefined();
    expect(isViolation("apps/worker", "apps/worker", "@xyflow/react")).toBe(true);
  });

  it("only permits packages the project actually declares", () => {
    // An allowlist entry for a package that is not in the dependency tree is a trap: it
    // looks enforced and silently permits an import that then fails to resolve at build
    // time (which is exactly how the editor dependency would have rotted).
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    const permitted: string[] = [];
    for (const rule of Object.values(RULES)) {
      permitted.push(...rule.allowedPackages, ...(rule.clientOnly?.packages ?? []));
    }
    expect([...new Set(permitted)].filter((name) => !declared.has(name))).toEqual([]);
    expect(declared.has("next")).toBe(true);
    expect(declared.has("@xyflow/react")).toBe(true);
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

// --- What the refusal-details allowlist is allowed to name (§12.1 / issue #59) ---------
//
// A permission list nobody can trace back to a real refusal is a list nobody can check: it
// grows one speculative key at a time and each entry then reads as if something produced it.
// So the gate reads the source for the keys control-plane refusals actually hand to the RPC
// boundary, and refuses to let the contract declare one that no refusal emits. The scan is
// deliberately narrow - only a literal object in the details position of `gateFail` or
// `blockedByReasons` counts, so a service that publishes through a computed object is not
// silently counted, and a name mentioned in prose is not counted either.
// Refusals are found by name: `gateFail`, the helper every service builds one with, and the local
// `fail` alias vector-service uses for the same shape. A helper named something else is not seen,
// and the direction that mistake goes is loud rather than quiet - the key it publishes then reads
// as unproduced and the gate below turns red until someone adds the name.
const REFUSAL_CALL = /\b(?:gateFail|fail)\s*\(/g;

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const character of text) {
    if (quote !== "") {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

// The closing paren of one call, found by balancing from its opening one.
function argumentsOf(code: string, open: number): string[] {
  let depth = 0;
  let quote = "";
  for (let index = open; index < code.length; index += 1) {
    const character = code[index] as string;
    if (quote !== "") {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character !== ")") continue;
    depth -= 1;
    if (depth === 0) return splitTopLevel(code.slice(open + 1, index));
  }
  return [];
}

function keysInDetails(call: string): string[] {
  const open = call.indexOf("(");
  if (open < 0) return [];
  // A multi-line call ends in a trailing comma, which leaves an empty slot; the details
  // argument is the last one that is actually there.
  const args = argumentsOf(call, open).filter((argument) => argument.trim() !== "");
  const details = args[args.length - 1];
  if (details === undefined) return [];
  const trimmed = details.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  const keys: string[] = [];
  for (const pair of splitTopLevel(trimmed.slice(1, -1))) {
    const entry = pair.trim();
    // `{ maxLimit: VECTOR_PAGE_MAX_LIMIT }` names its key; `{ pinnedRevision }` names it too,
    // and that shorthand form is what a service publishes when the value is already a local.
    const quoted = /^\s*"?([A-Za-z][A-Za-z0-9]*)"?\s*:/.exec(entry);
    const name = quoted !== null ? quoted[1] : (/^[A-Za-z][A-Za-z0-9_]*$/.test(entry) ? entry : undefined);
    if (name !== undefined) keys.push(name);
  }
  return keys;
}

function emittedRefusalKeys(dirs: string[]): Set<string> {
  const keys = new Set<string>();
  for (const dir of dirs) {
    for (const file of sourcesOf(dir)) {
      const code = withoutComments(readFileSync(file, "utf8"));
      for (const match of code.matchAll(REFUSAL_CALL)) {
        for (const key of keysInDetails(code.slice(match.index ?? 0))) keys.add(key);
      }
    }
  }
  return keys;
}

const REFUSAL_SOURCE_DIRS = ["packages/application", "packages/adapters", "apps/worker"];

describe("the refusal-details allowlist (DESIGN §12.1)", () => {
  const emitted = emittedRefusalKeys(REFUSAL_SOURCE_DIRS);

  it("reads a details object and nothing that merely looks like one", () => {
    // The gate is only as good as this reader, so both directions are pinned on fixtures:
    // top-level keys only (a nested `seq` is not a published fact), a call without details
    // contributes nothing, and a details argument that is a variable is not counted.
    expect(keysInDetails('gateFail("A", "r", "m", { limit: 1, nested: { seq: 2 } })')).toEqual(["limit", "nested"]);
    expect(keysInDetails('gateFail("A", "r", "m")')).toEqual([]);
    expect(keysInDetails("blockedByReasons(x, \"A\", \"m\", computedDetails)")).toEqual([]);
    expect(keysInDetails('gateFail("A", "r", "m", { "quoted": 1 })')).toEqual(["quoted"]);
    expect(keysInDetails('gateFail("A", "r", "m", { pinnedRevision, currentRevision: 7 })')).toEqual(["pinnedRevision", "currentRevision"]);
    expect(keysInDetails('gateFail("A", "r", "text with { fakeKey: 1 } inside", { actual: 2 })')).toEqual(["actual"]);
    expect(keysInDetails('gateFail(\n  "A",\n  "r",\n  "m",\n  { expected: 4, actual: 6 },\n)')).toEqual(["expected", "actual"]);
  });

  it("scans the directories that own a refusal", () => {
    // A scan that found nothing would pass the claim below vacuously, so the two keys the
    // size-and-page refusals publish are asserted here by name.
    expect(emitted.has("byteLength")).toBe(true);
    expect(emitted.has("maxAttempts")).toBe(true);
    expect(emitted.has("reasonCount")).toBe(true);
  });

  it("declares no key that no refusal in this repository publishes", () => {
    expect([...SAFE_DETAIL_KEYS].filter((key) => !emitted.has(key))).toEqual([]);
  });
});

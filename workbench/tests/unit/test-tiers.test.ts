import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import e2eConfig from "../../vitest.e2e.config.ts";
import integrationConfig from "../../vitest.integration.config.ts";
import unitConfig from "../../vitest.unit.config.ts";

// #123's third and fourth boxes split the test tiers apart. A split has exactly one failure mode that
// matters: a test file no tier claims, or a tier nothing runs. Both look like a green suite from the
// inside, so the split is guarded rather than trusted.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

type TierConfig = typeof unitConfig;

// Each config declares one include pattern of the documented shape, so a tier's membership is decided
// by its directory. Anything else - several patterns, a different glob, a pattern reaching outside
// `tests/` - is refused here instead of guessed at, because a guard that mis-reads a config still
// reports "every file is claimed".
function tierDirectory(name: string, config: TierConfig): string {
  const patterns = config.test?.include ?? [];
  if (patterns.length !== 1) {
    throw new Error(`${name}: expected exactly one include pattern, got ${String(patterns.length)} (${patterns.join(", ")})`);
  }
  const pattern = String(patterns[0]);
  const directory = /^((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+)\/\*\*\/\*\.test\.ts$/u.exec(pattern)?.[1];
  if (directory === undefined || !directory.startsWith("tests/")) {
    throw new Error(`${name}: include pattern ${pattern} is not "<dir>/**/*.test.ts" with <dir> inside tests/`);
  }
  return directory;
}

const TIERS: readonly { name: string; script: string; directory: string }[] = [
  { name: "unit", script: "test:unit", directory: tierDirectory("unit", unitConfig) },
  { name: "integration", script: "test:integration", directory: tierDirectory("integration", integrationConfig) },
  { name: "e2e", script: "test:e2e", directory: tierDirectory("e2e", e2eConfig) },
];

function testFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(full);
  }
  return found.sort();
}

function workflowText(): string {
  const dir = path.join(ROOT, "..", ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
}

function readmeTable(): string {
  return readFileSync(path.join(ROOT, "README.md"), "utf8");
}

function scripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts ?? {};
}

describe("the test tiers are a partition, not a list of directories", () => {
  it("claims every test file under tests/ exactly once", () => {
    const ownersOf = (file: string): string[] =>
      TIERS.filter((tier) => file.startsWith(`${tier.directory}/`)).map((tier) => tier.name);
    const orphans: string[] = [];
    const doubled: string[] = [];
    for (const file of testFiles("tests")) {
      const owners = ownersOf(file);
      if (owners.length === 0) orphans.push(file);
      if (owners.length > 1) doubled.push(`${file} -> ${owners.join(", ")}`);
    }
    // Both lists are named in the message because either one alone would still read as a pass: an
    // unclaimed file is run by nobody, and a file claimed twice runs under two tier names.
    expect(orphans, `test files no tier runs: ${orphans.join(", ")}`).toEqual([]);
    expect(doubled, `test files claimed by more than one tier: ${doubled.join(", ")}`).toEqual([]);
  });

  it("has at least one test file behind every tier it names", () => {
    // An empty tier passes trivially, which is how "we have an e2e tier" could outlive the deletion
    // of the only file in it.
    for (const tier of TIERS) {
      expect(
        testFiles(tier.directory).length,
        `${tier.name} claims ${tier.directory} but it holds no test file`,
      ).toBeGreaterThan(0);
    }
  });

  it("runs each tier in CI, or says in the README's table why it does not", () => {
    const workflows = workflowText();
    const readme = readmeTable();
    for (const tier of TIERS) {
      expect(scripts()[tier.script], `package.json has no ${tier.script} script`).toBeTruthy();
      if (workflows.includes(`npm run ${tier.script}`)) continue;
      const row = readme.split("\n").find((line) => line.startsWith(`| \`npm run ${tier.script}\``));
      expect(row, `no CI workflow runs \`npm run ${tier.script}\`, and the README has no row for it`).toBeDefined();
      // The reason has to sit in the table's last cell (the "在 CI 里" column): a sentence somewhere
      // else in a 2200-line file is not something a reader of that table will find.
      const cell = String(row).split("|").at(-2)?.trim() ?? "";
      expect(cell, `${tier.script} is not run by CI and its README row does not say so`).toContain("不进 CI");
    }
  });

  it("keeps the local aggregate running every tier", () => {
    // CI names the tiers it runs; `npm run test` is what a person types. Dropping a tier from the
    // aggregate would leave it reachable only by a command line nobody remembers.
    const aggregate = scripts().test ?? "";
    for (const tier of TIERS) expect(aggregate, `npm run test does not run ${tier.script}`).toContain(`npm run ${tier.script}`);
  });
});

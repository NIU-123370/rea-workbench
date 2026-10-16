import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RULES, scanSource, summarize } from "../../infra/review/rules.mjs";

// The bot is only useful if two things hold: every rule actually fires on the
// code shape it claims, and the repository itself is clean. Both are asserted
// here, with fixtures that a mutation of either the rule or the tree would break.

function findingsFor(file: string, text: string): string[] {
  return scanSource(file, text).map((finding) => finding.rule);
}

describe("rule table", () => {
  it("every rule has a severity, a document anchor and a fix hint", () => {
    expect(RULES.length).toBeGreaterThanOrEqual(7);
    for (const rule of RULES) {
      expect(["P1", "P2"]).toContain(rule.severity);
      expect(rule.anchor).toMatch(/§|TESTPLAN/);
      expect(rule.hint.length).toBeGreaterThan(10);
    }
  });
});

describe("R1 zod strictness (DESIGN §4 §8)", () => {
  it("fires on the loose builders and stays quiet on the strict ones", () => {
    expect(findingsFor("packages/contracts/x.ts", "const s = z.object({ a: z.string() });")).toContain("R1");
    expect(findingsFor("packages/contracts/x.ts", "const s = z.loosedObject({ a: z.string() });")).toContain("R1");
    expect(findingsFor("packages/contracts/x.ts", "const s = z.strictObject({ a: z.string() });")).not.toContain("R1");
    expect(findingsFor("packages/contracts/x.ts", "const s = z.discriminatedUnion('k', [a, b]);")).not.toContain("R1");
  });

  it("only applies to production modules, not to test fixtures", () => {
    expect(findingsFor("tests/unit/y.test.ts", 'const sample = "z.object({ a: 1 })";')).not.toContain("R1");
  });
});

describe("R2 raw console (DESIGN §12.1)", () => {
  it("fires on every console channel in production code", () => {
    for (const channel of ["log", "info", "warn", "error", "debug"]) {
      expect(findingsFor(`packages/application/${channel}.ts`, `console.${channel}("x");`)).toContain("R2");
    }
    expect(findingsFor("packages/application/a.ts", 'process.stdout.write("x\\n");')).not.toContain("R2");
  });
});

describe("R3 predictable identifiers (DESIGN §4 §14)", () => {
  it("fires on Math.random and not on crypto", () => {
    expect(findingsFor("packages/domain/a.ts", "const id = Math.random().toString(36);")).toContain("R3");
    expect(findingsFor("packages/domain/a.ts", "const id = randomUUID();")).not.toContain("R3");
  });
});

describe("R4 any (DESIGN §4)", () => {
  it("fires on each spelling of any", () => {
    for (const line of [
      "const value: any = input;",
      "const value = input as any;",
      "function f(input: Array<any>) {}",
      "const list: any[] = [];",
    ]) {
      expect(findingsFor("packages/application/a.ts", line), line).toContain("R4");
    }
    expect(findingsFor("packages/application/a.ts", "const value: JsonValue = input;")).not.toContain("R4");
    expect(findingsFor("packages/application/a.ts", "const value: unknown = input;")).not.toContain("R4");
  });
});

describe("R5 suppressed type errors (DESIGN §13)", () => {
  it("flags both directives as advisory", () => {
    expect(findingsFor("packages/domain/a.ts", "// @ts-ignore handled elsewhere")).toContain("R5");
    expect(findingsFor("packages/domain/a.ts", "// @ts-expect-error no declaration")).toContain("R5");
    expect(findingsFor("packages/domain/a.ts", "// a plain comment")).not.toContain("R5");
  });

  it("honours an explicit in-line exception marker", () => {
    const ignored = "// @ts-ignore review-bot-ignore R5 (upstream has no declaration)";
    expect(findingsFor("packages/domain/a.ts", ignored)).not.toContain("R5");
  });
});

describe("R6/R7 test suite integrity (TESTPLAN §6)", () => {
  // Built by concatenation so this file does not itself contain the shapes the
  // rules look for.
  const focused = ["it", ".only", "('slow', async () => {})"].join("");
  const skipped = ["describe", ".skip", "('later', () => {})"].join("");

  it("fires on a focused test, which would shrink the release gate to one case", () => {
    expect(findingsFor("tests/unit/a.test.ts", `${focused}`)).toContain("R6");
  });

  it("fires on a skipped suite as advisory and only inside tests", () => {
    expect(findingsFor("tests/unit/a.test.ts", `${skipped}`)).toContain("R7");
    expect(findingsFor("packages/application/a.ts", `${skipped}`)).not.toContain("R7");
  });

  it("stays quiet on ordinary cases", () => {
    expect(findingsFor("tests/unit/a.test.ts", "it('parses', () => {});")).not.toContain("R6");
    expect(findingsFor("tests/unit/a.test.ts", "it.each(rows)('%s', () => {});")).not.toContain("R6");
  });
});

describe("summary", () => {
  it("counts severities and reports blocking separately", () => {
    const findings = scanSource(
      "packages/domain/a.ts",
      "const s = z.object({});\n// @ts-ignore x\nconst v: any = 1;\n",
    );
    const summary = summarize(findings);
    expect(summary.P1).toBe(2);
    expect(summary.P2).toBe(1);
    expect(summary.total).toBe(3);
    expect(summary.blocking).toBe(summary.P1);
  });
});

describe("the repository passes its own review bot", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));

  it("scans a non-trivial number of files and finds nothing", () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "rea-review-")), "findings.json");
    execFileSync(process.execPath, ["infra/review/scan.mjs", "--json", out], { cwd: root });
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      scannedFiles: number;
      summary: { total: number; P1: number };
    };
    expect(report.scannedFiles).toBeGreaterThan(20);
    expect(report.summary).toEqual({ total: 0, P1: 0, P2: 0, blocking: 0 });
  });

  it("creates the report directory instead of assuming it exists", () => {
    // A clean CI checkout has no `.review/`, and assuming it did turned a crashed
    // scan into a green check once already.
    const scratch = mkdtempSync(path.join(tmpdir(), "rea-review-dir-"));
    const target = path.join(scratch, "deep", "nested", "findings.json");
    execFileSync(process.execPath, ["infra/review/scan.mjs", "--json", target], { cwd: root });
    const report = JSON.parse(readFileSync(target, "utf8")) as { scannedFiles: number };
    expect(report.scannedFiles).toBeGreaterThan(0);
  });

  it("exits non-zero when a P1 is present", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "rea-review-bad-"));
    mkdirSync(path.join(scratch, "packages/domain"), { recursive: true });
    writeFileSync(path.join(scratch, "packages/domain/bad.ts"), "const s = z.object({ a: 1 });\n", { flag: "w" });
    expect(() =>
      execFileSync(process.execPath, ["infra/review/scan.mjs", "--files", "packages/domain/bad.ts"], {
        cwd: scratch,
        stdio: "pipe",
      }),
    ).toThrow();
  });
});

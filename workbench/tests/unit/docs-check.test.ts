import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkDocs,
  parseAcceptanceRows,
  parseTestCaseRows,
  reconcile,
} from "../../infra/release/docs-check.mjs";

// The release gate that keeps the two documents honest with each other (TESTPLAN §6 /
// PRD A01-A13, issue #23). Fixtures are shaped like the real tables, because a checker
// that only matches a form the documents no longer use reads as a pass while testing
// nothing.

const PRD = `
| 编号           | 可验证标准 |
| -------------- | ---------- |
${Array.from({ length: 13 }, (_, index) => `| A${String(index + 1).padStart(2, "0")} 名称 | 标准 |`).join("\n")}
`;

function testplan(cases: [string, string][]) {
  const rows = cases.map(([id, accepts]) => `| ${id}  | ${accepts} | 场景 | 断言 |`).join("\n");
  return `## 3. 验收用例矩阵\n\n| 用例 | 对应验收 | 层次与场景 | 必须成立的断言 |\n| ---- | -------- | ---------- | -------------- |\n${rows}\n\n## 4. 别的标题\n`;
}

const ALL_CASES: [string, string][] = Array.from({ length: 17 }, (_, index) => [
  `T${String(index + 1).padStart(2, "0")}`,
  `A${String((index % 13) + 1).padStart(2, "0")}`,
]);

describe("the matrix reconciles with the acceptance table", () => {
  it("accepts a complete, unique, fully covered matrix", () => {
    expect(checkDocs(testplan(ALL_CASES), PRD)).toEqual([]);
  });

  it("parses a row that names several criteria and ignores a later section", () => {
    const rows = parseTestCaseRows(testplan([["T01", "A01、A03、A06"], ["T02", "A02 名称"]]));
    expect(rows).toEqual([
      { case: "T01", accepts: ["A01", "A03", "A06"] },
      { case: "T02", accepts: ["A02"] },
    ]);
    expect(parseAcceptanceRows(PRD)).toHaveLength(13);
  });

  it("names a hole, a duplicate and an out-of-range case", () => {
    const missing = testplan(ALL_CASES.slice(0, 16));
    expect(checkDocs(missing, PRD)).toContain("test-case-missing:T17");
    const doubled = testplan([...ALL_CASES, ["T05", "A05"]]);
    expect(checkDocs(doubled, PRD)).toContain("duplicate-test-case:T05");
    const beyond = testplan([...ALL_CASES, ["T18", "A01"]]);
    expect(checkDocs(beyond, PRD)).toContain("test-case-out-of-range:T18");
  });

  it("refuses to let a criterion go untested or a test name one that does not exist", () => {
    // Every case points at A01: twelve criteria are then claimed by nobody.
    const uncovered = testplan(ALL_CASES.map(([id]) => [id, "A01"]));
    const reasons = checkDocs(uncovered, PRD);
    expect(reasons).toContain("acceptance-untested:A02");
    expect(reasons).toContain("acceptance-untested:A13");
    expect(reasons.filter((reason) => reason.startsWith("acceptance-untested:"))).toHaveLength(12);

    const invented = testplan(ALL_CASES.map(([id], index) => [id, index === 0 ? "A14" : `A${String((index % 13) + 1).padStart(2, "0")}`]));
    expect(checkDocs(invented, PRD)).toContain("acceptance-not-declared:A14(T01)");
  });

  it("refuses a case with no acceptance id and an unreadable table", () => {
    expect(checkDocs(testplan([["T01", "没有编号"]]), PRD)).toContain("test-case-without-acceptance:T01");
    expect(checkDocs("什么表格都没有", PRD)).toEqual(["testplan-matrix-unreadable:no T## rows matched"]);
    expect(checkDocs(testplan(ALL_CASES), "| 编号 | 标准 |\n")).toEqual(["prd-acceptance-table-unreadable:no A## rows matched"]);
  });

  it("reconciles an explicit range so the checker itself can be tested at the edges", () => {
    const reasons = reconcile({
      testCases: [{ case: "T02", accepts: ["A01"] }],
      accepts: ["A01"],
      firstCase: "T01",
      lastCase: "T02",
    });
    expect(reasons).toEqual(["test-case-missing:T01"]);
  });
});

describe("the committed documents pass the gate they describe", () => {
  it("npm run docs:check exits clean against docs/PRD.md and docs/TESTPLAN.md", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const output = execFileSync(process.execPath, ["infra/release/docs-check.mjs"], { cwd: root, encoding: "utf8" });
    expect(path.basename(root)).toBe("workbench");
    // 17 cases and 13 criteria is what the documents declare today; a different count means
    // the checker stopped reading a table, not that the project changed.
    expect(output).toContain("用例 17 条 / 验收 13 条");
    expect(output).not.toContain("- acceptance-");
    expect(output).not.toContain("- test-case-");
  });
});

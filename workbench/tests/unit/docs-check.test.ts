import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkDocs,
  checkSectionAnchors,
  checkSourceReferences,
  findIdReferences,
  findSectionAnchors,
  parseAcceptanceRows,
  parseDecisionRows,
  parseDesignSections,
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
    const beyond = testplan([...ALL_CASES, ["T18", "A01"]]); // docs-check-ignore: names the invented case the reason below is about
    expect(checkDocs(beyond, PRD)).toContain("test-case-out-of-range:T18"); // docs-check-ignore: ditto
  });

  it("refuses to let a criterion go untested or a test name one that does not exist", () => {
    // Every case points at A01: twelve criteria are then claimed by nobody.
    const uncovered = testplan(ALL_CASES.map(([id]) => [id, "A01"]));
    const reasons = checkDocs(uncovered, PRD);
    expect(reasons).toContain("acceptance-untested:A02");
    expect(reasons).toContain("acceptance-untested:A13");
    expect(reasons.filter((reason) => reason.startsWith("acceptance-untested:"))).toHaveLength(12);

    const invented = testplan(ALL_CASES.map(([id], index) => [id, index === 0 ? "A14" : `A${String((index % 13) + 1).padStart(2, "0")}`])); // docs-check-ignore: A14 is the invented criterion this case asserts is refused
    expect(checkDocs(invented, PRD)).toContain("acceptance-not-declared:A14(T01)"); // docs-check-ignore: ditto
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

describe("the decision list is read from the document that owns it", () => {
  it("reads decisions as the bullets DECISIONS.md writes, not as a table", () => {
    const markdown = "# 技术决策记录\n\n- D01｜选了：甲；为什么：乙\n- D02｜选了：丙\n\n段落里那条形状不同的行不会被读成决策。\n";
    expect(parseDecisionRows(markdown)).toEqual(["D01", "D02"]);
    expect(parseDecisionRows("什么都没有")).toEqual([]);
  });
});

describe("a source file may only name an id the three tables declare", () => {
  const declared = { cases: ["T01", "T16"], accepts: ["A05", "A12"], decisions: ["D05", "D23"] };

  it("reads a citation but not a timestamp, a digest or an identifier", () => {
    const source = [
      `// The offline restore (DESIGN §13 line 453, D23 / PRD A12 / TESTPLAN T16, issue #23).`,
      `const stamp = "2026-10-16T09:00:00.000Z";`,
      `const digest = "sha512-hfhF/FmoQyTUkA0bIKFOtw536BQSeBMe6BF6QyWlrPxT754+TFLaZ7sKKTfvvM0yJgKgaYTwnFCIZ/GuDw5SUA==";`,
      `export const T17Record = "T17Record";`,
      `const advisory = "until TESTPLAN T07/T14 isolation acceptance has run";`,
    ].join("\n");
    const refs = findIdReferences("apps/worker/restore.ts", source).map((ref) => `${ref.ref}@${String(ref.line)}`);
    expect(refs).toEqual(["D23@1", "A12@1", "T16@1", "T07@5", "T14@5"]);
  });

  it("honours an inline opt-out so a fixture can name the id it refuses", () => {
    expect(findIdReferences("tests/unit/a.test.ts", `const invented = "A14"; // docs-check-ignore: this case asserts A14 is refused`)).toEqual([]);
  });

  // One id per family that no table declares, as named constants carrying the opt-out marker,
  // so an invented id appears at one marked site instead of on every assertion line.
  const inventedCase = "T19"; // docs-check-ignore: the fixture is about refusing an undeclared case id
  const inventedAcceptance = "A16"; // docs-check-ignore: ditto, acceptance family
  const otherInventedCase = "T40"; // docs-check-ignore: ditto
  const inventedDecision = "D33"; // docs-check-ignore: ditto, decision family (DECISIONS ends at D32)

  it("names the site of a reference the tables do not declare, by family", () => {
    const refs = findIdReferences("packages/contracts/sandbox.ts", `const advisory = "until ${inventedCase} isolation acceptance has run";`);
    expect(refs.map((ref) => ref.ref)).toEqual([inventedCase]);
    expect(checkSourceReferences(refs, declared)).toEqual([
      `test-case-ref-undeclared:${inventedCase}(packages/contracts/sandbox.ts:1)`,
    ]);
    expect(checkSourceReferences(refs, { ...declared, cases: [...declared.cases, inventedCase] })).toEqual([]);

    const every = findIdReferences("apps/worker/restore.ts", `// PRD ${inventedAcceptance}, TESTPLAN ${otherInventedCase}, DECISIONS ${inventedDecision}`);
    expect(checkSourceReferences(every, declared)).toEqual([
      `acceptance-ref-undeclared:${inventedAcceptance}(apps/worker/restore.ts:1)`,
      `test-case-ref-undeclared:${otherInventedCase}(apps/worker/restore.ts:1)`,
      `decision-ref-undeclared:${inventedDecision}(apps/worker/restore.ts:1)`,
    ]);

    // All three tables are consulted. A checker that read only the case list still passes the
    // assertions above, because that fixture holds no accepted id of the other two families —
    // the mutation that taught me that was killed only by the tree-level case, so the claim
    // gets named per family here too.
    expect(checkSourceReferences(findIdReferences("f.ts", "// A05 and T01 and D05"), declared)).toEqual([]);
  });
});

describe("a section citation has to land in the section it names", () => {
  const sections = [
    { section: "5", start: 97, end: 127 },
    { section: "8", start: 223, end: 321 },
    { section: "12", start: 423, end: 450 },
  ];
  const at = (section: string, from: number | null, to: number | null = null, line = 1) =>
    [{ section, from, to: to ?? from, file: "f.ts", line }];

  it("splits DESIGN.md at its `## N.` headings and runs the last section to the end", () => {
    const markdown = ["## 1. 甲", "正文", "## 2. 乙", "正文", "正文"].join("\n");
    expect(parseDesignSections(markdown)).toEqual([
      { section: "1", start: 1, end: 2 },
      { section: "2", start: 3, end: 5 },
    ]);
    expect(parseDesignSections("没有编号标题")).toEqual([]);
  });

  it("reads a pair, a range, and the line number that fell off the end of the comment", () => {
    const text = ["// DESIGN §13 line 453", "// (§8 lines 278-279, §11)", "// exactly §8 line", "// 272's two, and the narrowing"].join("\n");
    expect(findSectionAnchors("f.ts", text)).toEqual([
      { section: "13", from: 453, to: 453, file: "f.ts", line: 1 },
      { section: "8", from: 278, to: 279, file: "f.ts", line: 2 },
      { section: "8", from: null, to: null, file: "f.ts", line: 3 },
    ]);
  });

  it("refuses the citation whose line lives in another section, and names both ranges", () => {
    expect(checkSectionAnchors(at("5", 425), sections, 482)).toEqual([
      "design-anchor-outside-section:§5 line 425(f.ts:1) 该节是 97-127，而行号 425 属于 §12 423-450", // docs-check-ignore: the refusal text necessarily carries the mis-paired anchor
    ]);
  });

  it("names a wrapped pair, an unknown section and an off-the-end line as three different faults", () => {
    expect(checkSectionAnchors(at("8", null), sections, 482)).toEqual([
      "design-anchor-wrapped:§8 line(f.ts:1) 行号掉到下一行，这一对读不出来源",
    ]);
    expect(checkSectionAnchors(at("99", 10), sections, 482)).toEqual([
      "design-section-unknown:§99 line 10(f.ts:1) DESIGN.md 没有这一节", // docs-check-ignore: names the section that does not exist
    ]);
    expect(checkSectionAnchors(at("12", 900), sections, 482)).toEqual([
      "design-anchor-past-end:§12 line 900(f.ts:1) DESIGN.md 共 482 行", // docs-check-ignore: names the line past the document end
    ]);
  });

  it("says nothing about a pair that is inside its section, a range included", () => {
    expect(checkSectionAnchors(at("8", 278, 279), sections, 482)).toEqual([]);
    expect(checkSectionAnchors(at("5", 97), sections, 482)).toEqual([]);
    // The section's own heading line is inside it, so citing the heading is legal.
    expect(checkSectionAnchors(at("12", 423), sections, 482)).toEqual([]);
  });

  it("catches the range whose tail leaves the section it names", () => {
    // Only the front number is inside §8 (223-321); 430 is §12. A checker that compared the
    // start alone would call this a good citation, and `lines 310-430` reads as one claim.
    expect(checkSectionAnchors(at("8", 310, 430), sections, 482)).toEqual([
      "design-anchor-outside-section:§8 line 310-430(f.ts:1) 该节是 223-321，而行号 430 属于 §12 423-450", // docs-check-ignore: names the offending range on purpose
    ]);
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
    expect(output).toContain("决策 32 条");
    expect(output).not.toContain("- acceptance-");
    expect(output).not.toContain("- test-case-");
    expect(output).not.toContain("- decision-");
    expect(output).not.toContain("decisions-table-unreadable");
    expect(output).not.toContain("source-root-missing");
    // The scan size is part of the contract: a walk that read nothing (renamed root, wrong
    // root directory) prints an otherwise identical clean line, so the count is pinned to a
    // floor well below today's 119 references over 199 files rather than to the number itself.
    expect(output).toMatch(/源码引用 \d{3,} 处（\d{3,} 个文件）/);
    // The citation surface is reported the same way: today 376 anchors against 14 sections, and
    // a reader of this line can tell "nothing is wrong" from "nothing was read".
    expect(output).toMatch(/设计锚点 \d{3,} 处（DESIGN \d{2} 节）/);
    expect(output).not.toContain("- design-");
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  canonicalRoute,
  checkDocs,
  checkRoutes,
  checkSectionAnchors,
  checkSourceReferences,
  findIdReferences,
  findSectionAnchors,
  parseAcceptanceRows,
  parseDecisionRows,
  parseDesignRoutes,
  parseDesignSections,
  parseMountedRoutes,
  parseTestCaseRows,
  reconcile,
  ROUTE_DEVIATIONS,
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

describe("§8's route table is reconciled with the doors the web adapter mounts", () => {
  // Shaped like the real document: a backticked first cell in three tables, only one of which is
  // §8, and a `METHOD /path` row sitting in a section that is not §8. A parser that read every
  // such row would turn §3's module table or §7's field table into promised endpoints. The head is
  // nine lines, so §8's first row is line 10 and a reason can name the line it came from.
  const HEAD = [
    "## 7. 模块与字段",
    "",
    "| `packages/domain` | 语义 | 依赖 |",
    "| `POST /not-a-promise` | 这一行不是路由 |",
    "",
    "## 8. API 契约",
    "",
    "| 路由 | 请求 | 响应 |",
    "| ---- | ---- | ---- |",
  ];
  const TAIL = ["", "## 9. 下一节", "| `DELETE /not-a-promise` | 这一行也不算 |"];
  const ROWS = [
    "| `GET /health` | 无；需本地会话 | 200 |",
    "| `POST /projects/:p/jobs` | `{task}` | 202 JobRecord |",
    "| `GET /projects/:p/jobs/:j/preview` | query `frame?:integer` | 200 |",
  ];
  const design = (rows: string[] = ROWS) => [...HEAD, ...rows, ...TAIL].join("\n");
  const designRows = (rows: string[] = ROWS) => {
    const text = design(rows);
    return parseDesignRoutes(text, parseDesignSections(text));
  };

  // The adapter's table as api.ts writes it: one door per line, the prefix interpolated rather
  // than spelled out. Lines 2-5 below are the four doors.
  const door = (method: string, template: string) =>
    `  { method: "${method}", template: \`\${API_PREFIX}${template}\`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },`;
  const api = (extra: string[] = []) =>
    [
      "const ROUTES: readonly RouteSpec[] = [",
      door("GET", "/health"),
      door("POST", "/projects/:projectId/jobs"),
      door("GET", "/projects/:projectId/exports"),
      door("GET", "/comparator-policies"),
      ...extra,
      "];",
    ].join("\n");

  it("reads §8's rows with their line numbers, and nothing from the neighbouring tables", () => {
    expect(designRows()).toEqual([
      { method: "GET", target: "/health", line: 10 },
      { method: "POST", target: "/projects/:p/jobs", line: 11 },
      { method: "GET", target: "/projects/:p/jobs/:j/preview", line: 12 },
    ]);
    // A document with no §8 heading yields no rows, which the caller turns into
    // `design-routes-unreadable` rather than into an empty comparison.
    expect(parseDesignRoutes(HEAD.slice(0, 4).join("\n"), parseDesignSections(HEAD.slice(0, 4).join("\n")))).toEqual([]);
  });

  it("reads the adapter's table by its line shape", () => {
    expect(parseMountedRoutes(api())).toEqual([
      { method: "GET", target: "/health", line: 2 },
      { method: "POST", target: "/projects/:projectId/jobs", line: 3 },
      { method: "GET", target: "/projects/:projectId/exports", line: 4 },
      { method: "GET", target: "/comparator-policies", line: 5 },
    ]);
    // The failure this pins: a door reformatted onto several lines stops being readable here, and
    // since §8 still names it, it reappears as `design-route-unmounted` instead of as a green scan
    // over a shrunken table.
    expect(parseMountedRoutes("const ROUTES: readonly RouteSpec[] = [\n  {\n    method: \"GET\",\n    template: `${API_PREFIX}/health`,\n  },\n];")).toEqual([]);
    expect(parseMountedRoutes("const ROUTES = [];")).toEqual([]);
  });

  it("folds a parameter's name and nothing else", () => {
    expect(canonicalRoute("GET", "/projects/:p/jobs/:j/preview")).toBe(canonicalRoute("GET", "/projects/:projectId/jobs/:jobId/preview"));
    // A parameter never swallows its neighbours: a page and one of its rows are two routes.
    expect(canonicalRoute("GET", "/projects/:p")).not.toBe(canonicalRoute("GET", "/projects/:p/jobs"));
    // Methods distinguish, too.
    expect(canonicalRoute("POST", "/projects/:p")).not.toBe(canonicalRoute("GET", "/projects/:p"));
  });

  it("names an unmet promise and an undeclared door as two different faults", () => {
    expect(checkRoutes(designRows(), parseMountedRoutes(api()), {})).toEqual([
      "design-route-unmounted:GET /projects/:/jobs/:/preview(§8 line 12)", // docs-check-ignore: the fixture §8's own line, not a DESIGN citation
      "mounted-route-unlisted:GET /projects/:/exports(api.ts:4)",
      "mounted-route-unlisted:GET /comparator-policies(api.ts:5)",
    ]);
  });

  it("says nothing when the two sides and the waiver table agree", () => {
    // The three differences this fixture holds are the three the shipped table owns, in the same
    // directions, so this is the waiver table read against a difference set.
    expect(checkRoutes(designRows(), parseMountedRoutes(api()), ROUTE_DEVIATIONS)).toEqual([]);
  });

  it("keeps a waiver that has stopped covering a difference", () => {
    // Both sides now name the exports door: the waiver describes something that is no longer true,
    // and a table of waivers nobody re-reads is how the gate decays back into a one-off count.
    expect(checkRoutes(designRows([...ROWS, "| `GET /projects/:p/exports` | 无 | 201 |"]), parseMountedRoutes(api()), ROUTE_DEVIATIONS)).toEqual([
      `route-deviation-stale:GET /projects/:p/exports(两侧已对上，删掉这条记录) ${ROUTE_DEVIATIONS["GET /projects/:p/exports"]}`,
    ]);
    // A waiver for a route neither side has is stale the same way — the table is not a wishlist.
    expect(checkRoutes(designRows(), parseMountedRoutes(api()), { "GET /gone/:x": "issue #0 — 两侧都没有" })).toContain(
      "route-deviation-stale:GET /gone/:x(两侧都没有这条路由) issue #0 — 两侧都没有",
    );
  });

  it("refuses two waivers that turn out to name the same route", () => {
    // The table is keyed by §8's spelling, so an entry written with the code's parameter name
    // would otherwise sit beside it as a second waiver nobody reads — and the first one would
    // still silence the difference, so the pair is invisible until someone deletes one.
    expect(checkRoutes(designRows(), parseMountedRoutes(api()), {
      "GET /projects/:p/exports": "issue #58 — 第一条",
      "GET /projects/:projectId/exports": "issue #58 — 第二条",
    })).toEqual([
      "route-deviation-duplicate:GET /projects/:projectId/exports 与 GET /projects/:p/exports 是同一条路由",
      "design-route-unmounted:GET /projects/:/jobs/:/preview(§8 line 12)", // docs-check-ignore: the fixture's §8 line numbers, not a DESIGN citation
      "mounted-route-unlisted:GET /comparator-policies(api.ts:5)",
    ]);
  });

  it("catches the same promise written twice", () => {
    // Two §8 rows for one canonical route: the second is a different contract that nobody
    // reconciles with the first, and a checker that keyed by route alone would report whichever
    // row it kept as the unmet promise.
    expect(checkRoutes(designRows([...ROWS, "| `GET /health` | 第二行 | 同一个承诺 |"]), parseMountedRoutes(api()), ROUTE_DEVIATIONS)).toEqual([
      "design-route-duplicate:GET /health(§8 line 10,13)", // docs-check-ignore: the fixture's own line numbers, not a DESIGN citation
    ]);
  });

  it("catches the two doors that a parameter rename folds into one", () => {
    // `matchRoute` answers a collision with whichever entry came first, so the second door is
    // shadowed rather than mounted, and nothing else in the tree notices.
    const collide = ["const ROUTES: readonly RouteSpec[] = [", door("GET", "/projects/:projectId"), door("GET", "/projects/:id"), "];"].join("\n");
    expect(checkRoutes(designRows(["| `GET /projects/:p` | 无 | 200 |"]), parseMountedRoutes(collide), {})).toEqual([
      "mounted-route-duplicate:GET /projects/:(api.ts:2,api.ts:3)",
    ]);
  });

  it("refuses a table it cannot read rather than passing an empty scan", () => {
    expect(checkRoutes([], parseMountedRoutes(api()), {})).toEqual([
      "design-routes-unreadable:§8 没有一行 | `METHOD /path` | 表格，或那一节换了形状",
    ]);
    expect(checkRoutes(designRows(), [], {})).toEqual([
      "mounted-routes-unreadable:apps/web/api.ts 的 ROUTES 一条都没读出来",
    ]);
    expect(checkRoutes([], [], {})).toHaveLength(2);
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
    // The route side: 40 rows is what §8 declares today (issue #58's title counts them), and the
    // mounted side is pinned with a floor because doors keep landing. A printed count that fell to
    // zero would read as a clean line, so the shape of the number is part of the assertion.
    expect(output).toContain("路由 §8 40 条");
    expect(output).toMatch(/· 挂载 4\d 条 ·/);
    expect(output).not.toContain("- design-route-");
    expect(output).not.toContain("- mounted-route-");
    expect(output).not.toContain("- route-deviation-");
    expect(output).not.toContain("- web-api-module-");
  });

  it("names the door nobody documented, on a run no clean tree can fake", () => {
    // The green run above cannot distinguish "the reconciliation found nothing" from "the
    // reconciliation was never called", because the tree is genuinely clean today. `--probe-routes`
    // mounts a door §8 does not name and the whole path has to refuse it by that name, alone.
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const probe = spawnSync(process.execPath, ["infra/release/docs-check.mjs", "--probe-routes"], { cwd: root, encoding: "utf8" });
    expect(probe.status).not.toBe(0);
    expect(probe.stdout).toContain("mounted-route-unlisted:GET /probe-routes-not-a-door(api.ts:0)");
    expect(probe.stdout.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
  });
});

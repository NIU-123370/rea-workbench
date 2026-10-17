// Release-gate tooling: reconcile the acceptance ids in `docs/PRD.md` against the
// verification matrix in `docs/TESTPLAN.md` (TESTPLAN §6 / PRD A01-A13, issue #23), and
// then reconcile the *source tree* against the three id tables the documents own:
// cases (`T##`), criteria (`A##`) and decisions (`D##`, DECISIONS.md's `- D23｜选了：…`).
//
// The point is not to restate the documents — they stay the single source — but to fail
// a release when the two stop agreeing: a test case that names an acceptance id that does
// not exist, an acceptance criterion nobody tests, or a matrix with a hole in its numbering.
// Every reason names the id and the file so a reviewer can fix it without re-reading both
// tables.
//
// The third check exists because source files and the doctor's own advisory strings name
// these ids at operators. A reference to a case the matrix never had reads as a promise
// that some acceptance will eventually turn the gate green, and nothing in the tree notices
// when the id is invented or when the document it came from is renumbered. That is not
// hypothetical: this repository shipped a CAPABILITY_UNAVAILABLE payload that pointed an
// operator at a case id the matrix never had, and a restore command that cited a criterion
// the PRD does not declare. The ids are left out here on purpose — this file is scanned too,
// and a header that needs an opt-out marker to describe the refusal is a header teaching the
// next reader to add one.

const TEST_CASE_ROW = /^\|\s*(T\d{2})\s*\|\s*([^|]+)\|/;
const ACCEPTANCE_ROW = /^\|\s*(A\d{2})\s+[^|]+\|\s*[^|]+\|/;
const DECISION_ROW = /^-\s*(D\d{2})｜/;
const ID_IN_TEXT = /\bA\d{2}\b/g;

// A source file names a case (`T16`), a criterion (`A12`) or a decision (`D23`), and the
// token has to stand alone for that to mean anything: `2026-10-16T09:00:00Z` carries a `T09`
// whose preceding character is a digit, and a base64 run carries `A12` followed by a letter.
// Both are excluded here, because a scanner that fired on timestamps would be switched off
// inside a week — and a switched-off scanner is worse than none, since it reports a clean pass.
const SOURCE_ID_REF = /(?<![0-9A-Za-z._-])([TAD]\d{2})(?![0-9A-Za-z])/g;

// One row per id family, so adding a fourth table means adding it here rather than nesting
// another ternary where a missing branch reads as "that family is checked". The key set is
// `SOURCE_ID_REF`'s character class, so an unmapped family cannot reach the lookup; if one
// ever did, the reason would carry the literal `undefined` where the family name belongs —
// still a non-empty reason, so the gate fails rather than passing silently. (This comment
// once spelled that example with an invented id, and the scanner flagged this file for it.)
const REF_REASON_BY_PREFIX = {
  T: "test-case-ref-undeclared",
  A: "acceptance-ref-undeclared",
  D: "decision-ref-undeclared",
};

// A line that has to carry an id outside the matrix — testing the refusal itself — opts out
// inline and says why, so the opt-out stays visible at the site instead of exempting a file.
const IGNORE_MARKER = "docs-check-ignore";

// `§13 line 453` is a *pair*: the section says which rule, the line says which sentence. A
// renumbered document moves the sentence while the section stays, and then the citation reads
// as authority for something the document no longer says there. Only anchors that carry a line
// number can be checked — a bare `§11` names a section, not a place — and the pair is checked
// against DESIGN.md because every line-anchored citation in this tree is a DESIGN one.
const DESIGN_ANCHOR = /§(\d+)(?:\s*(?:line|lines)\s+(\d{1,4})(?:\s*-\s*(\d{1,4}))?)?/g;
const DESIGN_HEADING = /^##\s*(\d+)\./;

export const TESTPLAN_FILE = "docs/TESTPLAN.md";
export const PRD_FILE = "docs/PRD.md";
export const DECISIONS_FILE = "docs/DECISIONS.md";
export const DESIGN_FILE = "docs/DESIGN.md";
export const SOURCE_ROOTS = ["packages", "apps", "tests", "infra"];
export const SOURCE_EXTENSIONS = [".ts", ".mts", ".mjs"];
export const SKIPPED_DIRECTORIES = ["node_modules", ".next", "dist", "coverage"];

function ids(text) {
  return [...new Set(text)];
}

// The matrix rows are `| T01 | A01 导入身份 | ... |`, and a row may name several criteria
// (`A01、A03、A06`). Parsing is line-shaped on purpose: a row that stops matching is itself
// a defect, so a reformat that drops the id column cannot pass silently.
export function parseTestCaseRows(markdown) {
  /** @type {{ case: string, accepts: string[] }[]} */
  const rows = [];
  const lines = markdown.split("\n");
  let inMatrix = false;
  for (const line of lines) {
    if (/^##\s*3\./.test(line)) inMatrix = true;
    else if (/^##\s/.test(line)) inMatrix = false;
    if (!inMatrix) continue;
    const match = TEST_CASE_ROW.exec(line);
    if (match === null) continue;
    rows.push({ case: match[1], accepts: ids(match[2].match(ID_IN_TEXT) ?? []) });
  }
  return rows;
}

export function parseAcceptanceRows(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    const match = ACCEPTANCE_ROW.exec(line);
    if (match !== null) rows.push(match[1]);
  }
  return rows;
}

// DECISIONS.md is a bullet list, not a table: `- D23｜选了：… ；为什么：… ；放弃了：…`.
// Same reason as the other two parsers for staying line-shaped — a row that stops matching
// is the defect, and a renumbering that the source tree has not caught up with must not be
// able to pass by shrinking the declared set to nothing.
export function parseDecisionRows(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    const match = DECISION_ROW.exec(line);
    if (match !== null) rows.push(match[1]);
  }
  return rows;
}

/**
 * DESIGN.md's `## 7. …` headings split the document into the sections a citation names. A
 * section runs to the next H2 and the last one to the end of the file, so a citation's line
 * number can be placed in a section even after the document grows.
 * @param {string} markdown
 * @returns {{ section: string, start: number, end: number }[]}
 */
export function parseDesignSections(markdown) {
  const lines = markdown.split("\n");
  /** @type {{ section: string, start: number, end: number }[]} */
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = DESIGN_HEADING.exec(lines[index] ?? "");
    if (match !== null) sections.push({ section: String(match[1]), start: index + 1, end: lines.length });
  }
  for (let index = 0; index < sections.length - 1; index += 1) {
    const current = sections[index];
    const next = sections[index + 1];
    if (current !== undefined && next !== undefined) current.end = next.start - 1;
  }
  return sections;
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {{ section: string, from: number | null, to: number | null, file: string, line: number }[]}
 *   `from` is null for a citation whose line number fell onto the next comment line: the pair
 *   is unreadable as a pair, and a scanner that quietly skipped it would certify a document
 *   half of whose anchors it cannot see.
 */
export function findSectionAnchors(file, text) {
  /** @type {{ section: string, from: number | null, to: number | null, file: string, line: number }[]} */
  const found = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.includes(IGNORE_MARKER)) continue;
    const wrapped = /§(\d+)\s+(?:lines?)[\s]*$/.exec(line);
    if (wrapped !== null) found.push({ section: String(wrapped[1]), from: null, to: null, file, line: index + 1 });
    for (const match of line.matchAll(DESIGN_ANCHOR)) {
      // A bare `§11` names a section, not a place, and carries nothing to verify.
      if (match[2] === undefined) continue;
      found.push({
        section: String(match[1]),
        from: Number(match[2]),
        to: Number(match[3] ?? match[2]),
        file,
        line: index + 1,
      });
    }
  }
  return found;
}

/**
 * @param {{ section: string, from: number | null, to: number | null, file: string, line: number }[]} anchors
 * @param {{ section: string, start: number, end: number }[]} sections
 * @param {number} designLines the length of DESIGN.md, so an off-the-end line is named as such
 * @returns {string[]} one reason per citation whose section and line disagree
 */
export function checkSectionAnchors(anchors, sections, designLines) {
  const reasons = [];
  for (const anchor of anchors) {
    const site = `${anchor.file}:${String(anchor.line)}`;
    if (anchor.from === null) {
      reasons.push(`design-anchor-wrapped:§${anchor.section} line(${site}) 行号掉到下一行，这一对读不出来源`);
      continue;
    }
    const label = `§${anchor.section} line ${String(anchor.from)}${anchor.to !== null && anchor.to > anchor.from ? `-${String(anchor.to)}` : ""}`;
    const to = anchor.to ?? anchor.from;
    if (to > designLines) {
      reasons.push(`design-anchor-past-end:${label}(${site}) DESIGN.md 共 ${String(designLines)} 行`);
      continue;
    }
    const named = sections.find((section) => section.section === anchor.section);
    if (named === undefined) {
      reasons.push(`design-section-unknown:${label}(${site}) DESIGN.md 没有这一节`);
      continue;
    }
    if (anchor.from >= named.start && to <= named.end) continue;
    // Name the number that is actually outside, so the reason does not say "this line belongs to
    // the very section it was cited against" when only the tail of a range left the section.
    const offender = anchor.from < named.start || anchor.from > named.end ? anchor.from : to;
    const owner = sections.find((section) => offender >= section.start && offender <= section.end);
    reasons.push(
      `design-anchor-outside-section:${label}(${site}) 该节是 ${String(named.start)}-${String(named.end)}，`
      + `而行号 ${String(offender)} 属于 ${owner === undefined ? "文档开头（任何 ## 之前）" : `§${owner.section} ${String(owner.start)}-${String(owner.end)}`}`,
    );
  }
  return reasons;
}

/**
 * Every matrix/criterion id a source file names, with the site so a reason is actionable.
 * `file` is only ever used to label the reason — the caller reads the text.
 * @param {string} file
 * @param {string} text
 * @returns {{ ref: string, file: string, line: number }[]}
 */
export function findIdReferences(file, text) {
  /** @type {{ ref: string, file: string, line: number }[]} */
  const found = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.includes(IGNORE_MARKER)) continue;
    for (const match of line.matchAll(SOURCE_ID_REF)) {
      found.push({ ref: String(match[1]), file, line: index + 1 });
    }
  }
  return found;
}

/**
 * @param {{ ref: string, file: string, line: number }[]} references
 * @param {{ cases: string[], accepts: string[], decisions: string[] }} declared the ids the documents declare
 * @returns {string[]} one reason per reference that names an id no table declares
 */
export function checkSourceReferences(references, declared) {
  const known = new Set([...declared.cases, ...declared.accepts, ...declared.decisions]);
  const reasons = [];
  for (const reference of references) {
    if (known.has(reference.ref)) continue;
    const kind = REF_REASON_BY_PREFIX[reference.ref.charAt(0)];
    reasons.push(`${kind}:${reference.ref}(${reference.file}:${String(reference.line)})`);
  }
  return reasons;
}

/**
 * @param {{ testCases: string[], accepts: string[], firstCase?: string, lastCase?: string }} input
 * @returns {string[]} reasons, empty when the two documents agree
 */
export function reconcile(input) {
  const firstCase = input.firstCase ?? "T01";
  const lastCase = input.lastCase ?? "T17";
  const reasons = [];

  const cases = input.testCases.map((row) => row.case);
  const duplicates = cases.filter((case_, index) => cases.indexOf(case_) !== index);
  for (const duplicate of new Set(duplicates)) reasons.push(`duplicate-test-case:${duplicate}`);

  const expectedCases = expectedSequence(firstCase, lastCase, "T");
  for (const missing of expectedCases.filter((id) => !cases.includes(id))) {
    reasons.push(`test-case-missing:${missing}`);
  }
  for (const extra of cases.filter((id) => !expectedCases.includes(id))) {
    reasons.push(`test-case-out-of-range:${extra}`);
  }

  const declaredAccepts = input.accepts;
  const unknownAccepts = new Set();
  const covered = new Set();
  for (const row of input.testCases) {
    if (row.accepts.length === 0) reasons.push(`test-case-without-acceptance:${row.case}`);
    for (const accept of row.accepts) {
      if (!declaredAccepts.includes(accept)) unknownAccepts.add(`${accept}(${row.case})`);
      else covered.add(accept);
    }
  }
  for (const unknown of [...unknownAccepts].sort()) reasons.push(`acceptance-not-declared:${unknown}`);
  for (const missing of declaredAccepts.filter((id) => !covered.has(id))) {
    reasons.push(`acceptance-untested:${missing}`);
  }
  for (const extra of declaredAccepts.filter((id) => !expectedSequence("A01", `A${String(declaredAccepts.length)}`, "A").includes(id))) {
    reasons.push(`acceptance-out-of-range:${extra}`);
  }
  return reasons;
}

function expectedSequence(first, last, prefix) {
  const start = Number(first.slice(1));
  const end = Number(last.slice(1));
  const out = [];
  for (let value = start; value <= end; value += 1) out.push(`${prefix}${String(value).padStart(2, "0")}`);
  return out;
}

/**
 * @param {string} testplan the TESTPLAN.md text
 * @param {string} prd the PRD.md text
 * @returns {string[]} reasons, empty when the release matrix reconciles
 */
export function checkDocs(testplan, prd) {
  const rows = parseTestCaseRows(testplan);
  const accepts = parseAcceptanceRows(prd);
  if (rows.length === 0) return ["testplan-matrix-unreadable:no T## rows matched"];
  if (accepts.length === 0) return ["prd-acceptance-table-unreadable:no A## rows matched"];
  return reconcile({ testCases: rows, accepts });
}

// The command-line entry: `npm run docs:check` from `workbench/`, reading the documents
// that are the single source rather than a copy of them kept here, plus the source tree
// that cites them.
if (process.argv[1] !== undefined && process.argv[1].endsWith("docs-check.mjs")) {
  const { readFileSync, readdirSync, existsSync } = await import("node:fs");
  const { default: path } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  // The documents live at the repository root; the tree that cites them lives one level down.
  const project = fileURLToPath(new URL("../..", import.meta.url));

  const testplan = readFileSync(path.join(root, TESTPLAN_FILE), "utf8");
  const prd = readFileSync(path.join(root, PRD_FILE), "utf8");
  const decisions = readFileSync(path.join(root, DECISIONS_FILE), "utf8");
  const reasons = checkDocs(testplan, prd);
  const declaredDecisions = parseDecisionRows(decisions);
  if (declaredDecisions.length === 0) reasons.push("decisions-table-unreadable:no - D## rows matched");

  /** @type {{ ref: string, file: string, line: number }[]} */
  const references = [];
  /** @type {{ section: string, from: number | null, to: number | null, file: string, line: number }[]} */
  const anchors = [];
  let filesScanned = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // A generated tree (`.next`, `node_modules`) can carry compiled copies of these
        // files; scanning them would report the same line twice and under a path nobody owns.
        if (SKIPPED_DIRECTORIES.includes(entry.name) || entry.name.startsWith(".")) continue;
        walk(absolute);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
      const relative = path.relative(project, absolute);
      const text = readFileSync(absolute, "utf8");
      filesScanned += 1;
      references.push(...findIdReferences(relative, text));
      anchors.push(...findSectionAnchors(relative, text));
    }
  };
  for (const sourceRoot of SOURCE_ROOTS) {
    // A renamed or emptied root must not silently shrink the scan to nothing: an empty scan
    // is a green gate that proves nothing.
    if (!existsSync(path.join(project, sourceRoot))) reasons.push(`source-root-missing:${sourceRoot}`);
    else walk(path.join(project, sourceRoot));
  }
  const design = readFileSync(path.join(root, DESIGN_FILE), "utf8");
  const designSections = parseDesignSections(design);
  if (designSections.length === 0) reasons.push("design-sections-unreadable:no `## N.` heading matched");
  reasons.push(...checkSectionAnchors(anchors, designSections, design.split("\n").length));
  reasons.push(...checkSourceReferences(references, {
    cases: parseTestCaseRows(testplan).map((row) => row.case),
    accepts: parseAcceptanceRows(prd),
    decisions: declaredDecisions,
  }));

  const rows = parseTestCaseRows(testplan).length;
  const accepts = parseAcceptanceRows(prd).length;
  process.stdout.write(
    `docs:check 用例 ${String(rows)} 条 / 验收 ${String(accepts)} 条 / 决策 ${String(declaredDecisions.length)} 条 / `
    + `源码引用 ${String(references.length)} 处（${String(filesScanned)} 个文件）/ 设计锚点 ${String(anchors.length)} 处（DESIGN ${String(designSections.length)} 节）\n`,
  );
  for (const reason of reasons) process.stdout.write(`- ${reason}\n`);
  process.exit(reasons.length > 0 ? 1 : 0);
}

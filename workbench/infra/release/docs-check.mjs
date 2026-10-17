// Release-gate tooling: reconcile the acceptance ids in `docs/PRD.md` against the
// verification matrix in `docs/TESTPLAN.md` (TESTPLAN §6 / PRD A01-A13, issue #23), and
// then reconcile the *source tree* against those two tables.
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
// when the id is invented or when the document it came from is renumbered.

const TEST_CASE_ROW = /^\|\s*(T\d{2})\s*\|\s*([^|]+)\|/;
const ACCEPTANCE_ROW = /^\|\s*(A\d{2})\s+[^|]+\|\s*[^|]+\|/;
const ID_IN_TEXT = /\bA\d{2}\b/g;

// A source file names a case (`T16`) or a criterion (`A12`), and the token has to stand
// alone for that to mean anything: `2026-10-16T09:00:00Z` carries a `T09` whose preceding
// character is a digit, and a base64 run carries `A12` followed by a letter. Both are
// excluded here, because a scanner that fired on timestamps would be switched off inside a
// week — and a switched-off scanner is worse than none, since it reports a clean pass.
const SOURCE_ID_REF = /(?<![0-9A-Za-z._-])([TA]\d{2})(?![0-9A-Za-z])/g;

// A line that has to carry an id outside the matrix — testing the refusal itself — opts out
// inline and says why, so the opt-out stays visible at the site instead of exempting a file.
const IGNORE_MARKER = "docs-check-ignore";

export const TESTPLAN_FILE = "docs/TESTPLAN.md";
export const PRD_FILE = "docs/PRD.md";
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
 * @param {{ cases: string[], accepts: string[] }} declared the ids the documents declare
 * @returns {string[]} one reason per reference that names an id no table declares
 */
export function checkSourceReferences(references, declared) {
  const known = new Set([...declared.cases, ...declared.accepts]);
  const reasons = [];
  for (const reference of references) {
    if (known.has(reference.ref)) continue;
    const kind = reference.ref.startsWith("T") ? "test-case-ref-undeclared" : "acceptance-ref-undeclared";
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
  const reasons = checkDocs(testplan, prd);

  /** @type {{ ref: string, file: string, line: number }[]} */
  const references = [];
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
      filesScanned += 1;
      references.push(...findIdReferences(relative, readFileSync(absolute, "utf8")));
    }
  };
  for (const sourceRoot of SOURCE_ROOTS) {
    // A renamed or emptied root must not silently shrink the scan to nothing: an empty scan
    // is a green gate that proves nothing.
    if (!existsSync(path.join(project, sourceRoot))) reasons.push(`source-root-missing:${sourceRoot}`);
    else walk(path.join(project, sourceRoot));
  }
  reasons.push(...checkSourceReferences(references, {
    cases: parseTestCaseRows(testplan).map((row) => row.case),
    accepts: parseAcceptanceRows(prd),
  }));

  const rows = parseTestCaseRows(testplan).length;
  const accepts = parseAcceptanceRows(prd).length;
  process.stdout.write(
    `docs:check 用例 ${String(rows)} 条 / 验收 ${String(accepts)} 条 / 源码引用 ${String(references.length)} 处（${String(filesScanned)} 个文件）\n`,
  );
  for (const reason of reasons) process.stdout.write(`- ${reason}\n`);
  process.exit(reasons.length > 0 ? 1 : 0);
}

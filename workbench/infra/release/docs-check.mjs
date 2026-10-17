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

// §8's table is the only place in this repository that says which HTTP entry points exist, and
// until now nothing compared it against the table the web adapter mounts. Issue #58 opened with
// 40 documented rows against 13 mounted doors; the difference was visible only to whoever
// re-counted by hand, which is how a project quietly normalises an unmet promise — a year in,
// "the routes we mounted" is what people remember, and the document saying otherwise reads as
// stale instead of as a list. So the difference is computed here, on every release check.
//
// A deviation is therefore not an exemption but a dated promise with an owner: each entry names
// the issue that records it, and a route the two sides agree on turns the entry itself into a
// defect (`route-deviation-stale`). Without that inversion a waiver table only grows, and the
// gate decays back into the one-off reading it replaced.
const DESIGN_ROUTE_ROW = /^\|\s*`(GET|POST|PUT|PATCH|DELETE)\s+(\S+)`\s*\|/;// The web adapter's own table. Line-shaped on purpose, like the other four parsers: an entry
// that moves off the line this reads stops counting as a mounted door, and since §8 still names
// it, the loss surfaces as `design-route-unmounted` rather than as a green pass over a shrunken
// scan.
const MOUNTED_ROUTE_ROW = /^\s*\{\s*method:\s*"(GET|POST|PUT|PATCH|DELETE)",\s*template:\s*`\$\{API_PREFIX\}([^`]+)`,\s*mutating:\s*(true|false),\s*requiresSession:\s*(true|false),\s*requiresIdempotencyKey:\s*(true|false)\s*\}/;

// §8 line 261 says which creations take an `Idempotency-Key`, naming them by the *word* the command
// carries (`import`, `job`, …) rather than by a path. The mapping below is this file's own reading of
// those eight words onto the eight path templates that create them — which is why every entry is
// asserted to exist in the mounted table (`idempotency-door-unmounted`): if a door is renamed or
// dropped, the gate goes red instead of silently checking one fewer thing.
export const KEYED_CREATION_WORDS = ["import", "job", "vector", "plan", "blueprint", "candidate", "verification", "export"];
export const KEYED_CREATION_TEMPLATES = {
  import: "/projects/:projectId/imports",
  job: "/projects/:projectId/jobs",
  vector: "/projects/:projectId/vectors",
  plan: "/projects/:projectId/verification-plans",
  blueprint: "/projects/:projectId/blueprints",
  candidate: "/projects/:projectId/candidates",
  verification: "/projects/:projectId/verifications",
  export: "/projects/:projectId/exports",
};

// The two differences this build ships with, each pointing at the issue that records it.
export const IDEMPOTENCY_DEVIATIONS = {
  // §8 line 261 lists export among the keyed creations, while §5's `exports` row says 不覆盖旧包 —
  // a retried request must make a second package rather than replay the first. The code follows §5.
  "POST /projects/:p/exports": "issue #58 — §5 说不覆盖旧包，§8 line 261 又把 export 列为具名键创建",
  // §8's row for the project create asks only for `{name:string}`, yet the door requires a key.
  // Requiring more than the row says is a live difference for callers, so it is named, not assumed.
  "POST /projects": "issue #58 — 门要键，而 §8 那一行的请求字段只写 {name:string}",
};

/**
 * The three differences this build ships with, each recorded on an issue rather than smoothed
 * over. Keys are §8's own spelling — only the parameter *names* are normalised when comparing,
 * because the document writes `:p` where the code writes `:projectId` and that is a formatting
 * difference, not a route difference.
 */
export const ROUTE_DEVIATIONS = {
  // §8 line 304 promises a captured-frame preview. Nothing holds a frame: there is no pixel
  // artifact class, no image media type, and no isolated-origin process to serve it from.
  "GET /projects/:p/jobs/:j/preview": "issue #79 — 预览帧没有任何持有者（像素 class、image 媒体类型、隔离 origin 都不存在）",
  // A read §8 never declared, added because the verification door needs a comparator *name* and
  // an operator cannot be asked to type one they have no way of listing (issue #82, delivered).
  "GET /comparator-policies": "issue #82 — §8 表内无此行；写入闸需要的比较器名必须有读门",
  // §8 lines 299-300 declare the export create and its download; paging a project's packages is
  // the one mount in this adapter still waiting for a ruling on whether the document extends.
  "GET /projects/:p/exports": "issue #58 — §8 只声明 POST /exports 与 download；列表行待裁决",
};

export const WEB_API_FILE = "apps/web/api.ts";

/**
 * @param {string} markdown the DESIGN.md text
 * @param {{ section: string, start: number, end: number }[]} sections the same split the anchor check uses
 * @returns {{ method: string, target: string, request: string, line: number }[]} §8's route rows
 *
 * Scoped to §8 because other tables in the document open their first cell with a backtick too
 * (the module table's `packages/domain`, the field tables' `request.method`); the method
 * alternation excludes those, and the scope keeps a future `POST /something` row in an unrelated
 * section from being read as a promised endpoint.
 *
 * `request` is the row's second column — the field list §8 writes there — because the idempotency
 * rule below reads 「需幂等键」 out of it rather than from a copy of the table kept here. Cells are
 * split on pipes that are *not* escaped, since a row like the import one spells `kind:'har'\|'asar'`.
 */
export function parseDesignRoutes(markdown, sections) {
  const owned = sections.find((entry) => entry.section === "8");
  if (owned === undefined) return [];
  const lines = markdown.split("\n");
  /** @type {{ method: string, target: string, request: string, line: number }[]} */
  const rows = [];
  for (let index = owned.start - 1; index < owned.end; index += 1) {
    const line = lines[index] ?? "";
    const match = DESIGN_ROUTE_ROW.exec(line);
    if (match === null) continue;
    const cells = line.split(/(?<!\\)\|/);
    rows.push({
      method: String(match[1]),
      target: String(match[2]),
      request: String(cells[2] ?? "").trim(),
      line: index + 1,
    });
  }
  return rows;
}

/**
 * @param {string} text the apps/web/api.ts source
 * @returns {{ method: string, target: string, line: number, keyed: boolean }[]} the doors that table mounts
 *
 * The `${API_PREFIX}` the templates interpolate is dropped rather than substituted: §8's rows
 * are written without it, and a gate that had to agree on the prefix would only be checking its
 * own reading of a constant. The three flags are read with the same line-shape requirement, so a
 * door whose declaration moves off the line stops counting as mounted (and §8 still names it).
 */
export function parseMountedRoutes(text) {
  /** @type {{ method: string, target: string, line: number, keyed: boolean }[]} */
  const rows = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = MOUNTED_ROUTE_ROW.exec(lines[index] ?? "");
    if (match === null) continue;
    rows.push({
      method: String(match[1]),
      target: String(match[2]),
      line: index + 1,
      keyed: match[5] === "true",
    });
  }
  return rows;
}

/**
 * `GET /projects/:p/jobs/:j/preview` and `GET /projects/:projectId/jobs/:jobId/preview` are one
 * route; `GET /projects/:p` and `GET /projects/:p/jobs` are not. Each segment is kept or folded
 * whole, so a parameter never swallows its neighbours.
 * @param {string} method
 * @param {string} target
 */
export function canonicalRoute(method, target) {
  const folded = target
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => (part.startsWith(":") ? ":" : part))
    .join("/");
  return `${method.toUpperCase()} /${folded}`;
}

/**
 * @param {{ method: string, target: string, line: number }[]} design rows §8 declares
 * @param {{ method: string, target: string, line: number }[]} mounted rows the web adapter mounts
 * @param {Record<string, string>} deviations named, dated differences allowed to stand
 * @returns {string[]} one reason per difference the table does not already own
 */
export function checkRoutes(design, mounted, deviations) {
  const reasons = [];
  if (design.length === 0) reasons.push("design-routes-unreadable:§8 没有一行 | `METHOD /path` | 表格，或那一节换了形状");
  if (mounted.length === 0) reasons.push("mounted-routes-unreadable:apps/web/api.ts 的 ROUTES 一条都没读出来");
  if (design.length === 0 || mounted.length === 0) return reasons;

  /** @param {{ method: string, target: string, line: number }[]} rows */
  const byKey = (rows) => {
    const grouped = new Map();
    for (const row of rows) {
      const key = canonicalRoute(row.method, row.target);
      const seen = grouped.get(key);
      if (seen === undefined) grouped.set(key, [row]);
      else seen.push(row);
    }
    return grouped;
  };
  const designByKey = byKey(design);
  const mountedByKey = byKey(mounted);

  // Two rows for one canonical route are a defect on either side: on the document's, because
  // the second promise is a different contract nobody reconciles with the first; on the
  // adapter's, because `matchRoute` answers a collision with whichever entry came first, so a
  // parameter rename that folds two templates together silently shadows one door.
  for (const [key, rows] of designByKey) {
    if (rows.length > 1) reasons.push(`design-route-duplicate:${key}(§8 line ${rows.map((row) => String(row.line)).join(",")})`);
  }
  for (const [key, rows] of mountedByKey) {
    if (rows.length > 1) reasons.push(`mounted-route-duplicate:${key}(${rows.map((row) => `api.ts:${String(row.line)}`).join(",")})`);
  }

  /** @type {Map<string, string>} the allowed differences, keyed the way the two sides are keyed */
  const waiver = new Map();
  for (const target of Object.keys(deviations)) {
    const [method, path] = splitRoute(target);
    const key = canonicalRoute(method, path);
    const already = waiver.get(key);
    if (already !== undefined) reasons.push(`route-deviation-duplicate:${target} 与 ${already} 是同一条路由`);
    waiver.set(key, target);
  }

  for (const [key, rows] of designByKey) {
    const first = rows[0];
    if (first === undefined || mountedByKey.has(key) || waiver.has(key)) continue;
    reasons.push(`design-route-unmounted:${key}(§8 line ${String(first.line)})`);
  }
  for (const [key, rows] of mountedByKey) {
    const first = rows[0];
    if (first === undefined || designByKey.has(key) || waiver.has(key)) continue;
    reasons.push(`mounted-route-unlisted:${key}(api.ts:${String(first.line)})`);
  }

  // The inversion: a waiver that no longer covers a difference is not a waiver, it is a
  // description of something that is not true. Kept as a reason so the table stays readable.
  for (const [target, note] of Object.entries(deviations)) {
    const [method, path] = splitRoute(target);
    const key = canonicalRoute(method, path);
    const declared = designByKey.has(key);
    const mountedHere = mountedByKey.has(key);
    if (declared !== mountedHere) continue;
    reasons.push(`route-deviation-stale:${target}(${declared ? "两侧已对上，删掉这条记录" : "两侧都没有这条路由"}) ${note}`);
  }
  return reasons;
}

/**
 * §8 states the idempotency rule in two places: line 261 names the eight creations that take an
 * `Idempotency-Key`, and a row asks for one in its own field column (the cleanup-retry row writes
 * 需幂等键与本地会话). Both readings are compared against the flags the mounted table declares, in
 * both directions: a named creation whose door does not require a key is a promise unmet, and a door
 * that requires one the document never asked for changes what a caller has to send — the second is
 * the easier one to miss, because nothing refuses it.
 *
 * @param {{ method: string, target: string, request: string, line: number }[]} design §8's rows
 * @param {{ method: string, target: string, line: number, keyed: boolean }[]} mounted the doors
 * @param {Record<string, string>} deviations named differences allowed to stand
 * @param {readonly string[]} words the creation words the document names (a parameter, so a fixture
 *   can hand over one more word than the template table maps and read back the named refusal —
 *   a reason nobody can reach is a reason nobody can prove)
 * @param {Record<string, string>} templates the word → path-template reading
 */
export function checkIdempotencyKeys(design, mounted, deviations, words = KEYED_CREATION_WORDS, templates = KEYED_CREATION_TEMPLATES) {
  const reasons = [];
  if (design.length === 0 || mounted.length === 0) return reasons;
  const byKey = new Map();
  for (const row of mounted) byKey.set(canonicalRoute(row.method, row.target), row);

  /** @type {Map<string, number>} canonical key -> the §8 line that asks for the key */
  const expected = new Map();
  for (const word of words) {
    const template = templates[word];
    if (template === undefined) {
      reasons.push(`idempotency-word-unmapped:${word}`);
      continue;
    }
    const key = canonicalRoute("POST", template);
    if (!byKey.has(key)) {
      reasons.push(`idempotency-door-unmounted:${key}(§8 line 261 names ${word})`);
      continue;
    }
    expected.set(key, 0);
  }
  for (const row of design) {
    if (!row.request.includes("需幂等键")) continue;
    const key = canonicalRoute(row.method, row.target);
    if (!byKey.has(key)) {
      reasons.push(`idempotency-door-unmounted:${key}(§8 line ${String(row.line)} 写了 需幂等键)`);
      continue;
    }
    expected.set(key, row.line);
  }

  /** @param {string} key */
  const waived = (key) => Object.keys(deviations).some((target) => canonicalRoute(...splitRoute(target)) === key);

  for (const [key, designLine] of expected) {
    const door = byKey.get(key);
    if (door === undefined || door.keyed || waived(key)) continue;
    reasons.push(
      `idempotency-key-required-unenforced:${key}(api.ts:${String(door.line)}`
      + `${designLine > 0 ? `, §8 line ${String(designLine)}` : ", §8 line 261"})`,
    );
  }
  for (const [key, door] of byKey) {
    if (!door.keyed || expected.has(key) || waived(key)) continue;
    reasons.push(`idempotency-key-enforced-unlisted:${key}(api.ts:${String(door.line)})`);
  }
  for (const target of Object.keys(deviations)) {
    const key = canonicalRoute(...splitRoute(target));
    const door = byKey.get(key);
    if (door === undefined) {
      reasons.push(`idempotency-deviation-stale:${target}(两侧都没有这道门)`);
      continue;
    }
    const asks = expected.has(key);
    if (asks === door.keyed) {
      reasons.push(
        `idempotency-deviation-stale:${target}(${door.keyed ? "门已按要求要键，删掉这条记录" : "文档与门都不再要求"}) ${deviations[target] ?? ""}`.trimEnd(),
      );
    }
  }
  return reasons;
}

/**
 * `"GET /projects/:p"` → `["GET", "/projects/:p"]`. A key that spells no method cannot canonicalise
 * to a route either side names, so it reaches the stale loop and is reported there rather than
 * being silently skipped — an unreadable waiver still has to fail the gate.
 * @param {string} target
 */
function splitRoute(target) {
  const index = target.indexOf(" ");
  if (index < 0) return ["", target];
  return [target.slice(0, index), target.slice(index + 1)];
}

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

  // The route table is read the same way the three id tables are: from the document that owns it
  // and from the source that mounts it, with no copy of either kept here.
  const designRouteRows = parseDesignRoutes(design, designSections);
  const apiFile = path.join(project, WEB_API_FILE);
  /** @type {{ method: string, target: string, line: number }[]} */
  let mountedRouteRows = [];
  if (existsSync(apiFile)) mountedRouteRows = parseMountedRoutes(readFileSync(apiFile, "utf8"));
  else reasons.push(`web-api-module-missing:${WEB_API_FILE}`);

  // `--probe-routes` mounts a door no document names, and gives it a key requirement nobody asked
  // for. It exists because this repository's tree is currently clean on both reconciliations, and a
  // clean tree cannot tell "no defect" from "no check": the ordinary run's green line would print
  // identically if either reconciliation were computed and then dropped. The probe makes both paths
  // observable in one run — read, parse, compare, name both faults, exit non-zero.
  const PROBE_DOOR = { method: "GET", target: "/probe-routes-not-a-door", line: 0, keyed: false };
  // The key flag has to be the *other* value for the second reconciliation, so the probe door is
  // declared as requiring a key: §8 names no such creation, so only `checkIdempotencyKeys` can see it.
  const PROBE_KEYED_DOOR = { method: "POST", target: "/probe-routes-not-a-door", line: 0, keyed: true };
  const probed = process.argv.includes("--probe-routes");
  const mountedForRoutes = probed ? [...mountedRouteRows, PROBE_DOOR] : mountedRouteRows;
  const mountedForKeys = probed ? [...mountedRouteRows, PROBE_KEYED_DOOR] : mountedRouteRows;
  reasons.push(...checkRoutes(designRouteRows, mountedForRoutes, ROUTE_DEVIATIONS));
  reasons.push(...checkIdempotencyKeys(designRouteRows, mountedForKeys, IDEMPOTENCY_DEVIATIONS));

  const rows = parseTestCaseRows(testplan).length;
  const accepts = parseAcceptanceRows(prd).length;
  process.stdout.write(
    `docs:check 用例 ${String(rows)} 条 / 验收 ${String(accepts)} 条 / 决策 ${String(declaredDecisions.length)} 条 / `
    + `源码引用 ${String(references.length)} 处（${String(filesScanned)} 个文件）/ 设计锚点 ${String(anchors.length)} 处（DESIGN ${String(designSections.length)} 节）/ `
    + `路由 §8 ${String(designRouteRows.length)} 条 · 挂载 ${String(mountedRouteRows.length)} 条 · 已记偏差 ${String(Object.keys(ROUTE_DEVIATIONS).length)} 条 / `
    + `具名键 ${String(KEYED_CREATION_WORDS.length)} 词 · 已记幂等偏差 ${String(Object.keys(IDEMPOTENCY_DEVIATIONS).length)} 条\n`,
  );
  for (const reason of reasons) process.stdout.write(`- ${reason}\n`);
  process.exit(reasons.length > 0 ? 1 : 0);
}

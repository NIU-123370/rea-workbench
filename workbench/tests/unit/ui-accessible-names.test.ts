import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Every form control on the page has to carry an accessible programmatic name (issue #110).
//
// A real browser run said it: the console carried no JS error and one advisory -
// `A form field element should have an id or name attribute (count: 3)`. The page addresses its own
// controls through `data-*` attributes and its reconciliation tests read those, which is fine for a
// test and worth nothing to a screen reader, a browser's autofill, or the "which field is this value"
// question a form submission answers. So the rule here is the one Chrome applies: `name` or `id`, and
// non-empty either way.
//
// It scans the source rather than a render because the controls live in tabs whose content depends on
// click state: a static render can only see the tab that happens to be open, and a guard that only
// covers what one render happened to mount is a guard with a hole in it. The cost of source-scanning
// is the brace-aware walk below - the attributes of one element span lines and contain `{...}` blocks,
// so `[^>]*` would stop at the first `>` inside an expression.

const SOURCE = path.join(process.cwd(), "apps", "web", "app", "client", "workbench.tsx");
const CONTROL = /<(input|select|textarea)\b/g;

type Control = { tag: string; attributes: string; line: number };

// The opening tag ends at the first `>` that is not inside braces, a string, or a JSX expression.
function openingTag(text: string, from: number): { attributes: string; end: number } {
  let depth = 0;
  let quote: string | null = null;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "(") depth += 1;
    else if (char === "}" || char === ")") depth -= 1;
    else if (char === ">" && depth <= 0) return { attributes: text.slice(from, index), end: index };
  }
  return { attributes: text.slice(from), end: text.length };
}

function controlsOf(text: string): Control[] {
  const found: Control[] = [];
  for (const match of text.matchAll(CONTROL)) {
    const start = (match.index ?? 0) + match[0].length;
    const { attributes } = openingTag(text, start);
    found.push({ tag: match[1] as string, attributes, line: text.slice(0, match.index ?? 0).split("\n").length });
  }
  return found;
}

// `name=""` and `id={""}` are present-but-empty and answer nothing, so the pattern refuses both; an
// interpolated id (`id={`capture-role-${index}`}`) starts with a backtick and counts, because the
// prefix is a real name even though the suffix comes from state.
const NAMED = /(?:^|\s)(?:name|id)=(?:"[^"]+"|\{\s*(?!["'])[^}]*\})/;

describe("every form control names itself (issue #110)", () => {
  const source = readFileSync(SOURCE, "utf8");
  const controls = controlsOf(source);

  it("finds the controls this guard is supposed to cover", () => {
    // A guard that scans zero elements is green forever, so the census comes first: the page had 30
    // form controls at the time this file was written, and the number only has to be a floor.
    expect(controls.length).toBeGreaterThanOrEqual(25);
    const kinds = new Set(controls.map((control) => control.tag));
    expect([...kinds].sort()).toEqual(["input", "select", "textarea"]);
  });

  it("gives each one a non-empty name or id", () => {
    const anonymous = controls.filter((control) => !NAMED.test(control.attributes));
    expect(anonymous.map((control) => `line ${String(control.line)} <${control.tag}> ${control.attributes.replace(/\s+/g, " ").slice(0, 70)}`)).toEqual([]);
  });

  it("does not give two controls the same name", () => {
    // A screen reader or an autofill implementation keys on the name, and the page builds each
    // FormData by hand - so a collision cannot corrupt a request, only make two fields answer to
    // one label. Interpolated names (`capture-role-${index}`) are excluded because their prefix is
    // the same on purpose; only the literal ones are compared.
    const literals = [...source.matchAll(/\bname="([^"]+)"/g)].map((match) => match[1] as string);
    expect(literals.length).toBeGreaterThanOrEqual(6);
    const doubled = literals.filter((name, index) => literals.indexOf(name) !== index);
    expect([...new Set(doubled)].sort()).toEqual([]);
  });

  it("keeps the controls the browser run named among them", () => {
    // The four upload fields and the two checkbox groups were the ones Chrome complained about; a
    // future edit that renames them into a `data-*`-only shape must redden this as well as the guard.
    const upload = controls.filter((control) => control.attributes.includes("data-upload-"));
    expect(upload).toHaveLength(4);
    for (const control of upload) expect(NAMED.test(control.attributes)).toBe(true);
    const claims = controls.filter((control) => /data-(inspect-claim|plan-contract)=/.test(control.attributes));
    expect(claims).toHaveLength(2);
    for (const control of claims) expect(NAMED.test(control.attributes)).toBe(true);
  });
});

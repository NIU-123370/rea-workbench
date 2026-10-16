import type { JsonValue } from "../domain/json-value.ts";

// DESIGN §12.1 / D28: one owner filters everything the workbench itself emits —
// errors, logs, events, audit metadata, diffs, exports — and the same owner runs
// the strict pre-write check on contract bodies and blueprints.
//
// Two rules constrain the implementation more than the wording suggests:
//   * exclusion is structural or declared. A value is dropped because it sits in
//     a known transport-authentication shape, or because the operator declared
//     that literal for this operation. Nothing here guesses from a key called
//     `token`, `secret` or `password`.
//   * an excluded value is neither stored nor hashed, so redaction returns gaps,
//     never digests of secrets, and never renames a canonical field.

export const TRANSPORT_AUTH_HEADER_NAMES = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
] as const;

export type SensitiveDeclaration = {
  // Short-lived operation context. It is never persisted, never part of a
  // request digest, and dropped once the operation's checks are finished.
  declaredValues: readonly string[];
};

export type RedactedText = {
  text: string;
  excludedCount: number;
  // Named, safe facts about what was excluded — never the value itself.
  excludedReasons: string[];
};

export type BlockedReason =
  | "declared-value-present"
  | "transport-auth-structure"
  | "declaration-context-unavailable";

export type PayloadCheck = { ok: true } | { ok: false; code: "SENSITIVE_CONTENT_BLOCKED"; reason: BlockedReason };

function isHeaderPair(value: unknown): value is { name: string; value: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record["name"] === "string" && "value" in record;
}

function transportAuthHeaderNames(): Set<string> {
  return new Set<string>(TRANSPORT_AUTH_HEADER_NAMES);
}

function containsLiteral(haystack: string, needle: string): boolean {
  return needle.length > 0 && haystack.includes(needle);
}

function declaredLiterals(context: SensitiveDeclaration | null): string[] {
  if (context === null) return [];
  return context.declaredValues.filter((value) => value.length > 0);
}

// Free text (log lines, provider stderr, safeDiff strings, error messages).
export function redactText(text: string, context: SensitiveDeclaration | null): RedactedText {
  if (context === null) {
    // §12.1: without the declaration the operation must not proceed silently.
    return { text: "", excludedCount: 1, excludedReasons: ["declaration-context-unavailable"] };
  }
  let output = text;
  const reasons: string[] = [];
  let excluded = 0;
  for (const literal of declaredLiterals(context)) {
    const hits = output.split(literal).length - 1;
    if (hits === 0) continue;
    output = output.split(literal).join("");
    // Counted per occurrence, so "one declaration used twice" is not reported
    // as a single exclusion in the diagnostic.
    excluded += hits;
    reasons.push("explicit-sensitive-value");
  }
  return { text: output, excludedCount: excluded, excludedReasons: [...new Set(reasons)] };
}

// Structured output (job input/error JSON, event payload, audit metadata,
// blueprint payload). Returns the filtered structure or a refusal.
export function redactJsonValue(
  value: JsonValue,
  context: SensitiveDeclaration | null,
): { value: JsonValue; excludedCount: number } {
  let excluded = 0;
  const names = transportAuthHeaderNames();
  const literals = declaredLiterals(context);

  const walk = (input: JsonValue): JsonValue => {
    if (Array.isArray(input)) {
      const items: JsonValue[] = [];
      for (const item of input) {
        if (isHeaderPair(item)) {
          const pair = item as { name: string; value: JsonValue };
          if (names.has(pair.name.toLowerCase())) {
            excluded += 1;
            items.push({ ...pair, value: null });
            continue;
          }
        }
        items.push(walk(item));
      }
      return items;
    }
    if (typeof input === "object" && input !== null) {
      const out: Record<string, JsonValue> = {};
      for (const [key, member] of Object.entries(input)) {
        // Canonical field names and typed discriminators keep their meaning; the
        // key is never renamed and the member is never deleted.
        out[key] = walk(member);
      }
      return out;
    }
    if (typeof input === "string") {
      let text = input;
      for (const literal of literals) {
        if (containsLiteral(text, literal)) {
          text = text.split(literal).join("");
          excluded += 1;
        }
      }
      return text;
    }
    return input;
  };

  return { value: walk(value), excludedCount: excluded };
}

// Strict pre-write gate for content that becomes an approved, digest-bound
// artefact. Refusal is the only correct answer on a hit: silently rewriting an
// approved body while keeping its digest would invalidate the approval.
export function assertPayloadClean(
  value: JsonValue,
  context: SensitiveDeclaration | null,
): PayloadCheck {
  if (context === null) {
    return { ok: false, code: "SENSITIVE_CONTENT_BLOCKED", reason: "declaration-context-unavailable" };
  }
  const scan = JSON.stringify(value);
  for (const literal of declaredLiterals(context)) {
    if (containsLiteral(scan, literal)) {
      return { ok: false, code: "SENSITIVE_CONTENT_BLOCKED", reason: "declared-value-present" };
    }
  }
  if (hasTransportAuthStructure(value, 1)) {
    return { ok: false, code: "SENSITIVE_CONTENT_BLOCKED", reason: "transport-auth-structure" };
  }
  return { ok: true };
}

function hasTransportAuthStructure(value: JsonValue, depth: number): boolean {
  if (depth > 32) return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isHeaderPair(item)) {
        const pair = item as { name: string; value: JsonValue };
        if (
          transportAuthHeaderNames().has(pair.name.toLowerCase()) &&
          typeof pair.value === "string" &&
          pair.value.length > 0
        ) {
          return true;
        }
      }
      if (hasTransportAuthStructure(item, depth + 1)) return true;
    }
    return false;
  }
  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) {
      if (hasTransportAuthStructure(member, depth + 1)) return true;
    }
  }
  return false;
}

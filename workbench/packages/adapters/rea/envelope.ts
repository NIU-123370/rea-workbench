import { reaEvidenceSchema, reaToolErrorSchema } from "../../contracts/rea-evidence.ts";
import type { ReaEvidence, ReaToolError } from "../../contracts/rea-evidence.ts";
import type { Result } from "../../domain/result.ts";
import type { JsonValue } from "../../domain/json-value.ts";

// DESIGN §9: parse MCP replies by their named schema, never by guessing from
// log text. Two rules drive everything here.
//
//   1. An evidence-kind tool's `structuredContent` IS the Evidence record; only
//      `kind === "session"` tools wrap their payload in `{ result: ... }`.
//   2. On `isError: true` REA deletes `structuredContent` before the reply
//      leaves the server, so the typed error is read from the text block — and
//      a missing `structuredContent` is never an empty success.

export type AdapterFailure = {
  code: "REA_CONTRACT_MISMATCH";
  reason:
    | "malformed-result"
    | "missing-content"
    | "unparsable-text"
    | "unknown-success-shape"
    | "unknown-error-shape";
  detail: string;
};

export type ReaToolOutcome =
  | { kind: "evidence"; evidence: ReaEvidence }
  | { kind: "value"; value: JsonValue }
  | {
      kind: "error";
      error: ReaToolError;
      // A failed call can still leave retained Evidence behind (§9 item 4 and
      // A10's partial observation), so the reference is carried, not dropped.
      retainedEvidenceId: string | null;
    };

function fail(reason: AdapterFailure["reason"], detail: string): Result<ReaToolOutcome, AdapterFailure> {
  return { ok: false, error: { code: "REA_CONTRACT_MISMATCH", reason, detail } };
}

function textOf(result: Record<string, unknown>): string | null {
  const content = result["content"];
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0] as Record<string, unknown> | null;
  if (!first || typeof first !== "object") return null;
  return typeof first["text"] === "string" ? first["text"] : null;
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function looksLikeEvidence(candidate: JsonValue): boolean {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    "evidence_id" in candidate
  );
}

export function decodeToolResult(result: unknown): Result<ReaToolOutcome, AdapterFailure> {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return fail("malformed-result", "tool result is not an object");
  }
  const record = result as Record<string, unknown>;
  const text = textOf(record);
  if (text === null) return fail("missing-content", "tool result has no text content block");

  if (record["isError"] === true) {
    const parsed = parseJson(text);
    if (parsed === undefined) return fail("unparsable-text", "error text is not JSON");
    const validated = reaToolErrorSchema.safeParse(parsed);
    if (!validated.success) {
      return fail("unknown-error-shape", "error envelope does not match the named schema");
    }
    const details = validated.data.error.details as Record<string, JsonValue> | undefined;
    const partial = details?.["partial_observation"];
    const retained =
      typeof partial === "object" && partial !== null && !Array.isArray(partial)
        ? (partial as Record<string, JsonValue>)["evidence_id"]
        : undefined;
    return {
      ok: true,
      value: {
        kind: "error",
        error: validated.data.error,
        retainedEvidenceId: typeof retained === "string" ? retained : null,
      },
    };
  }

  const structured = record["structuredContent"];
  const candidate = structured ?? parseJson(text);
  if (candidate === undefined || candidate === null) {
    return fail("unparsable-text", "no structuredContent and text is not JSON");
  }
  if (looksLikeEvidence(candidate as JsonValue)) {
    const validated = reaEvidenceSchema.safeParse(candidate);
    if (!validated.success) {
      return fail("unknown-success-shape", "evidence envelope does not match the named schema");
    }
    return { ok: true, value: { kind: "evidence", evidence: validated.data } };
  }
  // A session-kind reply carries `{ result: ... }`; anything else is an
  // unmodelled shape and must not be reported as success (§9 items 3 and 4).
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    "result" in candidate
  ) {
    return { ok: true, value: { kind: "value", value: candidate as JsonValue } };
  }
  return fail("unknown-success-shape", "reply is neither an evidence envelope nor { result }");
}

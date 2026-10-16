import type { JsonObject, JsonValue } from "../domain/json-value.ts";
import type { NamedErrorCode } from "../contracts/errors.ts";

// One failure shape for every control-plane decision (DESIGN §8). The HTTP
// adapter maps `code` onto a status; nothing downstream may invent a code.

export type GateFailure = {
  code: NamedErrorCode;
  reason: string;
  message: string;
  details: JsonObject;
};

export type Err<T> = { ok: false; error: T };

export function gateFail(
  code: GateFailure["code"],
  reason: string,
  message: string,
  details: JsonObject = {},
): Err<GateFailure> {
  return { ok: false, error: { code, reason, message, details } };
}

// A gate reports the whole reason list, not the first hit: an operator fixing a
// contract or a plan needs every gap at once, and a partial list reads as "one
// more edit will pass".
export function blockedByReasons(
  reasons: readonly string[],
  code: GateFailure["code"],
  subject: string,
): Err<GateFailure> {
  return gateFail(code, reasons[0] ?? "gate-blocked", `${subject} is blocked by the gate`, {
    reasons: [...reasons] as unknown as JsonValue,
    reasonCount: reasons.length,
  });
}

type WireIssue = { path: readonly PropertyKey[]; code?: string; keys?: string[] };

// A strict-object refusal is the interesting one for a caller: it names the field
// that has no place in the request — above all a forged request/response pair or
// an attempt to submit the plan's own denominator.
export function issueNames(issues: readonly WireIssue[]): string[] {
  const named: string[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys" && issue.keys !== undefined) {
      named.push(...issue.keys);
      continue;
    }
    const path = issue.path.map(String).join(".");
    named.push(path === "" ? "<root>" : path);
  }
  return named.slice(0, 8);
}

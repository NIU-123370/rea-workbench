import type { Result } from "../domain/result.ts";
import { gateFail, type GateFailure } from "./gate-failure.ts";

// The one codec for opaque page cursors.
//
// Two §8 routes page (the job list and the inventory), and §8 gives neither a visible key: a
// caller must be able to hand a cursor back, but not to author one. Both cursors are therefore
// the same thing - a few server-chosen fields joined by a character none of them can contain,
// base64url-encoded - so the encoding and its one real trap live here once.
//
// The trap is that base64url decoding is lenient: padding and some alternate spellings
// decode to the same bytes. Accepting anything that decodes would let a string that is *not*
// the one we issued address the row whose bytes it happens to decode to, so a cursor is only
// ours if it re-encodes to the same characters it arrived as.

const CURSOR_SEPARATOR = "|";

export function encodePageCursor(fields: readonly string[]): string {
  return Buffer.from(fields.join(CURSOR_SEPARATOR), "utf8").toString("base64url");
}

// The refusal names the route that asked, because an operator reading a log line wants to
// know which page's cursor was rejected; the codec itself is shared.
export function decodePageCursor(raw: string, expectFields: number, reason: string): Result<string[], GateFailure> {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const parts = decoded.split(CURSOR_SEPARATOR);
  if (parts.length !== expectFields) return refused(reason);
  // The round trip is the check that matters: several different incoming strings decode to
  // these same bytes, and each of them is a different cursor as far as a caller is concerned.
  if (encodePageCursor(parts) !== raw) return refused(reason);
  return { ok: true, value: parts };
}

function refused(reason: string): Result<never, GateFailure> {
  return gateFail("INVALID_INPUT", reason, "the page cursor is not one this server issued");
}

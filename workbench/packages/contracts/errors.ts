import { z } from "zod";

// Named API error codes and their status mapping (DESIGN §8). No handler may
// invent a code or return 200 for an asynchronously failed job.
export const NAMED_ERROR_CODES = [
  "INVALID_INPUT",
  "SESSION_REQUIRED",
  "ACCESS_DENIED",
  "NOT_FOUND",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "STALE_INPUT",
  "EVENT_CURSOR_EXPIRED",
  "RESOURCE_LIMIT",
  "BLUEPRINT_BLOCKED",
  "SAMPLE_UNUSABLE",
  "UNSUPPORTED_FORMAT",
  "SENSITIVE_PROJECTION_UNSUPPORTED",
  "SENSITIVE_CONTENT_BLOCKED",
  "CAPABILITY_UNAVAILABLE",
  "REA_CONTRACT_MISMATCH",
] as const;

export const HTTP_STATUS_BY_ERROR_CODE = {
  INVALID_INPUT: 400,
  SESSION_REQUIRED: 401,
  ACCESS_DENIED: 403,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  STALE_INPUT: 409,
  EVENT_CURSOR_EXPIRED: 409,
  RESOURCE_LIMIT: 413,
  BLUEPRINT_BLOCKED: 422,
  SAMPLE_UNUSABLE: 422,
  UNSUPPORTED_FORMAT: 422,
  SENSITIVE_PROJECTION_UNSUPPORTED: 422,
  SENSITIVE_CONTENT_BLOCKED: 422,
  CAPABILITY_UNAVAILABLE: 503,
  REA_CONTRACT_MISMATCH: 503,
} as const satisfies Record<(typeof NAMED_ERROR_CODES)[number], number>;

export const apiErrorSchema = z.strictObject({
  code: z.enum(NAMED_ERROR_CODES),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.json()),
  requestId: z.string().min(1),
});

export const apiErrorBodySchema = z.strictObject({ error: apiErrorSchema });

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
export type NamedErrorCode = (typeof NAMED_ERROR_CODES)[number];

export type ApiError = z.infer<typeof apiErrorSchema>;

const NAMED_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(NAMED_ERROR_CODES);

// An error code that arrived from another process is data until this says otherwise:
// the HTTP adapter must not turn an unmodelled string into a status code.
export function isNamedErrorCode(value: unknown): value is NamedErrorCode {
  return typeof value === "string" && NAMED_ERROR_CODE_SET.has(value);
}

export function httpStatusFor(code: NamedErrorCode): number {
  return HTTP_STATUS_BY_ERROR_CODE[code];
}

export function makeApiError(
  code: NamedErrorCode,
  input: {
    message: string;
    retryable: boolean;
    details?: ApiError["details"];
    requestId: string;
  },
): ApiError {
  return {
    code,
    message: input.message,
    retryable: input.retryable,
    details: input.details ?? {},
    requestId: input.requestId,
  };
}

// --- What a refusal may say beyond its reason code (§8's ApiError.details, §12.1) -----
//
// Every control-plane service puts numbers into `details` - the byte length that crossed a
// cap, the attempt that spent a budget, the two revisions that disagree. Until now none of
// them reached an operator: the HTTP hop copied `reason` out and dropped the rest, so the
// sentence in `message` was all a page could show.
//
// The way out is a declared list, not a type sweep. `details` is assembled by hand in ~40
// places and grows whenever a service adds one, so a rule like "numbers are always safe to
// forward" would hand every *future* numeric detail an automatic right to leave the process -
// the fail-open shape §14's closed command table and §7.3's allowlisted handoff exist to
// prevent. Adding a key here is the reviewed act; forgetting to is a refusal that reads
// worse than it is, which is the safe direction for a mistake to go.
//
// The value rule is the second condition, not the first: a declared key must still carry a
// number or a boolean. `caseKey` is a safe name carrying whatever string a caller typed, and
// §12.1 is about text. The reverse shape is the one worth naming: `portCode` is a number whose
// value *is* the credential, so the type rule alone would publish a pairing code.
//
// Every key here has a refusal that emits it - the architecture gate reads the source for
// exactly that, because a list of keys nothing produces is a list nobody can check.
export const SAFE_DETAIL_KEYS = [
  // Size and page refusals: an operator has to tell "too big" apart from "not found",
  // and the number is what makes the message actionable.
  "byteLength",
  "limit",
  "maxLimit",
  // Generation budget (§10): what the loop was capped at.
  "maxAttempts",
  // Generation budget (§10): which attempt was refused, and how many the blueprint already spent.
  "attempt",
  "attempts",
  // Revision and cursor conflicts (§8's 409s): both sides of the disagreement, so a stale
  // page is diagnosable without a log read.
  "expected",
  "actual",
  "bound",
  "planGraphRevision",
  "currentGraphRevision",
  "pinnedRevision",
  "currentRevision",
  "latestSeq",
  "oldestSeq",
  "requestedSeq",
  "requested",
  "seq",
  // Counts a gate already published as a named fact (§7.3's reasons list, §7.4's declaration
  // count). The count is the published fact and the list beside it is not: `reasons`, `issues`
  // and `mismatched` are all arrays of names, which is why the value rule is a second condition
  // rather than a comment.
  "reasonCount",
  "declaredCount",
  // §8's own ApiError.retryable: the HTTP layer answers with a status, but the worker's
  // "you may ask again" decision is the worker's and should not be silently invented here.
  "retryable",
] as const;

const SAFE_DETAIL_KEY_SET: ReadonlySet<string> = new Set<string>(SAFE_DETAIL_KEYS);

export function safeFailureDetails(details: Record<string, unknown>): Record<string, number | boolean> {
  const safe: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEY_SET.has(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") safe[key] = value;
  }
  return safe;
}

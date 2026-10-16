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

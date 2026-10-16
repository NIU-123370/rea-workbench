import { apiErrorBodySchema, httpStatusFor, makeApiError } from "../../packages/contracts/errors.ts";
import type { NamedErrorCode } from "../../packages/contracts/errors.ts";
import { parseStrict } from "../../packages/contracts/parse.ts";
import { redactJsonValue, redactText } from "../../packages/application/sanitizer.ts";
import type { SensitiveDeclaration } from "../../packages/application/sanitizer.ts";
import { isId } from "../../packages/domain/identity.ts";
import { isJsonObject } from "../../packages/domain/json-value.ts";
import type { JsonObject, JsonValue } from "../../packages/domain/json-value.ts";
import type { ApiResponse, HttpHeaders } from "./types.ts";

// Every error this API emits is built here, in one function, and nowhere else
// (DESIGN §12.1 names `API error/message/details/requestId` as the filter owner's
// coverage). Two things make that call real rather than decorative:
//   * the declaration the adapter carries for the current request contains the
//     credentials *this request presented* — the pairing code it was handed, the
//     session cookie it arrived with. Anything those literals appear in is removed
//     before the body is written, so no message, detail or log line can repeat a
//     value the caller proved it had.
//   * the finished body is parsed against `apiErrorBodySchema` on the way out, so a
//     body that is not the contract never reaches the socket.

// The codes a client may act on by asking again. `EVENT_CURSOR_EXPIRED` counts as
// retryable because §8 says the recovery is to re-read a snapshot and resubscribe;
// a conflict the caller caused is not.
const RETRYABLE_CODES: readonly NamedErrorCode[] = [
  "SESSION_REQUIRED",
  "EVENT_CURSOR_EXPIRED",
  "CAPABILITY_UNAVAILABLE",
  "REA_CONTRACT_MISMATCH",
  "RESOURCE_LIMIT",
];

export function isRetryable(code: NamedErrorCode): boolean {
  return RETRYABLE_CODES.includes(code);
}

export type FailureInput = {
  code: NamedErrorCode;
  message: string;
  details: JsonObject;
};

function asDetails(value: JsonValue): JsonObject {
  return isJsonObject(value) ? value : {};
}

export function errorResponse(
  requestId: string,
  failure: FailureInput,
  declaration: SensitiveDeclaration,
  extraHeaders: HttpHeaders = [],
): ApiResponse {
  const message = redactText(failure.message, declaration).text;
  const details = asDetails(redactJsonValue(failure.details, declaration).value);
  const checked = parseStrict(apiErrorBodySchema, {
    error: makeApiError(failure.code, {
      message,
      retryable: isRetryable(failure.code),
      details,
      requestId,
    }),
  });
  if (!checked.ok) {
    // If the filtered body does not satisfy the contract, the answer is the named
    // code with a fixed message and no details at all — never the unfiltered body.
    return {
      kind: "response",
      status: httpStatusFor(failure.code),
      headers: jsonHeaders(requestId).concat(extraHeaders),
      body: JSON.stringify({
        error: makeApiError(failure.code, {
          message: "diagnostic_unavailable",
          retryable: isRetryable(failure.code),
          details: {},
          requestId,
        }),
      }),
    };
  }
  return {
    kind: "response",
    status: httpStatusFor(failure.code),
    headers: jsonHeaders(requestId).concat(extraHeaders),
    body: JSON.stringify(checked.value),
  };
}

// `X-Request-Id` is minted by the workbench and returned, never accepted: §12.1 says a
// request id is a random opaque id rather than caller text, so a client cannot put its
// own words into a field that a log will carry.
export function jsonHeaders(requestId: string): HttpHeaders {
  return [
    ["content-type", "application/json; charset=utf-8"],
    ["x-request-id", requestId],
    // A pairing code or session value must not reach a later request through the
    // referer, and none of this is cacheable (§14).
    ["referrer-policy", "no-referrer"],
    ["cache-control", "no-store"],
  ];
}

export function jsonSuccess(
  requestId: string,
  status: number,
  body: JsonValue,
  extraHeaders: HttpHeaders = [],
): ApiResponse {
  return { kind: "response", status, headers: jsonHeaders(requestId).concat(extraHeaders), body: JSON.stringify(body) };
}

export function emptySuccess(requestId: string, status: number, extraHeaders: HttpHeaders = []): ApiResponse {
  return { kind: "response", status, headers: jsonHeaders(requestId).concat(extraHeaders), body: null };
}

export function isOpaqueRequestId(value: string): boolean {
  return isId(value);
}

// An SSE response is not cacheable, not proxied and not buffered: §8's stream carries
// committed state, and a buffered copy of it would read as a second, later commit.
export function streamHeaders(): HttpHeaders {
  return [
    ["content-type", "text/event-stream; charset=utf-8"],
    ["cache-control", "no-store"],
    ["connection", "keep-alive"],
    ["x-accel-buffering", "no"],
    ["referrer-policy", "no-referrer"],
  ];
}

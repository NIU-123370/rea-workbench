import { decideProxy } from "./session-proxy.ts";

// The body of the UI relay (DESIGN §2, §14, issue #18).
//
// It lives here rather than inside `app/api/v1/[...path]/route.ts` for one reason: the
// bracketed directory is Next's route-name convention, and a module path containing it is
// not importable by a test runner. Everything that decides what crosses the boundary is
// therefore in a plain module, and the route file is the thin binding Next asks for.
//
// `decideProxy` makes every decision about a request; this file owns the two values that
// say *where* it may go, and then moves bytes.
//
// `WB_UI_ORIGIN` and `WB_API_ORIGIN` are not in §14's list - the document gives the web
// process `WB_HOST`/`WB_PORT`/`WB_DATA_DIR` and says nothing about the Next shell's config,
// which is issue #119's question. Whatever that answer is, this process dials one address
// and echoes another back as the only Origin it will accept, so both values get the same
// treatment §14 gives every field it does name: refuse a wrong one by name instead of
// using it. The hazard is not hypothetical - `WB_API_ORIGIN=http:4310` parses as a valid
// URL whose host is `0.0.11.184`, and this relay forwards `cookie`, so a typo would send a
// live session to an address nobody typed.

// RFC 9110: these statuses are terminated by the first CRLF, so a Response carrying any body -
// including an empty one - is an invalid construction, not an empty reply.
const STATUSES_WITHOUT_BODY = new Set([101, 204, 304]);

const DEFAULT_ORIGINS = {
  WB_UI_ORIGIN: "http://localhost:3000",
  WB_API_ORIGIN: "http://127.0.0.1:4310",
} as const;

export type RelayOriginField = keyof typeof DEFAULT_ORIGINS;

export type RelayOrigins = { ownOrigin: string; apiOrigin: string };

export type RelayConfig =
  | { ok: true; origins: RelayOrigins }
  | { ok: false; failures: { field: RelayOriginField; reason: string }[] };

// Every rule below exists because `URL.origin` - the only part this relay uses - silently
// *drops* the piece the operator wrote. A path, a query, a fragment and credentials all
// parse, all pass a bare `new URL()` check, and all vanish at `.origin`: the value that gets
// used is not the value that was set, and nothing says so.
export function resolveRelayOrigins(env: Record<string, string | undefined>): RelayConfig {
  const failures: { field: RelayOriginField; reason: string }[] = [];
  const resolved: Partial<Record<RelayOriginField, string>> = {};
  for (const field of Object.keys(DEFAULT_ORIGINS) as RelayOriginField[]) {
    const raw = env[field];
    if (raw === "") {
      failures.push({ field, reason: "present-but-empty" });
      continue;
    }
    const value = raw ?? DEFAULT_ORIGINS[field];
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      failures.push({ field, reason: "absolute-url-required" });
      continue;
    }
    if (!value.includes("://")) {
      // `localhost:3000` and `http:4310` both parse; the second becomes host `0.0.11.184`.
      failures.push({ field, reason: "scheme-and-authority-required" });
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      failures.push({ field, reason: "scheme-must-be-http-or-https" });
      continue;
    }
    const dropped =
      url.pathname !== "/" ? "origin-must-not-carry-a-path"
      : url.username !== "" || url.password !== "" ? "origin-must-not-carry-credentials"
      : url.search !== "" ? "origin-must-not-carry-a-query"
      : url.hash !== "" ? "origin-must-not-carry-a-fragment"
      : null;
    if (dropped !== null) {
      failures.push({ field, reason: dropped });
      continue;
    }
    resolved[field] = url.origin;
  }
  const ownOrigin = resolved["WB_UI_ORIGIN"];
  const apiOrigin = resolved["WB_API_ORIGIN"];
  if (failures.length > 0 || ownOrigin === undefined || apiOrigin === undefined) return { ok: false, failures };
  return { ok: true, origins: { ownOrigin, apiOrigin } };
}

// The API sets all of these itself, and a proxy that silently drops two of them turns a
// `no-store` session answer into something the browser may keep: `cache-control` and
// `referrer-policy` are decisions (§12.1, §14), not transport noise.
export const RELAYED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "referrer-policy",
  "x-request-id",
  "x-rea-export-sha256",
  "retry-after",
  "last-event-id",
  "x-accel-buffering",
] as const;

function flatHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

// Next calls a route handler with the request and a context object; the matched path
// segments live at `context.params`, which is a promise in the App Router. Reading them
// off the context itself rather than from `context.params` yields zero segments and so
// refuses every browser request with a named reason - a shape only a running server shows,
// which is how the browser pass found it (issue #18).
export type RelayContext = {
  params?: Promise<{ path?: string[] } | undefined> | { path?: string[] | undefined } | undefined;
};

export async function relay(request: Request, context: RelayContext): Promise<Response> {
  // Read per call, not at import: an import-time constant made the refusal path impossible to
  // exercise from a test (the value was fixed before the runner could set it), and two `new URL`
  // parses per request is not what a page load is waiting on.
  const config = resolveRelayOrigins(process.env);
  // A mis-set origin is this process's condition, not something the caller did, so it is a 503
  // with the field named - not the 403 an unparseable `apiOrigin` looked like while every
  // request was being refused one at a time with `proxy-url-unparseable`.
  if (!config.ok) {
    return Response.json(
      {
        error: {
          code: "CAPABILITY_UNAVAILABLE",
          message: "the UI relay is not configured",
          details: { reason: config.failures.map((failure) => `${failure.field}:${failure.reason}`).join(",") },
        },
      },
      { status: 503 },
    );
  }
  const { ownOrigin, apiOrigin } = config.origins;
  const resolved = await context.params;
  const segments = resolved?.path ?? [];
  const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
  const body = request.method === "GET" ? null : await request.arrayBuffer();
  const bodyBytes = body === null ? 0 : body.byteLength;
  const decided = decideProxy({
    requestUrl: `http://placeholder/api/v1/${path}${new URL(request.url).search}`,
    method: request.method,
    headers: flatHeaders(request),
    ownOrigin,
    apiOrigin,
    bodyBytes,
  });
  if (!decided.ok) {
    return Response.json(
      { error: { code: "ACCESS_DENIED", message: "the UI proxy refused the request", details: { reason: decided.reason } } },
      { status: 403 },
    );
  }
  const upstream = await fetch(decided.targetUrl, {
    method: request.method,
    headers: decided.headers,
    ...(body === null ? {} : { body }),
  });

  const headers = new Headers();
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const value of upstream.headers.getSetCookie()) headers.append("set-cookie", value);

  // The events route never finishes, so reading it to the end here would hold the
  // browser's first frame until the worker stopped. Anything else is a body with a
  // known length and goes through the buffer, which is what lets the digest header
  // above be copied after the bytes rather than around them.
  if ((headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  // A status that may not carry a body must be relayed with `null`: the Response constructor throws
  // on *any* body, an empty ArrayBuffer included, so §8 line 267's 204 came back to the browser as a
  // 500. Nothing caught it before because nothing had ever pushed a 204 through this file - the revoke
  // door was mounted and tested at the API, but had no caller on the page until issue #58's fourth box.
  if (STATUSES_WITHOUT_BODY.has(upstream.status)) {
    return new Response(null, { status: upstream.status, headers });
  }
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
}

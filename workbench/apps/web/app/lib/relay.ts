import { decideProxy } from "./session-proxy.ts";

// The body of the UI relay (DESIGN §2, §14, issue #18).
//
// It lives here rather than inside `app/api/v1/[...path]/route.ts` for one reason: the
// bracketed directory is Next's route-name convention, and a module path containing it is
// not importable by a test runner. Everything that decides what crosses the boundary is
// therefore in a plain module, and the route file is the thin binding Next asks for.
//
// `decideProxy` makes every decision; this file only moves bytes.

const API_ORIGIN = process.env.WB_API_ORIGIN ?? "http://127.0.0.1:4310";
const OWN_ORIGIN = process.env.WB_UI_ORIGIN ?? "http://localhost:3000";

export const RELAYED_ORIGINS = { api: API_ORIGIN, own: OWN_ORIGIN } as const;

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
  const resolved = await context.params;
  const segments = resolved?.path ?? [];
  const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
  const body = request.method === "GET" ? null : await request.arrayBuffer();
  const bodyBytes = body === null ? 0 : body.byteLength;
  const decided = decideProxy({
    requestUrl: `http://placeholder/api/v1/${path}${new URL(request.url).search}`,
    method: request.method,
    headers: flatHeaders(request),
    ownOrigin: OWN_ORIGIN,
    apiOrigin: API_ORIGIN,
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
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
}

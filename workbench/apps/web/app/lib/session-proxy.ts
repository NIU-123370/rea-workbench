// The browser-facing policy of the UI proxy (DESIGN §2, §14 / issue #18).
//
// The API owns sessions, CSRF and the strict Host/Origin pair (§14), and its cookie is
// `HttpOnly; SameSite=Strict` on its own host. A page served from another port therefore
// cannot present that cookie to it directly — so this proxy forwards what the browser
// already holds, on the browser's own behalf, and keeps the authority checks where they
// belong: it never mints a session, never adds a header the caller did not present, and
// refuses anything that is not this app's own read or create route.
//
// Kept pure and separate from the route handler so every one of those refusals is a unit
// test rather than a live-server fixture.

export const PROXY_PREFIX = "/api/v1";
export const ALLOWED_METHODS = ["GET", "POST", "DELETE"] as const;
export const MAX_PROXIED_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PATH_SEGMENTS = 8;

// The only request headers that cross the boundary. Each one is a credential or directive
// the API itself defined; everything else — including a caller-supplied `host` or
// `authorization` — is dropped rather than forwarded.
export const FORWARDED_HEADERS = [
  "cookie",
  "x-csrf-token",
  "idempotency-key",
  "content-type",
  "accept",
  "last-event-id",
] as const;

// `origin` is deliberately absent from the list above: a caller must not be able to hand
// this proxy an Origin and have it relayed. State changes get an Origin anyway, because
// the API's §14 gate compares the value against its *own* listen address, and the only
// address this relay is allowed to talk to is the configured API origin. So the proxy
// writes that value itself, after having refused any request whose own Origin or Referer
// was not this app's - which is where the browser-facing half of the same-source rule
// actually lives once a page and an API sit on different ports.
const STATED_ORIGIN_METHODS = ["POST", "DELETE"];

export type ProxyDecision =
  | { ok: true; targetUrl: string; headers: [string, string][] }
  | { ok: false; reason: string };

function normalizeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function decideProxy(input: {
  requestUrl: string;
  method: string;
  headers: Readonly<Record<string, string | undefined>>;
  ownOrigin: string;
  apiOrigin: string;
  bodyBytes?: number;
}): ProxyDecision {
  const method = input.method.toUpperCase();
  if (!ALLOWED_METHODS.includes(method as (typeof ALLOWED_METHODS)[number])) {
    return { ok: false, reason: `proxy-method-not-allowed:${method}` };
  }
  const api = normalizeUrl(input.apiOrigin);
  const own = normalizeUrl(input.ownOrigin);
  const request = normalizeUrl(input.requestUrl);
  if (api === null || own === null || request === null) return { ok: false, reason: "proxy-url-unparseable" };

  // A page on another site must not be able to turn this proxy into a request smuggler
  // against the local API. Same-origin only, and the check is on the browser's own
  // Origin value, never on something a caller can rename.
  const presented = input.headers["origin"];
  if (presented !== undefined && presented !== own.origin) return { ok: false, reason: "proxy-origin-mismatch" };
  const referer = input.headers["referer"];
  if (referer !== undefined && normalizeUrl(referer)?.origin !== own.origin) {
    return { ok: false, reason: "proxy-referer-mismatch" };
  }

  if (!request.pathname.startsWith(`${PROXY_PREFIX}/`)) return { ok: false, reason: "proxy-prefix-missing" };
  const segments = request.pathname.slice(PROXY_PREFIX.length + 1).split("/").filter((part) => part.length > 0);
  if (segments.length === 0 || segments.length > MAX_PATH_SEGMENTS) {
    return { ok: false, reason: `proxy-path-depth:${String(segments.length)}` };
  }
  // `%2e%2e` and friends survive into the pathname here, so the segments themselves are
  // checked rather than the joined string: a proxy that will forward `..` can walk out of
  // the API's own route table.
  if (segments.some((part) => part === ".." || part === "." || part.includes("%2f") || part.includes("%2F"))) {
    return { ok: false, reason: "proxy-path-traversal" };
  }
  const forwarded = (input.bodyBytes ?? 0) > MAX_PROXIED_BODY_BYTES ? MAX_PROXIED_BODY_BYTES + 1 : (input.bodyBytes ?? 0);
  if (forwarded > MAX_PROXIED_BODY_BYTES) return { ok: false, reason: "proxy-body-too-large" };

  const headers: [string, string][] = [];
  for (const name of FORWARDED_HEADERS) {
    const value = input.headers[name];
    if (value !== undefined) headers.push([name, value]);
  }
  if (STATED_ORIGIN_METHODS.includes(method)) headers.push(["origin", api.origin]);
  return { ok: true, targetUrl: `${api.origin}${PROXY_PREFIX}/${segments.join("/")}${request.search}`, headers };
}

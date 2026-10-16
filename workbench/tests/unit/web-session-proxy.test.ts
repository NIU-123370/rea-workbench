import { describe, expect, it } from "vitest";

import { decideProxy, FORWARDED_HEADERS, MAX_PROXIED_BODY_BYTES } from "../../apps/web/app/lib/session-proxy.ts";

// The UI proxy's decision function (DESIGN §14 / issue #18).
//
// The proxy exists so a browser session can reach the local API from the page's own
// origin. Everything that could turn it into a general request forwarder is refused here,
// and each refusal is its own case: the dangerous behaviours are one-line edits away.

const OWN = "http://localhost:3000";
const API = "http://127.0.0.1:4310";

function decide(input: Partial<Parameters<typeof decideProxy>[0]> = {}) {
  return decideProxy({
    requestUrl: "http://localhost:3000/api/v1/projects/abc/graph",
    method: "GET",
    headers: {},
    ownOrigin: OWN,
    apiOrigin: API,
    ...input,
  });
}

describe("what the proxy forwards", () => {
  it("carries only the headers the API itself defined", () => {
    const decided = decide({
      method: "POST",
      bodyBytes: 12,
      headers: {
        origin: OWN,
        cookie: "wb_session=opaque",
        "x-csrf-token": "token",
        "idempotency-key": "key",
        "content-type": "application/json",
        // Anything the API did not define is dropped rather than forwarded: an
        // `authorization` or a made-up control header crossing the boundary would let a
        // page speak to the API with credentials this proxy was never given.
        authorization: "Bearer stolen",
        "x-instructed-to-write": "yes",
      },
    });
    if (!decided.ok) throw new Error("the request should have been forwarded");
    expect(decided.headers.map(([name]) => name)).toEqual([
      "cookie",
      "x-csrf-token",
      "idempotency-key",
      "content-type",
      "origin",
    ]);
    // `origin` is the one header this relay writes rather than relays, and it is written
    // for a state change only.
    expect(decided.headers.filter(([name]) => name === "origin")).toEqual([["origin", API]]);
    expect(decided.headers.some(([name]) => name === "authorization")).toBe(false);
    // Nothing outside the declared list crosses, with the one written header above.
    expect(
      decided.headers.every(
        ([name]) => (FORWARDED_HEADERS as readonly string[]).includes(name) || name === "origin",
      ),
    ).toBe(true);
  });

  it("writes the API's own origin for a state change instead of relaying the page's", () => {
    // The API's §14 gate compares Origin against its own listen address, and the page
    // lives on another port. So a relayed `http://localhost:3000` would fail every real
    // POST, while a relayed caller-supplied value would be a header the API could be
    // told to believe. Neither is what happens: the value is the configured API origin.
    for (const method of ["POST", "DELETE"]) {
      const decided = decide({ method, bodyBytes: 4, headers: { origin: OWN, host: "attacker.example" } });
      if (!decided.ok) throw new Error(`${method} should have been forwarded`);
      expect(decided.headers.filter(([name]) => name === "origin")).toEqual([["origin", API]]);
      expect(decided.headers.some(([name]) => name === "host")).toBe(false);
    }
    // A read needs no origin assertion, and sending one would only invent a credential.
    const read = decide({ headers: { origin: OWN } });
    if (!read.ok) throw new Error("the request should have been forwarded");
    expect(read.headers.map(([name]) => name)).not.toContain("origin");
  });

  it("keeps the path and query as one address on the configured API", () => {
    const decided = decide({ requestUrl: "http://localhost:3000/api/v1/projects/abc/exports?limit=5" });
    if (!decided.ok) throw new Error("the request should have been forwarded");
    expect(decided.targetUrl).toBe(`${API}/api/v1/projects/abc/exports?limit=5`);
  });

  it("allows exactly the three methods the routes use", () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      expect(decide({ method }).ok, method).toBe(true);
    }
    for (const method of ["PUT", "PATCH", "OPTIONS", "HEAD", "TRACE"]) {
      const refused = decide({ method });
      expect(refused.ok, method).toBe(false);
      if (refused.ok) continue;
      expect(refused.reason).toBe(`proxy-method-not-allowed:${method}`);
    }
  });
});

describe("what the proxy refuses", () => {
  it("refuses a foreign page making the request", () => {
    expect(decide({ headers: { origin: "http://evil.example" } })).toEqual({ ok: false, reason: "proxy-origin-mismatch" });
    expect(decide({ headers: { referer: "http://evil.example/page" } })).toEqual({ ok: false, reason: "proxy-referer-mismatch" });
    // The page's own origin, and a request with no browser at all, are both fine.
    expect(decide({ headers: { origin: OWN } }).ok).toBe(true);
    expect(decide({ headers: { referer: `${OWN}/project/abc` } }).ok).toBe(true);
  });

  it("refuses anything that is not this app's API path", () => {
    expect(decide({ requestUrl: "http://localhost:3000/health" })).toEqual({ ok: false, reason: "proxy-prefix-missing" });
    expect(decide({ requestUrl: "http://localhost:3000/api/v1" })).toEqual({ ok: false, reason: "proxy-prefix-missing" });
    expect(decide({ requestUrl: "http://localhost:3000/api/v1/" })).toEqual({ ok: false, reason: "proxy-path-depth:0" });
    expect(decide({ requestUrl: "http://localhost:3000/api/v1/a/b/c/d/e/f/g/h/i" })).toEqual({ ok: false, reason: "proxy-path-depth:9" });
  });

  it("never forwards a resolved path that leaves the API prefix", () => {
    // Some of these are refused by name and some are normalised away first, which is
    // still a refusal or a path that stayed inside the prefix. What must never happen is
    // a forwarded address containing a dot segment or escaping `/api/v1`.
    const hostile = [
      "http://localhost:3000/api/v1/../secret",
      "http://localhost:3000/api/v1/./projects",
      "http://localhost:3000/api/v1/a%2f../../b",
      "http://localhost:3000/api/v1/a%2Fb",
      "http://localhost:3000/api/v1/../../etc/passwd",
      "http://localhost:3000/api/v1/projects/abc/../../downloads",
    ];
    for (const url of hostile) {
      const decided = decide({ requestUrl: url });
      if (!decided.ok) continue;
      const path = new URL(decided.targetUrl).pathname;
      expect(path.startsWith("/api/v1/"), `${url} -> ${path}`).toBe(true);
      expect(path.split("/"), path).not.toContain("..");
      expect(decodeURIComponent(path), path).not.toContain("/../");
    }
  });

  it("refuses a body bigger than the frame budget, and an unparseable address", () => {
    expect(decide({ method: "POST", bodyBytes: MAX_PROXIED_BODY_BYTES + 1 })).toEqual({ ok: false, reason: "proxy-body-too-large" });
    expect(decide({ bodyBytes: MAX_PROXIED_BODY_BYTES }).ok).toBe(true);
    expect(decide({ apiOrigin: "not a url" })).toEqual({ ok: false, reason: "proxy-url-unparseable" });
    expect(decide({ requestUrl: "http://[/" })).toEqual({ ok: false, reason: "proxy-url-unparseable" });
  });
});

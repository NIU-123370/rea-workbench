import { afterEach, describe, expect, it, vi } from "vitest";

import { relay, resolveRelayOrigins } from "../../apps/web/app/lib/relay.ts";

// The Next relay route (DESIGN §2, §14 / issue #18).
//
// `decideProxy` is unit-tested and `startWebServer` is integration-tested, but the file
// between them - the one that turns a `Request` into a decision and a decision into bytes
// on the wire - is what an operator's browser actually crosses. Driven here with the real
// global `Response`/`Headers` and a stubbed upstream, so a buffered event stream or a
// dropped `set-cookie` is a red test rather than a page that hangs.

// These are the relay's own defaults: §14's documented loopback pair is what an operator gets
// without configuring either, and `resolveRelayOrigins({})` now proves it rather than asserting
// a constant nobody but this file used. If the defaults move, the assertions below move with
// them and say so loudly.
const UI_ORIGIN = "http://localhost:3000";
const API_ORIGIN = "http://127.0.0.1:4310";

function browserRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`${UI_ORIGIN}/api/v1/${path}`, init);
}

// The shape Next hands a route handler: a context object whose `params` is a promise.
// A test double that passed the segments directly would have kept the bug this file now
// pins (issue #18's browser pass found it as `proxy-path-depth:0` on every request).
function paramsFor(path: string | string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path: typeof path === "string" ? path.split("/") : path }) };
}

type Upstream = {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array | ReadableStream | null;
};

function stubUpstream(reply: Upstream): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(reply.body, { status: reply.status, headers: reply.headers });
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the relay's refusals", () => {
  it("answers a dot-dot path with a named proxy reason and never reaches the API", async () => {
    const upstream = stubUpstream({ status: 200, headers: {}, body: "should-not-be-read" });
    const response = await relay(browserRequest("../../etc/passwd"), paramsFor("../../etc/passwd"));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("ACCESS_DENIED");
    // The reason is named and safe: no host path, no echo of what was asked for.
    expect(body.error.details.reason).toBe("proxy-prefix-missing");
    expect(JSON.stringify(body)).not.toContain("etc/passwd");
    expect(upstream.calls).toEqual([]);
  });

  it("re-encodes a segment so an embedded delimiter cannot widen the route", async () => {
    const upstream = stubUpstream({ status: 200, headers: { "content-type": "application/json" }, body: "{}" });
    // One segment holding an encoded slash. The relay encodes the percent itself, so the
    // API still sees three segments and its own route table stays the only matcher.
    await relay(browserRequest("projects/a%2Fb/graph"), paramsFor(["projects", "a%2Fb", "graph"]));
    const url = upstream.calls[0]?.url;
    if (url === undefined) throw new Error("the relay never contacted the API");
    expect(new URL(url).pathname.split("/")).toEqual(["", "api", "v1", "projects", "a%252Fb", "graph"]);
  });

  it("answers a foreign page's origin without contacting the API", async () => {
    const upstream = stubUpstream({ status: 200, headers: {}, body: "should-not-be-read" });
    const response = await relay(
      browserRequest("projects/abc/exports", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
      }),
      paramsFor("projects/abc/exports"),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("proxy-origin-mismatch");
    expect(upstream.calls).toEqual([]);
  });
});

describe("the relay's copies", () => {
  it("carries the declared headers and cookies through to the API", async () => {
    const upstream = stubUpstream({ status: 201, headers: { "content-type": "application/json", "x-request-id": "req-1" }, body: '{"ok":true}' });
    const response = await relay(
      browserRequest("session", {
        method: "POST",
        body: JSON.stringify({ bootstrapToken: "code" }),
        headers: { "content-type": "application/json", cookie: "wb_session=opaque", "x-csrf-token": "token", host: "attacker.example" },
      }),
      paramsFor("session"),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    const call = upstream.calls[0];
    if (call === undefined) throw new Error("the relay never contacted the API");
    expect(call.url).toBe(`${API_ORIGIN}/api/v1/session`);
    const sent = new Map((call.init.headers as [string, string][]).map(([name, value]) => [name.toLowerCase(), value]));
    expect(sent.get("cookie")).toBe("wb_session=opaque");
    expect(sent.get("x-csrf-token")).toBe("token");
    // The page's origin is rewritten to the API's own, and a caller-supplied Host is not
    // relayed at all - undici sets it from the target URL.
    expect(sent.get("origin")).toBe(API_ORIGIN);
    expect(sent.has("host")).toBe(false);
    expect(upstream.calls).toHaveLength(1);
  });

  it("replays a set-cookie from the API onto the browser's own host", async () => {
    stubUpstream({
      status: 201,
      headers: {
        "content-type": "application/json",
        "set-cookie": "wb_session=opaque; HttpOnly; SameSite=Strict; Path=/",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-request-id": "req-2",
      },
      body: '{"ok":true}',
    });
    const response = await relay(
      browserRequest("session", { method: "POST", body: "{}", headers: { "content-type": "application/json", origin: UI_ORIGIN } }),
      paramsFor("session"),
    );
    expect(response.headers.getSetCookie()).toEqual(["wb_session=opaque; HttpOnly; SameSite=Strict; Path=/"]);
    // Two decisions the API made that a proxy would otherwise quietly undo: a session
    // answer the browser is allowed to cache, and a referer that can carry a path id.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-request-id")).toBe("req-2");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("does not buffer an event stream: the first frame arrives while the response is still open", async () => {
    // A stream that pushes one frame and then goes quiet. If the relay read the body to
    // the end before replying, this test would sit until the timeout rather than fail an
    // assertion - which is exactly the bug the passthrough exists to prevent.
    const quiet = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("id: 1\nevent: job.updated\ndata: {}\n\n"));
      },
    });
    stubUpstream({ status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" }, body: quiet });
    const response = await relay(browserRequest("projects/abc/events?after=0"), paramsFor("projects/abc/events"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("the relay dropped the stream body");
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the relay buffered the event stream")), 500)),
    ]);
    expect(new TextDecoder().decode(first.value)).toContain("event: job.updated");
    reader.cancel().catch(() => undefined);
  });

  it("keeps the query string on the target address", async () => {
    const upstream = stubUpstream({ status: 200, headers: { "content-type": "application/json" }, body: "[]" });
    await relay(browserRequest("projects/abc/exports?limit=5"), paramsFor("projects/abc/exports"));
    expect(upstream.calls[0]?.url).toBe(`${API_ORIGIN}/api/v1/projects/abc/exports?limit=5`);
  });

  it("relays to the documented loopback pair when the operator configured neither", () => {
    // The assertions above speak to these two addresses, so the tie to §14's defaults is
    // stated rather than assumed: a changed default has to fail here first. It goes through
    // the resolver now - the export this used to read had only this file as its caller.
    expect(resolveRelayOrigins({})).toEqual({ ok: true, origins: { ownOrigin: UI_ORIGIN, apiOrigin: API_ORIGIN } });
  });
});

describe("the relay's own configuration", () => {
  // `URL.origin` - the only part this relay uses of what the operator sets - silently drops a
  // path, a query, a fragment and credentials. Each rule below exists because "it parsed" is
  // not "it means what you wrote": `WB_API_ORIGIN=http:4310` parses, and its host comes back
  // `0.0.11.184` - on the far side of a `cookie` header this relay forwards.
  const refused = (field: string, value: string, reason: string) =>
    expect(resolveRelayOrigins({ [field]: value }), `${field}=${value}`).toEqual({ ok: false, failures: [{ field, reason }] });

  it("refuses an empty value instead of quietly using the default", () => {
    refused("WB_API_ORIGIN", "", "present-but-empty");
    refused("WB_UI_ORIGIN", "", "present-but-empty");
  });

  it("refuses a value that is not a URL at all", () => {
    refused("WB_API_ORIGIN", "127.0.0.1:4310", "absolute-url-required");
  });

  it("refuses a scheme without an authority, whose host URL invents from the remainder", () => {
    refused("WB_API_ORIGIN", "http:4310", "scheme-and-authority-required");
    refused("WB_UI_ORIGIN", "https:3000", "scheme-and-authority-required");
  });

  it("refuses a scheme this relay cannot speak", () => {
    refused("WB_UI_ORIGIN", "ws://localhost:3000", "scheme-must-be-http-or-https");
  });

  it("names each part that URL.origin would drop on the floor", () => {
    refused("WB_API_ORIGIN", "http://127.0.0.1:4310/evil", "origin-must-not-carry-a-path");
    refused("WB_API_ORIGIN", "http://user:pass@127.0.0.1:4310", "origin-must-not-carry-credentials");
    refused("WB_API_ORIGIN", "http://127.0.0.1:4310?next=1", "origin-must-not-carry-a-query");
    refused("WB_API_ORIGIN", "http://127.0.0.1:4310#frag", "origin-must-not-carry-a-fragment");
  });

  it("accepts the trailing slash an operator would otherwise be punished for", () => {
    expect(resolveRelayOrigins({ WB_API_ORIGIN: "http://127.0.0.1:4310/" })).toEqual({
      ok: true,
      origins: { ownOrigin: UI_ORIGIN, apiOrigin: API_ORIGIN },
    });
  });

  it("reports both fields when both are wrong, and names which is which", () => {
    expect(resolveRelayOrigins({ WB_UI_ORIGIN: "", WB_API_ORIGIN: "http://127.0.0.1:4310/evil" })).toEqual({
      ok: false,
      failures: [
        { field: "WB_UI_ORIGIN", reason: "present-but-empty" },
        { field: "WB_API_ORIGIN", reason: "origin-must-not-carry-a-path" },
      ],
    });
  });

  it("answers a mis-set relay with 503 and the field named, and never dials", async () => {
    const upstream = stubUpstream({ status: 200, headers: {}, body: "must-not-be-reached" });
    vi.stubEnv("WB_API_ORIGIN", "http:4310");
    const response = await relay(browserRequest("projects"), paramsFor("projects"));
    expect(response.status).toBe(503);
    expect(upstream.calls).toHaveLength(0);
    const body = (await response.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(body.error.details.reason).toBe("WB_API_ORIGIN:scheme-and-authority-required");
  });

  it("keeps the empty-value refusal visible at the door, not just in the resolver", async () => {
    // Without a stubbed upstream a regression that dialled anyway would reach the network.
    const upstream = stubUpstream({ status: 200, headers: {}, body: "must-not-be-reached" });
    vi.stubEnv("WB_UI_ORIGIN", "");
    const response = await relay(browserRequest("projects"), paramsFor("projects"));
    expect(response.status).toBe(503);
    expect(upstream.calls).toHaveLength(0);
    const body = (await response.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("WB_UI_ORIGIN:present-but-empty");
  });
});

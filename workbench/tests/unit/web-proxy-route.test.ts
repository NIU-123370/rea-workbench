import { afterEach, describe, expect, it, vi } from "vitest";

import { RELAYED_ORIGINS, relay } from "../../apps/web/app/lib/relay.ts";

// The Next relay route (DESIGN §2, §14 / issue #18).
//
// `decideProxy` is unit-tested and `startWebServer` is integration-tested, but the file
// between them - the one that turns a `Request` into a decision and a decision into bytes
// on the wire - is what an operator's browser actually crosses. Driven here with the real
// global `Response`/`Headers` and a stubbed upstream, so a buffered event stream or a
// dropped `set-cookie` is a red test rather than a page that hangs.

// These are the route module's own defaults: `WB_UI_ORIGIN`/`WB_API_ORIGIN` are read at
// import time, so a test cannot set them, and §14's documented loopback pair is what an
// operator gets without configuring either. If the defaults move, this test moves with
// them and says so loudly.
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
    // stated rather than assumed: a changed default has to fail here first.
    expect(RELAYED_ORIGINS).toEqual({ api: API_ORIGIN, own: UI_ORIGIN });
  });
});

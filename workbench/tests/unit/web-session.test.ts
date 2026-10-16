import { describe, expect, it } from "vitest";

import {
  BootstrapTokenVault,
  CSRF_HEADER_NAME,
  SessionService,
  clearingCookieHeader,
  csrfMatches,
  hostAllowed,
  originAllowed,
  originOf,
  readCookie,
  sessionCookieHeader,
  SESSION_COOKIE_NAME,
} from "../../packages/application/session.ts";

// The pairing half of DESIGN §14 / D30 (issue #17): a code that exists once, a cookie
// that carries nothing but a handle, and a same-origin test that never resolves a
// name to decide locality.

const ADDRESS = { host: "127.0.0.1", port: 4310, secure: false };
const NOW = 1_700_000_000_000;

describe("the one-time bootstrap code (§14)", () => {
  it("consumes a code whether or not it was still live", () => {
    const vault = new BootstrapTokenVault();
    const code = vault.mint(NOW, 1_000);
    expect(vault.activeCount()).toBe(1);
    const first = vault.redeem(code.token, NOW);
    expect(first.ok).toBe(true);
    expect(vault.activeCount()).toBe(0);
    // A second presentation of the same value is `unknown`, not `expired`: the
    // distinction matters because a replay must not look like a clock problem.
    expect(vault.redeem(code.token, NOW)).toEqual({ ok: false, error: "unknown" });
  });

  it("destroys an expired code on contact", () => {
    const vault = new BootstrapTokenVault();
    const code = vault.mint(NOW, 1_000);
    expect(vault.redeem(code.token, NOW + 5_000)).toEqual({ ok: false, error: "expired" });
    expect(vault.activeCount()).toBe(0);
  });

  it("refuses an absent value without treating it as a guessable miss", () => {
    const vault = new BootstrapTokenVault();
    vault.mint(NOW);
    expect(vault.redeem("", NOW)).toEqual({ ok: false, error: "absent" });
    expect(vault.activeCount()).toBe(1);
  });

  it("supersedes the previous code instead of accumulating live ones", () => {
    const vault = new BootstrapTokenVault();
    const first = vault.mint(NOW);
    const second = vault.mint(NOW + 1);
    expect(vault.activeCount()).toBe(1);
    expect(vault.redeem(first.token, NOW + 2).ok).toBe(false);
    expect(vault.redeem(second.token, NOW + 2).ok).toBe(true);
  });

  it("never carries the code in a value a session could hand back", () => {
    const vault = new BootstrapTokenVault();
    const code = vault.mint(NOW);
    const sessions = new SessionService();
    const session = sessions.mint(NOW);
    expect(session.sessionKey).not.toBe(code.token);
    expect(session.csrfToken).not.toBe(code.token);
    expect(JSON.stringify(session)).not.toContain(code.token);
  });
});

describe("the session and its cookie (§14)", () => {
  it("drops an expired session and reports it as absent", () => {
    const sessions = new SessionService();
    const session = sessions.mint(NOW, 1_000);
    expect(sessions.resolve(session.sessionKey, NOW)).not.toBeNull();
    expect(sessions.resolve(session.sessionKey, NOW + 5_000)).toBeNull();
    expect(sessions.activeCount()).toBe(0);
  });

  it("revokes one session and then all of them", () => {
    const sessions = new SessionService();
    const a = sessions.mint(NOW);
    const b = sessions.mint(NOW);
    expect(sessions.activeCount()).toBe(2);
    expect(sessions.revoke(a.sessionKey)).toBe(true);
    expect(sessions.resolve(a.sessionKey, NOW)).toBeNull();
    // Revoking one caller's session leaves the other live: `revoke` is per key, and
    // only `revokeAll` (a restart) takes everything.
    expect(sessions.resolve(b.sessionKey, NOW)).not.toBeNull();
    expect(sessions.revokeAll()).toBe(1);
    expect(sessions.activeCount()).toBe(0);
  });

  it("always sets HttpOnly, SameSite=Strict and Path=/", () => {
    const sessions = new SessionService();
    const session = sessions.mint(NOW);
    const header = sessionCookieHeader(session, ADDRESS).header;
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    // Loopback V0.1 is plain HTTP: Secure is a decision with an owner, not a habit.
    expect(header).not.toContain("Secure");
    const tls = sessionCookieHeader(session, { ...ADDRESS, secure: true }).header;
    expect(tls).toContain("Secure");
  });

  it("clears a cookie by expiring it rather than by dropping the header", () => {
    const header = clearingCookieHeader({ name: SESSION_COOKIE_NAME, secure: false });
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
    expect(header.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
  });

  it("reads only the named cookie and cannot be shadowed by a later pair", () => {
    const presented = `other=1; ${SESSION_COOKIE_NAME}=good; ${SESSION_COOKIE_NAME}=forged`;
    expect(readCookie(presented, SESSION_COOKIE_NAME)).toBe("good");
    expect(readCookie("other=1", SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie(undefined, SESSION_COOKIE_NAME)).toBeNull();
  });
});

describe("host, origin and CSRF (§14)", () => {
  it("accepts only the literal loopback address with the bound port", () => {
    expect(hostAllowed("127.0.0.1:4310", ADDRESS)).toBe(true);
    // A name is resolved by the browser, not by this check: accepting `localhost`
    // would put DNS in the middle of a security decision.
    expect(hostAllowed("localhost:4310", ADDRESS)).toBe(false);
    expect(hostAllowed("127.0.0.1:4311", ADDRESS)).toBe(false);
    expect(hostAllowed("127.0.0.1", ADDRESS)).toBe(false);
    expect(hostAllowed(undefined, ADDRESS)).toBe(false);
    expect(hostAllowed("127.0.0.1:4310", { ...ADDRESS, host: "0.0.0.0" })).toBe(false);
  });

  it("requires an exact same-origin claim and treats null as no claim", () => {
    expect(originOf(ADDRESS)).toBe("http://127.0.0.1:4310");
    expect(originAllowed("http://127.0.0.1:4310", ADDRESS)).toBe(true);
    expect(originAllowed("http://evil.example", ADDRESS)).toBe(false);
    expect(originAllowed("null", ADDRESS)).toBe(false);
    expect(originAllowed(undefined, ADDRESS)).toBe(false);
  });

  it("refuses a missing or empty CSRF token before comparing anything", () => {
    const sessions = new SessionService();
    const session = sessions.mint(NOW);
    expect(csrfMatches(undefined, session.csrfToken)).toBe(false);
    expect(csrfMatches("", session.csrfToken)).toBe(false);
    expect(csrfMatches(session.csrfToken, session.csrfToken)).toBe(true);
    expect(csrfMatches(`${session.csrfToken}x`, session.csrfToken)).toBe(false);
    expect(CSRF_HEADER_NAME).toBe("x-csrf-token");
  });
});

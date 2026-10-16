import { randomBytes, timingSafeEqual } from "node:crypto";

import { LOOPBACK_HOST } from "../contracts/boot.ts";
import { asInstant, instantToEpochMs, newId } from "../domain/identity.ts";
import type { Id, Instant } from "../domain/identity.ts";
import type { Result } from "../domain/result.ts";

// Local session pairing (DESIGN §8, §14, D30).
//
// Everything here is a pure decision over values the caller hands in: which bytes
// are credentials, when they die, and what the browser may be told about them. The
// owner of the *store* is the worker process (DESIGN §14: SessionService 在 worker
// 内存持有会话和到期时间), which is why both containers below are memory-only —
// a session that was never written to SQLite cannot survive a restart, and
// "重启也使全部会话失效" is a property of the data structure rather than a cleanup
// step someone has to remember.
//
// Three rules shape the implementation:
//   * the bootstrap token is minted by the local start command only. Nothing in
//     this module can be asked by a remote caller to produce one; there is no
//     "give me a code" operation, only `redeem`.
//   * a redeemed token is destroyed, whether or not it worked. A second attempt
//     with the same value is indistinguishable from a wrong guess.
//   * no value in here is ever a name, a path or a hash of a secret (§12.1: an
//     excluded value is neither stored nor hashed).

export const BOOTSTRAP_TOKEN_BYTES = 32;
export const SESSION_KEY_BYTES = 32;
export const CSRF_TOKEN_BYTES = 32;

// DESIGN §14 gives these fields an expiry but no number: they are the workbench's
// own stated defaults, named here so a reviewer can disagree with a value rather
// than with an invisible constant.
export const DEFAULT_BOOTSTRAP_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = "wb_session";
export const CSRF_HEADER_NAME = "x-csrf-token";

export type SecretFailure = "absent" | "unknown" | "expired";

function randomSecret(bytes: number): string {
  // base64url keeps the value inside a cookie/header-safe alphabet and carries no
  // `.`, which is what lets the terminal's credential-shape filter (D28) pass a
  // pairing code through while still rejecting anything JWT-shaped.
  return randomBytes(bytes).toString("base64url");
}

function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  // timingSafeEqual throws on a length mismatch, so the length is compared first
  // and the answer is the same either way: a short guess is not a different cost.
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function expiresAt(nowMs: number, ttlMs: number): Instant {
  // `asInstant` rather than a cast: a non-finite clock would have produced an
  // "Invalid Date" expiry that reads as forever.
  return asInstant(new Date(nowMs + ttlMs).toISOString());
}

function isLive(expiresAtValue: Instant, nowMs: number): boolean {
  return instantToEpochMs(expiresAtValue) > nowMs;
}

export type PairingCode = {
  token: string;
  expiresAt: Instant;
};

// The one-time pairing code. `mint` is called by the local start command; `redeem`
// is the only other thing that can touch a code, and it destroys it.
export class BootstrapTokenVault {
  // token -> expiry in epoch ms. Never serialised: there is no `toJSON` and no
  // reader that returns values, only counts.
  readonly pending: Map<string, number> = new Map();

  mint(nowMs: number, ttlMs: number = DEFAULT_BOOTSTRAP_TTL_MS): PairingCode {
    const token = randomSecret(BOOTSTRAP_TOKEN_BYTES);
    const expires = expiresAt(nowMs, ttlMs);
    // A fresh code supersedes the one it replaces: an operator who restarts the
    // start command gets exactly one live code, not a pile of them.
    this.pending.clear();
    this.pending.set(token, instantToEpochMs(expires));
    return { token, expiresAt: expires };
  }

  redeem(candidate: string, nowMs: number): Result<true, SecretFailure> {
    if (candidate.length === 0) return { ok: false, error: "absent" };
    let matched: string | null = null;
    let expiry = 0;
    for (const [token, expiresAtMs] of this.pending) {
      if (secretsEqual(token, candidate)) {
        matched = token;
        expiry = expiresAtMs;
        break;
      }
    }
    if (matched === null) return { ok: false, error: "unknown" };
    // Whatever the outcome, the code is gone: consumption is not conditional on
    // the session that would have been built from it.
    this.pending.delete(matched);
    if (expiry <= nowMs) return { ok: false, error: "expired" };
    return { ok: true, value: true };
  }

  activeCount(): number {
    return this.pending.size;
  }
}

export type LocalSession = {
  // The opaque value the browser holds. It is a random handle, not a claim about
  // who the operator is.
  sessionKey: string;
  reviewerId: Id;
  csrfToken: string;
  expiresAt: Instant;
};

export class SessionService {
  readonly sessions: Map<string, LocalSession> = new Map();

  mint(nowMs: number, ttlMs: number = DEFAULT_SESSION_TTL_MS): LocalSession {
    const session: LocalSession = {
      sessionKey: randomSecret(SESSION_KEY_BYTES),
      // A local review identifier, not a real-world identity (DESIGN §14).
      reviewerId: newId(),
      csrfToken: randomSecret(CSRF_TOKEN_BYTES),
      expiresAt: expiresAt(nowMs, ttlMs),
    };
    this.sessions.set(session.sessionKey, session);
    return session;
  }

  // Returns null for an unknown, consumed or expired key alike, and drops the
  // expired entry so a long-lived worker does not accumulate dead sessions.
  resolve(sessionKey: string, nowMs: number): LocalSession | null {
    const found = this.sessions.get(sessionKey);
    if (found === undefined) return null;
    if (!isLive(found.expiresAt, nowMs)) {
      this.sessions.delete(sessionKey);
      return null;
    }
    return found;
  }

  revoke(sessionKey: string): boolean {
    return this.sessions.delete(sessionKey);
  }

  revokeAll(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  activeCount(): number {
    return this.sessions.size;
  }
}

export type ListenAddress = {
  host: string;
  port: number;
  // TLS is not part of V0.1; the flag exists so `Secure` is a decision with an
  // owner instead of a string someone appends when they remember.
  secure: boolean;
};

export function originOf(address: ListenAddress): string {
  return `${address.secure ? "https" : "http"}://${address.host}:${address.port}`;
}

// `Host` must be the literal loopback address with the port this process actually
// bound (§14: 首版仅接受该字面地址, 会话同源策略使用实际端口). `localhost` is
// refused on purpose: resolving a name to decide locality would put DNS in the
// middle of a security check.
export function hostAllowed(header: string | undefined, address: ListenAddress): boolean {
  if (header === undefined) return false;
  if (address.host !== LOOPBACK_HOST) return false;
  return header === `${LOOPBACK_HOST}:${address.port}`;
}

// Same-origin only, and `null` (a file:// or sandboxed frame) is not a same-origin
// claim. Absent is absent: a mutating request without an Origin is refused rather
// than guessed at.
export function originAllowed(header: string | undefined, address: ListenAddress): boolean {
  if (header === undefined) return false;
  return header === originOf(address);
}

export function csrfMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined || presented.length === 0) return false;
  return secretsEqual(presented, expected);
}

// A cookie header is a list of `name=value` pairs; only the exact name is read,
// and a duplicated name resolves to the first pair (which is what RFC 6265 tells a
// sender to do), so a later forged pair cannot shadow it.
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    if (trimmed.slice(0, index) !== name) continue;
    return decodeURIComponent(trimmed.slice(index + 1));
  }
  return null;
}

export type CookieDirective = {
  name: string;
  value: string;
  expiresAt: Instant;
  secure: boolean;
};

// Attribute assembly is a pure string build, so the whole set of attributes a
// session cookie may carry is one reviewable function rather than a header written
// at several call sites. `HttpOnly`, `SameSite=Strict` and `Path=/` are unconditional
// (§14); `Secure` appears only over TLS.
export function cookieHeader(directive: CookieDirective): string {
  const parts = [
    `${directive.name}=${encodeURIComponent(directive.value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Expires=${new Date(instantToEpochMs(directive.expiresAt)).toUTCString()}`,
  ];
  if (directive.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearingCookieHeader(directive: { name: string; secure: boolean }): string {
  const parts = [
    `${directive.name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    `Expires=${new Date(0).toUTCString()}`,
  ];
  if (directive.secure) parts.push("Secure");
  return parts.join("; ");
}

export type SessionCookie = {
  header: string;
};

export function sessionCookieHeader(session: LocalSession, address: ListenAddress): SessionCookie {
  return {
    header: cookieHeader({
      name: SESSION_COOKIE_NAME,
      value: session.sessionKey,
      expiresAt: session.expiresAt,
      secure: address.secure,
    }),
  };
}

import { describe, expect, it } from "vitest";

import {
  TRANSPORT_AUTH_HEADER_NAMES,
  assertPayloadClean,
  redactJsonValue,
  redactText,
} from "../../packages/application/sanitizer.ts";
import type { SensitiveDeclaration } from "../../packages/application/sanitizer.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";

const SECRET = "hunter2-session-token";
const declared: SensitiveDeclaration = { declaredValues: [SECRET] };
const noDeclaration: SensitiveDeclaration | null = null;

describe("declared values only (DESIGN §12.1, D21)", () => {
  it("removes a declared literal from free text and reports no value", () => {
    const result = redactText(`adapter stderr: rejected ${SECRET} at step 3`, declared);
    expect(result.text).not.toContain(SECRET);
    expect(result.text).toContain("adapter stderr");
    expect(result.excludedCount).toBe(1);
    expect(result.excludedReasons).toEqual(["explicit-sensitive-value"]);
  });

  it("does not keep the excluded value or a hash of it", () => {
    const result = redactText(`${SECRET} and again ${SECRET}`, declared);
    expect(result.text.trim()).toBe("and again");
    // 64-hex leftovers would mean a digest of the secret survived.
    expect(/[0-9a-f]{64}/.test(result.text)).toBe(false);
    expect(result.excludedCount).toBe(2);
  });

  it("preserves a token-looking value that nobody declared", () => {
    // §12.1 forbids name-based heuristics: `token` in a key is not sensitivity.
    const payload: JsonValue = { query: { token: "public-csrf-label", page: 2 } };
    const result = redactJsonValue(payload, declared);
    expect(result.value).toEqual(payload);
    expect(result.excludedCount).toBe(0);
  });

  it("strips known transport-auth header values structurally, keeping canonical keys", () => {
    const payload: JsonValue = {
      request: {
        method: "POST",
        headers: [
          { name: "content-type", value: "application/json" },
          // A header whose *name* contains "token" is not transport
          // authentication: §12.1 forbids deciding sensitivity by spelling.
          { name: "x-token-label", value: "public-csrf-label" },
          { name: "Authorization", value: "Bearer abc.def" },
          { name: "Cookie", value: "session=xyz" },
        ],
      },
    };
    const result = redactJsonValue(payload, declared);
    const headers = (result.value as { request: { headers: { name: string; value: JsonValue }[] } }).request
      .headers;
    expect(headers[2]?.value).toBeNull();
    expect(headers[3]?.value).toBeNull();
    expect(headers[0]).toEqual({ name: "content-type", value: "application/json" });
    expect(headers[1]).toEqual({ name: "x-token-label", value: "public-csrf-label" });
    expect(result.excludedCount).toBe(2);
    expect(TRANSPORT_AUTH_HEADER_NAMES).toEqual([
      "authorization",
      "proxy-authorization",
      "cookie",
      "set-cookie",
    ]);
  });

  it("refuses to run without the declaration context instead of assuming empty", () => {
    const text = redactText("provider said: hunter2-session-token", noDeclaration);
    expect(text.text).toBe("");
    expect(text.excludedReasons).toEqual(["declaration-context-unavailable"]);
    const payload = assertPayloadClean({ note: "anything" }, noDeclaration);
    expect(payload.ok).toBe(false);
    if (payload.ok) return;
    expect(payload.reason).toBe("declaration-context-unavailable");
  });
});

describe("strict payload gate (DESIGN §12.1, D28)", () => {
  it("blocks a contract or blueprint payload containing a declared value", () => {
    const body: JsonValue = { behaviorSpec: `use ${SECRET} to authenticate` };
    const check = assertPayloadClean(body, declared);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("SENSITIVE_CONTENT_BLOCKED");
    expect(check.reason).toBe("declared-value-present");
  });

  it("blocks a payload carrying a live transport-auth value", () => {
    const check = assertPayloadClean(
      { examples: [{ name: "set-cookie", value: "sid=1" }] },
      declared,
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe("transport-auth-structure");
  });

  it("leaves approved content untouched rather than rewriting it", () => {
    const body: JsonValue = { behaviorSpec: "GET /cart returns items", headers: [{ name: "x-trace", value: "1" }] };
    const before = JSON.stringify(body);
    expect(assertPayloadClean(body, declared).ok).toBe(true);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("does not report an empty header value or a token-shaped name as a leak", () => {
    expect(
      assertPayloadClean({ headers: [{ name: "authorization", value: "" }] }, declared).ok,
    ).toBe(true);
    expect(
      assertPayloadClean({ headers: [{ name: "x-token-label", value: "public-label" }] }, declared).ok,
    ).toBe(true);
  });
});

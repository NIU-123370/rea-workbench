import { describe, expect, it } from "vitest";

import {
  IdempotencyJournal,
  isIdempotencyKey,
  idempotencyDigest,
  journalScope,
  MAX_IDEMPOTENCY_JOURNAL_ENTRIES,
} from "../../packages/application/idempotency.ts";
import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type { SafeRequest } from "../../packages/application/idempotency.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";

// `Idempotency-Key` semantics (DESIGN §8 / §5, issue #17): same key and same safe
// request replays the original result; the same key carrying a different request is a
// conflict; and nothing that is authentication or explicitly sensitive can enter the
// digest at all.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const CLEAN = { declaredValues: [] };
const SECRET = "hunter2-pairing-value";
const SCOPE = journalScope("reviewer-one", "POST /api/v1/projects");

function request(body: Record<string, JsonValue>): SafeRequest {
  return { route: "POST /api/v1/projects", method: "POST", body };
}

describe("the safe request digest (§8)", () => {
  it("digests a clean projection and refuses a dirty one outright", () => {
    const clean = idempotencyDigest(request({ name: "cart" }), CLEAN, LIMITS);
    expect(clean.ok).toBe(true);
    const replayed = idempotencyDigest(request({ name: "cart" }), CLEAN, LIMITS);
    expect(replayed).toEqual(clean);

    const smuggled = idempotencyDigest(request({ name: "cart", token: SECRET }), {
      declaredValues: [SECRET],
    }, LIMITS);
    expect(smuggled.ok).toBe(false);
    if (smuggled.ok) return;
    expect(smuggled.error.code).toBe("SENSITIVE_CONTENT_BLOCKED");
    // The refusal does not carry the value it refused, and there is no digest of it.
    expect(JSON.stringify(smuggled.error)).not.toContain(SECRET);
  });

  it("keys on the matched route template, not on a caller-supplied target", () => {
    const a = idempotencyDigest(request({ name: "cart" }), CLEAN, LIMITS);
    const b = idempotencyDigest(
      { route: "POST /api/v1/projects/other", method: "POST", body: { name: "cart" } },
      CLEAN,
      LIMITS,
    );
    if (!a.ok || !b.ok) throw new Error("both should digest");
    expect(a.value).not.toBe(b.value);
  });

  it("rejects an empty or absurd key instead of treating it as a bucket", () => {
    expect(isIdempotencyKey(undefined)).toBe(false);
    expect(isIdempotencyKey("")).toBe(false);
    expect(isIdempotencyKey("x".repeat(201))).toBe(false);
    expect(isIdempotencyKey("x".repeat(200))).toBe(true);
  });

  it("scopes a key by reviewer and route so two callers cannot collide", () => {
    expect(journalScope("a", "POST /x")).not.toBe(journalScope("b", "POST /x"));
    expect(journalScope("a", "POST /x")).not.toBe(journalScope("a", "POST /y"));
  });
});

describe("the journal's outcomes (§8)", () => {
  function digestOf(body: Record<string, JsonValue>): Digest {
    const outcome = idempotencyDigest(request(body), CLEAN, LIMITS);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    return outcome.value;
  }

  it("claims once, replays the recorded result, and conflicts on divergence", () => {
    const journal = new IdempotencyJournal();
    const first = digestOf({ name: "cart" });
    expect(journal.claim(SCOPE, "key-1", first)).toEqual({ kind: "fresh" });
    // Claimed but not finished: a second request must not execute either.
    expect(journal.claim(SCOPE, "key-1", first)).toEqual({ kind: "inFlight" });
    journal.record(SCOPE, "key-1", first, { status: 201, body: { id: "job-1" } });
    const replay = journal.claim(SCOPE, "key-1", first);
    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") return;
    expect(replay.recorded).toEqual({ status: 201, body: { id: "job-1" } });

    const divergent = journal.claim(SCOPE, "key-1", digestOf({ name: "other" }));
    expect(divergent.kind).toBe("divergent");
  });

  it("keeps one key per scope", () => {
    const journal = new IdempotencyJournal();
    const digest = digestOf({ name: "cart" });
    expect(journal.claim(journalScope("a", "POST /x"), "same", digest).kind).toBe("fresh");
    expect(journal.claim(journalScope("b", "POST /x"), "same", digest).kind).toBe("fresh");
  });

  it("drops the oldest entry past its bound rather than growing forever", () => {
    const journal = new IdempotencyJournal();
    for (let index = 0; index < MAX_IDEMPOTENCY_JOURNAL_ENTRIES + 5; index += 1) {
      journal.claim(SCOPE, `key-${String(index)}`, asDigest(`${index.toString(16).padStart(64, "0")}`));
    }
    expect(journal.size()).toBe(MAX_IDEMPOTENCY_JOURNAL_ENTRIES);
    // The oldest entry is the one that left, so re-claiming it is fresh again.
    expect(journal.claim(SCOPE, "key-0", asDigest("0".repeat(64))).kind).toBe("fresh");
    expect(journal.evictionCount()).toBeGreaterThan(0);
  });

  it("can forget everything a revoked caller had recorded", () => {
    const journal = new IdempotencyJournal();
    journal.claim(SCOPE, "key-1", digestOf({ name: "a" }));
    journal.claim(journalScope("other", "POST /x"), "key-2", digestOf({ name: "b" }));
    expect(journal.dropScope(SCOPE)).toBe(1);
    expect(journal.size()).toBe(1);
  });
});

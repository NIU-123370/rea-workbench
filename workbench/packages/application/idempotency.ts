import { digestCanonicalJson } from "../domain/canonical-json.ts";
import type { CanonicalLimits, Digest } from "../domain/canonical-json.ts";
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import { gateFail } from "./gate-failure.ts";
import type { GateFailure } from "./gate-failure.ts";
import { assertPayloadClean } from "./sanitizer.ts";
import type { SensitiveDeclaration } from "./sanitizer.ts";

// `Idempotency-Key` handling (DESIGN §8 通用规则, §5 jobs).
//
// The stored half of this rule already exists: `jobs.idempotency_key` plus
// `jobs.request_digest`, where `insertJob` answers `existing` for the same key and
// digest and `divergent` for the same key with a different payload. This module is
// the adapter-side mirror of exactly that three-way decision, for endpoints whose
// table has no idempotency column (DESIGN §5 gives `projects` none), and it reuses
// the same digest owner - `domain/canonical-json.ts` - instead of inventing a second
// canonical form whose digests could not be compared with the stored ones.
//
// What enters a digest: the matched route template, the method and the *parsed*
// request body. Not the raw bytes, not any header (cookie, CSRF, the key itself),
// and not the value of anything the caller declared sensitive or a hash of it (§5).

export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_IDEMPOTENCY_JOURNAL_ENTRIES = 500;

export type SafeRequest = {
  // The matched route template, never the request target: a caller-controlled path
  // or query cannot enter a digest, and cannot reach an access log through here.
  route: string;
  method: string;
  body: JsonValue;
};

export type RecordedResponse = {
  status: number;
  body: JsonValue;
};

export type IdempotencyOutcome =
  | { kind: "fresh" }
  // The original result, replayed verbatim.
  | { kind: "replay"; recorded: RecordedResponse }
  // The key is already carrying a different safe request.
  | { kind: "divergent" }
  // The key is claimed and the first request has not produced a result yet. V0.1 has
  // no persisted idempotency row for these endpoints, so the honest answer is "try
  // again", never a second execution and never a replay of a result that does not
  // exist yet.
  | { kind: "inFlight" };

export function isIdempotencyKey(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDEMPOTENCY_KEY_LENGTH;
}

// The projection is checked by the filter owner *before* it is digested, so a body
// that smuggled in a transport-authentication structure or a declared literal cannot
// produce a digest at all: the refusal is the answer, never a digest of the secret.
export function idempotencyDigest(
  request: SafeRequest,
  declaration: SensitiveDeclaration,
  limits: CanonicalLimits,
): Result<Digest, GateFailure> {
  const projection: JsonValue = { route: request.route, method: request.method, body: request.body };
  const clean = assertPayloadClean(projection, declaration);
  if (!clean.ok) {
    return gateFail(
      "SENSITIVE_CONTENT_BLOCKED",
      clean.reason,
      "the request cannot be digested without carrying its sensitive content",
    );
  }
  return { ok: true, value: digestCanonicalJson(projection, limits) };
}

// A scope is one caller's namespace (the session it authenticated with) plus the
// route, so two callers or two endpoints cannot collide on one key, and revoking a
// session can drop everything that caller had recorded. A NUL separator cannot appear
// in a route template or in an opaque UUID, so the split stays unambiguous.
export function journalScope(reviewerId: string, route: string): string {
  return `${reviewerId}\u0000${route}`;
}

type JournalEntry = {
  digest: Digest;
  recorded: RecordedResponse | null;
};

export class IdempotencyJournal {
  // Insertion order is the eviction order, so the bound is deterministic and a
  // reviewer can say which entry leaves first.
  readonly entries: Map<string, JournalEntry> = new Map();
  private evictions = 0;

  private static locate(scope: string, key: string): string {
    return `${scope}\u0000${key}`;
  }

  // Claiming is part of the decision: a fresh key is recorded as in flight in the same
  // step, so two requests that arrive before either result exists cannot both be told
  // they are the first one.
  claim(scope: string, key: string, digest: Digest): IdempotencyOutcome {
    const id = IdempotencyJournal.locate(scope, key);
    const found = this.entries.get(id);
    if (found === undefined) {
      this.entries.set(id, { digest, recorded: null });
      this.evictOverBudget();
      return { kind: "fresh" };
    }
    if (found.digest !== digest) return { kind: "divergent" };
    if (found.recorded === null) return { kind: "inFlight" };
    return { kind: "replay", recorded: found.recorded };
  }

  record(scope: string, key: string, digest: Digest, recorded: RecordedResponse): void {
    this.entries.set(IdempotencyJournal.locate(scope, key), { digest, recorded });
    this.evictOverBudget();
  }

  // A request that produced no result gives the key back: §8 promises the *original
  // result* on a replay, and there is no result to promise from a refusal.
  abandon(scope: string, key: string): boolean {
    return this.entries.delete(IdempotencyJournal.locate(scope, key));
  }

  dropScope(scope: string): number {
    let dropped = 0;
    // A Map's own iterator tolerates deleting the current entry, so this walks the
    // live keys without copying the table first.
    for (const id of this.entries.keys()) {
      if (!id.startsWith(`${scope}\u0000`)) continue;
      this.entries.delete(id);
      dropped += 1;
    }
    return dropped;
  }

  private evictOverBudget(): void {
    while (this.entries.size > MAX_IDEMPOTENCY_JOURNAL_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  evictionCount(): number {
    return this.evictions;
  }

  size(): number {
    return this.entries.size;
  }
}

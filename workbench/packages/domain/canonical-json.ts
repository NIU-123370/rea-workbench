import { createHash } from "node:crypto";

import type { JsonValue } from "./json-value.ts";

// Digest is a lowercase SHA-256 hex string. Two distinct producers exist and
// must not be mixed (DESIGN §4): one over artifact bytes, one over the
// canonical JSON encoding of an explicitly versioned value.
export type Digest = string & { readonly digestBrand: unique symbol };

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

export function asDigest(value: string): Digest {
  if (!DIGEST_PATTERN.test(value)) {
    throw new TypeError("digest must be 64 lowercase hex characters");
  }
  return value as Digest;
}

export type CanonicalLimits = {
  // Budgets come from the resolved profile, never guessed at runtime (DESIGN §12).
  maxDepth: number;
  maxCodeUnits: number;
};

export class CanonicalizationError extends Error {
  public override readonly name: string = "CanonicalizationError";

  public readonly reason:
    | "unsupported-value"
    | "non-finite-number"
    | "depth-limit"
    | "size-limit";

  public constructor(reason: CanonicalizationError["reason"], detail: string) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

type Sink = { parts: string[]; codeUnits: number; limits: CanonicalLimits };

function push(sink: Sink, text: string): void {
  // The budget is charged as fragments are produced, so an oversized payload
  // stops before the whole document is materialised (DESIGN §12: measure first).
  sink.codeUnits += text.length;
  if (sink.codeUnits > sink.limits.maxCodeUnits) {
    throw new CanonicalizationError(
      "size-limit",
      `${sink.codeUnits} > ${sink.limits.maxCodeUnits}`,
    );
  }
  sink.parts.push(text);
}

function encode(value: JsonValue, depth: number, sink: Sink): void {
  if (depth > sink.limits.maxDepth) {
    throw new CanonicalizationError("depth-limit", `exceeded ${sink.limits.maxDepth}`);
  }
  if (value === null) {
    push(sink, "null");
    return;
  }
  switch (typeof value) {
    case "string": {
      push(sink, JSON.stringify(value));
      return;
    }
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError("non-finite-number", String(value));
      }
      // -0 and 0 share one canonical representation.
      push(sink, Object.is(value, -0) ? "0" : JSON.stringify(value));
      return;
    }
    case "boolean": {
      push(sink, value ? "true" : "false");
      return;
    }
    case "object": {
      if (Array.isArray(value)) {
        push(sink, "[");
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0) push(sink, ",");
          encode(value[index] as JsonValue, depth + 1, sink);
        }
        push(sink, "]");
        return;
      }
      const record = value as Record<string, JsonValue>;
      const keys = Object.keys(record);
      // UTF-16 code-unit ordering, matching the JSON canonicalisation the
      // comparator digests rely on.
      keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      push(sink, "{");
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index] as string;
        if (index > 0) push(sink, ",");
        push(sink, JSON.stringify(key));
        push(sink, ":");
        const member = record[key];
        if (member === undefined) {
          throw new CanonicalizationError("unsupported-value", `member ${key} is absent`);
        }
        encode(member, depth + 1, sink);
      }
      push(sink, "}");
      return;
    }
    default: {
      throw new CanonicalizationError("unsupported-value", typeof value);
    }
  }
}

export function canonicalJson(value: JsonValue, limits: CanonicalLimits): string {
  const sink: Sink = { parts: [], codeUnits: 0, limits };
  encode(value, 1, sink);
  return sink.parts.join("");
}

export function digestCanonicalJson(value: JsonValue, limits: CanonicalLimits): Digest {
  return asDigest(createHash("sha256").update(canonicalJson(value, limits), "utf8").digest("hex"));
}

export function digestBytes(bytes: Uint8Array): Digest {
  return asDigest(createHash("sha256").update(bytes).digest("hex"));
}

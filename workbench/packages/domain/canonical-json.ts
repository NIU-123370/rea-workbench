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

function encode(value: JsonValue, depth: number, limits: CanonicalLimits, out: string[]): void {
  if (depth > limits.maxDepth) {
    throw new CanonicalizationError("depth-limit", `exceeded ${limits.maxDepth}`);
  }
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "string": {
      out.push(JSON.stringify(value));
      return;
    }
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError("non-finite-number", String(value));
      }
      // -0 and 0 share one canonical representation.
      out.push(Object.is(value, -0) ? "0" : JSON.stringify(value));
      return;
    }
    case "boolean": {
      out.push(value ? "true" : "false");
      return;
    }
    case "object": {
      if (Array.isArray(value)) {
        out.push("[");
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0) out.push(",");
          encode(value[index] as JsonValue, depth + 1, limits, out);
        }
        out.push("]");
        return;
      }
      const record = value as Record<string, JsonValue>;
      const keys = Object.keys(record);
      // UTF-16 code-unit ordering, matching the JSON canonicalisation the
      // comparator digests rely on.
      keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      out.push("{");
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index] as string;
        if (index > 0) out.push(",");
        out.push(JSON.stringify(key), ":");
        const member = record[key];
        if (member === undefined) {
          throw new CanonicalizationError(
            "unsupported-value",
            `member ${key} is absent`,
          );
        }
        encode(member, depth + 1, limits, out);
      }
      out.push("}");
      return;
    }
    default: {
      throw new CanonicalizationError("unsupported-value", typeof value);
    }
  }
}

export function canonicalJson(value: JsonValue, limits: CanonicalLimits): string {
  const out: string[] = [];
  encode(value, 1, limits, out);
  const text = out.join("");
  if (text.length > limits.maxCodeUnits) {
    throw new CanonicalizationError("size-limit", `${text.length} > ${limits.maxCodeUnits}`);
  }
  return text;
}

export function digestCanonicalJson(value: JsonValue, limits: CanonicalLimits): Digest {
  return asDigest(createHash("sha256").update(canonicalJson(value, limits), "utf8").digest("hex"));
}

export function digestBytes(bytes: Uint8Array): Digest {
  return asDigest(createHash("sha256").update(bytes).digest("hex"));
}

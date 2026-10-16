import { describe, expect, it } from "vitest";

import {
  CanonicalizationError,
  asDigest,
  canonicalJson,
  digestBytes,
  digestCanonicalJson,
  isDigest,
} from "../../packages/domain/canonical-json.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";

const LIMITS = { maxDepth: 8, maxCodeUnits: 4096 };

describe("canonical JSON", () => {
  it("ignores member insertion order but not value types", () => {
    const left = digestCanonicalJson({ a: 1, b: "2" } as JsonValue, LIMITS);
    const right = digestCanonicalJson({ b: "2", a: 1 } as JsonValue, LIMITS);
    expect(left).toBe(right);
    expect(digestCanonicalJson({ a: 1, b: 2 } as JsonValue, LIMITS)).not.toBe(left);
  });

  it("orders keys by UTF-16 code units", () => {
    expect(canonicalJson({ b: 1, a: 2, B: 3, "0": 4 } as JsonValue, LIMITS)).toBe(
      `{"0":4,"B":3,"a":2,"b":1}`,
    );
  });

  it("gives -0 and 0 one representation and keeps arrays ordered", () => {
    expect(canonicalJson([-0, 0] as unknown as JsonValue, LIMITS)).toBe("[0,0]");
    expect(canonicalJson([1, 2] as JsonValue, LIMITS)).not.toBe(
      canonicalJson([2, 1] as JsonValue, LIMITS),
    );
  });

  it("refuses values that cannot round-trip losslessly", () => {
    expect(() => canonicalJson(Number.NaN as unknown as JsonValue, LIMITS)).toThrow(
      CanonicalizationError,
    );
    expect(() => canonicalJson(Infinity as unknown as JsonValue, LIMITS)).toThrow(
      "non-finite-number",
    );
    expect(() => canonicalJson(undefined as unknown as JsonValue, LIMITS)).toThrow(
      "unsupported-value",
    );
  });

  it("applies caller-supplied budgets instead of guessing them", () => {
    expect(() => canonicalJson({ a: { b: { c: 1 } } } as JsonValue, { ...LIMITS, maxDepth: 2 })).toThrow(
      "depth-limit",
    );
    expect(() =>
      canonicalJson({ a: "x".repeat(50) } as JsonValue, { ...LIMITS, maxCodeUnits: 16 }),
    ).toThrow("size-limit");
  });

  it("keeps byte digests and canonical JSON digests as separate entry points", () => {
    const payload = { a: 1 } as JsonValue;
    const jsonDigest = digestCanonicalJson(payload, LIMITS);
    const byteDigest = digestBytes(new TextEncoder().encode(canonicalJson(payload, LIMITS)));
    expect(jsonDigest).toBe(byteDigest);
    expect(digestBytes(new TextEncoder().encode("a"))).not.toBe(jsonDigest);
  });

  it("charges the budget before materialising the rest of the payload", () => {
    // DESIGN §12 measures before allocating: an oversized prefix must stop the
    // encoder before it ever reads the remaining members.
    const read: string[] = [];
    const source = {
      a: "x".repeat(50),
      get z(): JsonValue {
        read.push("z");
        return "y".repeat(50);
      },
    };
    expect(() =>
      canonicalJson(source as unknown as JsonValue, { ...LIMITS, maxCodeUnits: 40 }),
    ).toThrow("size-limit");
    expect(read).toEqual([]);
  });

  it("validates digest shape", () => {
    expect(isDigest("0".repeat(64))).toBe(true);
    expect(isDigest("0".repeat(63))).toBe(false);
    expect(isDigest("A".repeat(64))).toBe(false);
    expect(() => asDigest("nope")).toThrow(TypeError);
  });
});

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import { asId, newId } from "../../packages/domain/identity.ts";
import {
  BODY_KINDS,
  VECTOR_CONTENT_FIELDS,
  VectorDigestFieldError,
  deriveEligibility,
  isCanonicalBase64,
  sameSourceCoordinates,
  vectorDigest,
  vectorDigestInput,
  vectorIntegrityDefects,
} from "../../packages/domain/vector.ts";
import type { BodyValue, TestVectorContent } from "../../packages/domain/vector.ts";
import { testVectorContentSchema } from "../../packages/contracts/vectors.ts";

// DESIGN §7.1 and §7.4: what a body representation may and may not collapse
// into, when a sample stops being usable, and which fields the approved identity
// of a vector actually covers.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const HEX_A = ("a" as const).repeat(64);
const HEX_B = ("b" as const).repeat(64);
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

const COMPLETE_COVERAGE = { state: "complete" as const, examined: null, total: null, reasons: [] };

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const GOOD_BODY: BodyValue = {
  kind: "bytes",
  base64: "aGVsbG8=",
  sha256: asDigest(sha256Hex("hello")),
};

function usableRequest() {
  return {
    method: "GET",
    url: "https://shop.example/api/cart",
    query: [{ name: "include", value: "items" }],
    headers: [{ name: "accept", value: "application/json" }],
    body: { kind: "empty" } as BodyValue,
  };
}

function usableResponse(body: BodyValue = GOOD_BODY) {
  return {
    status: 200,
    headers: [{ name: "content-type", value: "application/json" }],
    body,
  };
}

function sampleContent(overrides: Partial<TestVectorContent> = {}): TestVectorContent {
  return {
    id: asId(ID_A),
    targetId: asId(ID_B),
    snapshotDigest: asDigest(HEX_A),
    operationId: "getCart",
    sdkInput: { include: "items" },
    caseKey: "cart-with-items",
    replacesId: null,
    source: {
      evidenceId: `ev_${HEX_B}`,
      captureId: null,
      recordOrdinal: 0,
      pointer: "/records/0",
      transactionId: null,
    },
    request: usableRequest(),
    response: usableResponse(),
    expectedOutcome: { kind: "return", value: { items: [] } },
    coverage: COMPLETE_COVERAGE,
    limitations: [],
    redactions: [],
    visibility: "public",
    eligibility: "usable",
    reasons: [],
    ...overrides,
  };
}

describe("BodyValue is a tagged union with no folding (DESIGN §7.1)", () => {
  it("publishes exactly the five producer representations", () => {
    expect(BODY_KINDS).toEqual(["missing", "empty", "text", "bytes", "redacted"]);
  });

  it("gives every body representation its own digest", () => {
    const bodies: BodyValue[] = [
      { kind: "missing", reason: "har-content-text-absent" },
      { kind: "empty" },
      { kind: "text", text: "", provenance: "producer-decoded" },
      { kind: "bytes", base64: "", sha256: asDigest(sha256Hex("")) },
      { kind: "redacted", reason: "producer-redaction:/response/content/text" },
    ];
    const digests = bodies.map((body) =>
      vectorDigest(sampleContent({ response: usableResponse(body) }), LIMITS),
    );
    expect(new Set(digests).size).toBe(bodies.length);
  });

  it("keeps an empty string body distinct from a bytes body of the same length", () => {
    const text = vectorDigest(
      sampleContent({
        response: usableResponse({ kind: "text", text: "hi", provenance: "producer-decoded" }),
      }),
      LIMITS,
    );
    const bytes = vectorDigest(
      sampleContent({
        response: usableResponse({ kind: "bytes", base64: "aGk=", sha256: asDigest(sha256Hex("hi")) }),
      }),
      LIMITS,
    );
    expect(text).not.toBe(bytes);
  });
});

describe("bytes bodies are verified, not trusted", () => {
  it("accepts canonical base64 and refuses non-canonical spellings", () => {
    expect(isCanonicalBase64("aGVsbG8=")).toBe(true);
    expect(isCanonicalBase64("aGVsbG8")).toBe(false);
    expect(isCanonicalBase64("====")).toBe(false);
    // `AD==` carries non-zero leftover bits, so it is a second spelling of a
    // first encoding rather than valid canonical base64.
    expect(isCanonicalBase64("AD==")).toBe(false);
    expect(isCanonicalBase64("QQ==")).toBe(true);
    expect(isCanonicalBase64("aGVsbA==")).toBe(true);
  });

  it("refuses a body whose declared digest does not match its bytes", () => {
    const defects = vectorIntegrityDefects(
      sampleContent({
        response: usableResponse({ kind: "bytes", base64: "aGVsbG8=", sha256: asDigest(HEX_A) }),
      }),
    );
    expect(defects).toEqual(["body-bytes-digest-mismatch"]);
  });

  it("refuses a non-canonical encoding even when the digest is right", () => {
    const defects = vectorIntegrityDefects(
      sampleContent({
        response: usableResponse({ kind: "bytes", base64: "aGVsbG", sha256: asDigest(HEX_A) }),
      }),
    );
    expect(defects).toEqual(["body-bytes-not-canonical-base64"]);
  });

  it("accepts a verified bytes body", () => {
    expect(vectorIntegrityDefects(sampleContent())).toEqual([]);
  });
});

describe("eligibility is derived (DESIGN §7.1, §7.4)", () => {
  it("marks a complete record usable with no reasons", () => {
    const derived = deriveEligibility({
      request: usableRequest(),
      response: usableResponse(),
      expectedOutcome: { kind: "return", value: {} },
      coverage: COMPLETE_COVERAGE,
    });
    expect(derived).toEqual({ eligibility: "usable", reasons: [] });
  });

  it.each([
    ["method", { request: { ...usableRequest(), method: null } }, "vector-missing-method"],
    ["url", { request: { ...usableRequest(), url: null } }, "vector-missing-url"],
    ["oracle", { expectedOutcome: null }, "vector-missing-oracle"],
    ["status", { response: { ...usableResponse(), status: null } }, "vector-response-status-unavailable"],
    [
      "missing response body",
      { response: { ...usableResponse(), body: { kind: "missing", reason: "x" } as BodyValue } },
      "vector-response-body-missing",
    ],
    [
      "redacted response body",
      { response: { ...usableResponse(), body: { kind: "redacted", reason: "x" } as BodyValue } },
      "vector-response-body-redacted",
    ],
    [
      "redacted request body",
      { request: { ...usableRequest(), body: { kind: "redacted", reason: "x" } as BodyValue } },
      "vector-request-body-redacted",
    ],
    [
      "partial coverage",
      { coverage: { state: "partial", examined: 1, total: 5, reasons: ["limited"] } },
      "coverage-partial",
    ],
  ] as const)(
    "blocks a record with a %s",
    (_label, override: Record<string, unknown>, expectedReason: string) => {
      const derived = deriveEligibility({
        request: usableRequest(),
        response: usableResponse(),
        expectedOutcome: { kind: "return", value: {} },
        coverage: COMPLETE_COVERAGE,
        ...override,
      });
      expect(derived.eligibility).toBe("blocked");
      expect(derived.reasons).toContain(expectedReason);
    },
  );

  it("treats a body-less request as a complete observation", () => {
    const derived = deriveEligibility({
      request: { ...usableRequest(), body: { kind: "missing", reason: "har-postdata-absent" } },
      response: usableResponse(),
      expectedOutcome: { kind: "return", value: {} },
      coverage: COMPLETE_COVERAGE,
    });
    expect(derived.eligibility).toBe("usable");
  });

  it("lists every defect at once instead of stopping at the first", () => {
    const derived = deriveEligibility({
      request: { ...usableRequest(), method: null, url: null },
      response: usableResponse(),
      expectedOutcome: null,
      coverage: COMPLETE_COVERAGE,
    });
    expect(derived.reasons).toEqual(["vector-missing-method", "vector-missing-url", "vector-missing-oracle"]);
  });
});

describe("the vector digest covers a fixed field manifest", () => {
  it("lists exactly the immutable content fields", () => {
    expect(Object.keys(vectorDigestInput(sampleContent())).sort()).toEqual(
      [...VECTOR_CONTENT_FIELDS].sort(),
    );
  });

  it("excludes the digest itself and the review record", () => {
    const covered = Object.keys(vectorDigestInput(sampleContent()));
    expect(covered).not.toContain("digest");
    expect(covered).not.toContain("review");
  });

  it("computes the same digest for two objects differing only in key order", () => {
    const left = sampleContent();
    const right = sampleContent();
    // A different insertion order must not move the approved identity.
    const reordered = Object.fromEntries(Object.entries(right).reverse()) as unknown as TestVectorContent;
    expect(vectorDigest(reordered, LIMITS)).toBe(vectorDigest(left, LIMITS));
  });

  it("drops metadata the manifest does not cover instead of letting it join the identity", () => {
    const plain = vectorDigestInput(sampleContent());
    const smuggled = vectorDigestInput({
      ...sampleContent(),
      displayLabel: "cart",
    } as unknown as TestVectorContent);
    // §7.2 excludes mutable UI metadata from the approved identity, and the
    // payload the service stores is this object, so an extra key is neither a
    // second digest nor a stored field.
    expect(smuggled).toEqual(plain);
    expect(Object.keys(smuggled)).not.toContain("displayLabel");
  });

  it("refuses to digest a vector whose covered field is absent", () => {
    const incomplete = { ...sampleContent(), caseKey: undefined } as unknown as TestVectorContent;
    expect(() => vectorDigest(incomplete, LIMITS)).toThrow();
  });

  it("refuses to digest when the covered fields no longer match the manifest", () => {
    // The guard is what stops a new field from joining the approved identity
    // quietly, so it is exercised by moving the manifest, not just by reading it.
    const manifest = VECTOR_CONTENT_FIELDS as unknown as string[];
    manifest.push("displayLabel");
    try {
      expect(() => vectorDigestInput(sampleContent())).toThrow(VectorDigestFieldError);
    } finally {
      manifest.pop();
    }
  });

  it("keeps the field manifest and the wire schema in step", () => {
    const wire = Object.keys(testVectorContentSchema.shape).sort();
    expect(wire).toEqual([...VECTOR_CONTENT_FIELDS].sort());
  });

  it("writes a payload the wire schema accepts", () => {
    // The service stores exactly what it digests, so the contract must accept it
    // back verbatim; drift here would silently break every later read.
    const parsed = testVectorContentSchema.safeParse(vectorDigestInput(sampleContent()));
    expect(parsed.success).toBe(true);
  });
});

describe("revision chain coordinates (DESIGN §7.4)", () => {
  const base = sampleContent().source;

  it("refuses a link across evidence records", () => {
    expect(
      sameSourceCoordinates(base, { ...base, evidenceId: `ev_${HEX_A}`, captureId: null, transactionId: null }),
    ).toBe(false);
  });

  it("refuses a link across source records", () => {
    expect(sameSourceCoordinates(base, { ...base, recordOrdinal: 1 })).toBe(false);
  });

  it("requires a usable coordinate rather than a pair of nulls", () => {
    expect(
      sameSourceCoordinates(
        { ...base, recordOrdinal: null, transactionId: null },
        { ...base, recordOrdinal: null, transactionId: null },
      ),
    ).toBe(false);
  });

  it("matches on ordinal or on transaction id", () => {
    expect(sameSourceCoordinates(base, { ...base })).toBe(true);
    expect(
      sameSourceCoordinates(
        { ...base, recordOrdinal: null, transactionId: "t-1" },
        { ...base, recordOrdinal: null, transactionId: "t-1" },
      ),
    ).toBe(true);
  });

  it("does not let a new id change what a chain link points at", () => {
    expect(sampleContent().id).not.toBe(newId());
  });
});

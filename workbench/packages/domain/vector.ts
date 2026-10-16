import type { CanonicalLimits, Digest } from "./canonical-json.ts";
import { asDigest, digestBytes, digestCanonicalJson } from "./canonical-json.ts";
import type { Coverage, Redaction } from "./evidence.ts";
import { coverageDeficiencyReasons } from "./evidence.ts";
import type { Id, Instant } from "./identity.ts";
import type { JsonArray, JsonObject, JsonValue } from "./json-value.ts";

// TestVector content rules (DESIGN §7.1, §7.4). This module owns the two things
// a reviewer cannot re-derive from the schema: which body representation
// variants are allowed to fold into each other (none) and what makes a sample
// unusable rather than merely incomplete.

export type NameValue = { name: string; value: string };

export const BODY_KINDS = ["missing", "empty", "text", "bytes", "redacted"] as const;
export type BodyKind = (typeof BODY_KINDS)[number];

// A tagged union with five mutually non-convertible members (§7.1): "no body was
// recorded" is not "the body was empty" is not "the body was withheld".
export type BodyValue =
  | { kind: "missing"; reason: string }
  | { kind: "empty" }
  | { kind: "text"; text: string; provenance: "producer-decoded" }
  | { kind: "bytes"; base64: string; sha256: Digest }
  | { kind: "redacted"; reason: string };

export type RequestSide = {
  method: string | null;
  url: string | null;
  query: NameValue[];
  headers: NameValue[];
  body: BodyValue;
};

export type ResponseSide = {
  status: number | null;
  headers: NameValue[];
  body: BodyValue;
};

export type ExpectedOutcome =
  | { kind: "return"; value: JsonValue }
  | { kind: "throw"; code: string; detail: JsonValue };

export type VectorSource = {
  evidenceId: string;
  captureId: Id | null;
  recordOrdinal: number | null;
  pointer: string | null;
  transactionId: string | null;
};

export type VectorVisibility = "public" | "holdout";
export type VectorEligibility = "usable" | "blocked";
export type ReviewStatus = "draft" | "approved" | "rejected";

export type VectorReview = {
  status: ReviewStatus;
  reviewerId: string | null;
  reviewedAt: Instant | null;
  approvedDigest: Digest | null;
};

export type TestVectorContent = {
  id: Id;
  targetId: Id;
  snapshotDigest: Digest;
  operationId: string;
  sdkInput: JsonValue;
  caseKey: string;
  replacesId: Id | null;
  source: VectorSource;
  request: RequestSide;
  response: ResponseSide;
  expectedOutcome: ExpectedOutcome | null;
  coverage: Coverage;
  limitations: string[];
  redactions: Redaction[];
  visibility: VectorVisibility;
  eligibility: VectorEligibility;
  reasons: string[];
};

export type TestVector = TestVectorContent & { digest: Digest; review: VectorReview };

// The digest covers exactly the immutable content (§7.1: "digest 对不可变内容
// 计算"), and `vectorDigest` refuses to compute one unless the field list it was
// given matches this manifest, so a new content field cannot quietly join — or
// quietly stay outside — the approved identity.
export const VECTOR_CONTENT_FIELDS = [
  "id",
  "targetId",
  "snapshotDigest",
  "operationId",
  "sdkInput",
  "caseKey",
  "replacesId",
  "source",
  "request",
  "response",
  "expectedOutcome",
  "coverage",
  "limitations",
  "redactions",
  "visibility",
  "eligibility",
  "reasons",
] as const;

export class VectorDigestFieldError extends Error {
  public override readonly name: string = "VectorDigestFieldError";

  public readonly missing: string[];

  public readonly extra: string[];

  // `erasableSyntaxOnly` forbids parameter properties, so the fields are declared
  // and assigned rather than folded into the constructor signature.
  public constructor(missing: string[], extra: string[]) {
    super(`digest field manifest mismatch: missing=${missing.join(",")} extra=${extra.join(",")}`);
    this.missing = missing;
    this.extra = extra;
  }
}

function bodyToJson(body: BodyValue): JsonObject {
  switch (body.kind) {
    case "missing":
      return { kind: "missing", reason: body.reason };
    case "empty":
      return { kind: "empty" };
    case "text":
      return { kind: "text", text: body.text, provenance: body.provenance };
    case "bytes":
      return { kind: "bytes", base64: body.base64, sha256: body.sha256 };
    case "redacted":
      return { kind: "redacted", reason: body.reason };
  }
}

function nameValueToJson(list: readonly NameValue[]): JsonArray {
  return list.map((pair: NameValue) => ({ name: pair.name, value: pair.value }));
}

function sideToJson(side: RequestSide): JsonObject {
  return {
    method: side.method,
    url: side.url,
    query: nameValueToJson(side.query),
    headers: nameValueToJson(side.headers),
    body: bodyToJson(side.body),
  };
}

function responseToJson(side: ResponseSide): JsonObject {
  return {
    status: side.status,
    headers: nameValueToJson(side.headers),
    body: bodyToJson(side.body),
  };
}

function sourceToJson(source: VectorSource): JsonObject {
  return {
    evidenceId: source.evidenceId,
    captureId: source.captureId,
    recordOrdinal: source.recordOrdinal,
    pointer: source.pointer,
    transactionId: source.transactionId,
  };
}

function outcomeToJson(outcome: ExpectedOutcome): JsonObject {
  return outcome.kind === "return"
    ? { kind: "return", value: outcome.value }
    : { kind: "throw", code: outcome.code, detail: outcome.detail };
}

function coverageToJson(coverage: Coverage): JsonObject {
  return {
    state: coverage.state,
    examined: coverage.examined,
    total: coverage.total,
    reasons: [...coverage.reasons],
  };
}

function redactionToJson(redaction: Redaction): JsonObject {
  return {
    fieldPointer: redaction.fieldPointer,
    reason: redaction.reason,
    representation: redaction.representation,
  };
}

export function vectorDigestInput(content: TestVectorContent): JsonObject {
  const input: JsonObject = {
    id: content.id,
    targetId: content.targetId,
    snapshotDigest: content.snapshotDigest,
    operationId: content.operationId,
    sdkInput: content.sdkInput,
    caseKey: content.caseKey,
    replacesId: content.replacesId,
    source: sourceToJson(content.source),
    request: sideToJson(content.request),
    response: responseToJson(content.response),
    expectedOutcome: content.expectedOutcome === null ? null : outcomeToJson(content.expectedOutcome),
    coverage: coverageToJson(content.coverage),
    limitations: [...content.limitations],
    redactions: content.redactions.map(redactionToJson),
    visibility: content.visibility,
    eligibility: content.eligibility,
    reasons: [...content.reasons],
  };
  const declared = [...VECTOR_CONTENT_FIELDS].sort();
  const actual = Object.keys(input).sort();
  const extra = actual.filter((key) => !declared.includes(key as (typeof VECTOR_CONTENT_FIELDS)[number]));
  const missing = declared.filter((key) => !actual.includes(key));
  if (extra.length > 0 || missing.length > 0) {
    throw new VectorDigestFieldError(missing, extra);
  }
  return input;
}

export function vectorDigest(content: TestVectorContent, limits: CanonicalLimits): Digest {
  return digestCanonicalJson(vectorDigestInput(content), limits);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// RFC 4648 canonical form: no premature padding and zeroed leftover bits. A
// non-canonical encoding has more than one spelling for the same bytes, which
// would give one body two digests.
export function isCanonicalBase64(text: string): boolean {
  if (text.length % 4 !== 0) return false;
  const groups = text.length / 4;
  for (let index = 0; index < groups; index += 1) {
    const quad = text.slice(index * 4, index * 4 + 4);
    const pad = quad.indexOf("=");
    if (index !== groups - 1) {
      if (pad !== -1) return false;
      continue;
    }
    if (pad === -1) continue;
    if (pad === 2) {
      if (quad[3] !== "=") return false;
      const tail = BASE64_ALPHABET.indexOf(quad[1] as string);
      if (tail === -1 || tail % 16 !== 0) return false;
    } else if (pad === 3) {
      const tail = BASE64_ALPHABET.indexOf(quad[2] as string);
      if (tail === -1 || tail % 4 !== 0) return false;
    } else {
      return false;
    }
  }
  return true;
}

function decodeBase64(text: string): Uint8Array | null {
  if (!isCanonicalBase64(text)) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// Integrity defects are refusals, not blocked samples: a `bytes` body whose
// digest does not match its encoding would otherwise be archived as evidence
// with a self-contradictory identity (§7.1 "bytes 必须可验证 base64 与摘要").
export function bodyIntegrityDefects(body: BodyValue): string[] {
  if (body.kind !== "bytes") return [];
  const bytes = decodeBase64(body.base64);
  if (bytes === null) return ["body-bytes-not-canonical-base64"];
  if (digestBytes(bytes) !== asDigest(body.sha256)) return ["body-bytes-digest-mismatch"];
  return [];
}

export function vectorIntegrityDefects(content: Omit<TestVectorContent, "eligibility" | "reasons">): string[] {
  return [
    ...bodyIntegrityDefects(content.request.body),
    ...bodyIntegrityDefects(content.response.body),
  ];
}

export type EligibilityFacts = {
  request: RequestSide;
  response: ResponseSide;
  expectedOutcome: ExpectedOutcome | null;
  coverage: Coverage;
};

// Blocked is computed, never supplied. A sample that cannot be compared stays
// in the inventory and still counts in a frozen plan (§7.4), so the reason list
// is part of the vector rather than a filter that hides it.
export function deriveEligibility(facts: EligibilityFacts): {
  eligibility: VectorEligibility;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (facts.request.method === null) reasons.push("vector-missing-method");
  if (facts.request.url === null) reasons.push("vector-missing-url");
  if (facts.expectedOutcome === null) reasons.push("vector-missing-oracle");
  if (facts.response.status === null) reasons.push("vector-response-status-unavailable");
  // Only the response side can make a comparison impossible on its own: a
  // withheld or unrecorded response body leaves nothing to decode, while a
  // body-less request is a complete observation of a body-less call.
  if (facts.response.body.kind === "missing") reasons.push("vector-response-body-missing");
  if (facts.response.body.kind === "redacted") reasons.push("vector-response-body-redacted");
  if (facts.request.body.kind === "redacted") reasons.push("vector-request-body-redacted");
  reasons.push(...coverageDeficiencyReasons(facts.coverage));
  const unique = [...new Set(reasons)];
  return { eligibility: unique.length > 0 ? "blocked" : "usable", reasons: unique };
}

export function draftReview(): VectorReview {
  return { status: "draft", reviewerId: null, reviewedAt: null, approvedDigest: null };
}

// Two different source records are two different cases: a revision may only
// point at a vector observed at the same coordinates (§7.4), so the coordinate
// identity is compared here rather than trusted from the caller.
export function sameSourceCoordinates(left: VectorSource, right: VectorSource): boolean {
  if (left.evidenceId !== right.evidenceId) return false;
  const ordinalMatch =
    left.recordOrdinal !== null &&
    right.recordOrdinal !== null &&
    left.recordOrdinal === right.recordOrdinal;
  const transactionMatch =
    left.transactionId !== null &&
    right.transactionId !== null &&
    left.transactionId === right.transactionId;
  return ordinalMatch || transactionMatch;
}

export function isJsonInteger(value: JsonValue): boolean {
  return typeof value === "number" && Number.isSafeInteger(value);
}

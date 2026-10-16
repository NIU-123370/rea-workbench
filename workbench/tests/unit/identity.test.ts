import { describe, expect, it } from "vitest";

import {
  REA_EVIDENCE_ID_PATTERN,
  asId,
  asInstant,
  instantToEpochMs,
  isId,
  isReaEvidenceId,
  newId,
  nowInstant,
} from "../../packages/domain/identity.ts";

describe("identities", () => {
  it("generates opaque UUIDs that are not names or paths", () => {
    const id = newId();
    expect(isId(id)).toBe(true);
    expect(() => asId("/tmp/har/session-1.har")).toThrow(TypeError);
    expect(() => asId("https://example.test/api")).toThrow(TypeError);
    expect(isId(id.toUpperCase())).toBe(false);
  });

  it("accepts only UTC RFC 3339 instants", () => {
    const instant = nowInstant();
    expect(() => asInstant(instant)).not.toThrow();
    expect(() => asInstant("2026-10-16T11:17:00+08:00")).toThrow(TypeError);
    expect(() => asInstant("2026-10-16 11:17:00")).toThrow(TypeError);
    expect(instantToEpochMs(asInstant("2026-01-01T00:00:00.000Z"))).toBe(Date.UTC(2026, 0, 1));
  });

  it("keeps upstream evidence ids in their own shape", () => {
    const hex = "a".repeat(64);
    expect(isReaEvidenceId(`ev_${hex}`)).toBe(true);
    expect(isReaEvidenceId(`ev_${"a".repeat(63)}`)).toBe(false);
    expect(isReaEvidenceId(`EV_${hex}`)).toBe(false);
    expect(REA_EVIDENCE_ID_PATTERN.source).toContain("ev_");
  });
});

import { describe, expect, it } from "vitest";

import { reaEvidenceSchema } from "../../packages/contracts/rea-evidence.ts";
import { decodeToolResult } from "../../packages/adapters/rea/envelope.ts";
import { projectEvidenceIndex } from "../../packages/adapters/rea/projection.ts";
import type { ReaEvidence } from "../../packages/contracts/rea-evidence.ts";

// These fixtures are hand-written from the mirrored §1 field list; they are
// synthetic, not captured provider output. Real REA 6.4.0 replies are verified
// against a live session in S14 (issue #14 carries that exit condition), and
// nothing here claims otherwise.

const HEX_A = "a".repeat(64);
const EV_A = `ev_${HEX_A}`;
const EV_B = `ev_${"b".repeat(64)}`;

function envelope(overrides: Partial<ReaEvidence> = {}): ReaEvidence {
  return {
    evidence_id: EV_A,
    subject: {
      name: "session.har",
      digest: { sha256: HEX_A },
      format: "file",
      architecture: null,
      local_path: "/operator/captures/session.har",
    },
    provider: {
      id: "har-schema/lossless-json",
      name: "REA HAR capture adapter",
      version: "har-schema@2.0.0;jsonc-parser@3.3.1;lossless-json@4.3.1",
    },
    analysis_profile: null,
    predicate_type: "rea.analysis",
    operation: "inspect_web_network_capture",
    parameters: { capture_path: "/operator/captures/session.har", format: "har", sensitive_value_count: 0 },
    raw_result: null,
    normalized_result: {
      decoder: { id: "har-schema/lossless-json", name: "REA HAR capture adapter", version: "x" },
      container: { reported: { log: { entries: null } }, numeric_literals: [], redactions: [], records_pointer: "/log/entries" },
      total_records: 1,
      records: [
        {
          ordinal: 0,
          location: { kind: "json-pointer", pointer: "/log/entries/0" },
          reported: { request: { method: "GET", url: "http://127.0.0.1:8080/cart" } },
          binary_fields: [],
          numeric_literals: [],
          redactions: [{ pointer: "/request/headers/0/value", reason: "transport-credential" }],
          limitations: ["HAR text is producer-decoded Unicode."],
        },
      ],
      artifact: { path: "/operator/captures/session.har", sha256: HEX_A, bytes: 4096 },
      format: "har",
      runtime_attribution: "unknown",
      limitations: [],
    },
    confidence: "observed",
    authority: "historical-reference",
    environment: null,
    limitations: ["Historical evidence does not prove runtime attribution."],
    relationship_coverage: null,
    locations: [{ kind: "artifact-path", path: "/operator/captures/session.har" }],
    evidence_links: [],
    ...overrides,
  } as ReaEvidence;
}

function wire(result: unknown): { content: { type: "text"; text: string }[]; structuredContent?: unknown; isError?: boolean } {
  const text = JSON.stringify(result);
  return { content: [{ type: "text", text }] };
}

describe("mirrored envelope (DESIGN §1, §4)", () => {
  it("carries exactly the upstream field names, snake_case included", () => {
    const parsed = reaEvidenceSchema.safeParse(envelope());
    expect(parsed.success).toBe(true);
    expect(Object.keys(envelope()).sort()).toEqual(
      [
        "analysis_profile",
        "authority",
        "confidence",
        "environment",
        "evidence_id",
        "evidence_links",
        "limitations",
        "locations",
        "normalized_result",
        "operation",
        "parameters",
        "predicate_type",
        "provider",
        "raw_result",
        "relationship_coverage",
        "subject",
      ].sort(),
    );
  });

  it("refuses an edited envelope rather than reusing its id", () => {
    // §4: an imported Evidence must validate against the schema and its
    // semantic summary; a field may not be rewritten under the same id.
    expect(reaEvidenceSchema.safeParse({ ...envelope(), confidence: "observed-but-approved" }).success).toBe(false);
    expect(reaEvidenceSchema.safeParse({ ...envelope(), authority: "analyst" }).success).toBe(false);
    expect(reaEvidenceSchema.safeParse(envelope({ evidence_id: "ev_short" })).success).toBe(false);
    const missing = { ...envelope() } as Record<string, unknown>;
    delete missing["relationship_coverage"];
    expect(reaEvidenceSchema.safeParse(missing).success).toBe(false);
    expect(reaEvidenceSchema.safeParse({ ...envelope(), injected: 1 }).success).toBe(false);
  });

  it("keeps the five location discriminators and drops nothing silently", () => {
    for (const location of [
      { kind: "address", address: "0x1000" },
      { kind: "address-range", start: "0x1000", end: "0x1010" },
      { kind: "artifact-path", path: "/tmp/a" },
      { kind: "file-offset", offset: 12 },
      { kind: "file-offset-range", start: 12, end: 24 },
    ]) {
      expect(reaEvidenceSchema.safeParse(envelope({ locations: [location as never] })).success).toBe(true);
    }
    expect(reaEvidenceSchema.safeParse(envelope({ locations: [{ kind: "line", number: 3 } as never] })).success).toBe(false);
    expect(reaEvidenceSchema.safeParse(envelope({ locations: [{ kind: "file-offset", offset: -1 } as never] })).success).toBe(false);
  });
});

describe("reply decoding (DESIGN §9)", () => {
  it("reads an evidence-kind reply straight from structuredContent", () => {
    const decoded = decodeToolResult({ content: [{ type: "text", text: "{}" }], structuredContent: envelope() });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.kind).toBe("evidence");
  });

  it("falls back to the text block when structuredContent is absent", () => {
    const decoded = decodeToolResult(wire(envelope()));
    expect(decoded.ok && decoded.value.kind === "evidence").toBe(true);
  });

  it("never treats a missing structuredContent as an empty success", () => {
    const decoded = decodeToolResult(wire({}));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.code).toBe("REA_CONTRACT_MISMATCH");
    expect(decoded.error.reason).toBe("unknown-success-shape");
  });

  it("accepts a session-kind { result } reply as a value, not evidence", () => {
    const decoded = decodeToolResult({
      content: [{ type: "text", text: "{}" }],
      structuredContent: { result: { open: false } },
    });
    expect(decoded.ok && decoded.value.kind === "value").toBe(true);
  });

  it("keeps the typed error when isError deletes structuredContent on the wire", () => {
    const failure = {
      error: {
        code: "resource_constraint",
        category: "resource_constraint",
        message: "reply exceeds the transport budget",
        retryable: true,
        remediation: { action: "use inspect_analysis_view pagination" },
      },
    };
    const decoded = decodeToolResult({ content: [{ type: "text", text: JSON.stringify(failure) }], isError: true });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    if (decoded.value.kind !== "error") throw new Error("expected error outcome");
    expect(decoded.value.error.code).toBe("resource_constraint");
    expect(decoded.value.error.retryable).toBe(true);
    expect(decoded.value.error.remediation.action).toBe("use inspect_analysis_view pagination");
    expect(decoded.value.retainedEvidenceId).toBeNull();
  });

  it("carries a retained partial observation out of a failed call", () => {
    const decoded = decodeToolResult({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "truncated",
              category: "truncated",
              message: "partial",
              retryable: false,
              remediation: { action: "read the retained record" },
              details: { partial_observation: { kind: "retained-evidence", evidence_id: EV_B } },
            },
          }),
        },
      ],
      isError: true,
    });
    expect(decoded.ok && decoded.value.kind === "error" && decoded.value.retainedEvidenceId).toBe(EV_B);
  });

  it("refuses an unmodelled error envelope instead of guessing from prose", () => {
    for (const text of ['{"error":{"code":"weird"}}', "provider exploded", "{}"]) {
      const decoded = decodeToolResult({ content: [{ type: "text", text }], isError: true });
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.error.code).toBe("REA_CONTRACT_MISMATCH");
    }
  });

  it("rejects a reply with no content block at all", () => {
    expect(decodeToolResult({ structuredContent: envelope() }).ok).toBe(false);
    expect(decodeToolResult(null).ok).toBe(false);
  });
});

describe("index projection (DESIGN §4, §5)", () => {
  it("lifts identity fields without changing confidence or authority", () => {
    // A non-observed fixture is deliberate: if the projection defaulted to
    // `observed`, or promoted a derived fact, this assertion would notice.
    const source = envelope({ confidence: "derived", authority: "analyst-inference" });
    const result = projectEvidenceIndex(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidenceId).toBe(EV_A);
    expect(result.value.confidence).toBe("derived");
    expect(result.value.authority).toBe("analyst-inference");
    expect(result.value.operation).toBe("inspect_web_network_capture");
    expect(result.value.sourceSha256).toBe(HEX_A);
    expect(result.value.identityReason).toBeNull();
    expect(result.value.locationsRetained).toBe(true);
    expect(result.value.provider.version).toBeTypeOf("string");
  });

  it("records a withheld digest as a disclosed unknown", () => {
    const result = projectEvidenceIndex(envelope({ subject: null, locations: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceSha256).toBeNull();
    expect(result.value.identityReason).toBe("producer-withheld-or-declared-sensitive");
    expect(result.value.locationsRetained).toBe(false);
  });

  it("refuses an evidence id that is not upstream-shaped", () => {
    const forged = { ...envelope(), evidence_id: "workbench-generated-1" } as ReaEvidence;
    expect(projectEvidenceIndex(forged).ok).toBe(false);
  });
});

import { z } from "zod";

import { digestSchema, jsonValueSchema, nonEmptyString } from "./primitives.ts";
import { reaEvidenceSchema } from "./rea-evidence.ts";
import { reaJavaScriptApplicationSummarySchema } from "./rea-static-analysis.ts";

// Field-for-field mirror of the REA 6.4.0 `inspect_analysis_view` contract at
// commit 98d8470d. Upstream owners read directly:
//   src/domain/analysisView/analysisView.ts:32-46        summary / facet views
//   src/domain/analysisView/analysisView.ts:47-77        item selectors and views
//   src/domain/analysisView/analysisView.ts:78-118       page and native views
//   src/domain/analysisView/analysisView.ts:120-146      request / source / input
//   src/domain/analysisView/analysisView.ts:167-193      coverage, artifact, layout summary
//   src/domain/analysisView/analysisView.ts:196-275      the six view results
//   src/domain/analysisView/webNetworkApiSurfaceView.ts:15-65  api-surface view + fields
//   src/contracts/analysisViewToolContracts.ts:14-27     the tool contract itself
//   src/contracts/toolOutputSchemaPrimitives.ts:29-32    `evidenceResultOf`
//
// Everything here is the *advertised* shape as well as the source shape: it was
// reconciled against `tools/list` of the built provider at 98d8470d on
// 2026-10-16 (173 tools; `inspect_analysis_view` input properties exactly
// ["source","view"], required ["source","view"], `additionalProperties:false`;
// output root exactly the 16 Evidence envelope fields, required 16,
// `additionalProperties:false`). The recorded shapes live in
// `tests/fixtures/rea-live-tools-shapes.json` and the comparing owner is
// `adapters/rea/schema-reconciliation.ts` — not this file (DESIGN §1, §9 item 2).
//
// Two divergences, both stated rather than hidden:
//
//   1. Upstream types the inline source payload as `z.unknown().nonoptional()`
//      (analysisView.ts:120-124) and advertises the full 16-field envelope in its
//      place: the application, not the input schema, owns authenticated Evidence
//      parsing. This mirror keeps `reaEvidenceSchema` there, so an inline source
//      that omits `relationship_coverage` is refused here even though the
//      provider would accept it and fill the producer default. That is the same
//      consumer-side strictness already recorded in `rea-evidence.ts`, and it is
//      deliberate: §4 and §6 forbid upgrading an unobserved claim.
//   2. Upstream builds `analysisViewSourceSchema` as a `discriminatedUnion` on
//      `kind`; the advertised JSON Schema is a plain `oneOf`. Same accepted set,
//      so this mirror keeps the upstream spelling.
//
// Property ORDER carries no meaning in either dialect and is never compared as
// if it did, exactly as catalog order is not an identity (§9 item 2).

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const jagNodeIdSchema = z.string().regex(/^jag_node_[a-f0-9]{64}$/u);
const count = z.number().int().nonnegative();

// --- request views (analysisView.ts:32-118) --------------------------------

export const reaSummaryViewSchema = z.strictObject({ kind: z.literal("summary") });

export const reaFacetViewSchema = z.strictObject({
  kind: z.literal("facet"),
  facet: z.enum(["mitigations", "linkage"]),
});

export const reaIndexSelectorSchema = z.strictObject({ index: count });
// Upstream admits the empty string on both selectors: an observed module path or
// original source-map reference may legitimately be empty
// (analysisView.ts:51-59), and a section/symbol name is `z.string()` (:50).
export const reaNameSelectorSchema = z.strictObject({ name: z.string() });
export const reaPathSelectorSchema = z.strictObject({ path: z.string() });
export const reaNodeIdSelectorSchema = z.strictObject({ node_id: jagNodeIdSchema });

const reaModuleItemViewSchema = z.strictObject({
  kind: z.literal("item"),
  collection: z.literal("modules"),
  selector: z.union([reaPathSelectorSchema, reaNodeIdSelectorSchema]),
});

const reaSectionOrSymbolItemViewSchema = z.strictObject({
  kind: z.literal("item"),
  collection: z.enum(["sections", "symbols"]),
  selector: z.union([reaIndexSelectorSchema, reaNameSelectorSchema]),
});

// The collection-specific selector alternatives are part of the advertised
// contract, not a refinement: modules take path/node_id, sections and symbols
// take index/name. Upstream keeps them separate for exactly that reason
// (analysisView.ts:60-77) — a refinement-only constraint does not survive JSON
// Schema conversion, so the advertised schema would otherwise accept a
// combination the runtime then rejects.
export const reaItemViewSchema = z.discriminatedUnion("collection", [
  reaModuleItemViewSchema,
  reaSectionOrSymbolItemViewSchema,
]);

export const reaPageViewSchema = z.strictObject({
  kind: z.literal("page"),
  collection: z.enum(["sections", "symbols", "modules"]),
  offset: count,
  limit: z.number().int().positive(),
});

export const reaNativeViewFacets = [
  "procedure",
  "pseudocode",
  "assembly",
  "basic_blocks",
  "comments",
  "callers",
  "callees",
  "incoming_references",
  "outgoing_references",
  "unresolved_calls",
  "referenced_strings",
  "referenced_names",
  "native_api",
  "value_flow_summary",
  "value_flow_operations",
  "value_flow_def_use",
  "value_flow_effects",
  "value_flow_parameters",
  "value_flow_parameter_uses",
] as const;

export const reaNativeViewSchema = z.strictObject({
  kind: z.literal("native"),
  facet: z.enum(reaNativeViewFacets),
  offset: count.default(0),
  limit: z.number().int().positive().default(64),
});

// webNetworkApiSurfaceView.ts:15-19
export const reaApiSurfaceViewSchema = z.strictObject({
  kind: z.literal("api-surface"),
  offset: count.default(0),
  limit: z.number().int().positive().default(50),
});

export const reaAnalysisViewRequestSchema = z.discriminatedUnion("kind", [
  reaSummaryViewSchema,
  reaFacetViewSchema,
  reaItemViewSchema,
  reaPageViewSchema,
  reaNativeViewSchema,
  reaApiSurfaceViewSchema,
]);

// --- source (analysisView.ts:133-146) -------------------------------------

export const reaRetainedEvidenceSourceSchema = z.strictObject({
  kind: z.literal("retained-evidence"),
  evidence_id: evidenceIdSchema,
});

export const reaInlineEvidenceSourceSchema = z.strictObject({
  kind: z.literal("inline"),
  evidence: reaEvidenceSchema,
});

export const reaAnalysisViewSourceSchema = z.discriminatedUnion("kind", [
  reaRetainedEvidenceSourceSchema,
  reaInlineEvidenceSourceSchema,
]);

export const inspectAnalysisViewInputSchema = z.strictObject({
  source: reaAnalysisViewSourceSchema,
  view: reaAnalysisViewRequestSchema,
});

export type InspectAnalysisViewInput = z.infer<typeof inspectAnalysisViewInputSchema>;
export type ReaAnalysisViewSource = z.infer<typeof reaAnalysisViewSourceSchema>;
export type ReaAnalysisViewRequest = z.infer<typeof reaAnalysisViewRequestSchema>;

// --- result views (analysisView.ts:167-275) -------------------------------

export const reaAnalysisViewCoverageSchema = z.strictObject({
  status: z.enum(["complete-within-view", "page", "empty"]),
  examined: count,
  total: count,
  next_offset: count.nullable(),
  exhausted: z.boolean(),
});

// analysisView.ts:175-181 — the recorded artifact path is admitted even when it
// is the empty string, so this is deliberately `z.string()` and not `nonEmptyString`.
export const reaAnalysisViewArtifactSchema = z.strictObject({
  path: z.string(),
  sha256: digestSchema,
});

export const reaBinaryLayoutSummarySchema = z.strictObject({
  bytes: count,
  format: z.literal("elf"),
  architecture: z.strictObject({
    machine: z.literal("EM_X86_64"),
    bits: z.literal(64),
    byte_order: z.literal("little"),
  }),
  image_type: z.enum(["ET_EXEC", "ET_DYN", "ET_REL"]),
  entry: z.strictObject({
    reported_value: nonEmptyString,
    meaning: z.enum(["linked-virtual-address", "not-applicable", "absent"]),
    execution_status: z.literal("unknown"),
  }),
  counts: z.strictObject({
    sections: count,
    segments: count,
    symbols: count,
    relocations: count,
  }),
  limitation_count: count,
});

const reaApiSurfaceRuleSchema = z.enum(["numeric", "uuid", "hex", "iso-date"]);

const reaApiSurfaceGroupSchema = z.strictObject({
  method: z.string(),
  origin: z.string(),
  path_template: z.string(),
  templated_segments: z.array(
    z.strictObject({
      segment_index: count,
      rule: reaApiSurfaceRuleSchema,
      // A templated segment is always an inference; the literal is upstream's
      // own claim and nothing here may widen it (DESIGN §6).
      basis: z.literal("inferred"),
      observed_values: z.array(z.string()),
    }),
  ),
  record_ordinals: z.array(count),
  statuses: z.array(z.number()),
  content_types: z.array(z.string()),
  flags: z.array(z.enum(["single-sample", "mixed-statuses", "mixed-content-types"])),
});

// webNetworkApiSurfaceView.ts:38-65 `apiSurfaceFields`
const reaApiSurfaceFields = {
  records: z.strictObject({
    examined: count,
    total: count,
    excluded: count,
  }),
  templated_groups: count,
  groups: z.array(reaApiSurfaceGroupSchema),
  excluded_records: z.array(
    z.strictObject({
      ordinal: count,
      reason: z.enum([
        "url-redacted",
        "url-unparseable",
        "request-unavailable",
        "method-unavailable",
      ]),
    }),
  ),
};

const reaViewResultBase = {
  parent_evidence_id: evidenceIdSchema,
  parent_operation: z.enum([
    "inspect_binary_layout",
    "analyze_javascript_application",
    "analyze_function",
  ]),
  parent_digest: digestSchema,
  view_digest: digestSchema,
  artifact: reaAnalysisViewArtifactSchema,
  coverage: reaAnalysisViewCoverageSchema,
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
};

export const reaAnalysisViewResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...reaViewResultBase,
    ...reaApiSurfaceFields,
    kind: z.literal("api-surface"),
    parent_operation: z.literal("inspect_web_network_capture"),
    view: reaApiSurfaceViewSchema,
    // The api-surface member narrows the base artifact: a HAR capture may carry
    // no digest at all (webNetworkApiSurfaceView.ts:100-118).
    artifact: z.strictObject({ path: z.string(), sha256: digestSchema.nullable() }),
  }),
  z.strictObject({
    kind: z.literal("summary"),
    view: reaSummaryViewSchema,
    summary: z.union([reaBinaryLayoutSummarySchema, reaJavaScriptApplicationSummarySchema]),
    ...reaViewResultBase,
  }),
  z.strictObject({
    kind: z.literal("facet"),
    view: reaFacetViewSchema,
    facet: jsonValueSchema,
    ...reaViewResultBase,
  }),
  z.strictObject({
    kind: z.literal("item"),
    view: reaItemViewSchema,
    item: jsonValueSchema,
    ...reaViewResultBase,
  }),
  z.strictObject({
    kind: z.literal("page"),
    view: reaPageViewSchema,
    items: z.array(jsonValueSchema),
    ...reaViewResultBase,
  }),
  z.strictObject({
    kind: z.literal("native"),
    view: reaNativeViewSchema,
    procedure_address: z.string().nullable(),
    item: jsonValueSchema,
    ...reaViewResultBase,
  }),
]);

// `evidenceResultOf(analysisViewResultSchema)` (analysisViewToolContracts.ts:26)
// re-declares the envelope with `normalized_result` specialised. The envelope
// fields themselves stay owned by `rea-evidence.ts`; this only replaces the one
// field the operation specialises, which is exactly how upstream spells it.
export const inspectAnalysisViewOutputSchema = reaEvidenceSchema.extend({
  normalized_result: reaAnalysisViewResultSchema,
});

export type ReaAnalysisViewResult = z.infer<typeof reaAnalysisViewResultSchema>;
export type InspectAnalysisViewOutput = z.infer<typeof inspectAnalysisViewOutputSchema>;

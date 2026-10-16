import { z } from "zod";

import { reaEvidenceSchema } from "./rea-evidence.ts";

// Field-for-field mirror of the REA 6.4.0 `analyze_javascript_application`
// request and normalized result at commit 98d8470d, for the ASAR static branch
// (DESIGN §1 "ASAR 有哪些静态模块与边界", PRD F12, D05). Upstream names stay
// snake_case and nothing here re-models an ASAR container: REA owns the reader,
// the graph identity derivation and every fact state, and the workbench only
// projects the already-parsed result (DESIGN §4, §9).
//
// Upstream owners mirrored by this file:
//   src/domain/javascript/javascriptApplicationAnalysis.ts:27-33   request
//   src/domain/javascript/javascriptApplicationAnalysis.ts:36-58   boundary summary
//   src/domain/javascript/javascriptApplicationAnalysis.ts:60-70   statistics
//   src/domain/javascript/javascriptApplicationAnalysis.ts:72-85   result shape
//   src/domain/javascript/javascriptApplicationAnalysis.ts:93-160  cross-graph bindings
//   src/domain/javascript/javascriptApplicationGraphSchemas.ts:15-152  graph
//   src/domain/javascript/javascriptApplicationEvidenceSchemas.ts:8-480 provenance
//   src/domain/javascript/javascriptSemanticGraphSchemas.ts:13-372  semantic graph
//   src/domain/javascript/javascriptSourceMapPaths.ts:7-21         map reference
//   src/domain/javascript/javascriptSourceSelection.ts:4-15        source selection
//   src/domain/javascript/javascriptAnalysisResourceControls.ts:44-81
//   src/domain/artifactIntegrityPolicy.ts:9-11
//   src/domain/artifactGraph.ts:4-21,144-156                       contradiction
//   src/domain/localPath.ts:15-20, src/domain/digests.ts:16-33
//   src/contracts/javascript/electronToolContracts.ts:32-39,89-122  advertised tool
//   src/contracts/analysisDetail.ts:6-11,18-24
//   src/contracts/toolOutputSchemaPrimitives.ts:29-32              evidenceResultOf
//   src/domain/analysisView/analysisView.ts:35,146-159,184-219      summary view
//   src/domain/analysisView/javascriptApplicationView.ts:131-162    unknowns formula
//   src/application/javascript/JavaScriptApplicationEvidence.ts:73-103 producer fields
//
// Two documented divergences, both deliberate:
//
//   1. Upstream re-derives and verifies `node_id` / `observation_id` / `edge_id`
//      / `graph_id` as canonical-JSON commitments
//      (javascriptApplicationGraph.ts:258-457, javascriptSemanticGraph.ts:708-709).
//      This mirror validates only the *shape* of those ids. Re-implementing the
//      digest here would create a second, drifting copy of the owner's
//      algorithm; the enforcing path is REA itself, exactly as recorded for the
//      envelope mirror in `adapters/rea/projection.ts` and issue #14.
//   2. Upstream declares `integrityContradictionSchema` with `z.object`
//      (src/domain/artifactGraph.ts:144), which in zod v4 strips unmodelled
//      keys. Here it is a `z.strictObject`, following `rea-evidence.ts`: an
//      unmodelled field is refused, never silently dropped (DESIGN §4).
//
// What could NOT be found at the pinned commit, stated plainly:
//   * There is no sensitive-value projection for this operation anywhere in REA.
//     `analyzeJavaScriptApplicationInputSchema` (javascriptApplicationAnalysis.ts:27-33)
//     has no sensitive field, and a repository-wide search for `sensitive_values`
//     in the JavaScript domain and contract directories returns nothing; the only
//     upstream owner of that field is `src/domain/webNetworkCapture.ts` (HAR and
//     mitmproxy). An ASAR import that declares sensitive values therefore cannot
//     be honoured by upstream and is refused — see `application/static-analysis.ts`
//     and DESIGN §8 / PRD A11.
//   * Upstream advertises no ASAR execution, launch or runtime-attach contract on
//     this operation; the tool description and `toolEffects.ts:482` classify it as
//     reconstruction without executing (docs/javascript-application-workflows.md:14).
//     Nothing in this file can express a runtime claim.
//   * `resource-controls` field documentation strings (`.describe(...)`) are
//     upstream presentation metadata and are not carried here.
//   * No real `.asar` file was parsed by REA while writing this mirror; the
//     fixture in `tests/fixtures/` is hand-built against these shapes. What HAS
//     been run against the built provider at 98d8470d (2026-10-16) is the
//     `format: "directory"` branch on a 3-file sample: it produced a 16-field
//     envelope with `confidence: "derived"` that `reaEvidenceSchema` accepts, and
//     `detail: "summary"` returned an `inspect_analysis_view` envelope whose
//     `parameters.parent_evidence_id` is the retained complete record. No claim
//     here rests on an asar run.

const boundedText = z.string().min(1);
const boundedKey = z.string().min(1);

// src/domain/javascript/javascriptApplicationAnalysis.ts:24
const countSchema = z.number().int().min(0);

// src/domain/digests.ts:16,19
const reaDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

// src/domain/digests.ts:27-33
function reaPrefixedDigest(prefix: string): z.ZodString {
  return z.string().regex(new RegExp(`^${prefix}_[a-f0-9]{64}$`, "u"));
}

// src/domain/javascript/javascriptApplicationEvidenceSchemas.ts:8-18
const reaRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path: string) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((part) => part !== "" && part !== ".."),
    "Expected a normalized relative POSIX path without traversal",
  );

// src/domain/localPath.ts:15-20 (a selected local filesystem path: NUL-free and
// nonempty). Upstream spells the NUL as `\x00`; this mirror keeps the same
// spelling `rea-evidence.ts:71` already uses for the envelope's `local_path`, so
// both halves of the workbench's path handling stay in step.
export const reaLocalPathSchema = z.string().regex(/^[^\0]*$/u).min(1);

// src/domain/artifactIntegrityPolicy.ts:9-11
export const reaArtifactIntegrityPolicySchema = z
  .enum(["fail", "record-and-continue"])
  .default("fail");

// src/domain/javascript/javascriptSourceSelection.ts:4-15
export const reaSourcePathsSchema = z.array(z.string().min(1)).min(1);

export const reaSourceSelectionSchema = z.strictObject({
  requested_paths: reaSourcePathsSchema,
  unselected_files: countSchema,
});

// src/domain/javascript/javascriptAnalysisResourceControls.ts:44-81
export const reaAnalysisResourceControlsSchema = z.strictObject({
  max_semantic_nodes: z.number().int().min(1).max(1_000_000).optional(),
  max_semantic_nodes_per_file: z.number().int().min(1).max(1_000_000).optional(),
  max_heap_mb: z.number().int().min(128).max(16_384).optional(),
  analysis_timeout_ms: z.number().int().min(1).max(2_147_483_647).optional(),
});

// src/contracts/analysisDetail.ts:6-11
export const reaAnalysisDetailSchema = z.enum(["complete", "summary"]).default("complete");

// src/domain/javascript/javascriptApplicationAnalysis.ts:27-33 plus
// src/contracts/javascript/electronToolContracts.ts:32-35, i.e. the complete
// advertised `analyze_javascript_application` input.
//
// `detail` belongs HERE, not in a second "request" schema. Upstream adds it to
// the tool's own inputSchema, so the field-for-field mirror of the tool input
// has to carry it: while it lived only in the derived request schema below,
// this strictObject refused a field the provider advertises as legal. That was
// caught at runtime, not by reading, because `tools/list` of the built provider
// at 98d8470d advertises exactly
// ["analysis_timeout_ms","detail","format","input_path","integrity_policy",
//  "max_heap_mb","max_semantic_nodes","max_semantic_nodes_per_file","source_paths"]
// with required ["input_path"] and additionalProperties:false, and
// `adapters/rea/schema-reconciliation.ts` now compares that advertised key set
// against the one derived from this schema (DESIGN §1, §9 item 2).
//
// Upstream's own two-level split (domain input + MCP request wrapper) collapses
// into one mirror here; the wrapper is re-exported below only so existing
// imports keep resolving, and it is the *same* schema object, so `detail` still
// has exactly one owner.
export const analyzeJavaScriptApplicationInputSchema = z.strictObject({
  input_path: reaLocalPathSchema,
  format: z.enum(["auto", "asar", "directory"]).default("auto"),
  integrity_policy: reaArtifactIntegrityPolicySchema,
  source_paths: reaSourcePathsSchema.optional(),
  ...reaAnalysisResourceControlsSchema.shape,
  detail: reaAnalysisDetailSchema,
});

// Alias, not a second mirror: the MCP request shape and the tool input shape are
// one and the same schema at this baseline.
export const analyzeJavaScriptApplicationRequestSchema = analyzeJavaScriptApplicationInputSchema;

// --- provenance (javascriptApplicationEvidenceSchemas.ts) ------------------

// :21-34
export const reaApplicationEvidenceAuthoritySchema = z.enum([
  "artifact-bytes",
  "ast-static-analysis",
  "static-relationship-inference",
  "passive-cdp-runtime",
  "cross-layer-reconciliation",
  "cross-version-comparison",
  "controlled-replay",
  "native-analysis-provider",
  "managed-static-analysis",
  "historical-reference",
  "user-assertion",
  "unknown",
]);

// :37-42 — the epistemic state of one graph fact. `inferred` is a producer
// value and the workbench never rewrites it (DESIGN §6, D08).
export const reaApplicationFactStateSchema = z.enum([
  "observed",
  "inferred",
  "unknown",
  "unavailable",
]);

// :45-51
export const reaApplicationConfidenceSchema = z.enum([
  "exact",
  "high",
  "medium",
  "low",
  "unknown",
]);

// :54-61
export const reaApplicationUnavailableReasonSchema = z.enum([
  "not-applicable",
  "not-observed",
  "truncated",
  "provider-unavailable",
  "unresolved",
  "unknown",
]);

const reaUnavailableFactSchema = z.strictObject({
  available: z.literal(false),
  reason: reaApplicationUnavailableReasonSchema,
  detail: boundedText,
});

// :69-88 — the producer's own commitment `artifact_id === art_<sha256>`.
const reaAvailableArtifactSchema = z
  .strictObject({
    available: z.literal(true),
    artifact_id: reaPrefixedDigest("art"),
    sha256: reaDigestSchema,
  })
  .superRefine((artifact, context) => {
    if (artifact.artifact_id !== `art_${artifact.sha256}`) {
      context.addIssue({
        code: "custom",
        path: ["artifact_id"],
        message: "Artifact identifier must commit the same SHA-256 digest",
      });
    }
  });

export const reaApplicationArtifactReferenceSchema = z.discriminatedUnion("available", [
  reaAvailableArtifactSchema,
  reaUnavailableFactSchema,
]);

// :90-160
const reaSourceRangeSchema = z
  .strictObject({
    kind: z.literal("source-range"),
    source: boundedText,
    start: z.strictObject({ line: z.number().int().min(1), column: z.number().int().min(0) }),
    end: z.strictObject({ line: z.number().int().min(1), column: z.number().int().min(0) }),
  })
  .superRefine((range, context) => {
    if (
      range.end.line < range.start.line ||
      (range.end.line === range.start.line && range.end.column < range.start.column)
    ) {
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "Source range end must not precede its start",
      });
    }
  });

const reaFileOffsetRangeSchema = z
  .strictObject({
    kind: z.literal("file-offset-range"),
    start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    end: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((range, context) => {
    if (range.end < range.start) {
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "File offset range end must not precede its start",
      });
    }
  });

export const reaApplicationLocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("artifact-path"), path: reaRelativePathSchema }),
  reaSourceRangeSchema,
  reaFileOffsetRangeSchema,
  z.strictObject({ kind: z.literal("url"), url: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("runtime"),
    capture_sha256: reaDigestSchema,
    target_key: boundedKey,
    frame_key: boundedKey.nullable(),
    script_key: boundedKey.nullable(),
  }),
  z.strictObject({
    kind: z.literal("native-address"),
    address: boundedKey,
    symbol: boundedText.nullable(),
  }),
  z.strictObject({
    kind: z.literal("package-export"),
    package_name: boundedKey,
    export_path: boundedText,
  }),
]);

export const reaApplicationLocationReferenceSchema = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(true), value: reaApplicationLocationSchema }),
  reaUnavailableFactSchema,
]);

// :172-191
const reaApplicationExtractorSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  operation: z.string().min(1),
  executable_sha256: reaDigestSchema.nullable(),
});

const reaApplicationLimitSchema = z.strictObject({
  name: z.string().min(1),
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  unit: z.enum(["items", "bytes", "milliseconds", "depth", "characters", "instructions", "other"]),
});

// :197-222 — bounded coverage; omission is never absence.
export const reaApplicationCoverageSchema = z.union([
  z.strictObject({
    status: z.literal("complete"),
    truncated: z.literal(false),
    omitted_count: z.literal(0),
    limits: z.array(reaApplicationLimitSchema),
  }),
  z.strictObject({
    status: z.literal("partial"),
    truncated: z.literal(false),
    omitted_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    limits: z.array(reaApplicationLimitSchema),
  }),
  z.strictObject({
    status: z.literal("partial"),
    truncated: z.literal(true),
    omitted_count: z
      .union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.null()])
      .nullable(),
    limits: z.array(reaApplicationLimitSchema).min(1),
  }),
  z.strictObject({
    status: z.enum(["unknown", "unavailable"]),
    truncated: z.literal(false),
    omitted_count: z.null(),
    limits: z.array(reaApplicationLimitSchema),
  }),
]);

// :260-270 plus the four refinement rules at :282-417. The refinements are the
// producer's own anti-promotion guarantees, so they are mirrored rather than
// paraphrased: a static-relationship authority must stay inferred, an unknown
// authority cannot claim an observed fact, and an inferred fact must carry a
// limitation.
const reaApplicationEvidenceBaseSchema = z.strictObject({
  authority: reaApplicationEvidenceAuthoritySchema,
  state: reaApplicationFactStateSchema,
  confidence: reaApplicationConfidenceSchema,
  artifact: reaApplicationArtifactReferenceSchema,
  location: reaApplicationLocationReferenceSchema,
  extractor: reaApplicationExtractorSchema,
  coverage: reaApplicationCoverageSchema,
  limitations: z.array(boundedText),
  evidence_ids: z.array(reaPrefixedDigest("ev")),
});

export const reaApplicationGraphEvidenceSchema = reaApplicationEvidenceBaseSchema.superRefine(
  (evidence, context) => {
    if (
      (evidence.authority === "static-relationship-inference" ||
        evidence.authority === "cross-layer-reconciliation" ||
        evidence.authority === "cross-version-comparison") &&
      evidence.state !== "inferred"
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "Inference-only authorities must remain inferred",
      });
    }
    if (evidence.authority === "unknown" && !["unknown", "unavailable"].includes(evidence.state)) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "Unknown authority cannot claim an observed fact",
      });
    }
    if (
      ["unknown", "unavailable"].includes(evidence.state) &&
      (evidence.confidence !== "unknown" || evidence.limitations.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Unknown and unavailable facts require unknown confidence and an explicit limitation",
      });
    }
    if (evidence.state === "observed" && evidence.confidence === "unknown") {
      context.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "Observed facts require a bounded non-unknown confidence",
      });
    }
    if (evidence.state === "inferred" && !["high", "medium", "low"].includes(evidence.confidence)) {
      context.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "Inferred facts require high, medium, or low confidence",
      });
    }
    if (evidence.confidence === "exact" && evidence.state !== "observed") {
      context.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "Exact confidence is reserved for observed facts",
      });
    }
    if (evidence.state === "observed" && !evidence.location.available) {
      context.addIssue({
        code: "custom",
        path: ["location"],
        message: "Observed facts require an actionable location",
      });
    }
    if (evidence.state === "inferred" && evidence.limitations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "Inferred facts require an explicit limitation",
      });
    }
    if (evidence.coverage.status !== "complete" && evidence.limitations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["limitations"],
        message: "Non-complete coverage requires an explicit limitation",
      });
    }
    const artifactBacked = [
      "artifact-bytes",
      "ast-static-analysis",
      "controlled-replay",
      "native-analysis-provider",
      "managed-static-analysis",
    ].includes(evidence.authority);
    if (artifactBacked && evidence.state !== "unavailable" && !evidence.artifact.available) {
      context.addIssue({
        code: "custom",
        path: ["artifact"],
        message: "Artifact-backed facts require a content digest",
      });
    }
  },
);

// :273-278 — provenance apart from the location, and the location on its own.
export const reaApplicationEvidenceContextSchema = z.strictObject({
  authority: reaApplicationEvidenceAuthoritySchema,
  state: reaApplicationFactStateSchema,
  confidence: reaApplicationConfidenceSchema,
  artifact: reaApplicationArtifactReferenceSchema,
  extractor: reaApplicationExtractorSchema,
  coverage: reaApplicationCoverageSchema,
  limitations: z.array(boundedText),
  evidence_ids: z.array(reaPrefixedDigest("ev")),
});

// :420-480 — stable node identity strategies, verbatim.
export const reaApplicationNodeIdentitySchema = z.discriminatedUnion("strategy", [
  z.strictObject({
    strategy: z.literal("content-digest"),
    stability: z.literal("global-exact"),
    sha256: reaDigestSchema,
  }),
  z.strictObject({
    strategy: z.literal("source-map-original"),
    stability: z.literal("source-map-exact"),
    source_map_sha256: reaDigestSchema,
    original_source: z.string(),
    source_root: z.string().nullable(),
    source_sha256: reaDigestSchema.nullable(),
  }),
  z.strictObject({
    strategy: z.literal("canonical-path"),
    stability: z.literal("artifact-version"),
    artifact_sha256: reaDigestSchema,
    path: reaRelativePathSchema,
  }),
  z.strictObject({
    strategy: z.literal("structural-fingerprint"),
    stability: z.literal("cross-version-inference"),
    algorithm: z.string().min(1),
    fingerprint_sha256: reaDigestSchema,
    basis: z
      .array(
        z.enum([
          "syntax-tree",
          "control-flow",
          "imports",
          "exports",
          "literals",
          "api-usage",
        ]),
      )
      .min(1),
  }),
  z.strictObject({
    strategy: z.literal("artifact-local-key"),
    stability: z.literal("artifact-version"),
    artifact_sha256: reaDigestSchema,
    namespace: boundedKey,
    key: z.string(),
  }),
  z.strictObject({
    strategy: z.literal("runtime-instance"),
    stability: z.literal("capture-only"),
    capture_sha256: reaDigestSchema,
    runtime_key: boundedText,
  }),
  z.strictObject({
    strategy: z.literal("observation-fingerprint"),
    stability: z.literal("observation-only"),
    observation_sha256: reaDigestSchema,
    scope: boundedText,
  }),
]);

// src/domain/javascript/javascriptSourceMapPaths.ts:7-21
export const reaSourceMapReferenceSchema = z.strictObject({
  source_name: z.string(),
  source_root: z.string().nullable(),
  map_path: z.string().min(1),
  resolution: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.enum(["artifact-relative", "suffix"]), path: z.string().min(1) }),
    z.strictObject({ kind: z.literal("unresolved"), reason: z.string().min(1) }),
  ]),
});

// --- application graph (javascriptApplicationGraphSchemas.ts) --------------

// :15-51
export const JAVASCRIPT_APPLICATION_NODE_KINDS = [
  "package",
  "installer",
  "artifact",
  "asar-entry",
  "electron-main",
  "electron-preload",
  "electron-renderer",
  "electron-utility",
  "javascript-asset",
  "javascript-chunk",
  "javascript-module",
  "javascript-expression",
  "source-map",
  "source-module",
  "browser-window",
  "frame",
  "target",
  "context-bridge-api",
  "ipc-channel",
  "ipc-handler",
  "worker",
  "service-worker",
  "endpoint",
  "storage",
  "native-addon",
  "native-export",
  "managed-assembly",
  "managed-module",
  "managed-type",
  "managed-method",
  "managed-field",
  "managed-pinvoke-import",
  "managed-native-implementation",
  "runtime-script-instance",
  "unknown",
] as const;

// :57-70
export const JAVASCRIPT_APPLICATION_RELATIONS = [
  "contains",
  "loads",
  "imports",
  "maps_to",
  "exposes",
  "sends",
  "invokes",
  "handles",
  "calls",
  "persists_to",
  "observed_as",
  "changed_from",
] as const;

// :75-78 — producer properties are an open JSON record, not a workbench DTO.
const reaApplicationPropertiesSchema = z.record(z.string().min(1), z.json());

// :96-103
export const reaApplicationNodeObservationSchema = z.strictObject({
  observation_id: reaPrefixedDigest("jag_observation"),
  identifier_strategy: z.strictObject({
    strategy: z.literal("semantic-content-sha256"),
    stability: z.literal("observation-exact"),
  }),
  label: z.string().min(1).nullable(),
  source_map_reference: reaSourceMapReferenceSchema.nullable(),
  properties: reaApplicationPropertiesSchema,
  evidence: reaApplicationGraphEvidenceSchema,
});

// :113-118
export const reaApplicationNodeSchema = z.strictObject({
  node_id: reaPrefixedDigest("jag_node"),
  kind: z.enum(JAVASCRIPT_APPLICATION_NODE_KINDS),
  identity: reaApplicationNodeIdentitySchema,
  observations: z.array(reaApplicationNodeObservationSchema).min(1),
});

// :130-136
export const reaApplicationEdgeSchema = z.strictObject({
  edge_id: reaPrefixedDigest("jag_edge"),
  identifier_strategy: z.strictObject({
    strategy: z.literal("semantic-content-sha256"),
    stability: z.literal("relationship-exact"),
  }),
  source_node_id: reaPrefixedDigest("jag_node"),
  target_node_id: reaPrefixedDigest("jag_node"),
  relation: z.enum(JAVASCRIPT_APPLICATION_RELATIONS),
  properties: reaApplicationPropertiesSchema,
  evidence: reaApplicationGraphEvidenceSchema,
});

// :139-152 (the stored record adds `graph_id`)
export const reaApplicationGraphRecordSchema = z.strictObject({
  schema: z.literal("JavaScriptApplicationGraph"),
  graph_id: reaPrefixedDigest("jag"),
  root_node_ids: z.array(reaPrefixedDigest("jag_node")).min(1),
  nodes: z.array(reaApplicationNodeSchema).min(1),
  edges: z.array(reaApplicationEdgeSchema),
  coverage: reaApplicationCoverageSchema,
  limitations: z.array(boundedText),
});

// --- semantic relation graph (javascriptSemanticGraphSchemas.ts) -----------

// :13-21
const semanticNodeId = reaPrefixedDigest("jsrg_node");
const semanticRelationId = reaPrefixedDigest("jsrg_relation");
const semanticUnknownId = reaPrefixedDigest("jsrg_unknown");
const semanticEvidenceContextId = reaPrefixedDigest("jsrg_evidence");

// :23-31
export const reaSemanticEvidenceContextSchema = z.strictObject({
  context_id: semanticEvidenceContextId,
  authority: reaApplicationEvidenceAuthoritySchema,
  state: reaApplicationFactStateSchema,
  confidence: reaApplicationConfidenceSchema,
  artifact: reaApplicationArtifactReferenceSchema,
  extractor: reaApplicationExtractorSchema,
  coverage: reaApplicationCoverageSchema,
  limitations: z.array(boundedText),
  evidence_ids: z.array(reaPrefixedDigest("ev")),
});

export const reaSemanticEvidenceReferenceSchema = z.strictObject({
  context_id: semanticEvidenceContextId,
  location: reaApplicationLocationReferenceSchema,
});

// :36-60
export const JAVASCRIPT_SEMANTIC_NODE_KINDS = [
  "module",
  "function",
  "parameter",
  "binding",
  "expression",
  "literal",
  "property-slot",
  "call-site",
  "return-site",
  "closure-capture",
  "promise",
  "task",
  "event",
  "listener",
  "timer",
  "child-process",
  "stdio",
  "signal",
  "config-source",
  "request",
  "response",
  "boundary",
  "resource",
  "unknown-frontier",
] as const;

// :64-76
export const JAVASCRIPT_SEMANTIC_RELATION_FAMILIES = [
  "boundary",
  "call-flow",
  "child-process",
  "closure",
  "configuration",
  "data-flow",
  "event",
  "object-flow",
  "promise-ownership",
  "request",
  "resource-lifecycle",
  "timer",
] as const;

// :81-126
export const JAVASCRIPT_SEMANTIC_RELATIONS = [
  "acquires",
  "aggregates",
  "aliases",
  "argument-to-parameter",
  "awaits",
  "calls",
  "cancels-timer",
  "captures",
  "chains",
  "coerces",
  "connects-stdio",
  "consumed-by",
  "constructs-request",
  "creates-promise",
  "defaults",
  "defines",
  "destructures",
  "detaches-task",
  "dispatches-candidate",
  "forwards-signal",
  "listens-error",
  "listens-exit",
  "owns",
  "overrides",
  "parses",
  "reads",
  "reads-argv",
  "reads-config",
  "reads-environment",
  "reads-property",
  "registers-listener",
  "releases",
  "removes-listener",
  "returns-task",
  "returns-to-call",
  "schedules-timer",
  "spawns",
  "spreads",
  "supplies-argv",
  "supplies-env",
  "supplies-request-field",
  "validates",
  "writes",
  "writes-property",
] as const;

// :261-273
export const JAVASCRIPT_SEMANTIC_UNKNOWN_REASONS = [
  "ambiguous-target",
  "bound-reached",
  "dynamic-call",
  "dynamic-property",
  "dynamic-scope",
  "eval-or-generated-code",
  "incomplete-module",
  "missing-source",
  "resource-limit",
  "unknown-value",
  "unsupported-syntax",
] as const;

// :192-219
const reaSemanticSourceRangeSchema = z
  .strictObject({
    start: z.strictObject({ line: z.number().int().min(1), column: z.number().int().min(0) }),
    end: z.strictObject({ line: z.number().int().min(1), column: z.number().int().min(0) }),
  })
  .superRefine((range, context) => {
    if (
      range.end.line < range.start.line ||
      (range.end.line === range.start.line && range.end.column < range.start.column)
    ) {
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "Source range end must not precede its start",
      });
    }
  });

const reaSemanticNodeIdentitySchema = z.strictObject({
  artifact_sha256: reaDigestSchema,
  module_path: reaRelativePathSchema,
  source_range: reaSemanticSourceRangeSchema.nullable(),
  role_key: z.string().min(1),
});

// :233-239
export const reaSemanticNodeSchema = z.strictObject({
  node_id: semanticNodeId,
  kind: z.enum(JAVASCRIPT_SEMANTIC_NODE_KINDS),
  identity: reaSemanticNodeIdentitySchema,
  function_node_id: semanticNodeId.nullable(),
  application_node_ids: z.array(reaPrefixedDigest("jag_node")),
  label: z.string().min(1).nullable(),
  properties: z.record(z.string().min(1), z.json()),
  evidence: reaSemanticEvidenceReferenceSchema,
});

// :252-258
export const reaSemanticRelationSchema = z.strictObject({
  relation_id: semanticRelationId,
  source_node_id: semanticNodeId,
  target_node_id: semanticNodeId,
  relation: z.enum(JAVASCRIPT_SEMANTIC_RELATIONS),
  resolution: z.enum(["resolved", "candidate"]),
  properties: z.record(z.string().min(1), z.json()),
  evidence: reaSemanticEvidenceReferenceSchema,
});

// :293-328
export const reaSemanticFingerprintSchema = z.strictObject({
  function_node_id: semanticNodeId,
  algorithm: z.literal("rea.javascript-semantic-function"),
  status: z.enum(["complete", "partial", "unavailable"]),
  components: z.strictObject({
    parameter_arity: z.number().int().min(0),
    normalized_ast_sha256: reaDigestSchema,
    control_flow_sha256: reaDigestSchema,
    relation_shape_sha256: reaDigestSchema,
    literal_set_sha256: reaDigestSchema,
    effects: z.array(
      z.enum([
        "async",
        "child-process",
        "event",
        "network",
        "promise",
        "resource",
        "timer",
      ]),
    ),
  }),
  limitations: z.array(boundedText),
  evidence: reaSemanticEvidenceReferenceSchema,
  fingerprint_id: reaPrefixedDigest("jsrg_fingerprint"),
  fingerprint_sha256: reaDigestSchema,
});

// :276-291 — one named unresolved frontier.
export const reaSemanticUnknownSchema = z.strictObject({
  unknown_id: semanticUnknownId,
  node_id: semanticNodeId.nullable(),
  family: z.enum(JAVASCRIPT_SEMANTIC_RELATION_FAMILIES),
  relation_kinds: z.array(z.enum(JAVASCRIPT_SEMANTIC_RELATIONS)).min(1),
  reason: z.enum(JAVASCRIPT_SEMANTIC_UNKNOWN_REASONS),
  detail: boundedText,
  candidate_node_ids: z.array(semanticNodeId),
  evidence: reaSemanticEvidenceReferenceSchema,
});

// :330-351
export const reaSemanticFamilyCoverageSchema = z.strictObject({
  family: z.enum(JAVASCRIPT_SEMANTIC_RELATION_FAMILIES),
  status: z.enum(["complete", "partial", "unknown", "unsupported"]),
  retained_relations: z.number().int().min(0),
  omitted_relations: z.number().int().min(0).nullable(),
  unknown_ids: z.array(semanticUnknownId),
});

const reaSemanticGraphCoverageSchema = z.strictObject({
  status: z.enum(["complete", "partial", "unknown", "unavailable"]),
  truncated: z.boolean(),
  omitted_nodes: z.number().int().min(0).nullable(),
  omitted_relations: z.number().int().min(0).nullable(),
  limits: z.array(
    z.strictObject({
      name: z.string().min(1),
      value: z.number().int().min(0),
      unit: z.enum(["items", "bytes", "milliseconds", "depth", "other"]),
    }),
  ),
  families: z.array(reaSemanticFamilyCoverageSchema).length(12),
});

// :354-372
export const reaSemanticGraphRecordSchema = z.strictObject({
  schema: z.literal("JavaScriptSemanticRelationGraph"),
  graph_id: reaPrefixedDigest("jsrg"),
  root_artifact_sha256: reaDigestSchema,
  application_graph_id: reaPrefixedDigest("jag"),
  root_node_ids: z.array(semanticNodeId).min(1),
  evidence_contexts: z.array(reaSemanticEvidenceContextSchema),
  nodes: z.array(reaSemanticNodeSchema).min(1),
  relations: z.array(reaSemanticRelationSchema),
  fingerprints: z.array(reaSemanticFingerprintSchema),
  unknowns: z.array(reaSemanticUnknownSchema),
  coverage: reaSemanticGraphCoverageSchema,
  limitations: z.array(boundedText),
});

// --- result (javascriptApplicationAnalysis.ts) -----------------------------

// src/domain/artifactGraph.ts:4-21,144-156
export const reaIntegrityContradictionSchema = z.strictObject({
  contradiction_id: reaPrefixedDigest("ic"),
  occurrence_id: reaPrefixedDigest("occ"),
  parent_artifact_id: reaPrefixedDigest("art"),
  logical_path: reaRelativePathSchema,
  declared_sha256: reaDigestSchema,
  observed_sha256: reaDigestSchema,
  entry_kind: z.enum(["file", "slice"]),
  unpacked: z.boolean(),
  trust: z.literal("observed-untrusted"),
  provenance: z.literal("container-integrity-metadata-versus-observed-bytes"),
  limitations: z.array(z.string()).min(1),
});

// javascriptApplicationAnalysis.ts:36-58 — the high-level Electron boundary
// counts. They are counts of what the archive declares statically; no entry in
// this object can state that anything ran.
export const reaElectronBoundarySummarySchema = z.strictObject({
  browser_windows: countSchema,
  explicit_web_preferences: countSchema,
  preload_entrypoints: countSchema,
  context_bridge_apis: countSchema,
  exposed_api_members: countSchema,
  ipc: z.strictObject({
    operations: countSchema,
    literal_channels: countSchema,
    dynamic_channel_operations: countSchema,
    renderer_transmissions: countSchema,
    renderer_listeners: countSchema,
    main_handlers: countSchema,
    paired_renderer_transmissions: countSchema,
    ambiguous_renderer_transmissions: countSchema,
    unpaired_literal_renderer_transmissions: countSchema,
  }),
  sender_validation_observations: countSchema,
  utility_processes: countSchema,
  resolved_utility_entrypoints: countSchema,
  native_addon_bindings: countSchema,
  resolved_native_addon_bindings: countSchema,
});

// javascriptApplicationAnalysis.ts:60-70
export const reaReconstructionStatisticsSchema = z.strictObject({
  relevant_files: countSchema,
  nested_asar_containers: countSchema,
  text_bytes_read: countSchema,
  invalid_utf8_files: countSchema,
  parsed_javascript_files: countSchema,
  visited_ast_nodes: countSchema,
  findings: countSchema,
  modules: countSchema,
  parse_failures: countSchema,
});

// javascriptApplicationAnalysis.ts:72-85
const applicationAnalysisResultShape = z.strictObject({
  input_path: z.string().min(1),
  format: z.enum(["asar", "directory"]),
  root_artifact_sha256: reaDigestSchema,
  inventory_manifest_id: reaPrefixedDigest("agm"),
  inventory_graph_sha256: reaDigestSchema,
  integrity_contradictions: z.array(reaIntegrityContradictionSchema),
  // `.exactOptional()` is the upstream spelling (:79): the key is absent, not
  // undefined, when the caller did not select sources.
  source_selection: reaSourceSelectionSchema.exactOptional(),
  graph: reaApplicationGraphRecordSchema,
  summary: reaElectronBoundarySummarySchema,
  statistics: reaReconstructionStatisticsSchema,
  limitations: z.array(boundedText),
  semantic_graph: reaSemanticGraphRecordSchema,
});

// javascriptApplicationAnalysis.ts:93-160 — the producer's cross-graph bindings.
export const javascriptApplicationAnalysisResultSchema =
  applicationAnalysisResultShape.superRefine((result, context) => {
    if (result.semantic_graph.application_graph_id !== result.graph.graph_id) {
      context.addIssue({
        code: "custom",
        path: ["semantic_graph", "application_graph_id"],
        message: "Semantic graph must commit the containing application graph",
      });
    }
    if (result.semantic_graph.root_artifact_sha256 !== result.root_artifact_sha256) {
      context.addIssue({
        code: "custom",
        path: ["semantic_graph", "root_artifact_sha256"],
        message: "Semantic graph must commit the containing root artifact",
      });
    }
    const applicationNodeIds = new Set<string>(result.graph.nodes.map((node) => node.node_id));
    for (const [nodeIndex, node] of result.semantic_graph.nodes.entries()) {
      for (const [index, identifier] of node.application_node_ids.entries()) {
        if (!applicationNodeIds.has(identifier)) {
          context.addIssue({
            code: "custom",
            path: ["semantic_graph", "nodes", nodeIndex, "application_node_ids", index],
            message: "Semantic node references an absent application node",
          });
        }
      }
    }
  });

// --- advertised reply (electronToolContracts.ts:36-39) ---------------------

// src/domain/analysisView/analysisView.ts:35,146-159,184-219 — `detail: "summary"`
// returns this view of the retained Evidence instead of the analysis result.
const reaSummaryViewCoverageSchema = z.strictObject({
  status: z.enum(["complete-within-view", "page", "empty"]),
  examined: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
  exhausted: z.boolean(),
});

// src/domain/analysisView/analysisView.ts:184-193 `javascriptSummarySchema`, i.e.
// the summary payload itself. Extracted from the strictObject below so
// `contracts/rea-analysis-view.ts` — whose `summary` view admits
// `z.union([layout, javascript])` over the SAME payload — imports it instead of
// copying it. Upstream's owner is one file; this keeps it one owner here too.
export const reaJavaScriptApplicationSummarySchema = z.strictObject({
  input_path: z.string().min(1),
  format: z.enum(["asar", "directory"]),
  root_artifact_sha256: reaDigestSchema,
  source_selection: reaSourceSelectionSchema.exactOptional(),
  statistics: z.record(z.string(), z.json()),
  electron: z.record(z.string(), z.json()),
  coverage: z.record(z.string(), z.json()),
  limitation_count: z.number().int().nonnegative(),
});

export const reaJavaScriptApplicationSummaryViewResultSchema = z.strictObject({
  kind: z.literal("summary"),
  view: z.strictObject({ kind: z.literal("summary") }),
  parent_evidence_id: reaPrefixedDigest("ev"),
  parent_digest: reaDigestSchema,
  view_digest: reaDigestSchema,
  artifact: z.strictObject({ path: z.string(), sha256: reaDigestSchema }),
  coverage: reaSummaryViewCoverageSchema,
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
  parent_operation: z.literal("analyze_javascript_application"),
  summary: reaJavaScriptApplicationSummarySchema,
});

// src/contracts/toolOutputSchemaPrimitives.ts:29-32 `evidenceResultOf` re-declares
// the envelope with the operation's normalized result specialised, and
// electronToolContracts.ts:36-39 makes it a union of the complete analysis or
// that summary view. The workbench envelope mirror (`rea-evidence.ts`) already
// carries the common fields, so this extends it rather than copying it.
export const reaJavaScriptApplicationEvidenceSchema = reaEvidenceSchema.extend({
  operation: z.literal("analyze_javascript_application"),
  normalized_result: z.union([
    javascriptApplicationAnalysisResultSchema,
    reaJavaScriptApplicationSummaryViewResultSchema,
  ]),
});

export type AnalyzeJavaScriptApplicationInput = z.infer<typeof analyzeJavaScriptApplicationInputSchema>;
export type AnalyzeJavaScriptApplicationRequest = z.infer<typeof analyzeJavaScriptApplicationRequestSchema>;
export type JavaScriptApplicationAnalysisResult = z.infer<typeof javascriptApplicationAnalysisResultSchema>;
export type ReaApplicationNode = z.infer<typeof reaApplicationNodeSchema>;
export type ReaApplicationEdge = z.infer<typeof reaApplicationEdgeSchema>;
export type ReaApplicationNodeObservation = z.infer<typeof reaApplicationNodeObservationSchema>;
export type ReaApplicationGraphRecord = z.infer<typeof reaApplicationGraphRecordSchema>;
export type ReaApplicationGraphEvidence = z.infer<typeof reaApplicationGraphEvidenceSchema>;
export type ReaApplicationCoverage = z.infer<typeof reaApplicationCoverageSchema>;
export type ReaApplicationFactState = z.infer<typeof reaApplicationFactStateSchema>;
export type ReaSemanticUnknown = z.infer<typeof reaSemanticUnknownSchema>;
export type ReaSemanticGraphRecord = z.infer<typeof reaSemanticGraphRecordSchema>;
export type ReaElectronBoundarySummary = z.infer<typeof reaElectronBoundarySummarySchema>;
export type ReaReconstructionStatistics = z.infer<typeof reaReconstructionStatisticsSchema>;
export type ReaIntegrityContradiction = z.infer<typeof reaIntegrityContradictionSchema>;
export type ReaJavaScriptApplicationEvidence = z.infer<typeof reaJavaScriptApplicationEvidenceSchema>;

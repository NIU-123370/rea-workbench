import { z } from "zod";

// Field-for-field mirror of the REA 6.4.0 evidence envelope at commit
// 98d8470d (src/domain/evidence.ts:110-129 and its sub-schemas). Upstream names
// stay snake_case; conversion to workbench camelCase happens exactly once, in
// the projection layer, never here. Nothing in this file may add, rename or
// reinterpret a field (DESIGN §1, §4).

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const evidenceId = z.string().regex(/^ev_[0-9a-f]{64}$/);
const nonEmpty = z.string().min(1);
const jsonValue = z.json();
const jsonObject = z.record(z.string(), z.json());

export const reaSubjectFormat = [
  "hopper",
  "analysis-database",
  "mach-o",
  "elf",
  "pe",
  "dos-mz",
  "dos-com",
  "raw-binary",
  "zip",
  "ipa",
  "apk",
  "msix",
  "appx",
  "hap",
  "hsp",
  "app-pack",
  "asar",
  "dmg",
  "pkg",
  "plist",
  "javascript",
  "source-map",
  "directory",
  "file",
  "unknown",
  "mach-o-universal",
  "javascript-bundle",
  "entitlements",
] as const;

export const reaBinaryArchitectures = ["x86", "x86_64", "arm", "arm64", "mips"] as const;

export const reaProviderSchema = z.strictObject({
  id: nonEmpty,
  name: nonEmpty,
  version: z.string().nullable(),
});

export const reaSubjectSchema = z.strictObject({
  name: nonEmpty,
  digest: z.strictObject({ sha256: digest }),
  format: z.enum(reaSubjectFormat),
  architecture: z.enum(reaBinaryArchitectures).nullable(),
  // NUL-free local path text as reported upstream; not a workbench Id.
  local_path: z.string().regex(/^[^\0]*$/u),
});

export const reaEvidenceLocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("address"), address: nonEmpty }),
  z.strictObject({ kind: z.literal("address-range"), start: nonEmpty, end: nonEmpty }),
  z.strictObject({ kind: z.literal("artifact-path"), path: nonEmpty }),
  z.strictObject({ kind: z.literal("file-offset"), offset: z.int().nonnegative() }),
  z.strictObject({
    kind: z.literal("file-offset-range"),
    start: z.int().nonnegative(),
    end: z.int().nonnegative(),
  }),
]);

export const reaAuthorityValues = [
  "shipped-artifact",
  "controlled-replay",
  "historical-reference",
  "external-service",
  "analyst-inference",
] as const;

export const reaConfidenceValues = ["observed", "derived", "inferred"] as const;

export const reaEnvironmentSchema = z.strictObject({
  id: nonEmpty,
  platform: nonEmpty,
  architecture: nonEmpty,
  isolation: z.enum(["none", "process", "container", "virtual-machine"]),
});

export const reaAnalysisProfileSchema = z.strictObject({
  provider: z.strictObject({ id: nonEmpty, name: nonEmpty, version: nonEmpty }),
  parameters: jsonObject,
  digest,
});

export const reaRelationshipCoverageSchema = z.union([
  z.strictObject({ status: z.literal("complete") }),
  z.strictObject({ status: z.literal("complete"), diagnostics: z.array(nonEmpty) }),
  z.strictObject({ status: z.literal("partial"), limitations: z.array(nonEmpty) }),
  z.strictObject({
    status: z.literal("partial"),
    limitations: z.array(nonEmpty),
    diagnostics: z.array(nonEmpty),
  }),
  z.strictObject({ status: z.literal("unknown"), reason: nonEmpty }),
  z.strictObject({ status: z.literal("unknown"), reason: nonEmpty, diagnostics: z.array(nonEmpty) }),
]);

export const reaEvidenceSchema = z.strictObject({
  evidence_id: evidenceId,
  subject: reaSubjectSchema.nullable(),
  provider: reaProviderSchema,
  analysis_profile: reaAnalysisProfileSchema.nullable(),
  predicate_type: nonEmpty,
  operation: nonEmpty,
  parameters: jsonObject,
  raw_result: jsonValue.nullable(),
  normalized_result: jsonValue,
  confidence: z.enum(reaConfidenceValues),
  authority: z.enum(reaAuthorityValues),
  environment: reaEnvironmentSchema.nullable(),
  limitations: z.array(z.string()),
  relationship_coverage: reaRelationshipCoverageSchema.nullable(),
  locations: z.array(reaEvidenceLocationSchema),
  evidence_links: z.array(evidenceId),
});

export type ReaEvidence = z.infer<typeof reaEvidenceSchema>;

// MCP failure projection (src/domain/analysisErrorProjection.ts:77-86,
// src/contracts/errorSchemas.ts:22-69). REA deletes `structuredContent` on the
// wire for errors, so this is parsed out of the text block, not the object.
export const reaErrorCodes = [
  "invalid_request",
  "access_denied",
  "artifact_changed",
  "unreadable_output",
  "capability_unavailable",
  "unsupported_target",
  "provider_unavailable",
  "provider_timeout",
  "resource_constraint",
  "cancelled",
  "artifact_integrity_mismatch",
  "artifact_operation_failed",
  "evidence_integrity_mismatch",
  "truncated",
  "process_capture_failed",
  "cleanup_incomplete",
  "revision_conflict",
  "configuration_invalid",
  "target_unavailable",
  "execution_failure",
] as const;

export const reaErrorCategories = [
  "invalid_input",
  "unsupported_provider",
  "unsupported_target",
  "integrity_mismatch",
  "truncated",
  "cancelled",
  "timeout",
  "resource_constraint",
  "unavailable",
  "execution_failure",
] as const;

export const reaToolErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(reaErrorCodes),
    category: z.enum(reaErrorCategories),
    message: z.string(),
    retryable: z.boolean(),
    remediation: z.strictObject({ action: z.string() }),
    details: z.record(z.string(), jsonValue).optional(),
  }),
});

export type ReaToolError = z.infer<typeof reaToolErrorSchema>["error"];

export const reaEvidenceBundleResultSchema = z.strictObject({
  result: z.strictObject({
    artifacts: z.array(z.unknown()),
    providers: z.array(z.unknown()),
    environments: z.array(z.unknown()),
    scenarios: z.array(z.unknown()),
    captures: z.array(z.unknown()),
    unknown: z.array(z.unknown()),
    records: z.array(reaEvidenceSchema),
  }),
});

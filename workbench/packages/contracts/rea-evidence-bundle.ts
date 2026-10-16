import { z } from "zod";

import { digestSchema, nonEmptyString } from "./primitives.ts";
import { reaLocalPathSchema } from "./rea-static-analysis.ts";

// Field-for-field mirror of the REA 6.4.0 session/ledger tool family at commit
// 98d8470d — the operations DESIGN §9 item 6 makes responsible for keeping
// retained Evidence alive across a connection. Upstream owners read directly:
//   src/contracts/sessionToolContracts.ts:56-66        exportEvidenceBundleInputSchema
//   src/contracts/sessionToolSchemas.ts:29-38          importEvidenceBundleInputSchema
//   src/contracts/sessionToolSchemas.ts:12-15          getEvidenceBundleInputSchema
//   src/contracts/sessionLifecycleInputs.ts:66-70      closeBinaryInputSchema
//   src/contracts/sessionStatusContract.ts:7-21        binarySessionInputSchema
//   src/contracts/toolOutputSchemaGroups.ts:490-497    export_evidence_bundle result
//   src/contracts/toolOutputSchemaGroups.ts:519-525    import_evidence_bundle result
//   src/domain/evidenceRecordSummary.ts:8-14           evidenceRecordFiltersSchema
//   src/domain/localPath.ts:15-20                      localPathStringSchema
//   src/domain/digests.ts:16,26-33                     digest / prefixed digest
//   src/contracts/toolOutputSchemaPrimitives.ts:35-36  lifecycleResultOf
//
// Reconciled against `tools/list` of the built provider at 98d8470d on
// 2026-10-16 (recorded in `tests/fixtures/rea-live-tools-shapes.json`; comparing
// owner is `adapters/rea/schema-reconciliation.ts`):
//   export_evidence_bundle  in  props ["overwrite","path"] req ["path"] ap false
//                           out {result:{path,bytes,records,unknowns}} all 4 req ap false
//   import_evidence_bundle  in  props ["path"] req ["path"] ap false
//                           out {result:{imported,unknowns_added,total}} all 3 req ap false
//   get_evidence_bundle     in  props ["detail","filters"] req [] ap false
//   close_binary            in  props ["overwrite","snapshot_path"] req [] ap false
//   binary_session          in  props ["expected_catalog_digest",
//                                       "expected_package_version","expected_server_path"]
//                           req [] ap false
// and read live on the same baseline: `export_evidence_bundle` answered
// `{path,bytes:169778,records:3,unknowns:0}`, a fresh connection answered
// `import_evidence_bundle` `{imported:3,unknowns_added:0,total:3}`, and
// `close_binary` answered `{result:null}`.
//
// One non-negotiable from §9 item 6 stays a *behavioural* rule, not a schema
// fact, and lives in `adapters/rea/retention.ts`: a bare exported path is not an
// imported retained reference. Nothing in this file can express that.

// src/domain/localPath.ts:15-20 plus the `isAbsolute` refinement the session
// tools add. The refinement is RUNTIME-ONLY and is deliberately NOT restated
// here for two reasons: a `.refine()` does not survive JSON Schema conversion,
// so the advertised pattern is exactly `^[^\0]*$` and pretending otherwise would
// make the expected side of issue #14's gate disagree with what the provider
// actually publishes; and DESIGN §3 forbids `packages/contracts` from importing
// `node:path` at all. Absoluteness is therefore enforced one layer up, in
// `adapters/rea/retention.ts`, which refuses a relative path by naming the field
// before anything is sent — the same refusal upstream would make, made earlier
// and with a reason this client owns.
//
// Consequence worth stating: the advertised schema looks legal for a relative
// path, and the live provider proved it still refuses one — but through the MCP
// SDK layer, whose `isError` text is not a `{error:...}` envelope, so the reply
// arrives unparsable rather than named (live probe, 2026-10-16).
const sessionPathSchema = reaLocalPathSchema;
const optionalSessionPathSchema = reaLocalPathSchema.optional();

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);

// --- export_evidence_bundle ------------------------------------------------

export const exportEvidenceBundleInputSchema = z.strictObject({
  path: sessionPathSchema,
  overwrite: z.boolean().default(false),
});

// Upstream wraps these results with `lifecycleResultOf`, which builds a
// non-strict object; the advertised outputSchema, however, says
// `additionalProperties:false` at both levels, so the mirror follows the
// advertisement — the same choice `reaToolErrorSchema` already makes
// (DESIGN §4: refuse an unmodelled field, never drop it silently).
// `result.path` is `z.string()` upstream with no minLength and no absolute
// refinement on the OUTPUT side; mirrored as it is advertised, not as one would
// prefer.
//
// The payload is named separately because that node, not the `{result}` wrapper,
// is what `schema-reconciliation.ts` can compare: it walks the advertised
// document down to `result` and checks the field set there. Naming it adds no
// constraint upstream does not have.
export const exportEvidenceBundleResultSchema = z.strictObject({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
  unknowns: z.number().int().nonnegative(),
});

export const exportEvidenceBundleOutputSchema = z.strictObject({
  result: exportEvidenceBundleResultSchema,
});

export type ExportEvidenceBundleInput = z.infer<typeof exportEvidenceBundleInputSchema>;
export type ExportEvidenceBundleOutput = z.infer<typeof exportEvidenceBundleOutputSchema>;

// --- import_evidence_bundle ------------------------------------------------

export const importEvidenceBundleInputSchema = z.strictObject({
  path: sessionPathSchema,
});

export const importEvidenceBundleResultSchema = z.strictObject({
  imported: z.number().int().nonnegative(),
  unknowns_added: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const importEvidenceBundleOutputSchema = z.strictObject({
  result: importEvidenceBundleResultSchema,
});

export type ImportEvidenceBundleInput = z.infer<typeof importEvidenceBundleInputSchema>;
export type ImportEvidenceBundleOutput = z.infer<typeof importEvidenceBundleOutputSchema>;

// --- get_evidence_bundle (input only) --------------------------------------

// src/domain/evidenceRecordSummary.ts:8-14. Every filter is optional, so an empty
// object is a legal filter set and is not the same thing as "no filters key".
export const reaEvidenceRecordFiltersSchema = z.strictObject({
  evidence_id: evidenceIdSchema.optional(),
  operation: nonEmptyString.optional(),
  target_sha256: digestSchema.optional(),
  analysis_profile_digest: digestSchema.optional(),
  procedure_address: nonEmptyString.optional(),
});

export const getEvidenceBundleInputSchema = z.strictObject({
  detail: z.enum(["complete", "summary"]).default("complete"),
  filters: reaEvidenceRecordFiltersSchema.optional(),
});

// NOT mirrored: `get_evidence_bundle`'s two output members. The complete member
// ({artifacts,providers,environments,scenarios,captures,unknowns,records}) is
// already carried by `reaEvidenceBundleResultSchema` in `rea-evidence.ts` —
// which issue #14 corrected from `unknown` to `unknowns` after reading the
// advertised shape — and the summary member
// ({kind,filters,total_retained_records,matching_records,unknown_revisions,
// records}) has no workbench reader, so nothing here claims to prove it.
export type GetEvidenceBundleInput = z.infer<typeof getEvidenceBundleInputSchema>;
export type ReaEvidenceRecordFilters = z.infer<typeof reaEvidenceRecordFiltersSchema>;

// --- close_binary / binary_session ----------------------------------------

export const closeBinaryInputSchema = z.strictObject({
  snapshot_path: optionalSessionPathSchema,
  overwrite: z.boolean().default(false),
});

export const binarySessionInputSchema = z.strictObject({
  expected_package_version: nonEmptyString.optional(),
  expected_catalog_digest: digestSchema.optional(),
  expected_server_path: optionalSessionPathSchema,
});

export type CloseBinaryInput = z.infer<typeof closeBinaryInputSchema>;
export type BinarySessionInput = z.infer<typeof binarySessionInputSchema>;

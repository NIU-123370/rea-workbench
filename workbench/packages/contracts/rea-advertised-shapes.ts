import { z } from "zod";

import { nonEmptyString } from "./primitives.ts";
import { reaEvidenceSchema } from "./rea-evidence.ts";
import { webNetworkCaptureInputSchema } from "./rea-web-capture.ts";
import { analyzeJavaScriptApplicationInputSchema } from "./rea-static-analysis.ts";
import { inspectAnalysisViewInputSchema, inspectAnalysisViewOutputSchema } from "./rea-analysis-view.ts";
import {
  binarySessionInputSchema,
  closeBinaryInputSchema,
  exportEvidenceBundleInputSchema,
  exportEvidenceBundleOutputSchema,
  exportEvidenceBundleResultSchema,
  getEvidenceBundleInputSchema,
  importEvidenceBundleInputSchema,
  importEvidenceBundleOutputSchema,
  importEvidenceBundleResultSchema,
} from "./rea-evidence-bundle.ts";

// The EXPECTED side of DESIGN §9 item 2, published as data.
//
// `adapters/rea/schema-reconciliation.ts` is the owner of the comparison, but
// DESIGN §3 forbids `packages/adapters/*` from importing zod, and the expected
// side has to come out of the zod mirrors or it would be a second transcription
// of them. So the projection lives here, in the same layer as the mirrors: this
// file reads each mirror's own JSON Schema and hands the adapter the field sets,
// without restating a single field name.
//
// That is the whole reason this file exists. A hand-written list of expected
// fields would drift from the mirrors exactly the way `REQUIRED_TOOLS` drifted
// from `analyzeJavaScriptApplicationInputSchema` — it recorded no required fields
// for a tool whose provider requires `input_path`, and it never mentioned
// `detail` at all. Derived from the mirror, it cannot drift, because there is
// one list to change.
//
// `io: "input"` vs `io: "output"` is not decoration: defaulted fields are
// optional in the request dialect and always present in the reply dialect, and
// the provider publishes each node in exactly one of them. `overwrite`, `detail`
// and the native view's `offset`/`limit` are the proof — they appear in
// `properties` but never in the advertised `required`.

// The shape of one comparison target. Published as a schema so the table below
// is checked against it at module load rather than trusted: an entry that lost
// its path, or claimed a required field no mirror declares, would otherwise
// silently shrink the gate.
export const advertisedShapeNodeSchema = z.strictObject({
  tool: nonEmptyString,
  // `["input"]` is the `inputSchema` root, `["output"]` the `outputSchema` root,
  // `["output","result"]` the `result` member inside it.
  path: z.array(nonEmptyString).min(1),
  dialect: z.enum(["input", "output"]),
  properties: z.array(nonEmptyString),
  required: z.array(nonEmptyString),
});

export type AdvertisedShapeNode = z.infer<typeof advertisedShapeNodeSchema>;

function project(
  tool: string,
  path: readonly string[],
  dialect: AdvertisedShapeNode["dialect"],
  mirror: z.ZodType,
): AdvertisedShapeNode {
  const document = z.toJSONSchema(mirror, { io: dialect });
  const properties = document.properties;
  if (typeof properties !== "object" || properties === null) {
    // Loud, not skipped: a mirror that no longer projects to an object would
    // otherwise drop its tool out of the gate without a word.
    throw new Error(`named mirror does not project to an object: ${tool}/${dialect}`);
  }
  if (document.additionalProperties !== false) {
    // Every node here comes from a `z.strictObject` mirror. A mirror that stopped
    // refusing unmodelled keys is a DESIGN §4 violation, and it must not be able
    // to hide inside a comparison table that only checks key sets.
    throw new Error(`named mirror is not a strict object: ${tool}/${dialect}`);
  }
  const sortedProperties = Object.keys(properties).sort();
  const sortedRequired = [...(Array.isArray(document.required) ? document.required : [])]
    .filter((field): field is string => typeof field === "string")
    .sort();
  return {
    tool,
    path: [...path],
    dialect,
    properties: sortedProperties,
    required: sortedRequired,
  };
}

const inputRoot = (tool: string, mirror: z.ZodType): AdvertisedShapeNode =>
  project(tool, ["input"], "input", mirror);

// Every named operation this workbench calls, and the nodes the gate compares.
// A tool with no entry here cannot be reached by a checked path: adding a
// producer call means adding its mirror first.
const projectedShapes: readonly AdvertisedShapeNode[] = [
  inputRoot("binary_session", binarySessionInputSchema),
  inputRoot("inspect_web_network_capture", webNetworkCaptureInputSchema),
  project("inspect_web_network_capture", ["output"], "output", reaEvidenceSchema),
  inputRoot("analyze_javascript_application", analyzeJavaScriptApplicationInputSchema),
  project("analyze_javascript_application", ["output"], "output", reaEvidenceSchema),
  inputRoot("inspect_analysis_view", inspectAnalysisViewInputSchema),
  project("inspect_analysis_view", ["output"], "output", inspectAnalysisViewOutputSchema),
  inputRoot("get_evidence_bundle", getEvidenceBundleInputSchema),
  inputRoot("export_evidence_bundle", exportEvidenceBundleInputSchema),
  project("export_evidence_bundle", ["output"], "output", exportEvidenceBundleOutputSchema),
  project("export_evidence_bundle", ["output", "result"], "output", exportEvidenceBundleResultSchema),
  inputRoot("import_evidence_bundle", importEvidenceBundleInputSchema),
  project("import_evidence_bundle", ["output"], "output", importEvidenceBundleOutputSchema),
  project("import_evidence_bundle", ["output", "result"], "output", importEvidenceBundleResultSchema),
  inputRoot("close_binary", closeBinaryInputSchema),
];

export const NAMED_TOOL_SHAPES: readonly AdvertisedShapeNode[] = projectedShapes.map((node) =>
  advertisedShapeNodeSchema.parse(node),
);

// Two invariants the adapter depends on and cannot itself check, because it only
// ever sees one side at a time.
for (const node of NAMED_TOOL_SHAPES) {
  const declared = new Set(node.properties);
  for (const field of node.required) {
    if (!declared.has(field)) {
      throw new Error(`named mirror requires a field it does not declare: ${node.tool}/${field}`);
    }
  }
}

// The names, so the adapter can report an operation that is gone rather than
// silently checking nothing. Order is irrelevant: the catalog is looked up by
// name (DESIGN §9 item 2).
export const NAMED_TOOL_NAMES: readonly string[] = [...new Set(NAMED_TOOL_SHAPES.map((node) => node.tool))].sort();

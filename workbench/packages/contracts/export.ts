import { z } from "zod";

import { digestSchema, idSchema, nonEmptyString } from "./primitives.ts";

// Export package wire shapes (DESIGN §8 line 299-300, §10 / PRD F11, issue #22).
//
// The 201 reply is the whole promise: an id, a label, a *relative* download route, the
// digest of the bytes that route will serve, and the manifest that says what the package
// is bound to. A caller that wanted an absolute URL or an output path would be asking for
// a way to make the workbench write somewhere else, so neither exists in these shapes.

export const EXPORT_LABEL_VALUES = ["draft", "verified-samples"] as const;

export const exportBoundIdentitiesSchema = z.strictObject({
  snapshotDigest: digestSchema,
  blueprintDigest: digestSchema,
  candidateDigest: digestSchema,
  vectorSetDigest: digestSchema,
  planDigest: digestSchema,
  inventoryDigest: digestSchema,
  comparatorDigest: digestSchema,
  runnerImageDigest: digestSchema,
});

export const exportPartSchema = z.strictObject({
  name: nonEmptyString,
  sha256: digestSchema,
  byteLength: z.int().min(0),
});

export const exportDeliverabilitySchema = z.strictObject({
  canExportVerifiedSamples: z.boolean(),
  reasons: z.array(nonEmptyString),
});

export const exportManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  label: z.enum(EXPORT_LABEL_VALUES),
  packageKind: z.literal("zip-stored"),
  projectId: idSchema,
  candidateId: idSchema,
  verificationId: idSchema.nullable(),
  blueprintId: idSchema,
  planId: idSchema.nullable(),
  bound: exportBoundIdentitiesSchema.nullable(),
  statusNote: z.array(nonEmptyString),
  deliverability: exportDeliverabilitySchema,
  openApiVersion: nonEmptyString,
  parts: z.array(exportPartSchema),
});

export const exportCreateRequestSchema = z.strictObject({
  candidateId: idSchema,
  // The spec spells this `verificationId?:Id`; an omitted field and an explicit null are
  // the same thing in JSON, so the wire accepts both and the record stores null.
  verificationId: idSchema.nullable().optional(),
  label: z.enum(EXPORT_LABEL_VALUES),
});

export const exportRecordSchema = z.strictObject({
  id: idSchema,
  label: z.enum(EXPORT_LABEL_VALUES),
  downloadUrl: nonEmptyString,
  sha256: digestSchema,
  manifest: exportManifestSchema,
});

export const exportReadRequestSchema = z.strictObject({ exportId: idSchema });

// The archive crosses the private local RPC as base64 in one frame: the web process may
// not open the artifact store, so the worker reads the bytes and hands them over (§8).
export const exportArchiveSchema = z.strictObject({
  exportId: idSchema,
  sha256: digestSchema,
  byteLength: z.int().min(0),
  mediaType: nonEmptyString,
  bytesBase64: nonEmptyString,
});

export const exportListSchema = z.array(exportRecordSchema);

export type ExportBoundIdentitiesWire = z.infer<typeof exportBoundIdentitiesSchema>;
export type ExportPartWire = z.infer<typeof exportPartSchema>;
export type ExportManifestWire = z.infer<typeof exportManifestSchema>;
export type ExportCreateRequestWire = z.infer<typeof exportCreateRequestSchema>;
export type ExportRecordWire = z.infer<typeof exportRecordSchema>;
export type ExportArchiveWire = z.infer<typeof exportArchiveSchema>;

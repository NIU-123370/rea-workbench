import { z } from "zod";

import { digestSchema, jsonValueSchema, nonEmptyString } from "./primitives.ts";

// Field-for-field mirror of the REA 6.4.0 `inspect_web_network_capture`
// normalized result at commit 98d8470d (src/domain/webNetworkCapture.ts:14-162,
// src/contracts/webNetworkCaptureToolContracts.ts:18). Upstream names stay
// snake_case and nothing here re-models a HAR entry: REA keeps the producer
// object verbatim in `record.reported`, so the workbench reads HTTP facts out of
// that object instead of inventing fields REA never advertises (DESIGN §1, §4).

const pointerString = z.string().min(1);

export const webNetworkCaptureInputSchema = z.strictObject({
  // `format` has no producer default, so a caller omission is a refusal here.
  capture_path: nonEmptyString,
  format: z.enum(["har", "mitmproxy"]),
  record_ordinals: z.array(z.int().nonnegative()).min(1).optional(),
  sensitive_values: z.array(nonEmptyString).default([]),
});

export const webCaptureRedactionSchema = z.union([
  z.strictObject({
    pointer: pointerString,
    reason: z.enum(["transport-credential", "explicit-sensitive-value"]),
  }),
  z.strictObject({
    pointer: pointerString,
    reason: z.literal("explicit-sensitive-value"),
    scope: z.literal("property-name"),
  }),
]);

export const webCaptureLocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unknown"), reason: z.literal("explicit-sensitive-value") }),
  z.strictObject({ kind: z.literal("json-pointer"), pointer: pointerString }),
  z.strictObject({ kind: z.literal("byte-range"), offset: z.int().nonnegative(), bytes: z.int().nonnegative() }),
]);

export const webCaptureBinaryFieldSchema = z.discriminatedUnion("state", [
  z.strictObject({
    pointer: pointerString,
    state: z.literal("retained"),
    representation: z.enum(["producer-bytes", "har-base64-content"]),
    content_base64: z.string(),
    bytes: z.int().nonnegative(),
    sha256: digestSchema,
  }),
  z.strictObject({
    pointer: pointerString,
    state: z.literal("redacted"),
    representation: z.enum(["producer-bytes", "har-base64-content"]),
    content_base64: z.null(),
    bytes: z.null(),
    sha256: z.null(),
  }),
]);

export const webCaptureNumericLiteralSchema = z.strictObject({
  pointer: pointerString,
  producer_type: z.enum(["json-number", "integer", "float"]),
  literal: nonEmptyString,
});

export const webCaptureRecordSchema = z.strictObject({
  ordinal: z.int().nonnegative(),
  location: webCaptureLocationSchema,
  reported: jsonValueSchema,
  binary_fields: z.array(webCaptureBinaryFieldSchema),
  numeric_literals: z.array(webCaptureNumericLiteralSchema),
  redactions: z.array(webCaptureRedactionSchema),
  limitations: z.array(z.string()),
});

export const webNetworkCaptureResultSchema = z.strictObject({
  decoder: z.strictObject({ id: nonEmptyString, name: nonEmptyString, version: z.string().nullable() }),
  container: z.strictObject({
    reported: jsonValueSchema,
    numeric_literals: z.array(webCaptureNumericLiteralSchema),
    redactions: z.array(webCaptureRedactionSchema),
    records_pointer: pointerString.nullable(),
  }),
  total_records: z.int().nonnegative(),
  records: z.array(webCaptureRecordSchema),
  artifact: z.strictObject({
    path: nonEmptyString,
    sha256: digestSchema.nullable(),
    bytes: z.int().nonnegative(),
  }),
  format: z.enum(["har", "mitmproxy"]),
  // REA states browser transaction attribution is unknown for file captures;
  // the literal is the producer's own answer, not a workbench placeholder.
  runtime_attribution: z.literal("unknown"),
  limitations: z.array(z.string()),
});

export type WebCaptureRecord = z.infer<typeof webCaptureRecordSchema>;
export type WebCaptureBinaryField = z.infer<typeof webCaptureBinaryFieldSchema>;
export type WebNetworkCaptureResult = z.infer<typeof webNetworkCaptureResultSchema>;

// HAR 1.2 entry subset REA passes through unmodified in `record.reported`.
//
// This is the one place in the workbench that reads an *unmodelled* producer
// object, and it is a deliberate exception to the "reject extra fields" rule:
// a HAR entry carries cookies, timings, cache, bodySize and server fields that
// REA never re-models, so a strict object here would refuse real captures. The
// looseness is confined to reading, and every field this projection consumes is
// still optional-checked below — an absent field stays absent, it is never
// defaulted (§7.1 "不补假 method/URL").
const readLoose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape); // review-bot-ignore R1 (verbatim producer object, see note above)

export const harNameValuePairSchema = readLoose({
  name: z.string(),
  value: z.string(),
});

export const harEntryReportedSchema = readLoose({
  request: readLoose({
    method: z.string().optional(),
    url: z.string().optional(),
    queryString: z.array(harNameValuePairSchema).optional(),
    headers: z.array(harNameValuePairSchema).optional(),
    postData: readLoose({
      mimeType: z.string().optional(),
      text: z.string().nullable().optional(),
      params: z.array(readLoose({ name: z.string(), value: z.string() })).optional(),
    }).optional(),
  }),
  response: readLoose({
    status: z.number().optional(),
    headers: z.array(harNameValuePairSchema).optional(),
    content: readLoose({
      size: z.number().optional(),
      mimeType: z.string().optional(),
      text: z.string().optional(),
      encoding: z.string().optional(),
    }).optional(),
  }),
});

export type HarEntryReported = z.infer<typeof harEntryReportedSchema>;

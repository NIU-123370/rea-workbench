import { z } from "zod";

import { idSchema, nonEmptyString } from "./primitives.ts";
import { INSPECT_SCOPES } from "../domain/inspect.ts";

// Job inputs (DESIGN §8). These unions are the whole instruction surface a
// target may receive: no JavaScript, no shell, no arbitrary Playwright
// expression, no arbitrary file access.

export const locatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("role"), role: nonEmptyString, name: nonEmptyString }),
  z.strictObject({ kind: z.literal("testId"), value: nonEmptyString }),
]);

export const browserActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), locator: locatorSchema }),
  z.strictObject({ kind: z.literal("fill"), locator: locatorSchema, value: z.string() }),
  z.strictObject({
    kind: z.literal("waitFor"),
    locator: locatorSchema,
    state: z.enum(["visible", "hidden"]),
  }),
]);

// `sensitiveValues` is short-lived operation context: it is never persisted,
// never part of the request digest, and destroyed once the operation's checks
// are complete (DESIGN §12.1).
const sensitiveValuesSchema = z.array(nonEmptyString);

export const captureTaskSchema = z.strictObject({
  kind: z.literal("capture"),
  profileId: nonEmptyString,
  scenario: z.strictObject({
    startUrl: z.string().url(),
    actions: z.array(browserActionSchema),
  }),
  network: z.strictObject({
    requestBody: z.boolean(),
    responseBody: z.boolean(),
    headerValues: z.boolean(),
  }),
  timeoutMs: z.int().positive().optional(),
  sensitiveValues: sensitiveValuesSchema.optional(),
});

export const inspectTaskSchema = z.strictObject({
  kind: z.literal("inspect"),
  // Empty is legal only for the first HAR/ASAR analysis; a directed
  // investigation must name existing claims (DESIGN §8).
  claimIds: z.array(idSchema),
  question: nonEmptyString,
  scope: z.enum(INSPECT_SCOPES),
});

export { INSPECT_SCOPES as inspectScopes, isInspectScope } from "../domain/inspect.ts";
export type { InspectScope } from "../domain/inspect.ts";

export const jobTaskSchema = z.discriminatedUnion("kind", [captureTaskSchema, inspectTaskSchema]);

export type Locator = z.infer<typeof locatorSchema>;
export type BrowserAction = z.infer<typeof browserActionSchema>;
export type CaptureTask = z.infer<typeof captureTaskSchema>;
export type InspectTask = z.infer<typeof inspectTaskSchema>;
export type JobTask = z.infer<typeof jobTaskSchema>;

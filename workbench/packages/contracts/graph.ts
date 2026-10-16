import { z } from "zod";

import { idSchema, nonEmptyString } from "./primitives.ts";

// The graph view wire shape (DESIGN §6, §8 / PRD F04, issue #18).
//
// A claim reaches the screen as the state the rows hold, and the tri-colour judgement is
// made by `projectClaim` in the domain - so this schema carries `basis`, `validity`,
// `coverage` and `authorityApplies` and nothing that looks like a colour or a status
// string. A client that could receive "SEEN" would be a second place where a claim's
// status gets decided.

export const graphCoverageSchema = z.strictObject({
  state: z.enum(["complete", "partial", "unknown", "unavailable"]),
  examined: z.int().nullable(),
  total: z.int().nullable(),
  reasons: z.array(nonEmptyString),
});

// The claim's stored state, nested under `state` exactly as the read returns it: the
// row fields that decide a colour, and nothing that decides it for them.
export const claimEvidenceStateSchema = z.strictObject({
  basis: z.enum(["observed", "derived", "inferred", "unknown"]),
  validity: z.enum(["current", "stale", "contradicted"]),
  sourceEvidenceIds: z.array(nonEmptyString),
  authorityApplies: z.boolean(),
  coverage: graphCoverageSchema,
});

export const graphClaimStateSchema = z.strictObject({
  claimId: idSchema,
  assertion: nonEmptyString,
  revision: z.int().min(0),
  state: claimEvidenceStateSchema,
});

export const graphNodeSchema = z.strictObject({
  entityKey: nonEmptyString,
  claimIds: z.array(idSchema),
  evidenceIds: z.array(nonEmptyString),
});

export const graphEdgeSchema = z.strictObject({
  id: idSchema,
  fromKey: nonEmptyString,
  toKey: nonEmptyString,
  relation: nonEmptyString,
  claimId: idSchema,
});

export const graphViewSchema = z.strictObject({
  projectId: idSchema,
  targetId: idSchema.nullable(),
  truncated: z.boolean(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  claims: z.array(graphClaimStateSchema),
  note: z.string().nullable(),
});

export const graphReadRequestSchema = z.strictObject({
  // Optional: with no target named, the newest target in the project is the one read,
  // and the reply says which. An empty project is a `note`, not an error.
  targetId: idSchema.optional(),
});

export type GraphViewWire = z.infer<typeof graphViewSchema>;
export type GraphClaimStateWire = z.infer<typeof graphClaimStateSchema>;
export type GraphReadRequestWire = z.infer<typeof graphReadRequestSchema>;

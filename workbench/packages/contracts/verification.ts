import { z } from "zod";

// Verification wire contracts (DESIGN §10, §8 `POST /verifications`, PRD F09/A08).
//
// The shape that decides everything here is: the evaluator submits *observations*,
// never a verdict. `result`, `counts`, `inventoryCounts` and the eight bound
// identities are derived by the worker from rows it already owns, so a candidate
// that prints "PASS", forges a report or replays a good run has nothing to write
// into (§10: 候选 stdout 中的 PASS、伪造报告与自报请求均无权成为验证依据).

import { digestSchema, idSchema, instantSchema, nonEmptyString } from "./primitives.ts";
import { CASE_STATES } from "../domain/report.ts";

// §10: method, encoded path, repeated query and body bytes are exact by default.
// Anything else has to be an explicitly named normalization, and the closed list
// is what stops a policy from growing a "ignore volatile fields" escape hatch.
export const comparatorNormalizations = [
  "http-header-name-case",
  "json-key-order",
  "timestamp-second-rounding",
] as const;

export const installedComparatorPolicySchema = z.strictObject({
  policyId: nonEmptyString,
  version: nonEmptyString,
  normalization: z.array(z.enum(comparatorNormalizations)).default([]),
});

export type InstalledComparatorPolicy = z.infer<typeof installedComparatorPolicySchema>;

// The registry the worker consults. `POST /verifications` accepts a policy *name*
// only, and an uninstalled name is refused rather than defaulted to something
// looser (§10: 不能为变绿自动忽略字段).
export const INSTALLED_COMPARATOR_POLICIES: readonly InstalledComparatorPolicy[] = [
  { policyId: "exact-http-v1", version: "1.0.0", normalization: [] },
  {
    policyId: "exact-http-normalized-v1",
    version: "1.0.0",
    normalization: ["http-header-name-case", "json-key-order"],
  },
];

export function findComparatorPolicy(
  policyId: string,
): InstalledComparatorPolicy | null {
  const matches = INSTALLED_COMPARATOR_POLICIES.filter((policy) => policy.policyId === policyId);
  return matches[0] ?? null;
}

export const verificationRequestSchema = z.strictObject({
  candidateId: idSchema,
  // A name, never code and never an inline policy object.
  comparatorPolicyId: nonEmptyString,
  deadlineAt: instantSchema.optional(),
});

export type VerificationRequest = z.infer<typeof verificationRequestSchema>;

// One observed behaviour per plan entry, as the trusted evaluator saw it.
// `expectedMatches` compares against the independently reviewed expected outcome;
// without an oracle the entry cannot settle to passed (§10: 响应解析没有 oracle
// 时不能 PASS).
export const evaluatorCaseObservationSchema = z.strictObject({
  vectorId: idSchema,
  requestObserved: z.boolean(),
  requestMatches: z.boolean(),
  decodedMatches: z.boolean(),
  // return/throw reported by the fixed adapter ABI, verbatim from the harness.
  outcome: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("return"), value: z.json() }),
    z.strictObject({ kind: z.literal("throw"), code: nonEmptyString, detail: z.json() }),
  ]),
  expectedOutcomeObserved: z.boolean(),
  nondeterministic: z.boolean(),
  // Already filtered by the only filter owner before it arrives here; the schema
  // cannot tell a raw holdout value from a redacted one, so the service also
  // refuses any holdout entry that carries one (domain/report.ts holdoutExposureDefects).
  safeDiff: z.json().nullable(),
});

export type EvaluatorCaseObservation = z.infer<typeof evaluatorCaseObservationSchema>;

// The named completion RPC body (§10: evaluator 只写 staging，再经具名 completion
// RPC 交给 worker 验证身份并提交). Note what is absent: no result, no counts, no
// digests of plan/blueprint/candidate/inventory/vector set — those are the
// worker's to bind.
export const evaluatorCompletionSchema = z.strictObject({
  candidateId: idSchema,
  jobId: idSchema,
  blueprintId: idSchema,
  planId: idSchema,
  comparatorPolicyId: nonEmptyString,
  runnerImageDigest: digestSchema,
  observations: z.array(evaluatorCaseObservationSchema),
  // An opaque staging id, not a storage key or a path: the worker re-reads and
  // re-hashes these bytes before anything is published.
  reportStagingId: z.string().regex(/^[0-9a-f-]{8,64}$/),
  reportSha256: digestSchema,
  limitations: z.array(z.string()).default([]),
});

export type EvaluatorCompletion = z.infer<typeof evaluatorCompletionSchema>;

export const verificationReportSchema = z.strictObject({
  id: idSchema,
  candidateId: idSchema,
  result: z.enum(["PASS", "FAIL", "UNKNOWN"]),
  currentness: z.enum(["current", "stale"]),
  scope: z.array(nonEmptyString),
  identities: z.strictObject({
    snapshotDigest: digestSchema,
    blueprintDigest: digestSchema,
    candidateDigest: digestSchema,
    vectorSetDigest: digestSchema,
    planDigest: digestSchema,
    inventoryDigest: digestSchema,
    comparatorDigest: digestSchema,
    runnerImageDigest: digestSchema,
  }),
  counts: z.strictObject({
    total: z.int().nonnegative(),
    passed: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    blocked: z.int().nonnegative(),
    skipped: z.int().nonnegative(),
  }),
  inventoryCounts: z.strictObject({
    total: z.int().nonnegative(),
    selected: z.int().nonnegative(),
    excluded: z.int().nonnegative(),
    blocked: z.int().nonnegative(),
  }),
  excludedVectors: z.array(
    z.strictObject({ vectorId: idSchema, reasonCode: z.enum(["outside-scope", "superseded"]) }),
  ),
  outcomes: z.array(
    z.strictObject({
      vectorId: idSchema,
      state: z.enum(CASE_STATES),
      reason: z.string().nullable(),
      safeDiff: z.json().nullable(),
    }),
  ),
  limitations: z.array(z.string()),
  digest: digestSchema,
});

export type VerificationReportWire = z.infer<typeof verificationReportSchema>;

export const verificationRowSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  candidateId: idSchema,
  jobId: idSchema,
  planId: idSchema,
  planDigest: digestSchema,
  inventoryDigest: digestSchema,
  blueprintDigest: digestSchema,
  vectorSetDigest: digestSchema,
  comparatorDigest: digestSchema,
  runnerImageDigest: digestSchema,
  result: z.enum(["PASS", "FAIL", "UNKNOWN"]),
  currentness: z.enum(["current", "stale"]),
  summary: z.record(z.string(), z.json()),
  reportArtifactId: idSchema,
});

export type VerificationRow = z.infer<typeof verificationRowSchema>;

// The Builder-facing projection (§10: 只给契约级类别和安全 diff). Case ids and
// their states stay; holdout entries and the policy internals do not, and there
// is no field here that could carry one.
export const builderVerificationSummarySchema = z.strictObject({
  candidateId: idSchema,
  result: z.enum(["PASS", "FAIL", "UNKNOWN"]),
  currentness: z.enum(["current", "stale"]),
  counts: z.strictObject({
    total: z.int().nonnegative(),
    passed: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    blocked: z.int().nonnegative(),
    skipped: z.int().nonnegative(),
  }),
  categories: z.array(
    z.strictObject({
      state: z.enum(CASE_STATES),
      count: z.int().nonnegative(),
    }),
  ),
  limitations: z.array(z.string()),
});

export type BuilderVerificationSummary = z.infer<typeof builderVerificationSummarySchema>;

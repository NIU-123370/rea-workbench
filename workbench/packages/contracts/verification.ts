import { z } from "zod";

// Verification wire contracts (DESIGN §10, §8 `POST /verifications`, PRD F09/A08).
//
// The shape that decides everything here is: the evaluator submits *observations*,
// never a verdict. `result`, `counts`, `inventoryCounts` and the eight bound
// identities are derived by the worker from rows it already owns, so a candidate
// that prints "PASS", forges a report or replays a good run has nothing to write
// into (§10: 候选 stdout 中的 PASS、伪造报告与自报请求均无权成为验证依据).

import { digestSchema, idSchema, instantSchema, nonEmptyString } from "./primitives.ts";
import { jobRecordSchema } from "./jobs.ts";
import { CASE_STATES } from "../domain/report.ts";

// §10: method, encoded path, repeated query and body bytes are exact by default.
// Anything else has to be an explicitly named normalization, and the closed list
// is what stops a policy from growing a "ignore volatile fields" escape hatch.
//
// The list itself is owned by `domain/comparators.ts` (node-free and zod-free) because the page has
// to name these same three things when it shows the operator what each policy will ignore; reaching
// them through this contract would pull zod into the browser bundle, which §3 forbids. Imported for
// the schema below *and* re-exported, so every existing importer of this name keeps one owner.
import { COMPARATOR_NORMALIZATIONS } from "../domain/comparators.ts";
import type { ComparatorNormalization } from "../domain/comparators.ts";

export { COMPARATOR_NORMALIZATIONS as comparatorNormalizations } from "../domain/comparators.ts";
export type { ComparatorNormalization };

export const installedComparatorPolicySchema = z.strictObject({
  policyId: nonEmptyString,
  version: nonEmptyString,
  normalization: z.array(z.enum(COMPARATOR_NORMALIZATIONS)).default([]),
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

// Reading the names (§8 line 297 requires one and the table gives no way to enumerate them;
// issue #82's option 1, which the operator was asked to choose). Before this read existed, the
// only way an operator could find out whether a name was right was to send it and be refused -
// and a refusal writes a journal entry, so "trying a name" was not a free question.
//
// The answer is the very table the gate consults, not a second copy of it: `findComparatorPolicy`
// and this read are two views of one array, which is what keeps the read from ever offering a name
// the write would reject. There is deliberately **no default and no "recommended" flag** in this
// shape: picking either policy for a caller is the mistake §10 names (把松的一档当默认), so the
// choice stays with the operator and the page has to say so instead of preselecting.
export const comparatorPolicyReadSchema = z.strictObject({
  policies: z.array(installedComparatorPolicySchema),
});

export type ComparatorPolicyRead = z.infer<typeof comparatorPolicyReadSchema>;

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
  // The claim in the first line is now enforced, not assumed: `VerificationService.complete` runs
  // this transcript through the filter owner before any row is read (§12.1's safeDiff face,
  // issue #125). The schema still cannot tell a raw holdout value from a redacted one, so the
  // service separately refuses any holdout entry that carries one
  // (domain/report.ts holdoutExposureDefects).
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

// §10's other named RPC on the worker's private socket: the evaluator asks which verify job it is to
// run, and the worker moves that row `queued → running` under §11's owner. There is deliberately no
// §8 route for either half of this exchange — an evaluator is not a browser (§14: a peer-identity
// checked socket submits named commands, never SQL).
//
// The answer carries the rows the job is bound to, because "the next verification" is not actionable
// without them: whose candidate bytes, against which frozen blueprint and plan, on which target and
// snapshot, under which named comparator the control plane chose. Identifiers and digests only — no
// source, no holdout value, no host path (§12.1) — and **no verdict field anywhere in this shape**,
// which is §10's rule that the door cannot state an outcome.
export const verificationClaimRequestSchema = z.strictObject({
  // Optional: an evaluator launched for one candidate may ask only for that one.
  candidateId: idSchema.optional(),
});

export const verificationWorkSchema = z.strictObject({
  candidateId: idSchema,
  candidateDigest: digestSchema,
  blueprintId: idSchema,
  planId: idSchema,
  targetId: idSchema,
  snapshotDigest: digestSchema,
  comparatorPolicyId: nonEmptyString,
});

// Three outcomes, not two shapes of the same object, because the claim has a third honest answer: it
// started something, there was nothing to start, or the row it found could not be started and is now
// `failed` (§11: 达到 deadlineAt 仍未启动，则 queued→failed，保存明确错误). Collapsing that last one into an
// error would roll the row back and leave it `queued` to be refused again forever; collapsing it into
// `idle` would hide that a job died. Same reasoning as the runner's `RunnerOutcome`: a turn that
// finished is an outcome, and only a port failure is an `err`.
export const verificationClaimSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("claimed"),
    job: jobRecordSchema,
    work: verificationWorkSchema,
  }),
  z.strictObject({ state: z.literal("idle") }),
  z.strictObject({
    state: z.literal("failed"),
    job: jobRecordSchema,
    // A reason *code*, §8.1's vocabulary: what stopped the start, not a body of text about it.
    reasonCode: nonEmptyString,
  }),
]);

export type VerificationClaimWire = z.infer<typeof verificationClaimSchema>;
export type VerificationWorkWire = z.infer<typeof verificationWorkSchema>;

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

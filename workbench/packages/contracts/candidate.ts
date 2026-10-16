import { z } from "zod";

import { apiErrorSchema } from "./errors.ts";
import { digestSchema, idSchema, instantSchema, jsonObjectSchema, nonEmptyString } from "./primitives.ts";

// Candidate generation wire (DESIGN §7.3, §10 / PRD F08 A07, issue #19).
//
// The request names a blueprint and a job and nothing else: there is no target id, no
// vector id and no artifact key in this shape, so the Builder's only input is the
// frozen handoff. The reply repeats the digests the worker computed — a client cannot
// claim a candidate identity the store did not write.

export const candidateBudgetSchema = z.strictObject({
  // §7.3 says an explicit count/time budget exists and that the loop stops when it is
  // spent, and gives no number. So none is invented here: the caller states both
  // bounds per request, and a spent count is a refusal rather than one more attempt.
  maxAttemptsPerBlueprint: z.int().min(1),
  deadlineAt: instantSchema.nullable(),
});

export const candidateGenerateRequestSchema = z.strictObject({
  blueprintId: idSchema,
  jobId: idSchema,
  budget: candidateBudgetSchema,
  generator: jsonObjectSchema,
});

export const candidateFileSchema = z.strictObject({
  path: nonEmptyString,
  sha256: digestSchema,
  byteLength: z.int().min(0),
});

export const candidateCommitSchema = z.strictObject({
  candidateId: idSchema,
  digest: digestSchema,
  blueprintDigest: digestSchema,
  attempt: z.int().min(1),
  openApiVersion: nonEmptyString,
  files: z.array(candidateFileSchema),
});

export const candidateFailureSchema = apiErrorSchema;

export type CandidateBudgetWire = z.infer<typeof candidateBudgetSchema>;
export type CandidateGenerateRequestWire = z.infer<typeof candidateGenerateRequestSchema>;
export type CandidateFileWire = z.infer<typeof candidateFileSchema>;
export type CandidateCommitWire = z.infer<typeof candidateCommitSchema>;

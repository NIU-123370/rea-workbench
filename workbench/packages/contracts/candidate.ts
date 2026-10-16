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

// --- Candidate *read* shapes (DESIGN §8 lines 295-296, issue #19) -------------------
//
// The two replies above are what the Builder's own commit path writes. These are what a
// reviewer reads back: a candidate says which files it has - by manifest id, display path,
// byte length and language - and one file says what those bytes were, with the digest the
// manifest promised. A path is never resolved by the read: §8 names the manifest file id as
// the only selector, so a client cannot ask for a host path, another project's artifact, or
// a file this candidate did not publish.

export const candidateFileViewSchema = z.strictObject({
  // The artifact row's id, which is what §8's `:f` segment resolves against.
  id: idSchema,
  path: nonEmptyString,
  byteLength: z.int().min(0),
  language: nonEmptyString,
  sha256: digestSchema,
});

export const candidateViewSchema = z.strictObject({
  id: idSchema,
  blueprintId: idSchema,
  digest: digestSchema,
  files: z.array(candidateFileViewSchema),
});

export const candidateFileContentSchema = z.strictObject({
  fileId: idSchema,
  content: z.string(),
  sha256: digestSchema,
});

// The manifest the Builder committed, re-checked on the way out rather than trusted
// because it is already in a row: an entry that names no artifact, repeats an id, or is
// empty is a refusal, not a partial file list.
export const candidateManifestSchema = z.strictObject({
  files: z
    .array(
      z.strictObject({
        path: nonEmptyString,
        sha256: digestSchema,
        artifactId: idSchema,
      }),
    )
    .min(1),
});

// What the two reads are asked for. Both name identifiers only: there is no path, no
// storage key and no project in these shapes, because the route already carries the
// project and §5 keeps the storage key server-side.
export const candidateReadRequestSchema = z.strictObject({ candidateId: idSchema });
export const candidateFileRequestSchema = z.strictObject({ candidateId: idSchema, fileId: idSchema });

export type CandidateReadRequestWire = z.infer<typeof candidateReadRequestSchema>;
export type CandidateFileRequestWire = z.infer<typeof candidateFileRequestSchema>;

export type CandidateFileViewWire = z.infer<typeof candidateFileViewSchema>;
export type CandidateViewWire = z.infer<typeof candidateViewSchema>;
export type CandidateFileContentWire = z.infer<typeof candidateFileContentSchema>;

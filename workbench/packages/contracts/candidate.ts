import { z } from "zod";

import { apiErrorSchema } from "./errors.ts";
import { digestSchema, idSchema, instantSchema, nonEmptyString } from "./primitives.ts";

// Candidate generation wire (DESIGN §7.3, §8 line 294, §10 / PRD F08 A07, issues #19 and #57).
//
// §8's row for this door says the body is `{blueprintId, deadlineAt?}` and the answer is a
// `202 JobRecord`, and that is the whole shape: the request names the frozen handoff and, at most,
// a deadline. It does not name a job, a budget or a generator, because each of those is a fact the
// worker owns — §11's recovery, §12.2's decision journal and §8's idempotency key are all written
// against "the worker created this job", so a client that supplied an id would be handing the
// request a fact it is not allowed to decide (that was `issue #57`'s complaint about
// `candidate.generate`, whose client-minted `jobId` is gone with this shape).
//
// The reply is `jobRecordSchema` itself, not a candidate summary: §10 says a request creates work
// and never a verdict, so at the moment this answers, no candidate exists yet.

export const candidateRequestSchema = z.strictObject({
  blueprintId: idSchema,
  deadlineAt: instantSchema.nullable().optional(),
});

export type CandidateRequestWire = z.infer<typeof candidateRequestSchema>;

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

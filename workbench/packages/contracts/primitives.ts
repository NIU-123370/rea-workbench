import { z } from "zod";

import { DIGEST_PATTERN } from "../domain/canonical-json.ts";
import {
  ID_PATTERN,
  INSTANT_PATTERN,
  REA_EVIDENCE_ID_PATTERN,
  isInstant,
} from "../domain/identity.ts";

// Wire primitives share one owner with the domain validators. A regex alone is
// not enough for instants: `2026-02-30T00:00:00Z` is syntactically well-formed
// but `Date.parse` rolls it forward, which would silently move a deadline.

export const idSchema = z.string().regex(ID_PATTERN);

export const digestSchema = z.string().regex(DIGEST_PATTERN);

export const instantSchema = z
  .string()
  .regex(INSTANT_PATTERN)
  .refine((value: string) => isInstant(value), {
    message: "instant must be a real UTC calendar instant",
  });

export const reaEvidenceIdSchema = z.string().regex(REA_EVIDENCE_ID_PATTERN);

export const jsonValueSchema = z.json();

export const jsonObjectSchema = z.record(z.string(), z.json());

export const nonEmptyString = z.string().min(1);

// A cursor is opaque: it is minted by the worker, never interpreted here.
export const cursorSchema = z.string().min(1).max(512);

export const limitSchema = z.int().min(1).max(500);

export const booleanFlag = z.boolean();

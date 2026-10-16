import { randomUUID } from "node:crypto";

import type { Id } from "./id.ts";

// Workbench wire identities are opaque UUIDs. They are never a name, address
// or path (DESIGN §4); upstream ids keep their own shape and are carried as
// strings in the dedicated fields below. The shape itself lives in `id.ts`, which
// carries no Node dependency so a browser bundle can check an id without pulling
// `node:crypto` in with it.
export { ID_PATTERN, isId, asId, type Id } from "./id.ts";

export function newId(): Id {
  return randomUUID() as Id;
}

export type Instant = string & { readonly instantBrand: unique symbol };

export const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function nowInstant(): Instant {
  return new Date().toISOString() as Instant;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function isInstant(value: unknown): value is Instant {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) return false;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  // Date.parse silently rolls impossible calendar dates forward
  // (2026-02-30T00:00:00Z becomes 2026-03-02), so the parsed value must project
  // back onto the exact source text before it can be a deadline or retry time.
  const date = new Date(ms);
  const rebuilt =
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`;
  if (value.slice(0, 19) !== rebuilt) return false;
  const fraction = value.slice(20, -1);
  if (fraction === "") return date.getUTCMilliseconds() === 0;
  // RFC 3339 allows up to nine fractional digits; anything below a millisecond
  // is representable in the parsed value only as a truncation, not a mismatch.
  return Math.floor(Number(`0.${fraction}`) * 1000) === date.getUTCMilliseconds();
}

export function asInstant(value: string): Instant {
  if (!isInstant(value)) {
    throw new TypeError("instant must be a UTC RFC 3339 timestamp");
  }
  return value;
}

export function instantToEpochMs(value: Instant): number {
  return Date.parse(value);
}

// Upstream identifiers are preserved verbatim, never re-derived here.
export const REA_EVIDENCE_ID_PATTERN = /^ev_[0-9a-f]{64}$/;
export const REA_GRAPH_ID_PREFIX = "jag_";

export function isReaEvidenceId(value: unknown): value is string {
  return typeof value === "string" && REA_EVIDENCE_ID_PATTERN.test(value);
}

export function isReaGraphId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(REA_GRAPH_ID_PREFIX);
}

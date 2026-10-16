import { z } from "zod";

import { idSchema, instantSchema, nonEmptyString } from "./primitives.ts";

// Session pairing (DESIGN §8, §14, D30). The bootstrap token is an in-memory,
// single-use credential that never appears in a URL, log or audit body; these
// schemas describe the exchange, they do not authorise storing either value.

export const bootstrapExchangeSchema = z.strictObject({
  bootstrapToken: nonEmptyString,
});

export const sessionViewSchema = z.strictObject({
  // A locally minted session identity used to attribute reviews; it claims no
  // real-world identity (DESIGN §14).
  reviewerId: idSchema,
  csrfToken: nonEmptyString,
  expiresAt: instantSchema,
});

export const currentSessionSchema = z.strictObject({
  reviewerId: idSchema,
  csrfToken: nonEmptyString,
  expiresAt: instantSchema,
  // V0.1 has a single local role; the server assigns it, callers cannot.
  role: z.literal("local-controller"),
});

// What the worker's private RPC answers to `session.pair`. This shape exists only
// between the two local processes: the cookie value is here because the HTTP adapter
// is the one component allowed to put it in a `Set-Cookie`, and none of these fields
// may be logged, stored or echoed (§14, §12.1).
export const pairedSessionSchema = z.strictObject({
  sessionKey: nonEmptyString,
  reviewerId: idSchema,
  csrfToken: nonEmptyString,
  expiresAt: instantSchema,
});

export const revokedSessionSchema = z.strictObject({
  revoked: z.literal(true),
});

export type BootstrapExchange = z.infer<typeof bootstrapExchangeSchema>;
export type SessionView = z.infer<typeof sessionViewSchema>;
export type CurrentSession = z.infer<typeof currentSessionSchema>;
export type PairedSessionWire = z.infer<typeof pairedSessionSchema>;
export type RevokedSessionWire = z.infer<typeof revokedSessionSchema>;

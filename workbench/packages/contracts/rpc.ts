import { z } from "zod";

import { jsonValueSchema, nonEmptyString } from "./primitives.ts";
import type { JsonValue } from "../domain/json-value.ts";

// The worker's local RPC frame (DESIGN §2 本机 RPC, §14).
//
// §2 gives one process the write connection and says every other process reaches it by
// *named commands over a private local RPC*, in one dialect. The server side of that
// dialect is `apps/worker/rpc-server.ts`; the client side lives in `apps/web`. Both are
// only the same dialect if the frame is described once, so the shape and the
// newline-delimited encoding are here, in the module both sides may depend on.
//
// There is deliberately nothing in this file that could carry a query: no SQL field, no
// path, no shell, no command list. A frame names a registered command or the worker
// refuses it.

// The wire vocabulary of actor kinds. `packages/application/actor.ts` owns what each kind
// may *do*; this list is the only one a frame may carry, and the tests pin the two lists
// against each other so they cannot drift into two vocabularies.
export const RPC_ACTOR_KINDS = ["inspector", "reviewer", "builder", "system"] as const;

export type RpcActorKind = (typeof RPC_ACTOR_KINDS)[number];

export const rpcActorSchema = z.strictObject({
  actorId: nonEmptyString.max(200),
  actorKind: z.enum(RPC_ACTOR_KINDS),
});

export const rpcFrameSchema = z.strictObject({
  id: z.int().nonnegative(),
  command: nonEmptyString.max(120),
  payload: jsonValueSchema,
  actor: rpcActorSchema,
});

export const rpcFailureSchema = z.strictObject({
  code: nonEmptyString,
  reason: nonEmptyString,
  message: nonEmptyString,
});

export const rpcReplySchema = z.union([
  z.strictObject({ id: z.int(), ok: z.literal(true), value: jsonValueSchema }),
  z.strictObject({ id: z.int(), ok: z.literal(false), error: rpcFailureSchema }),
]);

// The wire types are stated here rather than inferred: zod's recursive JSON type is not
// the workbench's `JsonValue` (§4), and a client that had to convert between the two
// would be a second definition of what a payload may be.
export type RpcActorWire = { actorId: string; actorKind: RpcActorKind };
export type RpcFrameWire = { id: number; command: string; payload: JsonValue; actor: RpcActorWire };
export type RpcFailureWire = { code: string; reason: string; message: string };
export type RpcReplyWire = { id: number; ok: true; value: JsonValue } | { id: number; ok: false; error: RpcFailureWire };

// One frame per line, one reply per line: the socket never buffers a partial object
// across a newline, so a reader can tell where a frame ended without parsing it.
export const RPC_FRAME_DELIMITER = "\n";

export function encodeRpcFrame(frame: RpcFrameWire): string {
  return `${JSON.stringify(frame)}${RPC_FRAME_DELIMITER}`;
}

export type RpcDecodeFailure = { reason: string };

export type RpcDecodeResult = { ok: true; value: RpcReplyWire } | { ok: false; error: RpcDecodeFailure };

function refused(reason: string): RpcDecodeResult {
  return { ok: false, error: { reason } };
}

export function decodeRpcReply(line: string): RpcDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return refused("reply-not-json");
  }
  const checked = rpcReplySchema.safeParse(parsed);
  if (!checked.success) return refused("reply-shape-rejected");
  return { ok: true, value: checked.data as unknown as RpcReplyWire };
}

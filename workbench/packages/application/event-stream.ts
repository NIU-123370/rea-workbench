import { EVENT_TYPES, committedEventSchema } from "../contracts/events.ts";
import type { CommittedEvent, EventType } from "../contracts/events.ts";
import { parseStrict } from "../contracts/parse.ts";
import type { CommittedEvent as StoredEvent } from "./ports.ts";
import { gateFail } from "./gate-failure.ts";
import type { GateFailure } from "./gate-failure.ts";
import { redactJsonValue } from "./sanitizer.ts";
import type { SensitiveDeclaration } from "./sanitizer.ts";
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";

// The SSE read side of committed events (DESIGN §8 "SSE 事件字段", §5, §12.1).
//
// The worker owns writing the outbox row inside the same transaction as the
// business change; this module owns what a browser may see of it. Three things are
// enforced here rather than assumed:
//   * the type list is CLOSED. A row whose `type` is not one of the ten names is a
//     refusal, never a passthrough and never a silent skip — skipping would break
//     the "at-least-once, deduplicate by seq" contract the design gives consumers.
//   * the payload shape is the strict one from `contracts/events.ts`, which is what
//     makes "no body text, no source code, no credential values, no model context"
//     checkable: there is no field a body could go into.
//   * every payload still passes the single filter owner before it is framed
//     (§12.1 lists the SSE payload explicitly).

export const CLOSED_EVENT_TYPES: readonly EventType[] = EVENT_TYPES;

// A frame over this budget is refused rather than truncated: a truncated event
// reads as a complete one to a client that is only diffing fields.
export const MAX_EVENT_FRAME_BYTES = 16 * 1024;

// The most a single read will hand the adapter, so a client cannot make the worker
// assemble the whole outbox in one reply.
export const MAX_EVENT_PAGE = 200;

export type EventCursor =
  // Live tail: nothing was requested, so the stream starts after the newest seq.
  | { kind: "live" }
  | { kind: "after"; afterSeq: number };

export type EventWindow = {
  // Null while the project has no events at all.
  oldestSeq: number | null;
  latestSeq: number;
};

export type CursorInput = {
  // `Last-Event-ID` as the browser sends it, verbatim.
  lastEventId: string | null;
  // `?after=` as the query string carries it, verbatim.
  after: string | null;
};

export function isClosedEventType(type: string): type is EventType {
  return (CLOSED_EVENT_TYPES as readonly string[]).includes(type);
}

function decimalSeq(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// `Last-Event-ID` **or** `after`, never both conflicting (§8). The two disagree only
// when both are present and name different seqs; equal values are one cursor.
export function resolveCursor(input: CursorInput, window: EventWindow): Result<EventCursor, GateFailure> {
  const header = input.lastEventId;
  const query = input.after;
  if (header !== null && query !== null) {
    if (header !== query) {
      return gateFail(
        "EVENT_CURSOR_EXPIRED",
        "cursor-conflict",
        "Last-Event-ID and after disagree; re-read a snapshot and subscribe from one cursor",
      );
    }
  }
  const presented = query ?? header;
  if (presented === null) return { ok: true, value: { kind: "live" } };
  const seq = decimalSeq(presented);
  if (seq === null) {
    // The query parameter is caller-supplied input; the header is a cursor the
    // server minted, so an unparseable header means the client is holding something
    // this worker never issued — that is an unrecoverable cursor, not a typo.
    return gateFail(
      query !== null ? "INVALID_INPUT" : "EVENT_CURSOR_EXPIRED",
      query !== null ? "cursor-not-integer" : "cursor-not-issued-here",
      "the event cursor is not a recoverable sequence number",
    );
  }
  if (window.oldestSeq !== null && seq + 1 < window.oldestSeq) {
    return gateFail(
      "EVENT_CURSOR_EXPIRED",
      "cursor-pruned",
      "events between the cursor and the retained window are gone; re-read a snapshot",
      { requestedSeq: seq, oldestSeq: window.oldestSeq },
    );
  }
  if (seq > window.latestSeq) {
    return gateFail(
      "EVENT_CURSOR_EXPIRED",
      "cursor-ahead-of-latest",
      "the cursor names a sequence this project never produced; re-read a snapshot",
      { requestedSeq: seq, latestSeq: window.latestSeq },
    );
  }
  return { ok: true, value: { kind: "after", afterSeq: seq } };
}

export function cursorOf(event: CommittedEvent): number {
  return event.seq;
}

// A stored outbox row -> the wire event. The strict schema is the gate: an unknown
// type, an extra payload field or a body-shaped payload all come back as a refusal
// with a named reason and no echo of the offending value.
export function toStreamEvent(stored: StoredEvent): Result<CommittedEvent, GateFailure> {
  if (!isClosedEventType(stored.type)) {
    return gateFail(
      "REA_CONTRACT_MISMATCH",
      "event-type-unknown",
      "a committed event names an event type outside the closed list",
      { seq: stored.seq },
    );
  }
  const candidate = {
    seq: stored.seq,
    projectId: stored.projectId,
    type: stored.type,
    aggregateId: stored.aggregateId,
    createdAt: stored.createdAt,
    payload: stored.payloadJson,
  };
  const parsed = parseStrict(committedEventSchema, candidate);
  if (!parsed.ok) {
    return gateFail(
      "REA_CONTRACT_MISMATCH",
      "event-payload-rejected",
      "a committed event does not match the event contract",
      { seq: stored.seq, fields: parsed.error.issues.map((issue) => issue.path) },
    );
  }
  return { ok: true, value: parsed.value };
}

export function toStreamEvents(stored: readonly StoredEvent[]): Result<CommittedEvent[], GateFailure> {
  const events: CommittedEvent[] = [];
  for (const row of stored) {
    const event = toStreamEvent(row);
    // The whole batch is refused, so the adapter never writes some events of a
    // batch and then fails partway through it.
    if (!event.ok) return event;
    events.push(event.value);
  }
  return { ok: true, value: events };
}

// The inferred payload type carries `| undefined` on every optional member, which
// `JsonValue` does not have. Round-tripping drops absent members instead of
// storing null for them, so a filter never sees a field the event did not send.
function eventPayloadJson(event: CommittedEvent): JsonValue {
  return JSON.parse(JSON.stringify(event.payload)) as JsonValue;
}

// One committed event -> one SSE frame: `id` is the seq, `event` is the type and
// `data` is exactly the six fields §8 names, in that order.
export function encodeSseFrame(
  event: CommittedEvent,
  declaration: SensitiveDeclaration | null,
): Result<string, GateFailure> {
  const filtered = redactJsonValue(eventPayloadJson(event), declaration);
  const wire = {
    seq: event.seq,
    projectId: event.projectId,
    type: event.type,
    aggregateId: event.aggregateId,
    createdAt: event.createdAt,
    payload: filtered.value,
  };
  const encoded = JSON.stringify(wire);
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
    // The `id:` line is the cursor a client will send back, so a seq that is not a
    // plain non-negative integer cannot be framed at all rather than framed and
    // then refused on the next request.
    return gateFail("REA_CONTRACT_MISMATCH", "event-seq-unframable", "the committed event has no usable sequence");
  }
  const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${encoded}\n\n`;
  // JSON.stringify escapes every control character, so the frame below is always
  // three fields plus the blank line terminator no matter what the payload said.
  const bytes = new TextEncoder().encode(frame).byteLength;
  if (bytes > MAX_EVENT_FRAME_BYTES) {
    return gateFail(
      "RESOURCE_LIMIT",
      "event-frame-too-large",
      "the committed event is larger than the SSE frame budget",
      { seq: event.seq, byteLength: bytes, limit: MAX_EVENT_FRAME_BYTES },
    );
  }
  return { ok: true, value: frame };
}

export function encodeSseFrames(
  events: readonly CommittedEvent[],
  declaration: SensitiveDeclaration | null,
): Result<string[], GateFailure> {
  const frames: string[] = [];
  for (const event of events) {
    const frame = encodeSseFrame(event, declaration);
    if (!frame.ok) return frame;
    frames.push(frame.value);
  }
  return { ok: true, value: frames };
}

export function normalizeEventLimit(requested: number | null): Result<number, GateFailure> {
  if (requested === null) return { ok: true, value: MAX_EVENT_PAGE };
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return gateFail("INVALID_INPUT", "limit-invalid", "the event limit must be a positive integer");
  }
  if (requested > MAX_EVENT_PAGE) {
    return gateFail("RESOURCE_LIMIT", "limit-over-budget", `${MAX_EVENT_PAGE} events at a time is the read budget`, {
      requested,
      limit: MAX_EVENT_PAGE,
    });
  }
  return { ok: true, value: requested };
}

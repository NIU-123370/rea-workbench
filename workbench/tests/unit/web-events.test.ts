import { describe, expect, it } from "vitest";

import {
  CLOSED_EVENT_TYPES,
  MAX_EVENT_FRAME_BYTES,
  cursorOf,
  encodeSseFrame,
  isClosedEventType,
  normalizeEventLimit,
  resolveCursor,
  toStreamEvent,
  toStreamEvents,
} from "../../packages/application/event-stream.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type { CommittedEvent as StoredEvent } from "../../packages/application/ports.ts";
import type { CommittedEvent, EventType } from "../../packages/contracts/events.ts";

// SSE from the worker's committed events (DESIGN §8 / §14, issue #17). The cursor is
// the contract: `Last-Event-ID` xor `after`, and anything unrecoverable is a 409 that
// sends the client back to a snapshot instead of a partial stream.

const PROJECT: Id = newId();
const WINDOW = { oldestSeq: 10, latestSeq: 40 };

function event(
  seq: number,
  type: EventType = "job.updated",
  payload: CommittedEvent["payload"] = { state: "running" },
): CommittedEvent {
  return {
    seq,
    projectId: PROJECT,
    type,
    aggregateId: newId(),
    payload,
    createdAt: nowInstant() as Instant,
  };
}

describe("the cursor (§8)", () => {
  it("starts a live tail when nothing was requested", () => {
    expect(resolveCursor({ lastEventId: null, after: null }, WINDOW)).toEqual({
      ok: true,
      value: { kind: "live" },
    });
  });

  it("takes either form, but never two that disagree", () => {
    expect(resolveCursor({ lastEventId: "25", after: null }, WINDOW)).toEqual({
      ok: true,
      value: { kind: "after", afterSeq: 25 },
    });
    expect(resolveCursor({ lastEventId: null, after: "25" }, WINDOW)).toEqual({
      ok: true,
      value: { kind: "after", afterSeq: 25 },
    });
    // Equal values are one cursor expressed twice.
    expect(resolveCursor({ lastEventId: "25", after: "25" }, WINDOW).ok).toBe(true);
    const conflict = resolveCursor({ lastEventId: "25", after: "26" }, WINDOW);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe("EVENT_CURSOR_EXPIRED");
    expect(conflict.error.reason).toBe("cursor-conflict");
  });

  it("refuses a cursor the retained window no longer holds", () => {
    const pruned = resolveCursor({ lastEventId: "4", after: null }, WINDOW);
    expect(pruned.ok).toBe(false);
    if (pruned.ok) return;
    expect(pruned.error.reason).toBe("cursor-pruned");
    expect(pruned.error.details["requestedSeq"]).toBe(4);
    expect(pruned.error.details["oldestSeq"]).toBe(10);
  });

  it("refuses a cursor naming a sequence that never happened", () => {
    const ahead = resolveCursor({ lastEventId: "99", after: null }, WINDOW);
    expect(ahead.ok).toBe(false);
    if (ahead.ok) return;
    expect(ahead.error.reason).toBe("cursor-ahead-of-latest");
  });

  it("treats a junk header as a cursor this worker never issued", () => {
    const header = resolveCursor({ lastEventId: "not-a-seq", after: null }, WINDOW);
    expect(header.ok).toBe(false);
    if (header.ok) return;
    expect(header.error.code).toBe("EVENT_CURSOR_EXPIRED");
    expect(header.error.reason).toBe("cursor-not-issued-here");

    const query = resolveCursor({ lastEventId: null, after: "not-a-seq" }, WINDOW);
    expect(query.ok).toBe(false);
    if (query.ok) return;
    // A caller-supplied query parameter is a bad request, not a lost stream.
    expect(query.error.code).toBe("INVALID_INPUT");
    expect(query.error.reason).toBe("cursor-not-integer");
  });

  it("accepts the newest seq so a reconnect after the last event is not a gap", () => {
    expect(resolveCursor({ lastEventId: "40", after: null }, WINDOW).ok).toBe(true);
  });

  it("has no oldest bound to prune against while the project is empty", () => {
    expect(resolveCursor({ lastEventId: "3", after: null }, { oldestSeq: null, latestSeq: 0 }).ok).toBe(false);
    expect(resolveCursor({ lastEventId: "0", after: null }, { oldestSeq: null, latestSeq: 0 }).ok).toBe(true);
  });
});

describe("the frame and the closed type list (§8)", () => {
  it("writes id, event and data from one committed event", () => {
    const frame = encodeSseFrame(event(12), { declaredValues: [] });
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    expect(frame.value.startsWith("id: 12\n")).toBe(true);
    expect(frame.value).toContain("event: job.updated\n");
    expect(frame.value.endsWith("\n\n")).toBe(true);
    const line = frame.value.split("data: ")[1];
    if (line === undefined) throw new Error("the frame carried no data line");
    const [dataLine = ""] = line.split("\n");
    const data = JSON.parse(dataLine) as Record<string, JsonValue>;
    expect(Object.keys(data).sort()).toEqual([
      "aggregateId",
      "createdAt",
      "payload",
      "projectId",
      "seq",
      "type",
    ]);
  });

  it("filters the payload through the one owner before it leaves", () => {
    // The payload has no free-form field, so the largest string a committed event can
    // carry is `reasonCode`; a declared literal in it must still be filtered (§12.1).
    const secret = "Bearer-abc123xyz";
    const frame = encodeSseFrame(event(13, "evidence.committed", { reasonCode: secret }), {
      declaredValues: [secret],
    });
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    expect(frame.value).not.toContain(secret);
  });

  it("refuses an event whose type is not on the closed list", () => {
    expect(isClosedEventType("job.updated")).toBe(true);
    expect(isClosedEventType("report.deleted")).toBe(false);
    // The list is enforced where a stored row becomes a wire event: an unknown type
    // must be a refusal, never a passthrough and never a silent skip, because a skip
    // would break the at-least-once / deduplicate-by-seq contract consumers rely on.
    const refused = toStreamEvent({
      seq: 14,
      projectId: PROJECT,
      type: "report.deleted",
      aggregateId: newId(),
      payloadJson: { state: "running" },
      createdAt: nowInstant(),
    } satisfies StoredEvent);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("REA_CONTRACT_MISMATCH");
    expect(refused.error.reason).toBe("event-type-unknown");
  });

  it("refuses a sequence it could not hand back as a cursor", () => {
    const bad = encodeSseFrame(event(-1), { declaredValues: [] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.reason).toBe("event-seq-unframable");
  });

  it("keeps one frame inside the byte budget", () => {
    const huge = "r".repeat(MAX_EVENT_FRAME_BYTES + 1);
    const refused = encodeSseFrame(event(15, "job.updated", { reasonCode: huge }), { declaredValues: [] });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("RESOURCE_LIMIT");
    expect(refused.error.reason).toBe("event-frame-too-large");
    expect(refused.error.details["limit"]).toBe(MAX_EVENT_FRAME_BYTES);
  });

  it("refuses the whole page when one row in it would be a lie", () => {
    const pages = toStreamEvents([
      { seq: 16, projectId: PROJECT, type: "job.updated", aggregateId: newId(), payloadJson: { state: "running" }, createdAt: nowInstant() },
      { seq: 17, projectId: PROJECT, type: "report.deleted", aggregateId: newId(), payloadJson: {}, createdAt: nowInstant() },
    ] as unknown as StoredEvent[]);
    expect(pages.ok).toBe(false);
  });

  it("normalizes a page size instead of trusting the caller's number", () => {
    const defaulted = normalizeEventLimit(null);
    expect(defaulted.ok).toBe(true);
    expect(normalizeEventLimit(-1).ok).toBe(false);
    if (defaulted.ok) expect(defaulted.value).toBeGreaterThan(0);
  });

  it("keeps the cursor and the frame's id the same number", () => {
    const committed = event(21);
    expect(cursorOf(committed)).toBe(21);
    const frame = encodeSseFrame(committed, { declaredValues: [] });
    if (!frame.ok) throw new Error("frame should build");
    expect(frame.value).toContain(`id: ${String(cursorOf(committed))}`);
  });

  it("reads a stored row through the strict gate", () => {
    const stored: StoredEvent = {
      seq: 5,
      projectId: PROJECT,
      type: "vector.created",
      // The stored aggregate id is an opaque Id upstream: a readable label is not a
      // valid idSchema value, and the strict gate would refuse it for that reason
      // rather than for the one this case is about.
      aggregateId: newId(),
      payloadJson: { resourceIds: [newId()] },
      createdAt: nowInstant(),
    };
    const ok = toStreamEvent(stored);
    expect(ok.ok).toBe(true);
    const junk = toStreamEvent({ ...stored, type: "vector.deleted" });
    expect(junk.ok).toBe(false);
    expect(CLOSED_EVENT_TYPES.length).toBeGreaterThan(0);
  });
});

import { eventPageSchema } from "../../packages/contracts/events.ts";
import type { EventPage } from "../../packages/contracts/events.ts";
import { parseStrict } from "../../packages/contracts/parse.ts";
import { encodeSseFrames, MAX_EVENT_PAGE, resolveCursor } from "../../packages/application/event-stream.ts";
import type { EventWindow } from "../../packages/application/event-stream.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type { SensitiveDeclaration } from "../../packages/application/sanitizer.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type { ApiResponse } from "./types.ts";
import type { WorkerCaller, WorkerFailure } from "./worker-client.ts";
import type { Actor } from "../../packages/application/actor.ts";
import { errorResponse, streamHeaders } from "./api-envelope.ts";

// SSE served from the worker's committed events (DESIGN §8 SSE, §2, §5).
//
// The adapter never opens a stream on an unvalidated cursor: the window is read first,
// the cursor is judged against it, and the backlog is fetched and framed *before* the
// 200 is written. That ordering is what lets §8's "unrecoverable cursor -> 409
// EVENT_CURSOR_EXPIRED" be a status code rather than a stream that dies. After the 200,
// a failure can only close the stream; the client re-reads a snapshot and resubscribes.

export type StreamDependencies = {
  worker: WorkerCaller;
  actor: Actor;
  requestId: string;
  declaration: SensitiveDeclaration;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
};

export type StreamRequest = {
  projectId: Id;
  lastEventId: string | null;
  after: string | null;
};

function workerFailure(requestId: string, failure: WorkerFailure, declaration: SensitiveDeclaration): ApiResponse {
  return errorResponse(
    requestId,
    { code: failure.code, message: failure.message, details: { reason: failure.reason } },
    declaration,
  );
}

async function readPage(
  deps: StreamDependencies,
  projectId: Id,
  afterSeq: number,
  limit: number,
): Promise<{ ok: true; page: EventPage } | { ok: false; response: ApiResponse }> {
  const outcome = await deps.worker.call("events.after", { projectId, afterSeq, limit } as unknown as JsonValue, deps.actor);
  if (!outcome.ok) return { ok: false, response: workerFailure(deps.requestId, outcome.error, deps.declaration) };
  const parsed = parseStrict(eventPageSchema, outcome.value);
  if (!parsed.ok) {
    // The reply is data, including its event types: the closed list is re-checked here
    // rather than assumed from whatever the socket carried (§8).
    return {
      ok: false,
      response: errorResponse(
        deps.requestId,
        {
          code: "REA_CONTRACT_MISMATCH",
          message: "the worker's event page does not match the event contract",
          details: { field: parsed.error.issues[0]?.path ?? "events" },
        },
        deps.declaration,
      ),
    };
  }
  return { ok: true, page: parsed.value };
}

export type OpenedStream = { ok: true; backlog: string[]; window: EventWindow; afterSeq: number } | { ok: false; failure: GateFailure };

// The first thing written to every stream, before any event.
//
// A route handler that forwards a body chunk by chunk - which is what the UI relay does (§2) -
// does not write the response head until the first chunk arrives, so an open-but-idle stream
// leaves the browser's `EventSource` waiting for its `open` event forever: the connection is
// live and tailing, and the panel says it is still connecting (issue #85's browser reading).
// An SSE line beginning with `:` is a comment the client must ignore, so this carries no state
// and cannot be mistaken for an event; it only proves the bytes are flowing.
export const STREAM_PREAMBLE = ": stream-open\n\n";

// Cursor judgement, shared by the open and by the re-read a client may force.
export function judgeCursor(window: EventWindow, request: StreamRequest) {
  return resolveCursor({ lastEventId: request.lastEventId, after: request.after }, window);
}

export async function openEventStream(
  deps: StreamDependencies,
  request: StreamRequest,
): Promise<ApiResponse> {
  // A page of one at cursor 0 is the cheapest honest way to learn the window: it is the
  // worker's own view of the outbox, not a count this process keeps.
  const probe = await readPage(deps, request.projectId, 0, 1);
  if (!probe.ok) return probe.response;
  const cursor = judgeCursor({ oldestSeq: probe.page.oldestSeq, latestSeq: probe.page.latestSeq }, request);
  if (!cursor.ok) {
    return errorResponse(
      deps.requestId,
      { code: cursor.error.code, message: cursor.error.message, details: { reason: cursor.error.reason, ...cursor.error.details } },
      deps.declaration,
    );
  }
  const afterSeq = cursor.value.kind === "live" ? probe.page.latestSeq : cursor.value.afterSeq;
  const backlog = await readPage(deps, request.projectId, afterSeq, MAX_EVENT_PAGE);
  if (!backlog.ok) return backlog.response;
  const frames = encodeSseFrames(backlog.page.events, deps.declaration);
  if (!frames.ok) {
    return errorResponse(
      deps.requestId,
      { code: frames.error.code, message: frames.error.message, details: { reason: frames.error.reason, ...frames.error.details } },
      deps.declaration,
    );
  }

  let lastSeq = afterSeq;
  for (const event of backlog.page.events) lastSeq = Math.max(lastSeq, event.seq);
  const queue = [STREAM_PREAMBLE, ...frames.value];
  let stopped = false;
  return {
    kind: "stream",
    status: 200,
    headers: streamHeaders(),
    pump: {
      close() {
        stopped = true;
      },
      async take(): Promise<string | null> {
        // A poll that found nothing is not the end of a stream: this loop is what keeps one open
        // subscriber waiting for the next commit. Returning null here on an empty page ended every
        // idle connection, and the browser's reconnect churn is what made a live tail indistinguishable
        // from a dead one (issue #85's reading: the door worked, the panel could not tell).
        for (;;) {
          // The close is checked before the queue: a stream the caller ended is not going to hand out
          // one more frame "because it was already committed", and the writer on the other side of this
          // call is a response that has been finished. Delivering into a finished response is not
          // silence - Node reports it as `ERR_STREAM_WRITE_AFTER_END`.
          if (stopped) return null;
          const next = queue.shift();
          if (next !== undefined) return next;
          await deps.sleep(deps.pollMs);
          if (stopped) return null;
          const page = await readPage(deps, request.projectId, lastSeq, MAX_EVENT_PAGE);
          if (!page.ok) {
            // The stream is closed rather than continued on a guess: the client's own
            // Last-Event-ID makes the gap recoverable, a silently skipped page would not.
            stopped = true;
            return null;
          }
          const encoded = encodeSseFrames(page.page.events, deps.declaration);
          if (!encoded.ok) {
            stopped = true;
            return null;
          }
          for (const event of page.page.events) lastSeq = Math.max(lastSeq, event.seq);
          queue.push(...encoded.value);
        }
      },
    },
  };
}

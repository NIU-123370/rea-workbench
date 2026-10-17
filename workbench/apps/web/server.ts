import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { MAX_REQUEST_BODY_BYTES, MAX_UPLOAD_BODY_BYTES, type ApiHandler } from "./api.ts";
import type { ApiResponse, HttpRequest } from "./types.ts";

// The loopback mount for the API pipeline (§14 / D30). It exists as its own file so
// the handler stays framework-agnostic: a Next.js route handler (§3) converts its own
// request into `HttpRequest` and writes the returned `ApiResponse`, and this server
// does the same with `node:http`. Neither one reaches into the other.
//
// What this layer owns is the parts that are transport properties rather than
// decisions: the body budget is counted while reading (not after), the peer address
// is taken from the socket it actually arrived on, and a stream response is written
// frame by frame so an unrecoverable cursor can still be a real 409 before the body
// starts.

export const READINESS_POLL_MS = 40;

export type WebServer = {
  port: number;
  close: () => Promise<void>;
};

export type WebServerOptions = {
  handler: ApiHandler;
  host: string;
  port: number;
  onError: (reason: string) => void;
};

function headerMap(message: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    out[name] = Array.isArray(value) ? (value[0] ?? undefined) : value;
  }
  return out;
}

// The query string is read for its names and values only. A pairing code or session
// token that arrives here is not stripped by this layer: the API refuses the route
// with a named reason, because "never in a query" is a decision, not a cleanup.
function parseQuery(url: string): Record<string, string> {
  const index = url.indexOf("?");
  if (index < 0) return {};
  const out: Record<string, string> = {};
  for (const pair of url.slice(index + 1).split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    out[decodeURIComponent(name)] = decodeURIComponent(value.replace(/\+/g, " "));
  }
  return out;
}

// The two budgets are separate because what they bound is separate (§12: 上传长度、解压展开…
// 分别预留容量). A multipart upload carries a file, so it needs room a JSON body would never
// be given, and reading them under one number would mean either refusing every realistic HAR
// or holding JSON routes to a megabyte budget they have no reason to trust.
function bodyBudget(headers: Record<string, string | undefined>): number {
  return (headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data")
    ? MAX_UPLOAD_BODY_BYTES
    : MAX_REQUEST_BODY_BYTES;
}

// Bytes first, text as a view of them. The budget is counted while the stream arrives rather
// than after, and an overflow stops accumulating immediately - a caller that streams 4 GiB is
// cut off inside the budget (§11, §12).
function readBody(message: IncomingMessage, limit: number): Promise<{ text: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let overflow = false;
    message.on("data", (chunk: Buffer) => {
      if (overflow) return;
      received += chunk.byteLength;
      if (received > limit) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    const finish = (): void => {
      if (overflow) {
        resolve(null);
        return;
      }
      const joined = Buffer.concat(chunks);
      resolve({ text: joined.toString("utf8"), bytes: new Uint8Array(joined) });
    };
    message.on("end", finish);
    message.on("error", finish);
  });
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const server = createServer((request, response) => {
    void handle(options, request, response);
  });
  // One listen failure is a start failure: a web API that silently binds nowhere
  // would leave the operator staring at a pairing code with nothing to paste it into.
  server.on("error", (error: Error) => options.onError(error.message));
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen({ host: options.host, port: options.port, exclusive: true });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handle(options: WebServerOptions, message: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = message.url ?? "/";
  const path = url.split("?")[0] ?? url;
  const headers = headerMap(message);
  const body = await readBody(message, bodyBudget(headers));
  if (body === null) {
    // The handler never sees a body it could not have validated.
    response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { code: "RESOURCE_LIMIT", message: "request body exceeds the byte budget", details: { reason: "body-too-large" } } }));
    return;
  }
  const request: HttpRequest = {
    method: message.method ?? "GET",
    path,
    query: parseQuery(url),
    headers,
    body: body.text,
    bodyBytes: body.bytes,
  };
  const outcome = await options.handler(request);
  write(outcome, response);
}

// `HttpHeaders` is a pair list so a header can appear more than once (two
// `set-cookie` lines are two directives, not one overwritten value). `writeHead`
// takes a record, so the pairs are folded here without dropping a repeated name.
function foldHeaders(pairs: [string, string][]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of pairs) {
    const existing = out[name];
    if (existing === undefined) out[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[name] = [existing, value];
  }
  return out;
}

function write(outcome: ApiResponse, response: ServerResponse): void {
  if (outcome.kind === "response") {
    response.writeHead(outcome.status, foldHeaders(outcome.headers));
    response.end(outcome.body ?? "");
    return;
  }
  response.writeHead(outcome.status, foldHeaders(outcome.headers));
  response.flushHeaders();
  void pump(outcome, response);
}

async function pump(outcome: Extract<ApiResponse, { kind: "stream" }>, response: ServerResponse): Promise<void> {
  try {
    for (;;) {
      const frame = await outcome.pump.take();
      if (frame === null) break;
      response.write(frame);
    }
  } catch {
    // A broken stream is not a place to invent a status code; the client re-reads a
    // snapshot, which is what EVENT_CURSOR_EXPIRED already told it to do.
  } finally {
    outcome.pump.close();
    response.end();
  }
}

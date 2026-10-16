// The shapes the HTTP adapters speak. `apps/web` deliberately has no dependency on
// `node:http` in its core: a Next.js route handler (§3 lists Next.js for this module)
// and the loopback `node:http` server both convert their own request and response
// objects into these, and the API pipeline below never learns which one it is in.

export type HttpHeaders = [string, string][];

export type HttpRequest = {
  method: string;
  // The path only. The query string is parsed separately and never carried here,
  // because §14 forbids a token ever reaching a query, a referrer or a log line.
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: string;
};

export type EventPump = {
  // The next frame to write, or null when the stream is finished. The backlog the
  // cursor asked for is already decided and validated before the response opened, so
  // a 409 can still be a real status code rather than a broken stream.
  take: () => Promise<string | null>;
  close: () => void;
};

export type ApiResponse =
  | { kind: "response"; status: number; headers: HttpHeaders; body: string | null }
  | { kind: "stream"; status: number; headers: HttpHeaders; pump: EventPump };

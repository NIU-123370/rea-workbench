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
  // The same bytes before anything decoded them. `body` is what a JSON route parses, and
  // it round-trips for text; an upload does not. A multipart file part is arbitrary
  // bytes, and every byte sequence that is not valid UTF-8 would have been replaced on
  // the way through a string - so the route that accepts a file reads this field and
  // never the other (§8 line 272, §12: 先计量再分配).
  //
  // `ArrayBuffer`-backed rather than the default view type, because the platform's own
  // multipart reader takes a body whose buffer is an `ArrayBuffer`; a view over a Node
  // `Buffer` pool would be a type error at the one place that needs to hand bytes over.
  bodyBytes: Uint8Array<ArrayBuffer>;
};

export type EventPump = {
  // The next frame to write, or null when the stream is finished. The backlog the
  // cursor asked for is already decided and validated before the response opened, so
  // a 409 can still be a real status code rather than a broken stream.
  take: () => Promise<string | null>;
  close: () => void;
};

export type ApiResponse =
  // `Uint8Array` exists for one route: a download replies with the package bytes, which
  // must not be run through a UTF-8 string on the way out (§8).
  | { kind: "response"; status: number; headers: HttpHeaders; body: string | Uint8Array | null }
  | { kind: "stream"; status: number; headers: HttpHeaders; pump: EventPump };

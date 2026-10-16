import { relay } from "../../../lib/relay.ts";

// The Next route that carries the browser's own API calls to the local API
// (DESIGN §2 / §14, issue #18). This file exists because Next names a route by its
// directory; the decisions are in `app/lib/relay.ts`, which a test can import.

export const runtime = "nodejs";

export const GET = relay;
export const POST = relay;
export const DELETE = relay;

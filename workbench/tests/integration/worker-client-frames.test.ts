import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWorkerClient } from "../../apps/web/worker-client.ts";
import type { WorkerCaller } from "../../apps/web/worker-client.ts";
import { RPC_FRAME_DELIMITER } from "../../packages/contracts/rpc.ts";
import { asId } from "../../packages/domain/identity.ts";
import type { Actor } from "../../packages/application/actor.ts";

// What the client does with a frame it was handed (§12.1, §14 / issue #59).
//
// The worker filters at its own boundary, so in the normal case there is nothing to check
// here. This file therefore points the client at a socket that is *not* the worker: a peer
// that answers with a well-shaped refusal whose `details` contains a string, an array, an
// undeclared number and a declared number. The claim under test is the one a security
// boundary has to survive - "the sender said it filtered" is not evidence, and what this
// client forwards must be a declared name carrying a number it actually saw.

const actor: Actor = { actorId: "local-inspector", actorKind: "inspector" };

let root: string;
let socketPath: string;
// The peer answers whatever id it was asked about, because a reply is only usable by the
// request it matches. Tests that want a mismatched id say so by ignoring the parameter.
let replyFor: (id: number) => unknown = () => {
  throw new Error("no reply configured for this request");
};
let server: net.Server;
let client: WorkerCaller & { close: () => Promise<void> };

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rea-wb-frames-"));
  socketPath = path.join(root, "worker.rpc.sock");
  server = net.createServer((peer) => {
    peer.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8").trim()) as { id: number };
      peer.write(`${JSON.stringify(replyFor(request.id))}${RPC_FRAME_DELIMITER}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  client = createWorkerClient({ socketPath, dataDir: root });
});

afterAll(async () => {
  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function ask() {
  return client.call("graph.read", { projectId: asId("11111111-1111-4111-8111-111111111111") }, actor);
}

describe("the client does not trust what the socket sent in details", () => {
  it("forwards only the number and boolean values it was handed", async () => {
    replyFor = (id) => ({
      id,
      ok: false,
      error: {
        code: "RESOURCE_LIMIT",
        reason: "too-large",
        message: "over the cap",
        details: { limit: 200, retryable: false, internalRowId: 91, byteLength: 4096, path: "/tmp/private/har", reasons: ["a", "b"], nested: { limit: 1 } },
      },
    });
    const outcome = await ask();
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.error.code).toBe("RESOURCE_LIMIT");
    expect(outcome.error.details).toEqual({ limit: 200, retryable: false, byteLength: 4096 });
    // Two conditions, both checked on the receiving side: `internalRowId` is a number the peer
    // was free to offer and nobody declared safe, and a path or a list never travels whatever
    // its name. Neither goes further than this reader.
    expect(JSON.stringify(outcome.error)).not.toContain("/tmp/private/har");
    expect(JSON.stringify(outcome.error)).not.toContain("reasons");
    expect(JSON.stringify(outcome.error)).not.toContain("internalRowId");
  });

  it("still answers when details is absent, malformed or full of nothing safe", async () => {
    for (const details of [undefined, null, "not-an-object", ["x"], {}, { secrets: "s" }, { internalRowId: 7, harPath: 3 }]) {
      if (details === undefined) {
        // A frame missing `details` entirely is a contract violation, and the refusal it
        // produces must name that rather than pretending the worker said "nothing safe".
        replyFor = (id) => ({ id, ok: false, error: { code: "NOT_FOUND", reason: "job-unknown", message: "gone" } });
        const missing = await ask();
        if (missing.ok) throw new Error("a frame without details must not read as a refusal");
        expect(missing.error.reason).toBe("reply-shape-rejected");
        continue;
      }
      replyFor = (id) => ({ id, ok: false, error: { code: "NOT_FOUND", reason: "job-unknown", message: "gone", details } });
      const outcome = await ask();
      if (outcome.ok) throw new Error("expected a refusal");
      expect(outcome.error.details).toEqual({});
      expect(outcome.error.reason).toBe("job-unknown");
    }
  });

  it("refuses a frame whose reply id is not the request it answered", async () => {
    replyFor = () => ({ id: 99, ok: false, error: { code: "NOT_FOUND", reason: "job-unknown", message: "gone", details: {} } });
    const outcome = await ask();
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.error.reason).toBe("reply-id-mismatch");
  });
});

import { describe, expect, it } from "vitest";

import { createWorkerClient } from "../../apps/web/worker-client.ts";
import type { Actor } from "../../packages/application/actor.ts";

// The operator RPC channel is not a capability channel (DESIGN §14: an
// Inspector/evaluator capability is issued by the worker for named operations and
// cannot be exchanged for an operator session). So a client that is handed an actor
// kind outside the operator vocabulary must refuse before the frame is written — and
// without touching the socket, because reaching the worker is not what is being tested.

const DATA_DIR = "/tmp/rea-wb-absent-data-dir";

function client() {
  return createWorkerClient({
    socketPath: `${DATA_DIR}/worker.sock`,
    dataDir: DATA_DIR,
    timeoutMs: 50,
  });
}

describe("the worker RPC client's actor vocabulary", () => {
  it("refuses to send an evaluator actor over the operator channel", async () => {
    const evaluator: Actor = { actorId: "evaluator-one", actorKind: "evaluator" };
    const outcome = await client().call("verification.complete", {}, evaluator);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("ACCESS_DENIED");
    expect(outcome.error.reason).toBe("actor-kind-not-accepted-over-rpc");
  });

  it("still attempts the socket for an operator kind", async () => {
    // A real operator actor reaches the transport and fails there instead: the
    // refusal above is about the vocabulary, not a blanket block on the client.
    const inspector: Actor = { actorId: "local-operator", actorKind: "inspector" };
    const outcome = await client().call("project.list", {}, inspector);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.reason).not.toBe("actor-kind-not-accepted-over-rpc");
  });
});

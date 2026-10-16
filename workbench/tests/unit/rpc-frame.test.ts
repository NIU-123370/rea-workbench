import { describe, expect, it } from "vitest";

import { errorFrame } from "../../apps/worker/rpc-server.ts";
import { blockedByReasons, gateFail } from "../../packages/application/gate-failure.ts";

// The frame a refusal becomes on its way out of the worker process (DESIGN §12.1, §8's
// ApiError.details / issue #59).
//
// Two directions are provable here and nowhere else: the numbers an operator needs to act on
// survive the boundary, and the shapes that could carry a caller's own text or a holdout
// identifier do not. Both are checked against the *frame*, not against the filter function, so
// a change that moved the filtering to the far side of the socket would be caught.

describe("the RPC error frame's declared-safe details", () => {
  it("keeps the count of a gate's reasons and drops the list published beside it", () => {
    const failure = blockedByReasons(["blueprint-needs-contracts", "the-second-gap"], "BLUEPRINT_BLOCKED", "contract cart r1").error;
    const frame = errorFrame(7, failure);
    if (frame.ok) throw new Error("a gate failure must answer as a failure frame");
    expect(frame.error.details).toEqual({ reasonCount: 2 });
    // `blockedByReasons` names the refusal after its first gap, so that string legitimately
    // appears in `reason`; what must not cross the boundary is the **rest of the list** the
    // gate collected, which is why the second entry is the assertion below.
    expect(frame.error.reason).toBe("blueprint-needs-contracts");
    expect(JSON.stringify(frame)).not.toContain("the-second-gap");
    expect(frame.error.code).toBe("BLUEPRINT_BLOCKED");
  });

  it("keeps both sides of a revision conflict, because that is what makes a 409 actionable", () => {
    const frame = errorFrame(1, gateFail("REVISION_CONFLICT", "inventory-moved", "the inventory moved", { expected: 4, actual: 6 }).error);
    if (frame.ok) throw new Error("expected a failure frame");
    expect(frame.error.details).toEqual({ expected: 4, actual: 6 });
  });

  it("drops an undeclared key even when its value is only a number", () => {
    const frame = errorFrame(1, gateFail("RESOURCE_LIMIT", "too-much", "over budget", { limit: 200, internalRowId: 91 }).error);
    if (frame.ok) throw new Error("expected a failure frame");
    expect(frame.error.details).toEqual({ limit: 200 });
  });

  it("drops a declared key whose value arrived as text", () => {
    // The list of allowed names and the type rule are two conditions on purpose: `caseKey` and
    // `state` are ordinary-looking names whose values are whatever a caller or a provider said.
    const frame = errorFrame(1, gateFail("INVALID_INPUT", "bad-case", "no such case", { caseKey: "cart-add", seq: "12" }).error);
    if (frame.ok) throw new Error("expected a failure frame");
    expect(frame.error.details).toEqual({});
  });

  it("keeps a number that is itself a credential inside the process", () => {
    // The shape a type-only rule would let through: `portCode` is the digits a terminal mints
    // for pairing, and it is a number. Nothing about the value marks it as secret, so the only
    // thing standing between it and the browser is that nobody declared the name.
    const frame = errorFrame(1, gateFail("ACCESS_DENIED", "pairing-code-spent", "that pairing code is spent", { portCode: 4821, attemptsLeft: 2 }).error);
    if (frame.ok) throw new Error("expected a failure frame");
    expect(frame.error.details).toEqual({});
    expect(JSON.stringify(frame)).not.toContain("4821");
  });

  it("sends an empty details object rather than omitting the field", () => {
    const frame = errorFrame(1, gateFail("NOT_FOUND", "job-unknown", "job not found").error);
    if (frame.ok) throw new Error("expected a failure frame");
    expect(frame.error.details).toEqual({});
  });
});

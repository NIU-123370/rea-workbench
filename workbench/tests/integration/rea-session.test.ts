import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { connectReaStdio } from "../../packages/adapters/rea/protocol.ts";
import { probeReaIdentity } from "../../packages/adapters/rea/identity.ts";
import { ReaSession } from "../../packages/adapters/rea/session.ts";
import type { RpcPeer } from "../../packages/adapters/rea/protocol.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = path.join(ROOT, "tests/fixtures/rea-mcp-fixture.mjs");
const EXPECT = { packageVersion: "6.4.0", catalogDigest: "a".repeat(64) };

const open: RpcPeer[] = [];

function connect(testCase: string): RpcPeer {
  // The child gets exactly this one variable: nothing from the host environment
  // leaks into an analysis process by default (§12, D21).
  const connected = connectReaStdio(process.execPath, [FIXTURE], {
    timeoutMs: 8_000,
    env: { FIXTURE_CASE: testCase },
  });
  if (!connected.ok) throw new Error(JSON.stringify(connected.error));
  open.push(connected.value);
  return connected.value;
}

function sessionFor(testCase: string): ReaSession {
  const connected = connect(testCase);
  return new ReaSession(connected);
}

async function probe(testCase: string, sensitiveValues: { declaredValues: readonly string[] } | null) {
  return probeReaIdentity(connect(testCase), { ...EXPECT, sensitiveValues });
}

afterAll(async () => {
  await Promise.all(open.map((peer) => peer.close()));
});

describe("identity probe against a fixture MCP server (DESIGN §1, §9)", () => {
  it("accepts an aligned connection and reports the advertised names", async () => {
    const result = await probe("ok", null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packageVersion).toBe("6.4.0");
    expect(result.value.alignmentState).toBe("aligned");
    expect(result.value.protocolVersion).toBe("2025-06-18");
    expect(result.value.tools.map((tool) => tool.name)).toContain("import_evidence_bundle");
  });

  it("selects operations by name, not by catalog position", async () => {
    const ordered = await probe("ok", null);
    const shuffled = await probe("shuffle", null);
    expect(ordered.ok && shuffled.ok).toBe(true);
    if (!ordered.ok || !shuffled.ok) return;
    expect(shuffled.value.tools.map((tool) => tool.name).sort()).toEqual(
      ordered.value.tools.map((tool) => tool.name).sort(),
    );
  });

  it("refuses a version that is not the pinned baseline", async () => {
    const result = await probe("version_drift", null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REA_CONTRACT_MISMATCH");
    expect(result.error.reasons).toContain("package_version_mismatch");
  });

  it("refuses a catalog missing a tool it needs", async () => {
    const result = await probe("missing_tool", null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reasons).toContain("missing_tool:import_evidence_bundle");
  });

  it("refuses advertised schemas that dropped required inputs", async () => {
    const result = await probe("no_required", null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // One reason per offending field, each naming the tool and the schema path
    // (issue #14): a refusal that only said "drift" would not be actionable.
    expect(result.error.reasons).toContain(
      "schema_drift:required_unadvertised:inspect_web_network_capture:input.capture_path",
    );
    expect(result.error.reasons).toContain(
      "schema_drift:required_unadvertised:inspect_web_network_capture:input.format",
    );
    expect(result.error.reasons).toContain(
      "schema_drift:required_unadvertised:export_evidence_bundle:input.path",
    );
  });

  it("does not carry provider reason text out without a declaration context", async () => {
    const without = await probe("ok", null);
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(without.value.alignmentReasons).toEqual([]);
    expect(without.value.withheldReasonCount).toBe(1);

    const withDeclaration = await probe("ok", { declaredValues: ["hunter2-fixture"] });
    expect(withDeclaration.ok).toBe(true);
    if (!withDeclaration.ok) return;
    expect(withDeclaration.value.withheldReasonCount).toBe(0);
    expect(withDeclaration.value.alignmentReasons.join("")).not.toContain("hunter2-fixture");
  });
});

describe("session ownership and the Evidence ledger (DESIGN §9)", () => {
  it("tracks retained Evidence and refuses to close before it is persisted", async () => {
    const session = sessionFor("ok");
    const called = await session.callTool("inspect_web_network_capture", {
      capture_path: "/fixture/session.har",
      format: "har",
    });
    expect(called.ok).toBe(true);
    if (!called.ok) return;
    expect(called.value.kind).toBe("evidence");
    const id = `ev_${"a".repeat(64)}`;
    expect(session.pendingPersistence).toEqual([id]);

    const refused = await session.closeBinary({});
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("EVIDENCE_UNPERSISTED");

    session.markPersisted(id);
    const closed = await session.closeBinary({});
    expect(closed.ok).toBe(true);
    expect([...session.retained]).toEqual([]);
    expect(session.pendingPersistence).toEqual([]);
    await session.close();
  });

  it("keeps a retained partial observation from a failed call", async () => {
    const session = sessionFor("ok");
    const result = await session.callTool("probe_big", {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.kind !== "error") throw new Error("expected an error outcome");
    expect(result.value.error.code).toBe("resource_constraint");
    expect(result.value.retainedEvidenceId).toBe(`ev_${"b".repeat(64)}`);
    expect(session.pendingPersistence).toEqual([`ev_${"b".repeat(64)}`]);
    await session.close();
  });

  it("preserves typed codes on a failure reply", async () => {
    const session = sessionFor("ok");
    const result = await session.callTool("probe_error", {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.kind !== "error") throw new Error("expected error outcome");
    expect(result.value.error.code).toBe("unsupported_target");
    expect(result.value.error.retryable).toBe(false);
    expect(result.value.error.remediation.action).toBe("pick another");
    await session.close();
  });

  it("never lets two calls touch the same connection at once", async () => {
    const session = sessionFor("ok");
    const three = await Promise.all([
      session.callTool("probe_serial", {}),
      session.callTool("probe_serial", {}),
      session.callTool("probe_serial", {}),
    ]);
    for (const result of three) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      if (result.value.kind !== "value") throw new Error("expected a value outcome");
      const peak = (result.value.value as { result: { peak: number } }).result.peak;
      expect(peak).toBe(1);
    }
    await session.close();
  });

  it("refuses to reuse a closed connection", async () => {
    const session = sessionFor("ok");
    await session.close();
    const after = await session.callTool("probe_serial", {});
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.error.code).toBe("MCP_TRANSPORT_CLOSED");
  });

  it("actually terminates the child process on close", async () => {
    const peer = connect("ok");
    expect(peer.hasExited).toBe(false);
    await peer.close();
    expect(peer.hasExited).toBe(true);
    await peer.close();
    expect(peer.hasExited).toBe(true);
  });

});

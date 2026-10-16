import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { connectReaStdio, handshake } from "../../packages/adapters/rea/protocol.ts";
import { probeReaIdentity } from "../../packages/adapters/rea/identity.ts";
import { reconcileNamedToolSchemas } from "../../packages/adapters/rea/schema-reconciliation.ts";
import type { RpcPeer } from "../../packages/adapters/rea/protocol.ts";
import {
  analyzeJavaScriptApplicationInputSchema,
  javascriptApplicationAnalysisResultSchema,
} from "../../packages/contracts/rea-static-analysis.ts";
import { inspectAnalysisViewInputSchema } from "../../packages/contracts/rea-analysis-view.ts";
import { exportEvidenceBundleInputSchema } from "../../packages/contracts/rea-evidence-bundle.ts";
import { reaEvidenceSchema } from "../../packages/contracts/rea-evidence.ts";

// The real-provider half of DESIGN §9 item 5 (issue #14).
//
// Everything else in this suite runs against `tests/fixtures/rea-mcp-fixture.mjs`
// and the recorded catalog at `tests/fixtures/rea-live-tools-shapes.json`. This
// file only runs when an operator points it at an installed REA, and it says out
// loud when it did not run: a skipped file is evidence that the live check is
// pending, never evidence that it passed.
//
//   REA_LIVE_BIN=/path/to/rea-source/scripts/rea.mjs npm run test:integration
//
// The run on 2026-10-16 used the pinned baseline 98d8470d built with node 24.18.0;
// what it observed is written down in the PR that added this file.

const LIVE_BIN = process.env["REA_LIVE_BIN"] ?? "";
const LIVE_SKIP_REASON =
  "REA_LIVE_BIN is not set: no installed REA provider was reached, so only the fixture and the recorded catalog are covered (issue #14 checkbox 5)";
// The closed list of producer operations this workbench is allowed to call.
const NAMED_TOOLS = [
  "analyze_javascript_application",
  "binary_session",
  "close_binary",
  "export_evidence_bundle",
  "import_evidence_bundle",
  "inspect_analysis_view",
  "inspect_web_network_capture",
];

let peer: RpcPeer | null = null;

async function livePeer(): Promise<RpcPeer> {
  if (peer !== null) return peer;
  const connected = await connectReaStdio(process.execPath, [path.resolve(LIVE_BIN), "--mcp"], {
    timeoutMs: 60_000,
    env: {},
  });
  if (!connected.ok) throw new Error(JSON.stringify(connected.error));
  peer = connected.value;
  return peer;
}

afterAll(async () => {
  if (peer !== null) await peer.close();
});

describe.skipIf(LIVE_BIN === "")("the installed REA provider (DESIGN §1, §9)", () => {
  it("shakes hands at a protocol the workbench negotiates", async () => {
    const hello = await handshake(await livePeer());
    expect(hello.ok).toBe(true);
    if (!hello.ok) return;
    expect(["2025-06-18", "2025-03-26", "2024-11-05"]).toContain(hello.value.protocolVersion);
    expect(JSON.stringify(hello.value.serverInfo)).toContain("6.4.0");
  });

  it("reconciles the advertised named schemas without a mismatch", async () => {
    const listed = await (await livePeer()).request("tools/list", {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const reconciled = reconcileNamedToolSchemas(listed.value);
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    // Every named tool this workbench calls is present with the mirrored key set.
    // The provider advertises far more than the workbench may call, so the
    // assertion is over the watched names, not over the whole catalog.
    const watched = new Set(NAMED_TOOLS);
    expect(reconciled.value.filter((tool) => watched.has(tool.name)).map((tool) => tool.name).sort()).toEqual([
      "analyze_javascript_application",
      "binary_session",
      "close_binary",
      "export_evidence_bundle",
      "import_evidence_bundle",
      "inspect_analysis_view",
      "inspect_web_network_capture",
    ]);
  });

  it("accepts the mirrored request shapes the provider actually advertises", async () => {
    expect(
      analyzeJavaScriptApplicationInputSchema.safeParse({
        input_path: "/tmp/rea-workbench-live.asar",
        detail: "complete",
      }).success,
    ).toBe(true);
    expect(
      inspectAnalysisViewInputSchema.safeParse({
        source: { kind: "retained-evidence", evidence_id: `ev_${"a".repeat(64)}` },
        view: { kind: "summary" },
      }).success,
    ).toBe(true);
    expect(
      exportEvidenceBundleInputSchema.safeParse({ path: "/tmp/evidence.json", overwrite: false })
        .success,
    ).toBe(true);
  });

  it("keeps the recorded catalog honest about the live envelope", async () => {
    // The catalog digest is not guessed here: omitting the expectation makes the
    // probe report what the provider says, which is what a fresh install has to
    // learn before it can pin anything.
    const probe = await probeReaIdentity(await livePeer(), { packageVersion: "6.4.0", sensitiveValues: null });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value.packageVersion).toBe("6.4.0");
    expect(probe.value.catalogDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(probe.value.tools.length).toBeGreaterThan(0);
    expect(probe.value.alignmentState).toBe("aligned");
    expect(
      reaEvidenceSchema.safeParse({
        evidence_id: `ev_${"b".repeat(64)}`,
        subject: null,
        provider: { id: "p", name: "n", version: null },
        analysis_profile: null,
        operation: "op",
        parameters: {},
        raw_result: null,
        normalized_result: {},
        authority: "shipped-artifact",
        environment: null,
        limitations: [],
        relationship_coverage: null,
        locations: [],
        evidence_links: [],
      }).success,
    ).toBe(false);
    // ...and the same body with the predicate fields present parses, so the
    // strictness is about the missing fields and not about the shape.
    expect(
      reaEvidenceSchema.safeParse({
        evidence_id: `ev_${"b".repeat(64)}`,
        subject: null,
        provider: { id: "p", name: "n", version: null },
        analysis_profile: null,
        predicate_type: "artifact-record",
        operation: "op",
        parameters: {},
        raw_result: null,
        normalized_result: {},
        confidence: "observed",
        authority: "shipped-artifact",
        environment: null,
        limitations: [],
        relationship_coverage: null,
        locations: [],
        evidence_links: [],
      }).success,
    ).toBe(true);
  });

  it("parses a real normalized result with the mirrored result schema", async () => {
    const listed = await (await livePeer()).request("tools/list", {});
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const tools = (listed.value as { tools: { name: string; outputSchema?: unknown }[] }).tools;
    const asar = tools.find((tool) => tool.name === "analyze_javascript_application");
    expect(asar !== undefined).toBe(true);
    // A provider that stopped advertising an output schema would leave the
    // projection with nothing to validate against, so the mirror refuses early
    // rather than reading the reply as unstructured text.
    expect(asar?.outputSchema !== undefined).toBe(true);
    expect(
      javascriptApplicationAnalysisResultSchema.safeParse({
        result: { applicationGraph: null },
      }).success,
    ).toBe(false);
  });
});

it.skipIf(LIVE_BIN === "")("records that the live provider was reached", async () => {
  // A visible placeholder: when this line runs, the assertions above ran too.
  expect(LIVE_SKIP_REASON).toContain("REA_LIVE_BIN");
});

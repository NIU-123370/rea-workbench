import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { reconcileNamedToolSchemas } from "../../packages/adapters/rea/schema-reconciliation.ts";
import { NAMED_TOOL_NAMES } from "../../packages/contracts/rea-advertised-shapes.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";

// The field-level half of the named-schema gate (DESIGN §9 item 2, issue #14).
//
// `tests/integration/rea-session.test.ts` drives the fixture server and proves the
// `required_unadvertised` direction. These cases pin the other three directions —
// a property the mirror declares that the provider no longer advertises, a field
// the provider requires that the mirror does not, and a schema that stopped being
// closed — because a gate that only catches one of four drifts is a gate that
// silently passes three.
//
// The observed side here is the recorded live catalog (provenance inside the
// fixture), so the assertions are about real advertised shapes rather than
// hand-written ones.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RECORDED = JSON.parse(
  readFileSync(path.join(ROOT, "tests/fixtures/rea-live-tools-shapes.json"), "utf8"),
) as { tools: Record<string, JsonValue>[] };

function listReply(mutate?: (tool: Record<string, JsonValue>) => void): JsonValue {
  const tools = RECORDED.tools.map((tool) => structuredClone(tool));
  if (mutate !== undefined) {
    const target = tools.find((tool) => tool["name"] === "inspect_web_network_capture");
    if (target === undefined) throw new Error("the recorded catalog lost the capture tool");
    mutate(target);
  }
  return { tools };
}

function inputOf(tool: Record<string, JsonValue>): Record<string, JsonValue> {
  const schema = tool["inputSchema"] as Record<string, JsonValue>;
  return schema as Record<string, JsonValue>;
}

function propertiesOf(tool: Record<string, JsonValue>): Record<string, JsonValue> {
  const schema = inputOf(tool);
  const properties = schema["properties"];
  if (properties === undefined || typeof properties !== "object") {
    throw new Error("the recorded tool has no properties");
  }
  return properties as Record<string, JsonValue>;
}

describe("named schema reconciliation reads both directions (§9 item 2)", () => {
  it("accepts the recorded live catalog as advertised", () => {
    const reconciled = reconcileNamedToolSchemas(listReply());
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    expect(reconciled.value.length).toBeGreaterThanOrEqual(NAMED_TOOL_NAMES.length);
  });

  it("refuses a provider that stopped advertising a mirrored property", () => {
    const reconciled = reconcileNamedToolSchemas(
      listReply((tool) => {
        delete propertiesOf(tool)["capture_path"];
      }),
    );
    expect(reconciled.ok).toBe(false);
    if (reconciled.ok) return;
    expect(reconciled.error.reasons).toContain(
      "schema_drift:property_unadvertised:inspect_web_network_capture:input.capture_path",
    );
  });

  it("refuses a provider that requires a field the mirror does not declare", () => {
    const reconciled = reconcileNamedToolSchemas(
      listReply((tool) => {
        const schema = inputOf(tool);
        const required = schema["required"];
        if (!Array.isArray(required)) throw new Error("the recorded tool has no required list");
        required.push("record_labels");
      }),
    );
    expect(reconciled.ok).toBe(false);
    if (reconciled.ok) return;
    expect(reconciled.error.reasons).toContain(
      "schema_drift:required_unmirrored:inspect_web_network_capture:input.record_labels",
    );
  });

  it("refuses a schema that is no longer closed", () => {
    // additionalProperties must be exactly false. A provider that answers with an
    // open object would let a field the mirror never heard of through, which is
    // what §4 forbids for an envelope this workbench persists verbatim.
    const reconciled = reconcileNamedToolSchemas(
      listReply((tool) => {
        inputOf(tool)["additionalProperties"] = true;
      }),
    );
    expect(reconciled.ok).toBe(false);
    if (reconciled.ok) return;
    expect(reconciled.error.reasons).toContain(
      "schema_drift:open_content:inspect_web_network_capture:input.additionalProperties",
    );

    const omitted = reconcileNamedToolSchemas(
      listReply((tool) => {
        delete inputOf(tool)["additionalProperties"];
      }),
    );
    expect(omitted.ok).toBe(false);
    if (omitted.ok) return;
    expect(omitted.error.reasons).toContain(
      "schema_drift:open_content:inspect_web_network_capture:input.additionalProperties",
    );
  });

  it("refuses a mirrored property the provider advertises under a new name only", () => {
    const reconciled = reconcileNamedToolSchemas(
      listReply((tool) => {
        propertiesOf(tool)["capture_prefix"] = { type: "string" };
      }),
    );
    expect(reconciled.ok).toBe(false);
    if (reconciled.ok) return;
    expect(reconciled.error.reasons).toContain(
      "schema_drift:property_unmirrored:inspect_web_network_capture:input.capture_prefix",
    );
  });

  it("says nothing about a tool the mirror does not describe", () => {
    // A provider may advertise 173 operations; the gate only owns the named ones,
    // so an unrelated extra tool must not read as drift.
    const withExtra = listReply();
    const tools = (withExtra as { tools: Record<string, JsonValue>[] }).tools;
    tools.push({ name: "capture_adb_screen", inputSchema: { type: "object" } });
    expect(reconcileNamedToolSchemas(withExtra).ok).toBe(true);
  });

  it("refuses a null or unusable list reply instead of trusting an empty catalog", () => {
    expect(reconcileNamedToolSchemas(null).ok).toBe(false);
    expect(reconcileNamedToolSchemas({ tools: [] }).ok).toBe(false);
    const mismatch = reconcileNamedToolSchemas({ tools: [] });
    if (mismatch.ok) throw new Error("an empty catalog must not reconcile");
    expect(mismatch.error.reasons.some((reason) => reason.startsWith("missing_tool:"))).toBe(true);
  });
});

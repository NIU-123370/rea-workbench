import type { JsonValue } from "../../domain/json-value.ts";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { NAMED_TOOL_NAMES, NAMED_TOOL_SHAPES } from "../../contracts/rea-advertised-shapes.ts";
import type { AdvertisedShapeNode } from "../../contracts/rea-advertised-shapes.ts";

// DESIGN §1 and §9 item 2: at connect time the adapter verifies the *actual*
// identity and the advertised named schemas before anything the connection says
// is trusted. This file is the single owner of that comparison.
//
//     expected side  =  `contracts/rea-advertised-shapes.ts`, projected out of
//                       the strict mirrors themselves
//     observed side  =  the `tools/list` reply this very connection returned
//
// Neither side is transcribed. `identity.ts` used to keep a hand-copied
// `REQUIRED_TOOLS` table as the expected side and it had already fallen behind
// the mirrors it was supposed to summarise — it recorded
// `analyze_javascript_application` as requiring nothing while the provider
// requires `input_path`, and it never named `detail` at all, which is the field
// the pinned provider advertises and the old mirror refused.
//
// What is compared, per named tool, at each declared node:
//   * the `properties` key set, in both directions
//   * the `required` set, in both directions
//   * `additionalProperties` being exactly `false`
// For an Evidence-producing tool the output node IS the envelope, so this is
// where the 16-field `required` list is checked against what the provider says it
// emits.
//
// What is deliberately NOT compared, so this file never claims more than it
// proves: leaf constraints (minLength, patterns, numeric bounds, enum members)
// and any node reached through a union. Upstream's `isAbsolute` refinements do
// not survive JSON Schema conversion at all, so treating advertised constraints
// as authority would produce false mismatches against a provider that is in fact
// correct. Field ORDER is not compared either — the same rule §9 item 2 states
// for catalog order: order carries no identity.
//
// A refusal names a tool and a schema path and never echoes a value. Every
// reason is `schema_drift:<kind>:<tool>:<field-path>`; both halves are contract
// vocabulary, neither is data (DESIGN §12.1).

export type AdvertisedTool = { name: string; required: readonly string[] };

export type CatalogMismatch = { code: "REA_CONTRACT_MISMATCH"; reasons: readonly string[] };

type ObjectShape = {
  readonly properties: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
  readonly openContent: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

// The advertised documents are `$ref`-ed against a sibling `$defs` map: the
// provider compacts repeated sub-schemas, so a node is often only
// `{ "$ref": "#/$defs/__schema7" }`. Following a reference is not a guess — the
// root document always carries its own `$defs`, which is why the root is kept
// while the walk descends. The hop bound exists so a self-referential definition
// fails the gate instead of hanging the connection.
function resolveNode(root: Record<string, unknown>, node: unknown): Record<string, unknown> | null {
  let current = node;
  for (let hop = 0; hop < 16; hop += 1) {
    if (!isRecord(current)) return null;
    const ref = current["$ref"];
    if (typeof ref !== "string" || !ref.startsWith("#/")) return current;
    const segments = ref.slice(2).split("/");
    let target: unknown = root;
    for (const segment of segments) {
      if (!isRecord(target)) return null;
      target = target[segment];
    }
    current = target;
  }
  return null;
}

// Walk `properties` down to `steps`, resolving references at every step. A node
// that turns out to be a union, or that is not an object, is reported rather than
// guessed at: this file never picks a union member on the caller's behalf.
function advertisedObject(
  root: Record<string, unknown>,
  steps: readonly string[],
): Result<Record<string, unknown>, "unresolvable" | "not-an-object"> {
  let current: unknown = root;
  for (const step of steps) {
    const resolved = resolveNode(root, current);
    if (resolved === null) return err("unresolvable");
    const properties = resolved["properties"];
    if (!isRecord(properties)) return err("unresolvable");
    current = properties[step];
    if (current === undefined) return err("unresolvable");
  }
  const final = resolveNode(root, current);
  if (final === null) return err("unresolvable");
  if (final["type"] !== "object" || !isRecord(final["properties"])) return err("not-an-object");
  return ok(final);
}

function shapeOf(node: Record<string, unknown>): ObjectShape {
  const properties = node["properties"];
  const required = stringArray(node["required"]) ?? [];
  return {
    properties: isRecord(properties) ? new Set(Object.keys(properties)) : new Set(),
    required: new Set(required),
    openContent: node["additionalProperties"] !== false,
  };
}

// `["input"]` and `["output"]` select which advertised document to read; the
// rest of the path walks inside it.
function documentOf(tool: Record<string, unknown>, node: AdvertisedShapeNode): Record<string, unknown> | null {
  const document = tool[node.dialect === "input" ? "inputSchema" : "outputSchema"];
  return isRecord(document) ? document : null;
}

function label(kind: string, node: AdvertisedShapeNode, field: string | null): string {
  const path = field === null ? node.path.join(".") : `${node.path.join(".")}.${field}`;
  return `schema_drift:${kind}:${node.tool}:${path}`;
}

function compareNode(tool: Record<string, unknown>, node: AdvertisedShapeNode): string[] {
  const document = documentOf(tool, node);
  if (document === null) return [label("document_absent", node, null)];
  const advertised = advertisedObject(document, node.path.slice(1));
  if (!advertised.ok) {
    // Either the path is not there, or it is a union this file refuses to choose
    // a member of. Naming the path is the honest report.
    return [label(advertised.error === "not-an-object" ? "node_not_an_object" : "node_unresolvable", node, null)];
  }
  const observed = shapeOf(advertised.value);
  const expected = {
    properties: new Set(node.properties),
    required: new Set(node.required),
  };
  const reasons: string[] = [];
  for (const field of expected.properties) {
    if (!observed.properties.has(field)) reasons.push(label("property_unadvertised", node, field));
  }
  for (const field of observed.properties) {
    if (!expected.properties.has(field)) reasons.push(label("property_unmirrored", node, field));
  }
  for (const field of expected.required) {
    if (!observed.required.has(field)) reasons.push(label("required_unadvertised", node, field));
  }
  for (const field of observed.required) {
    if (!expected.required.has(field)) reasons.push(label("required_unmirrored", node, field));
  }
  if (observed.openContent) reasons.push(label("open_content", node, "additionalProperties"));
  return reasons;
}

// One read of the catalog, one owner of the `name -> advertised tool` map.
export function advertisedTools(listResult: JsonValue | null): {
  tools: AdvertisedTool[];
  documents: Map<string, Record<string, unknown>>;
} {
  const root = isRecord(listResult) ? listResult : null;
  const entries = Array.isArray(root?.["tools"]) ? (root["tools"] as unknown[]) : [];
  const tools: AdvertisedTool[] = [];
  const documents = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const tool = isRecord(entry) ? entry : null;
    if (tool === null) continue;
    const name = typeof tool["name"] === "string" ? tool["name"] : null;
    if (name === null) continue;
    const inputSchema = isRecord(tool["inputSchema"]) ? (tool["inputSchema"] as Record<string, unknown>) : null;
    tools.push({ name, required: stringArray(inputSchema?.["required"]) ?? [] });
    documents.set(name, tool);
  }
  return { tools, documents };
}

// The gate itself. `listResult` is the raw `tools/list` reply, i.e. the same call
// `probeReaIdentity` already makes, so a connection is never described by two
// catalog reads.
export function reconcileNamedToolSchemas(listResult: JsonValue | null): Result<AdvertisedTool[], CatalogMismatch> {
  const { tools, documents } = advertisedTools(listResult);
  const reasons: string[] = [];
  const checked = new Set<string>();
  for (const node of NAMED_TOOL_SHAPES) {
    checked.add(node.tool);
    const document = documents.get(node.tool);
    if (document === undefined) {
      // Kept in `identity.ts`'s existing spelling so a missing operation reads
      // the same however it was discovered.
      reasons.push(`missing_tool:${node.tool}`);
      continue;
    }
    reasons.push(...compareNode(document, node));
  }
  // A named operation with no node at all would sail through the loop above, so
  // the name set is reconciled independently of the node set.
  for (const name of NAMED_TOOL_NAMES) {
    if (!checked.has(name)) reasons.push(`unshaped_named_tool:${name}`);
  }
  return reasons.length > 0
    ? err({ code: "REA_CONTRACT_MISMATCH", reasons: [...new Set(reasons)].sort() })
    : ok(tools);
}

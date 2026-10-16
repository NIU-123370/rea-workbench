import type { JsonValue } from "../../domain/json-value.ts";
import type { Result } from "../../domain/result.ts";
import { redactText } from "../../application/sanitizer.ts";
import type { SensitiveDeclaration } from "../../application/sanitizer.ts";
import { handshake } from "./protocol.ts";
import { decodeToolResult } from "./envelope.ts";
import type { RpcPeer } from "./protocol.ts";

// DESIGN §1/§9: verify the *actual* identity and the advertised named schemas
// before trusting anything the connection says. Operations are selected by tool
// name only — the catalog array order is never a semantic identifier, and a
// server that reorders its catalog must not change our behaviour.

export const REQUIRED_TOOLS: Record<string, readonly string[]> = {
  binary_session: [],
  inspect_web_network_capture: ["capture_path", "format"],
  get_evidence_bundle: [],
  export_evidence_bundle: ["path"],
  import_evidence_bundle: ["path"],
  close_binary: [],
  // The field list for the ASAR entry point is not re-derived here; it is
  // checked against the advertised schema when S16 wires that branch.
  analyze_javascript_application: [],
};

export type ProbeFailure = { code: "REA_CONTRACT_MISMATCH"; reasons: readonly string[] };

export type AdvertisedTool = { name: string; required: readonly string[] };

export type ReaIdentity = {
  protocolVersion: string;
  packageVersion: string;
  catalogDigest: string | null;
  alignmentState: string;
  // §12.1: a provider's reason strings are raw upstream text. They are only
  // carried out after the declared-value check; with no declaration context the
  // adapter reports a count instead, which is enough to act on.
  alignmentReasons: readonly string[];
  withheldReasonCount: number;
  tools: readonly AdvertisedTool[];
};

function asRecord(value: JsonValue | null): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" ? value : null;
}

function nested(source: Record<string, unknown> | null, ...path: string[]): Record<string, unknown> | null {
  let current = source;
  for (const key of path) {
    if (current === null) return null;
    const next = current[key];
    current = typeof next === "object" && next !== null && !Array.isArray(next) ? (next as Record<string, unknown>) : null;
  }
  return current;
}

function resultOf(reply: JsonValue | null): Record<string, unknown> | null {
  // Session-kind tools wrap their payload in { result: ... } (DESIGN §9 item 3).
  const root = asRecord(reply);
  return nested(root, "result") ?? root;
}

function advertisedTools(list: JsonValue | null): AdvertisedTool[] {
  const root = asRecord(list);
  const tools = root?.["tools"];
  if (!Array.isArray(tools)) return [];
  const out: AdvertisedTool[] = [];
  for (const entry of tools) {
    const tool = asRecord(entry);
    const name = stringOf(tool, "name");
    if (name === null) continue;
    const inputSchema = nested(tool ?? {}, "inputSchema");
    const required = Array.isArray(inputSchema?.["required"])
      ? (inputSchema["required"] as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
    out.push({ name, required });
  }
  return out;
}

export async function probeReaIdentity(
  peer: RpcPeer,
  expectations: {
    readonly packageVersion: string;
    readonly catalogDigest?: string;
    readonly sensitiveValues: SensitiveDeclaration | null;
  },
): Promise<Result<ReaIdentity, ProbeFailure>> {
  const hello = await handshake(peer);
  if (!hello.ok) return { ok: false, error: { code: "REA_CONTRACT_MISMATCH", reasons: [hello.error.code] } };

  const session = await peer.request("tools/call", {
    name: "binary_session",
    arguments: { expected_package_version: expectations.packageVersion },
  });
  if (!session.ok) return { ok: false, error: { code: "REA_CONTRACT_MISMATCH", reasons: ["binary_session_failed"] } };
  // One decoder for every reply shape; reading the transport envelope twice
  // would leave two owners disagreeing about what a reply contains.
  const decoded = decodeToolResult(session.value);
  if (!decoded.ok) return { ok: false, error: { code: "REA_CONTRACT_MISMATCH", reasons: [decoded.error.reason] } };
  if (decoded.value.kind === "error") {
    return { ok: false, error: { code: "REA_CONTRACT_MISMATCH", reasons: [`binary_session_${decoded.value.error.code}`] } };
  }
  if (decoded.value.kind !== "value") {
    return { ok: false, error: { code: "REA_CONTRACT_MISMATCH", reasons: ["binary_session_shape"] } };
  }
  const identity = resultOf(decoded.value.value);
  if (identity === null) return { ok: false, error: { code: "REA_CONTRACT_MISMATCH", reasons: ["binary_session_shape"] } };

  const packageVersion = stringOf(nested(identity, "server_identity", "package"), "version");
  const catalogDigest = stringOf(nested(identity, "server_identity", "catalog", "digests"), "combined_sha256");
  const alignment = nested(identity, "server_identity", "alignment");
  const alignmentState = stringOf(alignment, "state") ?? "unknown";
  const rawReasons = Array.isArray(alignment?.["reasons"])
    ? (alignment["reasons"] as unknown[]).filter((item): item is string => typeof item === "string")
    : [];

  const listed = await peer.request("tools/list", {});
  if (!listed.ok) return { ok: false, error: { code: "REA_CONTRACT_MISMATCH", reasons: ["tools_list_failed"] } };
  const tools = advertisedTools(listed.value);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const reasons: string[] = [];
  if (packageVersion !== expectations.packageVersion) {
    reasons.push("package_version_mismatch");
  }
  if (expectations.catalogDigest !== undefined && catalogDigest !== expectations.catalogDigest) {
    reasons.push("catalog_digest_mismatch");
  }
  if (alignmentState !== "aligned") reasons.push(`alignment_${alignmentState}`);
  for (const [name, required] of Object.entries(REQUIRED_TOOLS)) {
    const advertised = byName.get(name);
    if (advertised === undefined) {
      reasons.push(`missing_tool:${name}`);
      continue;
    }
    const missing = required.filter((field) => !advertised.required.includes(field));
    if (missing.length > 0) reasons.push(`schema_drift:${name}:${missing.join("+")}`);
  }

  // Catalog order is not an identity: the same names in a different order must
  // produce the same verdict, which is why every lookup above goes through
  // `byName`.
  const declared = expectations.sensitiveValues;
  const cleaned =
    declared === null
      ? []
      : rawReasons.map((reason) => redactText(reason, declared).text).filter((reason) => reason.length > 0);

  if (reasons.length > 0) {
    return { ok: false, error: { code: "REA_CONTRACT_MISMATCH", reasons: [...new Set(reasons)] } };
  }

  return {
    ok: true,
    value: {
      protocolVersion: hello.value.protocolVersion,
      packageVersion: packageVersion ?? "unknown",
      catalogDigest,
      alignmentState,
      alignmentReasons: cleaned,
      withheldReasonCount: declared === null ? rawReasons.length : rawReasons.length - cleaned.length,
      tools,
    },
  };
}

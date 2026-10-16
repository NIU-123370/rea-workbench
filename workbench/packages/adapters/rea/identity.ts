import type { JsonValue } from "../../domain/json-value.ts";
import type { Result } from "../../domain/result.ts";
import { redactText } from "../../application/sanitizer.ts";
import type { SensitiveDeclaration } from "../../application/sanitizer.ts";
import { handshake } from "./protocol.ts";
import { decodeToolResult } from "./envelope.ts";
import { reconcileNamedToolSchemas } from "./schema-reconciliation.ts";
import type { RpcPeer } from "./protocol.ts";
import type { AdvertisedTool } from "./schema-reconciliation.ts";

// DESIGN §1/§9: verify the *actual* identity and the advertised named schemas
// before trusting anything the connection says. Operations are selected by tool
// name only — the catalog array order is never a semantic identifier, and a
// server that reorders its catalog must not change our behaviour.
//
// The named-schema half of that verification is NOT this file's job any more.
// It used to keep a hand-copied `REQUIRED_TOOLS` table of required fields, which
// was a second, lazier copy of the mirrors in `contracts/rea-*.ts` and had
// already fallen behind it (`analyze_javascript_application` was recorded as
// requiring nothing while the provider requires `input_path`, and no field set
// at all was compared). `schema-reconciliation.ts` owns that rule and this file
// calls it once, on the same `tools/list` reply it already reads, so there is
// exactly one catalog read and one digest read per connection.

export type ProbeFailure = { code: "REA_CONTRACT_MISMATCH"; reasons: readonly string[] };

export type { AdvertisedTool };

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

// The catalog read lives in `schema-reconciliation.ts`; this file keeps no
// second parser of `tools/list`.

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

  // The expectations are handed to the provider as well as checked here: REA
  // compares them itself and answers through `server_identity.alignment`, so a
  // mismatch is reported by the owner of that verdict and re-verified by us,
  // rather than one of the two being trusted alone (§9 item 2).
  const sessionArgs: Record<string, JsonValue> = { expected_package_version: expectations.packageVersion };
  if (expectations.catalogDigest !== undefined) {
    sessionArgs["expected_catalog_digest"] = expectations.catalogDigest;
  }
  const session = await peer.request("tools/call", {
    name: "binary_session",
    arguments: sessionArgs,
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

  // One catalog read, one digest read, per connection: the reply fetched above is
  // handed straight to the reconciliation owner instead of being parsed twice,
  // because two parsers of the same document are two places that can disagree
  // about what the connection advertises (§9 item 2).
  const reconciled = reconcileNamedToolSchemas(listed.value);
  const tools: readonly AdvertisedTool[] = reconciled.ok ? reconciled.value : [];

  const reasons: string[] = [];
  if (packageVersion !== expectations.packageVersion) {
    reasons.push("package_version_mismatch");
  }
  if (expectations.catalogDigest !== undefined && catalogDigest !== expectations.catalogDigest) {
    reasons.push("catalog_digest_mismatch");
  }
  if (alignmentState !== "aligned") reasons.push(`alignment_${alignmentState}`);
  if (!reconciled.ok) reasons.push(...reconciled.error.reasons);

  // Catalog order is not an identity: the same names in a different order must
  // produce the same verdict. Every lookup is by name, and the reconciliation
  // reasons above are sorted, so a reordered catalog yields the byte-identical
  // verdict.
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

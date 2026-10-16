import type { JsonValue } from "../../domain/json-value.ts";
import type { CaptureInspectionOutcome, CaptureInspectionRequest } from "../../application/ports.ts";
import type { ReaSession } from "./session.ts";
import type { ReaEvidence, ReaToolError } from "../../contracts/rea-evidence.ts";

// The one producer call the HAR ingestion loop is allowed to make (DESIGN §9).
//
// This adapter exists so the ingestion service cannot hold a transport: it can ask
// for an inspection of a path the artifact store minted, and everything about the
// connection — tool naming, envelope decoding, the retained-record ledger, and the
// rule that a `resource_constraint` answer is consumed by reference instead of
// re-run — lives here.

type InspectorCode = CaptureInspectionOutcome extends infer O
  ? O extends { kind: "failure"; code: infer C }
    ? C
    : never
  : never;

// An unmapped producer code falls back to CAPABILITY_UNAVAILABLE: inventing a
// per-code mapping the design never states would be a guess, and 503 is the honest
// answer for "the provider told us something this client has no contract for".
const NAMED_CODE_BY_REA_ERROR: Record<string, InspectorCode> = {
  invalid_request: "INVALID_INPUT",
  configuration_invalid: "INVALID_INPUT",
  access_denied: "INVALID_INPUT",
  unsupported_target: "UNSUPPORTED_FORMAT",
  capability_unavailable: "CAPABILITY_UNAVAILABLE",
  provider_unavailable: "CAPABILITY_UNAVAILABLE",
  provider_timeout: "CAPABILITY_UNAVAILABLE",
  target_unavailable: "CAPABILITY_UNAVAILABLE",
  process_capture_failed: "CAPABILITY_UNAVAILABLE",
  execution_failure: "CAPABILITY_UNAVAILABLE",
  cleanup_incomplete: "CAPABILITY_UNAVAILABLE",
  artifact_changed: "REA_CONTRACT_MISMATCH",
  artifact_integrity_mismatch: "REA_CONTRACT_MISMATCH",
  evidence_integrity_mismatch: "REA_CONTRACT_MISMATCH",
  unreadable_output: "REA_CONTRACT_MISMATCH",
  artifact_operation_failed: "REA_CONTRACT_MISMATCH",
  truncated: "REA_CONTRACT_MISMATCH",
  revision_conflict: "STALE_INPUT",
  cancelled: "STALE_INPUT",
  resource_constraint: "CAPABILITY_UNAVAILABLE",
};

function toJson(value: ReaEvidence): JsonValue {
  // The envelope is already a validated plain object; re-encoding it once keeps the
  // stored bytes identical to what the schema proved, instead of trusting a cast.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function retainedReferenceOf(error: ReaToolError): string | null {
  const partial = error.details?.["partial_observation"];
  if (partial === null || partial === undefined || typeof partial !== "object" || Array.isArray(partial)) {
    return null;
  }
  const record = partial as Record<string, JsonValue>;
  if (record["kind"] !== "retained-evidence" || typeof record["evidence_id"] !== "string") return null;
  return record["evidence_id"];
}

export class ReaCaptureInspector {
  readonly session: ReaSession;

  constructor(deps: { session: ReaSession }) {
    this.session = deps.session;
  }

  async inspect(input: CaptureInspectionRequest): Promise<CaptureInspectionOutcome> {
    // Argument names are the producer's own (`capture_path`, `format`,
    // `record_ordinals`, `sensitive_values`), mirrored in contracts/rea-web-capture.ts.
    const args: Record<string, JsonValue> = {
      capture_path: input.capturePath,
      format: input.format,
      sensitive_values: [...input.sensitiveValues],
    };
    if (input.recordOrdinals !== null) args["record_ordinals"] = [...input.recordOrdinals];

    const called = await this.session.callTool("inspect_web_network_capture", args);
    if (!called.ok) {
      return {
        kind: "failure",
        code: called.error.code === "EVIDENCE_UNPERSISTED" ? "STALE_INPUT" : "CAPABILITY_UNAVAILABLE",
        reason: called.error.code,
        message: called.error.message,
      };
    }
    const outcome = called.value;
    if (outcome.kind === "evidence") {
      return { kind: "evidence", envelopeJson: toJson(outcome.evidence) };
    }
    if (outcome.kind === "value") {
      // A capture tool answers with an Evidence record. Anything else means this
      // client is reading a shape it does not have a contract for.
      return {
        kind: "failure",
        code: "REA_CONTRACT_MISMATCH",
        reason: "capture-without-evidence",
        message: "the capture tool returned a non-evidence result",
      };
    }

    const error = outcome.error;
    if (error.code === "resource_constraint") {
      // §9 item 7: the producer retained the record and said so. Re-running would
      // re-parse the capture under a different identity, so the reference is handed
      // back for later resolution by `inspect_analysis_view` / `export_evidence_bundle`.
      const reference = outcome.retainedEvidenceId ?? retainedReferenceOf(error);
      if (reference !== null) {
        return {
          kind: "retained-reference",
          evidenceId: reference,
          reason: "resource-constraint-reference-retained",
          continuationName: null,
        };
      }
    }
    const named = NAMED_CODE_BY_REA_ERROR[error.code] ?? "CAPABILITY_UNAVAILABLE";
    return { kind: "failure", code: named, reason: error.code, message: error.message };
  }
}

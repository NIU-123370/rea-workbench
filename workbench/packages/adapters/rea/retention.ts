import { isAbsolute } from "node:path";

import type { JsonValue } from "../../domain/json-value.ts";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { reaEvidenceIdSchema } from "../../contracts/primitives.ts";
import {
  inspectAnalysisViewInputSchema,
  inspectAnalysisViewOutputSchema,
} from "../../contracts/rea-analysis-view.ts";
import {
  exportEvidenceBundleInputSchema,
  exportEvidenceBundleOutputSchema,
  importEvidenceBundleInputSchema,
  importEvidenceBundleOutputSchema,
} from "../../contracts/rea-evidence-bundle.ts";
import type { ReaSession, ToolOutcome } from "./session.ts";

// DESIGN §9 item 5 and item 7: a large analysis can finish and be retained while
// the transport budget refuses to hand it back inline. The reply then carries a
// `resource_constraint` with an Evidence reference, and the ONLY correct response
// is to consume that reference — re-running the producer would re-parse the
// target under a different identity and mint a second, non-identical record of a
// fact that was already observed.
//
// `capture-inspection.ts` already turns that reply into a `retained-reference`
// outcome and must never re-run either; this file is the resolution side. It owns
// exactly three producer calls — `inspect_analysis_view`,
// `export_evidence_bundle`, `import_evidence_bundle` — and refuses every other
// name at runtime, so "never re-run the producer" is a property of the code path
// rather than a comment.
//
// Two live readings from the built provider at 98d8470d (2026-10-16) shape this
// file and are not invented here:
//
//   * `detail: "summary"` on `analyze_javascript_application` answers with an
//     `inspect_analysis_view` envelope whose `parameters.parent_evidence_id` is
//     the retained complete record. Referencing the ANSWER's own `evidence_id`
//     gets `unsupported_target`: "Parent Evidence operation
//     \"inspect_analysis_view\" is not inspect_binary_layout,
//     analyze_javascript_application or analyze_function." So a caller that
//     follows a reference must follow the parent, and this adapter hands back
//     exactly the id it was given and never silently swaps it.
//   * An argument the advertised schema refuses is refused by the MCP SDK layer,
//     whose `isError` text is not a `{error:...}` envelope at all, so the decoder
//     in `envelope.ts` reports `unparsable-text`. Validating the outgoing shape
//     against our own mirror is therefore not decoration: it is the only way this
//     path can name the offending field instead of losing the refusal.
//
// Cancellation (§9 item 7) is checked immediately before each call and a refused
// call is never re-issued: the outcome is `cancelled`, not a retry, and no
// producer process is started. What this file does NOT do is send
// `notifications/cancelled` with the in-flight request id — `RpcPeer` does not
// expose the id of a request it has already written, so telling the provider to
// stop is not yet possible from here. That gap is stated in issue #14's open list
// rather than papered over.

export type RetentionStage = "view" | "export" | "import";

export type RetentionFailureCode =
  | "REA_CONTRACT_MISMATCH"
  | "MCP_TRANSPORT_CLOSED"
  | "INVALID_INPUT"
  | "REFERENCE_UNRESOLVED"
  | "PRODUCER_REFUSED";

export type RetentionCancellation = {
  // Structural, not an AbortSignal, so a deadline is one more caller-supplied
  // predicate the adapter can prove it consulted before the call.
  cancelled: () => boolean;
};

export type RetentionOutcome =
  | {
      kind: "committed";
      stage: "export";
      evidenceId: string;
      path: string;
      bytes: number;
      records: number;
      unknowns: number;
    }
  | { kind: "cancelled"; stage: RetentionStage; evidenceId: string | null; reason: "cancelled" }
  | { kind: "failure"; stage: RetentionStage; code: RetentionFailureCode; reason: string }
  | {
      kind: "view";
      stage: "view";
      evidenceId: string;
      envelopeJson: JsonValue;
    };

export type ProducerRefusal = {
  code: RetentionFailureCode;
  reason: string;
};

// The names this path may call. Anything else is a re-run of a producer and is
// refused before it can reach the transport.
const ALLOWED_CALLS: readonly string[] = [
  "inspect_analysis_view",
  "export_evidence_bundle",
  "import_evidence_bundle",
  "close_binary",
];

// A refusal names a field and a safe reason — never a value. `error.path` is a
// schema path and `error.code` is a zod code; both are contract vocabulary.
function issueReason(
  stage: RetentionStage,
  side: "outgoing" | "reply",
  issues: readonly { path: readonly (string | number | symbol)[]; code: string }[],
): ProducerRefusal {
  const first = issues[0];
  const field = first === undefined ? "unknown" : first.path.map((part) => String(part)).join(".");
  const code = first?.code ?? "invalid";
  return {
    code: side === "outgoing" ? "INVALID_INPUT" : "REA_CONTRACT_MISMATCH",
    reason: `${stage}_${side}_field_${field || "root"}_${code}`,
  };
}

export class ReaRetention {
  readonly session: ReaSession;
  // Every name this instance has asked the transport for, in order. Tests read it
  // to prove a re-run never happened and that a cancelled caller issued nothing.
  readonly issued: string[] = [];

  constructor(deps: { session: ReaSession }) {
    this.session = deps.session;
  }

  // Absoluteness is enforced HERE rather than in the mirror, and that is a
  // placement decision with a reason: upstream's `isAbsolute` refinement is not
  // part of the advertised schema (a `.refine()` does not survive JSON Schema
  // conversion), and DESIGN §3 keeps `node:path` out of `packages/contracts`. The
  // live provider confirmed the gap on 2026-10-16 — a relative
  // `export_evidence_bundle` path is refused by the MCP SDK layer in prose the
  // envelope decoder has no named schema for, so the refusal would arrive as
  // `unparsable-text` instead of naming `path`. Refusing here first keeps the
  // refusal nameable, which is what §4 asks of every rejection.
  private static checkAbsolutePath(stage: RetentionStage, field: string, value: string): ProducerRefusal | null {
    return isAbsolute(value) ? null : { code: "INVALID_INPUT", reason: `${stage}_outgoing_field_${field}_must_be_absolute` };
  }

  private async call(
    stage: RetentionStage,
    name: string,
    args: JsonValue,
  ): Promise<Result<ToolOutcome, ProducerRefusal>> {
    if (!ALLOWED_CALLS.includes(name)) {
      return err({ code: "PRODUCER_REFUSED", reason: `stage_${stage}_name_not_allowed` });
    }
    this.issued.push(name);
    const called = await this.session.callTool(name, args);
    if (!called.ok) {
      return err({
        code: called.error.code === "EVIDENCE_UNPERSISTED" ? "INVALID_INPUT" : called.error.code,
        reason: called.error.code,
      });
    }
    return ok(called.value);
  }

  // The reference itself is checked before anything is sent: an id that is not an
  // `ev_<64 lowercase hex>` can never resolve, and asking for it would burn a
  // producer call on a guaranteed refusal.
  private checkEvidenceId(evidenceId: string): ProducerRefusal | null {
    const parsed = reaEvidenceIdSchema.safeParse(evidenceId);
    return parsed.success
      ? null
      : { code: "INVALID_INPUT", reason: `view_outgoing_field_source.evidence_id_${parsed.error.issues[0]?.code ?? "invalid"}` };
  }

  async resolveView(input: {
    evidenceId: string;
    view: JsonValue;
    cancellation?: RetentionCancellation;
  }): Promise<RetentionOutcome> {
    const badId = this.checkEvidenceId(input.evidenceId);
    if (badId !== null) return { kind: "failure", stage: "view", ...badId };

    // Outgoing shape validated against the mirror the provider's advertisement
    // was reconciled against — including the collection/selector pairing that
    // upstream keeps in the contract precisely so it survives JSON Schema
    // conversion (analysisView.ts:60-77).
    const args = { source: { kind: "retained-evidence", evidence_id: input.evidenceId }, view: input.view };
    const validated = inspectAnalysisViewInputSchema.safeParse(args);
    if (!validated.success) {
      return { kind: "failure", stage: "view", ...issueReason("view", "outgoing", validated.error.issues) };
    }

    // Checked again here, not once at the top of the method: a caller whose
    // deadline passes while the view argument was being validated must still not
    // reach the producer.
    if (input.cancellation?.cancelled() === true) {
      return { kind: "cancelled", stage: "view", evidenceId: input.evidenceId, reason: "cancelled" };
    }

    const called = await this.call("view", "inspect_analysis_view", validated.data as JsonValue);
    if (!called.ok) return { kind: "failure", stage: "view", ...called.error };
    const outcome = called.value;
    if (outcome.kind !== "evidence") {
      // The view reply is an Evidence record. Anything else means this client is
      // reading a shape it has no contract for (§9 item 3).
      return {
        kind: "failure",
        stage: "view",
        code: "REA_CONTRACT_MISMATCH",
        reason: `view_reply_kind_${outcome.kind}`,
      };
    }
    const checked = inspectAnalysisViewOutputSchema.safeParse(outcome.evidence);
    if (!checked.success) {
      return { kind: "failure", stage: "view", ...issueReason("view", "reply", checked.error.issues) };
    }
    return {
      kind: "view",
      stage: "view",
      evidenceId: input.evidenceId,
      envelopeJson: JSON.parse(JSON.stringify(outcome.evidence)) as JsonValue,
    };
  }

  async commitBundle(input: {
    evidenceId: string;
    path: string;
    overwrite?: boolean;
    cancellation?: RetentionCancellation;
  }): Promise<RetentionOutcome> {
    const badId = this.checkEvidenceId(input.evidenceId);
    if (badId !== null) return { kind: "failure", stage: "export", ...badId };
    const badPath = ReaRetention.checkAbsolutePath("export", "path", input.path);
    if (badPath !== null) return { kind: "failure", stage: "export", ...badPath };

    const args: Record<string, JsonValue> = { path: input.path };
    if (input.overwrite !== undefined) args["overwrite"] = input.overwrite;
    const validated = exportEvidenceBundleInputSchema.safeParse(args);
    if (!validated.success) {
      return { kind: "failure", stage: "export", ...issueReason("export", "outgoing", validated.error.issues) };
    }

    if (input.cancellation?.cancelled() === true) {
      return { kind: "cancelled", stage: "export", evidenceId: input.evidenceId, reason: "cancelled" };
    }

    const called = await this.call("export", "export_evidence_bundle", validated.data as JsonValue);
    if (!called.ok) return { kind: "failure", stage: "export", ...called.error };
    const outcome = called.value;
    if (outcome.kind === "error") {
      return { kind: "failure", stage: "export", code: "REFERENCE_UNRESOLVED", reason: `export_reply_error_${outcome.error.code}` };
    }
    if (outcome.kind !== "value") {
      return { kind: "failure", stage: "export", code: "REA_CONTRACT_MISMATCH", reason: "export_reply_kind_evidence" };
    }
    const checked = exportEvidenceBundleOutputSchema.safeParse(outcome.value);
    if (!checked.success) {
      return { kind: "failure", stage: "export", ...issueReason("export", "reply", checked.error.issues) };
    }

    // §9 item 6, in code: the ledger entry is cleared only after the producer has
    // named the file it wrote and the reply has validated. That is the point at
    // which the Evidence is proven committed, and it is what makes a later
    // `close_binary` legal at all — `ReaSession.closeBinary` refuses while any
    // id is still unpersisted.
    this.session.markPersisted(input.evidenceId);
    return {
      kind: "committed",
      stage: "export",
      evidenceId: input.evidenceId,
      path: checked.data.result.path,
      bytes: checked.data.result.bytes,
      records: checked.data.result.records,
      unknowns: checked.data.result.unknowns,
    };
  }

  async importBundle(input: {
    path: string;
    cancellation?: RetentionCancellation;
  }): Promise<Result<{ imported: number; unknownsAdded: number; total: number }, ProducerRefusal>> {
    const badPath = ReaRetention.checkAbsolutePath("import", "path", input.path);
    if (badPath !== null) return err(badPath);
    const validated = importEvidenceBundleInputSchema.safeParse({ path: input.path });
    if (!validated.success) {
      return err(issueReason("import", "outgoing", validated.error.issues));
    }
    if (input.cancellation?.cancelled() === true) {
      return err({ code: "INVALID_INPUT", reason: "import_cancelled_before_call" });
    }
    const called = await this.call("import", "import_evidence_bundle", validated.data as JsonValue);
    if (!called.ok) return err(called.error);
    const outcome = called.value;
    if (outcome.kind !== "value") {
      return err({ code: "REA_CONTRACT_MISMATCH", reason: `import_reply_kind_${outcome.kind}` });
    }
    const checked = importEvidenceBundleOutputSchema.safeParse(outcome.value);
    if (!checked.success) {
      return err(issueReason("import", "reply", checked.error.issues));
    }
    // The reply names counts, never ids (live reading:
    // `{imported:3,unknowns_added:0,total:3}`), so this path deliberately adds
    // nothing to the ledger: §9 item 6 forbids treating a bare exported path as an
    // already-imported retained reference, and a caller that wants one of these
    // ids must read it out of the bundle file it just imported.
    return ok({
      imported: checked.data.result.imported,
      unknownsAdded: checked.data.result.unknowns_added,
      total: checked.data.result.total,
    });
  }
}

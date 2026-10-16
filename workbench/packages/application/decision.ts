import { nowInstant } from "../domain/identity.ts";
import type { Id } from "../domain/identity.ts";
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import type { Actor } from "./actor.ts";
import type { AuditRow, StorageTransaction, StorageWriterPort } from "./ports.ts";
import { gateFail, type Err, type GateFailure } from "./gate-failure.ts";

// The transaction unit every control-plane service uses (DESIGN §12.2, D29):
// business rows, their outbox event and the journal entry for the *decision that
// was actually taken* commit together. A refusal is journalled as a deny inside
// the same transaction, so the audit trail cannot claim an approval that never
// wrote anything.

export type AuditDraft = {
  projectId: Id | null;
  actor: Actor;
  resourceType: string;
  action: string;
  resourceId: string | null;
  decision: AuditRow["decision"];
  reasonCode: string;
  metadata: JsonValue;
};

export function buildAuditRow(draft: AuditDraft): AuditRow {
  return {
    projectId: draft.projectId,
    actorId: draft.actor.actorId,
    actorKind: draft.actor.actorKind,
    action: draft.action,
    resourceType: draft.resourceType,
    resourceId: draft.resourceId,
    decision: draft.decision,
    reasonCode: draft.reasonCode,
    safeMetadataJson: draft.metadata,
    createdAt: nowInstant(),
  };
}

// Journal a refusal that was decided before any row could be written. The refusal
// stands even when the journal write itself fails (§12.2).
export function recordDeny(writer: StorageWriterPort, draft: AuditDraft): { recorded: boolean } {
  const outcome = writer.transact((tx) => tx.insertAudit(buildAuditRow(draft)));
  return { recorded: outcome.ok };
}

export type Step<T> =
  | { kind: "failure"; failure: Err<GateFailure> }
  | { kind: "committed"; value: T };

export type Decision<T> = {
  projectId: Id;
  actor: Actor;
  resourceType: string;
  action: string;
  resourceId: string | null;
  allowReason: string;
  metadata: JsonValue;
  work: (tx: StorageTransaction) => Step<T>;
};

export function commitDecision<T>(
  writer: StorageWriterPort,
  decision: Decision<T>,
): Result<{ value: T; auditSeq: number }, GateFailure> {
  const outcome = writer.transact((tx) => {
    const step = decision.work(tx);
    if (step.kind === "failure") {
      return {
        kind: "denied" as const,
        failure: step.failure.error,
        auditSeq: tx.insertAudit(
          buildAuditRow({
            projectId: decision.projectId,
            actor: decision.actor,
            resourceType: decision.resourceType,
            action: decision.action,
            resourceId: decision.resourceId,
            decision: "deny",
            reasonCode: step.failure.error.reason,
            metadata: {},
          }),
        ),
      };
    }
    return {
      kind: "allowed" as const,
      value: step.value,
      auditSeq: tx.insertAudit(
        buildAuditRow({
          projectId: decision.projectId,
          actor: decision.actor,
          resourceType: decision.resourceType,
          action: decision.action,
          resourceId: decision.resourceId,
          decision: "allow",
          reasonCode: decision.allowReason,
          metadata: decision.metadata,
        }),
      ),
    };
  });
  if (!outcome.ok) return gateFail("INVALID_INPUT", outcome.error.code, outcome.error.message);
  if (outcome.value.kind === "denied") {
    const failure = outcome.value.failure;
    return gateFail(failure.code, failure.reason, failure.message, failure.details);
  }
  return { ok: true, value: { value: outcome.value.value, auditSeq: outcome.value.auditSeq } };
}

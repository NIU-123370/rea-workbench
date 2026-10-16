import type { Result } from "../domain/result.ts";
import type { Id } from "../domain/identity.ts";
import type {
  AuditRow,
  CommittedAudit,
  StoragePortError,
  StorageTransaction,
  StorageWriterPort,
} from "./ports.ts";

// DESIGN §12.2 / D29: a business change and its audit record commit in the same
// SQLite transaction. If the audit row cannot be written, the change does not
// happen either — but a denial is still enforced even when the audit store is
// unavailable, and that condition degrades the worker instead of releasing the
// request.

export type CommittedChange<T> = { value: T; auditSeq: number };

export function commitWithAudit<T>(
  writer: StorageWriterPort,
  entry: AuditRow,
  work: (tx: StorageTransaction) => T,
): Result<CommittedChange<T>, StoragePortError> {
  return writer.transact((tx) => {
    const value = work(tx);
    // Same transaction, ordered after the business rows: an audit failure rolls
    // the whole unit back, so no change can exist without its record.
    const auditSeq = tx.insertAudit(entry);
    return { value, auditSeq };
  });
}

export type DenyOutcome = {
  decision: "deny";
  reasonCode: string;
  recorded: boolean;
  degraded: boolean;
};

export function enforceDeny(writer: StorageWriterPort, entry: AuditRow): DenyOutcome {
  const recorded = writer.transact((tx) => tx.insertAudit(entry));
  // The refusal stands on its own; failing to journal it only changes whether we
  // can prove it afterwards.
  return {
    decision: "deny",
    reasonCode: entry.reasonCode,
    recorded: recorded.ok,
    degraded: !recorded.ok,
  };
}

export function readAudit(
  writer: StorageWriterPort,
  input: { after: number; projectId: Id | null; limit: number },
): Result<CommittedAudit[], StoragePortError> {
  return writer.transact((tx) => tx.auditAfter(input.after, input.projectId, input.limit));
}

import { AUDIT_LIST_DEFAULT_LIMIT, AUDIT_LIST_MAX_LIMIT, type AuditEntryWire, type AuditPageWire } from "../contracts/audit.ts";
import type { Id } from "../domain/identity.ts";
import type { Result } from "../domain/result.ts";
import type { Actor } from "./actor.ts";
import { isControlPlane } from "./actor.ts";
import { gateFail, type GateFailure } from "./gate-failure.ts";
import type { CommittedAudit, StorageWriterPort } from "./ports.ts";

// The audit reads (DESIGN §8 lines 302-303, §12.2).
//
// Two windows over one journal. §8's rows are not interchangeable: the project route reads
// "only this project's safe metadata", and the unrooted route reads the rows that belong to no
// project - the worker's own startup, pairings and unauthenticated refusals. The storage layer
// already keeps those two selectors apart (`project_id = ?` against `project_id IS NULL`), so
// this service does not offer a single call with an optional filter: a missing filter would
// have to mean something, and either meaning leaks.
//
// What a reader gets is what `AuditService` wrote: named reason codes and metadata that
// already passed the sanitizer. Nothing here re-derives a message, and nothing here strips a
// field either - a journal an operator cannot trust to be the recorded one is not a journal.

export type AuditReadDeps = { storage: StorageWriterPort };

export class AuditReadService {
  readonly storage: StorageWriterPort;

  constructor(deps: AuditReadDeps) {
    this.storage = deps.storage;
  }

  // §8 marks both rows 仅本地操作者 and gives an agent no access to the journal. In this
  // codebase's actor vocabulary that is `isControlPlane`: inspector, reviewer and the worker
  // itself - and not the Builder, which must not learn what a reviewer decided about it.
  private refuseRole(actor: Actor, reason: string): Result<never, GateFailure> | null {
    if (isControlPlane(actor)) return null;
    return gateFail("ACCESS_DENIED", reason, "this role does not read the audit journal");
  }

  private page(
    projectId: Id | null,
    actor: Actor,
    refusal: string,
    input: { after: number | null; limit: number | null | undefined },
  ): Result<AuditPageWire, GateFailure> {
    const denied = this.refuseRole(actor, refusal);
    if (denied !== null) return denied;
    const limit = input.limit ?? AUDIT_LIST_DEFAULT_LIMIT;
    if (limit > AUDIT_LIST_MAX_LIMIT) {
      return gateFail("RESOURCE_LIMIT", "audit-limit", `an audit page is at most ${String(AUDIT_LIST_MAX_LIMIT)} entries`, {
        limit,
        maxLimit: AUDIT_LIST_MAX_LIMIT,
      });
    }
    const after = input.after ?? 0;
    // `limit + 1` is the probe that distinguishes "this was the last page" from "the journal
    // happens to end here", and it is why a full page does not automatically promise a cursor.
    const read = this.storage.transact((tx) => tx.auditAfter(after, projectId, limit + 1));
    if (!read.ok) return gateFail("CAPABILITY_UNAVAILABLE", "audit-read-failed", "the audit journal could not be read");
    const rows = read.value.slice(0, limit);
    return {
      ok: true,
      value: {
        entries: rows.map(toWire),
        nextCursor: read.value.length > limit && rows.length > 0 ? (rows[rows.length - 1] as CommittedAudit).seq : null,
      },
    };
  }

  listProject(projectId: Id, actor: Actor, input: { after: number | null; limit: number | null | undefined }): Result<AuditPageWire, GateFailure> {
    return this.page(projectId, actor, "audit-not-for-role", input);
  }

  // The unrooted page: what the worker did before any project existed, and everything that
  // arrived without one - pairing, revocation, unauthenticated refusals (§12.2's list).
  listGlobal(actor: Actor, input: { after: number | null; limit: number | null | undefined }): Result<AuditPageWire, GateFailure> {
    return this.page(null, actor, "global-audit-not-for-role", input);
  }
}

function toWire(row: CommittedAudit): AuditEntryWire {
  return {
    seq: row.seq,
    projectId: row.projectId,
    actorId: row.actorId,
    actorKind: row.actorKind,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    decision: row.decision,
    reasonCode: row.reasonCode,
    // §12.2 names the field `safeMetadata`; the row stores it as `safe_metadata_json`. The
    // rename happens here, at the wire boundary, and nowhere else.
    safeMetadata: row.safeMetadataJson,
    createdAt: row.createdAt,
  };
}

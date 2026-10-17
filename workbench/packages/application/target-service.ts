import { newId, nowInstant } from "../domain/identity.ts";
import type { Id } from "../domain/identity.ts";
import type { Result } from "../domain/result.ts";
import { URL_TARGET_IDENTITY_REASON, normalizeUrlLocator } from "../domain/target.ts";
import type { TargetRow } from "./ports.ts";
import type { Actor } from "./actor.ts";
import { isControlPlane } from "./actor.ts";
import { commitDecision, recordDeny } from "./decision.ts";
import type { Step } from "./decision.ts";
import { blockedByReasons, gateFail, type GateFailure } from "./gate-failure.ts";
import type { StorageWriterPort } from "./ports.ts";
import { createUrlTargetRequestSchema } from "../contracts/resources.ts";
import type { TargetCreated, TargetView } from "../contracts/resources.ts";

// Declaring and reading capture targets (DESIGN §8 lines 273-274, §5; PRD F01; issue #58).
//
// Two rules carry this module.
//
// A *file* target is a fact about something that already arrived, so it is created by the
// import that brought it (§8 line 272) and never by this door: a row that named a HAR nobody
// uploaded would make the target list a place to write wishes. The `kind` is therefore accepted
// by the request schema and refused here by name - a schema that only allowed `url` would answer
// 400 "field kind" and lose the sentence the operator needed.
//
// A URL target's identity is *unknown* until something is captured against it. §5 stores that
// as a reason string rather than a null, and §8's create reply says `snapshotDigest: null`
// explicitly, so this module never lets a declared URL look like a measured one.

// How many of a target's evidence ids one read will name. The view says "the evidence this target
// produced", and a target can have more than a page of it; a bounded list that says nothing about
// being bounded would be a half-truth, so the door's contract carries the cap and the read refuses
// to pretend the list is complete beyond it.
export const TARGET_EVIDENCE_LIMIT = 200;

export type TargetServiceDeps = { readonly storage: StorageWriterPort };

export class TargetService {
  readonly storage: StorageWriterPort;

  constructor(deps: TargetServiceDeps) {
    this.storage = deps.storage;
  }

  private denied(projectId: Id, actor: Actor, action: string, resourceId: Id | null, reason: string, message: string): Result<never, GateFailure> {
    recordDeny(this.storage, {
      projectId,
      actor,
      resourceType: "target",
      action,
      resourceId,
      decision: "deny",
      reasonCode: reason,
      metadata: {},
    });
    return gateFail("ACCESS_DENIED", reason, message, { actorKind: actor.actorKind });
  }

  declare(projectId: Id, actor: Actor, input: unknown): Result<TargetCreated, GateFailure> {
    if (!isControlPlane(actor)) {
      return this.denied(projectId, actor, "target.create", null, "role-may-not-declare-targets", "only the control plane declares a capture target (§7.3)");
    }
    const parsed = createUrlTargetRequestSchema.safeParse(input);
    if (!parsed.success) {
      return gateFail("INVALID_INPUT", "target-request", "the target declaration was rejected", {
        fields: parsed.error.issues.map((issue) => issue.path.join(".")),
        rejectedKeys: parsed.error.issues.flatMap((issue) => (issue as { keys?: string[] }).keys ?? []),
      });
    }
    const locator = normalizeUrlLocator(parsed.data.url);
    if (!locator.ok) return blockedByReasons(locator.error, "INVALID_INPUT", "the declared URL");

    const targetId = newId();
    const row: TargetRow = {
      id: targetId,
      projectId,
      kind: "url",
      originalLocator: locator.value.locator,
      sourceSha256: null,
      sourceArtifactId: null,
      snapshotDigest: null,
      identityReason: URL_TARGET_IDENTITY_REASON,
      createdAt: nowInstant(),
    };
    const committed = commitDecision(this.storage, {
      projectId,
      actor,
      resourceType: "target",
      action: "target.create",
      resourceId: targetId,
      allowReason: "url-declared",
      // The host, not the locator: §5 keeps a sensitive locator out of the journal, and the host
      // is the part an operator needs to see to know which declaration this was.
      metadata: { host: locator.value.host },
      work: (tx): Step<TargetCreated> => {
        tx.insertTarget(row);
        return {
          kind: "committed",
          value: {
            id: targetId,
            kind: "url",
            snapshotDigest: null,
            identityReason: URL_TARGET_IDENTITY_REASON,
            auditSeq: 0,
          },
        };
      },
    });
    if (!committed.ok) return committed;
    return { ok: true, value: { ...committed.value.value, auditSeq: committed.value.auditSeq } };
  }

  read(projectId: Id, actor: Actor, targetId: Id): Result<TargetView, GateFailure> {
    if (!isControlPlane(actor)) {
      return this.denied(projectId, actor, "target.read", targetId, "role-may-not-read-targets", "the target list is a control-plane view (§7.3)");
    }
    const looked = this.storage.transact((tx) => {
      const row = tx.getTarget(projectId, targetId);
      if (row === null) return null;
      return {
        row,
        evidenceIds: tx.listEvidenceIdsForTarget(projectId, targetId, TARGET_EVIDENCE_LIMIT),
        importJob: tx.findImportJobForTarget(projectId, targetId),
      };
    });
    if (!looked.ok) return gateFail("INVALID_INPUT", looked.error.code, looked.error.message);
    if (looked.value === null) return gateFail("NOT_FOUND", "target-unknown", "no such target in this project");
    const { row, evidenceIds, importJob } = looked.value;
    return {
      ok: true,
      value: {
        id: row.id,
        kind: row.kind,
        sourceSha256: row.sourceSha256,
        snapshotDigest: row.snapshotDigest,
        identityReason: row.identityReason,
        evidenceIds,
        importJobId: importJob?.id ?? null,
      },
    };
  }
}

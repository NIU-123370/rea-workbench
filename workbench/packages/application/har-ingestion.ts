import { canonicalJson } from "../domain/canonical-json.ts";
import type { CanonicalLimits, Digest } from "../domain/canonical-json.ts";
import { asDigest, digestBytes } from "../domain/canonical-json.ts";
import { asId, isReaEvidenceId, newId, nowInstant } from "../domain/identity.ts";
import type { Id } from "../domain/identity.ts";
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import { jobErrorFromFailure, projectJobRecord, transition } from "./job-queue.ts";
import { harImportCommandSchema, ingestionJobInputSchema, inspectionCommandSchema } from "../contracts/imports.ts";
import type { HarImportReceipt, InspectionReceipt } from "../contracts/imports.ts";
import { reaEvidenceSchema } from "../contracts/rea-evidence.ts";
import type { ReaEvidence } from "../contracts/rea-evidence.ts";
import type { Actor } from "./actor.ts";
import type { FileTargetKind } from "../domain/target.ts";
import { buildAuditRow, commitDecision, recordDeny, type Step } from "./decision.ts";
import { gateFail, issueNames, type GateFailure } from "./gate-failure.ts";
import { assertPayloadClean } from "./sanitizer.ts";
import type { SensitiveDeclaration } from "./sanitizer.ts";
import type {
  ArtifactPort,
  CaptureInspectorPort,
  JobRow,
  StorageWriterPort,
  TargetRow,
} from "./ports.ts";

// HAR ingestion (DESIGN §8 ingestion, §5, D25; PRD F02/A01; issue #15).
//
// Three rules carry the module, and each has a place where it is *decided* rather
// than repeated: an upload atomically creates the target, the inspect job and the
// owned staging lease; nothing here can reach a recorded URL because the producer
// call is a port that accepts only a workbench-minted path; and the sensitive
// declaration lives only inside this operation, so resuming an interrupted import
// without a fresh declaration is a refusal rather than an un-attested re-parse.

export type IngestionContext = {
  // Short-lived operation context. Never persisted, never part of a request
  // digest, never echoed in a receipt (§12.1, D25).
  sensitive: SensitiveDeclaration | null;
};

export type ImportBytes = {
  bytes: Uint8Array;
};

const IMPORT_ACTORS = ["inspector", "reviewer"] as const;

function safeBasename(text: string): string {
  // A locator is display text, not a path: strip directories so an uploaded
  // filename can never be re-opened as one, and keep the result filtered.
  const base = text.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? "unnamed";
  return base.slice(0, 200);
}

function commandOf(row: JobRow): JsonValue {
  return row.inputJson;
}

export class HarIngestionService {
  readonly storage: StorageWriterPort;
  readonly artifacts: ArtifactPort;
  readonly inspector: CaptureInspectorPort;
  readonly ledger: { markPersisted(evidenceId: string): void };
  readonly limits: CanonicalLimits;

  constructor(deps: {
    storage: StorageWriterPort;
    artifacts: ArtifactPort;
    inspector: CaptureInspectorPort;
    ledger: { markPersisted(evidenceId: string): void };
    limits: CanonicalLimits;
  }) {
    this.storage = deps.storage;
    this.artifacts = deps.artifacts;
    this.inspector = deps.inspector;
    this.ledger = deps.ledger;
    this.limits = deps.limits;
  }

  async importCapture(
    projectId: Id,
    actor: Actor,
    input: unknown,
    bytes: Uint8Array,
    context: IngestionContext,
  ): Promise<Result<HarImportReceipt & { auditSeq: number }, GateFailure>> {
    if (!IMPORT_ACTORS.includes(actor.actorKind as (typeof IMPORT_ACTORS)[number])) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "capture",
        action: "har.import",
        resourceId: null,
        decision: "deny",
        reasonCode: "actor-may-not-import",
        metadata: {},
      });
      return gateFail(
        "ACCESS_DENIED",
        "actor-may-not-import",
        "only the control plane may upload a capture for analysis",
      );
    }
    if (context.sensitive === null) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "capture",
        action: "har.import",
        resourceId: null,
        decision: "deny",
        reasonCode: "declaration-context-unavailable",
        metadata: {},
      });
      return gateFail(
        "SENSITIVE_CONTENT_BLOCKED",
        "declaration-context-unavailable",
        "an import needs the operator's short-lived declaration context before any bytes are stored",
      );
    }
    const parsed = harImportCommandSchema.safeParse(input);
    if (!parsed.success) {
      return gateFail("INVALID_INPUT", "import-command", "import command rejected", {
        issues: issueNames(parsed.error.issues) as unknown as JsonValue,
      });
    }
    const command = parsed.data;
    const declaredDigest = command.sourceSha256;
    const measured = digestBytes(bytes);
    if (measured !== declaredDigest) {
      // The declared digest is checked against the bytes, not trusted: a receipt
      // naming a digest the store never held would be a provenance lie.
      return gateFail("INVALID_INPUT", "source-digest-mismatch", "the uploaded bytes do not match the declared digest");
    }
    if (bytes.byteLength !== command.byteLength) {
      return gateFail("INVALID_INPUT", "source-length-mismatch", "the uploaded byte count differs from the command");
    }

    const locator = safeBasename(command.filename);
    // Written through its own contract rather than as a literal, so the row the runner later reads
    // has one owner for this shape: `ingestionJobInputSchema` is what tells an ingestion job apart
    // from a directed investigation, and a drift between the writer and that test would otherwise
    // show up as uploads whose rows nobody executes.
    const projected = ingestionJobInputSchema.safeParse({
      filename: locator,
      mediaType: command.mediaType,
      format: command.format,
      byteLength: command.byteLength,
      sourceSha256: measured,
      recordOrdinals: command.recordOrdinals ?? null,
    });
    if (!projected.success) {
      return gateFail("INVALID_INPUT", "ingestion-job-input", "the persisted import projection is not representable", {
        issues: issueNames(projected.error.issues) as unknown as JsonValue,
      });
    }
    const safeCommand: JsonValue = projected.data;
    // The stored input projection is filtered before it is written, so a filename
    // carrying a declared secret cannot become a persisted column.
    const cleanCheck = assertPayloadClean(safeCommand, context.sensitive);
    if (!cleanCheck.ok) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "capture",
        action: "har.import",
        resourceId: null,
        decision: "deny",
        reasonCode: cleanCheck.reason,
        metadata: {},
      });
      return gateFail(
        "SENSITIVE_CONTENT_BLOCKED",
        cleanCheck.reason,
        "the import metadata is refused by the diagnostic filter",
      );
    }

    // The producer's own budget hash: it excludes the declaration values and any
    // digest of them, so two imports of the same file differ only by safe facts
    // (§5 "request_digest 不包含认证或显式敏感原文及其摘要").
    const requestDigest = asDigest(
      digestBytes(
        new TextEncoder().encode(
          canonicalJson(
            {
              format: command.format,
              byteLength: command.byteLength,
              sourceSha256: measured,
              recordOrdinals: command.recordOrdinals ?? null,
            },
            this.limits,
          ),
        ),
      ),
    );

    const staged = await this.artifacts.publish(projectId, "inspector", bytes);
    if (!staged.ok) {
      return gateFail("CAPABILITY_UNAVAILABLE", staged.error.code, "the upload could not be staged");
    }

    const targetId = newId();
    const jobId = newId();
    const leaseId = newId();
    const sourceArtifactId = newId();
    const created = nowInstant();

    const committed = commitDecision<HarImportReceipt>(this.storage, {
      projectId,
      actor,
      resourceType: "capture",
      action: "har.import",
      resourceId: targetId,
      allowReason: "har-imported",
      metadata: { sourceSha256: measured, byteLength: command.byteLength, locator },
      work: (tx): Step<HarImportReceipt> => {
        const project = tx.getProject(projectId);
        if (project === null) {
          return { kind: "failure", failure: gateFail("NOT_FOUND", "project-unknown", "project not found") };
        }
        // The key is read before anything is written, because `jobs.target_id`
        // points at the target this same transaction is about to create: answering a
        // duplicate first is the only order that does not need a placeholder row.
        const prior = tx.findJobByKey(projectId, command.idempotencyKey);
        if (prior !== null) {
          if (prior.requestDigest !== requestDigest) {
            return {
              kind: "failure",
              failure: gateFail(
                "IDEMPOTENCY_CONFLICT",
                "idempotency-key-reused",
                "that idempotency key already carries a different import",
                { jobId: prior.id },
              ),
            };
          }
          const existingTarget = prior.targetId === null ? null : tx.getTarget(projectId, prior.targetId);
          if (existingTarget === null || existingTarget.snapshotDigest === null) {
            return {
              kind: "failure",
              failure: gateFail("REA_CONTRACT_MISMATCH", "import-target-missing", "the stored import names no readable target"),
            };
          }
          return {
            kind: "committed",
            value: {
              targetId: existingTarget.id,
              // §8 line 272's answer is the job the key already owns, named the same way the job
              // read doors name it - one projection, so a replay and a later read cannot disagree.
              job: projectJobRecord(prior, tx.listLeasesForJobs(projectId, [prior.id])),
              leaseId,
              sourceArtifactId: existingTarget.sourceArtifactId ?? sourceArtifactId,
              snapshotDigest: existingTarget.snapshotDigest,
              byteLength: command.byteLength,
              reused: true,
            },
          };
        }
        tx.insertArtifact({
          id: sourceArtifactId,
          projectId,
          // The source artifact is created before the job row that will point at
          // it (jobs → targets → artifacts would otherwise close an FK cycle), so
          // its provenance link is the target's `source_artifact_id`.
          jobId: null,
          class: "inspector",
          sha256: measured,
          digestReason: null,
          byteLength: staged.value.byteLength,
          storageKey: staged.value.storageKey,
          // A HAR body is retained as the producer's own file; the workbench adds
          // no media type it did not receive.
          mediaType: command.mediaType,
          createdAt: created,
        });
        const target: TargetRow = {
          id: targetId,
          projectId,
          kind: command.format,
          originalLocator: locator,
          sourceSha256: measured,
          sourceArtifactId,
          // §4: for a captured file the snapshot identity is the content digest, so it exists before
          // any producer has opened the file. §5 says the other half of line 272 is not captured at
          // all - an archive is an archive - so an ASAR import states a source digest and no
          // deployment snapshot, and `identityReason` is where the difference has to be readable
          // rather than inferred from a null.
          snapshotDigest: command.format === "har" ? measured : null,
          identityReason: command.format === "har" ? null : "file-import-without-capture",
          createdAt: created,
        };
        tx.insertTarget(target);

        const job: JobRow = {
          id: jobId,
          projectId,
          targetId,
          kind: "inspect",
          state: "queued",
          cleanupState: "pending",
          inputJson: safeCommand,
          resultRef: null,
          errorJson: null,
          idempotencyKey: command.idempotencyKey,
          requestDigest,
          deadlineAt: command.deadlineAt ?? null,
          retryAt: null,
          createdAt: created,
          updatedAt: created,
        };
        const createdJob = tx.insertJob(job);
        if (createdJob.outcome !== "inserted") {
          // A concurrent writer took the key between the read above and this
          // insert. BEGIN IMMEDIATE serialises writers, so reaching here means the
          // key was claimed by a transaction that committed first: report it rather
          // than writing a second target.
          return {
            kind: "failure",
            failure: gateFail(
              "IDEMPOTENCY_CONFLICT",
              "idempotency-key-raced",
              "the idempotency key was claimed by a concurrent import",
              { jobId: createdJob.job.id },
            ),
          };
        }

        tx.insertLease({
          id: leaseId,
          jobId,
          kind: "har-staging",
          resourceIdentityJson: { storageKey: staged.value.storageKey, sha256: measured },
          // The ownership proof is what later cleanup is allowed to act on: a
          // staging entry this workbench did not mint is never deleted (§5).
          ownershipProofJson: { mintedBy: "har-import", jobId, sourceArtifactId },
          cleanupState: "pending",
          lastErrorJson: null,
          retryAt: null,
          retryCount: 0,
        });
        const eventSeq = tx.appendEvent({
          projectId,
          type: "job.updated",
          aggregateId: jobId,
          payloadJson: { resourceIds: [jobId, targetId], state: "queued" },
          createdAt: created,
        });
        void eventSeq;
        return {
          kind: "committed",
          value: {
            targetId,
            // The job as §8 line 272 names it, read back from the row and the lease this same
            // transaction just wrote - not a copy of the fields the caller happened to send.
            job: projectJobRecord(job, tx.listLeasesForJobs(projectId, [jobId])),
            leaseId,
            sourceArtifactId,
            snapshotDigest: target.snapshotDigest,
            byteLength: command.byteLength,
            reused: false,
          },
        };
      },
    });

    if (!committed.ok) return committed;
    return { ok: true, value: { ...committed.value.value, auditSeq: committed.value.auditSeq } };
  }

  async runInspection(
    projectId: Id,
    actor: Actor,
    command: unknown,
    context: IngestionContext,
  ): Promise<Result<InspectionReceipt & { auditSeq: number }, GateFailure>> {
    if (!IMPORT_ACTORS.includes(actor.actorKind as (typeof IMPORT_ACTORS)[number])) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "job",
        action: "har.inspect",
        resourceId: null,
        decision: "deny",
        reasonCode: "actor-may-not-inspect",
        metadata: {},
      });
      return gateFail("ACCESS_DENIED", "actor-may-not-inspect", "only the control plane may drive an inspect job");
    }
    // D25: an interrupted parse may not be replayed without a declaration. A
    // missing context is a refusal even when the job itself is resumable, because
    // the filter that keeps declared values out of stored rows would be absent.
    if (context.sensitive === null) {
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "job",
        action: "har.inspect",
        resourceId: null,
        decision: "deny",
        reasonCode: "declaration-context-unavailable",
        metadata: {},
      });
      return gateFail(
        "SENSITIVE_CONTENT_BLOCKED",
        "declaration-context-unavailable",
        "a resumed inspection needs the operator's declaration context again",
      );
    }
    const parsed = inspectionCommandSchema.safeParse(command);
    if (!parsed.success) {
      return gateFail("INVALID_INPUT", "inspection-command", "inspection command rejected", {
        issues: issueNames(parsed.error.issues) as unknown as JsonValue,
      });
    }
    const request = parsed.data;

    const looked = this.storage.transact((tx) => {
      const job = tx.getJob(projectId, asId(request.jobId));
      if (job === null) return null;
      const target = job.targetId === null ? null : tx.getTarget(projectId, job.targetId);
      const artifact =
        target?.sourceArtifactId === null || target === null || target.sourceArtifactId === null
          ? null
          : tx.getArtifact(projectId, target.sourceArtifactId);
      return { job, target, artifact };
    });
    if (!looked.ok) return gateFail("INVALID_INPUT", looked.error.code, looked.error.message);
    if (looked.value === null) return gateFail("NOT_FOUND", "job-unknown", "job not found");
    const { job, target, artifact } = looked.value;
    if (target === null || artifact === null) {
      return gateFail("NOT_FOUND", "import-incomplete", "the import this job belongs to is missing its target or artifact");
    }
    if (job.state !== request.expectedJobState) {
      return gateFail(
        "REVISION_CONFLICT",
        "job-state-changed",
        `the job is ${job.state}, not the ${request.expectedJobState} state this command expected`,
        { state: job.state },
      );
    }
    const capturePath = this.artifacts.absolutePathFor(projectId, artifact.storageKey);
    if (capturePath === null) {
      return gateFail("INVALID_INPUT", "artifact-path-unresolvable", "only a path this store minted may be inspected");
    }

    // The stored target row, not the request, decides which producer is asked - §8 line 272's `kind`
    // is fixed at import time, and re-reading it from the row is what keeps a resumed inspection
    // from being talked into asking the capture tool to read an archive.
    const recordOrdinals = arrayOf(commandOf(job), "recordOrdinals");
    const ordinals = Array.isArray(recordOrdinals) ? recordOrdinals.map((value) => Number(value)) : null;
    if (target.kind === "asar" && ordinals !== null) {
      return gateFail(
        "INVALID_INPUT",
        "inspection-record-ordinals-for-archive",
        "a record selection belongs to a network capture; an ASAR import analyses the whole archive",
      );
    }
    // A declared URL target never reaches this line: it has no store-minted source artifact, and the
    // `import-incomplete` refusal above is what says so. So the two kinds left are exactly §8 line
    // 272's two, and the narrowing below is a type fact rather than a second gate.
    const format: FileTargetKind = target.kind === "asar" ? "asar" : "har";
    const outcome = await this.inspector.inspect({
      capturePath,
      format,
      recordOrdinals: ordinals,
      // §8 line 272's own asymmetry: the declaration belongs to a HAR. An ASAR row that somehow
      // carries one is refused rather than silently stripped, because stripping would let the
      // producer run with a filter the operator was told does not exist.
      sensitiveValues: target.kind === "har" ? context.sensitive.declaredValues : [],
    });

    if (outcome.kind === "retained-reference") {
      // §9 item 7: the producer kept the record and told the workbench to consume
      // it by reference. Re-running the operation is forbidden, so the job stops
      // here with the reference recorded for #14's export/inspect-by-reference path.
      const stopped = this.storage.transact((tx) => {
        const updated: JobRow = {
          ...job,
          state: "failed",
          // §9 item 7's stop is a resource constraint, so it reports under §8's own code for one and
          // keeps the service's reason in `message`; the column is read back as a JobRecord, and a
          // shape only this file knows would make the whole job page refuse to parse.
          errorJson: jobErrorFromFailure(job, { code: "RESOURCE_LIMIT", reason: "resource-constraint-reference-retained" }),
          updatedAt: nowInstant(),
        };
        tx.updateJob(updated);
        const lease = tx.getLeaseByJob(projectId, job.id);
        if (lease !== null) {
          // Nothing was cleaned and nothing was retried: the retained record still
          // has to be resolved by reference, so ownership stays with this job.
          tx.updateLeaseCleanup(lease.id, "failed", { reason: outcome.reason }, null, lease.retryCount + 1);
        }
        return tx.appendEvent({
          projectId,
          type: "job.updated",
          aggregateId: job.id,
          payloadJson: { resourceIds: [job.id, outcome.evidenceId], state: "failed", reasonCode: outcome.reason },
          createdAt: nowInstant(),
        });
      });
      if (!stopped.ok) return gateFail("INVALID_INPUT", stopped.error.code, stopped.error.message);
      const journalled = this.storage.transact((tx) =>
        tx.insertAudit(
          buildAuditRow({
            projectId,
            actor,
            resourceType: "job",
            action: "har.inspect",
            resourceId: job.id,
            decision: "deny",
            reasonCode: "resource-constraint-reference-retained",
            metadata: { evidenceId: outcome.evidenceId },
          }),
        ),
      );
      if (!journalled.ok) {
        return gateFail("INVALID_INPUT", journalled.error.code, journalled.error.message);
      }
      return {
        ok: true,
        value: {
          jobId: job.id,
          jobState: "failed",
          liveState: "failed",
          evidenceIds: [],
          cleanupState: job.cleanupState,
          retainedEvidenceIds: [outcome.evidenceId],
          auditSeq: journalled.value,
        },
      };
    }

    if (outcome.kind === "failure") {
      const failed = this.storage.transact((tx) => {
        tx.updateJob({
          ...job,
          state: "failed",
          errorJson: jobErrorFromFailure(job, outcome),
          updatedAt: nowInstant(),
        });
        const lease = tx.getLeaseByJob(projectId, job.id);
        if (lease !== null) {
          tx.updateLeaseCleanup(lease.id, "failed", { code: outcome.code, reason: outcome.reason }, null, lease.retryCount + 1);
        }
        return true;
      });
      if (!failed.ok) return gateFail("INVALID_INPUT", failed.error.code, failed.error.message);
      return gateFail(outcome.code, outcome.reason, outcome.message);
    }

    const checked = reaEvidenceSchema.safeParse(outcome.envelopeJson);
    if (!checked.success) {
      return gateFail(
        "REA_CONTRACT_MISMATCH",
        "envelope-schema",
        `the producer returned an envelope that violates the mirrored schema at ${issueNames(checked.error.issues).join(",")}`,
      );
    }
    const envelope = checked.data;
    if (!isReaEvidenceId(envelope.evidence_id)) {
      // The mirrored schema proves the shape; this proves the identity is the
      // producer's own form before any index column is written (§4, §5).
      return gateFail("REA_CONTRACT_MISMATCH", "evidence-id-malformed", "the returned evidence id is not an Evidence id");
    }

    const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
    const published = await this.artifacts.publish(projectId, "inspector", envelopeBytes);
    if (!published.ok) {
      return gateFail("CAPABILITY_UNAVAILABLE", published.error.code, "the returned envelope could not be stored");
    }
    const envelopeArtifactId = newId();
    const persisted = this.persist(projectId, actor, job, target, envelope, envelopeArtifactId, published.value.sha256, published.value.storageKey, published.value.byteLength);
    if (!persisted.ok) return persisted;
    // §9 item 6: the record is only safe to let go of once it is in the store, so
    // the connection ledger is cleared after this transaction committed.
    this.ledger.markPersisted(envelope.evidence_id);
    return { ok: true, value: { ...persisted.value.receipt, auditSeq: persisted.value.auditSeq } };
  }

  private persist(
    projectId: Id,
    actor: Actor,
    job: JobRow,
    target: TargetRow,
    envelope: ReaEvidence,
    artifactId: Id,
    sha256: Digest,
    storageKey: string,
    byteLength: number,
  ): Result<{ receipt: InspectionReceipt; auditSeq: number }, GateFailure> {
    const committed = commitDecision<InspectionReceipt>(this.storage, {
      projectId,
      actor,
      resourceType: "job",
      action: "har.inspect",
      resourceId: job.id,
      allowReason: "evidence-persisted",
      metadata: { evidenceId: envelope.evidence_id, sourceSha256: sha256 },
      work: (tx): Step<InspectionReceipt> => {
        const current = tx.getJob(projectId, job.id);
        if (current === null) {
          return { kind: "failure", failure: gateFail("NOT_FOUND", "job-unknown", "job vanished mid-flight") };
        }
        const existing = tx.getEvidence(projectId, envelope.evidence_id);
        if (existing !== null) {
          // The same evidence arriving twice is the resume case, not a second
          // record: the id is the producer's content identity.
          if (existing.artifactId !== artifactId && existing.targetId !== target.id) {
            return {
              kind: "failure",
              failure: gateFail("REA_CONTRACT_MISMATCH", "evidence-target-divergence", "stored evidence points at another target"),
            };
          }
        } else {
          tx.insertArtifact({
            id: artifactId,
            projectId,
            jobId: job.id,
            class: "inspector",
            sha256,
            digestReason: null,
            byteLength,
            storageKey,
            mediaType: "application/json",
            createdAt: nowInstant(),
          });
          tx.insertEvidence({
            projectId,
            id: envelope.evidence_id,
            targetId: target.id,
            jobId: job.id,
            artifactId,
            providerJson: { id: envelope.provider.id, name: envelope.provider.name, version: envelope.provider.version },
            operation: envelope.operation,
            confidence: envelope.confidence,
            authority: envelope.authority,
            createdAt: nowInstant(),
          });
          tx.appendEvent({
            projectId,
            type: "evidence.committed",
            aggregateId: envelope.evidence_id,
            payloadJson: { resourceIds: [envelope.evidence_id, target.id] },
            createdAt: nowInstant(),
          });
        }

        const moved = transition(current, "running", nowInstant());
        const base = moved ?? current;
        const finished = transition(base, "succeeded", nowInstant()) ?? base;
        const updated: JobRow = {
          ...finished,
          state: finished.state === "succeeded" ? "succeeded" : finished.state,
          cleanupState: "complete",
          resultRef: envelope.evidence_id,
          updatedAt: nowInstant(),
        };
        tx.updateJob(updated);
        const lease = tx.getLeaseByJob(projectId, job.id);
        if (lease !== null) {
          // The staging obligation this lease recorded is discharged by the file
          // becoming a referenced artifact, not by deleting it: the retained
          // capture is the analysis product (§5).
          tx.updateLeaseCleanup(lease.id, "complete", null, null, lease.retryCount);
        }
        const eventSeq = tx.appendEvent({
          projectId,
          type: "job.updated",
          aggregateId: job.id,
          payloadJson: { resourceIds: [job.id], state: updated.state, cleanupState: "complete" },
          createdAt: nowInstant(),
        });
        void eventSeq;
        return {
          kind: "committed",
          value: {
            jobId: job.id,
            jobState: updated.state === "succeeded" ? "succeeded" : "failed",
            evidenceIds: [envelope.evidence_id],
            cleanupState: "complete",
            liveState: updated.state,
            retainedEvidenceIds: [],
          },
        };
      },
    });
    if (!committed.ok) return committed;
    return { ok: true, value: { receipt: committed.value.value, auditSeq: committed.value.auditSeq } };
  }
}

function arrayOf(value: JsonValue, field: string): JsonValue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, JsonValue>)[field];
}


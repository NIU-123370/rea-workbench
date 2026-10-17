import { DatabaseSync } from "node:sqlite";

import type { Digest } from "../../domain/canonical-json.ts";
import { asDigest } from "../../domain/canonical-json.ts";
import type { Id, Instant } from "../../domain/identity.ts";
import { asId, asInstant } from "../../domain/identity.ts";
import type { JsonValue } from "../../domain/json-value.ts";
import type { Result } from "../../domain/result.ts";
import { TransactionRefused } from "../../application/decision.ts";
import type { CleanupState, JobState } from "../../contracts/jobs.ts";
import type {
  ArtifactClass,
  ArtifactRow,
  CandidateRow,
  AuditRow,
  CommittedAudit,
  CommittedEvent,
  EventDraft,
  EvidenceRow,
  ExportRow,
  JobIdempotency,
  JobRow,
  LeaseRow,
  VerificationRow,
  ProjectRow,
  StoragePortError,
  StorageTransaction,
  StorageWriterPort,
  BlueprintRow,
  ClaimEvidenceRow,
  ClaimRow,
  GraphEdgeRow,
  ContractRow,
  PlanRow,
  TargetRow,
  VectorRow,
} from "../../application/ports.ts";

// The worker's only SQLite writer (DESIGN §2, §5, D06). Everything runs inside
// one `BEGIN IMMEDIATE` transaction per unit of work, so business rows and their
// outbox events commit or roll back together, and a second writer cannot slip in
// between them.

type Row = Record<string, string | number | null>;

function jsonOf(value: JsonValue): string {
  return JSON.stringify(value);
}

function parseJson(text: string | null): JsonValue | null {
  if (text === null) return null;
  return JSON.parse(text) as JsonValue;
}

function verificationFrom(row: Row): VerificationRow {
  return {
    id: asId(String(row["id"])),
    projectId: asId(String(row["project_id"])),
    candidateId: asId(String(row["candidate_id"])),
    jobId: asId(String(row["job_id"])),
    planId: asId(String(row["plan_id"])),
    planDigest: asDigest(String(row["plan_digest"])),
    inventoryDigest: asDigest(String(row["inventory_digest"])),
    blueprintDigest: asDigest(String(row["blueprint_digest"])),
    vectorSetDigest: asDigest(String(row["vector_set_digest"])),
    comparatorDigest: asDigest(String(row["comparator_digest"])),
    runnerImageDigest: asDigest(String(row["runner_image_digest"])),
    result: String(row["result"]) as VerificationRow["result"],
    currentness: String(row["currentness"]) as VerificationRow["currentness"],
    summaryJson: parseJson(String(row["summary_json"])),
    reportArtifactId: asId(String(row["report_artifact_id"])),
  };
}

function claimFrom(row: Row): ClaimRow {
  return {
    id: asId(String(row["id"])),
    projectId: asId(String(row["project_id"])),
    targetId: asId(String(row["target_id"])),
    entityKey: String(row["entity_key"]),
    claimKey: String(row["claim_key"]),
    assertion: String(row["assertion"]),
    scopeJson: parseJson(String(row["scope_json"])),
    basis: String(row["basis"]) as ClaimRow["basis"],
    sourceState: row["source_state"] === null ? null : String(row["source_state"]),
    coverageJson: parseJson(String(row["coverage_json"])),
    validity: String(row["validity"]) as ClaimRow["validity"],
    revision: Number(row["revision"]),
    unknownReasonsJson: parseJson(String(row["unknown_reasons_json"])),
  };
}

function exportFrom(row: Row): ExportRow {
  return {
    id: asId(String(row["id"])),
    projectId: asId(String(row["project_id"])),
    candidateId: asId(String(row["candidate_id"])),
    verificationId: row["verification_id"] === null ? null : asId(String(row["verification_id"])),
    label: String(row["label"]) as ExportRow["label"],
    artifactId: asId(String(row["artifact_id"])),
    manifestJson: parseJson(String(row["manifest_json"])),
    createdAt: asInstant(String(row["created_at"])),
  };
}

function mapSqliteError(error: unknown): StoragePortError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE constraint failed")) {
    return { code: "UNIQUE_CONFLICT", message: "a row with these unique keys already exists" };
  }
  if (message.includes("FOREIGN KEY constraint failed")) {
    return { code: "FK_VIOLATION", message: "reference does not resolve inside the same project" };
  }
  return { code: "SQLITE_FAILURE", message };
}

class SqliteTransaction implements StorageTransaction {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  insertProject(row: ProjectRow): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, created_at, graph_revision, inventory_revision, schema_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.createdAt,
        row.graphRevision,
        row.inventoryRevision,
        row.schemaVersion,
      );
  }

  getProject(projectId: Id): ProjectRow | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Row | undefined;
    return row ? this.projectRowOf(row) : null;
  }

  listProjectsAfter(afterId: Id | null, limit: number): ProjectRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM projects
         WHERE (? IS NULL OR id > ?) ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, afterId, limit) as Row[];
    return rows.map((row) => this.projectRowOf(row));
  }

  private projectRowOf(row: Row): ProjectRow {
    return {
      id: asId(String(row["id"])),
      name: String(row["name"]),
      createdAt: asInstant(String(row["created_at"])),
      graphRevision: Number(row["graph_revision"]),
      inventoryRevision: Number(row["inventory_revision"]),
      schemaVersion: Number(row["schema_version"]),
    };
  }

  insertTarget(row: TargetRow): void {
    this.db
      .prepare(
        `INSERT INTO targets (id, project_id, kind, original_locator, source_sha256, source_artifact_id, snapshot_digest, identity_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.kind,
        row.originalLocator,
        row.sourceSha256,
        row.sourceArtifactId,
        row.snapshotDigest,
        row.identityReason,
        row.createdAt,
      );
  }

  getTarget(projectId: Id, targetId: Id): TargetRow | null {
    const row = this.db
      .prepare("SELECT * FROM targets WHERE project_id = ? AND id = ?")
      .get(projectId, targetId) as Row | undefined;
    if (!row) return null;
    const sha = row["source_sha256"] === null ? null : String(row["source_sha256"]);
    const snapshot = row["snapshot_digest"] === null ? null : String(row["snapshot_digest"]);
    return {
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      kind: String(row["kind"]) as TargetRow["kind"],
      originalLocator: row["original_locator"] === null ? null : String(row["original_locator"]),
      sourceSha256: sha === null ? null : asDigest(sha),
      sourceArtifactId:
        row["source_artifact_id"] === null ? null : asId(String(row["source_artifact_id"])),
      snapshotDigest: snapshot === null ? null : asDigest(snapshot),
      identityReason: row["identity_reason"] === null ? null : String(row["identity_reason"]),
      createdAt: asInstant(String(row["created_at"])),
    };
  }

  upsertProjectRevision(
    projectId: Id,
    increments: { graph?: number; inventory?: number },
  ): number {
    this.db
      .prepare(
        `UPDATE projects
         SET graph_revision = graph_revision + COALESCE(?, 0),
             inventory_revision = inventory_revision + COALESCE(?, 0)
         WHERE id = ?`,
      )
      .run(increments.graph ?? null, increments.inventory ?? null, projectId);
    const row = this.db
      .prepare("SELECT graph_revision, inventory_revision FROM projects WHERE id = ?")
      .get(projectId) as Row | undefined;
    if (!row) throw new Error("project row missing");
    return Number(row["graph_revision"]);
  }

  insertJob(row: JobRow): JobIdempotency {
    const existing = this.db
      .prepare("SELECT * FROM jobs WHERE project_id = ? AND idempotency_key = ?")
      .get(row.projectId, row.idempotencyKey) as Row | undefined;
    if (existing) {
      const stored = this.rowToJob(existing);
      return stored.requestDigest === row.requestDigest
        ? { outcome: "existing", job: stored }
        : { outcome: "divergent", job: stored };
    }
    this.db
      .prepare(
        `INSERT INTO jobs (id, project_id, target_id, kind, state, cleanup_state, input_json, result_ref, error_json,
                           idempotency_key, request_digest, deadline_at, retry_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.targetId,
        row.kind,
        row.state,
        row.cleanupState,
        jsonOf(row.inputJson),
        row.resultRef,
        row.errorJson === null ? null : jsonOf(row.errorJson),
        row.idempotencyKey,
        row.requestDigest,
        row.deadlineAt,
        row.retryAt,
        row.createdAt,
        row.updatedAt,
      );
    return { outcome: "inserted" };
  }

  updateJob(row: JobRow): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET state = ?, cleanup_state = ?, result_ref = ?, error_json = ?,
             deadline_at = ?, retry_at = ?, updated_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        row.state,
        row.cleanupState,
        row.resultRef,
        row.errorJson === null ? null : jsonOf(row.errorJson),
        row.deadlineAt,
        row.retryAt,
        row.updatedAt,
        row.projectId,
        row.id,
      );
  }

  listJobsByStates(states: readonly JobState[], limit: number): JobRow[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE state IN (${placeholders}) ORDER BY created_at ASC LIMIT ?`)
      .all(...states, limit) as Row[];
    return rows.map((row) => this.rowToJob(row));
  }

  listOpenLeases(states: readonly CleanupState[], limit: number): LeaseRow[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT leases.* FROM resource_leases leases
         JOIN jobs ON jobs.id = leases.job_id
         WHERE leases.cleanup_state IN (${placeholders}) ORDER BY leases.id ASC LIMIT ?`,
      )
      .all(...states, limit) as Row[];
    return rows.map((row) => this.rowToLease(row));
  }

  listJobsAfter(projectId: Id, input: { cursor: { createdAt: Instant; id: Id } | null; limit: number }): JobRow[] {
    const conditions = ["project_id = ?"];
    const args: (string | number)[] = [projectId];
    // A cursor is a whole row key this code issued; `{createdAt, id}` as one object is what
    // makes a half-cursor page from the wrong side of the key unrepresentable.
    if (input.cursor !== null) {
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      args.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...args, input.limit) as Row[];
    return rows.map((row) => this.rowToJob(row));
  }

  listLeasesForJobs(projectId: Id, jobIds: readonly Id[]): LeaseRow[] {
    if (jobIds.length === 0) return [];
    const placeholders = jobIds.map(() => "?").join(",");
    // The join on jobs.project_id is what keeps a caller from naming another project's
    // lease id: the rows come back only when the owning job belongs to this project (§5).
    const rows = this.db
      .prepare(
        `SELECT leases.* FROM resource_leases leases
         JOIN jobs ON jobs.id = leases.job_id
         WHERE jobs.project_id = ? AND leases.job_id IN (${placeholders}) ORDER BY leases.id ASC`,
      )
      .all(projectId, ...jobIds) as Row[];
    return rows.map((row) => this.rowToLease(row));
  }

  private rowToLease(row: Row): LeaseRow {
    return {
      id: asId(String(row["id"])),
      jobId: asId(String(row["job_id"])),
      kind: String(row["kind"]),
      resourceIdentityJson: parseJson(String(row["resource_identity_json"])),
      ownershipProofJson: parseJson(String(row["ownership_proof_json"])),
      cleanupState: String(row["cleanup_state"]) as CleanupState,
      lastErrorJson: parseJson(row["last_error_json"] === null ? null : String(row["last_error_json"])),
      retryAt: row["retry_at"] === null ? null : asInstant(String(row["retry_at"])),
      retryCount: Number(row["retry_count"]),
    };
  }

  findJobByKey(projectId: Id, idempotencyKey: string): JobRow | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE project_id = ? AND idempotency_key = ?")
      .get(projectId, idempotencyKey) as Row | undefined;
    return row ? this.rowToJob(row) : null;
  }

  getJob(projectId: Id, jobId: Id): JobRow | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE project_id = ? AND id = ?").get(projectId, jobId) as
      | Row
      | undefined;
    return row ? this.rowToJob(row) : null;
  }

  private rowToJob(row: Row): JobRow {
    return {
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      targetId: row["target_id"] === null ? null : asId(String(row["target_id"])),
      kind: String(row["kind"]) as JobRow["kind"],
      state: String(row["state"]) as JobRow["state"],
      cleanupState: String(row["cleanup_state"]) as JobRow["cleanupState"],
      inputJson: parseJson(row["input_json"] === undefined ? null : String(row["input_json"])),
      resultRef: row["result_ref"] === null ? null : String(row["result_ref"]),
      errorJson: parseJson(row["error_json"] === null ? null : String(row["error_json"])),
      idempotencyKey: String(row["idempotency_key"]),
      requestDigest: asDigest(String(row["request_digest"])),
      deadlineAt: row["deadline_at"] === null ? null : asInstant(String(row["deadline_at"])),
      retryAt: row["retry_at"] === null ? null : asInstant(String(row["retry_at"])),
      createdAt: asInstant(String(row["created_at"])),
      updatedAt: asInstant(String(row["updated_at"])),
    };
  }

  insertArtifact(row: ArtifactRow): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, job_id, class, sha256, digest_reason, byte_length, storage_key, media_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.jobId,
        row.class,
        row.sha256,
        row.digestReason,
        row.byteLength,
        row.storageKey,
        row.mediaType,
        row.createdAt,
      );
  }

  getArtifact(projectId: Id, artifactId: Id): ArtifactRow | null {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE project_id = ? AND id = ?")
      .get(projectId, artifactId) as Row | undefined;
    if (!row) return null;
    const sha256 = row["sha256"] === null ? null : (asDigest(String(row["sha256"])) as Digest);
    return {
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      jobId: row["job_id"] === null ? null : asId(String(row["job_id"])),
      class: String(row["class"]) as ArtifactRow["class"],
      sha256,
      digestReason: row["digest_reason"] === null ? null : String(row["digest_reason"]),
      byteLength: Number(row["byte_length"]),
      storageKey: String(row["storage_key"]),
      mediaType: String(row["media_type"]),
      createdAt: asInstant(String(row["created_at"])),
    };
  }

  insertEvidence(row: EvidenceRow): void {
    this.db
      .prepare(
        `INSERT INTO evidence_records (project_id, id, target_id, job_id, artifact_id, provider_json, operation, confidence, authority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.projectId,
        row.id,
        row.targetId,
        row.jobId,
        row.artifactId,
        jsonOf(row.providerJson),
        row.operation,
        row.confidence,
        row.authority,
        row.createdAt,
      );
  }

  listEvidenceIdsForTarget(projectId: Id, targetId: Id, limit: number): string[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM evidence_records WHERE project_id = ? AND target_id = ? ORDER BY id ASC LIMIT ?",
      )
      .all(projectId, targetId, limit) as Row[];
    return rows.map((row) => String(row["id"]));
  }

  findImportJobForTarget(projectId: Id, targetId: Id): JobRow | null {
    // An import is the job that *produced* this target's evidence, so a row whose target id is
    // not this one cannot answer it; newest first because a re-import is a new job, not an edit.
    const row = this.db
      .prepare(
        "SELECT * FROM jobs WHERE project_id = ? AND target_id = ? AND kind = 'inspect' ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(projectId, targetId) as Row | undefined;
    return row === undefined ? null : this.rowToJob(row);
  }

  getEvidence(projectId: Id, evidenceId: string): EvidenceRow | null {
    const row = this.db
      .prepare("SELECT * FROM evidence_records WHERE project_id = ? AND id = ?")
      .get(projectId, evidenceId) as Row | undefined;
    if (!row) return null;
    return {
      projectId: asId(String(row["project_id"])),
      id: String(row["id"]),
      targetId: asId(String(row["target_id"])),
      jobId: asId(String(row["job_id"])),
      artifactId: asId(String(row["artifact_id"])),
      providerJson: parseJson(String(row["provider_json"])),
      operation: String(row["operation"]),
      confidence: String(row["confidence"]) as EvidenceRow["confidence"],
      authority: String(row["authority"]),
      createdAt: asInstant(String(row["created_at"])),
    };
  }

  insertVector(row: VectorRow): void {
    this.db
      .prepare(
        `INSERT INTO test_vectors (id, project_id, target_id, evidence_id, source_locator_json,
                                   snapshot_digest, payload_artifact_id, digest, replaces_id, case_key,
                                   visibility, eligibility, reasons_json, review_status, review_record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.targetId,
        row.evidenceId,
        jsonOf(row.sourceLocatorJson),
        row.snapshotDigest,
        row.payloadArtifactId,
        row.digest,
        row.replacesId,
        row.caseKey,
        row.visibility,
        row.eligibility,
        jsonOf(row.reasonsJson),
        row.reviewStatus,
        row.reviewRecordJson === null ? null : jsonOf(row.reviewRecordJson),
      );
  }

  // Only the review columns change: the content and its digest stay byte-for-byte
  // the approved artefact, which is what lets a plan bind a digest (§7.1).
  updateVectorReview(row: VectorRow): void {
    this.db
      .prepare(
        `UPDATE test_vectors
         SET review_status = ?, review_record_json = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(row.reviewStatus, row.reviewRecordJson === null ? null : jsonOf(row.reviewRecordJson), row.projectId, row.id);
  }

  getVector(projectId: Id, vectorId: Id): VectorRow | null {
    const row = this.db
      .prepare("SELECT * FROM test_vectors WHERE project_id = ? AND id = ?")
      .get(projectId, vectorId) as Row | undefined;
    return row ? this.rowToVector(row) : null;
  }

  listVectors(
    projectId: Id,
    filter: { targetId: Id | null; evidenceId: string | null; limit: number },
  ): VectorRow[] {
    const clauses: string[] = ["project_id = ?"];
    const params: (string | number)[] = [projectId];
    if (filter.targetId !== null) {
      clauses.push("target_id = ?");
      params.push(filter.targetId);
    }
    if (filter.evidenceId !== null) {
      clauses.push("evidence_id = ?");
      params.push(filter.evidenceId);
    }
    params.push(filter.limit);
    const rows = this.db
      .prepare(`SELECT * FROM test_vectors WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ?`)
      .all(...params) as Row[];
    return rows.map((row) => this.rowToVector(row));
  }

  listVectorsAfter(
    projectId: Id,
    input: { targetId: Id; afterId: Id | null; publicOnly: boolean; limit: number },
  ): VectorRow[] {
    // The page is cut on `id`, which is the table's own order and does not move when a later
    // row is written: an offset page would silently skip or repeat rows for anyone who paged
    // while a capture landed. `publicOnly` is part of the query rather than a post-filter for
    // the same reason the cut is: a holdout row removed after the fact would make the page
    // shorter than the cursor claims and the next cursor point at a row the caller never saw.
    const clauses = ["project_id = ?", "target_id = ?"];
    const params: (string | number)[] = [projectId, input.targetId];
    if (input.afterId !== null) {
      clauses.push("id > ?");
      params.push(input.afterId);
    }
    if (input.publicOnly) clauses.push("visibility = 'public'");
    params.push(input.limit);
    const rows = this.db
      .prepare(`SELECT * FROM test_vectors WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ?`)
      .all(...params) as Row[];
    return rows.map((row) => this.rowToVector(row));
  }

  private rowToVector(row: Row): VectorRow {
    return {
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      targetId: asId(String(row["target_id"])),
      evidenceId: String(row["evidence_id"]),
      sourceLocatorJson: parseJson(String(row["source_locator_json"])),
      snapshotDigest: asDigest(String(row["snapshot_digest"])),
      payloadArtifactId: asId(String(row["payload_artifact_id"])),
      digest: asDigest(String(row["digest"])),
      replacesId: row["replaces_id"] === null ? null : asId(String(row["replaces_id"])),
      caseKey: String(row["case_key"]),
      visibility: String(row["visibility"]) as VectorRow["visibility"],
      eligibility: String(row["eligibility"]) as VectorRow["eligibility"],
      reasonsJson: parseJson(String(row["reasons_json"])),
      reviewStatus: String(row["review_status"]) as VectorRow["reviewStatus"],
      reviewRecordJson: parseJson(row["review_record_json"] === null ? null : String(row["review_record_json"])),
    };
  }

  listVectorsForSnapshot(projectId: Id, targetId: Id, snapshotDigest: Digest, limit: number): VectorRow[] {
    // The frozen inventory of one plan is exactly its target plus its capture
    // snapshot (§7.4); vectors of another snapshot never enter the denominator.
    const rows = this.db
      .prepare(
        "SELECT * FROM test_vectors WHERE project_id = ? AND target_id = ? AND snapshot_digest = ? ORDER BY id ASC LIMIT ?",
      )
      .all(projectId, targetId, snapshotDigest, limit) as Row[];
    return rows.map((row) => this.rowToVector(row));
  }

  insertContract(row: ContractRow): void {
    this.db
      .prepare(
        `INSERT INTO contract_revisions (id, project_id, target_id, contract_key, revision, payload_json, digest, review_status, review_record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.targetId,
        row.contractKey,
        row.revision,
        jsonOf(row.payloadJson),
        row.digest,
        row.reviewStatus,
        row.reviewRecordJson === null ? null : jsonOf(row.reviewRecordJson),
      );
  }

  updateContractReview(row: ContractRow): void {
    this.db
      .prepare("UPDATE contract_revisions SET review_status = ?, review_record_json = ? WHERE project_id = ? AND id = ?")
      .run(row.reviewStatus, row.reviewRecordJson === null ? null : jsonOf(row.reviewRecordJson), row.projectId, row.id);
  }

  getContract(projectId: Id, contractId: Id): ContractRow | null {
    const row = this.db
      .prepare("SELECT * FROM contract_revisions WHERE project_id = ? AND id = ?")
      .get(projectId, contractId) as Row | undefined;
    if (!row) return null;
    return {
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      targetId: asId(String(row["target_id"])),
      contractKey: String(row["contract_key"]),
      revision: Number(row["revision"]),
      payloadJson: parseJson(String(row["payload_json"])),
      digest: asDigest(String(row["digest"])),
      reviewStatus: String(row["review_status"]) as ContractRow["reviewStatus"],
      reviewRecordJson: parseJson(row["review_record_json"] === null ? null : String(row["review_record_json"])),
    };
  }

  // A revision number is assigned here, not by the caller, so two concurrent
  // drafts of the same contract key cannot both claim revision N.
  latestContractRevision(projectId: Id, contractKey: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM contract_revisions WHERE project_id = ? AND contract_key = ?")
      .get(projectId, contractKey) as Row;
    return Number(row["revision"]);
  }

  insertPlan(row: PlanRow): void {
    this.db
      .prepare(
        `INSERT INTO verification_plans (id, project_id, target_id, snapshot_digest, graph_revision, inventory_revision, inventory_digest, payload_json, digest, review_status, review_record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.targetId,
        row.snapshotDigest,
        row.graphRevision,
        row.inventoryRevision,
        row.inventoryDigest,
        jsonOf(row.payloadJson),
        row.digest,
        row.reviewStatus,
        row.reviewRecordJson === null ? null : jsonOf(row.reviewRecordJson),
        row.createdAt,
      );
  }

  updatePlanReview(row: PlanRow): void {
    this.db
      .prepare("UPDATE verification_plans SET review_status = ?, review_record_json = ? WHERE project_id = ? AND id = ?")
      .run(row.reviewStatus, row.reviewRecordJson === null ? null : jsonOf(row.reviewRecordJson), row.projectId, row.id);
  }

  getPlan(projectId: Id, planId: Id): PlanRow | null {
    const row = this.db
      .prepare("SELECT * FROM verification_plans WHERE project_id = ? AND id = ?")
      .get(projectId, planId) as Row | undefined;
    if (!row) return null;
    return this.rowToPlan(row);
  }

  listPlans(projectId: Id, filter: { targetId: Id | null; limit: number }): PlanRow[] {
    const rows = (
      filter.targetId === null
        ? this.db
            .prepare("SELECT * FROM verification_plans WHERE project_id = ? ORDER BY created_at ASC LIMIT ?")
            .all(projectId, filter.limit)
        : this.db
            .prepare(
              "SELECT * FROM verification_plans WHERE project_id = ? AND target_id = ? ORDER BY created_at ASC LIMIT ?",
            )
            .all(projectId, filter.targetId, filter.limit)
    ) as Row[];
    return rows.map((row) => this.rowToPlan(row));
  }

  private rowToPlan(row: Row): PlanRow {
    return {
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      targetId: asId(String(row["target_id"])),
      snapshotDigest: asDigest(String(row["snapshot_digest"])),
      graphRevision: Number(row["graph_revision"]),
      inventoryRevision: Number(row["inventory_revision"]),
      inventoryDigest: asDigest(String(row["inventory_digest"])),
      payloadJson: parseJson(String(row["payload_json"])),
      digest: asDigest(String(row["digest"])),
      reviewStatus: String(row["review_status"]) as PlanRow["reviewStatus"],
      reviewRecordJson: parseJson(row["review_record_json"] === null ? null : String(row["review_record_json"])),
      createdAt: asInstant(String(row["created_at"])),
    };
  }

  insertBlueprint(row: BlueprintRow): void {
    this.db
      .prepare(
        `INSERT INTO blueprints (id, project_id, target_id, graph_revision, snapshot_digest, verification_plan_id, artifact_id, digest, source_manifest_artifact_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.targetId,
        row.graphRevision,
        row.snapshotDigest,
        row.verificationPlanId,
        row.artifactId,
        row.digest,
        row.sourceManifestArtifactId,
        row.createdAt,
      );
  }

  getBlueprint(projectId: Id, blueprintId: Id): BlueprintRow | null {
    const row = this.db
      .prepare("SELECT * FROM blueprints WHERE project_id = ? AND id = ?")
      .get(projectId, blueprintId) as Row | undefined;
    if (!row) return null;
    return {
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      targetId: asId(String(row["target_id"])),
      graphRevision: Number(row["graph_revision"]),
      snapshotDigest: asDigest(String(row["snapshot_digest"])),
      verificationPlanId: asId(String(row["verification_plan_id"])),
      artifactId: asId(String(row["artifact_id"])),
      digest: asDigest(String(row["digest"])),
      sourceManifestArtifactId: asId(String(row["source_manifest_artifact_id"])),
      createdAt: asInstant(String(row["created_at"])),
    };
  }

  findArtifactByDigest(projectId: Id, class_: ArtifactClass, sha256: Digest): ArtifactRow | null {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE project_id = ? AND class = ? AND sha256 = ?")
      .get(projectId, class_, sha256) as Row | undefined;
    if (row === undefined) return null;
    return {
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      jobId: row["job_id"] === null ? null : asId(String(row["job_id"])),
      class: String(row["class"]) as ArtifactClass,
      sha256: row["sha256"] === null ? null : asDigest(String(row["sha256"])),
      digestReason: row["digest_reason"] === null ? null : String(row["digest_reason"]),
      byteLength: Number(row["byte_length"]),
      storageKey: String(row["storage_key"]),
      mediaType: String(row["media_type"]),
      createdAt: asInstant(String(row["created_at"])),
    };
  }

  insertCandidate(row: CandidateRow): void {
    this.db
      .prepare(
        `INSERT INTO candidates (id, project_id, blueprint_id, job_id, artifact_id, digest, generator_json, dependency_manifest_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.blueprintId,
        row.jobId,
        row.artifactId,
        row.digest,
        JSON.stringify(row.generatorJson),
        JSON.stringify(row.dependencyManifestJson),
      );
  }

  getCandidate(projectId: Id, candidateId: Id): CandidateRow | null {
    const row = this.db
      .prepare("SELECT * FROM candidates WHERE project_id = ? AND id = ?")
      .get(projectId, candidateId) as Row | undefined;
    if (!row) return null;
    return {
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      blueprintId: asId(String(row["blueprint_id"])),
      jobId: asId(String(row["job_id"])),
      artifactId: asId(String(row["artifact_id"])),
      digest: asDigest(String(row["digest"])),
      generatorJson: parseJson(String(row["generator_json"])),
      dependencyManifestJson: parseJson(String(row["dependency_manifest_json"])),
    };
  }

  listCandidatesForBlueprint(projectId: Id, blueprintId: Id): CandidateRow[] {
    const rows = this.db
      .prepare("SELECT * FROM candidates WHERE project_id = ? AND blueprint_id = ? ORDER BY rowid")
      .all(projectId, blueprintId) as Row[];
    return rows.map((row) => ({
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      blueprintId: asId(String(row["blueprint_id"])),
      jobId: asId(String(row["job_id"])),
      artifactId: asId(String(row["artifact_id"])),
      digest: asDigest(String(row["digest"])),
      generatorJson: parseJson(String(row["generator_json"])),
      dependencyManifestJson: parseJson(String(row["dependency_manifest_json"])),
    }));
  }

  insertVerification(row: VerificationRow): void {
    this.db
      .prepare(
        `INSERT INTO verifications (id, project_id, candidate_id, job_id, plan_id, plan_digest, inventory_digest, blueprint_digest, vector_set_digest, comparator_digest, runner_image_digest, result, currentness, summary_json, report_artifact_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.candidateId,
        row.jobId,
        row.planId,
        row.planDigest,
        row.inventoryDigest,
        row.blueprintDigest,
        row.vectorSetDigest,
        row.comparatorDigest,
        row.runnerImageDigest,
        row.result,
        row.currentness,
        JSON.stringify(row.summaryJson),
        row.reportArtifactId,
      );
  }

  getVerification(projectId: Id, verificationId: Id): VerificationRow | null {
    const row = this.db
      .prepare("SELECT * FROM verifications WHERE project_id = ? AND id = ?")
      .get(projectId, verificationId) as Row | undefined;
    if (!row) return null;
    return verificationFrom(row);
  }

  // A candidate may be re-verified; the newest row is the one whose currentness is
  // reported, and the older ones stay readable as their own immutable records.
  listVerificationsForCandidate(projectId: Id, candidateId: Id): VerificationRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM verifications WHERE project_id = ? AND candidate_id = ? ORDER BY rowid",
      )
      .all(projectId, candidateId) as Row[];
    return rows.map(verificationFrom);
  }

  insertExport(row: ExportRow): void {
    this.db
      .prepare(
        `INSERT INTO exports (id, project_id, candidate_id, verification_id, label, artifact_id, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.candidateId,
        row.verificationId,
        row.label,
        row.artifactId,
        JSON.stringify(row.manifestJson),
        row.createdAt,
      );
  }

  getExport(projectId: Id, exportId: Id): ExportRow | null {
    const row = this.db
      .prepare("SELECT * FROM exports WHERE project_id = ? AND id = ?")
      .get(projectId, exportId) as Row | undefined;
    return row === undefined ? null : exportFrom(row);
  }

  // Ordered by creation so a caller can see the sequence of packages, and bounded
  // because a project's export list is not a place to stream unbounded rows (§8).
  listExportsForProject(projectId: Id, limit: number): ExportRow[] {
    const rows = this.db
      .prepare("SELECT * FROM exports WHERE project_id = ? ORDER BY created_at ASC, id ASC LIMIT ?")
      .all(projectId, limit) as Row[];
    return rows.map(exportFrom);
  }

  listClaimsForTarget(projectId: Id, targetId: Id, limit: number): ClaimRow[] {
    const rows = this.db
      .prepare("SELECT * FROM claims WHERE project_id = ? AND target_id = ? ORDER BY entity_key ASC, id ASC LIMIT ?")
      .all(projectId, targetId, limit) as Row[];
    return rows.map(claimFrom);
  }

  listTargetsForProject(projectId: Id, limit: number): TargetRow[] {
    const rows = this.db
      .prepare("SELECT * FROM targets WHERE project_id = ? ORDER BY created_at DESC, id ASC LIMIT ?")
      .all(projectId, limit) as Row[];
    return rows.map((row) => ({
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      kind: String(row["kind"]) as TargetRow["kind"],
      originalLocator: row["original_locator"] === null ? null : String(row["original_locator"]),
      sourceSha256: row["source_sha256"] === null ? null : asDigest(String(row["source_sha256"])),
      sourceArtifactId: row["source_artifact_id"] === null ? null : asId(String(row["source_artifact_id"])),
      snapshotDigest: row["snapshot_digest"] === null ? null : asDigest(String(row["snapshot_digest"])),
      identityReason: row["identity_reason"] === null ? null : String(row["identity_reason"]),
      createdAt: asInstant(String(row["created_at"])),
    }));
  }

  insertGraphEdge(row: GraphEdgeRow): void {
    this.db
      .prepare(
        `INSERT INTO graph_edges (id, project_id, target_id, from_key, to_key, relation, claim_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.projectId, row.targetId, row.fromKey, row.toKey, row.relation, row.claimId);
  }

  listEdges(projectId: Id, targetId: Id): GraphEdgeRow[] {
    const rows = this.db
      .prepare("SELECT * FROM graph_edges WHERE project_id = ? AND target_id = ? ORDER BY id ASC")
      .all(projectId, targetId) as Row[];
    return rows.map((row) => ({
      id: asId(String(row["id"])),
      projectId: asId(String(row["project_id"])),
      targetId: asId(String(row["target_id"])),
      fromKey: String(row["from_key"]),
      toKey: String(row["to_key"]),
      relation: String(row["relation"]),
      claimId: asId(String(row["claim_id"])),
    }));
  }

  listClaimEvidence(projectId: Id, claimId: Id): { evidenceId: string; locationJson: JsonValue; role: "support" | "contradict" }[] {
    const rows = this.db
      .prepare("SELECT * FROM claim_evidence WHERE project_id = ? AND claim_id = ? ORDER BY evidence_id ASC, role ASC")
      .all(projectId, claimId) as Row[];
    return rows.map((row) => ({
      evidenceId: String(row["evidence_id"]),
      locationJson: parseJson(String(row["location_json"])),
      role: String(row["role"]) as "support" | "contradict",
    }));
  }

  insertClaim(row: ClaimRow): void {
    this.db
      .prepare(
        `INSERT INTO claims (id, project_id, target_id, entity_key, claim_key, assertion, scope_json, basis, source_state, coverage_json, validity, revision, unknown_reasons_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.targetId,
        row.entityKey,
        row.claimKey,
        row.assertion,
        jsonOf(row.scopeJson),
        row.basis,
        row.sourceState,
        jsonOf(row.coverageJson),
        row.validity,
        row.revision,
        jsonOf(row.unknownReasonsJson),
      );
  }

  getClaim(projectId: Id, claimId: Id): ClaimRow | null {
    const row = this.db
      .prepare("SELECT * FROM claims WHERE project_id = ? AND id = ?")
      .get(projectId, claimId) as Row | undefined;
    if (!row) return null;
    return claimFrom(row);
  }

  insertClaimEvidence(row: ClaimEvidenceRow): void {
    this.db
      .prepare(
        `INSERT INTO claim_evidence (project_id, claim_id, evidence_id, location_json, role)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.projectId, row.claimId, row.evidenceId, jsonOf(row.locationJson), row.role);
  }

  // A counter-evidence link can never be dropped by excluding the vector that
  // cites it (§7.4), so the ids are read straight from the link table.
  contradictingEvidenceIds(projectId: Id, claimIds: readonly Id[]): string[] {
    if (claimIds.length === 0) return [];
    const placeholders = claimIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT evidence_id FROM claim_evidence
         WHERE project_id = ? AND role = 'contradict' AND claim_id IN (${placeholders})
         ORDER BY evidence_id ASC`,
      )
      .all(projectId, ...claimIds) as Row[];
    return rows.map((row) => String(row["evidence_id"]));
  }

  appendEvent(draft: EventDraft): number {
    const result = this.db
      .prepare("INSERT INTO events (project_id, type, aggregate_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(draft.projectId, draft.type, draft.aggregateId, jsonOf(draft.payloadJson), draft.createdAt);
    return Number(result.lastInsertRowid);
  }

  eventsAfter(projectId: Id, afterSeq: number, limit: number): CommittedEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(projectId, afterSeq, limit) as Row[];
    return rows.map((row) => ({
      seq: Number(row["seq"]),
      projectId: asId(String(row["project_id"])),
      type: String(row["type"]),
      aggregateId: String(row["aggregate_id"]),
      payloadJson: parseJson(String(row["payload_json"])),
      createdAt: asInstant(String(row["created_at"])),
    }));
  }

  insertLease(row: LeaseRow): void {
    this.db
      .prepare(
        `INSERT INTO resource_leases (id, job_id, kind, resource_identity_json, ownership_proof_json, cleanup_state, last_error_json, retry_at, retry_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.jobId,
        row.kind,
        jsonOf(row.resourceIdentityJson),
        jsonOf(row.ownershipProofJson),
        row.cleanupState,
        row.lastErrorJson === null ? null : jsonOf(row.lastErrorJson),
        row.retryAt,
        row.retryCount,
      );
  }

  getLeaseByJob(projectId: Id, jobId: Id): LeaseRow | null {
    // The lease belongs to a job of this project; a caller cannot reach another
    // project's lease by guessing an id.
    const row = this.db
      .prepare("SELECT leases.* FROM resource_leases leases JOIN jobs ON jobs.id = leases.job_id WHERE jobs.project_id = ? AND leases.job_id = ?")
      .get(projectId, jobId) as Row | undefined;
    if (!row) return null;
    return this.rowToLease(row);
  }

  updateLeaseCleanup(
    leaseId: Id,
    cleanupState: CleanupState,
    lastErrorJson: JsonValue | null,
    retryAt: Instant | null,
    retryCount: number,
  ): void {
    this.db
      .prepare("UPDATE resource_leases SET cleanup_state = ?, last_error_json = ?, retry_at = ?, retry_count = ? WHERE id = ?")
      .run(cleanupState, lastErrorJson === null ? null : jsonOf(lastErrorJson), retryAt, retryCount, leaseId);
  }

  insertAudit(row: AuditRow): number {
    const result = this.db
      .prepare(
        `INSERT INTO audit_entries (project_id, actor_id, actor_kind, action, resource_type, resource_id, decision, reason_code, safe_metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.projectId,
        row.actorId,
        row.actorKind,
        row.action,
        row.resourceType,
        row.resourceId,
        row.decision,
        row.reasonCode,
        jsonOf(row.safeMetadataJson),
        row.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  auditAfter(afterSeq: number, projectId: Id | null, limit: number): CommittedAudit[] {
    const rows = (
      projectId === null
        ? this.db
            .prepare("SELECT * FROM audit_entries WHERE seq > ? AND project_id IS NULL ORDER BY seq ASC LIMIT ?")
            .all(afterSeq, limit)
        : this.db
            .prepare("SELECT * FROM audit_entries WHERE seq > ? AND project_id = ? ORDER BY seq ASC LIMIT ?")
            .all(afterSeq, projectId, limit)
    ) as Row[];
    return rows.map((row) => ({
      seq: Number(row["seq"]),
      projectId: row["project_id"] === null ? null : asId(String(row["project_id"])),
      actorId: String(row["actor_id"]),
      actorKind: String(row["actor_kind"]),
      action: String(row["action"]),
      resourceType: String(row["resource_type"]),
      resourceId: row["resource_id"] === null ? null : String(row["resource_id"]),
      decision: String(row["decision"]) as CommittedAudit["decision"],
      reasonCode: String(row["reason_code"]),
      safeMetadataJson: parseJson(String(row["safe_metadata_json"])),
      createdAt: asInstant(String(row["created_at"])),
    }));
  }

  latestSeq(projectId: Id): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project_id = ?")
      .get(projectId) as Row;
    return Number(row["seq"]);
  }
}

export class SqliteStorageWriter implements StorageWriterPort {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  transact<T>(work: (tx: StorageTransaction) => T): Result<T, StoragePortError> {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const value = work(new SqliteTransaction(this.db));
      this.db.exec("COMMIT");
      return { ok: true, value };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction already ended; the caller sees the original failure.
      }
      // A business refusal is not a storage failure: it propagates so the caller
      // can report the named reason it refused for, after the rollback.
      if (error instanceof TransactionRefused) throw error;
      return { ok: false, error: mapSqliteError(error) };
    }
  }
}

import { DatabaseSync } from "node:sqlite";

import type { Digest } from "../../domain/canonical-json.ts";
import { asDigest } from "../../domain/canonical-json.ts";
import type { Id } from "../../domain/identity.ts";
import { asId, asInstant } from "../../domain/identity.ts";
import type { JsonValue } from "../../domain/json-value.ts";
import type { Result } from "../../domain/result.ts";
import type {
  ArtifactRow,
  AuditRow,
  CommittedAudit,
  CommittedEvent,
  EventDraft,
  EvidenceRow,
  JobIdempotency,
  JobRow,
  LeaseRow,
  ProjectRow,
  StoragePortError,
  StorageTransaction,
  StorageWriterPort,
  TargetRow,
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
    if (!row) return null;
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
      return { ok: false, error: mapSqliteError(error) };
    }
  }
}

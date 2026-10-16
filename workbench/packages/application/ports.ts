import type { Digest } from "../domain/canonical-json.ts";
import type { Id, Instant } from "../domain/identity.ts";
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import type { CleanupState, JobKind, JobState } from "../contracts/jobs.ts";

// Ports that `packages/adapters/storage` implements (DESIGN §3). They exist so
// the application layer can hold a transaction without knowing SQLite exists:
// only the worker's StorageWriter may write, and the API never opens this
// connection (D06).

export type ArtifactClass = "inspector" | "blueprint" | "candidate" | "report";

export type ArtifactRow = {
  id: Id;
  projectId: Id;
  jobId: Id | null;
  class: ArtifactClass;
  sha256: Digest | null;
  // When a digest is withheld, the reason is stored instead — never a guess.
  digestReason: string | null;
  byteLength: number;
  storageKey: string;
  mediaType: string;
  createdAt: Instant;
};

export type JobRow = {
  id: Id;
  projectId: Id;
  targetId: Id | null;
  kind: JobKind;
  state: JobState;
  cleanupState: CleanupState;
  inputJson: JsonValue;
  resultRef: string | null;
  errorJson: JsonValue | null;
  idempotencyKey: string;
  requestDigest: Digest;
  deadlineAt: Instant | null;
  retryAt: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
};

export type EvidenceRow = {
  projectId: Id;
  id: string;
  targetId: Id;
  jobId: Id;
  artifactId: Id;
  providerJson: JsonValue;
  operation: string;
  confidence: "observed" | "derived" | "inferred";
  authority: string;
  createdAt: Instant;
};

export type EventDraft = {
  projectId: Id;
  type: string;
  aggregateId: string;
  payloadJson: JsonValue;
  createdAt: Instant;
};

export type CommittedEvent = EventDraft & { seq: number };

export type TargetRow = {
  id: Id;
  projectId: Id;
  kind: "url" | "har" | "asar";
  originalLocator: string | null;
  sourceSha256: Digest | null;
  sourceArtifactId: Id | null;
  snapshotDigest: Digest | null;
  identityReason: string | null;
  createdAt: Instant;
};

export type ProjectRow = {
  id: Id;
  name: string;
  createdAt: Instant;
  graphRevision: number;
  inventoryRevision: number;
  schemaVersion: number;
};

export type LeaseRow = {
  id: Id;
  jobId: Id;
  kind: string;
  resourceIdentityJson: JsonValue;
  ownershipProofJson: JsonValue;
  cleanupState: CleanupState;
  lastErrorJson: JsonValue | null;
  retryAt: Instant | null;
  retryCount: number;
};

export type StoragePortError = {
  code:
    | "SQLITE_FAILURE"
    | "FK_VIOLATION"
    | "UNIQUE_CONFLICT"
    | "ARTIFACT_MISMATCH"
    | "STAGING_UNVERIFIED";
  message: string;
};

// Idempotency is a storage-level fact so two concurrent retries cannot both
// start work: the same key with the same safe request digest returns the stored
// job, a different payload is a conflict the caller must turn into 409 (§8).
export type JobIdempotency =
  | { outcome: "inserted" }
  | { outcome: "existing"; job: JobRow }
  | { outcome: "divergent"; job: JobRow };

// A transaction handle. Implementations run the callback inside one SQLite
// transaction: business rows and their events commit together, and a rejection
// rolls everything back (DESIGN §5, §12.2).
export type StorageTransaction = {
  insertProject(row: ProjectRow): void;
  getProject(projectId: Id): ProjectRow | null;
  insertTarget(row: TargetRow): void;
  upsertProjectRevision(projectId: Id, increments: { graph?: number; inventory?: number }): number;
  insertJob(row: JobRow): JobIdempotency;
  updateJob(row: JobRow): void;
  getJob(projectId: Id, jobId: Id): JobRow | null;
  insertArtifact(row: ArtifactRow): void;
  getArtifact(projectId: Id, artifactId: Id): ArtifactRow | null;
  insertEvidence(row: EvidenceRow): void;
  appendEvent(draft: EventDraft): number;
  eventsAfter(projectId: Id, afterSeq: number, limit: number): CommittedEvent[];
  insertLease(row: LeaseRow): void;
  insertAudit(row: AuditRow): number;
  auditAfter(afterSeq: number, projectId: Id | null, limit: number): CommittedAudit[];
  latestSeq(projectId: Id): number;
};

export type AuditRow = {
  projectId: Id | null;
  actorId: string;
  actorKind: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  decision: "allow" | "deny";
  reasonCode: string;
  // Already passed through DiagnosticsSanitizer: named non-body facts only.
  safeMetadataJson: JsonValue;
  createdAt: Instant;
};

export type CommittedAudit = AuditRow & { seq: number };

export type StorageWriterPort = {
  transact<T>(work: (tx: StorageTransaction) => T): Result<T, StoragePortError>;
};

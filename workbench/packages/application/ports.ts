import type { Coverage, Redaction } from "../domain/evidence.ts";
import type { Digest } from "../domain/canonical-json.ts";
import type { Id, Instant } from "../domain/identity.ts";
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import type { RequestSide, ResponseSide, VectorSource } from "../domain/vector.ts";
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

export type VectorRow = {
  id: Id;
  projectId: Id;
  targetId: Id;
  evidenceId: string;
  sourceLocatorJson: JsonValue;
  snapshotDigest: Digest;
  payloadArtifactId: Id;
  digest: Digest;
  replacesId: Id | null;
  caseKey: string;
  visibility: "public" | "holdout";
  eligibility: "usable" | "blocked";
  reasonsJson: JsonValue;
  reviewStatus: "draft" | "approved" | "rejected";
  reviewRecordJson: JsonValue | null;
};

export type ContractRow = {
  id: Id;
  projectId: Id;
  targetId: Id;
  contractKey: string;
  revision: number;
  payloadJson: JsonValue;
  digest: Digest;
  reviewStatus: "draft" | "approved" | "rejected";
  reviewRecordJson: JsonValue | null;
};

export type PlanRow = {
  id: Id;
  projectId: Id;
  targetId: Id;
  snapshotDigest: Digest;
  graphRevision: number;
  inventoryRevision: number;
  inventoryDigest: Digest;
  payloadJson: JsonValue;
  digest: Digest;
  reviewStatus: "draft" | "approved" | "rejected";
  reviewRecordJson: JsonValue | null;
  createdAt: Instant;
};

// Claims are read by the contract and plan gates (DESIGN §7.2 recomputes every
// required claim's provenance) and written by the graph projection.
export type ClaimRow = {
  id: Id;
  projectId: Id;
  targetId: Id;
  entityKey: string;
  claimKey: string;
  assertion: string;
  scopeJson: JsonValue;
  basis: "observed" | "derived" | "inferred" | "unknown";
  sourceState: string | null;
  coverageJson: JsonValue;
  validity: "current" | "stale" | "contradicted";
  revision: number;
  unknownReasonsJson: JsonValue;
};

export type ClaimEvidenceRow = {
  projectId: Id;
  claimId: Id;
  evidenceId: string;
  locationJson: JsonValue;
  role: "support" | "contradict";
};

export type BlueprintRow = {
  id: Id;
  projectId: Id;
  targetId: Id;
  graphRevision: number;
  snapshotDigest: Digest;
  verificationPlanId: Id;
  artifactId: Id;
  digest: Digest;
  sourceManifestArtifactId: Id;
  createdAt: Instant;
};

export type GraphEdgeRow = {
  id: Id;
  projectId: Id;
  targetId: Id;
  fromKey: string;
  toKey: string;
  relation: string;
  claimId: Id;
};

// The producer call the ingestion loop makes. It is a port so the ingestion
// service cannot reach a network client, a shell or a Docker socket: the only
// thing it can ask for is an inspection of a file the workbench itself staged
// (DESIGN §8 ingestion, §9, D25).
export type CaptureInspectionRequest = {
  capturePath: string;
  format: "har";
  recordOrdinals: number[] | null;
  // Lives only for this call. Nothing in the persistence path reads it back, and
  // no field of it is stored or journalled.
  sensitiveValues: readonly string[];
};

export type CaptureInspectionOutcome =
  | { kind: "evidence"; envelopeJson: JsonValue }
  | {
      kind: "retained-reference";
      evidenceId: string;
      reason: string;
      // §9 item 7: the producer tells the caller to consume the retained record
      // instead of re-running the operation.
      continuationName: string | null;
    }
  | {
      kind: "failure";
      code: "REA_CONTRACT_MISMATCH" | "CAPABILITY_UNAVAILABLE" | "STALE_INPUT" | "UNSUPPORTED_FORMAT" | "INVALID_INPUT";
      reason: string;
      message: string;
    };

export type CaptureInspectorPort = {
  inspect(input: CaptureInspectionRequest): Promise<CaptureInspectionOutcome>;
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
  getTarget(projectId: Id, targetId: Id): TargetRow | null;
  upsertProjectRevision(projectId: Id, increments: { graph?: number; inventory?: number }): number;
  insertJob(row: JobRow): JobIdempotency;
  updateJob(row: JobRow): void;
  getJob(projectId: Id, jobId: Id): JobRow | null;
  findJobByKey(projectId: Id, idempotencyKey: string): JobRow | null;
  insertArtifact(row: ArtifactRow): void;
  getArtifact(projectId: Id, artifactId: Id): ArtifactRow | null;
  insertEvidence(row: EvidenceRow): void;
  getEvidence(projectId: Id, evidenceId: string): EvidenceRow | null;
  insertVector(row: VectorRow): void;
  updateVectorReview(row: VectorRow): void;
  getVector(projectId: Id, vectorId: Id): VectorRow | null;
  listVectors(
    projectId: Id,
    filter: { targetId: Id | null; evidenceId: string | null; limit: number },
  ): VectorRow[];
  listVectorsForSnapshot(
    projectId: Id,
    targetId: Id,
    snapshotDigest: Digest,
    limit: number,
  ): VectorRow[];
  insertContract(row: ContractRow): void;
  updateContractReview(row: ContractRow): void;
  getContract(projectId: Id, contractId: Id): ContractRow | null;
  latestContractRevision(projectId: Id, contractKey: string): number;
  insertPlan(row: PlanRow): void;
  updatePlanReview(row: PlanRow): void;
  getPlan(projectId: Id, planId: Id): PlanRow | null;
  listPlans(projectId: Id, filter: { targetId: Id | null; limit: number }): PlanRow[];
  insertBlueprint(row: BlueprintRow): void;
  getBlueprint(projectId: Id, blueprintId: Id): BlueprintRow | null;
  insertGraphEdge(row: GraphEdgeRow): void;
  listEdges(projectId: Id, targetId: Id): GraphEdgeRow[];
  listClaimEvidence(projectId: Id, claimId: Id): { evidenceId: string; locationJson: JsonValue; role: "support" | "contradict" }[];
  insertClaim(row: ClaimRow): void;
  getClaim(projectId: Id, claimId: Id): ClaimRow | null;
  insertClaimEvidence(row: ClaimEvidenceRow): void;
  contradictingEvidenceIds(projectId: Id, claimIds: readonly Id[]): string[];
  appendEvent(draft: EventDraft): number;
  eventsAfter(projectId: Id, afterSeq: number, limit: number): CommittedEvent[];
  insertLease(row: LeaseRow): void;
  getLeaseByJob(projectId: Id, jobId: Id): LeaseRow | null;
  // CleanupService owns the retry schedule (§5), so the only thing a caller may
  // change is the recorded state, its safe error and the next retry time.
  updateLeaseCleanup(
    leaseId: Id,
    cleanupState: CleanupState,
    lastErrorJson: JsonValue | null,
    retryAt: Instant | null,
    retryCount: number,
  ): void;
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

// Artifact store as the application layer sees it (DESIGN §5 line 126, §12).
// The shapes mirror `packages/adapters/storage/artifacts.ts` structurally so a
// service can hold the port without importing the filesystem adapter.
export type PublishedFile = {
  storageKey: string;
  byteLength: number;
  sha256: Digest;
};

export type ArtifactPortError = {
  code: "STAGING_UNVERIFIED" | "ARTIFACT_MISMATCH" | "ARTIFACT_WRITE_FAILED";
  message: string;
};

export type ArtifactPort = {
  publish(
    projectId: Id,
    // Named `class_` because `class` is reserved in a parameter position; the
    // adapter's own parameter is positional, so the spelling stays local here.
    class_: ArtifactClass,
    bytes: Uint8Array,
    declaredSha256?: Digest,
  ): Promise<Result<PublishedFile, ArtifactPortError>>;
  read(projectId: Id, storageKey: string): Promise<Result<Uint8Array, ArtifactPortError>>;
  // Resolves a key this store published into the absolute path the producer must
  // be given. Returns null for anything it did not mint.
  absolutePathFor(projectId: Id, storageKey: string): string | null;
};

// The parsed facts of one recorded request/response pair, as the producer
// actually reported them (DESIGN §7.1: VectorService extracts, callers submit
// nothing). A field the producer could not keep arrives as null plus a reason —
// never as an empty string, a zero status or a guessed method.
export type EvidenceRecordFacts = {
  evidenceId: string;
  projectId: Id;
  targetId: Id;
  snapshotDigest: Digest;
  operation: string;
  authority: string;
  confidence: "observed" | "derived" | "inferred";
  source: VectorSource;
  request: RequestSide;
  response: ResponseSide;
  coverage: Coverage;
  limitations: string[];
  redactions: Redaction[];
  // The capture declared sensitive values for this record, so no projection of
  // it may be persisted at all (issue #15, #24).
  sensitiveDeclared: boolean;
};

export type EvidenceFactsFailure = {
  code: "REA_CONTRACT_MISMATCH" | "NOT_FOUND" | "INVALID_INPUT" | "UNSUPPORTED_FORMAT";
  reason: string;
  message: string;
};

export type EvidenceFactsPort = {
  readRecord(input: {
    projectId: Id;
    evidenceId: string;
    coordinate: VectorSource;
  }): Promise<Result<EvidenceRecordFacts, EvidenceFactsFailure>>;
};

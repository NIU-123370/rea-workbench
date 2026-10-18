import { asDigest, digestBytes } from "../domain/canonical-json.ts";
import type { CanonicalLimits, Digest } from "../domain/canonical-json.ts";
import { newId, nowInstant } from "../domain/identity.ts";
import type { Id, Instant } from "../domain/identity.ts";
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import type { ExportLabel, ExportManifestContent } from "../domain/export.ts";
import {
  coverageOf,
  downloadUrlFor,
  declaredPackageEntries,
  exportStatusDefects,
  packageEntryDefects,
  statusNoteFor,
} from "../domain/export.ts";
import { deliverability, staleReasons } from "../domain/report.ts";
import type { CleanupState } from "../contracts/jobs.ts";
import type { ZipLimits } from "../domain/zip.ts";
import { buildZipArchive } from "../domain/zip.ts";
import { builderBlueprintSchema } from "../contracts/blueprint.ts";
import { exportManifestSchema } from "../contracts/export.ts";
import type { Actor } from "./actor.ts";
import { isBuilder } from "./actor.ts";
import { commitDecision, recordDeny, type Step } from "./decision.ts";
import { blockedByReasons, gateFail, type GateFailure } from "./gate-failure.ts";
import type { ArtifactPort, StorageWriterPort } from "./ports.ts";
import type { VerificationService } from "./verification-service.ts";

// Export packages and the verified-samples gate (DESIGN §10, §11, §8 / PRD F11, issue #22).
//
// Two rules own this file.
//
//   1. A package is a *copy of frozen facts*, never a re-measurement. Every entry is
//      bytes the store already holds (the candidate's three files, the blueprint handoff,
//      the published report) plus a manifest and a coverage projection whose numbers come
//      out of that report. Nothing here recomputes a pass rate or a digest chain.
//   2. `verified-samples` is decided by `deliverability()` — the owner in
//      `packages/domain/report.ts` that no other module may restate — and the same gate
//      is re-run at download, because §10 forbids an expired report carrying a pass
//      label out the door.

export type ExportCommit = {
  id: Id;
  label: ExportLabel;
  downloadUrl: string;
  sha256: Digest;
  byteLength: number;
  createdAt: Instant;
  manifest: ExportManifestContent;
};

export type ExportArchive = {
  exportId: Id;
  sha256: Digest;
  byteLength: number;
  mediaType: string;
  bytes: Uint8Array;
};

const MEDIA_TYPE = "application/zip";

export class ExportService {
  readonly storage: StorageWriterPort;
  readonly artifacts: ArtifactPort;
  readonly verification: VerificationService;
  readonly limits: CanonicalLimits;
  readonly zipLimits: ZipLimits;

  constructor(deps: {
    storage: StorageWriterPort;
    artifacts: ArtifactPort;
    verification: VerificationService;
    limits: CanonicalLimits;
    zipLimits: ZipLimits;
  }) {
    this.storage = deps.storage;
    this.artifacts = deps.artifacts;
    this.verification = deps.verification;
    this.limits = deps.limits;
    this.zipLimits = deps.zipLimits;
  }

  // The Builder may not assemble a package: it would be reading a published report
  // through the delivery path, and §7.3 keeps that report on the other side of the seam.
  private refused(projectId: Id, actor: Actor, action: string): Result<never, GateFailure> | null {
    if (!isBuilder(actor)) return null;
    // The denial is journalled before anything else happens: §12.2 asks for the refusal,
    // not merely the error the caller sees.
    recordDeny(this.storage, {
      projectId,
      actor,
      resourceType: "export",
      action: `export.${action}`,
      resourceId: null,
      decision: "deny",
      reasonCode: "builder-may-not-export",
      metadata: {},
    });
    return gateFail("ACCESS_DENIED", "builder-may-not-export", `export.${action} is not the Builder's operation`);
  }

  async create(
    projectId: Id,
    actor: Actor,
    input: { candidateId: Id; verificationId: Id | null; label: ExportLabel },
  ): Promise<Result<ExportCommit, GateFailure>> {
    const refused = this.refused(projectId, actor, "create");
    if (refused !== null) return refused;

    const rows = this.storage.transact((tx) => {
      const candidate = tx.getCandidate(projectId, input.candidateId);
      if (candidate === null) return null;
      const blueprint = tx.getBlueprint(projectId, candidate.blueprintId);
      if (blueprint === null) return null;
      const verification = input.verificationId === null ? null : tx.getVerification(projectId, input.verificationId);
      if (input.verificationId !== null && verification === null) return { missing: "verification" as const, candidate, blueprint, verification: null };
      // When a verification is bound, its own job is the one whose cleanup has to be
      // finished (§11); the candidate's build job stays the reference for a draft, where
      // nothing was verified and the analysis task is the only resource in flight.
      const owner = verification ?? candidate;
      const job = tx.getJob(projectId, owner.jobId);
      const lease = tx.getLeaseByJob(projectId, owner.jobId);
      return { missing: null as null, candidate, blueprint, verification, job, lease };
    });
    if (!rows.ok) return gateFail("INVALID_INPUT", rows.error.code, rows.error.message);
    const loaded = rows.value;
    if (loaded === null) {
      return gateFail("NOT_FOUND", "candidate-unknown", "no such candidate in this project");
    }
    if ("missing" in loaded && loaded.missing === "verification") {
      return gateFail("NOT_FOUND", "verification-unknown", "no such verification in this project");
    }
    const candidate = loaded.candidate;
    const blueprint = loaded.blueprint;
    const verification = loaded.verification;
    const bound = verification !== null;

    // Cleanup is a separate fact from the comparison (§11): the job's own state and the
    // lease it left both have to say complete, and `pending` is never inferred from a
    // succeeded job.
    const cleanupState = worstCleanup(loaded.job?.cleanupState ?? "pending", loaded.lease?.cleanupState ?? "complete");

    const viewed = bound ? await this.verification.read(projectId, actor, verification.id) : null;
    if (viewed !== null && !viewed.ok) return viewed;
    const report = viewed?.value.report ?? null;
    const staleness = viewed?.value.staleness ?? [];
    if (!bound && input.label === "verified-samples") {
      return gateFail("STALE_INPUT", "verified-samples-blocked:no-verification-bound", "a verified-samples package needs a verification to bind");
    }
    const gate = deliverability({
      result: report?.result ?? "UNKNOWN",
      currentness: staleness.length > 0 ? "stale" : (report?.currentness ?? "current"),
      cleanupState,
      reportPublished: report !== null,
    });
    const note = statusNoteFor(input.label, gate, bound);
    const defects = exportStatusDefects(input.label, gate, note, bound ? verification.id : null);
    if (defects.length > 0) {
      const failure = blockedByReasons(defects, "STALE_INPUT", "the verified-samples gate");
      recordDeny(this.storage, {
        projectId,
        actor,
        resourceType: "export",
        action: "export.create",
        resourceId: null,
        decision: "deny",
        reasonCode: failure.error.reason,
        metadata: { candidateId: candidate.id, label: input.label },
      });
      return failure;
    }

    // Every entry is bytes the store already published, re-hashed against its row before
    // it goes into the package: content read outside the write transaction has to be
    // provably the content that transaction decided about (§5).
    const parts: { name: string; bytes: Uint8Array }[] = [];
    const fileRows = candidateFilesOf(candidate.dependencyManifestJson);
    if (fileRows.length === 0) {
      return gateFail("REA_CONTRACT_MISMATCH", "candidate-files-unknown", "the candidate declares no files to package");
    }
    for (const file of fileRows) {
      const read = await this.readArtifact(projectId, file.artifactId);
      if (!read.ok) return read;
      parts.push({ name: file.path, bytes: read.value });
    }
    const blueprintBytes = await this.readArtifact(projectId, blueprint.artifactId);
    if (!blueprintBytes.ok) return blueprintBytes;
    const blueprintWire = builderBlueprintSchema.safeParse(parseJsonBytes(blueprintBytes.value));
    if (!blueprintWire.success) {
      return gateFail("REA_CONTRACT_MISMATCH", "blueprint-shape", "the stored blueprint is not a Builder handoff");
    }
    parts.push({ name: "blueprint.json", bytes: blueprintBytes.value });

    if (bound && report !== null) {
      const read = await this.readArtifact(projectId, verification.reportArtifactId);
      if (!read.ok) return read;
      parts.push({ name: "reports/verification.json", bytes: read.value });
      parts.push({
        name: "reports/coverage.json",
        bytes: new TextEncoder().encode(JSON.stringify(coverageOf(report))),
      });
    }

    const manifest: ExportManifestContent = {
      schemaVersion: 1,
      label: input.label,
      packageKind: "zip-stored",
      projectId,
      candidateId: candidate.id,
      verificationId: bound ? verification.id : null,
      blueprintId: blueprint.id,
      planId: bound ? verification.planId : null,
      bound: bound ? report?.identities ?? null : null,
      statusNote: note,
      deliverability: gate,
      openApiVersion: blueprintWire.data.generation.openapiVersion,
      parts: parts.map((part) => ({
        name: part.name,
        sha256: asDigest(digestBytes(part.bytes)),
        byteLength: part.bytes.byteLength,
      })),
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const entries = [{ name: "MANIFEST.json", bytes: manifestBytes }, ...parts];
    const entryDefects = packageEntryDefects(
      entries.map((entry) => entry.name),
      bound,
    );
    if (entryDefects.length > 0) {
      return blockedByReasons(entryDefects, "REA_CONTRACT_MISMATCH", "the package contents");
    }
    if (entries.length !== declaredPackageEntries(bound).length) {
      return gateFail("REA_CONTRACT_MISMATCH", "package-entry-count", `the package holds ${String(entries.length)} of ${String(declaredPackageEntries(bound).length)} entries`);
    }
    // The archive's entry timestamp is a *frozen fact*, not the moment the operator asked.
    // A package is a copy of frozen facts (§10), so two exports of the same candidate and report
    // have to hash to the same digest and land on one artifact row (§5's dedupe inside a class);
    // stamping with the wall clock made the digest move, which turned "one package per distinct
    // package" into a race against a two-second field and left a second stored copy behind every
    // time the clock happened to tick. The export's own instant is recorded in its row, where it
    // belongs, and the report inside a verified-samples package may therefore postdate this stamp.
    const archived = buildZipArchive(entries, blueprint.createdAt, this.zipLimits);
    if (!archived.ok) {
      return blockedByReasons(archived.error, "RESOURCE_LIMIT", "the package bytes");
    }
    const published = await this.artifacts.publish(projectId, "export", archived.value);
    if (!published.ok) {
      return gateFail("CAPABILITY_UNAVAILABLE", published.error.code, published.error.message);
    }

    const exportId = newId();
    const artifactId = newId();
    const createdAt = nowInstant();
    const committed = commitDecision<ExportCommit>(this.storage, {
      projectId,
      actor,
      resourceType: "export",
      action: "export.create",
      resourceId: exportId,
      allowReason: input.label === "verified-samples" ? "export-verified-samples" : "export-draft",
      metadata: { candidateId: candidate.id, label: input.label, sha256: published.value.sha256 },
      work: (tx): Step<ExportCommit> => {
        // The rows the package was built from must still say what they said a moment
        // ago, and a verified-samples package re-runs the gate here: a verification that
        // went stale during assembly is refused rather than shipped.
        const stillCandidate = tx.getCandidate(projectId, candidate.id);
        if (stillCandidate === null || stillCandidate.digest !== candidate.digest) {
          return failure<ExportCommit>("REVISION_CONFLICT", "candidate-changed-under-export");
        }
        const stillBlueprint = tx.getBlueprint(projectId, blueprint.id);
        if (stillBlueprint === null || stillBlueprint.digest !== blueprint.digest) {
          return failure<ExportCommit>("REVISION_CONFLICT", "blueprint-changed-under-export");
        }
        if (bound) {
          const stillVerification = tx.getVerification(projectId, verification.id);
          if (stillVerification === null || stillVerification.currentness !== "current") {
            return failure<ExportCommit>("STALE_INPUT", "verification-changed-under-export");
          }
        }
        // One artifact row per distinct package digest (§5 dedupes inside a class), while
        // every export request keeps its own record: two exports of the same facts share
        // bytes and never overwrite each other.
        const stored = tx.findArtifactByDigest(projectId, "export", published.value.sha256);
        const packageArtifactId = stored === null ? artifactId : stored.id;
        if (stored === null) {
          tx.insertArtifact({
            id: packageArtifactId,
            projectId,
            jobId: candidate.jobId,
            class: "export",
            sha256: published.value.sha256,
            digestReason: null,
            byteLength: published.value.byteLength,
            storageKey: published.value.storageKey,
            mediaType: MEDIA_TYPE,
            createdAt,
          });
        }
        tx.insertExport({
          id: exportId,
          projectId,
          candidateId: candidate.id,
          verificationId: bound ? verification.id : null,
          label: input.label,
          artifactId: packageArtifactId,
          manifestJson: manifest as unknown as JsonValue,
          createdAt,
        });
        return {
          kind: "committed",
          value: {
            id: exportId,
            label: input.label,
            downloadUrl: downloadUrlFor(projectId, exportId),
            sha256: published.value.sha256,
            byteLength: published.value.byteLength,
            createdAt,
            manifest,
          },
        };
      },
    });
    if (!committed.ok) return committed;
    return { ok: true, value: committed.value.value };
  }

  // Download re-verifies before a byte leaves: the row, the package digest, the manifest
  // shape, and for `verified-samples` the whole identity chain (§10: 禁止用过期报告给新
  // 代码贴通过标签).
  async archive(projectId: Id, actor: Actor, exportId: Id): Promise<Result<ExportArchive, GateFailure>> {
    const refused = this.refused(projectId, actor, "download");
    if (refused !== null) return refused;
    const looked = this.storage.transact((tx) => {
      const row = tx.getExport(projectId, exportId);
      if (row === null) return null;
      const artifact = tx.getArtifact(projectId, row.artifactId);
      if (artifact === null) return null;
      return { row, artifact };
    });
    if (!looked.ok) return gateFail("INVALID_INPUT", looked.error.code, looked.error.message);
    const found = looked.value;
    if (found === null) {
      return gateFail("NOT_FOUND", "export-unknown", "no such export in this project");
    }
    const { row: record, artifact } = found;
    if (artifact.class !== "export" || artifact.sha256 === null) {
      return gateFail("REA_CONTRACT_MISMATCH", "package-class-mismatch", "the export does not point at a digested package");
    }

    const bytes = await this.artifacts.read(projectId, artifact.storageKey);
    if (!bytes.ok) {
      return gateFail("CAPABILITY_UNAVAILABLE", bytes.error.code, "the stored package could not be read");
    }
    if (digestBytes(bytes.value) !== artifact.sha256) {
      return gateFail("REA_CONTRACT_MISMATCH", "package-digest-mismatch", "the stored package bytes are not the ones the export recorded");
    }
    const parsedManifest = exportManifestSchema.safeParse(record.manifestJson);
    if (!parsedManifest.success) {
      return gateFail("REA_CONTRACT_MISMATCH", "manifest-shape", "the stored export manifest no longer parses");
    }
    if (record.label === "verified-samples") {
      if (record.verificationId === null) {
        return gateFail("STALE_INPUT", "verified-samples-blocked:no-verification-bound", "a verified-samples export lost its verification id");
      }
      const viewed = await this.verification.read(projectId, actor, record.verificationId);
      if (!viewed.ok) return viewed;
      // The row, not the report body, owns the job whose cleanup state decides delivery (§11).
      const cleanup = await this.cleanupStateOf(projectId, record.verificationId);
      if (!cleanup.ok) return cleanup;
      const gate = deliverability({
        result: viewed.value.report.result,
        currentness: viewed.value.staleness.length > 0 ? "stale" : viewed.value.report.currentness,
        cleanupState: cleanup.value,
        reportPublished: true,
      });
      // The wire parse proves the shape; the branded domain type is what `staleReasons`
      // compares, so the stored manifest is read back through the same boundary cast the
      // other services use rather than through a re-derivation of its fields.
      const stored = record.manifestJson as unknown as ExportManifestContent;
      const drift = staleReasons(stored.bound ?? viewed.value.report.identities, viewed.value.report.identities);
      // The gate dimensions, the manifest bindings and the reasons the read path found
      // against the live rows are all reported: which identity moved is the answer a
      // caller needs, and the first one alone hides it.
      const reasons = [...gate.reasons, ...drift, ...viewed.value.staleness.map((reason) => `bound-${reason}`)];
      if (reasons.length > 0) {
        const failure = blockedByReasons(reasons, "STALE_INPUT", "the verified-samples gate at download");
        // A delivery that was refused because the world moved is a decision worth a line
        // in the journal: §10 forbids an expired report carrying a pass label out, and the
        // audit is where a reviewer sees that it was actually stopped.
        recordDeny(this.storage, {
          projectId,
          actor,
          resourceType: "export",
          action: "export.download",
          resourceId: exportId,
          decision: "deny",
          reasonCode: failure.error.reason,
          metadata: { reasons: reasons.slice(0, 8) as unknown as JsonValue },
        });
        return failure;
      }
    }
    return {
      ok: true,
      value: {
        exportId: record.id,
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
        mediaType: artifact.mediaType,
        bytes: bytes.value,
      },
    };
  }

  async list(projectId: Id, actor: Actor, limit: number): Promise<Result<ExportCommit[], GateFailure>> {
    const refused = this.refused(projectId, actor, "list");
    if (refused !== null) return refused;
    // The digest and length come from the artifact row, which is their only owner: a
    // listing that re-read the archive would be a second measurement of the same bytes.
    const rows = this.storage.transact((tx) =>
      tx.listExportsForProject(projectId, limit).map((row) => {
        const artifact = tx.getArtifact(projectId, row.artifactId);
        return { row, sha256: artifact?.sha256 ?? null, byteLength: artifact?.byteLength ?? 0 };
      }),
    );
    if (!rows.ok) return gateFail("INVALID_INPUT", rows.error.code, rows.error.message);
    const commits: ExportCommit[] = [];
    for (const entry of rows.value) {
      if (entry.sha256 === null) continue;
      const manifest = exportManifestSchema.safeParse(entry.row.manifestJson);
      if (!manifest.success) {
        // An unparseable manifest used to become `{}` here, which the door's own contract then
        // refused - a caller got a contract mismatch naming nothing. Say which row instead.
        return gateFail(
          "REA_CONTRACT_MISMATCH",
          "export-manifest-unreadable",
          "a stored package manifest does not parse as the manifest it claims to be",
          { exportId: entry.row.id },
        );
      }
      commits.push({
        id: entry.row.id,
        label: entry.row.label,
        downloadUrl: downloadUrlFor(projectId, entry.row.id),
        sha256: entry.sha256,
        byteLength: entry.byteLength,
        createdAt: entry.row.createdAt,
        // The wire parse strips the `Id` brands the content type carries, so this restates what the
        // row already stored rather than re-deriving it.
        manifest: manifest.data as unknown as ExportManifestContent,
      });
    }
    return { ok: true, value: commits };
  }

  private async readArtifact(projectId: Id, artifactId: Id): Promise<Result<Uint8Array, GateFailure>> {
    const looked = this.storage.transact((tx) => tx.getArtifact(projectId, artifactId));
    if (!looked.ok) return gateFail("INVALID_INPUT", looked.error.code, looked.error.message);
    const artifact = looked.value;
    if (artifact === null || artifact.sha256 === null) {
      return gateFail("REA_CONTRACT_MISMATCH", "package-source-unreadable", "an artifact the package needs is missing or undigested");
    }
    const bytes = await this.artifacts.read(projectId, artifact.storageKey);
    if (!bytes.ok) return gateFail("CAPABILITY_UNAVAILABLE", bytes.error.code, bytes.error.message);
    if (digestBytes(bytes.value) !== artifact.sha256) {
      return gateFail("REA_CONTRACT_MISMATCH", "package-source-digest-mismatch", "a stored artifact no longer hashes to its row");
    }
    return { ok: true, value: bytes.value };
  }

  private async cleanupStateOf(projectId: Id, verificationId: Id): Promise<Result<CleanupState, GateFailure>> {
    const read = this.storage.transact((tx) => {
      const row = tx.getVerification(projectId, verificationId);
      if (row === null) return null;
      const job = tx.getJob(projectId, row.jobId);
      const lease = tx.getLeaseByJob(projectId, row.jobId);
      return worstCleanup(job?.cleanupState ?? "pending", lease?.cleanupState ?? "complete");
    });
    if (!read.ok) return gateFail("INVALID_INPUT", read.error.code, read.error.message);
    if (read.value === null) return gateFail("NOT_FOUND", "verification-unknown", "no such verification in this project");
    return { ok: true, value: read.value };
  }
}

function failure<T>(code: GateFailure["code"], reason: string): Step<T> {
  return { kind: "failure", failure: gateFail(code, reason, "the rows the package was built from moved") };
}

function worstCleanup(job: CleanupState, lease: CleanupState): CleanupState {
  if (job !== "complete") return job;
  return lease;
}

function parseJsonBytes(bytes: Uint8Array): JsonValue {
  return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as JsonValue;
}

function candidateFilesOf(manifest: JsonValue): { path: string; artifactId: Id }[] {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return [];
  const files = (manifest as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  const parsed: { path: string; artifactId: Id }[] = [];
  for (const file of files) {
    if (file === null || typeof file !== "object") continue;
    const entry = file as { path?: unknown; artifactId?: unknown };
    if (typeof entry.path !== "string" || typeof entry.artifactId !== "string") continue;
    parsed.push({ path: entry.path, artifactId: entry.artifactId as Id });
  }
  return parsed;
}

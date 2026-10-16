import { digestBytes } from "../domain/canonical-json.ts";
import type { CanonicalLimits, Digest } from "../domain/canonical-json.ts";
import { asDigest } from "../domain/canonical-json.ts";
import { asId, newId, nowInstant } from "../domain/identity.ts";
import type { Id } from "../domain/identity.ts";
import type { ExcludedVector } from "../domain/inventory.ts";
import { planCounts } from "../domain/inventory.ts";

// The inventory is read with a bound, and one row above it is a defect rather
// than a silent truncation (§7.4: the denominator has to be the whole snapshot).
const INVENTORY_BOUND = 5_000;
import type { JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import type { EvaluatorCompletion } from "../contracts/verification.ts";
import { evaluatorCompletionSchema, verificationReportSchema } from "../contracts/verification.ts";
import { findComparatorPolicy } from "../contracts/verification.ts";
import type { EventDraft } from "./ports.ts";
import type {
  ArtifactPort,
  BlueprintRow,
  CandidateRow,
  PlanRow,
  StorageTransaction,
  StorageWriterPort,
  VectorRow,
  VerificationRow,
} from "./ports.ts";
import type {
  InventoryCounts,
  ReportedCase,
  ReportIdentities,
  VerificationReport,
  VerificationReportContent,
} from "../domain/report.ts";
import {
  CASE_STATES,
  comparatorDigestOf,
  denominatorDefects,
  determineResult,
  holdoutExposureDefects,
  reportDigest,
  staleReasons,
  vectorSetDigestOf,
} from "../domain/report.ts";
import type { VectorSetEntry } from "../domain/report.ts";
import type { TestVector } from "../domain/vector.ts";
import type { Actor } from "./actor.ts";
import { isBuilder } from "./actor.ts";
import { commitDecision, recordDeny, type Step } from "./decision.ts";
import { blockedByReasons, gateFail, issueNames, type Err, type GateFailure } from "./gate-failure.ts";
import { planContentOf } from "./plan-service.ts";
import type { VectorService } from "./vector-service.ts";

// VerificationService is the only producer of `verifications` rows and of the
// published report artifact (DESIGN §10, PRD F09 / A08).
//
// Everything here follows from one sentence in §10: a candidate's PASS, a forged
// report and a self-declared request have no standing as evidence. So the
// completion body carries *observations only* — `result`, `counts`,
// `inventoryCounts` and the eight bound identities are derived in this module from
// rows the worker already owns, which leaves no field an untrusted side could set.
// The evaluator's staged bytes are re-hashed before anything is published, and the
// report artifact is the JSON derived here, not the transcript handed over.

export type VerificationCommit = {
  verificationId: Id;
  reportArtifactId: Id;
  transcriptArtifactId: Id;
  report: VerificationReport;
};

export type VerificationView = {
  report: VerificationReport;
  // Re-derived on every read; the stored report is never rewritten (§10).
  staleness: string[];
};

export type BuilderSummary = {
  candidateId: Id;
  result: VerificationReport["result"];
  currentness: VerificationReport["currentness"];
  counts: VerificationReport["counts"];
  categories: { state: (typeof CASE_STATES)[number]; count: number }[];
  limitations: string[];
};

// The plan/inventory binding the gate decides on, assembled once and re-read
// inside the write transaction.
// The parsed wire body with its keys turned into the row keys the storage port
// takes, so no helper has to re-brand them.
type BrandedCompletion = EvaluatorCompletion & {
  candidateId: Id;
  jobId: Id;
  blueprintId: Id;
  planId: Id;
  runnerImageDigest: Digest;
  reportSha256: Digest;
};

type BoundRun = {
  candidate: CandidateRow;
  blueprint: BlueprintRow;
  planRow: PlanRow;
  selectedVectorIds: Id[];
  excludedVectors: ExcludedVector[];
  snapshotDigest: Digest;
  inventoryRows: VectorRow[];
  selectedVectors: Map<string, TestVector>;
};

export class VerificationService {
  readonly storage: StorageWriterPort;
  readonly artifacts: ArtifactPort;
  readonly vectors: VectorService;
  readonly limits: CanonicalLimits;

  constructor(deps: {
    storage: StorageWriterPort;
    artifacts: ArtifactPort;
    vectors: VectorService;
    limits: CanonicalLimits;
  }) {
    this.storage = deps.storage;
    this.artifacts = deps.artifacts;
    this.vectors = deps.vectors;
    this.limits = deps.limits;
  }

  // A refusal that never reached the decision transaction is still a decision:
  // §12.2 journals it, and the journal is the only place a denial is recorded.
  private denied(
    projectId: Id,
    actor: Actor,
    resourceId: Id | null,
    failure: Err<GateFailure>,
  ): Err<GateFailure> {
    recordDeny(this.storage, {
      projectId,
      actor,
      resourceType: "verification",
      action: "verification.complete",
      resourceId,
      decision: "deny",
      reasonCode: failure.error.reason,
      metadata: {},
    });
    return failure;
  }

  // The named completion RPC. Authorization comes first, so a Builder learns
  // nothing about the accepted shape from a refusal; a human-side role is refused
  // too, because recording a verification is not a decision to approve anything.
  async complete(
    projectId: Id,
    actor: Actor,
    payload: unknown,
  ): Promise<Result<VerificationCommit, GateFailure>> {
    if (actor.actorKind !== "evaluator") {
      const reason = isBuilder(actor)
        ? "builder-may-not-record-a-verification"
        : "only-the-evaluator-records-a-verification";
      return this.denied(projectId, actor, null, gateFail(
          "ACCESS_DENIED",
          reason,
          "a verification is produced by the trusted evaluator only (DESIGN §10)",
          { actorKind: actor.actorKind },
        ),
      );
    }
    const parsed = evaluatorCompletionSchema.safeParse(payload);
    if (!parsed.success) {
      return gateFail(
          "INVALID_INPUT",
          "completion-schema",
          `completion rejected: ${issueNames(parsed.error.issues).join(",")}`,
          { issues: issueNames(parsed.error.issues) },
        );
    }
    // Branded once at the wire boundary: every use below is against the row keys
    // the storage port asks for, so a string never reaches a lookup unturned.
    const completion = {
      ...parsed.data,
      candidateId: asId(parsed.data.candidateId),
      jobId: asId(parsed.data.jobId),
      blueprintId: asId(parsed.data.blueprintId),
      planId: asId(parsed.data.planId),
      runnerImageDigest: asDigest(parsed.data.runnerImageDigest),
      reportSha256: asDigest(parsed.data.reportSha256),
    };

    const policy = findComparatorPolicy(completion.comparatorPolicyId);
    if (policy === null) {
      return this.denied(projectId, actor, null, gateFail(
          "CAPABILITY_UNAVAILABLE",
          "comparator-not-installed",
          "the named comparator policy is not installed on this worker",
          { policyId: completion.comparatorPolicyId },
        ),
      );
    }
    const comparatorDigest = comparatorDigestOf(policy, this.limits);

    // The transcript must be the bytes the evaluator says it wrote, or the report
    // would bind an identity nobody produced.
    const staging = await this.artifacts.readStaging(projectId, completion.reportStagingId);
    if (!staging.ok) {
      return gateFail("REA_CONTRACT_MISMATCH", "transcript-unreadable", staging.error.code, {
          portCode: staging.error.code,
        });
    }
    if (digestBytes(staging.value) !== completion.reportSha256) {
      return this.denied(projectId, actor, null, gateFail(
          "REA_CONTRACT_MISMATCH",
          "transcript-digest-mismatch",
          "the staged transcript bytes no longer match the recorded digest",
          {},
        ),
      );
    }

    const bound = await this.bind(projectId, completion);
    if (!bound.ok) return this.denied(projectId, actor, null, bound);
    const run = bound.value;

    const outcomes = deriveOutcomes(completion, run.selectedVectors);
    if (outcomes.defects.length > 0) {
      return this.denied(
        projectId,
        actor,
        null,
        blockedByReasons(outcomes.defects, "REA_CONTRACT_MISMATCH", "the completion transcript"),
      );
    }

    const counts = planCounts(outcomes.cases);
    const inventoryCounts = inventoryCountsOf(run.inventoryRows, run.selectedVectorIds, run.excludedVectors.length);
    const denominator = denominatorDefects({
      plan: { selectedVectorIds: run.selectedVectorIds, excludedVectors: run.excludedVectors },
      counts,
      inventoryCounts,
      outcomes: outcomes.cases,
      excludedVectors: run.excludedVectors,
    });
    if (denominator.length > 0) {
      return this.denied(
        projectId,
        actor,
        null,
        blockedByReasons(denominator, "BLUEPRINT_BLOCKED", "the frozen plan"),
      );
    }

    const report = buildReport({
      candidateId: asId(completion.candidateId),
      result: determineResult({
        counts,
        requiredCoverageGap: counts.blocked > 0 || counts.skipped > 0,
        planApproved: run.planRow.reviewStatus === "approved",
        identitiesCurrent: true,
      }),
      scope: [...run.selectedVectorIds].sort(),
      identities: {
        snapshotDigest: run.snapshotDigest,
        blueprintDigest: run.blueprint.digest,
        candidateDigest: run.candidate.digest,
        vectorSetDigest: vectorSetDigestOf(vectorSetEntriesOf(run.inventoryRows), this.limits),
        planDigest: run.planRow.digest,
        inventoryDigest: run.planRow.inventoryDigest,
        comparatorDigest,
        runnerImageDigest: asDigest(completion.runnerImageDigest),
      },
      counts,
      inventoryCounts,
      excludedVectors: run.excludedVectors,
      outcomes: outcomes.cases,
      limitations: [...completion.limitations],
      limits: this.limits,
    });

    const reportBytes = new TextEncoder().encode(JSON.stringify(report));
    const publishedReport = await this.artifacts.publish(
      projectId,
      "report",
      reportBytes,
      asDigest(digestBytes(reportBytes)),
    );
    if (!publishedReport.ok) {
      return gateFail(
          "CAPABILITY_UNAVAILABLE",
          publishedReport.error.code,
          "the verification report could not be published",
        );
    }
    const publishedTranscript = await this.artifacts.publish(
      projectId,
      "inspector",
      staging.value,
      completion.reportSha256,
    );
    if (!publishedTranscript.ok) {
      return gateFail(
          "CAPABILITY_UNAVAILABLE",
          publishedTranscript.error.code,
          "the evaluator transcript could not be published",
        );
    }

    const reportArtifactId = newId();
    const transcriptArtifactId = newId();
    const verificationId = newId();
    const createdAt = nowInstant();

    const committed = commitDecision<VerificationCommit>(this.storage, {
      projectId,
      actor,
      resourceType: "verification",
      action: "verification.complete",
      resourceId: verificationId,
      allowReason: "verification-recorded",
      metadata: {
        candidateId: completion.candidateId,
        planId: completion.planId,
        result: report.result,
        comparatorDigest,
      },
      work: (tx): Step<VerificationCommit> => {
        // Re-read everything the gate decided on. A candidate, blueprint, plan or
        // sample that moved in between is refused rather than recorded against.
        const drift = this.rereadDrift(tx, projectId, completion, run);
        if (drift.length > 0) {
          return {
            kind: "failure",
            failure: gateFail(
              "REVISION_CONFLICT",
              "state-changed-under-verification",
              "the candidate, plan or sample inventory moved while this verification was being recorded",
              { drift },
            ),
          };
        }
        tx.insertArtifact({
          id: reportArtifactId,
          projectId,
          jobId: completion.jobId,
          class: "report",
          sha256: publishedReport.value.sha256,
          digestReason: null,
          byteLength: publishedReport.value.byteLength,
          storageKey: publishedReport.value.storageKey,
          mediaType: "application/json",
          createdAt,
        });
        tx.insertArtifact({
          id: transcriptArtifactId,
          projectId,
          jobId: completion.jobId,
          class: "inspector",
          sha256: publishedTranscript.value.sha256,
          digestReason: null,
          byteLength: publishedTranscript.value.byteLength,
          storageKey: publishedTranscript.value.storageKey,
          mediaType: "application/json",
          createdAt,
        });
        const row: VerificationRow = {
          id: verificationId,
          projectId,
          candidateId: completion.candidateId,
          jobId: completion.jobId,
          planId: completion.planId,
          planDigest: run.planRow.digest,
          inventoryDigest: run.planRow.inventoryDigest,
          blueprintDigest: run.blueprint.digest,
          vectorSetDigest: report.identities.vectorSetDigest,
          comparatorDigest,
          runnerImageDigest: asDigest(completion.runnerImageDigest),
          result: report.result,
          currentness: "current",
          summaryJson: {
            counts: report.counts,
            inventoryCounts: report.inventoryCounts,
            scopeSize: report.scope.length,
          },
          reportArtifactId,
        };
        tx.insertVerification(row);
        tx.appendEvent({
          projectId,
          type: "verification.completed",
          aggregateId: verificationId,
          payloadJson: {
            candidateId: completion.candidateId,
            planId: completion.planId,
            result: report.result,
            currentness: "current",
          },
          createdAt,
        } satisfies EventDraft);
        return {
          kind: "committed",
          value: { verificationId, reportArtifactId, transcriptArtifactId, report },
        };
      },
    });
    if (!committed.ok) return err(committed.error);
    return { ok: true, value: committed.value.value };
  }

  // A published report never changes: the stored body is re-hashed and re-parsed,
  // and staleness is reported next to it from the rows that exist now.
  async read(projectId: Id, verificationId: Id): Promise<Result<VerificationView, GateFailure>> {
    const looked = this.storage.transact((tx) => {
      const row = tx.getVerification(projectId, verificationId);
      if (row === null) return null;
      const artifact = tx.getArtifact(projectId, row.reportArtifactId);
      if (artifact === null) return null;
      const plan = tx.getPlan(projectId, row.planId);
      const candidate =
        plan === null
          ? null
          : tx.getCandidate(projectId, row.candidateId);
      const blueprint =
        candidate === null ? null : tx.getBlueprint(projectId, candidate.blueprintId);
      return { row, artifact, plan, candidate, blueprint };
    });
    if (!looked.ok) return gateFail("INVALID_INPUT", looked.error.code, looked.error.message);
    const found = looked.value;
    if (found === null) {
      return gateFail("NOT_FOUND", "verification-unknown", "no such verification or report");
    }
    const { row, artifact, plan, candidate, blueprint } = found;
    if (artifact.sha256 === null) {
      return gateFail(
          "REA_CONTRACT_MISMATCH",
          "report-digest-withheld",
          "the stored report carries no digest to verify",
          { artifactId: artifact.id },
        );
    }
    const bytes = await this.artifacts.read(projectId, artifact.storageKey);
    if (!bytes.ok) {
      return gateFail("REA_CONTRACT_MISMATCH", "report-unreadable", bytes.error.code, {
        portCode: bytes.error.code,
      });
    }
    if (digestBytes(bytes.value) !== artifact.sha256) {
      return gateFail(
          "REA_CONTRACT_MISMATCH",
          "report-digest-mismatch",
          "the stored report bytes no longer match the recorded digest",
          { artifactId: artifact.id },
        );
    }
    const parsed = verificationReportSchema.safeParse(parseJson(bytes.value));
    if (!parsed.success) {
      return gateFail(
          "REA_CONTRACT_MISMATCH",
          "report-shape",
          `stored report violates its schema at ${issueNames(parsed.error.issues).join(",")}`,
        );
    }
    const report = parsed.data as unknown as VerificationReport;
    if (report.identities.planDigest !== row.planDigest ||
        report.identities.blueprintDigest !== row.blueprintDigest ||
        report.identities.comparatorDigest !== row.comparatorDigest ||
        report.identities.inventoryDigest !== row.inventoryDigest ||
        report.identities.vectorSetDigest !== row.vectorSetDigest ||
        report.identities.runnerImageDigest !== row.runnerImageDigest) {
      return gateFail(
          "REA_CONTRACT_MISMATCH",
          "report-row-disagreement",
          "the stored report and its index row do not agree",
          { verificationId },
        );
    }
    if (plan === null || candidate === null || blueprint === null) {
      return gateFail(
          "REA_CONTRACT_MISMATCH",
          "verification-binding-broken",
          "the rows a verification is bound to no longer resolve",
          { verificationId },
        );
    }
    const current: ReportIdentities = {
      snapshotDigest: plan.snapshotDigest,
      blueprintDigest: blueprint.digest,
      candidateDigest: candidate.digest,
      vectorSetDigest: row.vectorSetDigest,
      planDigest: plan.digest,
      inventoryDigest: plan.inventoryDigest,
      comparatorDigest: row.comparatorDigest,
      runnerImageDigest: row.runnerImageDigest,
    };
    // The vector set digest is only recomputable from the live inventory, so an
    // inventory change shows up as `identity-changed:vectorSetDigest` here.
    const liveInventory = this.storage.transact((tx) =>
      tx.listVectorsForSnapshot(projectId, plan.targetId, plan.snapshotDigest, INVENTORY_BOUND + 1),
    );
    const staleness = liveInventory.ok
      ? staleReasons(report.identities, {
          ...current,
          vectorSetDigest: vectorSetDigestOf(vectorSetEntriesOf(liveInventory.value), this.limits),
        })
      : ["inventory-unreadable"];
    return { ok: true, value: { report, staleness } };
  }

  // What a Builder may see (§10: 契约级类别与安全 diff). Sample ids, holdout
  // entries and the transcript stay out; the self-check below turns that claim
  // into a gate instead of a comment.
  async builderSummary(projectId: Id, verificationId: Id): Promise<Result<BuilderSummary, GateFailure>> {
    const viewed = await this.read(projectId, verificationId);
    if (!viewed.ok) return viewed;
    const report = viewed.value.report;
    const projected: ReportedCase[] = report.outcomes.map((outcome) => ({
      vectorId: outcome.vectorId,
      state: outcome.state,
      reason: null,
      safeDiff: null,
    }));
    const exposed = holdoutExposureDefects(projected, () => "public");
    if (exposed.length > 0) {
      return blockedByReasons(exposed, "SENSITIVE_CONTENT_BLOCKED", "the builder summary");
    }
    return {
      ok: true,
      value: {
        candidateId: report.candidateId,
        result: report.result,
        currentness: viewed.value.staleness.length > 0 ? "stale" : report.currentness,
        counts: report.counts,
        categories: CASE_STATES.map((state) => ({
          state,
          count: projected.filter((outcome) => outcome.state === state).length,
        })),
        limitations: report.limitations,
      },
    };
  }

  private async bind(
    projectId: Id,
    completion: BrandedCompletion,
  ): Promise<Result<BoundRun, GateFailure>> {
    const looked = this.storage.transact((tx) => {
      const candidate = tx.getCandidate(projectId, completion.candidateId);
      if (candidate === null) return { missing: "candidate-unknown" as const };
      const blueprint = tx.getBlueprint(projectId, candidate.blueprintId);
      if (blueprint === null) return { missing: "blueprint-unknown" as const };
      const planRow = tx.getPlan(projectId, completion.planId);
      if (planRow === null) return { missing: "plan-unknown" as const };
      const inventoryRows = tx.listVectorsForSnapshot(
        projectId,
        planRow.targetId,
        planRow.snapshotDigest,
        INVENTORY_BOUND + 1,
      );
      return { candidate, blueprint, planRow, inventoryRows };
    });
    if (!looked.ok) return gateFail("INVALID_INPUT", looked.error.code, looked.error.message);
    const found = looked.value;
    if ("missing" in found) {
      return gateFail("NOT_FOUND", found.missing, "the verification binds to rows that do not exist");
    }
    const { candidate, blueprint, planRow, inventoryRows } = found;
    if (candidate.blueprintId !== completion.blueprintId) {
      return gateFail(
          "REA_CONTRACT_MISMATCH",
          "candidate-blueprint-mismatch",
          "the completion names a blueprint the candidate was not generated against",
          { candidateBlueprint: candidate.blueprintId },
        );
    }
    if (blueprint.verificationPlanId !== completion.planId) {
      return gateFail(
          "REA_CONTRACT_MISMATCH",
          "blueprint-plan-mismatch",
          "the blueprint was frozen against a different verification plan",
          { blueprintPlan: blueprint.verificationPlanId },
        );
    }
    if (planRow.reviewStatus !== "approved") {
      return gateFail("BLUEPRINT_BLOCKED", "plan-not-approved", "a verification runs only against the approved frozen plan", {
          reviewStatus: planRow.reviewStatus,
        });
    }
    const content = planContentOf(planRow);
    if (content === null) {
      return gateFail("REA_CONTRACT_MISMATCH", "plan-payload", "the stored plan payload is not decodable");
    }
    // Sample content is read through its owner, which verifies each payload
    // digest against the index row before anything is decided on.
    const loaded = await this.vectors.loadContents(projectId, content.selectedVectorIds);
    if (!loaded.ok) {
      return gateFail(loaded.error.code, loaded.error.reason, loaded.error.message);
    }
    return {
      ok: true,
      value: {
        candidate,
        blueprint,
        planRow,
        selectedVectorIds: content.selectedVectorIds,
        excludedVectors: content.excludedVectors,
        snapshotDigest: content.snapshotDigest,
        inventoryRows,
        selectedVectors: loaded.value,
      },
    };
  }

  private rereadDrift(
    tx: StorageTransaction,
    projectId: Id,
    completion: BrandedCompletion,
    run: BoundRun,
  ): string[] {
    const drift: string[] = [];
    const candidate = tx.getCandidate(projectId, completion.candidateId);
    if (candidate === null || candidate.digest !== run.candidate.digest) drift.push("candidate-changed");
    const blueprint = tx.getBlueprint(projectId, completion.blueprintId);
    if (blueprint === null || blueprint.digest !== run.blueprint.digest) drift.push("blueprint-changed");
    const plan = tx.getPlan(projectId, completion.planId);
    if (plan === null || plan.digest !== run.planRow.digest) drift.push("plan-changed");
    if (plan !== null && plan.reviewStatus !== "approved") drift.push("plan-review-changed");
    if (plan === null) return drift;
    const inventory = tx.listVectorsForSnapshot(
      projectId,
      plan.targetId,
      plan.snapshotDigest,
      INVENTORY_BOUND + 1,
    );
    if (inventory.length !== run.inventoryRows.length) drift.push("inventory-size-changed");
    for (const row of run.inventoryRows) {
      const again = inventory.find((entry) => entry.id === row.id);
      if (again === undefined) {
        drift.push(`vector-gone:${row.id}`);
        continue;
      }
      if (again.digest !== row.digest) drift.push(`vector-digest-changed:${row.id}`);
      if (again.eligibility !== row.eligibility) drift.push(`vector-eligibility-changed:${row.id}`);
    }
    return drift;
  }
}

function buildReport(input: {
  candidateId: Id;
  result: VerificationReport["result"];
  scope: string[];
  identities: ReportIdentities;
  counts: VerificationReport["counts"];
  inventoryCounts: InventoryCounts;
  excludedVectors: { vectorId: Id; reasonCode: ExcludedVector["reasonCode"] }[];
  outcomes: ReportedCase[];
  limitations: string[];
  limits: CanonicalLimits;
}): VerificationReport {
  const content: VerificationReportContent = {
    id: newId(),
    candidateId: input.candidateId,
    result: input.result,
    scope: input.scope,
    identities: input.identities,
    counts: input.counts,
    inventoryCounts: input.inventoryCounts,
    excludedVectors: input.excludedVectors,
    outcomes: input.outcomes,
    limitations: input.limitations,
  };
  return {
    ...content,
    currentness: "current",
    digest: reportDigest(content, input.limits),
  };
}

function vectorSetEntriesOf(rows: readonly VectorRow[]): VectorSetEntry[] {
  return rows.map((row) => ({
    vectorId: row.id,
    digest: row.digest,
    visibility: row.visibility,
    eligibility: row.eligibility,
  }));
}

function inventoryCountsOf(
  inventory: readonly VectorRow[],
  selectedVectorIds: readonly Id[],
  excludedCount: number,
): InventoryCounts {
  return {
    total: inventory.length,
    selected: selectedVectorIds.length,
    excluded: excludedCount,
    blocked: inventory.filter((row) => row.eligibility === "blocked").length,
  };
}

// One owner for "what state does this observation settle to". An entry that was
// not usable, had no reviewed oracle, or could not be compared deterministically
// never becomes a pass (§10 keeps those out of PASS rather than out of the
// denominator, which is why they still occupy counts.total).
export function deriveOutcomes(
  completion: EvaluatorCompletion,
  selectedVectors: ReadonlyMap<string, TestVector>,
): { cases: ReportedCase[]; defects: string[] } {
  const defects: string[] = [];
  const cases: ReportedCase[] = [];
  const seen = new Set<Id>();
  for (const observation of completion.observations) {
    if (seen.has(asId(observation.vectorId))) {
      defects.push(`duplicate-observation:${observation.vectorId}`);
      continue;
    }
    seen.add(asId(observation.vectorId));
    const vectorId = asId(observation.vectorId);
    const vector = selectedVectors.get(vectorId);
    if (vector === undefined) {
      defects.push(`observation-outside-plan:${observation.vectorId}`);
      continue;
    }
    if (vector.eligibility === "blocked") {
      cases.push({
        vectorId,
        state: "blocked",
        reason: vector.reasons[0] ?? "eligibility-blocked",
        safeDiff: null,
      });
      continue;
    }
    const oracle = hasReviewedOracle(vector);
    if (!oracle || observation.nondeterministic) {
      cases.push({
        vectorId,
        state: "skipped",
        reason: !oracle ? "no-reviewed-oracle" : "nondeterministic-unmodelled",
        safeDiff: null,
      });
      continue;
    }
    const matched =
      observation.requestObserved && observation.requestMatches && observation.decodedMatches;
    cases.push({
      vectorId,
      state: matched ? "passed" : "failed",
      reason: matched ? null : "comparison-mismatch",
      safeDiff: observation.safeDiff,
    });
  }
  return { cases, defects };
}

// §10: an expected outcome that no one reviewed independently is not an oracle.
export function hasReviewedOracle(vector: TestVector): boolean {
  return (
    vector.expectedOutcome !== null &&
    vector.review.status === "approved" &&
    vector.review.approvedDigest !== null &&
    vector.review.approvedDigest === vector.digest
  );
}

function parseJson(bytes: Uint8Array): JsonValue {
  return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as JsonValue;
}

function err(error: GateFailure): Err<GateFailure> {
  return { ok: false, error };
}

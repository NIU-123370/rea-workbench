import type { Digest } from "../domain/canonical-json.ts";
import { asDigest, digestBytes } from "../domain/canonical-json.ts";
import type { Id } from "../domain/identity.ts";
import type { JsonObject, JsonValue } from "../domain/json-value.ts";
import type { Result } from "../domain/result.ts";
import { ok as succeed } from "../domain/result.ts";
import type {
  ReaApplicationCoverage,
  ReaApplicationFactState,
  ReaElectronBoundarySummary,
  ReaIntegrityContradiction,
  ReaReconstructionStatistics,
} from "../contracts/rea-static-analysis.ts";
import {
  javascriptApplicationAnalysisResultSchema,
  reaJavaScriptApplicationEvidenceSchema,
  reaJavaScriptApplicationSummaryViewResultSchema,
} from "../contracts/rea-static-analysis.ts";
import type { JavaScriptApplicationAnalysisResult } from "../contracts/rea-static-analysis.ts";
import { httpStatusFor } from "../contracts/errors.ts";
import { importFieldsSchema } from "../contracts/resources.ts";
import type { Actor } from "./actor.ts";
import { isBuilder } from "./actor.ts";
import { commitDecision } from "./decision.ts";
import type { Step } from "./decision.ts";
import type { GateFailure } from "./gate-failure.ts";
import { gateFail, issueNames } from "./gate-failure.ts";
import { redactJsonValue, redactText } from "./sanitizer.ts";
import type { SensitiveDeclaration } from "./sanitizer.ts";
import type { ArtifactPort, EvidenceRow, StorageWriterPort, TargetRow } from "./ports.ts";

// The ASAR static branch (DESIGN §1 "ASAR 有哪些静态模块与边界", PRD F12, D05).
//
// This module owns three things and nothing else:
//
//   1. the admission gate for an ASAR import, which refuses a sensitive-value
//      declaration because upstream REA has no sensitive projection for
//      `analyze_javascript_application` — see the searched-and-not-found record in
//      the header of `contracts/rea-static-analysis.ts`;
//   2. a read-only projection of an already-persisted application-graph envelope,
//      which keeps every upstream identifier and every upstream fact state
//      verbatim;
//   3. the named unknowns query, which DESIGN §1 lists as the workbench's own
//      added responsibility next to the projection and the display layout.
//
// What it deliberately is not. Static facts generate no test vectors, so this
// file neither implements nor imports `EvidenceFactsPort` (the record reader for
// HTTP captures lives in `adapters/rea/web-capture-records.ts`), and it has no
// import of the vector, contract, plan or blueprint services. It writes no
// business row: the only rows it can cause are the allow/deny journal entries
// owned by `decision.ts`. No function here upgrades a static edge, an `inferred`
// observation or an envelope's `derived` confidence into a runtime claim — a
// static `observed` proves a static fact and nothing more (DESIGN §6, D08) — and
// no Electron runtime is promised or implied (D05: an ASAR is an archive, not a
// runnable platform).

// The named upstream operation this module reads, mirrored from
// src/contracts/javascript/electronToolContracts.ts:90.
export const STATIC_ANALYSIS_TOOL = "analyze_javascript_application";

export type StaticAnalysisFailure = GateFailure;
export type StaticAnalysisActor = Actor;

export type StaticOperationContext = {
  // Short-lived per-operation declaration (DESIGN §12.1). `null` means the
  // filter context is unavailable, which is reported instead of guessed past.
  sensitive: SensitiveDeclaration | null;
};

export type AsarImportAdmission = {
  kind: "asar";
  deadlineAt: string | null;
  // The declaration is dropped at this boundary: never persisted, never part of
  // a request digest, and after a restart the operator must declare again
  // (DESIGN §8 "敏感声明不持久化", §12.1).
  sensitiveDeclared: false;
};

// --- view DTOs. Workbench field names are camelCase (§4); every *value*,
// including upstream ids, is carried exactly as the producer wrote it. The
// nested producer payloads (boundaries, statistics, coverage, contradictions)
// keep upstream snake_case on purpose: renaming producer data here would make
// this projection a second interpretation of it.

export type StaticObservationView = {
  observationId: string;
  label: string | null;
  // Upstream `evidence.state`, copied — `inferred` stays `inferred`.
  factState: ReaApplicationFactState;
  authority: string;
  confidence: string;
  evidenceIds: readonly string[];
  limitations: readonly string[];
  locationRetained: boolean;
};

export type StaticNodeView = {
  graphId: string;
  nodeId: string;
  kind: string;
  identityStrategy: string;
  identityStability: string;
  observations: readonly StaticObservationView[];
};

export type StaticEdgeView = {
  graphId: string;
  edgeId: string;
  relation: string;
  sourceNodeId: string;
  targetNodeId: string;
  factState: ReaApplicationFactState;
  authority: string;
  confidence: string;
  evidenceIds: readonly string[];
  limitations: readonly string[];
};

export type ApplicationGraphView = {
  projectId: Id;
  targetId: Id;
  evidenceId: string;
  importJobId: Id;
  graphId: string;
  semanticGraphId: string;
  rootArtifactSha256: Digest;
  format: "asar" | "directory";
  roots: readonly string[];
  nodes: readonly StaticNodeView[];
  edges: readonly StaticEdgeView[];
  boundaries: ReaElectronBoundarySummary;
  statistics: ReaReconstructionStatistics;
  coverage: ReaApplicationCoverage;
  integrityContradictions: readonly ReaIntegrityContradiction[];
  limitations: readonly string[];
  // The envelope's own provenance stays visible so a projection can never read
  // as a stronger statement than its source.
  envelopeConfidence: "observed" | "derived" | "inferred";
  envelopeAuthority: string;
};

export type ApplicationGraphUnknowns = {
  evidenceId: string;
  graphId: string;
  semanticGraphId: string;
  // Application-graph nodes the producer itself labelled `unknown`
  // (src/domain/javascript/javascriptApplicationGraphSchemas.ts:50).
  applicationUnknownNodes: readonly {
    nodeId: string;
    identityStrategy: string;
    observationIds: readonly string[];
    factStates: readonly ReaApplicationFactState[];
  }[];
  // Named semantic frontiers, verbatim
  // (src/domain/javascript/javascriptSemanticGraphSchemas.ts:276-291).
  semanticUnknowns: readonly {
    unknownId: string;
    nodeId: string | null;
    family: string;
    reason: string;
    detail: string;
    relationKinds: readonly string[];
    candidateNodeIds: readonly string[];
    evidenceContextId: string;
    evidenceIds: readonly string[];
  }[];
  // The producer's own summary-view statement, mirrored field for field from
  // src/domain/analysisView/javascriptApplicationView.ts:131-162. A gap the
  // producer did not state is never added here, and one it stated is never
  // dropped.
  statedUnknowns: readonly string[];
  coverageStatuses: {
    applicationGraph: string;
    semanticGraph: string;
  };
};

type Err<T> = { ok: false; error: T };

function refuse(
  code: GateFailure["code"],
  reason: string,
  message: string,
  sensitive: SensitiveDeclaration | null,
  details: JsonObject = {},
): Err<GateFailure> {
  // Every emitted message passes the single filter owner (§12.1). A message
  // assembled here holds fixed literals and opaque ids only — never an operator
  // path, an artifact storage key or producer free text — and when the
  // declaration context is unavailable the text degrades to the fixed
  // unavailable token rather than being trusted as clean.
  const filtered =
    sensitive === null
      ? { text: "diagnostic_unavailable", excludedReasons: ["declaration-context-unavailable"] }
      : redactText(message, sensitive);
  const safeDetails: JsonObject = {
    ...details,
    httpStatus: httpStatusFor(code),
    ...(sensitive === null ? { filterReason: "declaration-context-unavailable" } : {}),
  };
  return gateFail(code, reason, filtered.text, safeDetails);
}

type EnvelopeLoad = {
  evidence: EvidenceRow;
  target: TargetRow;
  envelope: JsonValue;
};

export class StaticAnalysisService {
  readonly storage: StorageWriterPort;
  readonly artifacts: ArtifactPort;

  constructor(deps: { storage: StorageWriterPort; artifacts: ArtifactPort }) {
    this.storage = deps.storage;
    this.artifacts = deps.artifacts;
  }

  // (a) ASAR import admission (DESIGN §8, PRD A11). The refusal journals a deny
  // inside the same decision transaction owned by `decision.ts`.
  admitAsarImport(
    projectId: Id,
    actor: StaticAnalysisActor,
    input: unknown,
    context: StaticOperationContext,
  ): Result<AsarImportAdmission, GateFailure> {
    const action = "import.asar.admit";
    // Authorization precedes validation, so an unauthorised actor learns nothing
    // about the accepted shape from a refusal.
    if (isBuilder(actor)) {
      const denied = commitDecision<AsarImportAdmission>(this.storage, {
        projectId,
        actor,
        resourceType: "import",
        action,
        resourceId: null,
        allowReason: "unused-deny-path",
        metadata: {},
        work: (): Step<AsarImportAdmission> => ({
          kind: "failure",
          failure: gateFail(
            "ACCESS_DENIED",
            "builder-has-no-import-permission",
            "Builder admits no import and reads blueprint projections only (DESIGN §7.3)",
          ),
        }),
      });
      if (denied.ok) return succeed(denied.value.value);
      return refuse(denied.error.code, denied.error.reason, denied.error.message, context.sensitive);
    }

    const parsed = importFieldsSchema.safeParse(input);
    if (!parsed.success) {
      return refuse(
        "INVALID_INPUT",
        "import-fields-invalid",
        `import fields rejected: ${issueNames(parsed.error.issues).join(",")}`,
        context.sensitive,
        { issues: issueNames(parsed.error.issues) },
      );
    }
    if (parsed.data.kind !== "asar") {
      // One owner per branch: a HAR import is admitted by the ingestion owner,
      // and having both journal an allow for one request would double-record it.
      return refuse(
        "INVALID_INPUT",
        "not-an-asar-import",
        "only the asar branch is admitted here",
        context.sensitive,
      );
    }

    // The operator's declaration for this request joins the filter context for the
    // refusal message; the values themselves are never persisted and never hashed
    // (§12.1).
    const declaredValues = [...(context.sensitive?.declaredValues ?? []), ...(parsed.data.sensitiveValues ?? [])];
    const effective: SensitiveDeclaration = { declaredValues };
    // Presence of the key is what asserts the unsupported capability: an empty
    // list still says "project this ASAR with exclusions", and nothing downstream
    // could honour or verify that.
    const declared =
      typeof input === "object" &&
      input !== null &&
      Object.prototype.hasOwnProperty.call(input, "sensitiveValues");
    const declaredCount = parsed.data.sensitiveValues?.length ?? 0;

    const decision = commitDecision<AsarImportAdmission>(this.storage, {
      projectId,
      actor,
      resourceType: "import",
      action,
      // Nothing exists yet to name: the target row is minted by the ingestion job
      // that runs after this gate.
      resourceId: null,
      allowReason: "asar-import-accepted",
      metadata: redactJsonValue(
        { kind: "asar", deadlineProvided: parsed.data.deadlineAt !== undefined },
        effective,
      ).value,
      work: (tx): Step<AsarImportAdmission> => {
        if (declared) {
          // Refuse rather than pretend: upstream has no sensitive-value field on
          // this operation, so honouring the declaration would mean rewriting a
          // persisted envelope while keeping its `evidence_id`, which §4 and
          // §12.1 forbid.
          return {
            kind: "failure",
            failure: gateFail(
              "SENSITIVE_PROJECTION_UNSUPPORTED",
              "sensitive-projection-unsupported",
              "an asar import that declares sensitive values is refused because upstream has no asar sensitive projection",
              { declaredCount },
            ),
          };
        }
        // The gate writes no business row; this read only proves the project the
        // decision is journalled against exists.
        tx.getProject(projectId);
        return {
          kind: "committed",
          value: {
            kind: "asar",
            deadlineAt: parsed.data.deadlineAt ?? null,
            sensitiveDeclared: false,
          },
        };
      },
    });
    if (decision.ok) return succeed(decision.value.value);
    return refuse(
      decision.error.code,
      decision.error.reason,
      decision.error.message,
      effective,
      decision.error.details,
    );
  }

  // Reads the persisted envelope behind one Evidence row, re-checking the stored
  // artifact digest against the bytes on disk before anything is interpreted
  // (DESIGN §4 "导入现存 Evidence 必须验证其 schema 和语义摘要", §5).
  private async loadEnvelope(
    projectId: Id,
    evidenceId: string,
    sensitive: SensitiveDeclaration | null,
  ): Promise<Result<EnvelopeLoad, GateFailure>> {
    const looked = this.storage.transact((tx) => {
      const evidence = tx.getEvidence(projectId, evidenceId);
      if (evidence === null) return null;
      const artifact = tx.getArtifact(projectId, evidence.artifactId);
      if (artifact === null) return { missing: "artifact" } as const;
      const target = tx.getTarget(projectId, evidence.targetId);
      if (target === null) return { missing: "target" } as const;
      return { evidence, artifact, target };
    });
    if (!looked.ok) {
      return refuse("REA_CONTRACT_MISMATCH", "storage-failure", "storage read failed", sensitive, {
        storageCode: looked.error.code,
      });
    }
    const found = looked.value;
    if (found === null) {
      return refuse("NOT_FOUND", "evidence-unknown", "no evidence row is persisted here", sensitive);
    }
    if ("missing" in found) {
      return refuse(
        "NOT_FOUND",
        `${found.missing}-unknown`,
        `the ${found.missing} row behind this evidence is missing`,
        sensitive,
      );
    }
    const { evidence, artifact, target } = found;
    if (artifact.sha256 === null) {
      return refuse(
        "REA_CONTRACT_MISMATCH",
        "artifact-digest-withheld",
        "the stored artifact carries no digest to verify",
        sensitive,
        { artifactId: artifact.id },
      );
    }
    const bytes = await this.artifacts.read(projectId, artifact.storageKey);
    if (!bytes.ok) {
      // Only the failure code is carried: the adapter message can quote a host
      // path, and a storage key is server-visible only (§5).
      return refuse("REA_CONTRACT_MISMATCH", "artifact-unreadable", bytes.error.code, sensitive);
    }
    if (digestBytes(bytes.value) !== artifact.sha256) {
      return refuse(
        "REA_CONTRACT_MISMATCH",
        "artifact-digest-mismatch",
        "the stored artifact bytes no longer match the recorded digest",
        sensitive,
        { evidenceId, artifactId: artifact.id },
      );
    }
    let decoded: JsonValue;
    try {
      decoded = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes.value)) as JsonValue;
    } catch {
      return refuse("REA_CONTRACT_MISMATCH", "envelope-unparseable", "stored envelope is not JSON", sensitive);
    }
    return succeed({ evidence, target, envelope: decoded });
  }

  // (b) the read-only application-graph projection.
  async projectApplicationGraph(
    projectId: Id,
    evidenceId: string,
    context: StaticOperationContext,
  ): Promise<Result<ApplicationGraphView, GateFailure>> {
    const loaded = await this.loadEnvelope(projectId, evidenceId, context.sensitive);
    if (!loaded.ok) return loaded;
    const { evidence, target } = loaded.value;

    const checked = reaJavaScriptApplicationEvidenceSchema.safeParse(loaded.value.envelope);
    if (!checked.success) {
      return refuse(
        "REA_CONTRACT_MISMATCH",
        "envelope-schema",
        `stored envelope violates the mirrored static analysis schema at ${checked.error.issues
          .map((issue) => issue.path.map(String).join("."))
          .slice(0, 3)
          .join(",")}`,
        context.sensitive,
      );
    }
    const envelope = checked.data;
    if (envelope.evidence_id !== evidenceId) {
      return refuse(
        "REA_CONTRACT_MISMATCH",
        "evidence-id-mismatch",
        "the stored envelope identifies a different evidence record",
        context.sensitive,
        { evidenceId },
      );
    }
    // A foreign envelope — say a HAR capture indexed behind an ASAR target —
    // already failed above: the mirrored reply schema pins
    // `operation: "analyze_javascript_application"`, so there is no second,
    // looser read path to fall into.
    const normalized = this.normalizedResult(envelope.normalized_result, context);
    if (!normalized.ok) return normalized;
    const result = normalized.value;
    const graph = result.graph;

    const nodes = graph.nodes.map((node) => ({
      graphId: graph.graph_id,
      // Upstream ids are carried verbatim: never re-derived, never re-hashed,
      // never re-prefixed (§4 `Id`).
      nodeId: node.node_id,
      kind: node.kind,
      identityStrategy: node.identity.strategy,
      identityStability: node.identity.stability,
      observations: node.observations.map((observation) => ({
        observationId: observation.observation_id,
        label: observation.label,
        factState: observation.evidence.state,
        authority: observation.evidence.authority,
        confidence: observation.evidence.confidence,
        evidenceIds: [...observation.evidence.evidence_ids],
        limitations: [...observation.evidence.limitations],
        locationRetained: observation.evidence.location.available,
      })),
    }));

    const edges = graph.edges.map((edge) => ({
      graphId: graph.graph_id,
      edgeId: edge.edge_id,
      relation: edge.relation,
      sourceNodeId: edge.source_node_id,
      targetNodeId: edge.target_node_id,
      factState: edge.evidence.state,
      authority: edge.evidence.authority,
      confidence: edge.evidence.confidence,
      evidenceIds: [...edge.evidence.evidence_ids],
      limitations: [...edge.evidence.limitations],
    }));

    return succeed({
      projectId,
      targetId: target.id,
      evidenceId: envelope.evidence_id,
      importJobId: evidence.jobId,
      graphId: graph.graph_id,
      semanticGraphId: result.semantic_graph.graph_id,
      rootArtifactSha256: asDigest(result.root_artifact_sha256),
      format: result.format,
      roots: [...graph.root_node_ids],
      nodes,
      edges,
      boundaries: result.summary,
      statistics: result.statistics,
      coverage: graph.coverage,
      integrityContradictions: [...result.integrity_contradictions],
      limitations: [...result.limitations, ...graph.limitations],
      envelopeConfidence: envelope.confidence,
      envelopeAuthority: envelope.authority,
    });
  }

  // `detail: "complete"` delivers the analysis result inline; `detail: "summary"`
  // retains the complete Evidence upstream and delivers only its summary view
  // (src/contracts/analysisDetail.ts:6-11). A summary-only envelope must not be
  // rendered as an empty application graph (§8 "不能显示为空图成功"); reading the
  // rest needs `inspect_analysis_view` against the retained session, which this
  // slice does not wire.
  private normalizedResult(
    value: JsonValue,
    context: StaticOperationContext,
  ): Result<JavaScriptApplicationAnalysisResult, GateFailure> {
    if (reaJavaScriptApplicationSummaryViewResultSchema.safeParse(value).success) {
      return refuse(
        "CAPABILITY_UNAVAILABLE",
        "summary-view-only",
        "the retained analysis is delivered as a summary view; the full graph needs the retained-session view tool",
        context.sensitive,
      );
    }
    const parsed = javascriptApplicationAnalysisResultSchema.safeParse(value);
    if (!parsed.success) {
      return refuse(
        "REA_CONTRACT_MISMATCH",
        "normalized-result-shape",
        `normalized_result violates the mirrored analysis schema at ${parsed.error.issues
          .map((issue) => issue.path.map(String).join("."))
          .slice(0, 3)
          .join(",")}`,
        context.sensitive,
      );
    }
    return succeed(parsed.data);
  }

  // (c) the named unknowns query — the entry point DESIGN §1 assigns the
  // workbench beside the projection and the display layout.
  async listStaticUnknowns(
    projectId: Id,
    evidenceId: string,
    context: StaticOperationContext,
  ): Promise<Result<ApplicationGraphUnknowns, GateFailure>> {
    const loaded = await this.loadEnvelope(projectId, evidenceId, context.sensitive);
    if (!loaded.ok) return loaded;

    const checked = reaJavaScriptApplicationEvidenceSchema.safeParse(loaded.value.envelope);
    if (!checked.success) {
      return refuse(
        "REA_CONTRACT_MISMATCH",
        "envelope-schema",
        "stored envelope violates the mirrored static analysis schema",
        context.sensitive,
      );
    }
    const envelope = checked.data;
    // The mirrored reply schema already pins `operation:
    // STATIC_ANALYSIS_TOOL`, so a foreign envelope cannot reach this line; what
    // it cannot pin is that the row and the bytes name the same record.
    if (envelope.evidence_id !== evidenceId) {
      return refuse(
        "REA_CONTRACT_MISMATCH",
        "evidence-id-mismatch",
        "the stored envelope identifies a different evidence record",
        context.sensitive,
        { evidenceId },
      );
    }
    const normalized = this.normalizedResult(envelope.normalized_result, context);
    if (!normalized.ok) return normalized;
    const result = normalized.value;
    const graph = result.graph;
    const semantic = result.semantic_graph;

    const unknownNodes = graph.nodes
      .filter((node) => node.kind === "unknown")
      .map((node) => ({
        nodeId: node.node_id,
        identityStrategy: node.identity.strategy,
        observationIds: node.observations.map((observation) => observation.observation_id),
        factStates: node.observations.map((observation) => observation.evidence.state),
      }));

    const contextsById = new Map(
      semantic.evidence_contexts.map((entry) => [entry.context_id, entry.evidence_ids]),
    );

    const stated: string[] = [
      ...result.limitations,
      ...graph.limitations,
      ...semantic.limitations,
    ];
    if (graph.coverage.status !== "complete") {
      stated.push(`graph.coverage.status is ${graph.coverage.status}`);
    }
    if (semantic.coverage.status !== "complete") {
      stated.push(`semantic_graph.coverage.status is ${semantic.coverage.status}`);
    }
    if (unknownNodes.length > 0) {
      stated.push(
        `${String(unknownNodes.length)} application graph unknowns remain in the parent Evidence.`,
      );
    }
    if (semantic.unknowns.length > 0) {
      stated.push(
        `${String(semantic.unknowns.length)} semantic graph unknowns remain in the parent Evidence.`,
      );
    }

    return succeed({
      evidenceId: envelope.evidence_id,
      graphId: graph.graph_id,
      semanticGraphId: semantic.graph_id,
      applicationUnknownNodes: unknownNodes,
      semanticUnknowns: semantic.unknowns.map((unknown) => ({
        unknownId: unknown.unknown_id,
        nodeId: unknown.node_id,
        family: unknown.family,
        reason: unknown.reason,
        detail: unknown.detail,
        relationKinds: [...unknown.relation_kinds],
        candidateNodeIds: [...unknown.candidate_node_ids],
        evidenceContextId: unknown.evidence.context_id,
        // An id list the retained context does not carry stays empty rather than
        // being guessed at.
        evidenceIds: [...(contextsById.get(unknown.evidence.context_id) ?? [])],
      })),
      statedUnknowns: [...new Set(stated)],
      coverageStatuses: {
        applicationGraph: graph.coverage.status,
        semanticGraph: semantic.coverage.status,
      },
    });
  }
}

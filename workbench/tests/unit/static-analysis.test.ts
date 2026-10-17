import { readFileSync } from "node:fs";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { asDigest, digestBytes } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId, nowInstant } from "../../packages/domain/identity.ts";
import type { Id, Instant } from "../../packages/domain/identity.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type { Result } from "../../packages/domain/result.ts";
import {
  analyzeJavaScriptApplicationInputSchema,
  javascriptApplicationAnalysisResultSchema,
  reaJavaScriptApplicationEvidenceSchema,
} from "../../packages/contracts/rea-static-analysis.ts";
import { httpStatusFor } from "../../packages/contracts/errors.ts";
import { StaticAnalysisService } from "../../packages/application/static-analysis.ts";
import { STATIC_ANALYSIS_TOOL } from "../../packages/application/static-analysis.ts";
import type { StaticOperationContext } from "../../packages/application/static-analysis.ts";
import { TransactionRefused } from "../../packages/application/decision.ts";
import type {
  ArtifactClass,
  ArtifactRow,
  AuditRow,
  CommittedAudit,
  EvidenceRow,
  JobRow,
  LeaseRow,
  ProjectRow,
  PublishedFile,
  StoragePortError,
  StorageTransaction,
  StorageWriterPort,
  TargetRow,
  VectorRow,
  ContractRow,
  PlanRow,
  BlueprintRow,
  GraphEdgeRow,
  ClaimRow,
  CommittedEvent,
  EventDraft,
} from "../../packages/application/ports.ts";
import type { ArtifactPort } from "../../packages/application/ports.ts";

// F12 / D05 / issue #24: the ASAR static branch is a *projection* of REA's
// application graph and nothing more. These tests hold the three checkboxes of
// the issue in place without a database: the sensitive-value refusal, the
// verbatim-id / verbatim-fact-state projection, and the structural promise that
// a static fact can never become a runtime contract.

const hex = (seed: string): Digest => (seed.repeat(32) as string) as Digest;
const HEX_ROOT = hex("11");
const EV_ASAR = `ev_${hex("aa")}`;
const NODE_ASAR = `jag_node_${hex("55")}`;
const NODE_MAIN = `jag_node_${hex("66")}`;
const NODE_MODULE = `jag_node_${hex("77")}`;
const NODE_UNKNOWN = `jag_node_${hex("88")}`;
const GRAPH_ID = `jag_${hex("ee")}`;
const OBS_UNKNOWN = `jag_observation_${hex("dd")}`;
const SECRET = "hunter2-embedded-session-secret";

// A byte-level edit of the stored envelope that must never be re-interpreted:
// one `inferred` fact state rewritten to `observed`. The assertion below proves
// the replacement actually landed, so a silent no-op cannot pass the test.
function tamperInferredToObserved(): string {
  const text = FIXTURE_TEXT.replace('"state": "inferred"', '"state": "observed"');
  if (text === FIXTURE_TEXT) throw new Error("the fixture tamper did not change any byte");
  return text;
}

const FIXTURE_TEXT = readFileSync(
  new URL("../fixtures/asar-application-envelope.json", import.meta.url),
  "utf8",
);
const FIXTURE = JSON.parse(FIXTURE_TEXT) as JsonValue;

// The recorded `tools/list` reply of the real provider at 98d8470d. Unit tests
// read the advertised side from here instead of restating it, so "the mirror
// matches the provider" stays one assertion about two documents rather than two
// hand-copied lists that can agree with each other and disagree with REA.
const RECORDED_LIVE = JSON.parse(
  readFileSync(new URL("../fixtures/rea-live-tools-shapes.json", import.meta.url), "utf8"),
) as { namedToolOrder: string[]; tools: { name: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> | null }[] };

const projectRow: ProjectRow = {
  id: newId(),
  name: "demo-app",
  createdAt: nowInstant(),
  graphRevision: 0,
  inventoryRevision: 0,
  schemaVersion: 1,
};

const targetRow: TargetRow = {
  id: newId(),
  projectId: projectRow.id,
  kind: "asar",
  originalLocator: null,
  sourceSha256: HEX_ROOT,
  sourceArtifactId: null,
  // DESIGN §5: an ASAR is never captured, so there is no deployment snapshot.
  snapshotDigest: null,
  identityReason: "file-import-without-capture",
  createdAt: nowInstant(),
};

const importJobRow: JobRow = {
  id: newId(),
  projectId: projectRow.id,
  targetId: targetRow.id,
  kind: "inspect",
  state: "succeeded",
  cleanupState: "complete",
  inputJson: { kind: "asar" },
  resultRef: null,
  errorJson: null,
  idempotencyKey: "seed-asar",
  requestDigest: HEX_ROOT,
  deadlineAt: null,
  retryAt: null,
  createdAt: nowInstant(),
  updatedAt: nowInstant(),
};

const artifactRow: ArtifactRow = {
  id: newId(),
  projectId: projectRow.id,
  jobId: importJobRow.id,
  class: "inspector",
  sha256: asDigest(digestBytes(new TextEncoder().encode(FIXTURE_TEXT))),
  digestReason: null,
  byteLength: FIXTURE_TEXT.length,
  storageKey: `projects/${projectRow.id}/artifacts/inspector/envelope.bin`,
  mediaType: "application/json",
  createdAt: nowInstant(),
};

const evidenceRow: EvidenceRow = {
  projectId: projectRow.id,
  id: EV_ASAR,
  targetId: targetRow.id,
  jobId: importJobRow.id,
  artifactId: artifactRow.id,
  providerJson: {
    id: "rea-javascript-application",
    name: "REA JavaScript application analyzer",
    version: "1",
  },
  operation: "analyze_javascript_application",
  confidence: "derived",
  authority: "shipped-artifact",
  createdAt: nowInstant(),
};

// An in-memory writer that refuses every method the static branch is not allowed
// to touch. A projection that ever starts writing rows fails here first.
type FakeState = {
  projects: Map<string, ProjectRow>;
  targets: Map<string, TargetRow>;
  artifacts: Map<string, ArtifactRow>;
  evidence: Map<string, EvidenceRow>;
  audit: AuditRow[];
  writes: string[];
};

function fakeState(): FakeState {
  return {
    projects: new Map([[projectRow.id, projectRow]]),
    targets: new Map([[`${projectRow.id}|${targetRow.id}`, targetRow]]),
    artifacts: new Map([[`${projectRow.id}|${artifactRow.id}`, artifactRow]]),
    evidence: new Map([[`${projectRow.id}|${EV_ASAR}`, evidenceRow]]),
    audit: [],
    writes: [],
  };
}

function fakeWriter(state: FakeState): StorageWriterPort {
  const tx: StorageTransaction = {
    getProject: (projectId: Id) => state.projects.get(projectId) ?? null,
    getTarget: (projectId: Id, targetId: Id) => state.targets.get(`${projectId}|${targetId}`) ?? null,
    listProjectsAfter: refused("listProjectsAfter", state),
    getArtifact: (projectId: Id, artifactId: Id) => state.artifacts.get(`${projectId}|${artifactId}`) ?? null,
    listEvidenceIdsForTarget: refused("listEvidenceIdsForTarget", state),
    findImportJobForTarget: refused("findImportJobForTarget", state),
    findArtifactByDigest: refused("findArtifactByDigest", state),
    insertExport: refused("insertExport", state),
    getExport: refused("getExport", state),
    listClaimsForTarget: refused("listClaimsForTarget", state),
    listTargetsForProject: refused("listTargetsForProject", state),
    listExportsForProject: refused("listExportsForProject", state),
    getEvidence: (projectId: Id, evidenceId: string) => state.evidence.get(`${projectId}|${evidenceId}`) ?? null,
    insertAudit: (row: AuditRow) => {
      state.audit.push(row);
      return state.audit.length;
    },
    insertProject: refused("insertProject", state),
    insertTarget: refused("insertTarget", state),
    upsertProjectRevision: refused("upsertProjectRevision", state),
    insertJob: refused("insertJob", state),
    updateJob: refused("updateJob", state),
    getJob: refused("getJob", state),
    insertArtifact: refused("insertArtifact", state),
    insertEvidence: refused("insertEvidence", state),
    insertVector: refused("insertVector", state),
    updateVectorReview: refused("updateVectorReview", state),
    getVector: refused("getVector", state),
    listVectors: refused("listVectors", state),
    listVectorsForSnapshot: refused("listVectorsForSnapshot", state),
    insertContract: refused("insertContract", state),
    updateContractReview: refused("updateContractReview", state),
    getContract: refused("getContract", state),
    latestContractRevision: refused("latestContractRevision", state),
    insertPlan: refused("insertPlan", state),
    updatePlanReview: refused("updatePlanReview", state),
    getPlan: refused("getPlan", state),
    listPlans: refused("listPlans", state),
    insertBlueprint: refused("insertBlueprint", state),
    getBlueprint: refused("getBlueprint", state),
    insertGraphEdge: refused("insertGraphEdge", state),
    listEdges: refused("listEdges", state),
    listClaimEvidence: refused("listClaimEvidence", state),
    insertClaim: refused("insertClaim", state),
    getClaim: refused("getClaim", state),
    insertClaimEvidence: refused("insertClaimEvidence", state),
    contradictingEvidenceIds: refused("contradictingEvidenceIds", state),
    appendEvent: refused("appendEvent", state),
    eventsAfter: refused("eventsAfter", state),
    insertLease: refused("insertLease", state),
    insertCandidate: refused("insertCandidate", state),
    getCandidate: refused("getCandidate", state),
    listCandidatesForBlueprint: refused("listCandidatesForBlueprint", state),
    insertVerification: refused("insertVerification", state),
    getVerification: refused("getVerification", state),
    listVerificationsForCandidate: refused("listVerificationsForCandidate", state),
    findJobByKey: refused("findJobByKey", state),
    listJobsByStates: refused("listJobsByStates", state),
    listJobsAfter: refused("listJobsAfter", state),
    listVectorsAfter: refused("listVectorsAfter", state),
    listLeasesForJobs: refused("listLeasesForJobs", state),
    listOpenLeases: refused("listOpenLeases", state),
    getLeaseByJob: refused("getLeaseByJob", state),
    updateLeaseCleanup: refused("updateLeaseCleanup", state),
    auditAfter: refused("auditAfter", state),
    latestSeq: refused("latestSeq", state),
  };
  return {
    transact<T>(work: (handle: StorageTransaction) => T): Result<T, StoragePortError> {
      const auditMark = state.audit.length;
      try {
        return { ok: true, value: work(tx) };
      } catch (error) {
        // Mirror the real writer: a refusal propagates so `commitDecision` can
        // journal the deny in its own transaction after the rollback. Swallowing
        // it here would turn every refusal into a storage failure.
        if (error instanceof TransactionRefused) throw error;
        // A thrown work unit still rolls the journal back.
        state.audit.length = auditMark;
        return { ok: false, error: { code: "SQLITE_FAILURE", message: String((error as Error).message) } };
      }
    },
  };
}

function refused(name: string, state: FakeState) {
  return () => {
    state.writes.push(name);
    throw new Error(`static analysis touched a row it must not: ${name}`);
  };
}

function fakeArtifacts(bytes: Uint8Array): ArtifactPort {
  return {
    publish(): Promise<Result<PublishedFile, { code: "STAGING_UNVERIFIED" | "ARTIFACT_MISMATCH" | "ARTIFACT_WRITE_FAILED"; message: string }>> {
      return Promise.reject(new Error("the static branch never publishes an artifact"));
    },
    read(): Promise<Result<Uint8Array, { code: "STAGING_UNVERIFIED" | "ARTIFACT_MISMATCH" | "ARTIFACT_WRITE_FAILED"; message: string }>> {
      return Promise.resolve({ ok: true, value: bytes });
    },
    absolutePathFor(): string {
      // The static branch reads envelope bytes through `read`, never a host path:
      // handing one out would let a projection reach outside the artifact store.
      throw new Error("the static branch never resolves an absolute path");
    },
    readStaging(): Promise<Result<Uint8Array, { code: "STAGING_UNVERIFIED" | "ARTIFACT_MISMATCH" | "ARTIFACT_WRITE_FAILED"; message: string }>> {
      return Promise.reject(new Error("the static branch never reads evaluator staging"));
    },
  };
}

function serviceWith(bytes: Uint8Array, state = fakeState()): StaticAnalysisService {
  return new StaticAnalysisService({
    storage: fakeWriter(state),
    artifacts: fakeArtifacts(bytes),
  });
}

// A state whose recorded artifact digest matches the given text, so a test can
// exercise what happens *after* the digest check instead of at it.
function stateMatching(text: string): FakeState {
  const state = fakeState();
  const bytes = new TextEncoder().encode(text);
  const existing = state.artifacts.get(`${projectRow.id}|${artifactRow.id}`);
  if (existing === undefined) throw new Error("the fake artifact row disappeared");
  state.artifacts.set(`${projectRow.id}|${artifactRow.id}`, {
    ...existing,
    sha256: asDigest(digestBytes(bytes)),
    byteLength: bytes.byteLength,
  });
  return state;
}

const fixtureBytes = new TextEncoder().encode(FIXTURE_TEXT);

function context(declaredValues: readonly string[] = []): StaticOperationContext {
  return { sensitive: { declaredValues } };
}

const inspector = { actorId: "local-operator", actorKind: "inspector" } as const;
const builder = { actorId: "builder-agent", actorKind: "builder" } as const;

function keyNames(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keyNames(item, into);
    return into;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, member] of Object.entries(value)) {
      into.push(key);
      keyNames(member, into);
    }
  }
  return into;
}

// Comments state the very rules they forbid, so the structural assertions below
// must read the code, not the prose.
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

const SERVICE_CODE = codeOnly(
  readFileSync(new URL("../../packages/application/static-analysis.ts", import.meta.url), "utf8"),
);

describe("mirrored static analysis shapes (DESIGN §1, §4)", () => {
  it("parses the ASAR envelope the fixture persists", () => {
    const parsed = reaJavaScriptApplicationEvidenceSchema.safeParse(FIXTURE);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5)));
    expect(parsed.data.operation).toBe("analyze_javascript_application");
    expect(parsed.data.subject?.format).toBe("asar");
    // The producer classifies a reconstruction as derived, never observed.
    expect(parsed.data.confidence).toBe("derived");
  });

  it("refuses an envelope whose semantic graph abandons its application graph", () => {
    const mutated = JSON.parse(FIXTURE_TEXT) as Record<string, JsonValue>;
    const normalized = structuredClone(mutated["normalized_result"]) as Record<string, JsonValue>;
    const semantic = structuredClone(normalized["semantic_graph"]) as Record<string, JsonValue>;
    semantic["application_graph_id"] = `jag_${("f" as const).repeat(64)}`;
    normalized["semantic_graph"] = semantic;
    mutated["normalized_result"] = normalized;
    expect(reaJavaScriptApplicationEvidenceSchema.safeParse(mutated).success).toBe(false);
  });

  it("refuses an inferred fact the fixture tried to promote to observed", () => {
    // The mirrored producer rules (javascriptApplicationEvidenceSchemas.ts:282-408):
    // an inference-only authority that claims `observed` is refused, so no copy of
    // the graph can quietly upgrade a static relationship.
    const parsed = javascriptApplicationAnalysisResultSchema.safeParse(
      (FIXTURE as { normalized_result: JsonValue }).normalized_result,
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = parsed.data;
    const edge = result.graph.edges[0];
    if (edge === undefined) throw new Error("the fixture carries no edge");
    expect(edge.evidence.state).toBe("inferred");
    expect(edge.evidence.authority).toBe("static-relationship-inference");
    const promoted = javascriptApplicationAnalysisResultSchema.safeParse({
      ...structuredClone(result),
      graph: {
        ...structuredClone(result.graph),
        edges: result.graph.edges.map((candidate) =>
          candidate.edge_id === edge.edge_id
            ? { ...candidate, evidence: { ...candidate.evidence, state: "observed" } }
            : candidate,
        ),
      },
    });
    expect(promoted.success).toBe(false);
    // And the untouched fixture stays valid, so the refusal is the mutation's.
    expect(javascriptApplicationAnalysisResultSchema.safeParse(result).success).toBe(true);
  });

  it("has no sensitive-value field anywhere on the mirrored static request", () => {
    // The service's refusal rests on this absence, so prove it on the mirror
    // rather than on a comment: upstream
    // `analyzeJavaScriptApplicationInputSchema` has nowhere to put a declaration.
    const accepted = analyzeJavaScriptApplicationInputSchema.safeParse({
      input_path: "/operator/fixtures/demo-app.asar",
      format: "asar",
      integrity_policy: "fail",
    });
    expect(accepted.success).toBe(true);
    if (!accepted.success) return;
    // `detail` appears because upstream advertises it on this very tool and it
    // carries a producer default, so a parse fills it — see the regression below.
    expect(Object.keys(accepted.data).sort()).toEqual([
      "detail",
      "format",
      "input_path",
      "integrity_policy",
    ]);
    expect(accepted.data.detail).toBe("complete");

    const declared = analyzeJavaScriptApplicationInputSchema.safeParse({
      input_path: "/operator/fixtures/demo-app.asar",
      format: "asar",
      integrity_policy: "fail",
      sensitive_values: [SECRET],
    });
    expect(declared.success).toBe(false);
    if (declared.success) return;
    expect(declared.error.issues.map((issue) => issue.code)).toContain("unrecognized_keys");
  });

  it("accepts the `detail` delivery choice the provider advertises (issue #14)", () => {
    // Regression. Before issue #14 read `tools/list` of the built provider at
    // 98d8470d, `detail` lived only on a derived request schema, so this
    // strictObject refused a field the pinned provider names as legal input —
    // and `{"detail":"summary"}` is how a caller asks for the retained-reference
    // delivery that DESIGN §9 item 5 depends on. The advertised key set is
    // asserted from the recorded capture, not restated here, so the mirror and
    // the check cannot both drift.
    const summary = analyzeJavaScriptApplicationInputSchema.safeParse({
      input_path: "/operator/fixtures/demo-app.asar",
      format: "asar",
      integrity_policy: "fail",
      detail: "summary",
    });
    expect(summary.success).toBe(true);
    if (!summary.success) return;
    expect(summary.data.detail).toBe("summary");

    expect(
      analyzeJavaScriptApplicationInputSchema.safeParse({
        input_path: "/operator/fixtures/demo-app.asar",
        detail: "streaming",
      }).success,
    ).toBe(false);

    const advertised = RECORDED_LIVE.tools.find((tool) => tool.name === "analyze_javascript_application");
    if (advertised === undefined) throw new Error("the recorded catalog lost the ASAR tool");
    const advertisedProperties = (advertised.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(advertisedProperties).sort().join(",")).toEqual(
      "analysis_timeout_ms,detail,format,input_path,integrity_policy,max_heap_mb,max_semantic_nodes,max_semantic_nodes_per_file,source_paths",
    );;
    expect(
      (z.toJSONSchema(analyzeJavaScriptApplicationInputSchema, { io: "input" }).properties as Record<string, unknown>)
        .detail,
    ).toMatchObject({ type: "string", enum: ["complete", "summary"], default: "complete" });
  });
});

describe("ASAR import admission (DESIGN §8, PRD A11, issue #24)", () => {
  it("names the single upstream operation this branch reads", () => {
    // The reader is bound to one named tool, never to a catalog position (§1, §9).
    expect(STATIC_ANALYSIS_TOOL).toBe("analyze_javascript_application");
    expect(evidenceRow.operation).toBe(STATIC_ANALYSIS_TOOL);
  });

  it("refuses an asar import that declares sensitive values, with 422 and a deny", () => {
    const state = fakeState();
    const service = serviceWith(fixtureBytes, state);
    const result = service.admitAsarImport(
      projectRow.id,
      inspector,
      { kind: "asar", sensitiveValues: [SECRET] },
      context([SECRET]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SENSITIVE_PROJECTION_UNSUPPORTED");
    expect(httpStatusFor(result.error.code)).toBe(422);
    expect(result.error.reason).toBe("sensitive-projection-unsupported");

    const denial = state.audit.filter((entry) => entry.decision === "deny");
    expect(denial.map((entry) => entry.reasonCode)).toEqual(["sensitive-projection-unsupported"]);
    // The declared value is neither stored nor hashed anywhere (§12.1).
    expect(JSON.stringify(state.audit)).not.toContain(SECRET);
    expect(JSON.stringify(result.error.details)).not.toContain(SECRET);
    // Only the journal was written; no business row was created.
    expect(state.writes).toEqual([]);
  });

  it("refuses even an empty declaration, because presence asserts the capability", () => {
    const state = fakeState();
    const service = serviceWith(fixtureBytes, state);
    const result = service.admitAsarImport(projectRow.id, inspector, { kind: "asar", sensitiveValues: [] }, context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SENSITIVE_PROJECTION_UNSUPPORTED");
    expect(state.audit[0]?.decision).toBe("deny");
  });

  it("accepts an asar import with no declaration and journals an allow", () => {
    const state = fakeState();
    const service = serviceWith(fixtureBytes, state);
    const result = service.admitAsarImport(projectRow.id, inspector, { kind: "asar" }, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: "asar", deadlineAt: null, sensitiveDeclared: false });
    expect(state.audit.map((entry) => entry.decision)).toEqual(["allow"]);
    expect(state.audit[0]?.reasonCode).toBe("asar-import-accepted");
  });

  it("keeps an explicit deadline and drops the short-lived declaration", () => {
    const deadline = "2026-12-31T23:59:59.000Z" as Instant;
    const state = fakeState();
    const service = serviceWith(fixtureBytes, state);
    const result = service.admitAsarImport(
      projectRow.id,
      inspector,
      { kind: "asar", deadlineAt: deadline },
      context(),
    );
    expect(result.ok && result.value.deadlineAt).toBe(deadline);
    expect(JSON.stringify(state.audit)).not.toContain(deadline);
  });

  it("refuses an unmodelled extra field and a non-asar kind", () => {
    const service = serviceWith(fixtureBytes);
    const extra = service.admitAsarImport(
      projectRow.id,
      inspector,
      { kind: "asar", sensitive: [SECRET] },
      context(),
    );
    expect(extra.ok).toBe(false);
    if (extra.ok) return;
    expect(extra.error.reason).toBe("import-fields-invalid");
    expect(extra.error.details["issues"]).toContain("sensitive");

    const har = service.admitAsarImport(projectRow.id, inspector, { kind: "har" }, context());
    expect(har.ok).toBe(false);
    if (har.ok) return;
    expect(har.error.reason).toBe("not-an-asar-import");
  });

  it("denies a builder before it learns anything about the accepted shape", () => {
    const state = fakeState();
    const service = serviceWith(fixtureBytes, state);
    const result = service.admitAsarImport(projectRow.id, builder, { kind: "nonsense" }, context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ACCESS_DENIED");
    expect(state.audit[0]?.reasonCode).toBe("builder-has-no-import-permission");
  });
});

describe("application graph projection (DESIGN §1, §4, §6)", () => {
  it("keeps every upstream identifier verbatim", async () => {
    const service = serviceWith(fixtureBytes);
    const view = await service.projectApplicationGraph(projectRow.id, EV_ASAR, context());
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.evidenceId).toBe(EV_ASAR);
    expect(view.value.graphId).toBe(GRAPH_ID);
    expect(view.value.targetId).toBe(targetRow.id);
    expect(view.value.importJobId).toBe(importJobRow.id);
    expect(view.value.rootArtifactSha256).toBe(HEX_ROOT);
    expect(view.value.nodes.map((node) => node.nodeId)).toEqual([
      NODE_ASAR,
      NODE_MAIN,
      NODE_MODULE,
      NODE_UNKNOWN,
    ]);
    expect(view.value.roots).toEqual([NODE_ASAR]);
    expect(view.value.nodes[0]?.observations[0]?.observationId).toMatch(/^jag_observation_/u);
    expect(view.value.edges.map((edge) => edge.edgeId)).toHaveLength(3);
  });

  it("preserves inferred as inferred and never reports a static fact as runtime", async () => {
    const service = serviceWith(fixtureBytes);
    const view = await service.projectApplicationGraph(projectRow.id, EV_ASAR, context());
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    const projectedStates = [
      ...view.value.nodes.flatMap((node) => node.observations.map((o) => o.factState)),
      ...view.value.edges.map((edge) => edge.factState),
    ];
    const fixtureStates = fixtureFactStates();
    expect(projectedStates).toEqual(fixtureStates);
    // Nothing in the copy could have promoted a state.
    expect(projectedStates.filter((state) => state === "observed")).toHaveLength(
      fixtureStates.filter((state) => state === "observed").length,
    );
    expect(projectedStates).toContain("inferred");
    expect(projectedStates).toContain("unknown");
    const unknownNode = view.value.nodes.find((node) => node.nodeId === NODE_UNKNOWN);
    expect(unknownNode?.kind).toBe("unknown");
    expect(unknownNode?.observations[0]?.factState).toBe("unknown");
    expect(unknownNode?.observations[0]?.observationId).toBe(OBS_UNKNOWN);
    expect(unknownNode?.observations[0]?.limitations.length).toBeGreaterThan(0);
    expect(view.value.envelopeConfidence).toBe("derived");
  });

  it("exposes no runtime-contract surface at all", async () => {
    const service = serviceWith(fixtureBytes);
    const view = await service.projectApplicationGraph(projectRow.id, EV_ASAR, context());
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const keys = keyNames(view.value);
    for (const forbidden of [
      "httpOperations",
      "expectedOutcome",
      "sdkInput",
      "operationId",
      "caseKey",
      "vectors",
      "vectorIds",
      "testVectors",
      "contractRevisionIds",
      "blueprintDigest",
      "planDigest",
      "passRate",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    // And no field that would let a caller relabel the basis of a fact.
    expect(keys).not.toContain("basis");
    expect(keys).not.toContain("displayStatus");
  });

  it("carries the Electron boundary counts verbatim as counts, not capabilities", async () => {
    const service = serviceWith(fixtureBytes);
    const view = await service.projectApplicationGraph(projectRow.id, EV_ASAR, context());
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const fixtureSummary = (
      FIXTURE as {
        normalized_result: { summary: Record<string, JsonValue> };
      }
    ).normalized_result.summary;
    expect(view.value.boundaries).toEqual(fixtureSummary);
    expect(view.value.boundaries.ipc.dynamic_channel_operations).toBe(1);
    expect(view.value.integrityContradictions).toEqual([]);
    expect(view.value.coverage.status).toBe("partial");
  });

  it("refuses a foreign envelope instead of reading it as a static graph", async () => {
    // The mirrored reply schema pins the named operation, so an HTTP-capture
    // envelope indexed behind an ASAR target has no looser read path to fall into.
    const foreign = JSON.stringify({
      ...(structuredClone(FIXTURE) as Record<string, JsonValue>),
      operation: "inspect_web_network_capture",
    });
    const bytes = new TextEncoder().encode(foreign);
    const result = await serviceWith(bytes, stateMatching(foreign)).projectApplicationGraph(
      projectRow.id,
      EV_ASAR,
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("envelope-schema");
    expect(result.error.code).toBe("REA_CONTRACT_MISMATCH");
  });

  it("is structurally incapable of minting a runtime claim", () => {
    // DESIGN §1 + D05: static facts project, they do not generate a contract.
    expect(SERVICE_CODE).not.toMatch(/vector-service|contract-service|plan-service|blueprint-service/);
    expect(SERVICE_CODE).not.toMatch(/EvidenceFactsPort|readRecord|EvidenceRecordFacts/);
    expect(SERVICE_CODE).not.toMatch(/tx\.(insert|update|upsert|appendEvent|contradicting|listVectors|listEdges|getJob)/);
    expect(SERVICE_CODE).not.toMatch(/(factState|state)\s*:\s*"(observed|derived)"/);
    // The module is read-only against the storage port apart from the journal.
    expect(SERVICE_CODE).not.toMatch(/insertVector|insertContract|insertPlan|insertBlueprint|insertClaim/);
  });
});

describe("named unknowns query (DESIGN §1 entry point, F12)", () => {
  it("names the unknowns the producer stated, with their ids", async () => {
    const service = serviceWith(fixtureBytes);
    const unknowns = await service.listStaticUnknowns(projectRow.id, EV_ASAR, context());
    expect(unknowns.ok).toBe(true);
    if (!unknowns.ok) return;
    expect(unknowns.value.evidenceId).toBe(EV_ASAR);
    expect(unknowns.value.graphId).toBe(GRAPH_ID);
    expect(unknowns.value.semanticGraphId).toBe(`jsrg_${hex("d2")}`);
    expect(unknowns.value.applicationUnknownNodes.map((node) => node.nodeId)).toEqual([NODE_UNKNOWN]);
    expect(unknowns.value.applicationUnknownNodes[0]?.factStates).toEqual(["unknown"]);
    expect(unknowns.value.semanticUnknowns).toHaveLength(1);
    const frontier = unknowns.value.semanticUnknowns[0];
    expect(frontier?.unknownId).toBe(`jsrg_unknown_${hex("e1")}`);
    expect(frontier?.family).toBe("call-flow");
    expect(frontier?.reason).toBe("dynamic-call");
    expect(frontier?.relationKinds).toEqual(["calls"]);
    expect(frontier?.evidenceIds).toEqual([EV_ASAR]);
    expect(unknowns.value.coverageStatuses).toEqual({
      applicationGraph: "partial",
      semanticGraph: "partial",
    });
  });

  it("mirrors the producer's own summary-view unknown formula", async () => {
    const service = serviceWith(fixtureBytes);
    const unknowns = await service.listStaticUnknowns(projectRow.id, EV_ASAR, context());
    expect(unknowns.ok).toBe(true);
    if (!unknowns.ok) return;
    const stated = unknowns.value.statedUnknowns;
    expect(stated).toContain("graph.coverage.status is partial");
    expect(stated).toContain("semantic_graph.coverage.status is partial");
    expect(stated).toContain("1 application graph unknowns remain in the parent Evidence.");
    expect(stated).toContain("1 semantic graph unknowns remain in the parent Evidence.");
    // The producer's limitation text is carried, not rewritten.
    const result = javascriptApplicationAnalysisResultSchema.parse(
      (FIXTURE as { normalized_result: JsonValue }).normalized_result,
    );
    for (const limitation of [
      ...result.limitations,
      ...result.graph.limitations,
      ...result.semantic_graph.limitations,
    ]) {
      expect(stated).toContain(limitation);
    }
  });

  it("refuses an unknown evidence row and a tampered artifact", async () => {
    const missing = await serviceWith(fixtureBytes).listStaticUnknowns(
      projectRow.id,
      `ev_${("9" as const).repeat(64)}`,
      context(),
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("NOT_FOUND");
    expect(missing.error.reason).toBe("evidence-unknown");
    expect(httpStatusFor(missing.error.code)).toBe(404);

    // Same recorded digest, different bytes on disk.
    const tampered = new TextEncoder().encode(
      tamperInferredToObserved(),
    );
    const refused = await serviceWith(tampered).projectApplicationGraph(projectRow.id, EV_ASAR, context());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.reason).toBe("artifact-digest-mismatch");
    expect(httpStatusFor(refused.error.code)).toBe(503);
  });

  it("reports an unavailable filter context instead of trusting an unfiltered message", async () => {
    const result = await serviceWith(fixtureBytes).projectApplicationGraph(
      projectRow.id,
      `ev_${("9" as const).repeat(64)}`,
      { sensitive: null },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("diagnostic_unavailable");
    expect(result.error.details["filterReason"]).toBe("declaration-context-unavailable");
  });
});

function fixtureFactStates(): string[] {
  const result = javascriptApplicationAnalysisResultSchema.parse(
    (FIXTURE as { normalized_result: JsonValue }).normalized_result,
  );
  return [
    ...result.graph.nodes.flatMap((node) => node.observations.map((o) => o.evidence.state)),
    ...result.graph.edges.map((edge) => edge.evidence.state),
  ];
}

// Keep the unused-row types referenced so this fake cannot silently drift from
// the port it claims to implement.
export type FakePortCoverage = {
  lease: LeaseRow;
  vector: VectorRow;
  contract: ContractRow;
  plan: PlanRow;
  blueprint: BlueprintRow;
  edge: GraphEdgeRow;
  claim: ClaimRow;
  event: EventDraft;
  committed: CommittedEvent;
  audit: CommittedAudit;
  artifactClass: ArtifactClass;
};

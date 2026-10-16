import type { Id } from "../domain/identity.ts";
import type { Result } from "../domain/result.ts";
import type { ClaimEvidenceState } from "../domain/evidence.ts";
import type { Actor } from "./actor.ts";
import { isBuilder } from "./actor.ts";
import { claimFactOf } from "./contract-service.ts";
import { gateFail, type GateFailure } from "./gate-failure.ts";
import type { ClaimRow, StorageWriterPort } from "./ports.ts";

// The graph read side (DESIGN §6 / §5, PRD F04, issue #18).
//
// The middle column is allowed to show only what the rows already say: a node is an
// entity key with the claims attached to it, an edge carries the claim that judges it,
// and a claim's colour comes from `projectClaim` over a state built by `claimFactOf` —
// the same owner the contract gate uses, so the canvas and the blueprint gate can never
// disagree about what a claim said.
//
// Deliberately absent: no recomputation of basis or coverage from evidence text, and no node
// or edge synthesized from a "likely" relation. An empty graph reads as an empty graph with a
// stated reason.

export const GRAPH_READ_LIMIT = 500;

export type GraphClaimState = { claimId: Id; state: ClaimEvidenceState; assertion: string; revision: number };

export type GraphView = {
  projectId: Id;
  targetId: Id | null;
  truncated: boolean;
  nodes: { entityKey: string; claimIds: Id[]; evidenceIds: readonly string[] }[];
  edges: { id: string; fromKey: string; toKey: string; relation: string; claimId: Id }[];
  claims: GraphClaimState[];
  // Why the canvas is empty when it is: an absent target is a different answer from a
  // target with no claims, and the screen must not present either as "all quiet".
  note: string | null;
};

function stateOf(row: ClaimRow): ClaimEvidenceState {
  const fact = claimFactOf(row);
  return {
    basis: fact.basis,
    validity: fact.validity,
    sourceEvidenceIds: fact.sourceEvidenceIds,
    authorityApplies: fact.authorityApplies,
    coverage: fact.coverage,
  };
}

export class GraphReadService {
  readonly storage: StorageWriterPort;

  constructor(deps: { storage: StorageWriterPort }) {
    this.storage = deps.storage;
  }

  read(projectId: Id, actor: Actor, targetId?: Id): Result<GraphView, GateFailure> {
    // The Builder reads its frozen handoff, not the live evidence graph (§7.3): giving
    // the generation side a second, unrestricted view of claims would let holdout-bound
    // evidence reach it through the canvas.
    if (isBuilder(actor)) {
      return gateFail("ACCESS_DENIED", "builder-may-not-read-graph", "the graph view is a control-plane read, not the Builder's");
    }
    const loaded = this.storage.transact((tx) => {
      const targets = targetId === undefined ? tx.listTargetsForProject(projectId, GRAPH_READ_LIMIT) : [];
      const chosen = targetId ?? (targets[0]?.id ?? null);
      if (chosen === null) return { empty: "no-target" as const, targets, chosen };
      const target = tx.getTarget(projectId, chosen);
      if (target === null) return { empty: "target-unknown" as const, targets, chosen };
      const claims = tx.listClaimsForTarget(projectId, chosen, GRAPH_READ_LIMIT);
      const edges = tx.listEdges(projectId, chosen);
      return { empty: null as null, targets, chosen, claims, edges };
    });
    if (!loaded.ok) return gateFail("INVALID_INPUT", loaded.error.code, loaded.error.message);
    const found = loaded.value;
    if (found.empty !== null) {
      return {
        ok: true,
        value: {
          projectId,
          targetId: null,
          truncated: false,
          nodes: [],
          edges: [],
          claims: [],
          note: found.empty === "no-target" ? "no-target-imported-yet" : "target-unknown",
        },
      };
    }
    const claims = found.claims as ClaimRow[];
    const edges = found.edges;
    const truncated = claims.length >= GRAPH_READ_LIMIT || edges.length >= GRAPH_READ_LIMIT;
    const byEntity = new Map<string, { claimIds: Id[]; evidenceIds: Set<string> }>();
    for (const row of claims) {
      const bucket = byEntity.get(row.entityKey) ?? { claimIds: [], evidenceIds: new Set<string>() };
      bucket.claimIds.push(row.id);
      for (const evidenceId of claimFactOf(row).sourceEvidenceIds) bucket.evidenceIds.add(evidenceId);
      byEntity.set(row.entityKey, bucket);
    }
    return {
      ok: true,
      value: {
        projectId,
        targetId: found.chosen as Id,
        truncated,
        nodes: [...byEntity.entries()]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([entityKey, bucket]) => ({ entityKey, claimIds: bucket.claimIds, evidenceIds: [...bucket.evidenceIds].sort() })),
        edges: edges.map((edge) => ({ id: edge.id, fromKey: edge.fromKey, toKey: edge.toKey, relation: edge.relation, claimId: edge.claimId })),
        claims: claims.map((row) => ({ claimId: row.id, state: stateOf(row), assertion: row.assertion, revision: row.revision })),
        note: claims.length === 0 ? "target-has-no-claims" : null,
      },
    };
  }

  // The jump target the middle column promises: the evidence ids behind a claim, read
  // from the claim's own row rather than from a denormalized copy on the node (§5).
  evidenceIdsOf(projectId: Id, claimId: Id): Result<readonly string[], GateFailure> {
    const row = this.storage.transact((tx) => tx.getClaim(projectId, claimId));
    if (!row.ok) return gateFail("INVALID_INPUT", row.error.code, row.error.message);
    if (row.value === null) return gateFail("NOT_FOUND", "claim-unknown", "no such claim in this project");
    return { ok: true, value: claimFactOf(row.value).sourceEvidenceIds };
  }
}

import { describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { ClaimEvidenceState, Coverage } from "../../packages/domain/evidence.ts";
import {
  buildLeftPanel,
  buildMiddlePanel,
  buildRightTabs,
  directedInquiry,
  listView,
  presentStatus,
} from "../../apps/web/ui/view-model.ts";
import type { GraphEdgeView, GraphNodeView } from "../../apps/web/ui/view-model.ts";

// The three-column surface's own rules (PRD F04 / DESIGN §6, issue #18).
// Colour is never the only channel, an edge is judged by its own claim, a list view
// must not soften what the canvas said, and an UNKNOWN has to turn into the one next
// step the reason actually implies.

const COMPLETE: Coverage = { state: "complete", examined: null, total: null, reasons: [] };

function claim(overrides: Partial<ClaimEvidenceState> = {}): ClaimEvidenceState {
  return {
    basis: "observed",
    validity: "current",
    sourceEvidenceIds: [`ev_${"a".repeat(64)}`],
    authorityApplies: true,
    coverage: COMPLETE,
    ...overrides,
  };
}

function node(id: Id, claimIds: Id[]): GraphNodeView {
  return {
    id,
    kind: "operation",
    label: "GET /api/cart",
    targetId: newId(),
    claimIds,
    evidenceIds: [`ev_${"b".repeat(64)}`],
    contractRevisionIds: [newId()],
    coverage: COMPLETE,
  };
}

const claims = new Map<string, ClaimEvidenceState>();

function cellsWith(
  nodeClaims: ClaimEvidenceState[],
  edgeClaim: ClaimEvidenceState | null,
) {
  const nodeId = newId();
  const claimIds = nodeClaims.map(() => newId());
  nodeClaims.forEach((entry, index) => {
    claims.set(claimIds[index] as string, entry);
  });
  const edgeClaimId = newId();
  if (edgeClaim !== null) claims.set(edgeClaimId, edgeClaim);
  const nodes = [node(nodeId, claimIds)];
  const edges: GraphEdgeView[] = [{ id: "edge-1", from: nodeId, to: "somewhere", relation: "calls", claimId: edgeClaimId }];
  return buildMiddlePanel({
    nodes,
    edges,
    requiredClaimsOfNode: (entry) => entry.claimIds.map((id) => claims.get(id) as ClaimEvidenceState),
    claimOfEdge: (id) => claims.get(id) ?? null,
    ...(nodes.length === 0 ? {} : {}),
  });
}

describe("status presentation (§6)", () => {
  it("carries an icon, a word and the reasons for every status", () => {
    for (const status of ["SEEN", "INFERRED", "UNKNOWN"] as const) {
      const presented = presentStatus({ status, reasons: status === "SEEN" ? [] : ["claim-stale"] });
      expect(presented.icon.length).toBeGreaterThan(0);
      expect(presented.label.length).toBeGreaterThan(0);
      expect(["positive", "caution", "negative"]).toContain(presented.tone);
    }
    const unknown = presentStatus({ status: "UNKNOWN", reasons: ["claim-contradicted"] });
    expect(unknown.reasons).toEqual(["claim-contradicted"]);
  });

  it("marks a derived basis as inferred, with the reason named", () => {
    const { cells } = cellsWith([claim({ basis: "derived" })], claim());
    const nodeCell = cells.find((cell) => cell.role === "node");
    expect(nodeCell?.presentation.label).toBe("推断");
    expect(nodeCell?.presentation.reasons).toContain("basis-derived");
  });

  it("never lets a node's SEEN colour spill onto its edge", () => {
    // Both endpoints settled and required, the edge's own claim contradicted: §6 says
    // the edge is UNKNOWN and the node stays SEEN, in the same render.
    const { cells } = cellsWith([claim()], claim({ validity: "contradicted" }));
    const nodeCell = cells.find((cell) => cell.role === "node");
    const edgeCell = cells.find((cell) => cell.role === "edge");
    expect(nodeCell?.presentation.label).toBe("已观察");
    expect(edgeCell?.presentation.label).toBe("未知");
    expect(edgeCell?.presentation.reasons).toContain("claim-contradicted");
  });

  it("refuses an edge whose claim cannot be read instead of drawing nothing", () => {
    const { cells, failures } = cellsWith([claim()], null);
    expect(cells.find((cell) => cell.role === "edge")).toBeUndefined();
    expect(failures[0]?.reason).toBe("edge-claim-unreadable");
    expect(failures[0]?.missing).toContain("edge-1");
  });

  it("hands out evidence references only, never a body", () => {
    const { cells } = cellsWith([claim()], claim());
    const nodeCell = cells.find((cell) => cell.role === "node");
    expect(nodeCell?.evidenceJumpTargets).toEqual([`ev_${"b".repeat(64)}`]);
    expect(JSON.stringify(nodeCell)).not.toContain("raw_result");
    expect(JSON.stringify(nodeCell)).not.toContain("normalized_result");
  });
});

describe("the list view is the same judgement (§ F04)", () => {
  it("keeps icon, word and reasons when the canvas is replaced", () => {
    const { cells } = cellsWith([claim({ validity: "stale" })], claim());
    const rows = listView(cells);
    const row = rows.find((entry) => entry.role === "node");
    // A stale claim is UNKNOWN, and the list has to say so rather than quietly
    // tinting the row grey.
    expect(row?.statusLine).not.toContain("已观察");
    expect(row?.statusLine).toContain("?");
    expect(row?.reasonLine).toContain("claim-stale");
    expect(row?.sourceCount).toBe(1);
  });
});

describe("an unknown turns into one concrete next step (§6)", () => {
  it("maps each reason vocabulary onto the inquiry that could settle it", () => {
    const cases: [string, string][] = [
      ["claim-without-source", "capture-new"],
      ["claim-stale", "read-evidence"],
      ["claim-contradicted", "review-claim"],
      ["authority-not-applicable", "inspect-runtime"],
    ];
    for (const [reason, kind] of cases) {
      const { cells } = cellsWith([claim(reason === "claim-without-source" ? { sourceEvidenceIds: [] } : reason === "claim-stale" ? { validity: "stale" } : reason === "claim-contradicted" ? { validity: "contradicted" } : { authorityApplies: false })], claim());
      const edgeCell = cells.find((cell) => cell.role === "node");
      if (edgeCell === undefined) throw new Error("the node cell disappeared");
      const inquiry = directedInquiry(edgeCell);
      expect(inquiry.ok).toBe(true);
      if (!inquiry.ok) continue;
      expect(inquiry.value.kind).toBe(kind);
      expect(inquiry.value.gaps).toContain(reason);
    }
  });

  it("refuses to invent a step for a reason it does not know", () => {
    const { cells } = cellsWith([claim({ coverage: { state: "partial", examined: 1, total: 4, reasons: [] } })], claim());
    const cell = cells.find((entry) => entry.role === "node");
    if (cell === undefined) throw new Error("no cell");
    const unknown = directedInquiry({ ...cell, presentation: { ...cell.presentation, reasons: ["made-up-reason"] } });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.reason).toBe("reasons-unmapped");
    expect(unknown.unknown).toEqual(["made-up-reason"]);
  });

  it("has nothing to investigate in a settled cell", () => {
    const { cells } = cellsWith([claim()], claim());
    const cell = cells.find((entry) => entry.role === "node");
    if (cell === undefined) throw new Error("no cell");
    const inquiry = directedInquiry({ ...cell, presentation: { ...cell.presentation, reasons: [] } });
    expect(inquiry.ok).toBe(false);
    if (inquiry.ok) return;
    expect(inquiry.reason).toBe("cell-has-no-gap");
  });
});

describe("the side columns (§6, §7.3)", () => {
  it("shows limitations next to the thing they limit", () => {
    const panel = buildLeftPanel({
      job: { id: newId(), state: "succeeded", cleanupState: "complete", errorJson: null },
      target: { id: newId(), kind: "har", snapshotDigest: asDigest("9".repeat(64)) as Digest },
      limitations: ["关系覆盖为部分", "loopback 未观察"],
      scopeLabel: "cart 读取",
    });
    if ("reason" in panel) throw new Error("the panel should have been built");
    expect(panel.limitations).toHaveLength(2);
    expect(panel.taskState).toBe("succeeded");
    expect(panel.cleanupState).toBe("complete");
  });

  it("says plainly when there is neither a task nor a target", () => {
    const panel = buildLeftPanel({ job: null, target: null, limitations: [], scopeLabel: "—" });
    expect(panel).toEqual({ reason: "no-task-and-no-target" });
  });

  it("keeps source away from a Builder and reports behind a frozen blueprint", () => {
    const builder = buildRightTabs({ isBuilder: true, hasBlueprint: false });
    const code = builder.find((tab) => tab.id === "code");
    expect(code?.enabled).toBe(false);
    expect(code?.disabledReason).toBe("builder-may-not-read-source");
    expect(builder.find((tab) => tab.id === "report")?.disabledReason).toBe("builder-needs-a-frozen-blueprint");
    const inspector = buildRightTabs({ isBuilder: false, hasBlueprint: false });
    expect(inspector.every((tab) => tab.enabled)).toBe(true);
    expect(inspector.every((tab) => tab.label.length > 0)).toBe(true);
  });
});

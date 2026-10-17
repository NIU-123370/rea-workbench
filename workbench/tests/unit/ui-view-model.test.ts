import { describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { ClaimEvidenceState, Coverage } from "../../packages/domain/evidence.ts";
import {
  buildLeftPanel,
  buildMiddlePanel,
  canvasEdges,
  buildRightTabs,
  directedInquiry,
  listView,
  presentStatus,
  evidenceMetaLine, refusalFactsLine, relayData, SAMPLES_EMPTY_LINE, sampleDecisionLine, sampleRowsOf, samplesPageOf, samplesRefusalLine, sampleIsDecidable, sampleLine,
  pickCandidateSource,
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

  it("states the absence of preview frames instead of leaving the slot blank", () => {
    const base = {
      job: { id: newId(), state: "succeeded", cleanupState: "complete", errorJson: null },
      target: { id: newId(), kind: "har", snapshotDigest: asDigest("9".repeat(64)) as Digest },
      limitations: [],
      scopeLabel: "cart 读取",
    };
    const offline = buildLeftPanel(base);
    if ("reason" in offline) throw new Error("the panel should have been built");
    // An offline HAR import has no frames. The slot says so, in words, rather than
    // rendering an empty box the operator has to interpret.
    expect(offline.frames.count).toBe(0);
    expect(offline.frames.note).toContain("无画面");
    const withFrames = buildLeftPanel({ ...base, frameLabels: ["t+0s 首页", "t+2s 购物车"] });
    if ("reason" in withFrames) throw new Error("the panel should have been built");
    expect(withFrames.frames).toEqual({ count: 2, note: "见下方画面列表" });
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

describe("the canvas topology and the list's own actions (issue #18)", () => {
  const a = newId();
  const b = newId();
  const ac = newId();
  const bc = newId();
  const ec = newId();
  const seen = claim();
  claims.set(ac, seen);
  claims.set(bc, seen);
  claims.set(ec, seen);

  function scene(rows: readonly GraphEdgeView[]) {
    const nodes = [node(a, [ac]), { ...node(b, [bc]), label: "POST /api/cart" }];
    return buildMiddlePanel({
      nodes,
      edges: rows,
      requiredClaimsOfNode: (entry) => entry.claimIds.map((id) => claims.get(id) as ClaimEvidenceState),
      claimOfEdge: (id) => claims.get(id) ?? null,
    });
  }

  it("draws a relation between the two endpoint cells", () => {
    const rows: GraphEdgeView[] = [{ id: "edge-1", from: a, to: b, relation: "precedes", claimId: ec }];
    const built = scene(rows);
    const placed = canvasEdges(built.cells, rows);
    // The endpoints come from the row, so the ids are the cells' own ids. Reading them out
    // of the label instead gave a canvas with every node and no relation at all.
    expect(placed.drawn).toEqual([{ id: "edge-1", source: a, target: b, label: "precedes" }]);
    expect(placed.dropped).toEqual([]);
  });

  it("refuses to draw a relation whose endpoint is not on the canvas", () => {
    const missing = newId();
    const rows: GraphEdgeView[] = [{ id: "edge-2", from: a, to: missing, relation: "yields", claimId: ec }];
    const placed = canvasEdges(scene(rows).cells, rows);
    expect(placed.drawn).toEqual([]);
    expect(placed.dropped).toEqual([{ reason: "edge-endpoint-not-on-canvas", missing: ["edge-2", a, missing] }]);
  });

  it("leaves an edge with an unreadable claim to the refusal list rather than the canvas", () => {
    const unknownClaim = newId();
    const rows: GraphEdgeView[] = [{ id: "edge-3", from: a, to: b, relation: "calls", claimId: unknownClaim }];
    const built = scene(rows);
    expect(built.failures).toEqual([
      { code: "GRAPH_VIEW_INCOMPLETE", reason: "edge-claim-unreadable", missing: ["edge-3", unknownClaim] },
    ]);
    const placed = canvasEdges(built.cells, rows);
    expect(placed.drawn).toEqual([]);
    expect(placed.dropped).toEqual([]);
  });

  it("gives a list row the jump targets and the one next step", () => {
    const rows: GraphEdgeView[] = [{ id: "edge-4", from: a, to: b, relation: "precedes", claimId: ec }];
    const settled = listView(scene(rows).cells);
    const nodeRow = settled.find((row) => row.id === a);
    if (nodeRow === undefined) throw new Error("the node cell did not reach the list");
    expect(nodeRow.evidenceJumpTargets).toEqual([`ev_${"b".repeat(64)}`]);
    expect(nodeRow.sourceCount).toBe(1);
    // A cell with nothing missing has no next step to offer.
    expect(nodeRow.inquiry).toBeNull();

    const stale = claim({ validity: "stale" });
    claims.set(ac, stale);
    const gapRow = listView(scene(rows).cells).find((row) => row.id === a);
    if (gapRow?.inquiry === undefined || gapRow.inquiry === null) throw new Error("a stale claim offered no inquiry");
    expect(gapRow.inquiry.kind).toBe("read-evidence");
    expect(gapRow.reasonLine).toContain("claim-stale");
    claims.set(ac, seen);
  });
});

// Which candidate the 代码 tab reads (§8 lines 277 + 294 / issue #55).
//
// The screen is not given a candidate id; it recovers one from the job page. So the rule
// that picks the row is a product rule, not a fetch detail: only a successful build counts,
// the first such row on a newest-first page is the one, and a resultRef that is not an
// opaque id never goes into a URL path.

describe("candidate discovery from the job page (§8 line 277)", () => {
  const CANDIDATE = "2b1f6d4a-0ce7-4a3d-9a1a-6f0d9d5f1234";
  const OTHER = "7c2a5e3b-1d8f-4b2c-8e6d-3f0a9c1b5246";
  const job = (id: string, kind: string, state: string, resultRef: string | null = null) => ({ id, kind, state, resultRef });

  it("names the candidate the newest successful build delivered", () => {
    const picked = pickCandidateSource([
      job("j2", "verify", "succeeded", "report-42"),
      job("j1", "build", "succeeded", CANDIDATE),
      job("j0", "build", "succeeded", OTHER),
    ]);
    expect(picked).toEqual({ found: true, jobId: "j1", candidateId: CANDIDATE });
  });

  it("says which step came up empty rather than showing a blank panel", () => {
    expect(pickCandidateSource([])).toEqual({ found: false, reason: "job-page-empty" });
    expect(pickCandidateSource([job("j1", "capture", "succeeded", null), job("j2", "build", "failed", null)])).toEqual({
      found: false,
      reason: "no-successful-build",
    });
  });

  it("refuses to put a non-identifier into a route path", () => {
    for (const ref of [null, "", "artifacts/candidate.ts", `../../etc/passwd`, CANDIDATE.slice(0, -1) + "z"]) {
      const result = pickCandidateSource([job("j1", "build", "succeeded", ref)]);
      expect(result).toEqual({ found: false, reason: "result-ref-is-not-an-id" });
    }
  });
});

// What the evidence reader says about the bytes it fetched (§8 line 281 / issue #58).
//
// The withheld digest is the interesting case: the store may legitimately hold a NULL sha256
// with a reason beside it (§4), and a page that renders that as an empty field reads as a
// value that got lost in transit rather than a fact that was never published.

describe("evidenceMetaLine (§8 line 281)", () => {
  it("names the media type, the length and the digest the store recorded", () => {
    const line = evidenceMetaLine({
      mediaType: "application/json",
      byteLength: 1036,
      sha256: "dc3449a3e08b77e927e6f8e99e4e34c3bb1c9b2405455bd951613579836415c4",
    });
    expect(line).toContain("application/json");
    expect(line).toContain("1036 字节");
    expect(line).toContain("dc3449a3");
  });

  it("says the digest is withheld instead of rendering an empty field", () => {
    const line = evidenceMetaLine({ mediaType: "application/octet-stream", byteLength: 0, sha256: null });
    expect(line).toContain("未公开");
    expect(line).not.toMatch(/sha256 (null|undefined)/);
  });
});

describe("the numbers a refusal published (§8's ApiError.details, issue #59)", () => {
  it("names both sides of a size cap, in a stable order", () => {
    // Sorted, because the object came off a socket: the same refusal must read the same way
    // twice, or a page that re-renders looks like the server changed its answer.
    expect(refusalFactsLine({ limit: 1_048_576, byteLength: 1_048_577 })).toBe("byteLength 1048577 · limit 1048576");
    expect(refusalFactsLine({ byteLength: 1_048_577, limit: 1_048_576 })).toBe("byteLength 1048577 · limit 1048576");
  });

  it("renders a boolean as the value it is", () => {
    expect(refusalFactsLine({ retryable: false })).toBe("retryable false");
    expect(refusalFactsLine({ retryable: true, attempt: 3 })).toBe("attempt 3 · retryable true");
  });

  it("says nothing when the refusal published no number", () => {
    // `null` rather than an empty string, so the caller does not draw a pair of brackets
    // around absence.
    expect(refusalFactsLine({})).toBeNull();
  });
});

describe("the 样本 tab and its decisions (§8 lines 283 and 285 / issue #58)", () => {
  const row = (reviewStatus: string) => ({
    vectorId: "11111111-1111-4111-8111-111111111111",
    caseKey: "cart-add",
    digest: "a".repeat(64),
    visibility: "public",
    eligibility: "usable",
    reviewStatus,
  });

  it("offers the tab to a role that may decide, and refuses a Builder by name", () => {
    const inspector = buildRightTabs({ isBuilder: false, hasBlueprint: true });
    const samples = inspector.find((tab) => tab.id === "samples");
    expect(samples?.enabled, JSON.stringify(inspector)).toBe(true);
    expect(samples?.disabledReason).toBeNull();
    const builder = buildRightTabs({ isBuilder: true, hasBlueprint: true }).find((tab) => tab.id === "samples");
    expect(builder?.enabled).toBe(false);
    // The reason is the server's own reason code, not a paraphrase: §7.3's boundary is one rule
    // with two spellings otherwise.
    expect(builder?.disabledReason).toBe("builder-may-not-decide-samples");
  });

  it("only asks for a decision on a sample nobody has decided yet", () => {
    expect(sampleIsDecidable("draft")).toBe(true);
    expect(sampleIsDecidable("approved")).toBe(false);
    expect(sampleIsDecidable("rejected")).toBe(false);
  });

  it("names each empty state apart, pairwise", () => {
    expect(Object.keys(SAMPLES_EMPTY_LINE).sort()).toEqual(["empty-page", "no-session", "no-target"]);
    const keys = Object.keys(SAMPLES_EMPTY_LINE) as (keyof typeof SAMPLES_EMPTY_LINE)[];
    for (const a of keys) {
      for (const b of keys) {
        if (a !== b) expect(SAMPLES_EMPTY_LINE[a], `${a} vs ${b}`).not.toBe(SAMPLES_EMPTY_LINE[b]);
      }
    }
    // Each line has to name its own cause, not just differ in wording.
    expect(SAMPLES_EMPTY_LINE["no-session"]).toContain("配对");
    expect(SAMPLES_EMPTY_LINE["no-target"]).toContain("目标");
    expect(SAMPLES_EMPTY_LINE["empty-page"]).toContain("证据");
  });

  it("prints the row's own facts, in the order they are decided on", () => {
    expect(sampleLine(row("draft"))).toBe("cart-add｜public｜usable｜draft");
  });

  it("says what a recorded decision reported, without inventing what it did not", () => {
    expect(sampleDecisionLine({ auditSeq: 7, inventoryRevision: 3 }, "approved")).toBe("已批准该样本｜库存修订 3｜日志 seq 7");
    expect(sampleDecisionLine({ inventoryRevision: 4 }, "rejected")).toBe("已驳回该样本｜库存修订 4");
    expect(sampleDecisionLine({}, "approved")).toBe("已批准该样本");
  });
});

describe("mapping the inventory page onto the 样本 tab (issue #58)", () => {
  it("reads the fields the page actually publishes", () => {
    // The wire shape is §8 line 283's: `id`, and a `review` object with a `status`. Reading
    // `vectorId`/`reviewStatus` off it - the names the review route uses - used to render an
    // empty list with no error at all.
    const [row] = sampleRowsOf([
      { id: "aaaaaaaa-1111-4111-8111-111111111111", digest: "b".repeat(64), caseKey: "cart-add", visibility: "public", eligibility: "usable", review: { status: "draft" } },
    ]);
    expect(row?.vectorId).toBe("aaaaaaaa-1111-4111-8111-111111111111");
    expect(row?.reviewStatus).toBe("draft");
    expect(sampleIsDecidable(row?.reviewStatus ?? "")).toBe(true);
  });

  it("offers no decision on a row whose state it cannot read", () => {
    const [row] = sampleRowsOf([{ id: "x", digest: "y", caseKey: "z", visibility: "public", eligibility: "usable" }]);
    expect(row?.reviewStatus).toBe("unknown");
    expect(sampleIsDecidable(row?.reviewStatus ?? "")).toBe(false);
  });
});

describe("the single parse of an inventory reply (§8 lines 283 and 285 / issue #58)", () => {
  const summary = { id: "aaaaaaaa-1111-4111-8111-111111111111", digest: "b".repeat(64), caseKey: "cart-add", visibility: "public", eligibility: "usable", review: { status: "draft" } };

  it("reads rows and the revision out of the relay's envelope", () => {
    const page = samplesPageOf({ data: { items: [summary], inventoryRevision: 4 } });
    expect(page.rows).toHaveLength(1);
    // That number is what the *next* decision has to name. A page that kept the one it loaded
    // first gets a 409 it could have predicted, which is the bug this parse exists to prevent.
    expect(page.inventoryRevision).toBe(4);
  });

  it("reads the same page when the answer carried no envelope", () => {
    expect(samplesPageOf({ items: [summary], inventoryRevision: 2 }).inventoryRevision).toBe(2);
  });

  it("reports an unreadable page as no rows rather than as a page it did not see", () => {
    const page = samplesPageOf(null);
    expect(page.rows).toEqual([]);
    // 0 is the value that makes the following decision a stated conflict, not an implicit one.
    expect(page.inventoryRevision).toBe(0);
  });

  it("keeps the numbers the server published in the line the operator reads", () => {
    // expected/actual is the difference between "somebody decided first" and "this page was
    // stale"; a line that dropped them would leave the operator guessing.
    expect(samplesRefusalLine("decision", "inventory-revision-conflict", { expected: 3, actual: 4 })).toBe(
      "决定被拒：inventory-revision-conflict（actual 4 · expected 3）",
    );
    expect(samplesRefusalLine("read", "target-unknown", {})).toBe("库存读取被拒：target-unknown");
  });

  it("unwraps the envelope once, for every reply on this island", () => {
    expect(relayData({ data: { csrfToken: "issued" } })).toEqual({ csrfToken: "issued" });
    expect(relayData({ csrfToken: "issued" })).toEqual({ csrfToken: "issued" });
    expect(relayData(null)).toBeNull();
  });
});

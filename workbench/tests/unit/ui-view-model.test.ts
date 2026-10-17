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
  blueprintFreezeLine, evidenceMetaLine, FREEZE_EMPTY_LINE, importReceiptLine, NO_SESSION_LINE, projectDraftOf, PROJECT_NAME_EMPTY_LINE, projectCreateLine, sessionGate, uploadDraftOf, frozenBlueprintIds, freezablePlanIds, isSessionReason, jobActionLine, jobActions, freezePanelOf, GENERATE_EMPTY_LINE, generatePanelOf, journalEntriesOf, PROJECTS_EMPTY_LINE, pickCandidateSource, UPLOAD_NO_FILE_LINE, projectLine, projectsNotice, projectsPageOf, queuedJobLine, refusalFactsLine, refusalLine, relayData, SAMPLES_EMPTY_LINE, sampleDecisionLine, sampleRowsOf, samplesPageOf, samplesRefusalLine, sampleIsDecidable, sampleLine,
} from "../../apps/web/ui/view-model.ts";
import type { GraphEdgeView, GraphNodeView } from "../../apps/web/ui/view-model.ts";

// The three-column surface's own rules (PRD F04 / DESIGN §6, issue #18).
// Colour is never the only channel, an edge is judged by its own claim, a list view
// must not soften what the canvas said, and an UNKNOWN has to turn into the one next
// step the reason actually implies.

const COMPLETE: Coverage = { state: "complete", examined: null, total: null, reasons: [] };

// The two §8 doors that answer with a queued job row (§8 lines 294 and 297).
const VERIFY_QUEUE = { kind: "verify", done: "已排入验证队列" };
const BUILD_QUEUE = { kind: "build", done: "已排队生成" };

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


// The controls the page can honestly offer (§8 lines 270, 277-279, 297).
//
// Each branch below is a decision the browser island makes *before* it renders a button or a line,
// so a mutation that flips one of them has to show up as a wrong word on screen. That is the bar
// this file holds itself to: an unexercised branch is a branch that should not exist.
describe("the lifecycle controls on a job row (DESIGN §11, §8 lines 278-279)", () => {
  const row = (state: string, cleanupState: string) => ({ id: "job-1", kind: "build", state, cleanupState });

  it("offers cancel to the states §11 lets move", () => {
    for (const state of ["queued", "running", "cancelling"]) {
      const actions = jobActions(row(state, "pending"));
      expect(actions.cancel, state).toBe(true);
      expect(actions.cancelNote, state).toBeNull();
    }
  });

  it("names the terminal state instead of offering a cancel that can only repeat it", () => {
    for (const state of ["succeeded", "failed", "cancelled", "interrupted"]) {
      const actions = jobActions(row(state, "pending"));
      expect(actions.cancel, state).toBe(false);
      // The note quotes the state the row is in: an operator deciding whether to click twice needs
      // the reason, not a greyed-out control.
      expect(actions.cancelNote, state).toContain(state);
    }
  });

  it("refuses to guess at a state it cannot name", () => {
    const actions = jobActions(row("paused", "pending"));
    expect(actions.cancel).toBe(false);
    expect(actions.cancelNote).toContain("paused");
    expect(actions.cancelNote).toContain("不在 §11 的作业状态表里");
  });

  it("offers the cleanup retry whenever the row does not say it is done", () => {
    expect(jobActions(row("succeeded", "failed")).cleanupRetry).toBe(true);
    // `pending` stays offered even though it is the common case's opposite: the door re-schedules
    // the *leases* it can prove it minted, and a job's cleanup state is a separate state (§11).
    expect(jobActions(row("running", "pending")).cleanupRetry).toBe(true);
    expect(jobActions(row("running", "pending")).cleanupRetryNote).toBeNull();
    const done = jobActions(row("succeeded", "complete"));
    expect(done.cleanupRetry).toBe(false);
    expect(done.cleanupRetryNote).toContain("complete");
  });

  it("says what each door answered, including 'nothing was scheduled'", () => {
    expect(jobActionLine("cancel", { state: "cancelling" })).toContain("cancelling");
    expect(jobActionLine("cancel", {})).toBe("取消已被接受，但回包没带状态");
    expect(jobActionLine("cleanup-retry", { leaseIds: ["a", "b"], cleanupState: "pending" })).toContain("2 个 lease");
    expect(jobActionLine("cleanup-retry", { leaseIds: [], cleanupState: "failed" })).toContain("没有可重排的清理");
    expect(jobActionLine("cleanup-retry", { cleanupState: "pending" })).toContain("pending");
    expect(jobActionLine("cleanup-retry", {})).toContain("既没有 lease 清单也没有清理状态");
    // A non-array `leaseIds` is not silently counted as zero: the answer would then claim a fact
    // the reply never carried.
    expect(jobActionLine("cleanup-retry", { leaseIds: "nope", cleanupState: "failed" })).toContain("failed");
  });
});

describe("the verification request from the page (§8 line 297)", () => {
  it("names the job it queued and says it is only queued", () => {
    const line = queuedJobLine({ id: "job-9", state: "queued", kind: "verify" }, VERIFY_QUEUE);
    expect(line).toContain("job-9");
    expect(line).toContain("queued");
    expect(line).toContain("队列");
  });

  it("does not turn a missing id into a success, nor a foreign kind into a verification", () => {
    expect(queuedJobLine({ state: "queued" }, VERIFY_QUEUE)).toContain("没带作业 id");
    expect(queuedJobLine({ id: "x", kind: "build" }, VERIFY_QUEUE)).toContain("不是 verify");
    expect(queuedJobLine({ id: "x" }, VERIFY_QUEUE)).toContain("已排入验证队列：作业 x");
    // The same owner answers §8 line 294, and the two sentences are not one sentence twice: a
    // generation has produced a queue entry, not a verdict, and the page says which door answered.
    expect(queuedJobLine({ id: "j2", state: "queued", kind: "build" }, BUILD_QUEUE)).toBe("已排队生成：作业 j2（queued）");
    expect(queuedJobLine({ id: "j2", kind: "verify" }, BUILD_QUEUE)).toContain("不是 build");
  });
});

describe("the landing project list (§8 line 270)", () => {
  it("reads the relay envelope and the bare page alike", () => {
    const rowA = { id: "p1", name: "cart", graphRevision: 3, inventoryRevision: 4 };
    expect(projectsPageOf({ data: { items: [rowA], nextCursor: "cursor-1" } })).toEqual({
      rows: [rowA],
      nextCursor: "cursor-1",
    });
    expect(projectsPageOf({ items: [rowA], nextCursor: null })).toEqual({ rows: [rowA], nextCursor: null });
  });

  it("drops a row it cannot link to, and keeps the numbers it can show", () => {
    const listed = projectsPageOf({
      items: [
        { id: "p2", name: "no-revisions" },
        { name: "no id", id: 7 },
        null,
      ],
      nextCursor: 42,
    });
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]).toEqual({ id: "p2", name: "no-revisions", graphRevision: 0, inventoryRevision: 0 });
    // A cursor this server did not issue as a string is no cursor: the page must not carry one it
    // could not have been given.
    expect(listed.nextCursor).toBeNull();
  });

  it("tells the three empty states apart, and the refusal is not one of them", () => {
    expect(projectsNotice(null, 3)).toBe("");
    expect(projectsNotice(null, 0)).toBe(PROJECTS_EMPTY_LINE["empty-page"]);
    expect(projectsNotice({ reason: "cookie-absent", facts: {} }, 0)).toBe(PROJECTS_EMPTY_LINE["no-session"]);
    // A stale cookie after a worker restart is the same operator problem as no cookie at all
    // (§14: sessions live in the worker's memory), so it says pair again rather than "refused".
    expect(projectsNotice({ reason: "session-unknown", facts: {} }, 0)).toBe(PROJECTS_EMPTY_LINE["no-session"]);
    expect(projectsNotice({ reason: "projects-limit", facts: { limit: 5000, maxLimit: 200 } }, 0)).toContain("limit 5000");
    // The same rule the form's visibility turns on, tested once rather than guessed twice.
    expect(isSessionReason("cookie-absent")).toBe(true);
    expect(isSessionReason("session-unknown")).toBe(true);
    expect(isSessionReason("projects-limit")).toBe(false);
  });

  it("renders a row as the name plus the two revisions it read", () => {
    expect(projectLine({ id: "p", name: "cart", graphRevision: 1, inventoryRevision: 2 })).toBe("cart｜图 1｜库存 2");
  });
});

describe("one owner for how a refusal reads (§12.1)", () => {
  it("publishes the named numbers and omits them when there are none", () => {
    expect(refusalLine("决定被拒", "inventory-revision-conflict", { expected: 4, actual: 5 })).toBe(
      "决定被拒：inventory-revision-conflict（actual 5 · expected 4）",
    );
    expect(refusalLine("决定被拒", "role-may-not-decide", {})).toBe("决定被拒：role-may-not-decide");
    // The samples tab's wording is the same function now: two spellings of "this was refused and
    // here is why" is how a page ends up hiding the numbers in one of its own panels.
    expect(samplesRefusalLine("decision", "inventory-revision-conflict", { expected: 4, actual: 5 })).toBe(
      refusalLine("决定被拒", "inventory-revision-conflict", { expected: 4, actual: 5 }),
    );
    expect(samplesRefusalLine("read", "vector-cursor", {})).toBe("库存读取被拒：vector-cursor");
  });
});

// The 契约 tab's freeze and generate controls (issue #58's handle list, issue #57's last box).
// §8 gives no list route for plans or blueprints, so everything the page can offer comes out of the
// project's own decision journal - which makes the journal's *shape* the thing worth pinning here.
describe("what the journal says is freezable (§8 lines 291-292, 294 / §12.2)", () => {
  function entry(overrides: Record<string, unknown> = {}) {
    return {
      seq: 1,
      action: "plan.review",
      resourceType: "plan",
      resourceId: "plan-1",
      decision: "allow",
      reasonCode: "plan-approved",
      safeMetadata: {},
      ...overrides,
    };
  }

  it("reads the journal through the relay's own envelope and drops what it cannot name", () => {
    const listed = journalEntriesOf({ data: { entries: [entry(), { seq: 2 }, null, entry({ seq: 3, resourceId: null })] } });
    // `{seq:2}` has no action and no decision, and an entry without a resource id cannot be turned
    // into a button. Both are dropped rather than rendered with a guessed identity.
    // `{seq:2}` has no action and no decision, so it is not a decision, and `null` is not a row: both
    // are dropped rather than rendered with a guessed identity. An entry whose `resourceId` is null
    // stays — the reader is not the place that decides what is freezable.
    expect(listed.map((row) => [row.seq, row.resourceId])).toEqual([
      [1, "plan-1"],
      [3, null],
    ]);
    expect(journalEntriesOf(null)).toEqual([]);
    expect(journalEntriesOf({ data: { entries: "not-a-page" } })).toEqual([]);
  });

  it("offers a plan once and stops offering it after a freeze consumed it", () => {
    expect(freezablePlanIds([entry()])).toEqual(["plan-1"]);
    // The journal is a window, so the same approval can arrive twice on one page.
    expect(freezablePlanIds([entry(), entry({ seq: 2 })])).toEqual(["plan-1"]);
    expect(freezablePlanIds([entry(), entry({ seq: 2, decision: "deny", reasonCode: "role-may-not-decide" })])).toEqual(["plan-1"]);
    expect(
      freezablePlanIds([
        entry(),
        entry({ seq: 3, action: "blueprint.freeze", resourceType: "blueprint", resourceId: "bp-1", reasonCode: "blueprint-frozen", safeMetadata: { planId: "plan-1" } }),
      ]),
    ).toEqual([]);
    // A freeze of a *different* plan does not make this one unfreezable: the subtraction is by the
    // plan the receipt names, not by "any freeze ever happened".
    expect(
      freezablePlanIds([
        entry(),
        entry({ seq: 3, action: "blueprint.freeze", resourceId: "bp-1", reasonCode: "blueprint-frozen", safeMetadata: { planId: "plan-other" } }),
      ]),
    ).toEqual(["plan-1"]);
    expect(freezablePlanIds([entry({ decision: "deny" })])).toEqual([]);
    expect(freezablePlanIds([entry({ resourceId: null })])).toEqual([]);
    // A deny of a freeze says nothing about whether the plan is frozen.
    expect(
      freezablePlanIds([
        entry(),
        entry({ seq: 3, action: "blueprint.freeze", decision: "deny", reasonCode: "blueprint-blocked", safeMetadata: { planId: "plan-1" } }),
      ]),
    ).toEqual(["plan-1"]);
  });

  it("lists frozen blueprints newest-first without repeating one", () => {
    const frozen = (seq: number, id: string) => entry({ seq, action: "blueprint.freeze", resourceType: "blueprint", resourceId: id, reasonCode: "blueprint-frozen" });
    expect(frozenBlueprintIds([frozen(1, "bp-1"), frozen(2, "bp-2"), frozen(3, "bp-2")])).toEqual(["bp-2", "bp-1"]);
    expect(frozenBlueprintIds([entry()])).toEqual([]);
    expect(frozenBlueprintIds([entry({ seq: 4, action: "blueprint.freeze", resourceId: "bp-4", reasonCode: "blueprint-blocked", decision: "deny" })])).toEqual([]);
  });

  it("says what a freeze proved, and what it did not bring back", () => {
    expect(blueprintFreezeLine({ blueprintId: "bp-1", publicVectorCount: 9, holdoutVectorCount: 4, contractCount: 2, auditSeq: 31 })).toBe(
      "已冻结蓝图 bp-1｜公开 9｜保留 4｜契约 2｜日志 seq 31",
    );
    expect(blueprintFreezeLine({ blueprintId: "bp-1" })).toBe("已冻结蓝图 bp-1｜三个计数没带回来");
    expect(blueprintFreezeLine({ blueprintId: "bp-1", publicVectorCount: 9, holdoutVectorCount: 4, contractCount: 2 })).toBe(
      "已冻结蓝图 bp-1｜公开 9｜保留 4｜契约 2",
    );
    // A receipt without the id is the case the page must not paper over: there is then nothing to
    // ask a generation about, and "已冻结" alone would read as a fact the server never gave.
    expect(blueprintFreezeLine({})).toContain("没带蓝图 id");
    expect(blueprintFreezeLine({ publicVectorCount: 1, holdoutVectorCount: 2, contractCount: 3 })).toContain("没带蓝图 id");
  });

  it("tells a panel that read nothing apart from one that found nothing", () => {
    const approved = [entry()];
    expect(freezePanelOf(null)).toEqual({ state: "no-journal", plans: [] });
    expect(freezePanelOf([])).toEqual({ state: "no-plan", plans: [] });
    expect(freezePanelOf(approved)).toEqual({ state: "ready", plans: ["plan-1"] });
    expect(
      freezePanelOf([
        ...approved,
        entry({ seq: 9, action: "blueprint.freeze", resourceType: "blueprint", resourceId: "bp-1", reasonCode: "blueprint-frozen", safeMetadata: { planId: "plan-1" } }),
      ]),
    ).toEqual({ state: "all-frozen", plans: [] });
    // A journal of only denials is still "no approved plan", not "all frozen" - the second one tells
    // the operator to go freeze something, and nothing here was ever approvable.
    expect(freezePanelOf([entry({ decision: "deny", reasonCode: "role-may-not-decide" })])).toEqual({ state: "no-plan", plans: [] });
    expect(generatePanelOf(null)).toEqual({ state: "no-journal", blueprints: [] });
    expect(generatePanelOf(approved)).toEqual({ state: "no-blueprint", blueprints: [] });
    expect(
      generatePanelOf([entry({ seq: 9, action: "blueprint.freeze", resourceType: "blueprint", resourceId: "bp-1", reasonCode: "blueprint-frozen" })]),
    ).toEqual({ state: "ready", blueprints: ["bp-1"] });
  });

  it("keeps the three emptinesses of the freeze panel apart", () => {
    expect(FREEZE_EMPTY_LINE["no-journal"]).not.toBe(FREEZE_EMPTY_LINE["no-plan"]);
    expect(FREEZE_EMPTY_LINE["no-plan"]).not.toBe(FREEZE_EMPTY_LINE["all-frozen"]);
    expect(GENERATE_EMPTY_LINE["no-blueprint"]).toContain("冻结");
  });
});

// The two doors an operator reaches from the landing page and the 样本 tab (§8's `POST /projects`
// and line 272). Both receipts are read field by field: each has a sentence for "the server did not
// bring back what this line quotes", because a panel that fills the gap itself is a panel that has
// invented an id.
describe("the create and upload receipts (§8 POST /projects, line 272)", () => {
  it("names the project it made, with the revision that says nothing is analysed yet", () => {
    expect(projectCreateLine({ id: "p-1", name: "cart", graphRevision: 0 })).toBe("已建项目 cart｜图 0｜id p-1");
    expect(projectCreateLine({ id: "p-1", name: "cart" })).toBe("已建项目 cart｜id p-1");
    expect(projectCreateLine({ name: "cart" })).toContain("没带 id 或名字");
    expect(projectCreateLine({ id: "p-1" })).toContain("没带 id 或名字");
    expect(projectCreateLine({ id: "p-1", name: 7, graphRevision: 0 })).toContain("没带 id 或名字");
  });

  it("quotes the target and the job an import left behind, not a guessed state", () => {
    expect(importReceiptLine({ targetId: "t-1", job: { id: "j-1", state: "queued", kind: "inspect" } })).toBe(
      "已收下采集文件：目标 t-1｜作业 inspect j-1（queued）",
    );
    // A job with no state is a row the door wrote before the queue moved it - the line drops the
    // parenthetical rather than printing `undefined`.
    expect(importReceiptLine({ targetId: "t-1", job: { id: "j-1" } })).toBe("已收下采集文件：目标 t-1｜作业 j-1");
    expect(importReceiptLine({ targetId: "t-1" })).toContain("没带目标或作业 id");
    expect(importReceiptLine({ job: { id: "j-1" } })).toContain("没带目标或作业 id");
    expect(importReceiptLine({})).toContain("没带目标或作业 id");
  });

  it("keeps the three things a control can say before it sends apart", () => {
    expect(NO_SESSION_LINE).not.toBe(UPLOAD_NO_FILE_LINE);
    expect(PROJECT_NAME_EMPTY_LINE).not.toBe(NO_SESSION_LINE);
    // Each names the thing that is missing and where to fix it, which is the difference between a
    // form and a guess: the session line points at pairing, the other two at the field itself.
    expect(NO_SESSION_LINE).toContain("配对");
    expect(UPLOAD_NO_FILE_LINE).toContain("file");
    expect(PROJECT_NAME_EMPTY_LINE).toContain("名字");
  });
});

describe("what a control is allowed to send, decided before the socket (§14)", () => {
  it("holds every write back until there is a token to sign with", () => {
    expect(sessionGate("")).toEqual({ ok: false, line: NO_SESSION_LINE });
    expect(sessionGate("a-token")).toEqual({ ok: true });
  });

  it("trims a project name and refuses an empty one before posting it", () => {
    expect(projectDraftOf("  cart  ")).toEqual({ ok: true, body: { name: "cart" } });
    expect(projectDraftOf("   ")).toEqual({ ok: false, line: PROJECT_NAME_EMPTY_LINE });
    // Whitespace-only is the same absence, and saying it once here is why the door never sees a body
    // whose only field is blank.
    expect(projectDraftOf("\t\n").ok).toBe(false);
  });

  it("builds the multipart body from the four §8 names and refuses a form with no file", () => {
    const refused = uploadDraftOf({ file: null, kind: "har", deadlineAt: "", sensitiveValues: "" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.line).toBe(UPLOAD_NO_FILE_LINE);

    const file = new File([new Uint8Array([1, 2, 3])], "cart.har", { type: "application/json" });
    const built = uploadDraftOf({ file, kind: "har", deadlineAt: "  ", sensitiveValues: " a , , b " });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // An untouched deadline is absent, not an empty string the door would have to parse, and the
    // sensitive list drops blanks rather than sending a declaration of "".
    expect(built.form.getAll("deadlineAt")).toEqual([]);
    expect(built.form.getAll("sensitiveValues")).toEqual(["a", "b"]);
    expect((built.form.get("file") as File).name).toBe("cart.har");
    expect(built.form.get("kind")).toBe("har");

    const withDeadline = uploadDraftOf({ file, kind: "asar", deadlineAt: "2026-10-17T09:00:00.000Z", sensitiveValues: "" });
    expect(withDeadline.ok).toBe(true);
    if (!withDeadline.ok) return;
    expect(withDeadline.form.getAll("deadlineAt")).toEqual(["2026-10-17T09:00:00.000Z"]);
    expect(withDeadline.form.getAll("sensitiveValues")).toEqual([]);
  });
});

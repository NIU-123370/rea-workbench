import { describe, expect, it } from "vitest";

import { newId } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { ClaimEvidenceState, Coverage } from "../../packages/domain/evidence.ts";
import {
  jobFailureLine,
  buildLeftPanel,
  buildMiddlePanel,
  canvasEdges,
  buildRightTabs,
  directedInquiry,
  listView,
  presentStatus,
  blueprintFreezeLine, evidenceMetaLine, FREEZE_EMPTY_LINE, importReceiptLine, NO_SESSION_LINE, projectDraftOf, PROJECT_NAME_EMPTY_LINE, projectCreateLine, sessionGate, uploadDraftOf, frozenBlueprintIds, freezablePlanIds, isSessionReason, jobActionLine, jobActions, jobUpdateSignalOf, STREAM_LINE, streamLineOf, freezePanelOf, GENERATE_EMPTY_LINE, generatePanelOf, journalEntriesOf, PROJECTS_EMPTY_LINE, pickCandidateSource, UPLOAD_NO_FILE_LINE, projectLine, projectsNotice, projectsPageOf, queuedJobLine, refusalFactsLine, refusalLine, relayData, SAMPLES_EMPTY_LINE, sampleDecisionLine, sampleRowsOf, samplesPageOf, samplesRefusalLine, sampleIsDecidable, sampleLine,
  COMPARATOR_EMPTY_LINE, COMPARATOR_UNREADABLE_LINE, COMPARATOR_UNSELECTED_LINE, comparatorOptionsOf, verifyDraftOf,
  inspectDraftOf, inspectSubjectLine, inspectSubjectOf, inspectTargetReadOf, inquiryQueueLine, inspectClaimsNoteFor,
  INSPECT_CHOICE_UNLISTED_LINE, INSPECT_FIRST_ANALYSIS_NOTE, INSPECT_GRAPH_UNREAD_LINE, INSPECT_NEEDS_CLAIMS_LINE, INSPECT_NO_TARGET_LINE, INSPECT_QUESTION_EMPTY_LINE, INSPECT_REVISION_UNREAD_LINE, INSPECT_SCOPE_UNSELECTED_LINE, INSPECT_TARGET_UNREADABLE_LINE, INSPECT_TARGET_URL_LINE, INQUIRY_KIND_LINES, INSPECT_CAPTURE_NOTE,
  jobDetailLine, jobDetailOf, reportLine, reportOf, SESSION_SIGN_OUT_LINE, VERIFIED_SAMPLES_NEEDS_JOB_LINE, verificationIdOfJob,
  EXPORTS_EMPTY_LINE, exportDownloadLine, exportReceiptLine, exportRowOf, exportsRowsOf,
  captureActionOf, captureDraftOf, captureProfileOptionsOf, captureSubjectLine, captureSubjectOf, TARGET_URL_EMPTY_LINE, targetDraftOf, targetReceiptLine, approvedContractIds, planBuildLine, planDraftOf, planExclusionOf, planSubjectLine, planSubjectOf, PLAN_CONTRACT_UNLISTED_LINE, PLAN_CONTRACT_UNSELECTED_LINE, PLAN_NO_CONTRACTS_LINE, PLAN_NO_INVENTORY_LINE, PLAN_NO_JOURNAL_LINE, PLAN_NO_SNAPSHOT_LINE, PLAN_NO_TARGET_LINE, PLAN_SUCCESSOR_EMPTY_LINE, PLAN_TARGET_UNREADABLE_LINE, CAPTURE_ACTION_OPTIONS, CAPTURE_LOCATOR_OPTIONS, CAPTURE_WAIT_STATE_OPTIONS, CAPTURE_NETWORK_NOTE, CAPTURE_NO_TARGET_LINE, CAPTURE_TARGET_UNREADABLE_LINE, CAPTURE_TARGET_NOT_URL_LINE, CAPTURE_PROFILES_UNREADABLE_LINE, CAPTURE_PROFILES_EMPTY_LINE, CAPTURE_PROFILE_UNSELECTED_LINE, CAPTURE_START_URL_EMPTY_LINE, CAPTURE_TIMEOUT_LINE,
} from "../../apps/web/ui/view-model.ts";
import type { CaptureActionRow, CaptureProfileOption, JournalEntryWire, PlanExclusionRow, GraphEdgeView, GraphNodeView, InspectSubject, InspectTargetRead } from "../../apps/web/ui/view-model.ts";

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
      target: { id: newId() },
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
      target: { id: newId() },
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

// §13's frames are the only way this page learns that a job moved without being asked (issue #85),
// so the two things worth pinning are: a frame that is not a `job.updated` is not a signal, and the
// panel's sentence distinguishes "live" from "a snapshot you should not trust".
describe("the job stream a panel subscribes to (§13, issue #85)", () => {
  function frame(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      seq: 7,
      projectId: "p-1",
      type: "job.updated",
      aggregateId: "j-1",
      createdAt: "2026-10-17T08:00:00.000Z",
      payload: { resourceIds: ["j-1"], state: "succeeded" },
      ...overrides,
    });
  }

  it("reads the row and cursor out of a job.updated frame", () => {
    expect(jobUpdateSignalOf(frame())).toEqual({ seq: 7, jobId: "j-1", state: "succeeded", kind: null });
    // A frame whose payload names no state still names the job whose row must be re-read.
    expect(jobUpdateSignalOf(frame({ payload: { resourceIds: ["j-1"] } }))).toEqual({
      seq: 7,
      jobId: "j-1",
      state: null,
      kind: null,
    });
  });

  it("treats anything it cannot read as no signal", () => {
    expect(jobUpdateSignalOf("not json")).toBeNull();
    expect(jobUpdateSignalOf(frame({ type: "audit.appended" }))).toBeNull();
    expect(jobUpdateSignalOf(frame({ seq: "7" }))).toBeNull();
    expect(jobUpdateSignalOf(frame({ aggregateId: 12 }))).toBeNull();
    expect(jobUpdateSignalOf("{}")).toBeNull();
  });

  it("says whether the rows on screen are being kept up to date", () => {
    expect(streamLineOf("connecting", null)).toBe(STREAM_LINE.connecting);
    expect(streamLineOf("open", null)).toBe(STREAM_LINE.open);
    expect(streamLineOf("open", 12)).toContain("seq 12");
    expect(streamLineOf("closed", 12)).toContain("快照");
    expect(STREAM_LINE.connecting).not.toBe(STREAM_LINE.open);
    expect(STREAM_LINE.closed).not.toBe(STREAM_LINE.open);
  });
});

// The comparator list a verification request is chosen from (issue #82). Three rules the tests are
// built to hold: the page never preselects, it never shows a list it cannot read, and the three
// "nothing to choose" states are three different sentences.
describe("choosing a comparator from what this build installed (§8 line 297, issue #82)", () => {
  // The two policies the contracts install, in the installed order, exactly as the read door answers.
  const INSTALLED = {
    policies: [
      { policyId: "exact-http-v1", version: "1.0.0", normalization: [] },
      { policyId: "exact-http-normalized-v1", version: "1.0.0", normalization: ["http-header-name-case", "json-key-order"] },
    ],
  };

  function readyDraft(chosen: string) {
    return verifyDraftOf({ csrf: "token-1234567890", options: comparatorOptionsOf(INSTALLED), chosen });
  }

  it("labels each policy with what it will treat as equal, in the order it was installed", () => {
    const options = comparatorOptionsOf(INSTALLED);
    if (options === null) throw new Error("the installed list should read");
    // The order is the worker's, not alphabetical: sorting would put the looser policy first, and a
    // first option is what a screen reads as a suggestion.
    expect(options.map((option) => option.policyId)).toEqual(["exact-http-v1", "exact-http-normalized-v1"]);
    expect(options[0]?.label).toContain("逐字节严格");
    expect(options[1]?.label).toContain("header 名大小写");
    expect(options[1]?.label).toContain("JSON 键序");
    // A name the operator cannot see is a name they cannot choose, so the id is in the label.
    expect(options[1]?.label).toContain("exact-http-normalized-v1");
  });

  it("refuses to render a list it cannot read, in each of the ways that happens", () => {
    expect(comparatorOptionsOf(undefined)).toBeNull();
    expect(comparatorOptionsOf({})).toBeNull();
    expect(comparatorOptionsOf({ policies: "two of them" })).toBeNull();
    // An unknown normalization is the important one: the page would have to label a rule it does
    // not know, and half a list labelled is worse than none.
    expect(comparatorOptionsOf({ policies: [{ policyId: "x", version: "1", normalization: ["ignore-volatile-fields"] }] })).toBeNull();
    expect(comparatorOptionsOf({ policies: [{ policyId: "", version: "1", normalization: [] }] })).toBeNull();
    expect(comparatorOptionsOf({ policies: [{ policyId: "x", normalization: [] }] })).toBeNull();
    // And the positive case, so none of the above is passing because nothing ever reads.
    expect(comparatorOptionsOf({ policies: [{ policyId: "x", version: "1", normalization: ["timestamp-second-rounding"] }] })).not.toBeNull();
  });

  it("keeps the three nothing-to-choose states in three different sentences", () => {
    const lines = [COMPARATOR_UNREADABLE_LINE, COMPARATOR_EMPTY_LINE, COMPARATOR_UNSELECTED_LINE];
    expect(new Set(lines).size).toBe(3);
    expect(COMPARATOR_UNREADABLE_LINE).toContain("读不到");
    expect(COMPARATOR_EMPTY_LINE).toContain("没有安装");
    expect(COMPARATOR_UNSELECTED_LINE).toContain("还没有选");
    // An empty list is a reading, not a failure to read: the two must not share a state.
    const empty = comparatorOptionsOf({ policies: [] });
    expect(empty).toEqual([]);
    const withEmpty = verifyDraftOf({ csrf: "token-1234567890", options: empty, chosen: "" });
    expect(withEmpty.ok).toBe(false);
    if (withEmpty.ok) return;
    expect(withEmpty.line).toBe(COMPARATOR_EMPTY_LINE);

    // …and a list that never arrived is neither of those: folding it into "empty" would tell the
    // operator this build installs nothing, which is a claim about the deployment the page cannot make.
    const unreadable = verifyDraftOf({ csrf: "token-1234567890", options: null, chosen: "" });
    expect(unreadable.ok).toBe(false);
    if (unreadable.ok) return;
    expect(unreadable.line).toBe(COMPARATOR_UNREADABLE_LINE);
  });

  it("asks before anything else whether there is a session to sign with", () => {
    // Both other failures are present here, and the session sentence still wins: an unpaired page
    // has no door to send through, and telling it about its list would send it to fix the wrong thing.
    const draft = verifyDraftOf({ csrf: "", options: null, chosen: "" });
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.line).toBe(NO_SESSION_LINE);
  });

  it("lets a request go only once the operator has actually chosen", () => {
    const unchosen = readyDraft("");
    expect(unchosen.ok).toBe(false);
    if (unchosen.ok) return;
    expect(unchosen.line).toBe(COMPARATOR_UNSELECTED_LINE);

    const chosen = readyDraft("exact-http-normalized-v1");
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    // What goes out is the name from the list, byte for byte - the page adds no default and no
    // rewriting, so the door's own refusal vocabulary is still the thing being tested.
    expect(chosen.comparatorPolicyId).toBe("exact-http-normalized-v1");
  });
});

// §8 line 275's inspect half: the page can finally send a directed investigation instead of writing a
// note about one (issue #58's last control). Every assertion here is about what may cross the socket,
// because the door itself has been tested since issue #58's last slice.
describe("the directed-inspect handle (§8 line 275, issue #58)", () => {
  const targetId = newId();
  const claimA = newId();
  const claimB = newId();

  const readySubject = {
    graph: { targetId, claimIds: [claimA, claimB] },
    target: { ok: true, kind: "har", snapshotDigest: null } as const,
    graphRevision: 7,
  };

  function draftInput(
    overrides: Partial<{ csrf: string; graph: { targetId: string | null; claimIds: readonly string[] } | null; target: InspectTargetRead | null; graphRevision: number | null; chosen: readonly string[]; question: string; scope: string }> = {},
  ) {
    return {
      csrf: "token-1234567890",
      graph: readySubject.graph,
      target: readySubject.target,
      graphRevision: readySubject.graphRevision,
      chosen: [claimA],
      question: "这个响应在什么条件下会缺字段",
      scope: "static",
      ...overrides,
    };
  }

  it("reads a target row only when it names the row this page asked about", () => {
    expect(inspectTargetReadOf({ id: targetId, kind: "har", snapshotDigest: null }, targetId)).toEqual({ ok: true, kind: "har", snapshotDigest: null });
    // The relay's envelope must not decide: the same row read through `{data: …}` is the same answer.
    expect(inspectTargetReadOf({ data: { id: targetId, kind: "asar", snapshotDigest: null } }, targetId)).toEqual({ ok: true, kind: "asar", snapshotDigest: null });
    // A URL target is a kind the read *recognises*, not a broken read - blocking it is the subject
    // gate's job, because that gate can say why.
    expect(inspectTargetReadOf({ id: targetId, kind: "url", snapshotDigest: null }, targetId)).toEqual({ ok: true, kind: "url", snapshotDigest: null });

    const mismatch = inspectTargetReadOf({ id: newId(), kind: "har", snapshotDigest: null }, targetId);
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    // The two ids are named: "the read answered about a different row" is only actionable if the
    // operator can see which row that was.
    expect(mismatch.line).toContain("另一个行");

    expect(inspectTargetReadOf(undefined, targetId).ok).toBe(false);
    // A row that never says what its snapshot digest is (a string or an explicit `null`, §8 line 274) is
    // a read the plan control must not guess from: it fails as an unreadable row, not as "no snapshot".
    expect(inspectTargetReadOf({ id: targetId, kind: "har" }, targetId).ok).toBe(false);
    expect(inspectTargetReadOf({ id: targetId, kind: "har", snapshotDigest: 7 }, targetId).ok).toBe(false);
    expect(inspectTargetReadOf({ id: targetId, kind: "har", snapshotDigest: "z".repeat(64) }, targetId)).toEqual({
      ok: true,
      kind: "har",
      snapshotDigest: "z".repeat(64),
    });
    expect(inspectTargetReadOf({ id: targetId, kind: 7 }, targetId).ok).toBe(false);
    // An unknown vocabulary word is refused *without echoing it*: §12.1 publishes names, never values,
    // and this is the one field whose value has already failed the closed list.
    const hostile = inspectTargetReadOf({ id: targetId, kind: "SNAPSHOT-onerror<svg>" }, targetId);
    expect(hostile.ok).toBe(false);
    if (hostile.ok) return;
    expect(hostile.line).not.toContain("SNAPSHOT");
    expect(hostile.line).toContain("不是三种目标类型之一");
  });

  it("keeps the six ways a subject can be unavailable in six different sentences, checked in read order", () => {
    const refusalOf = (subject: InspectSubject) => (subject.ok ? "ready" : subject.line);
    expect(
      [
        refusalOf(inspectSubjectOf({ graph: null, target: readySubject.target, graphRevision: 7 })),
        refusalOf(inspectSubjectOf({ graph: { targetId: null, claimIds: [] }, target: readySubject.target, graphRevision: 7 })),
        refusalOf(inspectSubjectOf({ graph: readySubject.graph, target: null, graphRevision: 7 })),
        refusalOf(inspectSubjectOf({ graph: readySubject.graph, target: { ok: false, line: "目标行读到的形状不对" }, graphRevision: 7 })),
        refusalOf(inspectSubjectOf({ graph: readySubject.graph, target: { ok: true, kind: "url", snapshotDigest: null }, graphRevision: 7 })),
        refusalOf(inspectSubjectOf({ graph: readySubject.graph, target: readySubject.target, graphRevision: null })),
      ]
      // Pinned by identity and by position: swapping two branches would tell the operator to go fix
      // something that is already fine.
    ).toEqual([
      INSPECT_GRAPH_UNREAD_LINE,
      INSPECT_NO_TARGET_LINE,
      INSPECT_TARGET_UNREADABLE_LINE,
      "目标行读到的形状不对",
      INSPECT_TARGET_URL_LINE,
      INSPECT_REVISION_UNREAD_LINE,
    ]);

    const ready = inspectSubjectOf(readySubject);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    // Read back by value, not just by field name: the token the request will carry is the one the
    // project row gave, and the claim list is the graph's, in the graph's order.
    expect(ready).toEqual({ ok: true, targetId, kind: "har", graphRevision: 7, claimIds: [claimA, claimB] });
  });

  it("shows the concurrency token in the sentence, because a 409 has to be explainable", () => {
    const line = inspectSubjectLine(inspectSubjectOf(readySubject), false);
    expect(line).toContain(targetId);
    expect(line).toContain("图修订 7");
    expect(line).toContain("HAR 导入的字节");
    expect(line).not.toContain("截断");
    // A truncated view is said on the same line as the claim list it limits - the list below is then
    // only part of what the target holds, and an operator choosing claims has to know that.
    expect(inspectSubjectLine(inspectSubjectOf(readySubject), true)).toContain("截断");
    const blocked = inspectSubjectLine({ ok: false, line: INSPECT_TARGET_URL_LINE }, true);
    expect(blocked).toBe(INSPECT_TARGET_URL_LINE);
    expect(blocked).not.toContain("截断");
  });

  it("refuses before anything crosses the socket, one named cause at a time", () => {
    // Every precondition broken at once, and the session sentence still wins: an unpaired page has no
    // door to send through, so the rest is not yet its problem.
    const nothing = inspectDraftOf({ csrf: "", graph: null, target: null, graphRevision: null, chosen: [], question: "", scope: "" });
    expect(nothing.ok).toBe(false);
    if (nothing.ok) return;
    expect(nothing.line).toBe(NO_SESSION_LINE);

    for (const [overrides, line] of [
      [{ graph: null }, INSPECT_GRAPH_UNREAD_LINE],
      [{ graph: { targetId: null, claimIds: [] } }, INSPECT_NO_TARGET_LINE],
      [{ target: null }, INSPECT_TARGET_UNREADABLE_LINE],
      [{ target: { ok: true, kind: "url", snapshotDigest: null } as const }, INSPECT_TARGET_URL_LINE],
      [{ graphRevision: null }, INSPECT_REVISION_UNREAD_LINE],
      [{ question: "   " }, INSPECT_QUESTION_EMPTY_LINE],
      [{ scope: "" }, INSPECT_SCOPE_UNSELECTED_LINE],
      // A value outside the two the page renders is the same unanswered question - and it must not be
      // waved through as "close enough", which is how a default gets smuggled in.
      [{ scope: "captured-runtime-ish" }, INSPECT_SCOPE_UNSELECTED_LINE],
      [{ chosen: [] }, INSPECT_NEEDS_CLAIMS_LINE],
      [{ chosen: [newId()] }, INSPECT_CHOICE_UNLISTED_LINE],
    ] as const) {
      const draft = inspectDraftOf(draftInput(overrides));
      expect(draft.ok).toBe(false);
      if (draft.ok) return;
      expect(draft.line).toBe(line);
    }

    const padded = inspectDraftOf(draftInput({ question: "  这个响应在什么条件下会缺字段  " }));
    expect(padded.ok).toBe(true);
    if (!padded.ok) return;
    // What goes out is the trimmed answer, so the door's `nonEmptyString` is not satisfied by spaces.
    expect(padded.body.task.question).toBe("这个响应在什么条件下会缺字段");
  });

  it("keeps §8's one empty-claim exception distinct from its directed rule", () => {
    const directed = inspectDraftOf(draftInput({ chosen: [] }));
    expect(directed.ok).toBe(false);

    const firstAnalysis = inspectDraftOf(draftInput({ graph: { targetId, claimIds: [] }, chosen: [] }));
    expect(firstAnalysis.ok).toBe(true);
    if (!firstAnalysis.ok) return;
    // The empty list is what §8 allows for a target that has never been analysed; refusing it here
    // would make the first inspect of a fresh import impossible to ask for.
    expect(firstAnalysis.body.task.claimIds).toEqual([]);
  });

  it("lists the checked claims in the read's order, never the click's", () => {
    const both = inspectDraftOf(draftInput({ chosen: [claimA, claimB] }));
    const reversed = inspectDraftOf(draftInput({ chosen: [claimB, claimA] }));
    expect(both.ok).toBe(true);
    expect(reversed.ok).toBe(true);
    if (!both.ok || !reversed.ok) return;
    expect(both.body.task.claimIds).toEqual([claimA, claimB]);
    // Same boxes, same body: §8's request digest is computed over this body, so a click sequence must
    // not become a second identity for one request.
    expect(reversed.body).toEqual(both.body);

    // Half-known is not half-sent: dropping the unlisted id would silently narrow what was asked about.
    const partly = inspectDraftOf(draftInput({ chosen: [claimA, newId()] }));
    expect(partly.ok).toBe(false);
    if (partly.ok) return;
    expect(partly.line).toBe(INSPECT_CHOICE_UNLISTED_LINE);
  });

  it("sends exactly the fields §8 line 275 lists and no others", () => {
    const draft = inspectDraftOf(draftInput({ chosen: [claimA, claimB], scope: "captured-runtime" }));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(Object.keys(draft.body).sort()).toEqual(["expectedGraphRevision", "targetId", "task"]);
    expect(Object.keys(draft.body.task).sort()).toEqual(["claimIds", "kind", "question", "scope"]);
    expect(draft.body).toEqual({
      targetId,
      expectedGraphRevision: 7,
      task: { kind: "inspect", claimIds: [claimA, claimB], question: "这个响应在什么条件下会缺字段", scope: "captured-runtime" },
    });
    // Nothing here is a `capture` field: profileId, scenario, network and sensitiveValues belong to the
    // other half of the union, and the two sections that build them must not merge into one body.
    expect(JSON.stringify(draft.body)).not.toContain("sensitiveValues");
    expect(JSON.stringify(draft.body)).not.toContain("profileId");
  });

  it("only prints the 首次分析 sentence about a target it actually read", () => {
    // The sentence is "this target holds no claims yet". Printing it for a project with no target, or
    // for a page that has not read anything, turns an unanswered question into an answered-looking one -
    // which is what the browser pass for this round caught.
    expect(inspectClaimsNoteFor(null)).toBeNull();
    expect(inspectClaimsNoteFor({ targetId: null, claimIds: [] })).toBeNull();
    expect(inspectClaimsNoteFor({ targetId, claimIds: [] })).toBe(INSPECT_FIRST_ANALYSIS_NOTE);
    expect(inspectClaimsNoteFor({ targetId, claimIds: [claimA] })).toBeNull();
  });

  it("says which recorded gap can become a request on this page, in words an operator reads", () => {
    const kinds = Object.keys(INQUIRY_KIND_LINES).sort();
    expect(kinds).toEqual(["capture-new", "inspect-runtime", "read-evidence", "review-claim"]);
    expect(new Set(Object.values(INQUIRY_KIND_LINES)).size).toBe(4);
    expect(INQUIRY_KIND_LINES["inspect-runtime"]).toContain("line 275");
    // Both sendable kinds now point at a section that exists, and say which: §8 line 310 makes an
    // active capture its own CaptureTask, so the queue entry has to name where that is composed.
    expect(INQUIRY_KIND_LINES["capture-new"]).toContain("line 310");
    expect(INQUIRY_KIND_LINES["capture-new"]).toContain("发起一次采集");
    expect(INQUIRY_KIND_LINES["capture-new"]).not.toContain("发不出");
    expect(INSPECT_CAPTURE_NOTE).toContain("发起一次采集");

    const line = inquiryQueueLine({
      kind: "inspect-runtime",
      subjectId: "cell-9",
      gaps: ["authority-not-applicable", "basis-unknown"],
      request: { subjectId: "cell-9" },
    });
    expect(line).toContain("inspect-runtime");
    expect(line).toContain("cell-9");
    expect(line).toContain("authority-not-applicable、basis-unknown");
    expect(line).toContain(INQUIRY_KIND_LINES["inspect-runtime"]);
    // The queue used to print `JSON.stringify(inquiry)`: a wire-shaped blob for a request nobody sent.
    expect(line).not.toContain("{");
    expect(inquiryQueueLine({ kind: "review-claim", subjectId: "cell-9", gaps: [], request: {} })).toContain("（无）");
  });
});

// The capture half of §8 line 275 (issue #58's last handle). Three rules decide the shape of these
// tests: nothing crosses the socket until every name the door requires has an answer (§10 forbids the
// page guessing a profile), an operator reads a failure as "第 2 行缺 name" and not as a union that did
// not parse, and every value in the body is one the composer was actually given - no defaults, because
// a default here would be the page choosing a sandbox or a recording breadth nobody asked for.
describe("capture composer (DESIGN §8 line 275's CaptureTask)", () => {
  const profileList = {
    effectiveProfiles: [
      { id: "web-fixture", available: true, browserVersion: "1.55.0", unavailableReasons: [] },
      { id: "linux-x64-chrome", available: false, browserVersion: "1.54.0", unavailableReasons: ["host-executable-missing"] },
      // A third, also available: with one of each the two counts the subject line publishes are the
      // same number, and an inverted `available` filter would still read correctly - which is how a
      // symmetric fixture hides its own assertion.
      { id: "web-fixture-arm64", available: true, browserVersion: "1.55.0", unavailableReasons: [] },
    ],
  };

  const row = (overrides: Partial<CaptureActionRow> = {}): CaptureActionRow => ({
    kind: "click",
    locatorKind: "testId",
    role: "",
    name: "",
    testId: "checkout",
    value: "",
    waitState: "",
    ...overrides,
  });

  // Named rather than inferred: a union of these object literals is what TS builds when the list is
  // inline, and a union with `?: never` markers is not assignable to the gate's parameter under
  // `exactOptionalPropertyTypes` - so the shape the two functions take is written once, here.
  type SubjectGaps = readonly Partial<{ targetId: string | null; target: InspectTargetRead | null; graphRevision: number | null; profiles: CaptureProfileOption[] | null }>[];

  function captureInput(
    overrides: Partial<{ csrf: string; targetId: string | null; target: InspectTargetRead | null; graphRevision: number | null; profiles: CaptureProfileOption[] | null; profileId: string; startUrl: string; rows: readonly CaptureActionRow[]; requestBody: boolean; responseBody: boolean; headerValues: boolean; timeoutMs: string; sensitiveValues: string }> = {},
  ) {
    return {
      csrf: "token-1234567890",
      targetId: "22222222-2222-4222-8222-222222222222",
      target: { ok: true, kind: "url", snapshotDigest: null } as const,
      graphRevision: 0,
      profiles: captureProfileOptionsOf(profileList),
      profileId: "web-fixture",
      startUrl: "http://127.0.0.1:4110/checkout",
      rows: [row()],
      requestBody: false,
      responseBody: false,
      headerValues: false,
      timeoutMs: "",
      sensitiveValues: "",
      ...overrides,
    };
  }

  it("states its subject once, and the submit refuses exactly what that sentence says is missing", () => {
    const subjectOf = (overrides: Partial<{ targetId: string | null; target: InspectTargetRead | null; graphRevision: number | null; profiles: CaptureProfileOption[] | null }>) =>
      captureSubjectOf({ targetId: "22222222-2222-4222-8222-222222222222", target: { ok: true, kind: "url", snapshotDigest: null }, graphRevision: 3, profiles: captureProfileOptionsOf(profileList), ...overrides });

    const ready = subjectOf({});
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    // Read back by value: the id and the token the request will carry are the ones the reads gave, and a
    // `graphRevision: 0` is a real token rather than an absence.
    expect(ready).toEqual({ ok: true, targetId: "22222222-2222-4222-8222-222222222222", graphRevision: 3, profiles: captureProfileOptionsOf(profileList) });
    const line = captureSubjectLine(ready);
    expect(line).toContain("22222222-2222-4222-8222-222222222222");
    expect(line).toContain("图修订 3");
    // Both counts, because they are two different facts: an unavailable profile is still a name the
    // operator may choose, and the door's refusal is what settles it - the panel only says how many
    // this host can run.
    expect(line).toContain("2 个可用，清单共 3 个");
    expect(captureSubjectLine(subjectOf({ graphRevision: 0 }))).toContain("图修订 0");

    // The reconciliation this section lives on: for every subject-level gap, the sentence under the
    // heading and the reason a submit refuses are the same string. A gate duplicated between the two,
    // or a branch added to only one of them, breaks here rather than on the screen.
    const gaps: SubjectGaps = [
      { targetId: null },
      { target: null },
      { target: { ok: false, line: "目标行读到的形状不对" } },
      { target: { ok: true, kind: "har", snapshotDigest: null } },
      { graphRevision: null },
      { profiles: null },
      { profiles: [] },
    ];
    for (const overrides of gaps) {
      const subject = subjectOf(overrides);
      expect(subject.ok).toBe(false);
      if (subject.ok) return;
      expect(captureSubjectLine(subject)).toBe(subject.line);
      expect(captureDraftOf(captureInput(overrides))).toEqual({ ok: false, line: subject.line });
    }

    // Answered fields are *not* subject facts: the panel says nothing about an empty startUrl before the
    // operator has had the chance to type one, while the gate refuses. That asymmetry is the reason the
    // two functions are two functions.
    expect(captureDraftOf(captureInput({ startUrl: "" })).ok).toBe(false);
  });

  it("offers exactly the names the contract takes, in the order the domain lists them", () => {
    // The screen's option lists are the closed set, so a fourth action the worker would refuse (or a
    // third wait state nobody can observe) cannot appear as a choice - and a kind the union has cannot
    // go missing from the row editor.
    expect(CAPTURE_ACTION_OPTIONS.map((option) => option.value)).toEqual(["click", "fill", "waitFor"]);
    expect(CAPTURE_LOCATOR_OPTIONS.map((option) => option.value)).toEqual(["role", "testId"]);
    expect(CAPTURE_WAIT_STATE_OPTIONS.map((option) => option.value)).toEqual(["visible", "hidden"]);
    // Every option says what it does in the operator's language: an untranslated key is a control whose
    // label comes from the wire, and `undefined` is what a missing phrase would print.
    for (const options of [CAPTURE_ACTION_OPTIONS, CAPTURE_LOCATOR_OPTIONS, CAPTURE_WAIT_STATE_OPTIONS]) {
      for (const option of options) {
        expect(option.label.length).toBeGreaterThan(0);
        expect(option.label).not.toContain("undefined");
      }
    }
    expect(CAPTURE_ACTION_OPTIONS.map((option) => option.label)).toEqual(["点击（click）", "填入（fill）", "等待状态（waitFor）"]);
  });

  it("builds one row at a time and blames the row, not the union", () => {
    expect(captureActionOf(row(), 0)).toEqual({
      ok: true,
      action: { kind: "click", locator: { kind: "testId", value: "checkout" } },
    });
    // Trimmed on the way out: the door's `nonEmptyString` would accept " Admin ", and a locator with
    // padding matches no element - the mistake is invisible unless the value is normalised here.
    expect(captureActionOf(row({ locatorKind: "role", role: " button ", name: " Checkout ", testId: "ignored" }), 1)).toEqual({
      ok: true,
      action: { kind: "click", locator: { kind: "role", role: "button", name: "Checkout" } },
    });
    // `fill` with an empty value is how you clear a box, and §8 types it as `string`, so the composer
    // must not add a non-empty rule the contract does not have.
    expect(captureActionOf(row({ kind: "fill", testId: "qty", value: "" }), 2)).toEqual({
      ok: true,
      action: { kind: "fill", locator: { kind: "testId", value: "qty" }, value: "" },
    });
    expect(captureActionOf(row({ kind: "waitFor", testId: "receipt", waitState: "hidden" }), 0)).toEqual({
      ok: true,
      action: { kind: "waitFor", locator: { kind: "testId", value: "receipt" }, state: "hidden" },
    });

    const failures = [
      [row({ kind: "evaluate" }), 0, "不在 §8 的三个里"],
      [row({ kind: "click", locatorKind: "css" }), 0, "不在 §8 的两个里"],
      [row({ locatorKind: "role", role: "", name: "Checkout" }), 1, "第 2 行缺角色名"],
      [row({ locatorKind: "role", role: "button", name: "  " }), 0, "缺名称（name）"],
      [row({ locatorKind: "testId", testId: " " }), 2, "第 3 行缺 testId"],
      [row({ kind: "waitFor", waitState: "" }), 0, "没说要等到什么状态"],
      [row({ kind: "waitFor", waitState: "networkidle" }), 0, "没说要等到什么状态"],
    ] as const;
    for (const [badRow, index, fragment] of failures) {
      const built = captureActionOf(badRow, index);
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.failure.index).toBe(index);
      expect(built.failure.line).toContain(fragment);
    }

    // An action kind outside the closed list is refused *without echoing it* - the same §12.1 rule the
    // target-kind read follows, because this is a field whose value already failed a closed vocabulary.
    const hostile = captureActionOf(row({ kind: "eval`; require('child_process')" }), 0);
    expect(hostile.ok).toBe(false);
    if (hostile.ok) return;
    expect(hostile.failure.line).not.toContain("child_process");
    expect(hostile.failure.line).not.toContain("eval");
  });

  it("reads profile names only from the health payload, and drops the whole list when a row is half-formed", () => {
    const options = captureProfileOptionsOf(profileList);
    expect(options).not.toBeNull();
    if (options === null) return;
    expect(options.map((option) => option.id)).toEqual(["web-fixture", "linux-x64-chrome", "web-fixture-arm64"]);
    expect(options[0]?.available).toBe(true);
    expect(options[0]?.label).toContain("web-fixture");
    expect(options[0]?.label).toContain("1.55.0");
    expect(options[0]?.label).toContain("可用");
    // An unavailable profile is still listed, with its reason: hiding it would leave the operator
    // choosing a name the door refuses, and a list without the reason is a mystery rather than a fact.
    expect(options[1]?.label).toContain("本机不可用");
    expect(options[1]?.label).toContain("host-executable-missing");

    // Half-parsed is not half-offered: one row whose id or availability is missing takes the list down
    // to "unreadable", which the composer answers with its own sentence.
    expect(captureProfileOptionsOf(null)).toBeNull();
    expect(captureProfileOptionsOf({})).toBeNull();
    expect(captureProfileOptionsOf({ effectiveProfiles: {} })).toBeNull();
    expect(captureProfileOptionsOf({ effectiveProfiles: [{ available: true }] })).toBeNull();
    expect(captureProfileOptionsOf({ effectiveProfiles: [{ id: "p", available: "yes" }] })).toBeNull();
    expect(captureProfileOptionsOf({ effectiveProfiles: [{ id: "", available: true }] })).toBeNull();
    // An empty list is a *read* answer ("this build has no profile") and stays a list, so the composer
    // can say 一个 profile 都没有 instead of the vaguer 读不到.
    expect(captureProfileOptionsOf({ effectiveProfiles: [] })).toEqual([]);
    // A profile that does not name its browser version says so, rather than printing a blank.
    const noVersion = captureProfileOptionsOf({ effectiveProfiles: [{ id: "p", available: true }] });
    expect(noVersion?.[0]?.label).toContain("版本未知");
    // Nor does one that claims to be unavailable while naming nothing.
    const noReason = captureProfileOptionsOf({ effectiveProfiles: [{ id: "p", available: false, unavailableReasons: [] }] });
    expect(noReason?.[0]?.label).toContain("未具名");
  });

  it("refuses before anything crosses the socket, one named cause at a time, in read order", () => {
    const lineOf = (input: Parameters<typeof captureDraftOf>[0]) => {
      const draft = captureDraftOf(input);
      return draft.ok ? "ready" : draft.line;
    };
    // Every precondition broken at once and the session sentence still wins.
    expect(
      lineOf(
        captureInput({
          csrf: "",
          targetId: null,
          target: null,
          graphRevision: null,
          profiles: null,
          profileId: "",
          startUrl: "",
          rows: [row({ testId: "" })],
        }),
      ),
    ).toBe(NO_SESSION_LINE);

    // Pinned by identity and by position: two of these sentences swapped would tell the operator to go
    // fix something that is already fine.
    expect(
      [
        lineOf(captureInput({ targetId: null })),
        lineOf(captureInput({ target: null })),
        lineOf(captureInput({ target: { ok: false, line: "目标行读到的形状不对" } })),
        lineOf(captureInput({ target: { ok: true, kind: "har", snapshotDigest: null } })),
        lineOf(captureInput({ graphRevision: null })),
        lineOf(captureInput({ profiles: null })),
        lineOf(captureInput({ profiles: [] })),
        lineOf(captureInput({ profileId: "" })),
        lineOf(captureInput({ profileId: "made-up-profile" })),
        lineOf(captureInput({ startUrl: "   " })),
        lineOf(captureInput({ startUrl: "ftp://127.0.0.1/x" })),
        lineOf(captureInput({ startUrl: "http://user:hunter2@127.0.0.1/x" })),
        lineOf(captureInput({ startUrl: "http://127.0.0.1/x#frag" })),
        lineOf(captureInput({ rows: [row(), row({ kind: "waitFor" })] })),
        lineOf(captureInput({ timeoutMs: "0" })),
        lineOf(captureInput({ timeoutMs: "1.5" })),
        lineOf(captureInput({ timeoutMs: "soon" })),
      ]
    ).toEqual([
      CAPTURE_NO_TARGET_LINE,
      CAPTURE_TARGET_UNREADABLE_LINE,
      "目标行读到的形状不对",
      CAPTURE_TARGET_NOT_URL_LINE,
      INSPECT_REVISION_UNREAD_LINE,
      CAPTURE_PROFILES_UNREADABLE_LINE,
      CAPTURE_PROFILES_EMPTY_LINE,
      CAPTURE_PROFILE_UNSELECTED_LINE,
      `${CAPTURE_PROFILE_UNSELECTED_LINE}（要的那一个不在健康回包给的清单里：made-up-profile）`,
      CAPTURE_START_URL_EMPTY_LINE,
      "startUrl 不能用作采集起点：url-scheme-not-http:ftp",
      "startUrl 不能用作采集起点：url-credentials-forbidden",
      "startUrl 不能用作采集起点：url-fragment-forbidden",
      "第 2 行没说要等到什么状态（visible / hidden 两档之一）",
      CAPTURE_TIMEOUT_LINE,
      CAPTURE_TIMEOUT_LINE,
      CAPTURE_TIMEOUT_LINE,
    ]);

    // The credential-bearing address is refused for the *rule*, not by echoing what was typed: a
    // startUrl can carry a password, and §12.1 publishes names rather than values.
    const secret = captureDraftOf(captureInput({ startUrl: "http://user:hunter2@127.0.0.1/x" }));
    expect(secret.ok).toBe(false);
    if (secret.ok) return;
    expect(secret.line).not.toContain("hunter2");
    expect(secret.line).not.toContain("user:");
  });

  it("sends exactly the fields §8 line 306 names, and only the ones that were answered", () => {
    const draft = captureDraftOf(captureInput());
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(Object.keys(draft.body).sort()).toEqual(["expectedGraphRevision", "targetId", "task"]);
    expect(draft.body).toEqual({
      targetId: "22222222-2222-4222-8222-222222222222",
      expectedGraphRevision: 0,
      task: {
        kind: "capture",
        profileId: "web-fixture",
        scenario: { startUrl: "http://127.0.0.1:4110/checkout", actions: [{ kind: "click", locator: { kind: "testId", value: "checkout" } }] },
        network: { requestBody: false, responseBody: false, headerValues: false },
      },
    });
    // `graphRevision: 0` is a real token, not an absence: a fresh project's revision is 0 and a
    // truthiness check here would make the first capture of every new target unsendable.
    expect(captureDraftOf(captureInput({ graphRevision: 0 })).ok).toBe(true);
    expect(Object.keys(draft.body.task).sort()).toEqual(["kind", "network", "profileId", "scenario"]);

    // Optional fields travel only when answered. `0` would mean "no runtime limit is 0ms" and an empty
    // `sensitiveValues` array would be a declaration of something the operator did not declare.
    const answered = captureDraftOf(captureInput({ timeoutMs: " 45000 ", sensitiveValues: "hunter2, , sesame" }));
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.body.task.timeoutMs).toBe(45000);
    expect(answered.body.task.sensitiveValues).toEqual(["hunter2", "sesame"]);
    expect(Object.keys(answered.body.task).sort()).toEqual(["kind", "network", "profileId", "scenario", "sensitiveValues", "timeoutMs"]);

    // An action list may be empty: visiting the start address and recording what it exchanges is a
    // capture, and §8 puts no floor on `actions`.
    const bare = captureDraftOf(captureInput({ rows: [] }));
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.body.task.scenario).toEqual({ startUrl: "http://127.0.0.1:4110/checkout", actions: [] });

    // Rows keep the order they were written in - a capture is a sequence, and sorting it would run a
    // waitFor before the click it waits for.
    const sequence = captureDraftOf(
      captureInput({
        rows: [
          row({ kind: "fill", testId: "qty", value: "2" }),
          row({ kind: "waitFor", testId: "receipt", waitState: "visible" }),
          row({ kind: "click", locatorKind: "role", role: "button", name: "Pay" }),
        ],
      }),
    );
    expect(sequence.ok).toBe(true);
    if (!sequence.ok) return;
    const actions = (sequence.body.task.scenario as { actions: { kind: string }[] }).actions;
    expect(actions.map((action) => action.kind)).toEqual(["fill", "waitFor", "click"]);

    // The network block is whatever was ticked, all-false included - the note is what makes that
    // readable, so it has to say the same thing the body does instead of promising a default.
    const allThree = captureDraftOf(captureInput({ requestBody: true, responseBody: true, headerValues: true }));
    expect(allThree.ok).toBe(true);
    if (!allThree.ok) return;
    expect(allThree.body.task.network).toEqual({ requestBody: true, responseBody: true, headerValues: true });
    expect(CAPTURE_NETWORK_NOTE).toContain("全不勾");
    expect(CAPTURE_NETWORK_NOTE).toContain("骨架");
  });
});

// §8 line 273's control (issue #58's last missing handle). The rule that shapes both tests below:
// the address is the one input on this page that can carry a credential, so a refusal names the defect
// and never the value - and the receipt may only say what the door observed, which for a declaration is
// "this identity is still unknown".
describe("declare a URL target (DESIGN §8 line 273)", () => {
  const targetId = "33333333-3333-4333-8333-333333333333";
  const receipt = { id: targetId, kind: "url", snapshotDigest: null, identityReason: "url-declared-not-captured", auditSeq: 7 };

  it("refuses the four things that are not yet a declaration, by name and never by value", () => {
    const lineOf = (input: Parameters<typeof targetDraftOf>[0]) => {
      const draft = targetDraftOf(input);
      return draft.ok ? "ready" : draft.line;
    };
    // Session first, with everything else answered: an unpaired page has no door to send through.
    expect(lineOf({ csrf: "", url: "https://shop.example/cart" })).toBe(NO_SESSION_LINE);
    expect(lineOf({ csrf: "token-1234567890", url: "   " })).toBe(TARGET_URL_EMPTY_LINE);

    const refusals = [
      ["https://user:hunter2@shop.example/cart", "url-credentials-forbidden"],
      ["file:///etc/passwd", "url-scheme-not-http:file"],
      ["https://shop.example/cart#access_token=1", "url-fragment-forbidden"],
      ["not-an-url-at-all", "url-unparseable"],
      [`https://shop.example/${"a".repeat(2000)}`, "url-over-length:2000"],
    ] as const;
    for (const [url, defect] of refusals) {
      const line = lineOf({ csrf: "token-1234567890", url });
      // The defect name is the door's own name for the same rule (`urlLocatorDefects` is one owner),
      // so this is a real reason and not "the form did not like it".
      expect(line).toContain(defect);
      expect(line).toContain("这个地址还不能声明成目标");
      // …and the value that failed is not in the sentence, so a password typed into this box cannot
      // come back as screen text (§12.1: names, never values).
      expect(line).not.toContain("hunter2");
      expect(line).not.toContain("user:");
      expect(line).not.toContain("access_token");
      expect(line).not.toContain("etc/passwd");
    }

    const drafted = targetDraftOf({ csrf: "token-1234567890", url: "  https://shop.example/cart  " });
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    // Trimmed, two keys, and `kind` fixed at `url`: §8 names nothing else, and the three kinds a target
    // row may carry are decided by which door wrote the row (a `har` one comes from an import).
    expect(drafted.body).toEqual({ kind: "url", url: "https://shop.example/cart" });
    // A zero-length-after-trim address is the empty case, not `url-empty` from the door's list.
    expect(targetDraftOf({ csrf: "token-1234567890", url: "\t\ntp://x" }).ok).toBe(false);
  });

  it("says the receipt back without promising an observation nobody made", () => {
    const line = targetReceiptLine(receipt);
    expect(line).toContain(targetId);
    expect(line).toContain("身份未知");
    expect(line).toContain("url-declared-not-captured");
    expect(line).toContain("日志 seq 7");
    // The pair the page actually uses: `relayData` is the one owner of "unwrap the relay's envelope",
    // so the receipt line is fed what the relay left inside it rather than the envelope itself.
    expect(targetReceiptLine(relayData({ data: receipt }))).toBe(line);

    // Half-read receipts get their own sentences instead of printing `undefined`.
    expect(targetReceiptLine({})).toBe("声明已被接受，但回包没带目标 id");
    expect(targetReceiptLine(null)).toBe("声明已被接受，但回包没带目标 id");
    expect(targetReceiptLine({ ...receipt, id: "" })).toBe("声明已被接受，但回包没带目标 id");

    // A receipt that is not about a URL target is refused *without echoing what it said* - the same rule
    // the target-kind read follows for a word outside the three.
    const wrongKind = targetReceiptLine({ ...receipt, kind: "SNAPSHOT-onerror<svg>" });
    expect(wrongKind).toContain("不是 url 目标");
    expect(wrongKind).not.toContain("SNAPSHOT");

    // §8 line 273: a declared URL has no snapshot. A receipt claiming one is a contradiction this page
    // does not smooth over - it says so, rather than printing 身份未知 beside a digest.
    expect(targetReceiptLine({ ...receipt, snapshotDigest: "c".repeat(64) })).toContain("不该带摘要");

    // The two absences that would otherwise print `undefined` or silently claim a fact.
    expect(targetReceiptLine({ ...receipt, identityReason: "" })).toContain("url-declared-not-captured");
    expect(targetReceiptLine({ ...receipt, auditSeq: undefined })).toContain("日志 seq 没给");
    expect(targetReceiptLine({ ...receipt, identityReason: "" })).not.toContain("undefined");
  });
});

// §8 line 289's plan builder (issue #58's next handle). The two rules that shape these tests: every
// value the door requires comes from a read the page already makes (so a hand-typed contract id is a
// bug, not a shortcut), and an exclusion is a *claim* about the inventory - §7.4's two codes cannot be
// mixed, and the page refuses the contradiction rather than letting the door store it.
describe("plan builder (DESIGN §8 line 289 / §7.4)", () => {
  const contractA = "44444444-4444-4444-8444-444444444444";
  const contractB = "55555555-5555-5555-8555-555555555555";
  const vectorA = "66666666-6666-4666-8666-666666666666";
  const vectorB = "77777777-7777-4777-8777-777777777777";
  const snapshot = "d".repeat(64);
  const targetId = "88888888-8888-4888-8888-888888888888";

  const journalRow = (overrides: Partial<JournalEntryWire>): JournalEntryWire => ({
    seq: 1,
    action: "contract.review",
    resourceType: "contract",
    resourceId: contractA,
    decision: "allow",
    reasonCode: "contract-approved",
    safeMetadata: null,
    ...overrides,
  });

  it("finds approved contracts in the journal and only approved contracts", () => {
    // A rejection is not an approval; a plan approval is a different record type; a create row is not a
    // decision. All three sit in the same window and none of them may enter the list.
    const ids = approvedContractIds([
      journalRow({ seq: 2 }),
      // A rejection is journalled as `decision: "allow"` with reasonCode `contract-rejected` - the
      // allow/deny axis in §12.2 is "was this request permitted to commit", not "what did the reviewer
      // decide" (`packages/application/decision.ts` writes allow whenever a commit lands). So a fixture
      // that models a rejection as `deny` would make the reason-code filter look redundant and let an
      // excluded-but-rejected contract into the list; this row is the shape the service really writes.
      journalRow({ seq: 3, resourceId: contractB, reasonCode: "contract-rejected" }),
      journalRow({ seq: 4, action: "plan.review", reasonCode: "plan-approved", resourceId: contractB }),
      journalRow({ seq: 5, action: "contract.create", reasonCode: "contract-drafted" }),
      journalRow({ seq: 6, resourceId: null }),
      // The same contract twice because a review can be re-recorded: the list is a set, and the request
      // digest is taken over it, so a duplicate would make one decision two identities.
      journalRow({ seq: 7 }),
    ]);
    // `contractB` names a row of its own, otherwise the two entries collapse in the dedupe and the
    // reason-code filter has nothing to be wrong about - a fixture can be too small to prove its rule.
    expect(ids).toEqual([contractA]);
    expect(ids).not.toContain(contractB);
    expect(approvedContractIds([])).toEqual([]);
  });

  it("names which read is missing before anything is answered", () => {
    const lineOf = (input: Parameters<typeof planSubjectOf>[0]) => {
      const subject = planSubjectOf(input);
      return subject.ok ? "ready" : subject.line;
    };
    const ready = { targetId, target: { ok: true, kind: "har", snapshotDigest: snapshot } as const, inventoryRevision: 4, contracts: [contractA] };
    expect(
      [
        lineOf({ ...ready, targetId: null }),
        lineOf({ ...ready, target: null }),
        lineOf({ ...ready, target: { ok: false, line: "目标行读到的形状不对" } }),
        lineOf({ ...ready, target: { ok: true, kind: "url", snapshotDigest: null } }),
        lineOf({ ...ready, inventoryRevision: null }),
        lineOf({ ...ready, contracts: null }),
        lineOf({ ...ready, contracts: [] }),
      ]
    ).toEqual([
      PLAN_NO_TARGET_LINE,
      PLAN_TARGET_UNREADABLE_LINE,
      "目标行读到的形状不对",
      PLAN_NO_SNAPSHOT_LINE,
      PLAN_NO_INVENTORY_LINE,
      PLAN_NO_JOURNAL_LINE,
      PLAN_NO_CONTRACTS_LINE,
    ]);

    const subject = planSubjectOf(ready);
    expect(subject.ok).toBe(true);
    if (!subject.ok) return;
    expect(subject).toEqual({ ok: true, targetId, snapshotDigest: snapshot, inventoryRevision: 4, contracts: [contractA] });
    // The line quotes the three numbers a 409 has to be explainable against, and the digest in full
    // because a truncated one cannot be checked against the row it came from.
    const line = planSubjectLine(subject);
    expect(line).toContain(targetId);
    expect(line).toContain(snapshot);
    expect(line).toContain("库存修订 4");
    expect(line).toContain("已批准契约 1 份可勾");
    expect(planSubjectLine({ ok: false, line: PLAN_NO_SNAPSHOT_LINE })).toBe(PLAN_NO_SNAPSHOT_LINE);
  });

  it("refuses each half-written exclusion by the row that is half-written", () => {
    const row = (overrides: Partial<PlanExclusionRow> = {}): PlanExclusionRow => ({
      vectorId: vectorA,
      reasonCode: "outside-scope",
      reason: "这一版不算它",
      excludedBehavior: "GET /api/cart",
      supersededBy: "",
      ...overrides,
    });
    const inventory = [vectorA, vectorB];
    const lineOf = (input: PlanExclusionRow, index: number, earlier: readonly string[] = []) => {
      const built = planExclusionOf(input, index, inventory, earlier);
      return built.ok ? "ready" : built.failure.line;
    };

    expect(lineOf(row(), 0)).toBe("ready");
    // The two codes produce two different wire objects: `superseded` carries the successor's id and
    // `outside-scope` carries a literal null, which is the pairing §7.4 makes part of the type.
    expect(planExclusionOf(row({ reasonCode: "superseded", supersededBy: vectorB }), 1, inventory, [])).toEqual({
      ok: true,
      exclusion: { vectorId: vectorA, reasonCode: "superseded", reason: "这一版不算它", excludedBehavior: "GET /api/cart", supersededBy: vectorB },
    });

    const failures = [
      [row({ vectorId: "" }), 0, "还没说排除的是哪一条样本"],
      [row({ vectorId: newId() }), 1, "不在本页读到的库存清单里"],
      [row({ reasonCode: "" }), 0, "不在 §7.4 的两个里"],
      [row({ reasonCode: "deprecated" }), 0, "不在 §7.4 的两个里"],
      [row({ reason: "  " }), 0, "还没有写理由"],
      [row({ excludedBehavior: "" }), 0, "还没有写被排除的是哪个行为"],
      [row({ supersededBy: vectorB }), 0, "互相矛盾"],
      [row({ reasonCode: "superseded" }), 0, PLAN_SUCCESSOR_EMPTY_LINE],
      [row({ reasonCode: "superseded", supersededBy: newId() }), 0, "那一行不在本页读到的库存里"],
      [row({ reasonCode: "superseded", supersededBy: vectorA }), 0, "不能用自己取代自己"],
    ] as const;
    for (const [bad, index, fragment] of failures) {
      const line = lineOf(bad, index);
      expect(line).toContain(fragment);
      expect(line).toContain(`第 ${String(index + 1)} 行`);
    }
    // A sample cannot be excluded twice across rows - the door's own `inventoryCounts` throws on it, and
    // the page can see that much without knowing anything about required cases.
    expect(lineOf(row(), 1, [vectorA])).toContain("已经被前面那一行排过了");
  });

  it("sends the five fields the door takes, in the journal's order rather than the click's", () => {
    const base = {
      csrf: "token-1234567890",
      targetId,
      target: { ok: true, kind: "har", snapshotDigest: snapshot } as const,
      inventoryRevision: 4,
      contracts: [contractA, contractB],
      chosenContractIds: [contractA],
      inventoryIds: [vectorA, vectorB],
      rows: [] as PlanExclusionRow[],
    };
    expect(planDraftOf({ ...base, csrf: "", chosenContractIds: [] })).toEqual({ ok: false, line: NO_SESSION_LINE });
    expect(planDraftOf({ ...base, chosenContractIds: [] })).toEqual({ ok: false, line: PLAN_CONTRACT_UNSELECTED_LINE });
    expect(planDraftOf({ ...base, chosenContractIds: [newId()] })).toEqual({ ok: false, line: PLAN_CONTRACT_UNLISTED_LINE });

    const both = planDraftOf({ ...base, chosenContractIds: [contractB, contractA] });
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    // Same two boxes, same body: the door's request digest is computed over this body, so the order an
    // operator happened to click in must not become a second identity for one decision.
    const forward = planDraftOf({ ...base, chosenContractIds: [contractA, contractB] });
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    expect(both.body).toEqual(forward.body);
    expect((both.body.contractRevisionIds as string[])).toEqual([contractA, contractB]);

    // The contradiction that spans two rows: row 1 says `vectorB` was superseded by `vectorA`, row 2
    // says `vectorA` is out of scope. Neither row is malformed on its own - which is why this check is
    // over the whole list, and why §7.4's own `inventoryCounts` refuses to be a per-entry predicate.
    const contradictory = planDraftOf({
      ...base,
      rows: [
        { vectorId: vectorB, reasonCode: "superseded", reason: "换了一版", excludedBehavior: "POST /api/cart", supersededBy: vectorA },
        { vectorId: vectorA, reasonCode: "outside-scope", reason: "这一版不算它", excludedBehavior: "GET /api/cart", supersededBy: "" },
      ],
    });
    expect(contradictory.ok).toBe(false);
    if (contradictory.ok) return;
    expect(contradictory.line).toContain("自己也在这份排除里");
    expect(contradictory.line).toContain(vectorA);

    // The same two codes that DO fit together: `vectorB` was superseded by a row that stays in the plan,
    // and `vectorA` is itself not excluded - so only one row is written, and it travels with the
    // successor as a value rather than a null (§7.4 makes that pairing part of the type).
    const oneExclusion = planDraftOf({
      ...base,
      chosenContractIds: [contractA, contractB],
      rows: [{ vectorId: vectorB, reasonCode: "superseded", reason: "换了一版", excludedBehavior: "POST /api/cart", supersededBy: vectorA }],
    });
    expect(oneExclusion.ok).toBe(true);
    if (!oneExclusion.ok) return;
    expect(oneExclusion.body.exclusions).toEqual([
      { vectorId: vectorB, reasonCode: "superseded", reason: "换了一版", excludedBehavior: "POST /api/cart", supersededBy: vectorA },
    ]);
    const drafted = planDraftOf(base);
    if (!drafted.ok) throw new Error("base should build");
    expect(drafted.body).toEqual({
      targetId,
      snapshotDigest: snapshot,
      contractRevisionIds: [contractA],
      exclusions: [],
      expectedInventoryRevision: 4,
    });
  });

  it("says what the plan door answered, and that a draft is not an approval", () => {
    const receipt = { planId: "99999999-9999-4999-8999-999999999999", selectedCount: 3, excludedCount: 1, reviewStatus: "draft", auditSeq: 12 };
    const line = planBuildLine(receipt);
    expect(line).toContain(receipt.planId);
    expect(line).toContain("选中 3");
    expect(line).toContain("排除 1");
    expect(line).toContain("草稿（还要 §8 line 291 的批准）");
    expect(line).toContain("日志 seq 12");
    expect(planBuildLine({})).toBe("计划已被接受，但回包没带 planId");
    expect(planBuildLine({ ...receipt, selectedCount: undefined })).toContain("两个计数没带回来");
    expect(planBuildLine({ ...receipt, auditSeq: undefined })).toContain("日志 seq 没给");
    // An approved plan answering here would be a different fact, and the sentence must not call it a draft.
    expect(planBuildLine({ ...receipt, reviewStatus: "approved" })).not.toContain("草稿");
  });
});

// Issue #59's projection half: the left column may only say what the reply published. The four
// shapes below are the ones a job row can actually arrive with - no error, an error with numbers,
// an error whose details carry only the reason name, and a value that is not a number.
describe("jobFailureLine says what the refusal published (issue #59)", () => {
  it("stays silent for a row that was not refused", () => {
    expect(jobFailureLine(null)).toBeNull();
    expect(jobFailureLine("a string is not an ApiError")).toBeNull();
    expect(jobFailureLine({ retryable: false })).toBeNull();
  });

  it("quotes the reason and every published number", () => {
    expect(
      jobFailureLine({
        code: "RESOURCE_LIMIT",
        message: "generation-budget-exhausted",
        details: { reason: "generation-budget-exhausted", attempt: 4, maxAttempts: 3 },
      }),
    ).toBe("本次任务被拒：RESOURCE_LIMIT / generation-budget-exhausted（attempt 4 · maxAttempts 3）");
  });

  it("names the refusal without inventing a number when only the reason name was published", () => {
    // `reason` is a string, and a string never becomes page text here: the sentence the operator
    // reads has to be built from what the reply measured, not from whatever text a detail carried.
    expect(jobFailureLine({ code: "STALE_INPUT", message: "graph-moved-since-plan", details: { reason: "graph-moved-since-plan" } })).toBe(
      "本次任务被拒：STALE_INPUT / graph-moved-since-plan",
    );
  });

  it("ignores a detail that is not a number or a boolean", () => {
    // The API already filtered keys; this is the second half of the same rule - a string value
    // does not become page text here even if a future key ever carried one.
    expect(
      jobFailureLine({ code: "RESOURCE_LIMIT", message: "inventory-too-large", details: { limit: 500, note: "raw producer text" } }),
    ).toBe("本次任务被拒：RESOURCE_LIMIT / inventory-too-large（limit 500）");
  });
});

  // The wiring, not just the sentence: a row the left column was handed is what decides whether a
  // refusal appears at all. Without this case `buildLeftPanel` could keep returning `failure: null`
  // for every job and every text-level test would still pass.
  it("carries the refusal from the job row into the left column", () => {
    const refused = buildLeftPanel({
      job: {
        id: newId(),
        state: "failed",
        cleanupState: "complete",
        errorJson: {
          code: "RESOURCE_LIMIT",
          message: "generation-budget-exhausted",
          retryable: false,
          details: { reason: "generation-budget-exhausted", attempt: 4, maxAttempts: 3 },
        },
      },
      target: { id: newId() },
      limitations: [],
      scopeLabel: "cart 读取",
    });
    if ("reason" in refused) throw new Error("the panel refused to build");
    expect(refused.failure).toBe("本次任务被拒：RESOURCE_LIMIT / generation-budget-exhausted（attempt 4 · maxAttempts 3）");

    const running = buildLeftPanel({
      job: { id: newId(), state: "running", cleanupState: "pending", errorJson: null },
      target: { id: newId() },
      limitations: [],
      scopeLabel: "cart 读取",
    });
    if ("reason" in running) throw new Error("the panel refused to build");
    expect(running.failure).toBeNull();
  })

// The delivery surface (§8 lines 299-300, PRD F11, issue #58's fourth box): none of the three export
// doors had a page caller before this round, so the model side is where the rules can be pinned.
describe("what the delivery panel says about a package (issue #58)", () => {
  const manifest = { statusNote: "这是 draft：没有绑定的验证报告，不声称已验证" };
  const row = { id: newId(), label: "draft", downloadUrl: `/api/v1/projects/${newId()}/exports/${newId()}/download`, sha256: "a".repeat(64), manifest };

  it("keeps every row a listing carries, with the digest and the route the door named", () => {
    const rows = exportsRowsOf([row, { ...row, id: newId() }]);
    expect(rows).toHaveLength(2);
    const [first] = rows;
    if (first === undefined) throw new Error("the listing lost its first row");
    // The digest and the route are the two facts a package is worth: an id alone is not downloadable.
    expect(first.downloadUrl).toBe(row.downloadUrl);
    expect(first.sha256).toBe("a".repeat(64));
    expect(first.statusNote).toBe(manifest.statusNote);
  });

  it("names the field a row is missing instead of dropping the row", () => {
    const broken = exportRowOf({ label: "draft" });
    expect(broken.id).toBeNull();
    expect(broken.downloadUrl).toBeNull();
    // A field that *is* there stays: the panel is reporting what it read, not rewriting the row.
    expect(broken.label).toBe("draft");
    expect(broken.sha256).toBe("（回包没带摘要）");
    expect(broken.statusNote).toBeNull();
    // And a row that is not an object at all still says which fields it could not find.
    expect(exportRowOf(null).label).toBe("（回包没带 label）");
    // Both halves of the download line: a row with a route gets nothing said about it, a row without
    // one gets a sentence naming which id is un-downloadable. Asserting only one half would let a
    // version that always returns the sentence, or always returns null, pass.
    expect(exportDownloadLine(broken)).toContain("没带下载路由");
    expect(exportDownloadLine(exportRowOf(row))).toBeNull();
  });

  it("will not write a receipt for a package it has no id for", () => {
    expect(exportReceiptLine(exportRowOf(row))).toContain(`已打出交付包 ${row.id}`);
    expect(exportReceiptLine(exportRowOf(row))).toContain("sha256 " + "a".repeat(64));
    expect(exportReceiptLine(exportRowOf(row))).toContain(manifest.statusNote);
    expect(exportReceiptLine(exportRowOf({ label: "draft" }))).toBe("打包已被接受，但回包没带 id");
  });

  it("says a different thing for each of the three emptinesses it can be in", () => {
    const lines = [EXPORTS_EMPTY_LINE["no-candidate"], EXPORTS_EMPTY_LINE["empty-page"], EXPORTS_EMPTY_LINE.unread];
    // Three states, three sentences: a copy-paste would collapse "no candidate to package" into
    // "no packages yet" into "the listing did not come back", and those are three different next steps.
    expect(new Set(lines).size).toBe(3);
    for (const line of lines) expect(line.length).toBeGreaterThan(8);
  });
});

// §8 line 276 and line 298: the two reads that turn "a job was queued" into something the page can
// name. Before this round both doors had no caller at all, so the verification id - which §8 gives no
// list route for - could not reach the operator except by typing it in.
describe("reading one job row and the report it points at (issue #58)", () => {
  const verifyJob = { id: newId(), kind: "verify", state: "succeeded", cleanupState: "complete", deadlineAt: null, retryAt: null, cleanupRetryAt: null, resultRef: newId(), error: null };

  it("says what one job row is, including the two times only the single read carries", () => {
    const quiet = jobDetailOf(verifyJob);
    expect(verificationIdOfJob(quiet)).toBe(quiet.resultRef);
    expect(jobDetailLine(quiet)).toContain(`作业 ${quiet.id}：verify｜succeeded｜清理 complete`);
    expect(jobDetailLine(quiet)).toContain(`resultRef ${verifyJob.resultRef}`);
    // A retry time is a fact this door owns: the page listing has none, so the line has to show it
    // when it is there and stay silent when it is not - one branch asserted alone would let either
    // mistake through.
    expect(jobDetailLine(quiet)).not.toContain("重试行于");
    const queued = jobDetailOf({ ...verifyJob, state: "queued", retryAt: "2026-10-18T03:00:00.000Z", cleanupRetryAt: "2026-10-18T04:00:00.000Z" });
    expect(jobDetailLine(queued)).toContain("重试行于 2026-10-18T03:00:00.000Z");
    expect(jobDetailLine(queued)).toContain("清理重排于 2026-10-18T04:00:00.000Z");
  });

  it("names a refusal by the reason the details carry, not by the code", () => {
    const failed = jobDetailOf({ ...verifyJob, state: "failed", resultRef: null, error: { code: "RESOURCE_LIMIT", message: "spent", retryable: false, details: { reason: "generation-budget-exhausted" } } });
    expect(failed.errorReason).toBe("generation-budget-exhausted");
    expect(jobDetailLine(failed)).toContain("被拒：generation-budget-exhausted");
    // And a row that was never refused says nothing about a failure at all.
    expect(jobDetailLine(jobDetailOf(verifyJob))).not.toContain("被拒");
  });

  it("only reads a verification id out of a verify row", () => {
    const detail = jobDetailOf(verifyJob);
    expect(verificationIdOfJob(jobDetailOf({ ...verifyJob, kind: "build" }))).toBeNull();
    expect(verificationIdOfJob(jobDetailOf({ ...verifyJob, resultRef: null }))).toBeNull();
    expect(verificationIdOfJob(detail)).toBe(detail.resultRef);
  });

  it("reports a verdict, its counts and its limits without inventing a number", () => {
    const full = reportOf({ id: newId(), result: "PASS", currentness: "current", counts: { total: 4, passed: 3, failed: 1, blocked: 0 }, limitations: ["a", "b"] });
    expect(reportLine(full)).toBe(`验证报告 ${full.id}：PASS｜current｜通过 3／失败 1／阻断 0／共 4｜限制 2 条`);
    const missing = reportOf({});
    expect(missing.result).toBe("（回包没带 result）");
    expect(reportLine(missing)).toContain("通过 ?");
    expect(reportLine(missing)).toContain("限制 0 条");
  });

  it("keeps the two lines it says without a read distinct", () => {
    expect(SESSION_SIGN_OUT_LINE).not.toBe(VERIFIED_SAMPLES_NEEDS_JOB_LINE);
    expect(VERIFIED_SAMPLES_NEEDS_JOB_LINE).toContain("resultRef");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkbenchColumns } from "../../apps/web/ui/panels.tsx";
import { buildMiddlePanel, buildRightTabs, listView } from "../../apps/web/ui/view-model.ts";
import type { ClaimEvidenceState, Coverage } from "../../packages/domain/evidence.ts";
import { newId } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";

// The three columns rendered for real (PRD F04 / DESIGN §6, issue #18).
//
// `react-dom/server` is not a browser, and this file does not claim otherwise: what it
// proves is that the components render the same judgement the model computed — icon
// *and* word, the reasons list, the inquiry button, the disabled Builder tab, and a
// list view that says exactly what the canvas said. Whether a click scrolls, pans or
// drags a node is a browser question and is recorded as unverified in the PR.

const COMPLETE: Coverage = { state: "complete", examined: null, total: null, reasons: [] };

function claim(overrides: Partial<ClaimEvidenceState> = {}): ClaimEvidenceState {
  return {
    basis: "observed",
    validity: "current",
    sourceEvidenceIds: [`ev_${"c".repeat(64)}`],
    authorityApplies: true,
    coverage: COMPLETE,
    ...overrides,
  };
}

const nodeId: Id = newId();
const staleClaimId: Id = newId();
const edgeClaimId: Id = newId();
const claims = new Map<string, ClaimEvidenceState>([
  [staleClaimId, claim({ validity: "stale" })],
  [edgeClaimId, claim()],
]);

const built = buildMiddlePanel({
  nodes: [{
    id: nodeId,
    kind: "operation",
    label: "GET /api/cart",
    targetId: newId(),
    claimIds: [staleClaimId],
    evidenceIds: [`ev_${"d".repeat(64)}`],
    contractRevisionIds: [newId()],
    coverage: COMPLETE,
  }],
  edges: [{ id: "edge-1", from: nodeId, to: "elsewhere", relation: "calls", claimId: edgeClaimId }],
  requiredClaimsOfNode: (node) => node.claimIds.map((id) => claims.get(id) as ClaimEvidenceState),
  claimOfEdge: (id) => claims.get(id) ?? null,
});

function rendered(mode: "canvas" | "list", isBuilder = false): string {
  return renderToStaticMarkup(
    createElement(WorkbenchColumns, {
      left: {
        taskId: newId(),
        taskState: "running",
        viewLabel: "cart 读取",
        limitations: ["关系覆盖为部分"],
        cleanupState: "pending",
      },
      cells: built.cells,
      canvasFailures: built.failures,
      tabs: buildRightTabs({ isBuilder, hasBlueprint: false }),
      activeTab: "contract",
      mode,
    }),
  );
}

describe("the rendered three columns (PRD F04)", () => {
  it("states each status in words and glyphs, never as colour alone", () => {
    const markup = rendered("canvas");
    expect(markup).toContain("data-layout=\"three-column\"");
    expect(markup).toContain("data-panel=\"middle\"");
    expect(markup).toContain("?");
    expect(markup).toContain("未知");
    expect(markup).toContain("claim-stale");
    // The stale required claim makes the node UNKNOWN; the edge's own claim is clean,
    // so the edge is 已观察 — the two judgements appear side by side.
    expect(markup).toContain("已观察");
    expect(markup).toContain("data-inquiry=\"read-evidence\"");
    expect(markup).toContain("data-jump=");
  });

  it("keeps the same words in the list view", () => {
    const canvas = rendered("canvas");
    const list = rendered("list");
    const cells = listView(built.cells);
    for (const row of cells) {
      // `renderToStaticMarkup` keeps adjacent text nodes apart with a comment, so the
      // glyph and the word are checked separately rather than as one concatenated line.
      for (const fragment of row.statusLine.split(" ")) {
        expect(list).toContain(fragment);
      }
      expect(list).toContain("claim-stale");
    }
    expect(list).toContain("data-view=\"list\"");
    // Switching views must not soften anything.
    expect(canvas).toContain("未知");
    expect(list).toContain("未知");
  });

  it("disables the source tab for a Builder and says why", () => {
    const builder = rendered("canvas", true);
    expect(builder).toContain("data-tab=\"code\"");
    expect(builder).toContain("builder-may-not-read-source");
    expect(builder).toContain("disabled");
    const inspector = rendered("canvas", false);
    expect(inspector).not.toContain("builder-may-not-read-source");
  });

  it("shows the producer's limitations next to the task", () => {
    const markup = rendered("canvas");
    expect(markup).toContain("关系覆盖为部分");
    expect(markup).toContain("running");
    expect(markup).toContain("pending");
  });

  it("surfaces a refusal instead of drawing a silent gap", () => {
    const missing = buildMiddlePanel({
      nodes: [],
      edges: [{ id: "edge-x", from: "a", to: "b", relation: "reads", claimId: newId() }],
      requiredClaimsOfNode: () => [],
      claimOfEdge: () => null,
    });
    const markup = renderToStaticMarkup(
      createElement(WorkbenchColumns, {
        left: { reason: "no-task-and-no-target" },
        cells: missing.cells,
        canvasFailures: missing.failures,
        tabs: buildRightTabs({ isBuilder: false, hasBlueprint: true }),
        activeTab: "report",
      }),
    );
    expect(markup).toContain("edge-claim-unreadable");
    expect(markup).toContain("无可用任务");
    expect(markup).toContain("此 scope 暂无主张");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkbenchColumns } from "../../apps/web/ui/panels.tsx";
import { buildMiddlePanel, buildRightTabs, listView, PROJECTS_EMPTY_LINE } from "../../apps/web/ui/view-model.ts";
import { ProjectList } from "../../apps/web/app/client/project-list.tsx";
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

type RenderOptions = {
  mode: "canvas" | "list";
  isBuilder?: boolean;
  activeTab?: "contract" | "code" | "report";
  onJumpToEvidence?: (evidenceId: string) => void;
  onInquiry?: (inquiry: unknown) => void;
  onSelectTab?: (id: string) => void;
};

function render(options: RenderOptions): string {
  const { mode, isBuilder = false, activeTab = "contract", ...rest } = options;
  return renderToStaticMarkup(
    createElement(WorkbenchColumns, {
      left: {
        taskId: newId(),
        taskState: "running",
        viewLabel: "cart 读取",
        limitations: ["关系覆盖为部分"],
        cleanupState: "pending",
        frames: { count: 0, note: "无画面：本次导入只带请求与响应，没有预览帧" },
      },
      cells: built.cells,
      canvasFailures: built.failures,
      tabs: buildRightTabs({ isBuilder, hasBlueprint: false }),
      activeTab,
      mode,
      ...(rest.onJumpToEvidence === undefined ? {} : { onJumpToEvidence: rest.onJumpToEvidence }),
      ...(rest.onInquiry === undefined ? {} : { onInquiry: rest.onInquiry }),
      ...(rest.onSelectTab === undefined ? {} : { onSelectTab: rest.onSelectTab }),
    }),
  );
}

function rendered(mode: "canvas" | "list", isBuilder = false): string {
  return render({ mode, isBuilder });
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
    // The list carries the same tone the canvas cell has, as a class beside the icon and
    // the word: a view that quietly lost the colour channel would look like a different
    // answer to the same row.
    expect(list).toContain('class="status status-negative"');
    expect(list).toContain('class="status status-positive"');
    expect(list).toContain('data-tone="negative"');
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

describe("the list view's own actions (PRD F04, issue #18 acceptance)", () => {
  // The node's own evidence list, not the claim's source ids: a jump goes to what the
  // cell carries (DESIGN §5 keeps the two lookups separate).
  const evidenceId = `ev_${"d".repeat(64)}`;

  it("offers a jump for every source the cell names", () => {
    const list = render({ mode: "list", onJumpToEvidence: () => undefined });
    expect(list).toContain(`data-evidence-jump="${evidenceId}"`);
    expect(list).toContain("来源 1");
    // The count alone would satisfy a table and fail the requirement, so the button is
    // what the row has to give.
    expect(list).not.toContain(">1</td>");
  });

  it("offers a directed inquiry for a gap and no button for a settled cell", () => {
    const list = render({ mode: "list", onInquiry: () => undefined });
    expect(list).toContain("data-inquiry=");
    expect(list).toContain("创建定向调查");
    // A stale source makes this an evidence read, not a new capture: the kind comes from
    // the same reason table the canvas uses.
    expect(list).toContain("data-inquiry-kind=\"read-evidence\"");
    const withoutHandlers = render({ mode: "list" });
    expect(withoutHandlers).not.toContain("创建定向调查");
    expect(withoutHandlers).not.toContain("data-evidence-jump");
  });

  it("labels the enabled tabs and keeps the disabled one inert", () => {
    const reviewer = render({ mode: "list", onSelectTab: () => undefined });
    expect(reviewer).toContain("data-tab=\"code\"");
    expect(reviewer).toContain("data-enabled=\"yes\"");
    const builder = render({ mode: "list", isBuilder: true, onSelectTab: () => undefined });
    expect(builder).toContain("data-enabled=\"no\"");
    expect(builder).toContain("builder-may-not-read-source");
  });

  it("shows the panel body the active tab names", () => {
    // The body is the island's, so the render here only proves the tab's own state is
    // readable: `aria-selected` marks exactly one tab as the live one.
    const markup = render({ mode: "list", activeTab: "report" });
    expect(markup.match(/aria-selected="true"/g) ?? []).toHaveLength(1);
    expect(markup).toContain("data-tab=\"report\"");
  });
});

describe("the 样本 tab in the rendered shell (issue #58)", () => {
  it("is an enabled control for a local operator and a named refusal for a Builder", () => {
    const inspector = renderToStaticMarkup(
      createElement(WorkbenchColumns, {
        left: { reason: "no-task-and-no-target" },
        cells: [],
        canvasFailures: [],
        tabs: buildRightTabs({ isBuilder: false, hasBlueprint: true }),
        activeTab: "samples",
      }),
    );
    expect(inspector).toContain('data-tab="samples"');
    expect(inspector).toContain('data-enabled="yes"');
    const builder = renderToStaticMarkup(
      createElement(WorkbenchColumns, {
        left: { reason: "no-task-and-no-target" },
        cells: [],
        canvasFailures: [],
        tabs: buildRightTabs({ isBuilder: true, hasBlueprint: true }),
        activeTab: "contract",
      }),
    );
    expect(builder).toContain('data-tab="samples"');
    expect(builder).toContain("builder-may-not-decide-samples");
  });
});


// The landing page's first paint (issue #58's project list).
describe("the landing list before any read has happened", () => {
  it("asks for a pairing rather than spinning", () => {
    const html = renderToStaticMarkup(createElement(ProjectList));
    // This is the exact failure the 样本 tab was caught at in a real browser: a panel that says
    // 正在读取 while the session is what makes the read possible. The static render has run no
    // effect at all, so what this proves is the *initial* state and nothing else - the read that
    // follows it is recorded from the browser pass.
    expect(html).not.toContain("正在读取");
    expect(html).toContain(PROJECTS_EMPTY_LINE["no-session"]);
    expect(html).toContain('data-panel="project-list"');
    // No link is rendered to a project nobody has read yet.
    expect(html).not.toContain("/project/");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkbenchColumns } from "../../apps/web/ui/panels.tsx";
import { buildMiddlePanel, buildRightTabs, jobFailureLine, CAPTURE_NETWORK_NOTE, CAPTURE_NO_TARGET_LINE, CAPTURE_PROFILES_UNREADABLE_LINE, PLAN_NO_JOURNAL_LINE, PLAN_NO_TARGET_LINE, FREEZE_EMPTY_LINE, INSPECT_CAPTURE_NOTE, INSPECT_FIRST_ANALYSIS_NOTE, INSPECT_GRAPH_UNREAD_LINE, listView, PROJECTS_EMPTY_LINE } from "../../apps/web/ui/view-model.ts";
import { Workbench } from "../../apps/web/app/client/workbench.tsx";
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
  // The refusal sentence the left column was handed, when the row it read had been refused.
  failure?: string | null;
  onJumpToEvidence?: (evidenceId: string) => void;
  onInquiry?: (inquiry: unknown) => void;
  onSelectTab?: (id: string) => void;
};

function render(options: RenderOptions): string {
  const { mode, isBuilder = false, activeTab = "contract", failure = null, ...rest } = options;
  return renderToStaticMarkup(
    createElement(WorkbenchColumns, {
      left: {
        taskId: newId(),
        taskState: "running",
        viewLabel: "cart 读取",
        limitations: ["关系覆盖为部分"],
        cleanupState: "pending",
        failure,
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

// Issue #59's last step: the numbers a refusal published have to be on the page, not only in the
// reply the browser already holds. Two halves, because the missing half is the one that lies -
// a row that was never refused must not gain a 被拒 field, and a refused row must not be able to
// lose the numbers.
describe("the left column says what a refused task said (issue #59)", () => {
  it("renders the published numbers beside the reason", () => {
    const html = render({
      mode: "list",
      failure: jobFailureLine({
        code: "RESOURCE_LIMIT",
        message: "generation-budget-exhausted",
        retryable: false,
        details: { reason: "generation-budget-exhausted", attempt: 4, maxAttempts: 3 },
      }),
    });
    expect(html).toContain('data-job-failure="本次任务被拒：RESOURCE_LIMIT / generation-budget-exhausted（attempt 4 · maxAttempts 3）"');
    expect(html).toContain("被拒");
  });

  it("renders no refusal field at all when the row was not refused", () => {
    expect(render({ mode: "list" })).not.toContain("data-job-failure");
    expect(render({ mode: "list" })).not.toContain("被拒");
  });

  // The other half of issue #59: an operator who cannot ask for a page the door refuses can never be
  // told the cap. First paint only - whether the typed number reaches the panel is a browser question
  // and is recorded from the browser pass, not claimed here.
  // §8 line 267's revoke had no caller either: the page could pair but never hand the session back.
  it("offers the revoke, and says nothing about it until it is asked", () => {
    const html = renderToStaticMarkup(createElement(Workbench, { projectId: "00000000-0000-4000-8000-000000000000" }));
    expect(html).toContain("data-session-sign-out");
    // No notice paragraph exists before an operator has clicked - a page that greeted everyone with
    // "session revoked" would be reporting an action that never happened.
    expect(html).not.toContain("data-session-line");
    expect(html).not.toContain("会话已撤销");
  });

  it("offers the page size the door bounds, un-defaulted and un-clamped", () => {
    const html = renderToStaticMarkup(createElement(Workbench, { projectId: "00000000-0000-4000-8000-000000000000" }));
    expect(html).toMatch(/<input[^>]*data-jobs-limit[^>]*type="number"/);
    // No `max` and no `min`: the ceiling is the door's, and a page that clamped the number itself
    // would replace the refusal that names both figures with its own guess.
    const control = /<input[^>]*data-jobs-limit[^>]*\/>/.exec(html)?.[0] ?? "";
    expect(control).not.toContain("max=");
    expect(control).not.toContain("min=");
    // Empty means "not stated", so no copy of the server's default lives in this file.
    expect(control).toContain('value=""');
    expect(control).toContain("placeholder=");
  });
});

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
    // The create form is there from the first paint - a visitor who cannot read a list still has to
    // be able to ask for one - but it has not said anything yet: no notice paragraph exists before
    // an operator has typed or clicked.
    expect(html).toContain('data-panel="project-create"');
    expect(html).not.toContain("data-project-create-notice");
  });
});

// The freeze and generate panels' first paint (issues #58 and #57). The static render has run no
// effect, so this is the *initial* state and nothing else: what it proves is that neither panel
// offers a button or claims an empty list before the journal has been read.
describe("the contract tab before its journal has been read", () => {
  it("names the missing read instead of an empty plan list", () => {
    const html = renderToStaticMarkup(createElement(Workbench, { projectId: "00000000-0000-4000-8000-000000000000" }));
    expect(html).toContain('data-panel="blueprint-freeze"');
    expect(html).toContain(FREEZE_EMPTY_LINE["no-journal"]);
    expect(html).not.toContain("data-blueprint-freeze=");
    expect(html).not.toContain("data-candidate-generate=");
  });
});

// The directed-inspect panel's first paint (issue #58's last control).
//
// This is the section that used to print `JSON.stringify` of an inquiry under a heading admitting
// nothing had been submitted. The static render has run no effect, so what is on screen here is the
// page's answer to "what do you know before any read has happened" - and the answer has to be a named
// missing read, not a blank form and not the old apology.
describe("the directed-inspect panel before any read has happened", () => {
  it("names which of its own reads is missing instead of offering a blank form", () => {
    const html = renderToStaticMarkup(createElement(Workbench, { projectId: "00000000-0000-4000-8000-000000000000" }));
    expect(html).toContain('data-panel="directed-inspect"');
    expect(html).toContain('data-inspect-subject="blocked"');
    expect(html).toContain(INSPECT_GRAPH_UNREAD_LINE);
    // The two halves of one door are two sections, and the panel says so before any read happens: an
    // operator who wants a new capture must know which boxes to fill, not discover it as a 400.
    expect(html).toContain(INSPECT_CAPTURE_NOTE);
    // The scope control exists and is unchosen: no option is marked selected, because picking one for
    // the operator is §10's prohibition.
    expect(html).toContain("（还没有选：页面不默认任何一档）");
    // Read from the actual markup: the empty choice is the one marked selected, and neither of the two
    // real scopes is. Preselecting either would be the page deciding an adjudication question (§10).
    expect(html).toContain('<option value="" selected="">（还没有选：页面不默认任何一档）</option>');
    expect(html).not.toContain('<option value="static" selected');
    expect(html).not.toContain('<option value="captured-runtime" selected');
    // A claim list is not offered, and, just as important, the page does not claim this target has no
    // claims: with the graph unread it only knows it has not read.
    expect(html).not.toContain(INSPECT_FIRST_ANALYSIS_NOTE);
    expect(html).not.toContain("data-inspect-claim=");
    // The old heading promised 本地排队，尚未提交; the receipt sentence may only appear after a 202.
    expect(html).not.toContain("本地排队，尚未提交");
    expect(html).not.toContain("已排入定向调查");
    expect(html).toContain("还没有点过任何格子");
  });

  it("names which of its own reads is missing, and offers one blank action row rather than a promise", () => {
    const html = renderToStaticMarkup(createElement(Workbench, { projectId: "00000000-0000-4000-8000-000000000000" }));
    expect(html).toContain('data-panel="capture-compose"');
    // A capture needs a target, its kind, the concurrency token and a profile list, and none of those
    // have been read at first paint. The sentence is the subject gate's own - the same value a submit
    // would refuse with - so the heading cannot advertise a form its gate is about to reject.
    expect(html).toContain('data-capture-subject="blocked"');
    expect(html).toContain(CAPTURE_NO_TARGET_LINE);
    // The profile control is the §10 case: a name the page invented would pick a sandbox for the
    // operator, so the select is empty, unchosen, and disabled until health answers.
    expect(html).toContain('data-capture-profile="unreadable"');
    expect(html).toContain("<select id=\"capture-profile\" data-capture-profile=\"unreadable\" disabled=\"\">");
    expect(html).toContain('<option value="" selected="">（还没有选：这一格没有默认值）</option>');
    expect(html).toContain(CAPTURE_PROFILES_UNREADABLE_LINE);

    // One row, because a capture without actions is still a capture (visit this address, record what
    // it exchanges) - and the row shows only what its own kind can carry: `click` has no value to fill,
    // a `role` locator has no testId, and no wait state is being asked for yet.
    expect(html).toContain('data-capture-rows="1"');
    expect(html).toContain('data-capture-row="0" data-capture-kind="click" data-capture-locator="role"');
    expect(html).toContain('data-capture-role="0"');
    expect(html).toContain('data-capture-name="0"');
    expect(html).not.toContain("data-capture-testid=");
    expect(html).not.toContain("data-capture-value=");
    expect(html).not.toContain("data-capture-wait=");

    // Read from the actual markup rather than from the JSX: an unchecked box renders no `checked`, and
    // an all-false network block is a decision the note next to it explains.
    expect(html).toContain('<input id="capture-request-body" data-capture-request-body="true" type="checkbox"/>');
    expect(html).toContain('<input id="capture-response-body" data-capture-response-body="true" type="checkbox"/>');
    expect(html).toContain('<input id="capture-header-values" data-capture-header-values="true" type="checkbox"/>');
    expect(html).toContain(CAPTURE_NETWORK_NOTE);
    // The field that may carry a secret asks the browser not to remember it. Pinned from the markup the
    // harness really produces (it keeps the JSX's `autoComplete` spelling) rather than from a guess.
    expect(html).toContain('<input id="capture-sensitive" data-capture-sensitive="true" type="text" autoComplete="off" value=""/>');

    // Nothing here is a receipt: the sentence a 202 earns has not been printed, and neither half of the
    // door's output is promised by a heading.
    expect(html).not.toContain("已排入采集");
    expect(html).not.toContain("本地排队，尚未提交");
    expect(html).toContain("尚未发起：这一发只会排一个采集作业，不会给出结论。");
  });
});

// The declare-target control (§8 line 273, issue #58's last handle). It is the one write control whose
// only input is typed, so the two things worth pinning at first paint are that it offers no address of
// its own, and that it sits *before* the composer it feeds - the composer's subject comes from the
// project row, and a control placed after the section that depends on it reads like an afterthought.
describe("the target-declare panel before anything is typed", () => {
  it("offers an empty address and no receipt", () => {
    const html = renderToStaticMarkup(createElement(Workbench, { projectId: "00000000-0000-4000-8000-000000000000" }));
    expect(html).toContain('data-panel="target-declare"');
    expect(html.indexOf('data-panel="target-declare"')).toBeLessThan(html.indexOf('data-panel="capture-compose"'));
    // Nothing prefilled: a suggested address would be the page choosing which site a project is about.
    expect(html).toContain('<input id="declare-url" data-declare-url="true" type="text" autoComplete="off" value=""/>');
    expect(html).toContain("尚未声明：这一发只写一行目标，不会去访问任何东西。");
    expect(html).not.toContain("已声明 URL 目标");
    expect(html).not.toContain("身份未知（");
  });
});

// The plan builder's first paint (§8 line 289). It is the one section on this page whose inputs are
// three other sections' reads, so the honest first state is "nothing has been read yet" on all three
// fronts at once - and no exclusion row, because a plan that needs no exclusion is the ordinary case
// and a forced row would be the page demanding an answer nobody asked for.
describe("the plan-build panel before any read has happened", () => {
  it("names all three missing reads and offers no exclusion row", () => {
    const html = renderToStaticMarkup(createElement(Workbench, { projectId: "00000000-0000-4000-8000-000000000000" }));
    expect(html).toContain('data-panel="plan-build"');
    // A plan precedes a freeze in the chain, so the panel that builds one sits above the one that consumes it.
    expect(html.indexOf('data-panel="plan-build"')).toBeLessThan(html.indexOf('data-panel="blueprint-freeze"'));
    expect(html).toContain('data-plan-subject="blocked"');
    expect(html).toContain(PLAN_NO_TARGET_LINE);
    expect(html).toContain('data-plan-contracts="unreadable"');
    expect(html).toContain(PLAN_NO_JOURNAL_LINE);
    expect(html).toContain('data-plan-rows="0"');
    expect(html).not.toContain("data-plan-vector=");
    expect(html).not.toContain("data-plan-successor=");
    expect(html).toContain('data-plan-row-add="true"');
    expect(html).toContain("尚未造计划：这一发只写一份草稿计划，批准要另走 §8 line 291。");
    expect(html).not.toContain("已造计划");
  });
});

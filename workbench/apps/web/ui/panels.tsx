import { createElement, type ReactNode } from "react";

import { GraphView } from "./graph-canvas.tsx";
import type { DirectedInquiry, LeftPanel, ListRow, MiddleCell, RightTab } from "./view-model.ts";
import { listView } from "./view-model.ts";

// The three columns (PRD F04 / DESIGN §6, issue #18).
//
// These components are mounted by whatever renders them; nothing here imports a
// framework beyond `react` itself, which is what lets the headless render test the same
// tree the browser shows. `apps/web/app/client/workbench.tsx` is the Next.js island that
// mounts them (issue #18).
//
// Every status in this tree is rendered as icon + text + reasons. A cell that only
// had a background colour would be unusable to a screen reader, to a monochrome
// screenshot in a report, and to anyone with the very common kind of colour-vision
// deficiency the design rule exists for, so the presentation object cannot be
// replaced by a class name here — the component takes the words, not the hue.

export type PanelProps = {
  left: LeftPanel | { reason: string };
  cells: MiddleCell[];
  canvasFailures: { reason: string; missing: string[] }[];
  tabs: RightTab[];
  activeTab: RightTab["id"];
  onJumpToEvidence?: (evidenceId: string) => void;
  onInquiry?: (inquiry: DirectedInquiry) => void;
  // The canvas is the default view; the list is the same cells in another shape.
  mode?: "canvas" | "list";
  // A tab is a view choice, not a decoration: the shell owns which panel body is shown.
  onSelectTab?: (id: RightTab["id"]) => void;
  // The interactive canvas belongs to the middle column, not underneath the layout.
  canvasSlot?: ReactNode;
};

function StatusBadge(props: { cell: MiddleCell }): ReactNode {
  const { presentation } = props.cell;
  return createElement(
    "span",
    {
      className: `status status-${presentation.tone}`,
      "data-status": presentation.reasons.length === 0 ? "settled" : props.cell.presentation.reasons.join(","),
      "aria-label": `${presentation.label}：${presentation.reasons.join("；") || "无缺口"}`,
    },
    // Icon and text travel together; neither is optional.
    createElement("span", { "aria-hidden": "true" }, presentation.icon),
    " ",
    presentation.label,
    presentation.reasons.length > 0
      ? createElement("ul", { className: "reasons" }, presentation.reasons.map((reason) =>
          createElement("li", { key: reason, "data-reason": reason }, reason),
        ))
      : null,
  );
}

function LeftColumn(props: { panel: LeftPanel | { reason: string } }): ReactNode {
  if ("reason" in props.panel) {
    return createElement("aside", { "data-panel": "left" }, createElement("p", null, `无可用任务：${props.panel.reason}`));
  }
  const panel = props.panel;
  return createElement(
    "aside",
    { "data-panel": "left" },
    createElement("h2", null, panel.viewLabel),
    createElement("dl", null,
      createElement("dt", null, "任务"),
      createElement("dd", { "data-task-state": panel.taskState }, panel.taskId),
      createElement("dt", null, "清理"),
      createElement("dd", null, panel.cleanupState ?? "—"),
      // The refusal, with whatever numbers the server published beside it. Absent when the row has
      // not been refused - the dash would read as "refused, and nothing was said" (§6's honesty
      // rule for a missing fact, issue #59).
      ...(panel.failure === null
        ? []
        : [
            createElement("dt", { key: "failure-term" }, "被拒"),
            createElement("dd", { key: "failure-desc", "data-job-failure": panel.failure }, panel.failure),
          ]),
      createElement("dt", null, "画面"),
      createElement(
        "dd",
        { "data-frame-count": String(panel.frames.count) },
        panel.frames.count > 0 ? `${String(panel.frames.count)} 帧` : panel.frames.note,
      ),
    ),
    createElement("section", { "aria-label": "限制" },
      panel.limitations.length === 0
        ? createElement("p", null, "生产者未声明限制")
        : createElement("ul", null, panel.limitations.map((entry) =>
            createElement("li", { key: entry }, entry),
          )),
    ),
  );
}

// The list view is not a read-only summary: F04 asks for a jump to the evidence behind a
// claim and for an unknown to be able to start a directed inquiry, and the list is the
// view the operator can always reach. Both actions come from the cell, never from the row
// inventing them.
function ListColumnRows(props: {
  rows: ListRow[];
  onJumpToEvidence?: (evidenceId: string) => void;
  onInquiry?: (inquiry: DirectedInquiry) => void;
}): ReactNode {
  const jump = props.onJumpToEvidence;
  const inquire = props.onInquiry;
  return createElement("table", { "data-view": "list" },
    createElement("thead", null, createElement("tr", null,
      createElement("th", null, "项目"),
      createElement("th", null, "状态"),
      createElement("th", null, "缺口"),
      createElement("th", null, "来源"),
    )),
    createElement("tbody", null, props.rows.map((row) => createElement("tr", { key: row.id, "data-role": row.role },
      createElement("td", null, row.label),
      createElement("td", { className: `status status-${row.tone}`, "data-tone": row.tone }, row.statusLine),
      createElement("td", { "data-reasons": row.reasonLine },
        row.reasonLine,
        row.inquiry === null || inquire === undefined ? null : createElement("button", {
          type: "button",
          "data-inquiry": row.id,
          "data-inquiry-kind": row.inquiry.kind,
          onClick: () => inquire(row.inquiry as DirectedInquiry),
        }, "创建定向调查")),
      createElement("td", null,
        row.evidenceJumpTargets.length === 0 || jump === undefined
          ? String(row.sourceCount)
          : row.evidenceJumpTargets.map((evidenceId, index) => createElement("button", {
              key: evidenceId,
              type: "button",
              "data-evidence-jump": evidenceId,
              onClick: () => jump(evidenceId),
            }, `来源 ${String(index + 1)}`))),
    ))),
  );
}

function RightColumn(props: { tabs: RightTab[]; active: RightTab["id"]; onSelectTab?: (id: RightTab["id"]) => void }): ReactNode {
  const select = props.onSelectTab;
  return createElement("aside", { "data-panel": "right" },
    createElement("nav", { role: "tablist" }, props.tabs.map((tab) => createElement("button", {
      key: tab.id,
      role: "tab",
      type: "button",
      "aria-selected": tab.id === props.active ? "true" : "false",
      "data-tab": tab.id,
      "data-enabled": tab.enabled ? "yes" : "no",
      disabled: !tab.enabled,
      title: tab.disabledReason ?? "",
      ...(select === undefined || !tab.enabled ? {} : { onClick: () => select(tab.id) }),
    }, tab.label))),
  );
}

export function WorkbenchColumns(props: PanelProps): ReactNode {
  const mode = props.mode ?? "canvas";
  const cells = props.cells;
  return createElement("main", { "data-layout": "three-column" },
    LeftColumn({ panel: props.left }),
    createElement("section", { "data-panel": "middle" },
      props.canvasSlot ?? null,
      mode === "canvas"
        ? GraphView({
            cells,
            failures: props.canvasFailures,
            ...(props.onJumpToEvidence === undefined ? {} : { onJumpToEvidence: props.onJumpToEvidence }),
            ...(props.onInquiry === undefined ? {} : { onInquiry: props.onInquiry }),
          })
        : ListColumnRows({
            rows: listView(cells),
            ...(props.onJumpToEvidence === undefined ? {} : { onJumpToEvidence: props.onJumpToEvidence }),
            ...(props.onInquiry === undefined ? {} : { onInquiry: props.onInquiry }),
          }),
      cells.length === 0 ? createElement("p", null, "此 scope 暂无主张") : null,
      props.canvasFailures.map((failure) => createElement("p", {
        key: `${failure.reason}:${failure.missing.join(",")}`,
        "data-refusal": failure.reason,
      }, `画布不完整：${failure.reason}（${failure.missing.join(", ")}）`)),
    ),
    RightColumn({
      tabs: props.tabs,
      active: props.activeTab,
      ...(props.onSelectTab === undefined ? {} : { onSelectTab: props.onSelectTab }),
    }),
  );
}

// A cell keeps its own judgement in the list too: the two views are rendered from the
// same cells, so a reviewer cannot get a friendlier answer by switching tabs.
export { StatusBadge };

import { createElement, type ReactNode } from "react";

import { GraphView } from "./graph-canvas.tsx";
import type { DirectedInquiry, LeftPanel, ListRow, MiddleCell, RightTab } from "./view-model.ts";
import { listView } from "./view-model.ts";

// The three columns (PRD F04 / DESIGN §6, issue #18).
//
// These components are mounted by whatever renders them; nothing here imports a
// framework beyond `react` itself. That is a stated gap rather than a finished
// integration: §3 names Next.js for `apps/web`, and the page shell, `next dev` and a
// real browser pass over pan/zoom, tab switching and focus are not done in this
// repository yet — see issue #18's unverified list.
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

function ListColumnRows(props: { rows: ListRow[] }): ReactNode {
  return createElement("table", { "data-view": "list" },
    createElement("thead", null, createElement("tr", null,
      createElement("th", null, "项目"),
      createElement("th", null, "状态"),
      createElement("th", null, "缺口"),
      createElement("th", null, "来源"),
    )),
    createElement("tbody", null, props.rows.map((row) => createElement("tr", { key: row.id, "data-role": row.role },
      createElement("td", null, row.label),
      createElement("td", null, row.statusLine),
      createElement("td", { "data-reasons": row.reasonLine }, row.reasonLine),
      createElement("td", null, String(row.sourceCount)),
    ))),
  );
}

function RightColumn(props: { tabs: RightTab[]; active: RightTab["id"] }): ReactNode {
  return createElement("aside", { "data-panel": "right" },
    createElement("nav", { role: "tablist" }, props.tabs.map((tab) => createElement("button", {
      key: tab.id,
      role: "tab",
      "aria-selected": tab.id === props.active ? "true" : "false",
      "data-tab": tab.id,
      "data-enabled": tab.enabled ? "yes" : "no",
      disabled: !tab.enabled,
      title: tab.disabledReason ?? "",
    }, tab.label))),
  );
}

export function WorkbenchColumns(props: PanelProps): ReactNode {
  const mode = props.mode ?? "canvas";
  const cells = props.cells;
  return createElement("main", { "data-layout": "three-column" },
    LeftColumn({ panel: props.left }),
    createElement("section", { "data-panel": "middle" },
      mode === "canvas"
        ? GraphView({
            cells,
            failures: props.canvasFailures,
            ...(props.onJumpToEvidence === undefined ? {} : { onJumpToEvidence: props.onJumpToEvidence }),
            ...(props.onInquiry === undefined ? {} : { onInquiry: props.onInquiry }),
          })
        : ListColumnRows({ rows: listView(cells) }),
      cells.length === 0 ? createElement("p", null, "此 scope 暂无主张") : null,
      props.canvasFailures.map((failure) => createElement("p", {
        key: `${failure.reason}:${failure.missing.join(",")}`,
        "data-refusal": failure.reason,
      }, `画布不完整：${failure.reason}（${failure.missing.join(", ")}）`)),
    ),
    RightColumn({ tabs: props.tabs, active: props.activeTab }),
  );
}

// A cell keeps its own judgement in the list too: the two views are rendered from the
// same cells, so a reviewer cannot get a friendlier answer by switching tabs.
export { StatusBadge };

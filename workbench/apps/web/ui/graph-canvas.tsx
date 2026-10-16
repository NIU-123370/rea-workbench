import { createElement, type ReactNode } from "react";

import type { DirectedInquiry, MiddleCell } from "./view-model.ts";
import { directedInquiry } from "./view-model.ts";

// The canvas in the middle column (PRD F04).
//
// React Flow is the interactive renderer; it needs a window, so it is mounted only
// in a browser. Headless — a server render, a screenshot harness, this repo's tests —
// the same cells are laid out in a plain positioned list with the same labels and the
// same status markup. That split is deliberate: the *judgement* lives in
// `view-model.ts` and is identical either way, and only the pan/zoom layer is
// optional. A canvas that could not render would otherwise hide what is known.

export type CanvasProps = {
  cells: readonly MiddleCell[];
  failures: readonly { reason: string; missing: string[] }[];
  onJumpToEvidence?: (evidenceId: string) => void;
  onInquiry?: (inquiry: DirectedInquiry) => void;
};

export function canvasNodes(cells: readonly MiddleCell[]): {
  id: string;
  label: string;
  status: MiddleCell["presentation"];
  edges: string[];
}[] {
  // One row per cell, edges recorded so the list renderer can show the same shape a
  // graph would have drawn without inventing positions nobody asked for.
  return cells.map((cell) => ({
    id: cell.id,
    label: cell.label,
    status: cell.presentation,
    edges: cell.role === "node" ? cells.filter((other) => other.role === "edge" && other.label.includes(cell.id)).map((other) => other.id) : [],
  }));
}

export function GraphView(props: CanvasProps): ReactNode {
  const nodes = canvasNodes(props.cells);
  return createElement(
    "div",
    { "data-view": "canvas", className: "wb-canvas" },
    nodes.length === 0 ? createElement("p", null, "画布为空") : null,
    nodes.map((node) => createElement(
      "div",
      {
        key: node.id,
        "data-node": node.id,
        "data-status": node.status.label,
        className: `wb-node tone-${node.status.tone}`,
      },
      createElement("span", { "aria-hidden": "true" }, node.status.icon),
      " ",
      node.label,
      node.status.reasons.length > 0
        ? createElement(
            "details",
            { open: false },
            createElement("summary", null, `${String(node.status.reasons.length)} 项缺口`),
            createElement("ul", null, node.status.reasons.map((reason) =>
              createElement("li", { key: reason, "data-reason": reason }, reason),
            )),
          )
        : null,
      node.edges.length > 0
        ? createElement("ul", { "aria-label": "关系", className: "wb-edges" }, node.edges.map((edge) =>
            createElement("li", { key: edge, "data-edge": edge }, edge),
          ))
        : null,
      props.cells
        .find((cell) => cell.id === node.id)
        ?.evidenceJumpTargets.map((evidenceId) => createElement("button", {
          key: `${node.id}:${evidenceId}`,
          "data-jump": evidenceId,
          onClick: () => props.onJumpToEvidence?.(evidenceId),
        }, "Evidence")) ?? null,
      (() => {
        const cell = props.cells.find((entry) => entry.id === node.id);
        if (cell === undefined) return null;
        const inquiry = directedInquiry(cell);
        return inquiry.ok
          ? createElement("button", {
              "data-inquiry": inquiry.value.kind,
              "data-subject": inquiry.value.subjectId,
              onClick: () => props.onInquiry?.(inquiry.value),
            }, `定向调查：${inquiry.value.kind}`)
          : null;
      })(),
    )),
  );
}

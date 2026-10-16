#!/usr/bin/env node
// Posts the review bot's findings onto the pull request as a real review:
// CHANGES_REQUESTED when a P1 is present, COMMENTED otherwise. Inline comments
// are only attachable to lines inside the diff, so a payload rejected by the API
// is retried without them rather than dropping the whole review — a bot that
// silently fails to report is worse than one that reports in the summary body.

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";

function gh(args, payload) {
  const result = spawnSync("gh", ["api", ...args], {
    encoding: "utf8",
    input: payload === undefined ? "" : JSON.stringify(payload),
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { ok: result.status === 0, body: result.stdout || "", error: result.stderr || "" };
}

const repo = process.env["REPO"];
const pr = process.env["PR"];
const findingsPath = process.env["FINDINGS"] ?? ".review/findings.json";
const runUrl = process.env["GITHUB_SERVER_URL"]
  ? `${process.env["GITHUB_SERVER_URL"]}/${repo}/actions/runs/${process.env["GITHUB_RUN_ID"]}`
  : "(local run)";

if (!repo || !pr) {
  console.error("REPO and PR must be set");
  process.exit(2);
}

if (!existsSync(findingsPath)) {
  // An earlier gate (typecheck or tests) failed before the rules ran, so the red
  // check already carries the signal and a review body would only be noise.
  process.stdout.write(`no findings file at ${findingsPath}; earlier gate failed, skipping review\n`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(findingsPath, "utf8"));
const summary = report.summary;
const event = summary.P1 > 0 ? "CHANGES_REQUESTED" : "COMMENTED";

const lines = [
  `自动评审：扫描 ${report.scannedFiles} 个文件，命中 ${summary.total} 条（P1 ${summary.P1} / P2 ${summary.P2}）。`,
  "",
  `判定：**${event === "CHANGES_REQUESTED" ? "阻塞（有 P1）" : "不阻塞"}**。检测范围 = typecheck + 全部测试 + oxlint + 规则表，细节见 ${runUrl}。`,
  "",
];
if (summary.total === 0) {
  lines.push("规则表全部通过（R1–R7，见 `infra/review/rules.mjs`）。");
} else {
  lines.push("| 级别 | 规则 | 位置 | 结论 |");
  lines.push("| --- | --- | --- | --- |");
  for (const finding of report.findings) {
    lines.push(
      `| ${finding.severity} | ${finding.rule}（${finding.anchor}） | \`${finding.file}:${finding.line}\` | ${finding.title} — ${finding.hint} |`,
    );
  }
}
const body = lines.join("\n");

const inline = report.findings.map((finding) => ({
  path: finding.file,
  line: finding.line,
  body: `**${finding.severity} ${finding.rule}**（${finding.anchor}）\n\n${finding.title}。${finding.hint}\n\n\`\`\`\n${finding.snippet}\n\`\`\``,
}));

let result = gh(
  [`repos/${repo}/pulls/${pr}/reviews`, "--method", "POST", "--input", "-"],
  { body, event, comments: inline },
);

if (!result.ok) {
  const note = `\n\n_（inline comment 被 API 拒绝：这些行不在本次 diff 的右侧范围内。原因：${result.error.split("\n")[0]?.slice(0, 140)}）_`;
  result = gh(
    [`repos/${repo}/pulls/${pr}/reviews`, "--method", "POST", "--input", "-"],
    { body: body + note, event },
  );
}

process.stdout.write(`${result.ok ? "posted" : "FAILED"} review=${event} findings=${summary.total}\n`);
process.exit(result.ok ? 0 : 1);

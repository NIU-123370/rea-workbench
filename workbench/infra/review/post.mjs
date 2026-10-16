#!/usr/bin/env node
// Posts the review bot's findings onto the pull request as a real review, using
// the event names GitHub actually accepts (APPROVE / REQUEST_CHANGES / COMMENT).
// Three attempts, each strictly weaker than the last, and every downgrade is
// explained inside the review body: a bot that silently fails to report is worse
// than one that reports in the summary.

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";

function gh(endpoint, payload) {
  const result = spawnSync("gh", ["api", ...endpoint], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { ok: result.status === 0, body: result.stdout || "", error: result.stderr || "" };
}

function reason(raw) {
  const clean = String(raw).replace(/\s+/g, " ").trim();
  return clean.slice(0, 140) || "unknown";
}

function reportPosted(result, usedEvent, stats, notes) {
  let state = "";
  try {
    state = JSON.parse(result.body || "{}")?.state ?? "";
  } catch {
    // The review was accepted; only its echo failed to parse.
  }
  process.stdout.write(
    `posted review=${usedEvent}${state ? ` state=${state}` : ""} findings=${stats.total} downgrades=${notes.length}\n`,
  );
  process.exit(0);
}

const repo = process.env["REPO"];
const pr = process.env["PR"];
const findingsPath = process.env["FINDINGS"] ?? ".review/findings.json";
const runUrl = process.env["GITHUB_SERVER_URL"]
  ? `${process.env["GITHUB_SERVER_URL"]}/${repo}/actions/runs/${process.env["GITHUB_RUN_ID"]}`
  : "(local run)";

if (!repo || !pr) {
  process.stderr.write("REPO and PR must be set\n");
  process.exit(2);
}

if (!existsSync(findingsPath)) {
  // Nothing was scanned, so there is nothing to report. This is not a pass: the
  // final workflow step fails the check when the report is missing.
  process.stdout.write(`no findings file at ${findingsPath}; nothing to post\n`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(findingsPath, "utf8"));
const summary = report.summary;
const event = summary.P1 > 0 ? "REQUEST_CHANGES" : "COMMENT";

const lines = [
  `自动评审：扫描 ${report.scannedFiles} 个文件，命中 ${summary.total} 条（P1 ${summary.P1} / P2 ${summary.P2}）。`,
  "",
  `判定：**${event === "REQUEST_CHANGES" ? "阻塞（有 P1）" : "不阻塞"}**。检测范围 = typecheck + 全部测试 + oxlint + 规则表，细节见 ${runUrl}。`,
  "",
];
if (summary.total === 0) {
  lines.push("规则表全部通过（R1–R7，见 `infra/review/rules.mjs`）。");
} else {
  lines.push("| 级别 | 规则 | 位置 | 结论 |", "| --- | --- | --- | --- |");
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

const endpoint = [`repos/${repo}/pulls/${pr}/reviews`, "--method", "POST", "--input", "-"];

// 1. event + inline comments — the useful shape, but a path or line outside the
//    diff is a hard 422 ("Path could not be resolved").
const first = gh(endpoint, { body, event, comments: inline });
if (first.ok) reportPosted(first, event, summary, []);

const notes = [`第 1 次（inline + ${event}）被拒：${reason(first.error)}`];

// 2. event + summary only.
const second = gh(endpoint, { body: `${body}\n\n_${notes[0]}，改为只发摘要_`, event });
if (second.ok) reportPosted(second, event, summary, notes);

notes.push(`第 2 次（${event} 无 inline）被拒：${reason(second.error)}`);

// 3. COMMENT + summary only — a human author cannot request changes on their own
//    pull request, so the blocking signal falls to the failed check instead.
const blocking = event !== "COMMENT";
const third = gh(endpoint, {
  body: `${body}\n\n_${notes.join("；")}${
    blocking ? "；改为 COMMENT，合并阻断由本次检查变红承担_" : "_"
  }`,
  event: "COMMENT",
});
if (!third.ok) {
  process.stdout.write(
    `FAILED all three attempts findings=${summary.total} last=${reason(third.error)}\n`,
  );
  process.exit(1);
}
reportPosted(third, "COMMENT", summary, notes);

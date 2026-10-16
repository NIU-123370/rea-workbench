#!/usr/bin/env node
// Review bot entrypoint: scans the tree (or an explicit file list) with the rule
// table and emits findings as JSON, plus a markdown summary and per-line GitHub
// annotations. Exit code 1 when any P1 is found, so the check blocks the merge.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { RULES, scanSource, summarize } from "./rules.mjs";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs"];
const SCAN_ROOTS = ["packages", "apps", "tests"];

function parseArgs(argv) {
  const options = { root: process.cwd(), json: null, summary: null, only: null, listRules: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = argv[(index += 1)];
    else if (arg === "--json") options.json = argv[(index += 1)];
    else if (arg === "--summary") options.summary = argv[(index += 1)];
    else if (arg === "--files") options.only = String(argv[(index += 1)] ?? "").split(",").filter(Boolean);
    else if (arg === "--rules") options.listRules = true;
  }
  return options;
}

function walk(rootDir, relativeDir) {
  const absolute = path.join(rootDir, relativeDir);
  if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) return [];
  const found = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    // Tool output is not source. A build directory (`apps/web/.next`, `.turbo`, `.swc`)
    // is full of generated files that carry suppressions and shapes no rule was written
    // for, and scanning them turns a green tree red for reasons nobody can fix in a
    // review. Dot-directories are the convention for exactly that output.
    if (entry.isDirectory() && entry.name.startsWith(".")) continue;
    const relative = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) found.push(...walk(rootDir, relative));
    else if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(relative);
  }
  return found;
}

const options = parseArgs(process.argv.slice(2));

if (options.listRules) {
  for (const rule of RULES) {
    process.stdout.write(`${rule.id} ${rule.severity} ${rule.anchor} ${rule.title}\n`);
  }
  process.exit(0);
}

const files = options.only ?? SCAN_ROOTS.flatMap((root) => walk(options.root, root));
const findings = files.flatMap((file) =>
  scanSource(file, readFileSync(path.join(options.root, file), "utf8")),
);
const summary = summarize(findings);

function writeReport(target, contents) {
  if (!target) return;
  // CI starts from a clean checkout where .review/ does not exist, so the parent
  // directory is created rather than assumed: assuming it turned a crashed scan
  // into a green check.
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

const payload = { scannedFiles: files.length, findings, summary };
const serialised = `${JSON.stringify(payload)}\n`;
writeReport(options.json, serialised);
if (!options.json) process.stdout.write(serialised);

if (options.summary) {
  const lines = [
    "## 自动评审（规则来自设计文档，不是风格偏好）",
    "",
    `扫描 ${files.length} 个文件，命中 ${summary.total} 条（P1 ${summary.P1} / P2 ${summary.P2}）。`,
    "",
  ];
  if (summary.total === 0) lines.push("本轮规则全部通过。");
  for (const finding of findings) {
    lines.push(
      `- **${finding.severity} ${finding.rule}** \`${finding.file}:${finding.line}\` — ${finding.title}（${finding.anchor}）— ${finding.hint}`,
    );
  }
  writeReport(options.summary, `${lines.join("\n")}\n`);
}

for (const finding of findings) {
  const level = finding.severity === "P1" ? "error" : "warning";
  // Annotations go to stderr so stdout stays a single parseable JSON document.
  process.stderr.write(
    `::${level} file=${finding.file},line=${finding.line}::${finding.rule} ${finding.title} (${finding.anchor})\n`,
  );
}

process.exitCode = summary.P1 > 0 ? 1 : 0;

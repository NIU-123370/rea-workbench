// The in-repo review bot's rule table. Each rule traces to a sentence in the
// design documents that a type checker and a test suite cannot catch on their
// own, and is deliberately narrow: rules that fire on correct-but-different code
// train everyone to ignore the bot.

const PRODUCTION = /^(packages|apps)\//;
const TESTS = /^tests\//;
// Tooling has to be able to contain the strings it detects.
const EXCLUDED = /^infra\//;

export const RULES = [
  {
    id: "R1",
    severity: "P1",
    scope: "production",
    // DESIGN §4/§8: every wire input is parsed from `unknown` and must reject
    // extra fields; only the strict object builders satisfy that.
    anchor: "DESIGN §4 §8",
    title: "zod 对象必须拒绝额外字段",
    pattern: /\bz\.(object|looseObject|loosedObject)\s*[<(]/,
    hint: "用 z.strictObject(...)；上游 payload 用 z.loosedObject 会把没建模的字段静默收下",
  },
  {
    id: "R2",
    severity: "P1",
    scope: "production",
    // DESIGN §12.1: raw console/provider stderr must never reach a file or the
    // terminal; output goes through the sanitizer ports.
    anchor: "DESIGN §12.1 / D28",
    title: "生产代码不允许直接 console 输出",
    pattern: /\bconsole\.(log|info|warn|error|debug)\s*\(/,
    hint: "日志经 DiagnosticsSanitizer 与 Logger port 落；raw console 会绕过唯一过滤 owner",
  },
  {
    id: "R3",
    severity: "P1",
    scope: "production",
    // DESIGN §4: workbench ids are opaque UUIDs; §14/D30: pairing tokens and
    // session/CSRF values are random credentials. Both must be crypto-backed.
    anchor: "DESIGN §4 §14 / D30",
    title: "身份与凭据必须来自 crypto，不用 Math.random",
    pattern: /\bMath\.random\s*\(/,
    hint: "用 crypto.randomUUID() 或 randomBytes；Math.random 可预测，不能用于 Id/token/CSRF",
  },
  {
    id: "R4",
    severity: "P1",
    scope: "production",
    // DESIGN §4: `JsonValue` instead of `any`; §12.1: unknown-shaped data must
    // be parsed, not cast.
    anchor: "DESIGN §4",
    title: "不允许 any 类型",
    pattern: /:\s*any\b|\bas any\b|<any>|any\[\]/,
    hint: "先按具名 schema 从 unknown 解析；用 JsonValue / Result 表达未定型数据",
  },
  {
    id: "R5",
    severity: "P2",
    scope: "production",
    anchor: "DESIGN §13",
    title: "抑制类型检查要写明原因",
    pattern: /@ts-(?:ignore|expect-error)\b/,
    hint: "写清为什么必须抑制；确属合理就在同一行加 review-bot-ignore R5 (原因)，让例外留在 diff 里",
  },
  {
    id: "R6",
    severity: "P1",
    scope: "tests",
    anchor: "TESTPLAN §6",
    title: "测试里不许留下 .only",
    pattern: /\b(?:it|test|describe)\s*\.\s*only\s*\(/,
    hint: "focus 标记会静默把整条发布门禁变成只跑一条用例",
  },
  {
    id: "R7",
    severity: "P2",
    scope: "tests",
    anchor: "TESTPLAN §6",
    title: "跳过的用例要挂回 issue",
    pattern: /\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\s*\(/,
    hint: "被 skip 的门禁必须留下它归属的 issue 号，否则就等于门禁消失了",
  },
];

function inScope(scope, file) {
  if (EXCLUDED.test(file)) return false;
  if (scope === "production") return PRODUCTION.test(file);
  if (scope === "tests") return TESTS.test(file);
  return false;
}

// One finding per (rule, file, line). A line carrying an explicit
// `review-bot-ignore <id>` marker is skipped, so a deliberate exception stays
// visible in the diff instead of being silently tolerated by the rule table.
export function scanSource(file, text) {
  const findings = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const rule of RULES) {
      if (!inScope(rule.scope, file)) continue;
      if (!rule.pattern.test(line)) continue;
      const ignore = new RegExp(`review-bot-ignore\\s+${rule.id}\\b`);
      if (ignore.test(line)) continue;
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        anchor: rule.anchor,
        title: rule.title,
        hint: rule.hint,
        file,
        line: index + 1,
        snippet: line.trim().slice(0, 160),
      });
    }
  }
  return findings;
}

export function summarize(findings) {
  const counts = { P1: 0, P2: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return { total: findings.length, ...counts, blocking: counts.P1 };
}

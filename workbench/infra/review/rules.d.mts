export type ReviewSeverity = "P1" | "P2";

export type ReviewRule = {
  readonly id: string;
  readonly severity: ReviewSeverity;
  readonly scope: "production" | "tests";
  readonly anchor: string;
  readonly title: string;
  readonly hint: string;
  readonly pattern: RegExp;
};

export type ReviewFinding = {
  rule: string;
  severity: ReviewSeverity;
  anchor: string;
  title: string;
  hint: string;
  file: string;
  line: number;
  snippet: string;
};

export type ReviewSummary = {
  total: number;
  P1: number;
  P2: number;
  blocking: number;
};

export const RULES: readonly ReviewRule[];

export function scanSource(file: string, text: string): ReviewFinding[];

export function summarize(findings: readonly ReviewFinding[]): ReviewSummary;

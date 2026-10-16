export declare const TESTPLAN_FILE: "docs/TESTPLAN.md";
export declare const PRD_FILE: "docs/PRD.md";

export type ParsedTestCase = { case: string; accepts: string[] };

export type ReconcileInput = {
  testCases: ParsedTestCase[];
  accepts: string[];
  firstCase?: string;
  lastCase?: string;
};

export declare function parseTestCaseRows(markdown: string): ParsedTestCase[];

export declare function parseAcceptanceRows(markdown: string): string[];

export declare function reconcile(input: ReconcileInput): string[];

export declare function checkDocs(testplan: string, prd: string): string[];

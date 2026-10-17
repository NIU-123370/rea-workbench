export declare const TESTPLAN_FILE: "docs/TESTPLAN.md";
export declare const PRD_FILE: "docs/PRD.md";
export declare const SOURCE_ROOTS: string[];
export declare const SOURCE_EXTENSIONS: string[];
export declare const SKIPPED_DIRECTORIES: string[];

export type ParsedTestCase = { case: string; accepts: string[] };

export type SourceIdReference = { ref: string; file: string; line: number };

export type ReconcileInput = {
  testCases: ParsedTestCase[];
  accepts: string[];
  firstCase?: string;
  lastCase?: string;
};

export declare function parseTestCaseRows(markdown: string): ParsedTestCase[];

export declare function parseAcceptanceRows(markdown: string): string[];

export declare function findIdReferences(file: string, text: string): SourceIdReference[];

export declare function checkSourceReferences(
  references: SourceIdReference[],
  declared: { cases: string[]; accepts: string[] },
): string[];

export declare function reconcile(input: ReconcileInput): string[];

export declare function checkDocs(testplan: string, prd: string): string[];

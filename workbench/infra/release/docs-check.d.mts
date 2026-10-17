export declare const TESTPLAN_FILE: "docs/TESTPLAN.md";
export declare const PRD_FILE: "docs/PRD.md";
export declare const DECISIONS_FILE: "docs/DECISIONS.md";
export declare const DESIGN_FILE: "docs/DESIGN.md";
export declare const SOURCE_ROOTS: string[];
export declare const SOURCE_EXTENSIONS: string[];
export declare const SKIPPED_DIRECTORIES: string[];

export type ParsedTestCase = { case: string; accepts: string[] };

export type SourceIdReference = { ref: string; file: string; line: number };

export type DesignSection = { section: string; start: number; end: number };

export type DesignAnchor = {
  section: string;
  from: number | null;
  to: number | null;
  file: string;
  line: number;
};

export type DeclaredIds = { cases: string[]; accepts: string[]; decisions: string[] };

export type ReconcileInput = {
  testCases: ParsedTestCase[];
  accepts: string[];
  firstCase?: string;
  lastCase?: string;
};

export declare function parseTestCaseRows(markdown: string): ParsedTestCase[];

export declare function parseAcceptanceRows(markdown: string): string[];

export declare function parseDecisionRows(markdown: string): string[];

export declare function parseDesignSections(markdown: string): DesignSection[];

export declare function findSectionAnchors(file: string, text: string): DesignAnchor[];

export declare function checkSectionAnchors(
  anchors: DesignAnchor[],
  sections: DesignSection[],
  designLines: number,
): string[];

export declare function findIdReferences(file: string, text: string): SourceIdReference[];

export declare function checkSourceReferences(references: SourceIdReference[], declared: DeclaredIds): string[];

export declare function reconcile(input: ReconcileInput): string[];

export declare function checkDocs(testplan: string, prd: string): string[];

/** One row of either route table: §8's, or the web adapter's. */
export type RouteRow = { method: string; target: string; line: number };

/**
 * The differences this build ships with, each naming the issue that records it. Declared with its
 * keys spelled out because a waiver table that type-checked as `Record<string, string>` would let
 * a test index a key the table never had and read `undefined` back as if it were a waiver.
 */
export declare const ROUTE_DEVIATIONS: {
  "GET /projects/:p/jobs/:j/preview": string;
  "GET /comparator-policies": string;
  "GET /projects/:p/exports": string;
};

export declare const WEB_API_FILE: string;

export declare function parseDesignRoutes(markdown: string, sections: DesignSection[]): RouteRow[];

export declare function parseMountedRoutes(text: string): RouteRow[];

export declare function canonicalRoute(method: string, target: string): string;

export declare function checkRoutes(
  design: RouteRow[],
  mounted: RouteRow[],
  deviations: Record<string, string>,
): string[];

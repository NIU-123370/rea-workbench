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

/** One row of §8's route table: the door it promises and the field column that describes it. */
export type DesignRouteRow = { method: string; target: string; request: string; line: number };

/** One door the web adapter actually mounts, with the flag its declaration line carries. */
export type MountedRouteRow = { method: string; target: string; line: number; keyed: boolean };

/** Rows of either table, for the check that only compares method and path. */
export type RouteRow = { method: string; target: string; line: number };

/** The eight creations §8 line 261 names, and this file's reading of each onto a path template. */
export declare const KEYED_CREATION_WORDS: string[];
export declare const KEYED_CREATION_TEMPLATES: Record<string, string>;

/**
 * The two idempotency differences this build ships with. Named keys, for the same reason as the
 * route waiver table: indexing a door that is not here should not read back as a waiver.
 */
export declare const IDEMPOTENCY_DEVIATIONS: {
  "POST /projects/:p/exports": string;
  "POST /projects": string;
};

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

export declare function parseDesignRoutes(markdown: string, sections: DesignSection[]): DesignRouteRow[];

export declare function parseMountedRoutes(text: string): MountedRouteRow[];

export declare function canonicalRoute(method: string, target: string): string;

export declare function checkRoutes(
  design: RouteRow[],
  mounted: RouteRow[],
  deviations: Record<string, string>,
): string[];

export declare function checkIdempotencyKeys(
  design: DesignRouteRow[],
  mounted: MountedRouteRow[],
  deviations: Record<string, string>,
  words?: readonly string[],
  templates?: Record<string, string>,
): string[];

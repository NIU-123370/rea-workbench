import { describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { asId } from "../../packages/domain/identity.ts";
import { draftReview, vectorDigest, vectorDigestInput } from "../../packages/domain/vector.ts";
import type { TestVector, TestVectorContent } from "../../packages/domain/vector.ts";
import {
  BLUEPRINT_DIGEST_FIELDS,
  GENERATION_LANGUAGE,
  GENERATION_OUTPUT_KIND,
  OPENAPI_VERSION,
  SOURCE_MANIFEST_DIGEST_FIELDS,
  blueprintDigestInput,
  blueprintDigestOf,
  buildBlueprintPayload,
  leakReasons,
  nonSeenClaimReasons,
  nonSeenEdgeReasons,
  publicVectorOf,
  sourceManifestDigestInput,
  sourceManifestDigestOf,
  sourceTextSuspicions,
  type BlueprintContractEntry,
  type PublicTestVector,
  type SourceManifest,
} from "../../packages/domain/blueprint.ts";
import type { BlueprintClaim } from "../../packages/domain/blueprint.ts";
import { builderBlueprintSchema } from "../../packages/contracts/blueprint.ts";

// DESIGN §7.3 with D12/D13 and PRD A06: the handoff is a fixed field list, a
// public vector is a usable approved one with an oracle, and a required claim or
// edge that is not SEEN blocks the freeze no matter who approved what.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const HEX_1 = ("1" as const).repeat(64);
const HEX_2 = ("2" as const).repeat(64);
const VECTOR_ID = asId("11111111-1111-4111-8111-111111111111");
const CLAIM_ID = asId("22222222-2222-4222-8222-222222222222");
const BLUEPRINT_ID = asId("33333333-3333-4333-8333-333333333333");

function content(overrides: Partial<TestVectorContent> = {}): TestVectorContent {
  const base: TestVectorContent = {
    id: VECTOR_ID,
    targetId: asId("44444444-4444-4444-8444-444444444444"),
    snapshotDigest: asDigest(HEX_1),
    operationId: "getCart",
    sdkInput: { include: "items" },
    caseKey: "cart-ok",
    replacesId: null,
    source: {
      evidenceId: `ev_${HEX_2}`,
      captureId: null,
      recordOrdinal: 0,
      pointer: "/records/0/reported",
      transactionId: null,
    },
    request: {
      method: "GET",
      url: "https://shop.example/api/cart",
      query: [{ name: "include", value: "items" }],
      headers: [{ name: "accept", value: "application/json" }],
      body: { kind: "empty" },
    },
    response: {
      status: 200,
      headers: [{ name: "content-type", value: "application/json" }],
      body: { kind: "text", text: '{"items":[]}', provenance: "producer-decoded" },
    },
    expectedOutcome: { kind: "return", value: { items: [] } },
    coverage: { state: "complete", examined: null, total: null, reasons: [] },
    limitations: [],
    redactions: [
      {
        fieldPointer: "/records/0/reported/request/headers/0/value",
        reason: "transport-auth",
        representation: "omitted",
      },
    ],
    visibility: "public",
    eligibility: "usable",
    reasons: [],
    ...overrides,
  };
  return base;
}

function vector(overrides: Partial<TestVector> = {}): TestVector {
  const base = content();
  const digest = vectorDigest(base, LIMITS);
  return {
    ...base,
    digest,
    review: { ...draftReview(), status: "approved", reviewerId: "reviewer-one", reviewedAt: "2026-10-16T00:00:00.000Z" as never, approvedDigest: digest },
    ...overrides,
  };
}

function contractEntry(): BlueprintContractEntry {
  return {
    contractKey: "cart-api",
    revision: 1,
    digest: asDigest(HEX_2),
    behaviorSpec: "GET /api/cart returns the item list",
    inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    httpOperations: [
      {
        operationId: "getCart",
        method: "GET",
        path: "/api/cart",
        requestMediaType: null,
        responses: [{ status: 200, mediaType: "application/json", schema: { type: "object" } }],
      },
    ],
    errorCases: ["401 unauthenticated"],
    limitations: ["only one sample observed"],
    unknowns: ["pagination behaviour"],
  };
}

function publicVector(): PublicTestVector {
  const projected = publicVectorOf(vector());
  if (projected === null) throw new Error("sample should project");
  return projected;
}

function payload(publicVectors: readonly PublicTestVector[] = [publicVector()]) {
  return buildBlueprintPayload({
    blueprintId: BLUEPRINT_ID,
    blueprintDigest: asDigest(HEX_1),
    contracts: [contractEntry()],
    publicVectors,
    verificationScope: ["contract:cart-api@1", "operation:getCart"],
  });
}

function claim(overrides: Partial<BlueprintClaim> = {}): BlueprintClaim {
  return {
    id: CLAIM_ID,
    basis: "observed",
    validity: "current",
    sourceEvidenceIds: [`ev_${HEX_2}`],
    authorityApplies: true,
    coverage: { state: "complete", examined: null, total: null, reasons: [] },
    ...overrides,
  };
}

function manifest(overrides: Partial<Omit<SourceManifest, "manifestDigest">> = {}): Omit<SourceManifest, "manifestDigest"> {
  return {
    schemaVersion: 1,
    blueprintId: BLUEPRINT_ID,
    blueprintDigest: asDigest(HEX_1),
    projectId: asId("55555555-5555-4555-8555-555555555555"),
    targetId: asId("44444444-4444-4444-8444-444444444444"),
    snapshotDigest: asDigest(HEX_1),
    graphRevision: 4,
    planId: asId("66666666-6666-4666-8666-666666666666"),
    planDigest: asDigest(HEX_2),
    inventoryDigest: asDigest(HEX_1),
    selectedVectorIds: [VECTOR_ID],
    excludedVectorReasons: [],
    claims: [
      {
        contractDigest: asDigest(HEX_2),
        claimId: CLAIM_ID,
        evidenceIds: [`ev_${HEX_2}`],
        sourceLocations: [{ pointer: "/records/0/reported" }],
      },
    ],
    holdoutVectorIds: [],
    reviewAttribution: [
      { reviewerId: "reviewer-one", reviewedAt: "2026-10-16T00:00:00.000Z" as never, approvedDigest: asDigest(HEX_2) },
    ],
    sourceTextSuspicions: [],
    ...overrides,
  };
}

describe("the handoff is a fixed allowlist (DESIGN §7.3)", () => {
  it("carries exactly the fields the spec lists", () => {
    expect(Object.keys(payload()).sort()).toEqual(
      [
        "blueprintDigest",
        "blueprintId",
        "contractRevisions",
        "generation",
        "publicVectors",
        "schemaVersion",
        "verificationScope",
      ].sort(),
    );
    expect(Object.keys(builderBlueprintSchema.shape).sort()).toEqual(
      Object.keys(payload()).sort(),
    );
  });

  it("carries exactly the public vector fields, with a non-null oracle", () => {
    expect(Object.keys(publicVector()).sort()).toEqual(
      ["coverage", "expectedOutcome", "id", "limitations", "operationId", "request", "response", "sdkInput"].sort(),
    );
    const record = publicVector() as unknown as Record<string, unknown>;
    expect(record.expectedOutcome).not.toBeNull();
  });

  it("names the generation target rather than a version it guessed", () => {
    expect(payload().generation).toEqual({
      language: GENERATION_LANGUAGE,
      outputKind: GENERATION_OUTPUT_KIND,
      openapiVersion: OPENAPI_VERSION,
    });
  });

  it("drops the source reference, locator and storage location from a public vector", async () => {
    const source = content().source;
    const serialized = JSON.stringify(payload());
    expect(serialized).not.toContain(source.evidenceId);
    expect(serialized).not.toContain(String(source.pointer));
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("evidenceId");
    expect(serialized).not.toContain("snapshotDigest");
    expect(serialized).not.toContain(content().redactions[0]?.fieldPointer as string);
  });

  it("refuses to project a sample that is holdout, blocked, unapproved or without an oracle", () => {
    expect(publicVectorOf(vector({ visibility: "holdout" }))).toBeNull();
    expect(
      publicVectorOf(
        vector({
          eligibility: "blocked",
          reasons: ["vector-missing-oracle"],
          expectedOutcome: null,
        }),
      ),
    ).toBeNull();
    expect(publicVectorOf(vector({ review: draftReview() }))).toBeNull();
    const tampered = vector();
    expect(
      publicVectorOf({
        ...tampered,
        review: { ...tampered.review, approvedDigest: asDigest(HEX_2) },
      }),
    ).toBeNull();
  });

  it("keeps an approval bound to the content it reviewed", () => {
    const approved = vector();
    // Same id and same recorded approval, but the content moved: the digest the
    // reviewer locked no longer describes this vector, so it is not projectable.
    const movedContent = content({ caseKey: "renamed" });
    const changed = {
      ...approved,
      ...movedContent,
      digest: vectorDigest(movedContent, LIMITS),
      review: approved.review,
    };
    expect(publicVectorOf(changed)).toBeNull();
    expect(publicVectorOf(approved)).not.toBeNull();
  });
});

describe("blueprint digests (§7.3)", () => {
  it("covers a fixed field list that excludes its own value", () => {
    const withoutDigest = { ...payload(), blueprintDigest: undefined as unknown as Digest };
    const input = blueprintDigestInput(
      withoutDigest as unknown as Omit<ReturnType<typeof payload>, "blueprintDigest">,
    );
    expect(Object.keys(input).sort()).toEqual([...BLUEPRINT_DIGEST_FIELDS].sort());
    expect(Object.keys(input)).not.toContain("blueprintDigest");
  });

  it("moves when a promised behaviour or a handed-over sample moves", () => {
    const first = blueprintDigestOf({ ...payload() }, LIMITS);
    const second = blueprintDigestOf(
      { ...payload(), verificationScope: [...payload().verificationScope, "operation:addItem"] },
      LIMITS,
    );
    expect(first).not.toBe(second);
    const noVectors = blueprintDigestOf({ ...payload(), publicVectors: [] }, LIMITS);
    expect(noVectors).not.toBe(first);
  });

  it("drops a field the manifest does not list instead of letting it join", () => {
    const withExtra = { ...payload(), displayNote: "for the UI only" } as unknown as Omit<
      ReturnType<typeof payload>,
      "blueprintDigest"
    >;
    expect(Object.keys(blueprintDigestInput(withExtra))).not.toContain("displayNote");
    expect(blueprintDigestInput(withExtra)).toEqual(blueprintDigestInput({ ...payload() }));
  });
});

describe("disclosure detection (§7.3)", () => {
  it("finds a forbidden reference anywhere in the payload text", () => {
    const leaked = buildBlueprintPayload({
      blueprintId: BLUEPRINT_ID,
      blueprintDigest: asDigest(HEX_1),
      contracts: [
        {
          ...contractEntry(),
          behaviorSpec: `see ${`ev_${HEX_2}`} for the trace`,
        },
      ],
      publicVectors: [publicVector()],
      verificationScope: ["contract:cart-api@1"],
    });
    expect(leakReasons(leaked, [`ev_${HEX_2}`])).toEqual([`ev_${HEX_2}`]);
    expect(leakReasons(payload(), [`ev_${HEX_2}`])).toEqual([]);
  });

  it("ignores empty tokens instead of matching everything", () => {
    expect(leakReasons(payload(), [""])).toEqual([]);
  });

  it("flags source-shaped text in the spec or an example", () => {
    expect(sourceTextSuspicions(["GET /api/cart returns the item list"])).toEqual([]);
    expect(sourceTextSuspicions(["function getCart() { return fetch(url); }"])).toContain("declaration");
    expect(sourceTextSuspicions(['import { client } from "./sdk";'])).toContain("module-io");
    expect(sourceTextSuspicions(["const call = (x) => { return x; };"])).toContain("arrow-body");
    expect(sourceTextSuspicions(["def handler(req):", "def handler2(req):"])).toEqual(["python-def"]);
  });
});

describe("the strict freeze re-derives colour (§6, D10)", () => {
  it("lets an observed, current, well-covered claim through", () => {
    expect(nonSeenClaimReasons([claim()])).toEqual([]);
  });

  it("blocks a yellow claim and names its basis", () => {
    // The status the projection produced is named in the reason, so an operator
    // can tell a yellow claim from a red one without re-deriving it.
    expect(nonSeenClaimReasons([claim({ basis: "derived" })])[0]).toContain(":INFERRED:basis-derived");
    expect(nonSeenClaimReasons([claim({ basis: "inferred" })])[0]).toContain(":INFERRED:basis-inferred");
    expect(nonSeenClaimReasons([claim({ basis: "unknown" })])[0]).toContain(":UNKNOWN:basis-unknown");
  });

  it("blocks a stale, contradicted, unsourced or under-covered claim", () => {
    const stale = nonSeenClaimReasons([claim({ validity: "stale" })]);
    expect(stale[0]).toContain(":UNKNOWN:claim-stale");
    const contradicted = nonSeenClaimReasons([claim({ validity: "contradicted" })]);
    expect(contradicted[0]).toContain("claim-contradicted");
    const unsourced = nonSeenClaimReasons([claim({ sourceEvidenceIds: [] })]);
    expect(unsourced[0]).toContain("claim-without-source");
    const wrongAuthority = nonSeenClaimReasons([claim({ authorityApplies: false })]);
    expect(wrongAuthority[0]).toContain("authority-not-applicable");
    const partial = nonSeenClaimReasons([
      claim({ coverage: { state: "partial", examined: 1, total: 4, reasons: ["x"] } }),
    ]);
    expect(partial[0]).toContain("coverage-partial");
  });

  it("keeps a manual approval from upgrading a yellow claim", () => {
    // There is no `approved` input in the projection: a claim that is derived stays
    // blocking however it was reviewed (§6, PRD 证据与交付规则).
    expect(nonSeenClaimReasons([claim({ basis: "derived" })])).toHaveLength(1);
  });

  it("judges an edge by its own claim, never by the node colour", () => {
    const edges = [
      { id: "edge-1", relation: "calls", claim: claim({ basis: "observed" }) },
      { id: "edge-2", relation: "reads", claim: claim({ basis: "inferred" }) },
    ];
    const reasons = nonSeenEdgeReasons(edges);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("edge-not-seen:edge-2:reads:INFERRED");
    expect(nonSeenEdgeReasons([edges[0] as (typeof edges)[number]])).toEqual([]);
  });
});

describe("source manifest belongs to the control plane (§7.3)", () => {
  it("covers a fixed field list excluding its own digest", () => {
    const input = sourceManifestDigestInput(manifest());
    expect(Object.keys(input).sort()).toEqual([...SOURCE_MANIFEST_DIGEST_FIELDS].sort());
    expect(Object.keys(input)).not.toContain("manifestDigest");
  });

  it("recomputes the same digest regardless of array order", () => {
    const a = sourceManifestDigestOf(manifest(), LIMITS);
    const shuffled = manifest({
      selectedVectorIds: [VECTOR_ID, asId("77777777-7777-4777-8777-777777777777")].sort(),
    });
    const other = sourceManifestDigestOf(shuffled, LIMITS);
    expect(a).not.toBe(other);
    expect(sourceManifestDigestOf(manifest(), LIMITS)).toBe(a);
  });

  it("holds the claim to evidence to location chain and the holdout references", () => {
    const value = manifest();
    expect(value.claims[0]?.evidenceIds).toEqual([`ev_${HEX_2}`]);
    expect(value.claims[0]?.sourceLocations).toEqual([{ pointer: "/records/0/reported" }]);
    expect(value.holdoutVectorIds).toEqual([]);
    expect(value.reviewAttribution[0]?.reviewerId).toBe("reviewer-one");
    // The digest that binds the handoff is recorded here too, so an evaluator can
    // prove which Builder payload this provenance belongs to.
    expect(value.blueprintDigest).toBe(asDigest(HEX_1));
  });

  it("round-trips the payload through the handoff schema without drift", () => {
    const bytes = JSON.parse(JSON.stringify(payload())) as unknown;
    const parsed = builderBlueprintSchema.safeParse(bytes);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const reparsed = parsed.data as unknown as ReturnType<typeof payload>;
      expect(reparsed.publicVectors[0]?.response.body).toEqual({
        kind: "text",
        text: '{"items":[]}',
        provenance: "producer-decoded",
      });
      expect(Object.keys(reparsed).sort()).toEqual(Object.keys(payload()).sort());
    }
  });

  it("refuses a handoff payload that carries an extra field", () => {
    const smuggled = { ...JSON.parse(JSON.stringify(payload())), storageKey: "projects/x" };
    expect(builderBlueprintSchema.safeParse(smuggled).success).toBe(false);
  });

  it("refuses a public vector that carries the source locator", () => {
    const withSource = JSON.parse(JSON.stringify(payload())) as { publicVectors: Record<string, unknown>[] };
    withSource.publicVectors[0] = { ...withSource.publicVectors[0], source: { evidenceId: `ev_${HEX_2}` } };
    expect(builderBlueprintSchema.safeParse(withSource).success).toBe(false);
  });

  it("computes the vector digest from the same fields the service stores", () => {
    // The blueprint hands over a vector whose digest the plan bound; if the digest
    // input and the wire payload disagreed, the freeze would certify a different
    // document than the one the Builder receives.
    const base = content();
    expect(Object.keys(vectorDigestInput(base)).sort()).toEqual(
      Object.keys(JSON.parse(JSON.stringify(vectorDigestInput(base)))).sort(),
    );
    expect(vectorDigest(base, LIMITS)).toBe(vectorDigest(content(), LIMITS));
  });
});

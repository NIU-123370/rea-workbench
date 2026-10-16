import { describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import {
  contractDigest,
  contractDigestInput,
  contractGateReasons,
  type ContractClaimFact,
  type ContractRevisionContent,
  type ContractVectorFact,
} from "../../packages/domain/contract.ts";
import {
  PLAN_CONTENT_FIELDS,
  deriveSelectedVectorIds,
  inventorySnapshotDigest,
  planDigest,
  planDigestInput,
  planGateReasons,
  type PlanContractFact,
  type PlanVectorFact,
  type VerificationPlanContent,
} from "../../packages/domain/plan.ts";
import { asId } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { contractRevisionContentSchema, verificationPlanContentSchema } from "../../packages/contracts/behaviors.ts";
import { parseStrict } from "../../packages/contracts/parse.ts";

// DESIGN §7.2 and §7.4 in the two gate functions that decide whether a promise
// can be frozen. The cases below are the ways a reviewer can make a denominator
// lie, in the order a reader would try them.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const HEX_1 = ("1" as const).repeat(64);
const HEX_2 = ("2" as const).repeat(64);
const TARGET = asId("33333333-3333-4333-8333-333333333333");
const CLAIM = asId("44444444-4444-4444-8444-444444444444");
const VECTOR_A = asId("55555555-5555-4555-8555-555555555555");
const VECTOR_B = asId("66666666-6666-4666-8666-666666666666");
const VECTOR_C = asId("77777777-7777-4777-8777-777777777777");
const PLAN_ID = asId("88888888-8888-4888-8888-888888888888");

const seenClaim: ContractClaimFact = {
  id: CLAIM,
  targetId: TARGET,
  validity: "current",
  basis: "observed",
  sourceEvidenceIds: ["ev_a"],
  authorityApplies: true,
  coverage: { state: "complete", examined: null, total: null, reasons: [] },
};

const inferredClaim: ContractClaimFact = {
  ...seenClaim,
  basis: "inferred",
};

const contradictedClaim: ContractClaimFact = {
  ...seenClaim,
  validity: "contradicted",
};

const usableVector: ContractVectorFact = {
  id: VECTOR_A,
  targetId: TARGET,
  snapshotDigest: asDigest(HEX_1),
  caseKey: "cart-ok",
  operationId: "getCart",
  eligibility: "usable",
  reviewStatus: "approved",
};

function content(overrides: Partial<ContractRevisionContent> = {}): ContractRevisionContent {
  return {
    id: asId("99999999-9999-4999-8999-999999999999"),
    contractKey: "cart-api",
    revision: 1,
    targetId: TARGET,
    scope: {
      snapshotDigest: asDigest(HEX_1),
      operationIds: ["getCart"],
      excludedBehaviors: [],
    },
    behaviorSpec: "GET /api/cart returns the item list",
    inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    httpOperations: [
      {
        operationId: "getCart",
        method: "GET",
        path: "/api/cart",
        requestMediaType: null,
        responses: [
          {
            status: 200,
            mediaType: "application/json",
            schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
          },
        ],
      },
    ],
    errorCases: [],
    limitations: [],
    unknowns: [],
    sourceClaimIds: [CLAIM],
    requiredCases: [{ caseKey: "cart-ok", claimId: CLAIM, kind: "success", vectorIds: [VECTOR_A] }],
    ...overrides,
  };
}

function gateReasons(
  overrides: Partial<ContractRevisionContent> = {},
  options: {
    vectors?: readonly ContractVectorFact[];
    claims?: readonly ContractClaimFact[];
    requireComplete?: boolean;
  } = {},
): string[] {
  return contractGateReasons({
    content: content(overrides),
    vectors: options.vectors ?? [usableVector],
    claims: options.claims ?? [seenClaim],
    requireComplete: options.requireComplete ?? false,
  });
}

describe("contract gate (DESIGN §7.2)", () => {
  it("passes a contract whose operations, claims and samples all line up", () => {
    expect(gateReasons()).toEqual([]);
  });

  it("refuses a required case citing a claim the contract does not own", () => {
    const other = asId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(gateReasons({ requiredCases: [{ caseKey: "cart-ok", claimId: other, kind: "success", vectorIds: [VECTOR_A] }] })).toContain(
      "required-case-claim-outside-source:cart-ok",
    );
  });

  it("refuses a sample borrowed from another operation", () => {
    expect(
      gateReasons({}, { vectors: [{ ...usableVector, operationId: "postCart" }] }),
    ).toContain("vector-operation-out-of-scope:cart-ok:" + VECTOR_A);
  });

  it("refuses an operation with no required case at all", () => {
    expect(
      gateReasons({
        scope: { snapshotDigest: asDigest(HEX_1), operationIds: ["getCart", "deleteCart"], excludedBehaviors: [] },
        httpOperations: [
          ...content().httpOperations,
          {
            operationId: "deleteCart",
            method: "DELETE",
            path: "/api/cart",
            requestMediaType: null,
            responses: [{ status: 204, mediaType: null, schema: { type: "null" } }],
          },
        ],
      }),
    ).toContain("operation-without-required-case:deleteCart");
  });

  it("refuses an operation in scope with no HTTP binding", () => {
    expect(
      gateReasons({
        scope: { snapshotDigest: asDigest(HEX_1), operationIds: ["getCart", "ghost"], excludedBehaviors: [] },
      }),
    ).toContain("operation-without-http-binding:ghost");
  });

  it("refuses a schema that does not declare the 2020-12 dialect", () => {
    expect(gateReasons({ inputSchema: { type: "object" } })).toContain("schema-inputSchema-dialect-not-2020-12");
    expect(gateReasons({ outputSchema: true })).toContain("schema-outputSchema-not-an-object");
  });

  it("refuses a sample whose caseKey or snapshot does not match the contract", () => {
    expect(gateReasons({}, { vectors: [{ ...usableVector, caseKey: "other" }] })).toContain(
      `vector-scope-mismatch:cart-ok:${VECTOR_A}`,
    );
    expect(gateReasons({}, { vectors: [{ ...usableVector, snapshotDigest: asDigest(HEX_2) }] })).toContain(
      `vector-scope-mismatch:cart-ok:${VECTOR_A}`,
    );
  });

  it("only demands approved, usable samples when the freeze asks", () => {
    const draftVector = { ...usableVector, reviewStatus: "draft" as const, eligibility: "blocked" as const };
    expect(gateReasons({}, { vectors: [draftVector] })).toEqual([]);
    const reasons = gateReasons({}, { vectors: [draftVector], requireComplete: true });
    expect(reasons).toContain(`required-vector-not-approved:${VECTOR_A}`);
    expect(reasons).toContain(`required-vector-blocked:${VECTOR_A}`);
  });

  it("refuses a required case with no sample once completeness is required", () => {
    expect(gateReasons({ requiredCases: [{ caseKey: "cart-ok", claimId: CLAIM, kind: "success", vectorIds: [] }] })).toContain(
      "required-case-without-vector:cart-ok",
    );
  });

  it("blocks a non-SEEN source claim only for the freeze", () => {
    expect(gateReasons({}, { claims: [inferredClaim] })).toEqual([]);
    expect(gateReasons({}, { claims: [inferredClaim], requireComplete: true })).toContain(
      `source-claim-not-seen:${CLAIM}:inferred`,
    );
    expect(gateReasons({}, { claims: [contradictedClaim], requireComplete: true })).toContain(
      `source-claim-not-seen:${CLAIM}:unknown`,
    );
  });

  it("computes the same digest for an equivalent contract read back from disk", () => {
    const first = content();
    const roundParsed = parseStrict(contractRevisionContentSchema, contractDigestInput(first));
    if (!roundParsed.ok) throw new Error(JSON.stringify(roundParsed.error));
    const round = roundParsed.value;
    // Re-branding is the service's job (`contractContentOf`); here the round trip
    // only has to prove the schema accepts every digested field.
    const rebuilt = { ...first, scope: content().scope, httpOperations: round.httpOperations, requiredCases: first.requiredCases };
    expect(contractDigest(rebuilt, LIMITS)).toBe(contractDigest(first, LIMITS));
  });

  it("moves the digest when a promise moves", () => {
    expect(contractDigest(content({ behaviorSpec: "GET /api/cart may return a subset" }), LIMITS)).not.toBe(
      contractDigest(content(), LIMITS),
    );
  });
});

function planVector(
  id: Id,
  overrides: Partial<PlanVectorFact> = {},
): PlanVectorFact {
  return {
    id,
    targetId: TARGET,
    snapshotDigest: asDigest(HEX_1),
    evidenceId: `ev_${id.slice(0, 8)}`,
    caseKey: "cart-ok",
    eligibility: "usable",
    reasons: [],
    reviewStatus: "approved",
    replacesId: null,
    digest: asDigest(HEX_2),
    ...overrides,
  };
}

function planContract(overrides: Partial<PlanContractFact> = {}): PlanContractFact {
  return {
    id: asId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    targetId: TARGET,
    snapshotDigest: asDigest(HEX_1),
    reviewStatus: "approved",
    requiredCases: [{ caseKey: "cart-ok", claimId: CLAIM, kind: "success", vectorIds: [VECTOR_A] }],
    ...overrides,
  };
}

function planContent(overrides: Partial<VerificationPlanContent> = {}): VerificationPlanContent {
  const contract = planContract();
  return {
    id: PLAN_ID,
    targetId: TARGET,
    snapshotDigest: asDigest(HEX_1),
    contractRevisionIds: [contract.id],
    graphRevision: 4,
    inventoryRevision: 7,
    inventoryDigest: inventorySnapshotDigest([{ id: VECTOR_A, digest: asDigest(HEX_2) }]),
    selectedVectorIds: deriveSelectedVectorIds(contract.requiredCases),
    excludedVectors: [],
    ...overrides,
  };
}

function planReasons(
  overrides: Partial<VerificationPlanContent> = {},
  options: {
    inventory?: readonly PlanVectorFact[];
    contracts?: readonly PlanContractFact[];
    contradicting?: readonly string[];
    requireComplete?: boolean;
  } = {},
): string[] {
  const content = planContent(overrides);
  return planGateReasons({
    content,
    inventory: options.inventory ?? [planVector(VECTOR_A)],
    contracts: options.contracts ?? [planContract()],
    contradictingEvidenceIds: options.contradicting ?? [],
    requireComplete: options.requireComplete ?? false,
  });
}

describe("plan gate (DESIGN §7.4)", () => {
  it("derives the denominator from the approved contracts, sorted and unique", () => {
    const cases = [
      { caseKey: "b", claimId: CLAIM, kind: "success" as const, vectorIds: [VECTOR_B, VECTOR_A] },
      { caseKey: "a", claimId: CLAIM, kind: "edge" as const, vectorIds: [VECTOR_A] },
    ];
    expect(deriveSelectedVectorIds(cases)).toEqual([VECTOR_A, VECTOR_B].sort());
  });

  it("refuses a plan whose selected set is not that union", () => {
    const contract = planContract();
    expect(
      planReasons(
        { selectedVectorIds: [] },
        { inventory: [planVector(VECTOR_A), planVector(VECTOR_B, { caseKey: "b" })] },
      ),
    ).toContain("selected-not-required-union");
    expect(planContent().selectedVectorIds).toEqual(contract.requiredCases[0]?.vectorIds);
  });

  it("refuses exclusions that leave an inventory entry unaccounted", () => {
    expect(planReasons({}, { inventory: [planVector(VECTOR_A), planVector(VECTOR_B)] })).toContain(
      `inventory-not-exhausted:${VECTOR_B}`,
    );
  });

  it("refuses excluding a vector that is also required", () => {
    expect(
      planReasons({
        excludedVectors: [
          {
            vectorId: VECTOR_A,
            reasonCode: "outside-scope",
            reason: "not promised",
            excludedBehavior: "pagination",
            supersededBy: null,
          },
        ],
      }),
    ).toContain(`vector-both-selected-and-excluded:${VECTOR_A}`);
  });

  it("refuses using a blocking reason as a scope statement", () => {
    const blocked = planVector(VECTOR_B, { eligibility: "blocked", reasons: ["vector-missing-oracle"] });
    const contract = planContract({
      requiredCases: [{ caseKey: "cart-ok", claimId: CLAIM, kind: "success", vectorIds: [VECTOR_A] }],
    });
    expect(
      planReasons(
        {
          excludedVectors: [
            {
              vectorId: VECTOR_B,
              reasonCode: "outside-scope",
              reason: "declared out of scope",
              excludedBehavior: "vector-missing-oracle",
              supersededBy: null,
            },
          ],
        },
        { inventory: [planVector(VECTOR_A), blocked], contracts: [contract] },
      ),
    ).toContain(`blocked-is-not-an-exclusion:${VECTOR_B}`);
  });

  it("refuses excluding the counter-evidence of a promised claim", () => {
    const contradicting = planVector(VECTOR_B, { evidenceId: "ev_bad" });
    expect(
      planReasons(
        {
          excludedVectors: [
            {
              vectorId: VECTOR_B,
              reasonCode: "outside-scope",
              reason: "not promised",
              excludedBehavior: "caching",
              supersededBy: null,
            },
          ],
        },
        {
          inventory: [planVector(VECTOR_A), contradicting],
          contracts: [planContract()],
          contradicting: ["ev_bad"],
        },
      ),
    ).toContain(`cannot-exclude-contradicting-evidence:${VECTOR_B}`);
  });

  it("requires a superseded exclusion to name the selected leaf that replaces it", () => {
    const successor = planVector(VECTOR_B, { replacesId: VECTOR_A, caseKey: "cart-ok" });
    const contract = planContract({
      requiredCases: [{ caseKey: "cart-ok", claimId: CLAIM, kind: "success", vectorIds: [VECTOR_B] }],
    });
    const exclusion = {
      vectorId: VECTOR_A,
      reasonCode: "superseded" as const,
      reason: "oracle added",
      excludedBehavior: "none",
      supersededBy: VECTOR_B,
    };
    expect(
      planReasons(
        {
          excludedVectors: [exclusion],
          selectedVectorIds: [VECTOR_B],
          inventoryDigest: inventorySnapshotDigest([
            { id: VECTOR_A, digest: asDigest(HEX_2) },
            { id: VECTOR_B, digest: asDigest(HEX_2) },
          ]),
        },
        { inventory: [planVector(VECTOR_A), successor], contracts: [contract] },
      ),
    ).toEqual([]);

    const brokenLink = planReasons(
      {
        excludedVectors: [{ ...exclusion, supersededBy: VECTOR_C }],
        selectedVectorIds: [VECTOR_B],
      },
      {
        inventory: [
          planVector(VECTOR_A),
          successor,
          planVector(VECTOR_C, { replacesId: null, caseKey: "other" }),
        ],
        contracts: [contract],
      },
    );
    expect(brokenLink).toContain(`superseded-link-mismatch:${VECTOR_A}`);
  });

  it("refuses a plan built on an unapproved or foreign contract", () => {
    expect(planReasons({}, { contracts: [planContract({ reviewStatus: "draft" })] })).toContain(
      `contract-not-approved:${planContract().id}`,
    );
    // Each reason is namespaced with the contract id, so the assertion is on the
    // joined list rather than on one exact element.
    expect(planReasons({}, { contracts: [planContract({ targetId: asId("cccccccc-cccc-4ccc-8ccc-cccccccccccc") })] }).join(",")).toContain(
      "contract-target-mismatch",
    );
  });

  it("keeps a blocked case in the denominator and refuses PASS eligibility", () => {
    const reasons = planReasons(
      {},
      { inventory: [planVector(VECTOR_A, { eligibility: "blocked", reasons: ["vector-missing-oracle"] })], requireComplete: true },
    );
    expect(reasons).toContain(`selected-vector-blocked:${VECTOR_A}`);
    expect(planReasons({}, { requireComplete: false })).toEqual([]);
  });

  it("refuses selecting a chain parent while its leaf stays unexcluded", () => {
    const leaf = planVector(VECTOR_B, { replacesId: VECTOR_A });
    const contract = planContract({
      requiredCases: [{ caseKey: "cart-ok", claimId: CLAIM, kind: "success", vectorIds: [VECTOR_A] }],
    });
    expect(
      planReasons(
        {
          inventoryDigest: inventorySnapshotDigest([
            { id: VECTOR_A, digest: asDigest(HEX_2) },
            { id: VECTOR_B, digest: asDigest(HEX_2) },
          ]),
        },
        { inventory: [planVector(VECTOR_A), leaf], contracts: [contract] },
      ),
    ).toContain(`superseded-version-selected-leaf-left-out:${VECTOR_A}`);
  });

  it("pins the inventory snapshot by content, not by count", () => {
    const before = inventorySnapshotDigest([{ id: VECTOR_A, digest: asDigest(HEX_1) }]);
    const after = inventorySnapshotDigest([
      { id: VECTOR_A, digest: asDigest(HEX_2) },
    ]);
    expect(before).not.toBe(after);
    expect(before).toBe(inventorySnapshotDigest([{ id: VECTOR_A, digest: asDigest(HEX_1) }]));
  });

  it("digests a plan without its own digest or review fields", () => {
    const input = planDigestInput(planContent());
    expect(Object.keys(input).sort()).toEqual([...PLAN_CONTENT_FIELDS].sort());
    expect(Object.keys(input)).not.toContain("digest");
    expect(Object.keys(input)).not.toContain("review");
  });

  it("round-trips a plan through the wire schema without moving its digest", () => {
    const content = planContent({
      excludedVectors: [
        {
          vectorId: VECTOR_B,
          reasonCode: "outside-scope",
          reason: "not promised",
          excludedBehavior: "caching",
          supersededBy: null,
        },
      ],
      inventoryDigest: inventorySnapshotDigest([
        { id: VECTOR_A, digest: asDigest(HEX_2) },
        { id: VECTOR_B, digest: asDigest(HEX_2) },
      ]),
    });
    const parsedPlan = parseStrict(verificationPlanContentSchema, planDigestInput(content));
    if (!parsedPlan.ok) throw new Error(JSON.stringify(parsedPlan.error));
    const wire = parsedPlan.value as unknown as {
      id: string;
      snapshotDigest: string;
      inventoryDigest: string;
      contractRevisionIds: string[];
      selectedVectorIds: string[];
    };
    expect(planDigest({ ...content, contractRevisionIds: wire.contractRevisionIds.map((id) => asId(id)) }, LIMITS)).toBe(
      planDigest(content, LIMITS),
    );
    expect(new Set(wire.selectedVectorIds).size).toBe(wire.selectedVectorIds.length);
  });

  it("treats a different snapshot as a different promise", () => {
    expect(planReasons({}, { contracts: [planContract({ snapshotDigest: asDigest("3".repeat(64) as Digest) })] }).join(",")).toContain(
      "contract-snapshot-mismatch",
    );
  });
});

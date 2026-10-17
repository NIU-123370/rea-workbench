import { describe, expect, it } from "vitest";
import { z } from "zod";

import { HTTP_STATUS_BY_ERROR_CODE, NAMED_ERROR_CODES, SAFE_DETAIL_KEYS, apiErrorBodySchema, makeApiError, safeFailureDetails } from "../../packages/contracts/errors.ts";

import { jobRecordSchema } from "../../packages/contracts/jobs.ts";
import { EVENT_TYPES, committedEventSchema, eventPayloadSchema } from "../../packages/contracts/events.ts";
import { healthResponseSchema, effectiveProfileSchema } from "../../packages/contracts/health.ts";
import { browserActionKinds, browserActionSchema, captureTaskSchema, inspectTaskSchema, locatorKinds, locatorSchema, waitStates } from "../../packages/contracts/tasks.ts";
import { excludedVectorSchema, planBuildHttpRequestSchema } from "../../packages/contracts/behaviors.ts";
import { EXCLUSION_REASON_CODES } from "../../packages/domain/inventory.ts";
import { bootstrapExchangeSchema, currentSessionSchema } from "../../packages/contracts/session.ts";
import { createUrlTargetRequestSchema, importFieldsSchema, pendingTargetSchema, pagedSchema, projectSummarySchema, targetViewSchema } from "../../packages/contracts/resources.ts";
import { parseStrict } from "../../packages/contracts/parse.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const HEX64 = "a".repeat(64);
const EV_ID = `ev_${HEX64}`;

const job = {
  id: ID,
  kind: "inspect" as const,
  state: "queued" as const,
  cleanupState: "pending" as const,
  deadlineAt: "2026-10-16T00:00:00.000Z",
  retryAt: null,
  cleanupRetryAt: null,
  resultRef: null,
  error: null,
};

function rejects(schema: Parameters<typeof parseStrict>[0], input: unknown): void {
  expect(parseStrict(schema, input).ok).toBe(false);
}
function accepts(schema: Parameters<typeof parseStrict>[0], input: unknown): void {
  const result = parseStrict(schema, input);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  expect(result.ok).toBe(true);
}

// A vocabulary can be checked against a union in one direction only by parsing samples, which cannot
// see a branch nobody listed. The union's published JSON Schema lists every branch, so reading the
// discriminators from it compares the two sets as sets - and is the only form that goes red when the
// contract grows a kind the composer has no row for.
function branchConst(branch: unknown, key: string): unknown {
  return (branch as { properties?: { [name: string]: { const?: unknown } | undefined } }).properties?.[key]?.const;
}
// The discriminator's *name* is a parameter, not an assumption: `browserActionSchema` discriminates on
// `kind` while §8's exclusion union discriminates on `reasonCode`, and a helper that only looked at the
// first would silently return ["undefined","undefined"] for the second - a green list of nothing.
function discriminatorNames(branches: unknown[], key: string): string[] {
  return branches.map((branch) => String(branchConst(branch, key)));
}
function enumOf(branch: unknown, key: string): string[] {
  const values = (branch as { properties?: { [name: string]: { enum?: unknown } | undefined } }).properties?.[key]?.enum;
  return Array.isArray(values) ? values.map((value) => String(value)) : [];
}

describe("strict parsing (DESIGN §4, §8)", () => {
  it("rejects extra fields instead of ignoring them", () => {
    rejects(jobRecordSchema, { ...job, unexpected: 1 });
    rejects(captureTaskSchema, {
      kind: "capture",
      profileId: "p",
      scenario: { startUrl: "http://127.0.0.1:8080", actions: [] },
      network: { requestBody: false, responseBody: false, headerValues: false },
      script: "page.click('#buy')",
    });
    rejects(locatorSchema, { kind: "css", value: ".btn" });
  });

  it("reports which field failed, without echoing the value", () => {
    const result = parseStrict(projectSummarySchema, {
      id: "not-a-uuid",
      name: "",
      graphRevision: -1,
      inventoryRevision: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.error.issues.map((issue) => issue.path);
    expect(paths).toContain("id");
    expect(paths).toContain("name");
    expect(JSON.stringify(result.error)).not.toContain("not-a-uuid");
  });
});

describe("named error codes (DESIGN §8)", () => {
  it("maps every named code to a status", () => {
    expect(NAMED_ERROR_CODES).toHaveLength(16);
    for (const code of NAMED_ERROR_CODES) {
      expect(HTTP_STATUS_BY_ERROR_CODE[code]).toBeGreaterThanOrEqual(400);
    }
    expect(HTTP_STATUS_BY_ERROR_CODE.REVISION_CONFLICT).toBe(409);
    expect(HTTP_STATUS_BY_ERROR_CODE.SENSITIVE_CONTENT_BLOCKED).toBe(422);
    expect(HTTP_STATUS_BY_ERROR_CODE.REA_CONTRACT_MISMATCH).toBe(503);
  });

  it("accepts only the strict error body shape", () => {
    accepts(apiErrorBodySchema, {
      error: makeApiError("INVALID_INPUT", {
        message: "field required",
        retryable: false,
        requestId: "req_1",
      }),
    });
    rejects(apiErrorBodySchema, { error: { code: "MYSTERIOUS", message: "x" } });
  });
});

describe("JobRecord calendar-valid times (issue #4)", () => {
  it("refuses an impossible deadline that merely matches the shape", () => {
    rejects(jobRecordSchema, { ...job, deadlineAt: "2026-02-30T00:00:00Z" });
    rejects(jobRecordSchema, { ...job, retryAt: "2026-13-01T00:00:00Z" });
    rejects(jobRecordSchema, { ...job, deadlineAt: "2026-10-16 00:00:00" });
  });

  it("keeps sub-millisecond precision and explicit nulls legal", () => {
    accepts(jobRecordSchema, { ...job, deadlineAt: "2026-10-16T00:00:00.123456Z" });
    accepts(jobRecordSchema, { ...job, deadlineAt: null });
    rejects(jobRecordSchema, { ...job, cleanupRetryAt: undefined });
    rejects(jobRecordSchema, { ...job, error: { code: "INVALID_INPUT" } });
  });

  it("only allows the §11 states and four kinds", () => {
    accepts(jobRecordSchema, { ...job, state: "interrupted", cleanupState: "failed" });
    rejects(jobRecordSchema, { ...job, state: "paused" });
    rejects(jobRecordSchema, { ...job, kind: "delete" });
  });
});

describe("committed events (DESIGN §8.1)", () => {
  it("lists exactly the ten committed types", () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "contract.reviewed",
        "evidence.committed",
        "graph.updated",
        "job.updated",
        "plan.reviewed",
        "report.stale",
        "resource.cleanup_failed",
        "verification.completed",
        "vector.created",
        "vector.reviewed",
      ].sort(),
    );
  });

  it("carries references and states, never a body", () => {
    accepts(committedEventSchema, {
      seq: 7,
      projectId: ID,
      type: "job.updated",
      aggregateId: ID,
      createdAt: "2026-10-16T00:00:00.000Z",
      payload: { state: "running", retryAt: null, deadlineAt: "2026-10-16T00:05:00.000Z" },
    });
    rejects(committedEventSchema, {
      seq: 7,
      projectId: ID,
      type: "job.updated",
      aggregateId: ID,
      createdAt: "2026-10-16T00:00:00.000Z",
      payload: { evidenceText: "GET /api/cart cookie: session=abc" },
    });
    rejects(committedEventSchema, {
      seq: 7,
      projectId: ID,
      type: "job.deleted",
      aggregateId: ID,
      createdAt: "2026-10-16T00:00:00.000Z",
      payload: {},
    });
    expect(parseStrict(eventPayloadSchema, { aggregateId: EV_ID }).ok).toBe(false);
  });
});

describe("task instruction surface (DESIGN §8)", () => {
  it("accepts only the named browser actions", () => {
    accepts(captureTaskSchema, {
      kind: "capture",
      profileId: "web-fixture",
      scenario: {
        startUrl: "http://127.0.0.1:4110",
        actions: [
          { kind: "click", locator: { kind: "role", role: "button", name: "Checkout" } },
          { kind: "fill", locator: { kind: "testId", value: "qty" }, value: "2" },
          { kind: "waitFor", locator: { kind: "testId", value: "receipt" }, state: "visible" },
        ],
      },
      network: { requestBody: true, responseBody: true, headerValues: false },
      sensitiveValues: ["hunter2"],
    });
    rejects(captureTaskSchema, {
      kind: "capture",
      profileId: "p",
      scenario: { startUrl: "http://127.0.0.1", actions: [{ kind: "eval", script: "1+1" }] },
      network: { requestBody: false, responseBody: false, headerValues: false },
    });
    // A non-loopback startUrl is still shape-valid; authorisation is checked
    // against the target scope by the application, not by this schema.
    rejects(captureTaskSchema, {
      kind: "capture",
      profileId: "p",
      scenario: { startUrl: "not-a-url", actions: [] },
      network: { requestBody: false, responseBody: false, headerValues: false },
    });
  });

  // The two vocabularies the composer renders rows from and the two the union accepts have to be one
  // set, in both directions. Asserting only "each listed kind parses" would leave a branch the domain
  // does not list alive on the wire - which is the drift §3 forbids, and the page would then be able to
  // send a kind it can never show. So the comparison is by value against the union's own discriminators.
  it("accepts exactly the action and locator kinds the domain lists (§8 白名单, #58)", () => {
    expect(discriminatorNames(z.toJSONSchema(browserActionSchema, { io: "input" }).oneOf ?? [], "kind")).toEqual([...browserActionKinds]);
    expect(discriminatorNames(z.toJSONSchema(locatorSchema, { io: "input" }).oneOf ?? [], "kind")).toEqual([...locatorKinds]);
    // `waitFor`'s observed state is the third vocabulary. It lives inside one branch rather than as a
    // discriminator, so it is read from the same projection rather than trusted from the enum object.
    const waitForBranch = (z.toJSONSchema(browserActionSchema, { io: "input" }).oneOf ?? []).find((branch) => branchConst(branch, "kind") === "waitFor");
    expect(enumOf(waitForBranch, "state")).toEqual([...waitStates]);
  });

  // §7.4's two exclusion claims and §8 line 289's body are the same reason this page's composer is
  // pinned against the contract: the screen offers the codes from `domain/inventory.ts`, and a third
  // name on either side would be an exclusion the door refuses or a choice the form never shows.
  it("takes the exclusion codes from the domain list, and the plan body from §8's five names", () => {
    expect(discriminatorNames(z.toJSONSchema(excludedVectorSchema, { io: "input" }).oneOf ?? [], "reasonCode")).toEqual([...EXCLUSION_REASON_CODES]);
    const fields = z.toJSONSchema(planBuildHttpRequestSchema, { io: "input" }).required as string[];
    expect([...fields].sort()).toEqual(["contractRevisionIds", "exclusions", "expectedInventoryRevision", "snapshotDigest", "targetId"]);
  });

  it("keeps inspect scopes and claim references narrow", () => {
    accepts(inspectTaskSchema, { kind: "inspect", claimIds: [], question: "哪些请求缺正文", scope: "static" });
    accepts(inspectTaskSchema, { kind: "inspect", claimIds: [ID], question: "q", scope: "captured-runtime" });
    rejects(inspectTaskSchema, { kind: "inspect", claimIds: ["/tmp/har.har"], question: "q", scope: "static" });
    rejects(inspectTaskSchema, { kind: "inspect", claimIds: [], question: "", scope: "attach-gdb" });
  });
});

describe("health and profiles (DESIGN §14, D31)", () => {
  const profile = {
    id: "web-fixture",
    schemaVersion: 1,
    reaPackageDigest: HEX64,
    browserImageDigest: HEX64,
    browserVersion: "141.0.7390.55",
    limits: {
      cpuCores: 2,
      memoryBytes: 1073741824,
      pids: 128,
      diskBytes: 4294967296,
      maxExpandedBytes: 134217728,
      queueWaitMs: 60000,
      timeoutMs: 30000,
    },
    networkPolicyId: "deny-all",
    available: false,
    unavailableReasons: ["sandbox_unavailable"],
  };

  it("refuses host paths and entrypoints in the health payload", () => {
    accepts(effectiveProfileSchema, profile);
    rejects(effectiveProfileSchema, { ...profile, reaContainerEntrypoint: "/opt/rea/scripts/rea.mjs" });
    rejects(effectiveProfileSchema, { ...profile, root_path: "/home/operator/rea" });
    rejects(healthResponseSchema, {
      status: "ready",
      schemaVersion: 1,
      reaIdentity: { packageVersion: "6.4.0", catalogDigest: HEX64, alignment: "aligned" },
      capabilities: ["har-import"],
      effectiveProfiles: [profile],
      bootstrapToken: "never-here",
    });
  });

  it("keeps limits positive where a zero would disable the ceiling", () => {
    rejects(effectiveProfileSchema, { ...profile, limits: { ...profile.limits, memoryBytes: 0 } });
    accepts(effectiveProfileSchema, { ...profile, limits: { ...profile.limits, queueWaitMs: 0 } });
    rejects(healthResponseSchema, {
      status: "buffering",
      schemaVersion: 1,
      reaIdentity: null,
      capabilities: [],
      effectiveProfiles: [],
    });
  });
});

describe("session and project surfaces (DESIGN §8)", () => {
  it("does not let a caller declare its own role", () => {
    accepts(currentSessionSchema, {
      reviewerId: ID,
      csrfToken: "tok",
      expiresAt: "2026-10-16T01:00:00.000Z",
      role: "local-controller",
    });
    rejects(currentSessionSchema, {
      reviewerId: ID,
      csrfToken: "tok",
      expiresAt: "2026-10-16T01:00:00.000Z",
      role: "builder",
    });
    rejects(bootstrapExchangeSchema, { bootstrapToken: "" });
    rejects(bootstrapExchangeSchema, { bootstrapToken: "t", role: "evaluator" });
  });

  it("keeps an uncaptured URL target without a snapshot", () => {
    accepts(pendingTargetSchema, { id: ID, kind: "url", snapshotDigest: null, identityReason: "not-captured" });
    rejects(pendingTargetSchema, { id: ID, kind: "url", snapshotDigest: HEX64, identityReason: "x" });
    accepts(createUrlTargetRequestSchema, { kind: "url", url: "https://example.test/cart" });
    rejects(createUrlTargetRequestSchema, { kind: "har", url: "https://example.test" });
  });

  it("refuses an ASAR sensitive declaration instead of pretending support", () => {
    accepts(importFieldsSchema, { kind: "har", sensitiveValues: ["hunter2"] });
    accepts(importFieldsSchema, { kind: "asar" });
    accepts(importFieldsSchema, { kind: "har", deadlineAt: "2026-10-16T00:30:00.000Z" });
    rejects(importFieldsSchema, { kind: "exe" });
    rejects(importFieldsSchema, { kind: "har", deadlineAt: "2026-02-30T00:00:00Z" });
  });

  it("pages with server-minted cursors and keeps evidence ids upstream-shaped", () => {
    accepts(pagedSchema(projectSummarySchema), {
      items: [{ id: ID, name: "cart", graphRevision: 0, inventoryRevision: 0 }],
      nextCursor: null,
    });
    rejects(pagedSchema(projectSummarySchema), { items: [], nextCursor: null, total: 0 });
    accepts(targetViewSchema, {
      id: ID,
      kind: "har",
      sourceSha256: HEX64,
      snapshotDigest: HEX64,
      identityReason: null,
      evidenceIds: [EV_ID],
      importJobId: ID,
    });
    rejects(targetViewSchema, {
      id: ID,
      kind: "har",
      sourceSha256: HEX64,
      snapshotDigest: HEX64,
      identityReason: null,
      evidenceIds: ["evidence-3"],
      importJobId: ID,
    });
  });
});

// What a refusal is allowed to say beyond its reason code (§8's ApiError.details, §12.1).
//
// The rule has two conditions and the test holds both up separately: a key must be declared,
// and its value must be a number or a boolean. Either half alone would be the wrong rule -
// names alone would let `caseKey` carry whatever string a caller typed, and types alone would
// hand every future numeric detail an automatic right to leave the process.

describe("safeFailureDetails (§12.1)", () => {
  it("passes declared keys whose value is a number or a boolean", () => {
    expect(
      safeFailureDetails({ byteLength: 1048577, limit: 1048576, maxLimit: 200, retryable: true, attempt: 3 }),
    ).toEqual({ byteLength: 1048577, limit: 1048576, maxLimit: 200, retryable: true, attempt: 3 });
  });

  it("passes every name on the list, so undeclaring one is a failing test", () => {
    // Derived from the list itself rather than written out a second time: dropping a key from
    // the contract then stops passing at the boundary, which is the red test that claim needs.
    const every = Object.fromEntries(SAFE_DETAIL_KEYS.map((key) => [key, 1]));
    expect(Object.keys(safeFailureDetails(every)).sort()).toEqual([...SAFE_DETAIL_KEYS].sort());
    expect(SAFE_DETAIL_KEYS.length).toBeGreaterThan(0);
  });

  it("drops a key nobody declared, even when its value is a harmless number", () => {
    const safe = safeFailureDetails({ internalRowId: 7, secretCount: 2, limit: 50 });
    expect(safe).toEqual({ limit: 50 });
  });

  it("drops a declared key whose value is text, a list or an object", () => {
    // `caseKey`/`reasons`/`issues` are the shapes that would carry a caller's own string or
    // a holdout identifier out of the process if the name alone decided.
    expect(safeFailureDetails({ caseKey: "cart-add", reasons: ["a"], issues: [{ path: "x" }], limit: "50" })).toEqual({});
    expect(safeFailureDetails({ limit: null, byteLength: undefined, seq: [1] })).toEqual({});
  });

  it("treats a non-object payload as nothing safe rather than as a surprise", () => {
    expect(safeFailureDetails({})).toEqual({});
    // The signature takes a record; the callers that could hand it anything are the ones
    // that parsed JSON, so the function must not throw on the shapes they can produce.
    expect(safeFailureDetails({ nested: { limit: 1 }, limit: 2 })).toEqual({ limit: 2 });
  });

  it("is idempotent, because both ends of the RPC socket apply this same list", () => {
    const once = safeFailureDetails({ limit: 200, reasons: ["with-held"] });
    expect(safeFailureDetails(once)).toEqual(once);
  });
});

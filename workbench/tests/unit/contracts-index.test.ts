import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  apiErrorBodySchema,
  httpStatusFor,
} from "../../packages/contracts/errors.ts";
import { jobRecordSchema } from "../../packages/contracts/jobs.ts";
import { committedEventSchema } from "../../packages/contracts/events.ts";
import { healthResponseSchema } from "../../packages/contracts/health.ts";
import { bootstrapExchangeSchema, currentSessionSchema } from "../../packages/contracts/session.ts";
import { captureTaskSchema, inspectTaskSchema } from "../../packages/contracts/tasks.ts";
import { importFieldsSchema, pendingTargetSchema } from "../../packages/contracts/resources.ts";
import { parseStrict } from "../../packages/contracts/parse.ts";

// DESIGN §8 declares one contract source so DTOs, OpenAPI and clients cannot
// drift. The guard against drift that a reviewer can actually check is that
// every file in this module publishes named schemas — a hard-coded list would
// silently omit the next file added here.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONTRACTS_DIR = path.join(ROOT, "packages/contracts");

// `rea-evidence.ts` mirrors the upstream envelope and is delivered on #5.
const EXCLUDED = ["rea-evidence.ts"];

const HEX = "a".repeat(64);
const ID = "11111111-1111-4111-8111-111111111111";

const SPEC_NAMED_SCHEMAS: Record<string, { file: string; name: string }> = {
  apiErrorBodySchema: { file: "errors.ts", name: "apiErrorBodySchema" },
  jobRecordSchema: { file: "jobs.ts", name: "jobRecordSchema" },
  committedEventSchema: { file: "events.ts", name: "committedEventSchema" },
  healthResponseSchema: { file: "health.ts", name: "healthResponseSchema" },
  bootstrapExchangeSchema: { file: "session.ts", name: "bootstrapExchangeSchema" },
  captureTaskSchema: { file: "tasks.ts", name: "captureTaskSchema" },
  inspectTaskSchema: { file: "tasks.ts", name: "inspectTaskSchema" },
  importFieldsSchema: { file: "resources.ts", name: "importFieldsSchema" },
};

function contractFiles(): string[] {
  return readdirSync(CONTRACTS_DIR)
    .filter((name) => name.endsWith(".ts") && !EXCLUDED.includes(name))
    .sort();
}

function exportedSchemaNames(file: string): string[] {
  const text = readFileSync(path.join(CONTRACTS_DIR, file), "utf8");
  return [...text.matchAll(/^export const (\w+Schema)\b/gm)].map((match) => match[1] as string);
}

describe("contract module inventory (DESIGN §8)", () => {
  it("finds the contract files on disk", () => {
    expect(contractFiles().length).toBeGreaterThan(0);
    expect(contractFiles()).toContain("jobs.ts");
  });

  it("every contract file publishes a schema, or is a declared building block", () => {
    // `primitives.ts` and `parse.ts` provide field schemas and the parser
    // rather than object shapes. A new file must either publish a named schema
    // or be added here with a reason, so an undocumented module cannot slip in
    // untested.
    const buildingBlocks = ["primitives.ts", "parse.ts"];
    const silentSchemas: string[] = [];
    const silentBlocks: string[] = [];
    for (const file of contractFiles()) {
      const names = exportedSchemaNames(file);
      if (buildingBlocks.includes(file)) {
        const text = readFileSync(path.join(CONTRACTS_DIR, file), "utf8");
        if (!/^export (?:function|const \w+ =)/m.test(text)) silentBlocks.push(file);
        continue;
      }
      if (names.length === 0) silentSchemas.push(file);
    }
    expect(silentSchemas).toEqual([]);
    expect(silentBlocks).toEqual([]);
  });

  it("publishes each §8-named schema in the file the design points at", () => {
    const misplaced: string[] = [];
    for (const [name, where] of Object.entries(SPEC_NAMED_SCHEMAS)) {
      if (!exportedSchemaNames(where.file).includes(name)) misplaced.push(`${name} -> ${where.file}`);
    }
    expect(misplaced).toEqual([]);
  });
});

describe("wire objects are parseable and reject extras", () => {
  const cases: [string, unknown, Parameters<typeof parseStrict>[0]][] = [
    [
      "apiErrorBodySchema",
      {
        error: {
          code: "INVALID_INPUT",
          message: "field required",
          retryable: false,
          details: {},
          requestId: "req_1",
        },
      },
      apiErrorBodySchema,
    ],
    [
      "jobRecordSchema",
      {
        id: ID,
        kind: "capture",
        state: "queued",
        cleanupState: "pending",
        deadlineAt: null,
        retryAt: null,
        cleanupRetryAt: null,
        resultRef: null,
        error: null,
      },
      jobRecordSchema,
    ],
    [
      "committedEventSchema",
      {
        seq: 1,
        projectId: ID,
        type: "evidence.committed",
        aggregateId: `ev_${HEX}`,
        createdAt: "2026-10-16T00:00:00.000Z",
        payload: { resourceIds: [`ev_${HEX}`] },
      },
      committedEventSchema,
    ],
    [
      "healthResponseSchema",
      {
        status: "degraded",
        schemaVersion: 1,
        reaIdentity: null,
        capabilities: [],
        effectiveProfiles: [],
      },
      healthResponseSchema,
    ],
    [
      "bootstrapExchangeSchema",
      { bootstrapToken: "one-time-pairing-code" },
      bootstrapExchangeSchema,
    ],
    [
      "captureTaskSchema",
      {
        kind: "capture",
        profileId: "web",
        scenario: { startUrl: "http://127.0.0.1:4110", actions: [] },
        network: { requestBody: false, responseBody: false, headerValues: false },
      },
      captureTaskSchema,
    ],
    [
      "inspectTaskSchema",
      { kind: "inspect", claimIds: [], question: "缺哪些正文", scope: "static" },
      inspectTaskSchema,
    ],
    ["importFieldsSchema", { kind: "har" }, importFieldsSchema],
    [
      "pendingTargetSchema",
      { id: ID, kind: "url", snapshotDigest: null, identityReason: "not-captured" },
      pendingTargetSchema,
    ],
  ];

  it.each(cases.map(([name, value, schema]) => [name, value, schema]))(
    "%s parses",
    (_name, value, schema) => {
      const result = parseStrict(schema, value);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
    },
  );

  it.each(cases.map(([name, value, schema]) => [name, value, schema]))(
    "%s rejects an extra field",
    (_name, value, schema) => {
      expect(parseStrict(schema, { ...(value as object), injected: 1 }).ok).toBe(false);
    },
  );
});

describe("error status mapping", () => {
  it("maps the codes §8 names to the documented statuses", () => {
    expect(httpStatusFor("INVALID_INPUT")).toBe(400);
    expect(httpStatusFor("SESSION_REQUIRED")).toBe(401);
    expect(httpStatusFor("ACCESS_DENIED")).toBe(403);
    expect(httpStatusFor("NOT_FOUND")).toBe(404);
    expect(httpStatusFor("EVENT_CURSOR_EXPIRED")).toBe(409);
    expect(httpStatusFor("RESOURCE_LIMIT")).toBe(413);
    expect(httpStatusFor("BLUEPRINT_BLOCKED")).toBe(422);
    expect(httpStatusFor("CAPABILITY_UNAVAILABLE")).toBe(503);
  });

  it("refuses an unmodelled error code", () => {
    const result = parseStrict(apiErrorBodySchema, {
      error: {
        code: "INTERNAL_OOPS",
        message: "x",
        retryable: false,
        details: {},
        requestId: "r",
      },
    });
    expect(result.ok).toBe(false);
  });

  it("keeps the current session role server-assigned", () => {
    expect(
      parseStrict(currentSessionSchema, {
        reviewerId: ID,
        csrfToken: "t",
        expiresAt: "2026-10-16T01:00:00.000Z",
        role: "local-controller",
      }).ok,
    ).toBe(true);
    expect(
      parseStrict(currentSessionSchema, {
        reviewerId: ID,
        csrfToken: "t",
        expiresAt: "2026-10-16T01:00:00.000Z",
        role: "inspector",
      }).ok,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import type { Digest } from "../../packages/domain/canonical-json.ts";
import { newId } from "../../packages/domain/identity.ts";
import type { BlueprintPayload } from "../../packages/domain/blueprint.ts";
import {
  ADAPTER_ABI_FIELDS,
  ADAPTER_EXPORT,
  JSON_SCHEMA_DIALECT,
  OPENAPI_VERSION,
  adapterSource,
  buildTargetOpenApi,
  candidateManifest,
  generationDefects,
  openApiDigest,
} from "../../packages/domain/openapi.ts";

// Generation rules for the target SDK (DESIGN §7.3, §10 / PRD F08 A07, issue #19).
//
// The theme of every case here is the same: a generator may only write down what a
// reviewed contract actually said. Strictness, required lists, path templates and
// error handling all *stay* as the contract left them, because an invented
// `additionalProperties:false` reads as a promise the evidence never made.

const LIMITS = { maxDepth: 24, maxCodeUnits: 200_000 };
const INPUT_SCHEMA = {
  type: "object",
  properties: { include: { type: "string" }, quantity: { type: "integer" } },
  required: ["include"],
};

function blueprint(overrides: Partial<BlueprintPayload> = {}): BlueprintPayload {
  const contractKey = "cart-read";
  return {
    schemaVersion: 1,
    blueprintId: newId(),
    blueprintDigest: asDigest("b".repeat(64)),
    contractRevisions: [
      {
        contractKey,
        revision: 1,
        digest: asDigest("1".repeat(64)),
        behaviorSpec: "reads the cart with the requested include set",
        inputSchema: INPUT_SCHEMA,
        outputSchema: { type: "object", properties: { items: { type: "array" } } },
        httpOperations: [
          {
            operationId: "getCart",
            method: "GET",
            path: "/api/cart/42",
            requestMediaType: "application/json",
            responses: [{ status: 200, mediaType: "application/json", schema: { type: "object" } }],
          },
        ],
        errorCases: ["401 unauthenticated"],
        limitations: ["no retry semantics observed"],
        unknowns: ["pagination shape"],
      },
    ],
    publicVectors: [],
    generation: { language: "typescript", outputKind: "http-sdk", openapiVersion: "3.1.1" },
    verificationScope: ["getCart"],
    ...overrides,
  };
}

describe("the generated document carries only what the contract said (§10)", () => {
  it("publishes at the version and dialect the design fixes", () => {
    const { document, defects } = buildTargetOpenApi(blueprint());
    expect(defects).toEqual([]);
    expect(document["openapi"]).toBe(OPENAPI_VERSION);
    expect(document["jsonSchemaDialect"]).toBe(JSON_SCHEMA_DIALECT);
  });

  it("passes the reviewed schema object through unchanged", () => {
    const { document } = buildTargetOpenApi(blueprint());
    const schemas = (document["components"] as { schemas: Record<string, unknown> }).schemas;
    const input = schemas["cart-read_v1_input"] as Record<string, unknown>;
    expect(input).toEqual(INPUT_SCHEMA);
    // The invented-strictness case: a generator that wanted to look careful would add
    // `additionalProperties: false`. §10 forbids that, so it must be absent.
    expect(JSON.stringify(input)).not.toContain("additionalProperties");
    const operation = ((document["paths"] as Record<string, Record<string, unknown>>)["/api/cart/42"] ?? {})["get"] as Record<string, unknown>;
    const requestBody = operation["requestBody"] as { content: Record<string, unknown> };
    expect(requestBody.content["application/json"]).toEqual(INPUT_SCHEMA);
  });

  it("keeps a path template exactly as reviewed and does not generalise a literal", () => {
    const { document } = buildTargetOpenApi(blueprint());
    const paths = Object.keys(document["paths"] as Record<string, unknown>);
    // `/api/cart/42` stays `/api/cart/42`: turning it into `/api/cart/{id}` would be
    // a claim about identifier shape the contract never made.
    expect(paths).toEqual(["/api/cart/42"]);
    expect(paths.some((path) => path.includes("{"))).toBe(false);
  });

  it("carries error cases, limitations and unknowns instead of dropping them", async () => {
    const { document } = buildTargetOpenApi(blueprint());
    const operation = ((document["paths"] as Record<string, Record<string, unknown>>)["/api/cart/42"] ?? {})["get"] as Record<string, unknown>;
    expect(operation["x-rea-error-cases"]).toEqual(["401 unauthenticated"]);
    expect(operation["x-rea-limitations"]).toEqual(["no retry semantics observed"]);
    expect(operation["x-rea-unknowns"]).toEqual(["pagination shape"]);
    const contract = operation["x-rea-contract"] as { digest: Digest };
    expect(contract.digest).toBe("1".repeat(64));
    expect(JSON.stringify(document)).toContain("401 unauthenticated");
  });

  it("refuses to generate when there is nothing reviewed to generate from", () => {
    expect(generationDefects(blueprint({ contractRevisions: [] }))).toContain("no-reviewed-contract");
    const noResponses = blueprint();
    noResponses.contractRevisions[0]!.httpOperations[0]!.responses = [];
    expect(generationDefects(noResponses)).toContain("operation-without-response:cart-read:getCart");
    // A document whose paths are unknown cannot be salvaged, so the whole build is
    // refused rather than emitting a placeholder path.
    expect(buildTargetOpenApi(noResponses).document).toEqual({});
    expect(buildTargetOpenApi(noResponses).defects.length).toBeGreaterThan(0);
  });

  it("refuses a generation request for another language, output kind or OpenAPI version", () => {
    const wrongVersion = blueprint();
    wrongVersion.generation.openapiVersion = "3.1.0" as unknown as "3.1.1";
    expect(generationDefects(wrongVersion)).toContain("openapi-version-unsupported:3.1.0");
    const wrongKind = blueprint();
    wrongKind.generation.outputKind = "grpc-stub" as unknown as "http-sdk";
    expect(generationDefects(wrongKind)).toContain("generation-request-unsupported");
    const stillWrongKind = blueprint();
    stillWrongKind.generation = { language: "typescript", outputKind: "http-sdk", openapiVersion: "3.1.1" };
    expect(generationDefects(stillWrongKind)).toEqual([]);
    const wrongLanguage = blueprint();
    wrongLanguage.generation = {
      language: "python" as unknown as "typescript",
      outputKind: "http-sdk",
      openapiVersion: "3.1.1",
    };
    expect(generationDefects(wrongLanguage)).toContain("generation-request-unsupported");
  });

  it("digests the document so a changed contract is a different candidate", () => {
    const base = openApiDigest(buildTargetOpenApi(blueprint()).document, LIMITS);
    const moved = blueprint();
    moved.contractRevisions[0]!.digest = asDigest("2".repeat(64));
    expect(openApiDigest(buildTargetOpenApi(moved).document, LIMITS)).not.toBe(base);
    const reordered = blueprint();
    reordered.contractRevisions[0]!.httpOperations.push({
      operationId: "anotherOp",
      method: "POST",
      path: "/api/cart",
      requestMediaType: null,
      responses: [{ status: 204, mediaType: null, schema: {} }],
    });
    expect(openApiDigest(buildTargetOpenApi(reordered).document, LIMITS)).not.toBe(base);
  });

  it("a response with no media type gets no invented content block", () => {
    const bare = blueprint();
    bare.contractRevisions[0]!.httpOperations[0]!.responses = [
      { status: 204, mediaType: null, schema: {} },
    ];
    const { document } = buildTargetOpenApi(bare);
    const operation = ((document["paths"] as Record<string, Record<string, unknown>>)["/api/cart/42"] ?? {})["get"] as {
      responses: Record<string, Record<string, unknown>>;
    };
    expect(operation.responses["204"]).toEqual({ description: "Reviewed response 204 of getCart" });
  });
});

describe("the candidate's declared adapter ABI (§10)", () => {
  const operations = [
    { operationId: "getCart", method: "GET", path: "/api/cart/42" },
    { operationId: "postCheckout", method: "POST", path: "/api/checkout" },
    { operationId: "addItem", method: "post", path: "/api/cart/42/items" },
  ];
  const ids = operations.map((operation) => operation.operationId);

  it("names the export and its three parameters, sorted", () => {
    const manifest = candidateManifest({
      schemaVersion: 1,
      entry: "adapter.ts",
      operationIds: ids,
      openApiDigest: asDigest("3".repeat(64)),
    });
    expect(manifest["adapterAbi"]).toEqual({
      export: ADAPTER_EXPORT,
      parameters: [...ADAPTER_ABI_FIELDS],
    });
    expect(manifest["operationIds"]).toEqual([...ids].sort());
    expect(manifest["openApiVersion"]).toBe(OPENAPI_VERSION);
  });

  it("emits a branch per reviewed operation and an error for anything else", () => {
    const source = adapterSource(operations);
    for (const operation of operations) {
      expect(source).toContain(`operationId === ${JSON.stringify(operation.operationId)}`);
    }
    expect(source).toContain("export async function invoke(");
    expect(source).toContain("is not part of the reviewed contract");
    // No operation means nothing callable: the fall-through says so rather than
    // dispatching on a guessed name.
    expect(adapterSource([])).toContain("no reviewed operation in this candidate");
  });

  it("routes each operation by the method and path the contract stated", () => {
    const source = adapterSource(operations);
    // A generated SDK that lost the method would send every POST as a GET, and one
    // that built the URL from the operation id would call an endpoint no contract
    // promised. Both facts are in the reviewed operation, so they must appear.
    expect(source).toContain(`"getCart": { method: "GET", path: "/api/cart/42" },`);
    expect(source).toContain(`"postCheckout": { method: "POST", path: "/api/checkout" },`);
    expect(source).toContain(`"addItem": { method: "POST", path: "/api/cart/42/items" },`);
    expect(source).toContain("fetch(context.baseUrl + route.path");
    expect(source).toContain("method: route.method");
    // The base URL arrives per call, never as module state a second call overwrites.
    expect(source).not.toContain("let CURRENT_BASE_URL");
  });

  it("keeps every operation id quoted, so a caller cannot inject a branch", () => {
    const hostile = 'getCart"); throw "pwned';
    const source = adapterSource([{ operationId: hostile, method: "GET", path: "/x" }]);
    // The id reaches the file as a JSON string literal, never as raw source text:
    // one dispatch per operation id, and the unescaped form must not appear at all.
    expect(source).toContain(JSON.stringify(hostile));
    expect(source).not.toContain(hostile);
    expect(source.match(/return request\(/g)?.length).toBe(1);
  });
});

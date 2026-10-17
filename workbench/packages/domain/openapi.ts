import type { CanonicalLimits, Digest } from "./canonical-json.ts";
import { asDigest, digestCanonicalJson } from "./canonical-json.ts";
import type { JsonObject, JsonValue } from "./json-value.ts";
import type { BlueprintPayload } from "./blueprint.ts";

// OpenAPI 3.1.1 generation for the *target SDK* (DESIGN §7.3, §10 / PRD F08 A07,
// issue #19).
//
// The rule that shapes this whole file is §10's last clause: a sample's fields are
// observations, not a specification. So every schema here is the reviewed contract's
// own schema object, carried through unchanged, and what the contract did not state
// stays unstated: no `additionalProperties:false` invented to look strict, no
// `required` grown from whatever the public vectors happened to carry, no `format`
// guessed from a value's shape.
//
// The workbench's own REST API OpenAPI is a different product (§10 says so
// explicitly) and is not derived from here.

export const OPENAPI_VERSION = "3.1.1";
// 3.1.1 aligns its Schema Object with the declared JSON Schema dialect; the
// workbench pins 2020-12 because that is what the reviewed contracts declare.
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export type GenerationDefect = {
  code: "GENERATION_BLOCKED";
  reason: string;
  missing: string[];
};

export function generationDefects(blueprint: BlueprintPayload): string[] {
  const reasons: string[] = [];
  if (blueprint.contractRevisions.length === 0) reasons.push("no-reviewed-contract");
  for (const contract of blueprint.contractRevisions) {
    // A behaviour spec without an operation cannot become a path: emitting
    // `/unknown` would be inventing an endpoint the contract never promised.
    if (contract.httpOperations.length === 0) {
      reasons.push(`contract-without-operation:${contract.contractKey}`);
    }
    for (const operation of contract.httpOperations) {
      if (operation.responses.length === 0) {
        reasons.push(`operation-without-response:${contract.contractKey}:${operation.operationId}`);
      }
    }
  }
  if (blueprint.generation.language !== "typescript" || blueprint.generation.outputKind !== "http-sdk") {
    reasons.push("generation-request-unsupported");
  }
  if (blueprint.generation.openapiVersion !== OPENAPI_VERSION) {
    reasons.push(`openapi-version-unsupported:${blueprint.generation.openapiVersion}`);
  }
  return reasons;
}

function schemaOf(value: JsonValue): JsonObject {
  // Carried through verbatim; `$schema` is stated once, at the document root, so a
  // contract that already declared a *different* dialect keeps its own marker inside
  // its schema object rather than being relabelled here.
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as JsonObject) }
    : {};
}

function pathKey(path: string): string {
  // Templates stay as the contract wrote them. Generalising `/cart/42` to
  // `/cart/{id}` is a claim about the *shape* of the identifier the reviewed
  // contract never made, so §10's "模板泛化另列待证 claim" applies: no substitution here.
  return path;
}

export type GeneratedOpenApi = { document: JsonObject; defects: string[] };

export function buildTargetOpenApi(blueprint: BlueprintPayload): GeneratedOpenApi {
  const defects = generationDefects(blueprint);
  if (defects.length > 0) return { document: {}, defects };

  const paths: Record<string, JsonValue> = {};
  const components: Record<string, JsonValue> = {};
  const unknowns: string[] = [];

  for (const contract of blueprint.contractRevisions) {
    for (const operation of contract.httpOperations) {
      const method = operation.method.toLowerCase();
      const path = pathKey(operation.path);
      const perPath = (paths[path] ?? {}) as Record<string, JsonValue>;
      const responses: Record<string, JsonValue> = {};
      for (const response of operation.responses) {
        const media = response.mediaType === null
          ? {}
          : { content: { [response.mediaType]: schemaOf(response.schema) } };
        responses[String(response.status)] = {
          description: `Reviewed response ${String(response.status)} of ${operation.operationId}`,
          ...media,
        };
      }
      const requestMedia = operation.requestMediaType === null
        ? {}
        : {
            requestBody: {
              required: true,
              content: { [operation.requestMediaType]: schemaOf(contract.inputSchema) },
            },
          };
      const known: Record<string, JsonValue> = {
        operationId: operation.operationId,
        summary: contract.behaviorSpec,
        tags: [contract.contractKey],
        ...requestMedia,
        responses,
        // §10: error cases and limits are part of the promise, not a footnote a
        // generator is free to drop.
        "x-rea-error-cases": contract.errorCases as unknown as JsonValue,
        "x-rea-limitations": contract.limitations as unknown as JsonValue,
        "x-rea-contract": {
          contractKey: contract.contractKey,
          revision: contract.revision,
          digest: contract.digest,
        },
      };
      if (contract.unknowns.length > 0) {
        known["x-rea-unknowns"] = contract.unknowns as unknown as JsonValue;
        unknowns.push(...contract.unknowns.map((entry: string) => `${contract.contractKey}:${entry}`));
      }
      perPath[method] = known;
      paths[path] = perPath;
    }
    components[`${contract.contractKey}_v${String(contract.revision)}_input`] = schemaOf(contract.inputSchema);
    components[`${contract.contractKey}_v${String(contract.revision)}_output`] = schemaOf(contract.outputSchema);
  }

  return {
    document: {
      openapi: OPENAPI_VERSION,
      jsonSchemaDialect: JSON_SCHEMA_DIALECT,
      info: {
        title: "REA Workbench generated SDK (target HTTP contract)",
        version: blueprint.blueprintDigest,
        "x-rea-blueprint": {
          blueprintId: blueprint.blueprintId,
          blueprintDigest: blueprint.blueprintDigest,
          schemaVersion: blueprint.schemaVersion,
        },
        "x-rea-verification-scope": blueprint.verificationScope as unknown as JsonValue,
        "x-rea-public-vector-count": blueprint.publicVectors.length,
      },
      paths: paths as unknown as JsonValue,
      components: { schemas: components as unknown as JsonValue },
    },
    defects: [],
  };
}

export function openApiDigest(document: JsonObject, limits: CanonicalLimits): Digest {
  return asDigest(digestCanonicalJson(document, limits));
}

// The fixed adapter ABI (§10: 不按目录或导出顺序猜调用点). The candidate is only
// usable downstream if it *declares* the entry and the operation ids it implements;
// a generation that could not name them is refused rather than guessed.
export const ADAPTER_EXPORT = "invoke";
export const ADAPTER_ABI_FIELDS = ["operationId", "sdkInput", "context"] as const;

export type CandidateFile = { path: string; body: string; mediaType: string };

// The reviewed part of an operation that the adapter needs to be callable: an id, the
// method and the path the contract promised. Nothing else is written into the file.
export type ReviewedOperation = { operationId: string; method: string; path: string };

export function candidateManifest(input: {
  schemaVersion: number;
  entry: string;
  operationIds: readonly string[];
  openApiDigest: Digest;
}): JsonObject {
  return {
    schemaVersion: input.schemaVersion,
    entry: input.entry,
    operationIds: [...input.operationIds].sort(),
    openApiVersion: OPENAPI_VERSION,
    openApiDigest: input.openApiDigest,
    adapterAbi: {
      export: ADAPTER_EXPORT,
      parameters: [...ADAPTER_ABI_FIELDS],
    },
  };
}

export function adapterSource(operations: readonly ReviewedOperation[]): string {
  const sorted = [...operations].sort((left, right) =>
    left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0
  );
  // Every branch and every route is a reviewed operation id with the method and path
  // the contract stated. The fall-through is an error, never a best guess at which
  // endpoint the caller meant, and the base URL arrives through the context argument
  // instead of module state two parallel calls could clobber.
  //
  // The body rule below is not a style choice: this file used to emit `body` unconditionally, and
  // nothing ever *ran* a generated candidate, so no test could see what a browser or a harness sees
  // immediately - `fetch` rejects a GET carrying a body with `TypeError: Request with GET/HEAD method
  // cannot have body`, which made every generated GET operation uncallable. Silently dropping
  // `sdkInput` on those methods would be worse than the crash: the call would answer 200 while
  // ignoring part of what the caller passed, which is the "best guess at what the caller meant"
  // this function otherwise refuses to make. So a bodyless method that is handed a non-empty input
  // names the mistake instead of hiding it.
  const routes = sorted.map(
    (operation) =>
      `    ${JSON.stringify(operation.operationId)}: { method: ${JSON.stringify(
        operation.method.toUpperCase(),
      )}, path: ${JSON.stringify(operation.path)} },`,
  );
  const unknown = `throw new Error("operation " + String(operationId) + " is not part of the reviewed contract");`;
  // One table, one lookup, one guard. There used to be a second copy of the same fact - an `if
  // (operationId === …) return request(…)` branch per operation, plus a `route === undefined` check
  // inside `request` that nothing could ever reach, because `invoke` had already refused the id. A
  // mutation that turned that dead check into a silent `{ invented: true }` passed the whole suite,
  // which is how it got found: the guard that cannot be reached cannot be wrong, and a guard that
  // cannot be wrong is not a guard.
  return [
    `// Generated from a frozen REA Workbench blueprint. Do not edit by hand.`,
    `export type SdkInput = Record<string, unknown>;`,
    `export type Context = { baseUrl: string };`,
    `type Route = { method: string; path: string };`,
    `const ROUTE: Record<string, Route> = {`,
    ...(routes.length > 0 ? routes : [`    // no reviewed operation in this candidate`]),
    `};`,
    `async function request(`,
    `  route: Route,`,
    `  context: Context,`,
    `  sdkInput: SdkInput,`,
    `  operationId: string,`,
    `): Promise<unknown> {`,
    `  const bodyless = route.method === "GET" || route.method === "HEAD";`,
    `  const hasInput = Object.keys(sdkInput).length > 0;`,
    `  if (bodyless && hasInput) {`,
    `    throw new Error("operation " + String(operationId) + " is " + route.method + ": it can carry no request body, and this call passed " + String(Object.keys(sdkInput).length) + " field(s)");`,
    `  }`,
    `  const init: Record<string, unknown> = { method: route.method };`,
    `  if (!bodyless && hasInput) {`,
    `    init.body = JSON.stringify(sdkInput);`,
    `    init.headers = { "content-type": "application/json" };`,
    `  }`,
    `  const response = await fetch(context.baseUrl + route.path, init);`,
    `  return (await response.json()) as unknown;`,
    `}`,
    `export async function invoke(`,
    `  operationId: string,`,
    `  sdkInput: SdkInput,`,
    `  context: Context,`,
    `): Promise<unknown> {`,
    `  const route = ROUTE[operationId];`,
    `  if (route === undefined) { ${unknown} }`,
    `  return request(route, context, sdkInput, operationId);`,
    `}`,
  ].join("\n");
}

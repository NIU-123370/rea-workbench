import {
  bootstrapExchangeSchema,
  currentSessionSchema,
  pairedSessionSchema,
  revokedSessionSchema,
  sessionViewSchema,
} from "../../packages/contracts/session.ts";
import type { CurrentSession } from "../../packages/contracts/session.ts";
import { createProjectRequestSchema, createdProjectSchema, evidenceViewSchema, projectViewSchema } from "../../packages/contracts/resources.ts";
import { verificationPlanSchema } from "../../packages/contracts/behaviors.ts";
import { testVectorSchema, vectorPageSchema } from "../../packages/contracts/vectors.ts";
import { exportArchiveSchema, exportCreateRequestSchema, exportListSchema, exportRecordSchema } from "../../packages/contracts/export.ts";
import { jobPageSchema, jobRecordSchema } from "../../packages/contracts/jobs.ts";
import { auditPageSchema } from "../../packages/contracts/audit.ts";
import { isRelativeDownloadUrl } from "../../packages/domain/export.ts";
import { healthResponseSchema } from "../../packages/contracts/health.ts";
import { graphViewSchema } from "../../packages/contracts/graph.ts";
import { candidateFileContentSchema, candidateViewSchema } from "../../packages/contracts/candidate.ts";
import { parseStrict } from "../../packages/contracts/parse.ts";
import type { NamedErrorCode } from "../../packages/contracts/errors.ts";
import type { CanonicalLimits } from "../../packages/domain/canonical-json.ts";
import { asId, asInstant, isId, isReaEvidenceId, newId } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { JsonObject, JsonValue } from "../../packages/domain/json-value.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { ListenAddress, LocalSession } from "../../packages/application/session.ts";
import {
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  clearingCookieHeader,
  csrfMatches,
  hostAllowed,
  originAllowed,
  readCookie,
  sessionCookieHeader,
} from "../../packages/application/session.ts";
import { IdempotencyJournal, idempotencyDigest, isIdempotencyKey, journalScope } from "../../packages/application/idempotency.ts";
import type { SensitiveDeclaration } from "../../packages/application/sanitizer.ts";
import { emptySuccess, errorResponse, jsonSuccess } from "./api-envelope.ts";
import { openEventStream } from "./event-stream.ts";
import type { AccessLog } from "./access-log.ts";
import type { ApiResponse, HttpRequest } from "./types.ts";
import type { WorkerCaller, WorkerFailure } from "./worker-client.ts";

// The API pipeline (DESIGN §8 通用规则, §14, §12.1, §12.2).
//
// One function per request, in a fixed order, because the order *is* the security
// property: Host, then route, then Origin (for anything that changes state or pairs),
// then the session, then CSRF, then the idempotency claim, then the strict body parse,
// then the named command. A request that fails an earlier gate never reaches a later
// one, so a foreign `Host` cannot discover which routes exist, an unpaired caller cannot
// make the worker mint anything, and a mutation without its CSRF header cannot consume an
// idempotency key.
//
// Nothing here touches SQLite or the artifact store. §2 gives the API exactly one way to
// ask for a change — a named command over the worker's private socket — so a worker that
// does not answer is a 503, and there is no local fallback path to fall back to.

export const API_PREFIX = "/api/v1";

// §12 measures before it allocates. These bodies are named commands, not uploads: the
// multipart import route belongs to issue #15's flow and is not mounted here.
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

// The role §8 gives a paired local session. It is assigned by this module and never read
// from a caller, so a body field claiming a role has nowhere to go.
const LOCAL_ROLE = "local-controller" as const;

// The actor a pairing attempt is journalled under: the reviewer identity does not exist
// until the pairing succeeds, so the honest attribution is the local start path itself.
const UNPAIRED_ACTOR: Actor = { actorId: "local-start-terminal", actorKind: "system" };

type RouteSpec = {
  method: string;
  template: string;
  mutating: boolean;
  requiresSession: boolean;
  requiresIdempotencyKey: boolean;
};

const ROUTES: readonly RouteSpec[] = [
  { method: "POST", template: `${API_PREFIX}/session`, mutating: false, requiresSession: false, requiresIdempotencyKey: false },
  { method: "GET", template: `${API_PREFIX}/session`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  { method: "DELETE", template: `${API_PREFIX}/session`, mutating: true, requiresSession: true, requiresIdempotencyKey: false },
  { method: "GET", template: `${API_PREFIX}/health`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  { method: "POST", template: `${API_PREFIX}/projects`, mutating: true, requiresSession: true, requiresIdempotencyKey: true },
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/events`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  // The graph read the three columns are built from (§6, §8 / issue #18). It is a GET
  // with no body: the target it names, if any, comes from the query, so a page can ask
  // for the same view the tested headless renderer gets without inventing a second
  // place where a claim's status is decided.
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/graph`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  // The project's job page (§8 line 277 / issue #55). Cursor and limit ride the query
  // because the read is a page, not a resource: §8 names this route as where a client
  // recovers a build or verification resource id from the persisted resultRef.
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/jobs`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  // The two audit windows (§8 lines 302-303 / issue #58). Separate routes with separate
  // commands: the journal a reviewer reads about one project is not the journal of pairings,
  // revocations and unauthenticated refusals that belong to no project.
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/audit`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  { method: "GET", template: `${API_PREFIX}/audit`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  // The five §8 reads that had a worker command and no HTTP door (issue #58). Each one is a
  // single resource under the project, session-bound, and answered by the command of the
  // same name; none of them takes a body, and none of them resolves a path.
  { method: "GET", template: `${API_PREFIX}/projects/:projectId`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/jobs/:jobId`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/evidence/:evidenceId`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  // The inventory page (§8 line 283): the list a reviewer browses before opening one
  // vector. It is the only route in this adapter whose cursor can go stale on purpose -
  // §8 says a moved inventory is a 409, not a page that mixes two states.
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/vectors`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/vectors/:vectorId`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/verification-plans/:planId`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  // The candidate file read (§8 lines 295-296 / issue #19). Two GETs, both session-bound:  // the first lists the files a candidate published, the second returns one file's content
  // selected by manifest file id. Neither takes a path.
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/candidates/:candidateId`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/candidates/:candidateId/files/:fileId`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  // Delivery (§8 lines 299-300 / issue #22). The POST creates a *new* package rather than
  // taking an idempotency key: §5's rule is that an old package is never overwritten, and
  // a retried request therefore has to make a second record, not replay the first.
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/exports`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/exports`, mutating: true, requiresSession: true, requiresIdempotencyKey: false },
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/exports/:exportId/download`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
];

export type Matched = { route: RouteSpec; params: Record<string, string> };

// A path matches a template segment by segment; a `:name` segment captures one part and
// nothing captures more, so `/api/v1/projects/x/events/extra` is not a route.
export function matchRoute(method: string, path: string): Matched | null {
  const parts = path.split("/").filter((part) => part.length > 0);
  for (const route of ROUTES) {
    if (route.method !== method.toUpperCase()) continue;
    const template = route.template.split("/").filter((part) => part.length > 0);
    if (template.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let index = 0; index < template.length; index += 1) {
      const expect = template[index] as string;
      const actual = parts[index] as string;
      if (expect.startsWith(":")) {
        params[expect.slice(1)] = actual;
        continue;
      }
      if (expect !== actual) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

// The routes this adapter mounts, for the startup line and for `GET /health`'s
// capability list. It is derived from the table, so it cannot claim a route that is not
// implemented.
export function routeTemplates(): string[] {
  return ROUTES.map((route) => `${route.method} ${route.template}`);
}

export type ApiDependencies = {
  address: ListenAddress;
  worker: WorkerCaller;
  journal: IdempotencyJournal;
  limits: CanonicalLimits;
  access: AccessLog;
  stream: { pollMs: number; sleep: (ms: number) => Promise<void> };
};

type Context = {
  request: HttpRequest;
  requestId: string;
  declaration: SensitiveDeclaration;
  actor: Actor;
  params: Record<string, string>;
  sessionKey: string;
  session: CurrentSession | null;
};

function refused(
  requestId: string,
  code: NamedErrorCode,
  reason: string,
  message: string,
  declaration: SensitiveDeclaration,
  details: JsonObject = {},
): ApiResponse {
  return errorResponse(requestId, { code, message, details: { reason, ...details } }, declaration);
}

function fromWorker(requestId: string, failure: WorkerFailure, declaration: SensitiveDeclaration): ApiResponse {
  return errorResponse(
    requestId,
    { code: failure.code, message: failure.message, details: { reason: failure.reason } },
    declaration,
  );
}

function jsonRecord(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}

function pickFields(value: JsonValue, fields: readonly string[]): JsonObject {
  const record = jsonRecord(value);
  const picked: Record<string, JsonValue> = {};
  for (const field of fields) {
    const member = record[field];
    if (member !== undefined) picked[field] = member;
  }
  return picked;
}

// The credentials this request presented, as declared literals: the session cookie it
// arrived with, and a pairing code in its body. §12.1 names cookies and the bootstrap
// token as things that never become debug attachments, and declaring them for this
// request's own diagnostics is how that is enforced rather than remembered: every
// message, detail and log line this request can produce is filtered against them.
export function requestDeclarations(bodyText: string, cookieValue: string | undefined): SensitiveDeclaration {
  const declared: string[] = [];
  const cookie = readCookie(cookieValue, SESSION_COOKIE_NAME);
  if (cookie !== null && cookie.length > 0) declared.push(cookie);
  if (bodyText.length > 0 && bodyText.length <= MAX_REQUEST_BODY_BYTES) {
    const parsed = tryJson(bodyText);
    if (parsed.ok) {
      const token = jsonRecord(parsed.value).bootstrapToken;
      if (typeof token === "string" && token.length > 0) declared.push(token);
    }
  }
  return { declaredValues: declared };
}

function tryJson(text: string): { ok: true; value: JsonValue } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch {
    return { ok: false };
  }
}

function readJsonBody(ctx: Context): { ok: true; value: JsonValue } | { ok: false; response: ApiResponse } {
  if (ctx.request.body.length === 0) {
    return { ok: false, response: refused(ctx.requestId, "INVALID_INPUT", "body-empty", "this request needs a JSON body", ctx.declaration) };
  }
  const parsed = tryJson(ctx.request.body);
  if (!parsed.ok) {
    // The reason is a shape fact: the text itself is never echoed, quoted or logged.
    return { ok: false, response: refused(ctx.requestId, "INVALID_INPUT", "body-not-json", "this request body is not JSON", ctx.declaration) };
  }
  return { ok: true, value: parsed.value };
}

async function pairSession(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const exchange = parseStrict(bootstrapExchangeSchema, body.value);
  if (!exchange.ok) {
    return refused(ctx.requestId, "INVALID_INPUT", "pair-body", "the pairing request does not match the exchange contract", ctx.declaration);
  }
  const outcome = await deps.worker.call("session.pair", { bootstrapToken: exchange.value.bootstrapToken }, UNPAIRED_ACTOR);
  if (!outcome.ok) {
    // §8: a rejected pairing is a 401. The worker's code decides the status, and its
    // reason never says whether the code existed and was old or was never minted.
    return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  }
  const paired = parseStrict(pairedSessionSchema, outcome.value);
  if (!paired.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "pair-reply", "the worker did not answer with a paired session", ctx.declaration);
  }
  const session: LocalSession = {
    sessionKey: paired.value.sessionKey,
    reviewerId: asId(paired.value.reviewerId),
    csrfToken: paired.value.csrfToken,
    expiresAt: asInstant(paired.value.expiresAt),
  };
  // The 201 body is exactly `sessionViewSchema`: the cookie value is deliberately not in
  // it, because a response body is readable by page script and a HttpOnly cookie is not.
  const view = parseStrict(sessionViewSchema, {
    reviewerId: session.reviewerId,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  });
  if (!view.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "session-view", "the paired session cannot be presented", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 201, view.value, [["set-cookie", sessionCookieHeader(session, deps.address).header]]);
}

function readSession(ctx: Context): ApiResponse {
  const view = parseStrict(currentSessionSchema, {
    reviewerId: (ctx.session as CurrentSession).reviewerId,
    csrfToken: (ctx.session as CurrentSession).csrfToken,
    expiresAt: (ctx.session as CurrentSession).expiresAt,
    role: LOCAL_ROLE,
  });
  if (!view.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "session-view", "the live session cannot be presented", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, view.value);
}

async function revokeSession(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const outcome = await deps.worker.call("session.revoke", { sessionKey: ctx.sessionKey }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const revoked = parseStrict(revokedSessionSchema, outcome.value);
  if (!revoked.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "revoke-reply", "the worker did not confirm the revocation", ctx.declaration);
  }
  // A revoked identity takes its idempotency journal with it: a later pairing has a
  // different reviewerId, and a replayed result must never cross a revoked session.
  deps.journal.dropScope(journalScope(String((ctx.session as CurrentSession).reviewerId), `${API_PREFIX}/projects`));
  return emptySuccess(ctx.requestId, 204, [
    ["set-cookie", clearingCookieHeader({ name: SESSION_COOKIE_NAME, secure: deps.address.secure })],
  ]);
}

function isReady(report: JsonValue): boolean {
  return jsonRecord(report).ready === true;
}

async function readHealth(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const [profiles, doctor] = await Promise.all([
    deps.worker.call("health.effectiveProfiles", {}, ctx.actor),
    deps.worker.call("doctor.run", {}, ctx.actor),
  ]);
  // §14: with the worker unavailable the API is degraded, and degraded here means a
  // 503 rather than a healthy body assembled from what this process remembers.
  if (!profiles.ok) return fromWorker(ctx.requestId, profiles.error, ctx.declaration);
  if (!doctor.ok) return fromWorker(ctx.requestId, doctor.error, ctx.declaration);
  const body = parseStrict(healthResponseSchema, {
    status: isReady(doctor.value) ? "ready" : "degraded",
    schemaVersion: 1,
    // This process owns no provider session, so it claims no REA identity.
    reaIdentity: null,
    capabilities: routeTemplates(),
    effectiveProfiles: profiles.value,
  });
  if (!body.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "health-shape", "the worker's health data does not match the health contract", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, body.value);
}

async function createProject(ctx: Context, deps: ApiDependencies, key: string): Promise<ApiResponse> {
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const parsed = parseStrict(createProjectRequestSchema, body.value);
  if (!parsed.ok) {
    // Field paths only, never values: a rejected extra field must not echo what a caller
    // put in it.
    return errorResponse(
      ctx.requestId,
      {
        code: "INVALID_INPUT",
        message: "the project request does not match the named schema",
        details: { fields: parsed.error.issues.map((issue) => issue.path) },
      },
      ctx.declaration,
    );
  }
  const digest = idempotencyDigest(
    { route: `${API_PREFIX}/projects`, method: "POST", body: parsed.value },
    ctx.declaration,
    deps.limits,
  );
  if (!digest.ok) return fromWorker(ctx.requestId, digest.error, ctx.declaration);
  const scope = journalScope(String((ctx.session as CurrentSession).reviewerId), `${API_PREFIX}/projects`);
  const claim = deps.journal.claim(scope, key, digest.value);
  if (claim.kind === "divergent") {
    return refused(ctx.requestId, "IDEMPOTENCY_CONFLICT", "idempotency-key-reused", "that idempotency key already carries a different request", ctx.declaration);
  }
  if (claim.kind === "inFlight") {
    return refused(ctx.requestId, "IDEMPOTENCY_CONFLICT", "idempotency-key-in-flight", "the first request with that key has not produced a result yet", ctx.declaration);
  }
  if (claim.kind === "replay") {
    // The original result, field for field, with a fresh request id: §8 says a replay
    // returns 原结果, and nothing is sent to the worker a second time.
    return jsonSuccess(ctx.requestId, claim.recorded.status, claim.recorded.body);
  }
  const outcome = await deps.worker.call("project.create", parsed.value, ctx.actor);
  if (!outcome.ok) {
    // A command that produced nothing gives the key back, so the caller may retry it.
    deps.journal.abandon(scope, key);
    return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  }
  // §8's 201 body is four fields; the worker's row carries more than that, and a response
  // is a named contract rather than a dump of what the command happened to return.
  const created = parseStrict(createdProjectSchema, pickFields(outcome.value, ["id", "name", "graphRevision", "createdAt"]));
  if (!created.ok) {
    deps.journal.abandon(scope, key);
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "project-shape", "the worker did not answer with a created project", ctx.declaration);
  }
  deps.journal.record(scope, key, digest.value, { status: 201, body: created.value });
  return jsonSuccess(ctx.requestId, 201, created.value);
}

async function listExports(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const outcome = await deps.worker.call("export.list", { projectId, limit: 50 }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const listed = parseStrict(exportListSchema, outcome.value);
  if (!listed.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "export-list-shape", "the worker did not answer with a list of exports", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, listed.value);
}

function pathId(ctx: Context, name: string): Id | null {
  const raw = ctx.params[name] ?? "";
  return isId(raw) ? asId(raw) : null;
}

// GET /projects/:p/jobs (§8 line 277). The limit is checked here rather than coerced:
// `Number("abc")` is NaN, and a NaN that reaches the worker as JSON null would read as
// "the caller did not state a limit" instead of "the caller stated a broken one".
async function listJobs(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const rawLimit = ctx.request.query.limit;
  if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) {
    return refused(ctx.requestId, "INVALID_INPUT", "jobs-limit-malformed", "the limit in the query is not a whole number", ctx.declaration);
  }
  const outcome = await deps.worker.call(
    "jobs.list",
    { projectId, request: { cursor: ctx.request.query.cursor ?? null, limit: rawLimit === undefined ? null : Number(rawLimit) } },
    ctx.actor,
  );
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const page = parseStrict(jobPageSchema, outcome.value);
  if (!page.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "job-page-shape", "the worker did not answer with a page of jobs", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, page.value);
}

async function readCandidate(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  const candidateId = pathId(ctx, "candidateId");
  if (projectId === null || candidateId === null) return unknownProject(ctx);
  const outcome = await deps.worker.call("candidate.get", { projectId, request: { candidateId } }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const view = parseStrict(candidateViewSchema, outcome.value);
  if (!view.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "candidate-view-shape", "the worker did not answer with a candidate file list", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, view.value);
}

async function readCandidateFile(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  const candidateId = pathId(ctx, "candidateId");
  const fileId = pathId(ctx, "fileId");
  if (projectId === null || candidateId === null || fileId === null) {
    // A segment that is not an opaque id is not a resource: §8 authorises a path id by
    // matching the project, not by believing the caller.
    return refused(ctx.requestId, "NOT_FOUND", "candidate-file-unknown", "no candidate file is addressed by that identifier", ctx.declaration);
  }
  const outcome = await deps.worker.call("candidate.file", { projectId, request: { candidateId, fileId } }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const content = parseStrict(candidateFileContentSchema, outcome.value);
  if (!content.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "candidate-file-shape", "the worker did not answer with candidate file content", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, content.value);
}

// The two audit reads (§8 lines 302-303). `after` and `limit` arrive as query text, and a
// value that is not a whole number is refused at the edge rather than turned into NaN or 0:
// `0` is a legal cursor meaning "from the beginning", so coercing a typo would silently
// re-serve the whole journal to a page that asked for the next hundred entries.
function intQuery(ctx: Context, name: string, reason: string): { value: number | null } | { refusal: ApiResponse } {
  const raw = ctx.request.query[name];
  if (raw === undefined) return { value: null };
  if (!/^\d+$/.test(raw)) {
    return { refusal: refused(ctx.requestId, "INVALID_INPUT", reason, `the ${name} in the query is not a whole number`, ctx.declaration) };
  }
  return { value: Number(raw) };
}

async function readAuditPage(
  ctx: Context,
  deps: ApiDependencies,
  command: string,
  payload: Record<string, JsonValue>,
): Promise<ApiResponse> {
  const after = intQuery(ctx, "after", "audit-after-malformed");
  if ("refusal" in after) return after.refusal;
  const limit = intQuery(ctx, "limit", "audit-limit-malformed");
  if ("refusal" in limit) return limit.refusal;
  const outcome = await deps.worker.call(command, { ...payload, request: { after: after.value, limit: limit.value } }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const page = parseStrict(auditPageSchema, outcome.value);
  if (!page.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "audit-page-shape", "the worker did not answer with a page of audit entries", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, page.value);
}

async function readProjectAudit(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  return readAuditPage(ctx, deps, "audit.list", { projectId });
}

async function readGlobalAudit(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  // No project segment exists on this route, so there is nothing to pass: §8 line 303 reads
  // the rows whose project is null, and the command refuses any project id in its payload.
  return readAuditPage(ctx, deps, "audit.listGlobal", {});
}

// --- The §8 reads that had a command but no route (issue #58) ------------------------
//
// Each of these five was already reachable by name inside the worker and already carried a
// wire schema; what was missing was the HTTP half, so a browser could not ask for any of
// them. A path segment that is not an opaque identifier is refused as "not a resource"
// rather than forwarded: §8 authorises a path id by matching the project, not by believing
// the caller, and echoing the string back would put it in a log line and a page (§12.1).

async function readProject(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const outcome = await deps.worker.call("project.get", { projectId }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const view = parseStrict(projectViewSchema, outcome.value);
  if (!view.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "project-view-shape", "the worker did not answer with the project view", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, view.value);
}

async function readJob(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  const jobId = pathId(ctx, "jobId");
  if (projectId === null) return unknownProject(ctx);
  // A segment that is not an opaque id was never a job: that is a malformed request, not a
  // lookup miss, and the two read differently to an operator fixing a link (the same
  // distinction `graph-target-id-malformed` makes for the graph read's query).
  if (jobId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "job-id-malformed", "the job segment of the path is not an opaque id", ctx.declaration);
  }
  const outcome = await deps.worker.call("job.get", { projectId, jobId }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const record = parseStrict(jobRecordSchema, outcome.value);
  if (!record.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "job-record-shape", "the worker did not answer with a job record", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, record.value);
}

async function readVectorPage(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const query = ctx.request.query;
  // Three slots, each refused at the edge on its own terms. `targetId` must be an opaque id
  // (a non-id here is a typo in a link, not a lookup miss); `limit` must be whole digits,
  // because `Number("1.5")` would otherwise arrive as 1 and read as a satisfied request.
  const targetId = query.targetId;
  if (targetId === undefined || !isId(targetId)) {
    return refused(ctx.requestId, "INVALID_INPUT", "vectors-target-required", "this page needs a targetId that is an opaque id", ctx.declaration);
  }
  // `limit` is checked here because turning query text into a number is lossy: `1.5` would
  // otherwise arrive as 1 and read as a satisfied request. `cursor` is *not* pre-checked —
  // whether a cursor is ours has exactly one owner, the worker's codec, and a second guess
  // at the edge would be a check with no observable difference behind it.
  const rawLimit = query.limit;
  if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) {
    return refused(ctx.requestId, "INVALID_INPUT", "vectors-limit-malformed", "the limit in the query is not a whole number", ctx.declaration);
  }
  const outcome = await deps.worker.call(
    "vector.list",
    {
      projectId,
      request: {
        targetId,
        cursor: query.cursor ?? null,
        limit: query.limit === undefined ? null : Number(query.limit),
      },
    },
    ctx.actor,
  );
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const page = parseStrict(vectorPageSchema, outcome.value);
  if (!page.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "vector-page-shape", "the worker did not answer with a page of vectors", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, page.value);
}

async function readEvidence(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  // Upstream evidence ids keep their own shape (`ev_` plus 64 hex); they are not workbench
  // ids, so the path test is the one §4 names for preserved upstream identifiers.
  const rawEvidence = ctx.params["evidenceId"] ?? "";
  if (projectId === null) return unknownProject(ctx);
  if (!isReaEvidenceId(rawEvidence)) {
    return refused(ctx.requestId, "INVALID_INPUT", "evidence-id-malformed", "the evidence segment of the path is not an upstream evidence id", ctx.declaration);
  }
  const outcome = await deps.worker.call("evidence.get", { projectId, evidenceId: rawEvidence }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const view = parseStrict(evidenceViewSchema, outcome.value);
  if (!view.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "evidence-view-shape", "the worker did not answer with a stored evidence envelope", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, view.value);
}

async function readVector(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  const vectorId = pathId(ctx, "vectorId");
  if (projectId === null) return unknownProject(ctx);
  if (vectorId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "vector-id-malformed", "the vector segment of the path is not an opaque id", ctx.declaration);
  }
  const outcome = await deps.worker.call("vector.read", { projectId, vectorId }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const vector = parseStrict(testVectorSchema, outcome.value);
  if (!vector.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "vector-shape", "the worker did not answer with a test vector", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, vector.value);
}

async function readPlan(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  const planId = pathId(ctx, "planId");
  if (projectId === null) return unknownProject(ctx);
  if (planId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "plan-id-malformed", "the plan segment of the path is not an opaque id", ctx.declaration);
  }
  const outcome = await deps.worker.call("plan.read", { projectId, planId }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const plan = parseStrict(verificationPlanSchema, outcome.value);
  if (!plan.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "plan-shape", "the worker did not answer with a verification plan", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, plan.value);
}

async function readGraph(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  // The target is optional and named in the query, because the read's reply already says
  // which target it chose. A malformed name is refused here rather than reaching the
  // worker, so the operator sees "that is not an identifier" and not a lookup miss.
  const targetId = ctx.request.query.targetId;
  if (targetId !== undefined && !isId(targetId)) {
    return refused(ctx.requestId, "INVALID_INPUT", "graph-target-id-malformed", "the target identifier in the query is not an id", ctx.declaration);
  }
  const outcome = await deps.worker.call(
    "graph.read",
    { projectId, request: targetId === undefined ? {} : { targetId } },
    ctx.actor,
  );
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const view = parseStrict(graphViewSchema, outcome.value);
  if (!view.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "graph-view-shape", "the worker did not answer with a graph view", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, view.value);
}

async function createExport(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const parsed = parseStrict(exportCreateRequestSchema, body.value);
  if (!parsed.ok) {
    return errorResponse(
      ctx.requestId,
      {
        code: "INVALID_INPUT",
        message: "the export request does not match the named schema",
        details: { fields: parsed.error.issues.map((issue) => issue.path) },
      },
      ctx.declaration,
    );
  }
  const outcome = await deps.worker.call(
    "export.create",
    { projectId, request: { candidateId: parsed.value.candidateId, verificationId: parsed.value.verificationId ?? null, label: parsed.value.label } },
    ctx.actor,
  );
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  // §8's 201 body is five named fields; the command's reply is checked against that
  // contract rather than forwarded as whatever the worker happened to return.
  const created = parseStrict(exportRecordSchema, pickFields(outcome.value, ["id", "label", "downloadUrl", "sha256", "manifest"]));
  if (!created.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "export-shape", "the worker did not answer with a created export", ctx.declaration);
  }
  if (!isRelativeDownloadUrl(String(created.value.downloadUrl))) {
    // A package that names somewhere other than this workbench's own route would be a way
    // for the worker's reply to point a browser elsewhere.
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "download-url-not-relative", "the download route must be relative to this API", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 201, created.value);
}

async function downloadExport(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const rawExportId = ctx.params.exportId ?? "";
  if (!isId(rawExportId)) return unknownExport(ctx);
  const outcome = await deps.worker.call(
    "export.download",
    { projectId, request: { exportId: asId(rawExportId) } },
    ctx.actor,
  );
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const archive = parseStrict(exportArchiveSchema, outcome.value);
  if (!archive.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "archive-shape", "the worker did not answer with a package archive", ctx.declaration);
  }
  const decoded = canonicalBase64Bytes(archive.value.bytesBase64);
  if (decoded === null) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "archive-base64", "the package bytes were not canonical base64", ctx.declaration);
  }
  if (decoded.byteLength !== archive.value.byteLength) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "archive-byte-length", "the package length the worker recorded does not match its bytes", ctx.declaration);
  }
  return {
    kind: "response",
    status: 200,
    headers: [
      ["content-type", archive.value.mediaType],
      ["content-length", String(archive.value.byteLength)],
      ["x-content-type-options", "nosniff"],
      ["content-disposition", `attachment; filename="rea-export-${archive.value.exportId}.zip"`],
      ["x-rea-export-sha256", archive.value.sha256],
      ["x-request-id", ctx.requestId],
      ["referrer-policy", "no-referrer"],
      ["cache-control", "no-store"],
    ],
    body: decoded,
  };
}

// Base64 that is not canonical in both directions is refused rather than decoded
// leniently: the same bytes under two spellings would mean a package identity that
// depends on how the transport happened to encode it (§4).
function canonicalBase64Bytes(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return null;
  return new Uint8Array(bytes);
}

function projectFromPath(ctx: Context): Id | null {
  const raw = ctx.params.projectId ?? "";
  return isId(raw) ? asId(raw) : null;
}

function unknownProject(ctx: Context): ApiResponse {
  return refused(ctx.requestId, "NOT_FOUND", "project-unknown", "no project is addressed by that identifier", ctx.declaration);
}

function unknownExport(ctx: Context): ApiResponse {
  return refused(ctx.requestId, "NOT_FOUND", "export-unknown", "no export is addressed by that identifier", ctx.declaration);
}

async function streamEvents(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const raw = ctx.params.projectId ?? "";
  if (!isId(raw)) {
    // An opaque id that is not one cannot name a project, and §8 authorises a path id by
    // matching the project rather than by being believed.
    return refused(ctx.requestId, "NOT_FOUND", "project-unknown", "no project is addressed by that identifier", ctx.declaration);
  }
  const projectId = asId(raw);
  const known = await deps.worker.call("project.get", { projectId }, ctx.actor);
  if (!known.ok) return fromWorker(ctx.requestId, known.error, ctx.declaration);
  return await openEventStream(
    {
      worker: deps.worker,
      actor: ctx.actor,
      requestId: ctx.requestId,
      declaration: ctx.declaration,
      pollMs: deps.stream.pollMs,
      sleep: deps.stream.sleep,
    },
    {
      projectId,
      lastEventId: ctx.request.headers["last-event-id"] ?? null,
      after: ctx.request.query.after ?? null,
    },
  );
}

export type ApiHandler = (request: HttpRequest) => Promise<ApiResponse>;

export function createApiHandler(deps: ApiDependencies): ApiHandler {
  return async function handle(request: HttpRequest): Promise<ApiResponse> {
    const requestId = newId();
    const declaration = requestDeclarations(request.body, request.headers.cookie);
    const record = (
      route: string,
      status: number,
      sessionState: "paired" | "anonymous" | "revoked",
    ): void => {
      deps.access.record({ method: request.method, route, status, requestId, sessionState }, declaration);
    };

    // 1. Host, before routing: a request that names some other address must not learn
    //    which routes exist (§8, §14).
    if (!hostAllowed(request.headers.host, deps.address)) {
      const response = refused(requestId, "ACCESS_DENIED", "host-not-accepted", "the Host header is not the loopback address this workbench bound", declaration);
      record("unrouted", response.status, "anonymous");
      return response;
    }
    const matched = matchRoute(request.method, request.path);
    if (matched === null) {
      const response = refused(requestId, "NOT_FOUND", "route-unknown", "no API route matches this method and path", declaration);
      record("unrouted", response.status, "anonymous");
      return response;
    }
    const { route, params } = matched;
    const routeName = `${route.method} ${route.template}`;

    // 2. Origin: every state change and the pairing exchange. A GET carries no Origin
    //    from a same-origin browser page, so requiring it there would be a rule that
    //    only real clients fail (§8 通用规则).
    if (route.method !== "GET" && !originAllowed(request.headers.origin, deps.address)) {
      const response = refused(requestId, "ACCESS_DENIED", "origin-not-same-source", "the Origin header is not this same-origin loopback address", declaration);
      record(routeName, response.status, "anonymous");
      return response;
    }

    let session: CurrentSession | null = null;
    let sessionKey = "";
    if (route.requiresSession) {
      sessionKey = readCookie(request.headers.cookie, SESSION_COOKIE_NAME) ?? "";
      if (sessionKey.length === 0) {
        const response = refused(requestId, "SESSION_REQUIRED", "cookie-absent", "this request needs the local session cookie", declaration);
        record(routeName, response.status, "anonymous");
        return response;
      }
      // The session is the worker's to answer for; §14 keeps it in that process's memory,
      // so a restart, an expiry or a revocation is felt on the next request rather than
      // whenever this process next feels like re-reading a table.
      const outcome = await deps.worker.call("session.read", { sessionKey }, UNPAIRED_ACTOR);
      if (!outcome.ok) {
        const response = fromWorker(requestId, outcome.error, declaration);
        record(routeName, response.status, "revoked");
        return response;
      }
      const view = parseStrict(currentSessionSchema, {
        ...jsonRecord(outcome.value),
        role: LOCAL_ROLE,
      });
      if (!view.ok) {
        const response = refused(requestId, "REA_CONTRACT_MISMATCH", "session-reply", "the worker's session answer does not match the contract", declaration);
        record(routeName, response.status, "revoked");
        return response;
      }
      session = view.value;
    }

    // 3. CSRF, compared only ever against the secret the worker issued to this session.
    if (route.mutating && !csrfMatches(request.headers[CSRF_HEADER_NAME], session === null ? "" : session.csrfToken)) {
      const response = refused(requestId, "ACCESS_DENIED", "csrf-token-missing", "a mutating request must carry the session's X-CSRF-Token", declaration);
      record(routeName, response.status, session === null ? "anonymous" : "paired");
      return response;
    }

    const ctx: Context = {
      request,
      requestId,
      declaration,
      actor: session === null ? UNPAIRED_ACTOR : { actorId: session.reviewerId, actorKind: "reviewer" },
      params,
      sessionKey,
      session,
    };

    let response: ApiResponse;
    if (route.method === "POST" && route.template === `${API_PREFIX}/session`) {
      response = await pairSession(ctx, deps);
    } else if (route.method === "GET" && route.template === `${API_PREFIX}/session`) {
      response = readSession(ctx);
    } else if (route.method === "DELETE" && route.template === `${API_PREFIX}/session`) {
      response = await revokeSession(ctx, deps);
    } else if (route.template === `${API_PREFIX}/health`) {
      response = await readHealth(ctx, deps);
    } else if (route.method === "POST" && route.template === `${API_PREFIX}/projects`) {
      if (!isIdempotencyKey(request.headers["idempotency-key"])) {
        response = refused(requestId, "INVALID_INPUT", "idempotency-key-required", "this creation needs an Idempotency-Key header", declaration);
      } else {
        response = await createProject(ctx, deps, request.headers["idempotency-key"] as string);
      }
    } else if (route.method === "GET" && route.template.endsWith("/exports/:exportId/download")) {
      response = await downloadExport(ctx, deps);
    } else if (route.method === "POST" && route.template.endsWith("/exports")) {
      response = await createExport(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/exports")) {
      response = await listExports(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/files/:fileId")) {
      response = await readCandidateFile(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/candidates/:candidateId")) {
      response = await readCandidate(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/graph")) {
      response = await readGraph(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/jobs")) {
      response = await listJobs(ctx, deps);
    } else if (route.method === "GET" && route.template === `${API_PREFIX}/audit`) {
      // Before the project-scoped suffix test: `${API_PREFIX}/audit` also ends with
      // `/audit`, and letting the scoped branch claim it would turn the unrooted journal
      // into a "project unknown" answer.
      response = await readGlobalAudit(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/audit")) {
      response = await readProjectAudit(ctx, deps);
    } else if (route.method === "GET" && route.template === `${API_PREFIX}/projects/:projectId`) {
      response = await readProject(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/jobs/:jobId")) {
      response = await readJob(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/evidence/:evidenceId")) {
      response = await readEvidence(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/vectors")) {
      response = await readVectorPage(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/vectors/:vectorId")) {
      response = await readVector(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/verification-plans/:planId")) {
      response = await readPlan(ctx, deps);
    } else if (route.template.endsWith("/events")) {
      response = await streamEvents(ctx, deps);
    } else {
      response = refused(requestId, "NOT_FOUND", "route-unhandled", "the matched route has no handler", declaration);
    }

    record(routeName, response.status, session === null ? "anonymous" : "paired");
    return response;
  };
}


import {
  bootstrapExchangeSchema,
  currentSessionSchema,
  pairedSessionSchema,
  revokedSessionSchema,
  sessionViewSchema,
} from "../../packages/contracts/session.ts";
import type { CurrentSession } from "../../packages/contracts/session.ts";
import { createProjectRequestSchema, createUrlTargetRequestSchema, createdProjectSchema, evidenceViewSchema, projectPageSchema, projectViewSchema, targetCreatedSchema, targetViewSchema } from "../../packages/contracts/resources.ts";
import { contractCommitReceiptSchema, contractDraftRequestSchema, contractRevisionSchema, contractReviewHttpRequestSchema, planBuildHttpRequestSchema, planCommitReceiptSchema, planReviewHttpRequestSchema, verificationPlanSchema } from "../../packages/contracts/behaviors.ts";
import { comparatorPolicyReadSchema, verificationReportSchema, verificationRequestSchema } from "../../packages/contracts/verification.ts";
import { blueprintFreezeHttpRequestSchema, blueprintFreezeReceiptSchema, blueprintReadSchema } from "../../packages/contracts/blueprint.ts";
import { testVectorSchema, vectorCreateRequestSchema, vectorPageSchema, vectorCommitReceiptSchema, vectorReviewHttpRequestSchema } from "../../packages/contracts/vectors.ts";
import { exportArchiveSchema, exportCreateRequestSchema, exportListSchema, exportRecordSchema } from "../../packages/contracts/export.ts";
import { cancelRequestSchema, cleanupRetryReceiptSchema, jobPageSchema, jobRecordSchema, jobRequestSchema } from "../../packages/contracts/jobs.ts";
import type { JobRecord } from "../../packages/contracts/jobs.ts";
import { CAPTURE_MEDIA_TYPES, harImportHttpResponseSchema } from "../../packages/contracts/imports.ts";
import { instantSchema } from "../../packages/contracts/primitives.ts";
import { auditPageSchema } from "../../packages/contracts/audit.ts";
import { isRelativeDownloadUrl } from "../../packages/domain/export.ts";
import { healthResponseSchema } from "../../packages/contracts/health.ts";
import { graphViewSchema } from "../../packages/contracts/graph.ts";
import { candidateFileContentSchema, candidateRequestSchema, candidateViewSchema } from "../../packages/contracts/candidate.ts";
import { parseStrict } from "../../packages/contracts/parse.ts";
import type { JsonSchema } from "../../packages/contracts/parse.ts";
import type { NamedErrorCode } from "../../packages/contracts/errors.ts";
import type { CanonicalLimits } from "../../packages/domain/canonical-json.ts";
// The digest owner is the domain module, and apps/web may not import node:crypto (§3). That is not a
// inconvenience: the declared `sourceSha256` an upload carries has to be produced by the same function
// the worker will re-measure with, or the two sides would disagree about what the same bytes hash to.
import { digestBytes } from "../../packages/domain/canonical-json.ts";
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
// The storable half of a task, decided by the module that owns the rule. The door needs it for one
// thing - the digest it stores must not contain a secret - and re-implementing the field list here
// would be a second copy of §12.1 that could disagree with the first.
import { taskForStorage } from "../../packages/application/job-request.ts";
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

// §12 measures before it allocates, and the two budgets bound different things: these named
// commands are small JSON bodies, while §8 line 272's import carries a file. Reading them under
// one number would mean either refusing every realistic HAR or holding JSON routes to a
// megabyte budget they have no reason to trust, so the transport picks by content type.
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

// The whole multipart body.
export const MAX_UPLOAD_BODY_BYTES = 6 * 1024 * 1024;

// The `file` part inside it. This number is derived rather than chosen: the bytes cross to the
// worker as base64 inside one RPC frame, and that frame is capped at 8 MiB by
// `MAX_FRAME_BYTES` in apps/worker/rpc-server.ts. base64 of n bytes is 4·ceil(n/3), so a 5 MiB
// part is ~6.67 MiB of text and leaves the JSON envelope room beside it. A larger upload needs a
// chunked staging handoff this build does not have; the door names that limit instead of letting
// the frame cap surface as a transport error nobody declared.
export const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;

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
  // §8 line 270's project page. It is the one list in this table that is not scoped to a project,
  // so it is also the one read whose actor rule (§7.3: 仅本地操作者) is decided inside the service
  // rather than by a project id on the path.
  { method: "GET", template: `${API_PREFIX}/projects`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
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
  // Which comparator names this build installed (issue #82). The second route in this adapter that
  // §8's table does not list (the first is `GET /projects/:p/exports`), and the reason is the same:
  // the write door needs a name from this list, and a table the caller cannot read turns "am I right"
  // into a journalled refusal. Recorded as a deviation rather than silently extended.
  { method: "GET", template: `${API_PREFIX}/comparator-policies`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
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
  // The contract and the report reads (§8 lines 288 and 298). Both services have owned their
  // rules for a while — including the refusal that keeps a Builder out of the control-plane
  // contract and out of a report's case list — but with no door those rules existed only where
  // a test asked for them (issue #58).
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/contracts/:contractId`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/verifications/:verificationId`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  // The blueprint read (§8 line 293): the frozen handoff, its digest and - for this role - the
  // plan it was cut from. No route here reaches a source manifest or a holdout list; §8 says so
  // for every role, and `blueprintReadSchema` has no field they could arrive in.
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/blueprints/:blueprintId`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  // The two target routes (§8 lines 273-274). The declaration is not in §8 line 261's list of
  // creations that carry an Idempotency-Key, so the door honours the document literally and the
  // replay question - what does a retried declaration make? - is answered by the row's identity
  // being fresh each time. Recorded as a deviation on issue #58 rather than fixed by invention.
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/targets`, mutating: true, requiresSession: true, requiresIdempotencyKey: false },
  { method: "GET", template: `${API_PREFIX}/projects/:projectId/targets/:targetId`, mutating: false, requiresSession: true, requiresIdempotencyKey: false },
  // The three review writes (§8 lines 285, 287, 291). Session-bound and mutating, and - unlike
  // the creations §8 line 261 lists - they take no Idempotency-Key: a review carries its own
  // conflict token (the digest it looked at, and for the inventory-bound two the revision they
  // were cut from), so a replay is a 409 rather than something to deduplicate.
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/vectors/:vectorId/review`, mutating: true, requiresSession: true, requiresIdempotencyKey: false },
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/contracts/:contractId/review`, mutating: true, requiresSession: true, requiresIdempotencyKey: false },
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/verification-plans/:planId/review`, mutating: true, requiresSession: true, requiresIdempotencyKey: false },
  // The three creation doors (§8 lines 282, 286, 289). Vectors and plans are among the creations
  // §8 line 261 names, so they carry an Idempotency-Key; contracts are not on that list, and the
  // door honours the document literally rather than inventing a key for a row the service already
  // versions. Bodies are the service's own schemas, so a field §8 names that nothing stores
  // (`sensitiveValues` at a vector create, `expectedGraphRevision` at a plan or contract create) is
  // a named refusal, not a silent drop - recorded as deviations on issue #58.
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/vectors`, mutating: true, requiresSession: true, requiresIdempotencyKey: true },
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/contracts`, mutating: true, requiresSession: true, requiresIdempotencyKey: false },
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/verification-plans`, mutating: true, requiresSession: true, requiresIdempotencyKey: true },
  // The freeze (§8 line 292). Unlike the three review doors, this one is a *creation* named in
  // §8 line 261, so it carries an Idempotency-Key: a retried freeze must replay the blueprint it
  // already made rather than mint a second one beside it.
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/blueprints`, mutating: true, requiresSession: true, requiresIdempotencyKey: true },
  // Asking for a verification (§8 line 297). Keyed because §8 line 261 lists it among the
  // creations, and the answer is 202 rather than 201: what this creates is a job that has not
  // run yet, so there is no report to point at on the way out.
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/verifications`, mutating: true, requiresSession: true, requiresIdempotencyKey: true },
  // The upload (§8 line 272). `mutating` because it is a POST, so Host, Origin, session and CSRF
  // all apply before a single byte of the file is looked at; keyed because §8 line 261 names
  // import among the creations. The body is multipart, so this is the one route the JSON budget
  // above does not govern.
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/imports`, mutating: true, requiresSession: true, requiresIdempotencyKey: true },
  // Asking for work against a target (§8 line 275) - the last row in §8's table this build can mount.
  // Keyed because §8 line 261 lists `job` among the creations, and answered with a `Location` header
  // because §8's third column names one. The body is the task union, so this is also the only route
  // whose request can carry short-lived secrets: they are neither stored nor digested (§12.1), and
  // that is decided in the service rather than here, so the door cannot be talked into keeping them.
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/jobs`, mutating: true, requiresSession: true, requiresIdempotencyKey: true },
  // The two lifecycle writes (§8 lines 278-279). Only the cleanup retry is in §8 line 261's list of
  // keyed operations, and §8 line 279 says so itself (需幂等键与本地会话); the cancel door therefore
  // takes no key and its repeat-safety comes from the state machine, not from a journal.
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/jobs/:jobId/cancel`, mutating: true, requiresSession: true, requiresIdempotencyKey: false },
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/jobs/:jobId/cleanup-retry`, mutating: true, requiresSession: true, requiresIdempotencyKey: true },
  // The candidate file read (§8 lines 295-296 / issue #19). Two GETs, both session-bound:  // the first lists the files a candidate published, the second returns one file's content
  // selected by manifest file id. Neither takes a path.
  // §8 line 294: asking for a generation. It is a creation, so it carries the key, and its body is
  // the whole of what a caller may name - a blueprint and at most a deadline. The job id, the
  // attempt budget and the generator identity are the worker's (§11, §7.3, issue #57).
  { method: "POST", template: `${API_PREFIX}/projects/:projectId/candidates`, mutating: true, requiresSession: true, requiresIdempotencyKey: true },
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

// Only a failure read off the worker's socket arrives here, and both ends of that socket apply
// the declared-key list (§12.1), so this hop adds no filter of its own - three copies of one
// rule would only create a third thing that can drift. What it owns is the shape: `reason`
// first, because the page's contract reads the reason out of `details`, then the numbers the
// worker published (§8's ApiError.details).
function fromWorker(requestId: string, failure: WorkerFailure, declaration: SensitiveDeclaration): ApiResponse {
  return errorResponse(
    requestId,
    { code: failure.code, message: failure.message, details: { reason: failure.reason, ...failure.details } },
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

// POST /projects. §8's 201 body is four named fields, and the journaling is the shared one -
// a second copy of "digest, claim, abandon, record" is a second thing that can drift from the
// first, and this route was the last creation still carrying its own.
async function createProject(ctx: Context, deps: ApiDependencies, key: string): Promise<ApiResponse> {
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const parsed = parseStrict(createProjectRequestSchema, body.value);
  if (!parsed.ok) return invalidBody(ctx, "the project request does not match the named schema", parsed.error);
  return commitCreation(ctx, deps, {
    key,
    scope: `${API_PREFIX}/projects`,
    template: `${API_PREFIX}/projects`,
    command: "project.create",
    payload: parsed.value,
    body: parsed.value,
    projection: COMMIT_PROJECTIONS.project,
  });
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

// Issue #82: the read §8's table lacks and §8 line 297 needs. A session, no body, the worker's
// answer checked against its named schema - like the reads above. Two things this door does *not*
// do: it does not sort (the installed order is the code's, and a reordering could be read as a
// ranking - putting the looser policy first would be precisely §10's mistake), and it adds no
// `default` or `recommended` field. The page that shows this list has to leave the choice unmade,
// which is what its empty first option is for.
async function readComparatorPolicies(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const outcome = await deps.worker.call("comparator.list", {}, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const parsed = parseStrict(comparatorPolicyReadSchema, outcome.value);
  if (!parsed.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "comparator-policy-shape", "the worker did not answer with the comparator policies it installed", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, parsed.value);
}

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

// --- The creation doors (§8 lines 282, 286, 289 / issue #58) ---------------------------
//
// Each door forwards the body the service already parses - one definition of a create request,
// so the door cannot drift from the service - and answers with the same commit receipt its review
// sibling uses, because creation and review are both statements about one row. The only mapping
// is a name: §8 calls the plan's exclusion list `exclusions`, the service calls the identical
// list `excludedVectors`, and the door translates in one line rather than redeclaring the items.
async function createVector(ctx: Context, deps: ApiDependencies, key: string): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const parsed = parseStrict(vectorCreateRequestSchema, body.value);
  if (!parsed.ok) return invalidBody(ctx, "the vector request does not match the named schema", parsed.error);
  return commitCreation(ctx, deps, {
    key,
    scope: `${API_PREFIX}/projects/${String(projectId)}/vectors`,
    template: `${API_PREFIX}/projects/:projectId/vectors`,
    command: "vector.create",
    payload: { projectId, request: parsed.value },
    body: parsed.value,
    projection: COMMIT_PROJECTIONS.vector,
  });
}

async function createContract(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const parsed = parseStrict(contractDraftRequestSchema, body.value);
  if (!parsed.ok) return invalidBody(ctx, "the contract request does not match the named schema", parsed.error);
  // No journal: §8 line 261 does not list contract among the keyed creations, so a retried body
  // here is the service's own question (it versions by content), not one this process answers.
  const outcome = await deps.worker.call("contract.create", { projectId, request: parsed.value }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const projected = projectCommit(ctx, outcome.value, COMMIT_PROJECTIONS.contract);
  if (!projected.ok) return projected.response;
  return jsonSuccess(ctx.requestId, 201, projected.value);
}

async function createPlan(ctx: Context, deps: ApiDependencies, key: string): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const parsed = parseStrict(planBuildHttpRequestSchema, body.value);
  if (!parsed.ok) return invalidBody(ctx, "the plan request does not match the named schema", parsed.error);
  return commitCreation(ctx, deps, {
    key,
    scope: `${API_PREFIX}/projects/${String(projectId)}/verification-plans`,
    template: `${API_PREFIX}/projects/:projectId/verification-plans`,
    command: "plan.build",
    payload: {
      projectId,
      request: {
        targetId: parsed.value.targetId,
        snapshotDigest: parsed.value.snapshotDigest,
        contractRevisionIds: parsed.value.contractRevisionIds,
        excludedVectors: parsed.value.exclusions,
        expectedInventoryRevision: parsed.value.expectedInventoryRevision,
      },
    },
    body: parsed.value,
    projection: COMMIT_PROJECTIONS.plan,
  });
}

// --- The review routes (§8 lines 285, 287, 291 / issue #58) ---------------------------
//
// One rule these three share that is not written in §8's table: **the reviewer is the session,
// never the body.** Each service stores the reviewer id inside the durable review record - the
// same record a blueprint freeze later cites - so a route that relayed a caller-named reviewer
// would let one session write another reviewer's approval into the artifact the freeze depends
// on. The request schemas are `strictObject` without that field, which turns a caller who sends
// `reviewerId` (or §8's `note`, which has no storage owner anywhere) into a 400 naming the field,
// rather than a suggestion the route quietly honours or drops.
// One projection per record type. The create door and the review door answer about the same row,
// so the field list, the schema and the name of a malformed answer live here once. Written out
// twice, they are two lists that can drift - the field list below is what makes a receipt a named
// contract rather than a dump of whatever the command happened to return.
type CommitProjection = {
  readonly fields: readonly string[];
  readonly schema: JsonSchema;
  readonly reason: string;
  readonly message: string;
};

// §8's JobRecord is the answer of three doors - the queued job (line 275), the build (line 294) and
// the verification (line 297) - and each of them parses it with the same schema. The *list* of names
// to pick out of the worker's receipt was written per door, which is three lists that can drift away
// from the schema they are checked against; this one constant is why they cannot, and the `satisfies`
// is what makes adding a field to §8's JobRecord show up here as a compile error rather than as a
// door that quietly stopped answering it.
const JOB_RECORD_FIELDS = [
  "id",
  "kind",
  "state",
  "cleanupState",
  "deadlineAt",
  "retryAt",
  "cleanupRetryAt",
  "resultRef",
  "error",
] as const satisfies readonly (keyof JobRecord)[];

const COMMIT_PROJECTIONS = {
  project: {
    fields: ["id", "name", "graphRevision", "createdAt"],
    schema: createdProjectSchema,
    reason: "project-shape",
    message: "the worker did not answer with a created project",
  },
  vector: {
    fields: ["vectorId", "digest", "eligibility", "reasons", "inventoryRevision", "auditSeq", "eventSeq"],
    schema: vectorCommitReceiptSchema,
    reason: "vector-commit-shape",
    message: "the worker did not answer with a vector commit",
  },
  contract: {
    fields: ["contractId", "contractKey", "revision", "digest", "reviewStatus", "auditSeq", "eventSeq"],
    schema: contractCommitReceiptSchema,
    reason: "contract-commit-shape",
    message: "the worker did not answer with a contract commit",
  },
  plan: {
    fields: ["planId", "digest", "inventoryDigest", "selectedCount", "excludedCount", "graphRevision", "inventoryRevision", "reviewStatus", "auditSeq", "eventSeq"],
    schema: planCommitReceiptSchema,
    reason: "plan-commit-shape",
    message: "the worker did not answer with a plan commit",
  },
  blueprint: {
    fields: ["blueprintId", "digest", "manifestDigest", "planId", "publicVectorCount", "holdoutVectorCount", "contractCount", "auditSeq"],
    schema: blueprintFreezeReceiptSchema,
    reason: "blueprint-freeze-shape",
    message: "the worker did not answer with a frozen blueprint",
  },
  cleanup: {
    fields: ["jobId", "cleanupState", "retryAt", "leaseIds", "auditSeq"],
    schema: cleanupRetryReceiptSchema,
    reason: "cleanup-retry-shape",
    message: "the worker did not answer with a cleanup retry",
  },
  // §8 line 297's 202 body is a JobRecord, so this door projects the very schema the job read
  // doors use. Written twice it would be two field lists that can drift apart, and the queued job
  // the request answers with is the same row a later `GET /jobs/:j` reads back.
  verification: {
    fields: JOB_RECORD_FIELDS,
    schema: jobRecordSchema,
    reason: "verification-request-shape",
    message: "the worker did not answer with a queued verification job",
  },
  // §8 line 294's 202 body is the same JobRecord shape, and it is the same row: the build job this
  // request writes is what the runner later settles, so the answer and the read-back are one
  // projection with two readers.
  candidate: {
    fields: JOB_RECORD_FIELDS,
    schema: jobRecordSchema,
    reason: "candidate-request-shape",
    message: "the worker did not answer with a queued build job",
  },
  // §8 line 275's 202 is the same row shape again: the job this request queued is what `GET /jobs/:j`
  // reads back and what `job.updated` names, so the door has no field list of its own to drift.
  job: {
    fields: JOB_RECORD_FIELDS,
    schema: jobRecordSchema,
    reason: "job-request-shape",
    message: "the worker did not answer with a queued job",
  },
  // §8 line 272's 202 body is `{targetId,job}` and nothing else. The worker's receipt also names
  // the lease and the source artifact it minted; those are real, but this route's third column
  // does not list them, so they stay on the service side instead of becoming an undocumented answer.
  import: {
    fields: ["targetId", "job"],
    schema: harImportHttpResponseSchema,
    reason: "import-shape",
    message: "the worker did not answer with an imported target and its job",
  },
} as const satisfies Record<string, CommitProjection>;

function projectCommit(
  ctx: Context,
  value: JsonValue,
  projection: CommitProjection,
): { ok: true; value: JsonValue } | { ok: false; response: ApiResponse } {
  const parsed = parseStrict(projection.schema, pickFields(value, projection.fields));
  if (!parsed.ok) {
    return { ok: false, response: refused(ctx.requestId, "REA_CONTRACT_MISMATCH", projection.reason, projection.message, ctx.declaration) };
  }
  return { ok: true, value: parsed.value };
}

// A body that does not match its named schema. Field paths and the names of rejected keys, never
// the values that came with them (§12.1) - a caller has to learn what to remove, and echoing a
// rejected value would put the request's own text into the answer.
type ParseFailureLike = { issues: { path: string; keys?: string[] }[] };

function invalidBody(ctx: Context, message: string, failure: ParseFailureLike): ApiResponse {
  return errorResponse(ctx.requestId, {
    code: "INVALID_INPUT",
    message,
    details: { fields: failure.issues.map((issue) => issue.path), rejectedKeys: failure.issues.flatMap((issue) => issue.keys ?? []) },
  }, ctx.declaration);
}

// A creation over HTTP, in one place: digest the canonical request, claim the key, call the
// command, and only record a 201 once the reply has been projected through its named schema.
// A refusal gives the key back (§8 line 261 says 同键可重试), and a reply that does not fit the
// contract is a REA_CONTRACT_MISMATCH rather than a dump of what the command happened to return.
// The journal scope carries the concrete path (two projects must not share one key) while the
// digest is taken over the template, which is what makes a replay by body rather than by URL.
async function commitCreation(
  ctx: Context,
  deps: ApiDependencies,
  input: {
    key: string;
    scope: string;
    template: string;
    command: string;
    payload: Record<string, JsonValue>;
    body: JsonValue;
    projection: CommitProjection;
    // §8's creations answer 201 and its keyed lifecycle write answers 202, so the status is named by
    // the caller and recorded with the answer it replays.
    status?: number;
    // A route §8 gives a `Location` header (line 275). It is *derived from the recorded body* on
    // both the first answer and a replay, rather than journaled as a second copy: the header and the
    // body must not be able to name different rows, and the row id is already in the body.
    locate?: (body: JsonValue) => string;
  },
): Promise<ApiResponse> {
  const located = (body: JsonValue): [string, string][] => (input.locate === undefined ? [] : [["location", input.locate(body)]]);
  const digest = idempotencyDigest({ route: input.template, method: "POST", body: input.body }, ctx.declaration, deps.limits);
  if (!digest.ok) return refused(ctx.requestId, digest.error.code, digest.error.reason, digest.error.message, ctx.declaration);
  const scope = journalScope(String((ctx.session as CurrentSession).reviewerId), input.scope);
  const claim = deps.journal.claim(scope, input.key, digest.value);
  if (claim.kind === "divergent") {
    return refused(ctx.requestId, "IDEMPOTENCY_CONFLICT", "idempotency-key-reused", "that idempotency key already carries a different request", ctx.declaration);
  }
  if (claim.kind === "inFlight") {
    return refused(ctx.requestId, "IDEMPOTENCY_CONFLICT", "idempotency-key-in-flight", "the first request with that key has not produced a result yet", ctx.declaration);
  }
  if (claim.kind === "replay") {
    return jsonSuccess(ctx.requestId, claim.recorded.status, claim.recorded.body, located(claim.recorded.body));
  }
  const outcome = await deps.worker.call(input.command, input.payload, ctx.actor);
  if (!outcome.ok) {
    deps.journal.abandon(scope, input.key);
    return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  }
  const receipt = projectCommit(ctx, outcome.value, input.projection);
  if (!receipt.ok) {
    // A creation that produced something this process cannot name is still a refusal, so the key
    // goes back to the caller rather than being pinned to an answer it never got.
    deps.journal.abandon(scope, input.key);
    return receipt.response;
  }
  const status = input.status ?? 201;
  deps.journal.record(scope, input.key, digest.value, { status, body: receipt.value });
  return jsonSuccess(ctx.requestId, status, receipt.value, located(receipt.value));
}

type ReviewInput = { decision: "approved" | "rejected"; expectedDigest: JsonValue; expectedInventoryRevision?: number };

type ReviewBody = { ok: true; request: ReviewInput } | { ok: false; response: ApiResponse };

function reviewBody(ctx: Context, schema: Parameters<typeof parseStrict>[0]): ReviewBody {
  const body = readJsonBody(ctx);
  if (!body.ok) return { ok: false, response: body.response };
  const parsed = parseStrict(schema, body.value);
  if (!parsed.ok) return { ok: false, response: invalidBody(ctx, "the review request does not match the named schema", parsed.error) };
  // Which of the three schemas was handed in is what decides whether the inventory revision is
  // required, so a missing one is a schema refusal here rather than a second check that could
  // disagree with it.
  return { ok: true, request: parsed.value as ReviewInput };
}

// The service's own field names, with the reviewer written from the session rather than read
// from the caller: `expectedDigest` is §8's spelling for what the services call `digest`.
function reviewRequest(ctx: Context, request: ReviewInput): JsonObject {
  const stored: Record<string, JsonValue> = {
    decision: request.decision,
    reviewerId: String((ctx.session as CurrentSession).reviewerId),
    digest: request.expectedDigest,
  };
  if (request.expectedInventoryRevision !== undefined) stored.expectedInventoryRevision = request.expectedInventoryRevision;
  return stored;
}

// POST /projects/:p/blueprints (§8 line 292). The journal work mirrors `createProject` exactly:
// the key is only given back when nothing was produced, so a refusal the caller can correct stays
// retryable while a committed freeze replays its own 201.
async function freezeBlueprint(ctx: Context, deps: ApiDependencies, key: string): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const parsed = parseStrict(blueprintFreezeHttpRequestSchema, body.value);
  if (!parsed.ok) {
    return errorResponse(ctx.requestId, {
      code: "INVALID_INPUT",
      message: "the freeze request does not match the named schema",
      // Only the plan is named here; §7.4 derives the rest. Naming the rejected keys tells a
      // caller exactly which fields to take out (§12.1 publishes names, never values).
      details: { fields: parsed.error.issues.map((issue) => issue.path), rejectedKeys: parsed.error.issues.flatMap((issue) => issue.keys ?? []) },
    }, ctx.declaration);
  }
  return commitCreation(ctx, deps, {
    key,
    scope: `${API_PREFIX}/projects/${String(projectId)}/blueprints`,
    template: `${API_PREFIX}/projects/:projectId/blueprints`,
    command: "blueprint.freeze",
    payload: { projectId, request: { planId: parsed.value.verificationPlanId } },
    body: parsed.value,
    projection: COMMIT_PROJECTIONS.blueprint,
  });
}

// §8 line 297: asking for a verification. The body is `verificationRequestSchema` itself - the
// contract already spells §8's three fields, so the door reuses it instead of keeping a second
// copy that could drift. `comparatorPolicyId` is a name and the schema has no field for a policy
// body, which is the checkable form of 不接受代码: what this door can send is an id.
async function requestVerification(ctx: Context, deps: ApiDependencies, key: string): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const parsed = parseStrict(verificationRequestSchema, body.value);
  if (!parsed.ok) return invalidBody(ctx, "the verification request does not match the named schema", parsed.error);
  // Rebuilt field by field rather than forwarded whole, so an absent deadline stays absent instead
  // of arriving as a null the service's own schema would refuse.
  const request: Record<string, JsonValue> = {
    candidateId: parsed.value.candidateId,
    comparatorPolicyId: parsed.value.comparatorPolicyId,
  };
  if (parsed.value.deadlineAt !== undefined) request.deadlineAt = parsed.value.deadlineAt;
  return commitCreation(ctx, deps, {
    key,
    scope: `${API_PREFIX}/projects/${String(projectId)}/verifications`,
    template: `${API_PREFIX}/projects/:projectId/verifications`,
    command: "verification.request",
    payload: { projectId, idempotencyKey: key, request },
    body: request,
    projection: COMMIT_PROJECTIONS.verification,
    status: 202,
  });
}

// §8 line 294 from the browser's side. The body is `candidateRequestSchema` - a blueprint id and at
// most a deadline - and everything the old `candidate.generate` command used to take from the
// caller is gone with it: the job id, the attempt budget and the generator identity are facts the
// worker owns (issue #57), so this door has no field for them and a request that brings one is
// refused by name rather than honoured.
async function requestCandidate(ctx: Context, deps: ApiDependencies, key: string): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const parsed = parseStrict(candidateRequestSchema, body.value);
  if (!parsed.ok) return invalidBody(ctx, "the generation request does not match the named schema", parsed.error);
  const request: Record<string, JsonValue> = { blueprintId: parsed.value.blueprintId };
  if (parsed.value.deadlineAt !== undefined) request.deadlineAt = parsed.value.deadlineAt;
  return commitCreation(ctx, deps, {
    key,
    scope: `${API_PREFIX}/projects/${String(projectId)}/candidates`,
    template: `${API_PREFIX}/projects/:projectId/candidates`,
    command: "candidate.request",
    payload: { projectId, idempotencyKey: key, request },
    body: request,
    projection: COMMIT_PROJECTIONS.candidate,
    status: 202,
  });
}

// §8 line 275: asking for work against a target. The body is the document's own `jobRequestSchema`,
// task union included, which makes this the one creation whose request can carry short-lived secrets
// (`sensitiveValues` inside a capture task). The door hands the request over whole and the service
// decides what may be written down, so that rule has exactly one owner (§12.1); a door that filtered
// the secrets itself would be a second place that has to remember which fields are secret.
//
// The answer is the queued row plus §8's `Location` header, and the header is *derived* from the
// projected body's own id rather than journaled beside it - a replay must point at the row its body
// names, and two stored copies of that address are one way to make them disagree.
async function requestJob(ctx: Context, deps: ApiDependencies, key: string): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const parsed = parseStrict(jobRequestSchema, body.value);
  if (!parsed.ok) return invalidBody(ctx, "the job request does not match the named schema", parsed.error);
  const projectPath = String(projectId);
  // Two shapes leave this door and they are deliberately not the same object. The frame carries what
  // the caller sent, short-lived capture secrets included - the worker needs them to run the task, and
  // this is the same route `POST /imports` takes with its declared sensitive values. The *digest* the
  // journal stores is rebuilt from the storable half, because §12.1 says a persisted request digest
  // holds no sensitive original: pinning the whole body would put a secret into a column that outlives
  // the job, and a replay check that can see the secret is a disclosure surface wearing a hash.
  const digestBody: Record<string, JsonValue> = {
    targetId: parsed.value.targetId,
    expectedGraphRevision: parsed.value.expectedGraphRevision,
    task: taskForStorage(parsed.value.task),
  };
  if (parsed.value.deadlineAt !== undefined) digestBody.deadlineAt = parsed.value.deadlineAt;
  return commitCreation(ctx, deps, {
    key,
    scope: `${API_PREFIX}/projects/${projectPath}/jobs`,
    template: `${API_PREFIX}/projects/:projectId/jobs`,
    command: "job.request",
    payload: { projectId, idempotencyKey: key, request: body.value },
    body: digestBody,
    projection: COMMIT_PROJECTIONS.job,
    status: 202,
    locate: (record) => `${API_PREFIX}/projects/${projectPath}/jobs/${String((record as JobRecord).id)}`,
  });
}

// §8 line 272's body is multipart, so this is the one route that reads `bodyBytes`: a file part is
// arbitrary bytes, and the text view of them has already replaced every sequence that is not valid
// UTF-8. The named fields are exactly the four §8 lists - `file`, `kind`, `deadlineAt`,
// `sensitiveValues` - and a fifth name is refused by name rather than honoured: a door that accepts
// what the document does not name becomes the place where undocumented capabilities arrive. (The
// worker's own command does support a `recordOrdinals` selection; §8 line 272 does not list it, so
// it stays a service-side capability and the deviation is recorded on issue #58.)
const IMPORT_FIELDS: readonly string[] = ["file", "kind", "deadlineAt", "sensitiveValues"];
const IMPORT_KINDS: readonly string[] = ["har", "asar"];

async function importCapture(ctx: Context, deps: ApiDependencies, key: string): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const contentType = ctx.request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return refused(ctx.requestId, "INVALID_INPUT", "import-multipart-required", "the import body is multipart/form-data (§8 line 272)", ctx.declaration);
  }
  let form: FormData;
  try {
    form = await new Response(ctx.request.bodyBytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return refused(ctx.requestId, "INVALID_INPUT", "import-multipart-malformed", "the multipart body could not be parsed", ctx.declaration);
  }

  // Read before anything can be refused: §12.1 filters *every* message, detail and log line this
  // request produces against the caller's declared values, and the refusals below repeat a media
  // type and a kind the caller named. A declaration collected at the end of the door would have left
  // those echoes in place - which is what the test "never echoes a value the caller declared
  // sensitive" caught.
  const declaredValues = form.getAll("sensitiveValues").filter((value): value is string => typeof value === "string" && value.length > 0);
  const declaration: SensitiveDeclaration = { declaredValues: [...ctx.declaration.declaredValues, ...declaredValues] };

  const names = new Set(form.keys());
  const unexpected = [...names].filter((name) => !IMPORT_FIELDS.includes(name));
  if (unexpected.length > 0) {
    return refused(ctx.requestId, "INVALID_INPUT", "import-field-unsupported", "the import carries fields §8 line 272 does not name", declaration, { rejectedKeys: unexpected });
  }

  const parts = form.getAll("file");
  if (parts.length === 0) {
    return refused(ctx.requestId, "INVALID_INPUT", "import-file-part-missing", "the import needs a `file` part", declaration);
  }
  if (parts.length > 1) {
    return refused(ctx.requestId, "INVALID_INPUT", "import-file-part-duplicated", "one import carries exactly one file", declaration);
  }
  const part = parts[0];
  if (!(part instanceof File)) {
    return refused(ctx.requestId, "INVALID_INPUT", "import-file-part-not-file", "the `file` part must be a file, not a text field", declaration);
  }
  const allowedMediaTypes: readonly string[] = CAPTURE_MEDIA_TYPES;
  if (!allowedMediaTypes.includes(part.type)) {
    return refused(ctx.requestId, "UNSUPPORTED_FORMAT", "import-media-type-unsupported", "the upload's media type is not one the workbench ingests", declaration, { mediaType: part.type, allowed: [...allowedMediaTypes] });
  }
  const bytes = new Uint8Array(await part.arrayBuffer());
  if (bytes.byteLength === 0) {
    return refused(ctx.requestId, "INVALID_INPUT", "import-file-empty", "an empty file is not an import", declaration);
  }
  if (bytes.byteLength > MAX_UPLOAD_FILE_BYTES) {
    // Named here rather than left to the RPC frame: the frame limit is this process's transport,
    // and a caller that never learns which number it hit cannot fix the request.
    return refused(ctx.requestId, "RESOURCE_LIMIT", "import-file-too-large", "the upload is larger than one worker frame can carry", declaration, { byteLength: bytes.byteLength, maxBytes: MAX_UPLOAD_FILE_BYTES });
  }

  const kind = form.get("kind");
  if (typeof kind !== "string" || !IMPORT_KINDS.includes(kind)) {
    return refused(ctx.requestId, "INVALID_INPUT", "import-kind-unsupported", "the import names a kind §8 line 272 does not offer", declaration, { allowed: [...IMPORT_KINDS] });
  }
  // §8's own order: the unsupported projection is answered first, because that is the disagreement
  // the caller can act on. A caller who is told "this build cannot ingest ASAR" and a caller who is
  // told "ASAR carries no sensitive projection" are being asked to change different things.
  if (kind === "asar" && declaredValues.length > 0) {
    return refused(ctx.requestId, "SENSITIVE_PROJECTION_UNSUPPORTED", "import-asar-sensitive-values-unsupported", "the ASAR path records no short-lived sensitive declaration (§8 line 272: 不伪称上游支持)", declaration);
  }
  if (kind === "asar") {
    return refused(ctx.requestId, "CAPABILITY_UNAVAILABLE", "import-asar-not-wired", "this build wires the HAR ingestion loop only (README 还没有的东西)", declaration);
  }
  // Display text, never a path this process opens (§5): the bytes arrived in this request, and
  // nothing below reads the name again.
  const filename = part.name;
  const mediaType = part.type;
  const sourceSha256 = digestBytes(bytes);
  const safeBody: Record<string, JsonValue> = {
    filename,
    mediaType,
    format: "har",
    byteLength: bytes.byteLength,
    sourceSha256,
  };
  const command: Record<string, JsonValue> = { ...safeBody, idempotencyKey: key };
  const deadlineRaw = form.get("deadlineAt");
  if (deadlineRaw !== null) {
    const parsedDeadline = instantSchema.safeParse(deadlineRaw);
    if (!parsedDeadline.success) {
      return refused(ctx.requestId, "INVALID_INPUT", "import-deadline-malformed", "the deadline is not a UTC instant", declaration);
    }
    command.deadlineAt = parsedDeadline.data;
    safeBody.deadlineAt = parsedDeadline.data;
  }

  // The declaration travels to the worker for this task only (§8 line 261: 含短期敏感上下文的请求
  // 仅在该任务仍存活时核对). It never enters `safeBody`, which is the projection the replay digest
  // is taken over (§5: 显式敏感原文不进入持久 request_digest).
  const payload: Record<string, JsonValue> = {
    projectId,
    command,
    bytesBase64: Buffer.from(bytes).toString("base64"),
  };
  if (declaredValues.length > 0) payload.sensitiveValues = declaredValues;

  return commitCreation({ ...ctx, declaration }, deps, {
    key,
    scope: `${API_PREFIX}/projects/${String(projectId)}/imports`,
    template: `${API_PREFIX}/projects/:projectId/imports`,
    command: "capture.importHar",
    payload,
    body: safeBody,
    projection: COMMIT_PROJECTIONS.import,
    status: 202,
  });
}

async function reviewVector(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const vectorId = pathId(ctx, "vectorId");
  if (vectorId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "vector-id-malformed", "the vector segment of the path is not an opaque id", ctx.declaration);
  }
  const body = reviewBody(ctx, vectorReviewHttpRequestSchema);
  if (!body.ok) return body.response;
  const outcome = await deps.worker.call("vector.review", { projectId, vectorId, request: reviewRequest(ctx, body.request) }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const projected = projectCommit(ctx, outcome.value, COMMIT_PROJECTIONS.vector);
  if (!projected.ok) return projected.response;
  return jsonSuccess(ctx.requestId, 200, projected.value);
}

async function reviewContract(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const contractId = pathId(ctx, "contractId");
  if (contractId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "contract-id-malformed", "the contract segment of the path is not an opaque id", ctx.declaration);
  }
  const body = reviewBody(ctx, contractReviewHttpRequestSchema);
  if (!body.ok) return body.response;
  const outcome = await deps.worker.call("contract.review", { projectId, contractId, request: reviewRequest(ctx, body.request) }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const projected = projectCommit(ctx, outcome.value, COMMIT_PROJECTIONS.contract);
  if (!projected.ok) return projected.response;
  return jsonSuccess(ctx.requestId, 200, projected.value);
}

async function reviewPlan(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const planId = pathId(ctx, "planId");
  if (planId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "plan-id-malformed", "the plan segment of the path is not an opaque id", ctx.declaration);
  }
  const body = reviewBody(ctx, planReviewHttpRequestSchema);
  if (!body.ok) return body.response;
  const outcome = await deps.worker.call("plan.review", { projectId, planId, request: reviewRequest(ctx, body.request) }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const projected = projectCommit(ctx, outcome.value, COMMIT_PROJECTIONS.plan);
  if (!projected.ok) return projected.response;
  return jsonSuccess(ctx.requestId, 200, projected.value);
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

// §8 line 288: the stored contract revision, which is what the right-hand panel needs to
// re-open a contract it named by id. The reply is projected through the same schema the review
// door answers with, so one stored row cannot be described two different ways.
async function readContract(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  const contractId = pathId(ctx, "contractId");
  if (projectId === null) return unknownProject(ctx);
  if (contractId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "contract-id-malformed", "the contract segment of the path is not an opaque id", ctx.declaration);
  }
  const outcome = await deps.worker.call("contract.read", { projectId, contractId }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const revision = parseStrict(contractRevisionSchema, outcome.value);
  if (!revision.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "contract-shape", "the worker did not answer with a contract revision", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, revision.value);
}

async function listProjects(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  // The same shape the job page uses: a limit that is not a whole number is refused here rather
  // than turned into NaN on the way to the worker, and an absent page marker stays null.
  const rawLimit = ctx.request.query.limit;
  if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) {
    return refused(ctx.requestId, "INVALID_INPUT", "projects-limit-malformed", "the limit in the query is not a whole number", ctx.declaration);
  }
  const outcome = await deps.worker.call(
    "projects.list",
    { request: { cursor: ctx.request.query.cursor ?? null, limit: rawLimit === undefined ? null : Number(rawLimit) } },
    ctx.actor,
  );
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const page = parseStrict(projectPageSchema, outcome.value);
  if (!page.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "projects-shape", "the worker did not answer with a project page", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, page.value);
}

async function declareTarget(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  if (projectId === null) return unknownProject(ctx);
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  // §8's body is `{kind:'url',url}` and `createUrlTargetRequestSchema` has owned that shape since
  // the contracts were first written, so the door asks it rather than a second copy of itself.
  // A *file* kind is named before the parse because the schema can only say "not url" while the
  // operator needs the reason: a har or asar target is created by the import that brought it.
  const declared = jsonRecord(body.value);
  if (declared["kind"] === "har" || declared["kind"] === "asar") {
    return refused(ctx.requestId, "INVALID_INPUT", "target-kind-needs-import", "a har or asar target is created by the import that brought the file (§8 line 272)", ctx.declaration);
  }
  const request = parseStrict(createUrlTargetRequestSchema, declared);
  if (!request.ok) return invalidBody(ctx, "the target declaration does not match its contract", request.error);
  const outcome = await deps.worker.call("target.create", { projectId, request: request.value }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const created = parseStrict(targetCreatedSchema, outcome.value);
  if (!created.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "target-create-shape", "the worker did not answer with a created target", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 201, created.value);
}

async function readTarget(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  const targetId = pathId(ctx, "targetId");
  if (projectId === null) return unknownProject(ctx);
  if (targetId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "target-id-malformed", "the target segment of the path is not an opaque id", ctx.declaration);
  }
  const outcome = await deps.worker.call("target.read", { projectId, targetId }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const view = parseStrict(targetViewSchema, outcome.value);
  if (!view.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "target-shape", "the worker did not answer with a target view", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, view.value);
}

async function cancelJob(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  const jobId = pathId(ctx, "jobId");
  if (projectId === null) return unknownProject(ctx);
  if (jobId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "job-id-malformed", "the job segment of the path is not an opaque id", ctx.declaration);
  }
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const request = parseStrict(cancelRequestSchema, body.value);
  if (!request.ok) return invalidBody(ctx, "a cancel carries no fields", request.error);
  const outcome = await deps.worker.call("job.cancel", { projectId, jobId }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const record = parseStrict(jobRecordSchema, outcome.value);
  if (!record.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "job-cancel-shape", "the worker did not answer with a job record", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 202, record.value);
}

// §8 line 279: keyed, so a retry replays the same answer instead of scheduling the cleanup twice.
async function retryJobCleanup(ctx: Context, deps: ApiDependencies, key: string): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  const jobId = pathId(ctx, "jobId");
  if (projectId === null) return unknownProject(ctx);
  if (jobId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "job-id-malformed", "the job segment of the path is not an opaque id", ctx.declaration);
  }
  const body = readJsonBody(ctx);
  if (!body.ok) return body.response;
  const request = parseStrict(cancelRequestSchema, body.value);
  if (!request.ok) return invalidBody(ctx, "a cleanup retry carries no fields", request.error);
  return commitCreation(ctx, deps, {
    key,
    scope: `cleanup-retry:${jobId}`,
    template: `${API_PREFIX}/projects/:projectId/jobs/:jobId/cleanup-retry`,
    command: "job.cleanupRetry",
    payload: { projectId, jobId },
    body: request.value,
    projection: COMMIT_PROJECTIONS.cleanup,
    status: 202,
  });
}

// §8 line 293. One path segment, one id, no query: the blueprint is named, not searched, and
// the reply is the same bundle the Builder was handed - which is the point of reading it back:
// two roles looking at one frozen thing see the same bytes.
async function readBlueprint(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  const blueprintId = pathId(ctx, "blueprintId");
  if (projectId === null) return unknownProject(ctx);
  if (blueprintId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "blueprint-id-malformed", "the blueprint segment of the path is not an opaque id", ctx.declaration);
  }
  const outcome = await deps.worker.call("blueprint.read", { projectId, blueprintId }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const blueprint = parseStrict(blueprintReadSchema, outcome.value);
  if (!blueprint.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "blueprint-shape", "the worker did not answer with a frozen blueprint", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, blueprint.value);
}

// §8 line 298 names the body as the VerificationReport, so the staleness the service re-derives
// for its own callers stays behind this hop: what leaves is the stored claim, re-hashed and
// re-parsed by the service, not a second opinion about whether it still holds.
async function readVerification(ctx: Context, deps: ApiDependencies): Promise<ApiResponse> {
  const projectId = projectFromPath(ctx);
  const verificationId = pathId(ctx, "verificationId");
  if (projectId === null) return unknownProject(ctx);
  if (verificationId === null) {
    return refused(ctx.requestId, "INVALID_INPUT", "verification-id-malformed", "the verification segment of the path is not an opaque id", ctx.declaration);
  }
  const outcome = await deps.worker.call("verification.read", { projectId, verificationId }, ctx.actor);
  if (!outcome.ok) return fromWorker(ctx.requestId, outcome.error, ctx.declaration);
  const report = parseStrict(verificationReportSchema, jsonRecord(outcome.value)["report"] ?? null);
  if (!report.ok) {
    return refused(ctx.requestId, "REA_CONTRACT_MISMATCH", "verification-shape", "the worker did not answer with a verification report", ctx.declaration);
  }
  return jsonSuccess(ctx.requestId, 200, report.value);
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

    // 4. The Idempotency-Key, for the routes that declare one. Until now this was a field on the
    //    route table that nothing read: each creation re-checked the header by hand, so a route
    //    that forgot to was silently accepting an unkeyed creation - and the two checks that did
    //    exist were not even the same rule (one validated the key's shape, mine only its
    //    presence). One owner now, validating the shape §8 line 261 assumes.
    if (route.requiresIdempotencyKey && !isIdempotencyKey(request.headers["idempotency-key"])) {
      const response = refused(requestId, "INVALID_INPUT", "idempotency-key-required", "this creation needs an Idempotency-Key header", declaration);
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
      response = await createProject(ctx, deps, request.headers["idempotency-key"] as string);
    } else if (route.method === "GET" && route.template === `${API_PREFIX}/projects`) {
      response = await listProjects(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/exports/:exportId/download")) {
      response = await downloadExport(ctx, deps);
    } else if (route.method === "POST" && route.template.endsWith("/exports")) {
      response = await createExport(ctx, deps);
    } else if (route.method === "POST" && route.template === `${API_PREFIX}/projects/:projectId/blueprints`) {
      response = await freezeBlueprint(ctx, deps, request.headers["idempotency-key"] as string);
    } else if (route.method === "POST" && route.template === `${API_PREFIX}/projects/:projectId/vectors`) {
      response = await createVector(ctx, deps, request.headers["idempotency-key"] as string);
    } else if (route.method === "POST" && route.template === `${API_PREFIX}/projects/:projectId/contracts`) {
      response = await createContract(ctx, deps);
    } else if (route.method === "POST" && route.template === `${API_PREFIX}/projects/:projectId/verification-plans`) {
      response = await createPlan(ctx, deps, request.headers["idempotency-key"] as string);
    } else if (route.method === "POST" && route.template === `${API_PREFIX}/projects/:projectId/verifications`) {
      response = await requestVerification(ctx, deps, request.headers["idempotency-key"] as string);
    } else if (route.method === "POST" && route.template === `${API_PREFIX}/projects/:projectId/candidates`) {
      response = await requestCandidate(ctx, deps, request.headers["idempotency-key"] as string);
    } else if (route.method === "POST" && route.template === `${API_PREFIX}/projects/:projectId/imports`) {
      response = await importCapture(ctx, deps, request.headers["idempotency-key"] as string);
    } else if (route.method === "POST" && route.template === `${API_PREFIX}/projects/:projectId/jobs`) {
      response = await requestJob(ctx, deps, request.headers["idempotency-key"] as string);
    } else if (route.method === "POST" && route.template.endsWith("/cancel")) {
      response = await cancelJob(ctx, deps);
    } else if (route.method === "POST" && route.template.endsWith("/cleanup-retry")) {
      response = await retryJobCleanup(ctx, deps, request.headers["idempotency-key"] as string);
    } else if (route.method === "POST" && route.template.endsWith("/review")) {
      // One branch for three routes, chosen by the resource the path names: the commands take
      // different ids, and two of the three are inventory-bound while the contract one is not.
      response = route.template.includes("/vectors/")
        ? await reviewVector(ctx, deps)
        : route.template.includes("/contracts/")
          ? await reviewContract(ctx, deps)
          : await reviewPlan(ctx, deps);
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
    } else if (route.method === "GET" && route.template === `${API_PREFIX}/comparator-policies`) {
      response = await readComparatorPolicies(ctx, deps);
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
    } else if (route.method === "GET" && route.template.endsWith("/contracts/:contractId")) {
      response = await readContract(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/verifications/:verificationId")) {
      response = await readVerification(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/blueprints/:blueprintId")) {
      response = await readBlueprint(ctx, deps);
    } else if (route.method === "POST" && route.template.endsWith("/targets")) {
      response = await declareTarget(ctx, deps);
    } else if (route.method === "GET" && route.template.endsWith("/targets/:targetId")) {
      response = await readTarget(ctx, deps);
    } else if (route.template.endsWith("/events")) {
      response = await streamEvents(ctx, deps);
    } else {
      response = refused(requestId, "NOT_FOUND", "route-unhandled", "the matched route has no handler", declaration);
    }

    record(routeName, response.status, session === null ? "anonymous" : "paired");
    return response;
  };
}


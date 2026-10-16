#!/usr/bin/env node
// A stand-in REA MCP server used only by tests/integration/rea-session.test.ts.
// It exists so the adapter's parsing and identity rules can be exercised without
// a real provider; results from it are never evidence about REA itself (DESIGN
// §1, and the "fixture vs real provider" split issue #14 asks for).
//
// The catalog it advertises is READ FROM the recorded live capture
// `tests/fixtures/rea-live-tools-shapes.json` — the shapes `tools/list` really
// returned from the built provider at 98d8470d. Hand-writing an approximation
// here would have made issue #14's reconciliation gate pass by construction and
// prove nothing; drift cases below mutate the recorded document instead, so every
// refusal in the suite traces to a field a real provider named.
//
// Behaviour is selected with FIXTURE_CASE:
//   ok                aligned, catalog in the documented order
//   shuffle           same tools, deliberately reordered (name lookup must not care)
//   version_drift   reports a different package version
//   missing_tool    omits import_evidence_bundle
//   no_required     advertises capture tools without their required input fields
//   open_content    drops additionalProperties:false from the capture input
//   extra_field     adds an input field no mirror declares
//   dropped_envelope_field  removes `relationship_coverage` from an advertised
//                     Evidence output `required` list (the §9 item 2 envelope rule)
//   detail_missing  removes `detail` from the advertised analyze input, i.e. the
//                     mirror is now the side that is wrong
//   har_records     capture answers with a contract-shaped records envelope
//   resource_constraint / retained_view
//                   capture answers `resource_constraint` with a retained
//                   reference; the reference then resolves by view / export
//
// FIXTURE_CALL_LOG, when set to a file path, gets one JSON line per `tools/call`:
// {name, arguments}. Tests use it to prove a producer is never re-run and that a
// cancelled caller issues nothing at all.

import process from "node:process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDED = JSON.parse(readFileSync(path.join(HERE, "rea-live-tools-shapes.json"), "utf8"));

const HEX = "a".repeat(64);
const CASE = process.env.FIXTURE_CASE ?? "ok";
const CALL_LOG = process.env.FIXTURE_CALL_LOG ?? null;

function envelope(id) {
  return {
    evidence_id: `ev_${id}`,
    subject: {
      name: "session.har",
      digest: { sha256: HEX },
      format: "file",
      architecture: null,
      local_path: "/fixture/session.har",
    },
    provider: { id: "har-schema/lossless-json", name: "REA HAR capture adapter", version: "har12" },
    analysis_profile: null,
    predicate_type: "rea.analysis",
    operation: "inspect_web_network_capture",
    parameters: { capture_path: "/fixture/session.har", format: "har", sensitive_value_count: 0 },
    raw_result: null,
    normalized_result: {
      decoder: { id: "har-schema/lossless-json", name: "REA HAR capture adapter", version: "har12" },
      container: { reported: { log: { entries: null } }, numeric_literals: [], redactions: [], records_pointer: "/log/entries" },
      total_records: 1,
      records: [
        {
          ordinal: 0,
          location: { kind: "json-pointer", pointer: "/log/entries/0" },
          reported: { request: { method: "GET", url: "http://127.0.0.1:8080/cart" } },
          binary_fields: [],
          numeric_literals: [],
          redactions: [],
          limitations: [],
        },
      ],
      artifact: { path: "/fixture/session.har", sha256: HEX, bytes: 512 },
      format: "har",
      runtime_attribution: "unknown",
      limitations: [],
    },
    confidence: "observed",
    authority: "historical-reference",
    environment: null,
    limitations: [],
    relationship_coverage: null,
    locations: [{ kind: "artifact-path", path: "/fixture/session.har" }],
    evidence_links: [],
  };
}

// A capture-shaped envelope that satisfies the mirrored contract in
// packages/contracts/rea-web-capture.ts, so the ingestion loop can be driven
// end-to-end: ordinal + json-pointer coordinates, a transport-credential redaction
// on one header value, a text response body and one retained binary sidecar.
function harRecordsEnvelope(id) {
  const base = envelope(id);
  base.parameters = { capture_path: "/fixture/session.har", format: "har", sensitive_values: [] };
  base.relationship_coverage = { status: "complete" };
  base.normalized_result = {
    decoder: { id: "har-1.2", name: "HAR", version: "1.2" },
    container: {
      reported: { log: { version: "1.2", creator: { name: "chrome", version: "141" } } },
      numeric_literals: [],
      redactions: [],
      records_pointer: "/log/entries",
    },
    total_records: 2,
    records: [
      {
        ordinal: 0,
        location: { kind: "json-pointer", pointer: "/log/entries/0" },
        reported: {
          cache: {},
          request: {
            method: "GET",
            url: "http://127.0.0.1:9/card?include=items",
            httpVersion: "HTTP/2",
            queryString: [{ name: "include", value: "items" }],
            headers: [
              { name: "authorization", value: "redacted" },
              { name: "accept", value: "application/json" },
            ],
            cookies: [],
          },
          response: {
            status: 200,
            statusText: "OK",
            headers: [{ name: "content-type", value: "application/json" }],
            cookies: [],
            content: { size: 11, compression: 0, mimeType: "application/json", text: '{"items":[]}' },
            redirectURL: "",
          },
          startedDateTime: "2026-10-16T09:00:00.000Z",
          time: 12,
        },
        binary_fields: [],
        numeric_literals: [{ pointer: "/log/entries/0/response/status", producer_type: "json-number", literal: "200" }],
        redactions: [{ pointer: "/log/entries/0/request/headers/0/value", reason: "transport-credential" }],
        limitations: [],
      },
      {
        ordinal: 1,
        location: { kind: "json-pointer", pointer: "/log/entries/1" },
        reported: {
          request: {
            method: "POST",
            url: "http://127.0.0.1:9/card/items",
            queryString: [],
            headers: [{ name: "content-type", value: "application/json" }],
            postData: { mimeType: "application/json", text: "{}" },
          },
          response: { status: 201, headers: [], content: { size: 0, mimeType: "application/json" } },
        },
        binary_fields: [
          {
            pointer: "/log/entries/1/request/postData/text",
            state: "retained",
            representation: "har-base64-content",
            content_base64: "e30=",
            bytes: 2,
            sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          },
        ],
        numeric_literals: [],
        redactions: [],
        limitations: ["response-body-not-retained"],
      },
    ],
    artifact: { path: "/fixture/session.har", sha256: HEX, bytes: 512 },
    format: "har",
    runtime_attribution: "unknown",
    limitations: [],
  };
  return base;
}

function recordedTool(name) {
  const tool = RECORDED.tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`recorded capture has no ${name}`);
  return {
    name,
    description: `fixture ${name} (shapes recorded from the live provider)`,
    inputSchema: structuredClone(tool.inputSchema),
    outputSchema: structuredClone(tool.outputSchema ?? { type: "object" }),
  };
}

function mutate(tool) {
  if (CASE === "no_required") {
    // The provider stops naming any required input: every field the mirrors demand
    // becomes `required_unadvertised`.
    return { ...tool, inputSchema: { ...tool.inputSchema, required: [] } };
  }
  if (CASE === "open_content" && tool.name === "inspect_web_network_capture") {
    const { additionalProperties, ...rest } = tool.inputSchema;
    void additionalProperties;
    return { ...tool, inputSchema: rest };
  }
  if (CASE === "extra_field" && tool.name === "export_evidence_bundle") {
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: { ...tool.inputSchema.properties, compression: { type: "string" } },
      },
    };
  }
  if (CASE === "dropped_envelope_field" && tool.name === "inspect_web_network_capture") {
    // §9 item 2's envelope half: the provider no longer names
    // `relationship_coverage` as required, while the consumer mirror must keep
    // requiring it.
    return {
      ...tool,
      outputSchema: {
        ...tool.outputSchema,
        required: tool.outputSchema.required.filter((field) => field !== "relationship_coverage"),
      },
    };
  }
  if (CASE === "detail_missing" && tool.name === "analyze_javascript_application") {
    const { detail, ...properties } = tool.inputSchema.properties;
    void detail;
    return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
  }
  return tool;
}

function catalog() {
  const names = CASE === "missing_tool"
    ? RECORDED.namedToolOrder.filter((name) => name !== "import_evidence_bundle")
    : RECORDED.namedToolOrder;
  const tools = names.map((name) => mutate(recordedTool(name)));
  // Retention is only reachable if the reference resolves, and the provider says
  // which operations may be parents: a stale catalog that lost
  // `inspect_analysis_view` must fail the gate rather than degrade quietly.
  if (CASE === "shuffle") return [...tools].reverse();
  return tools;
}

// A HAR capture parent can only be projected through the `api-surface` view:
// upstream's `summary`/`item`/`page`/`native` members admit
// inspect_binary_layout | analyze_javascript_application | analyze_function as
// `parent_operation`, and the live provider confirmed the other direction on
// 2026-10-16 (`inspect_analysis_view` of a non-admitted parent answers
// `unsupported_target`). This reply is shaped by that rule, not by preference.
function viewEnvelope(parentEvidenceId) {
  const base = envelope(HEX);
  base.provider = { id: "rea-analysis-view", name: "REA analysis view projection", version: "1" };
  base.predicate_type = "rea.analysis-view";
  base.operation = "inspect_analysis_view";
  base.parameters = { parent_evidence_id: parentEvidenceId, view: { kind: "api-surface" } };
  base.normalized_result = {
    kind: "api-surface",
    parent_evidence_id: parentEvidenceId,
    parent_operation: "inspect_web_network_capture",
    parent_digest: HEX,
    view_digest: HEX,
    artifact: { path: "/fixture/session.har", sha256: null },
    coverage: { status: "complete-within-view", examined: 1, total: 1, next_offset: null, exhausted: true },
    limitations: [],
    unknowns: [],
    view: { kind: "api-surface", offset: 0, limit: 50 },
    records: { examined: 1, total: 1, excluded: 0 },
    templated_groups: 0,
    groups: [
      {
        method: "GET",
        origin: "http://127.0.0.1:9",
        path_template: "/card",
        templated_segments: [],
        record_ordinals: [0],
        statuses: [200],
        content_types: ["application/json"],
        flags: ["single-sample"],
      },
    ],
    excluded_records: [],
  };
  return base;
}


let inFlight = 0;
let peak = 0;

function sessionReply() {
  return {
    result: {
      open: false,
      server_identity: {
        package: { name: "rea", version: CASE === "version_drift" ? "6.3.0" : "6.4.0", root_path: "/fixture/rea" },
        catalog: { counts: { mcp_tools: catalog().length }, digests: { tools_sha256: HEX, combined_sha256: HEX } },
        alignment: { state: "aligned", reasons: ["token hunter2-fixture"], remediation: "none" },
        negotiated_protocol_version: "2025-06-18",
      },
    },
  };
}

async function callTool(name, args) {
  if (name === "binary_session") return sessionReply();
  if (name === "probe_serial") {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    inFlight -= 1;
    return { result: { peak, active: inFlight } };
  }
  if (name === "inspect_web_network_capture") {
    if (CASE === "har_records") return harRecordsEnvelope(HEX);
    if (CASE === "resource_constraint" || CASE === "retained_view") {
      return {
        errorReply: {
          code: "resource_constraint",
          category: "resource_constraint",
          message: "the reply exceeds the transport budget",
          retryable: true,
          remediation: { action: "read the retained record" },
          details: {
            partial_observation: { kind: "retained-evidence", evidence_id: `ev_${"b".repeat(64)}` },
            resource: "memory",
          },
        },
      };
    }
    return envelope(HEX);
  }
  if (name === "probe_error") {
    return { errorReply: { code: "unsupported_target", category: "unsupported_target", message: "no", retryable: false, remediation: { action: "pick another" } } };
  }
  if (name === "probe_big") {
    return {
      errorReply: {
        code: "resource_constraint",
        category: "resource_constraint",
        message: "reply exceeds the transport budget",
        retryable: true,
        remediation: { action: "read the retained record" },
        details: { partial_observation: { kind: "retained-evidence", evidence_id: `ev_${"b".repeat(64)}` } },
      },
    };
  }
  if (name === "inspect_analysis_view") {
    if (args?.source?.kind !== "retained-evidence" || typeof args.source.evidence_id !== "string") {
      // The provider refuses a reference it cannot resolve, naming the field.
      return {
        errorReply: {
          code: "invalid_request",
          category: "invalid_input",
          message: "source.evidence_id must name a retained record of this session",
          retryable: false,
          remediation: { action: "pass an exact same-session evidence_id" },
          details: { field: "source.evidence_id" },
        },
      };
    }
    return viewEnvelope(args.source.evidence_id);
  }
  if (name === "export_evidence_bundle") {
    return { result: { path: args?.path ?? "/fixture/bundle.json", bytes: 4096, records: 2, unknowns: 0 } };
  }
  if (name === "import_evidence_bundle") {
    return { result: { imported: 2, unknowns_added: 0, total: 2 } };
  }
  if (name === "get_evidence_bundle") {
    return {
      result: {
        artifacts: [],
        providers: [],
        environments: [],
        scenarios: [],
        captures: [],
        unknowns: [],
        records: [],
      },
    };
  }
  if (name === "close_binary") return { result: null };
  void args;
  return { result: { echo: name } };
}

const rl = { buffer: "" };
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  rl.buffer += chunk;
  let index = rl.buffer.indexOf("\n");
  while (index >= 0) {
    const line = rl.buffer.slice(0, index).trim();
    rl.buffer = rl.buffer.slice(index + 1);
    if (line) await handle(line);
    index = rl.buffer.indexOf("\n");
  }
});

async function handle(line) {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (method === "notifications/initialized") return;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "rea-fixture", version: "6.4.0" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: catalog() } });
    return;
  }
  if (method === "tools/call") {
    if (CALL_LOG !== null) {
      appendFileSync(CALL_LOG, `${JSON.stringify({ name: params?.name ?? null, arguments: params?.arguments ?? null })}\n`);
    }
    const outcome = await callTool(params?.name, params?.arguments);
    if (outcome.errorReply) {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify({ error: outcome.errorReply }) }], isError: true },
      });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(outcome) }], structuredContent: outcome } });
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
}

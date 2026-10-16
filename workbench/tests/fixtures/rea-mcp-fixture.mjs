#!/usr/bin/env node
// A stand-in REA MCP server used only by tests/integration/rea-session.test.ts.
// It exists so the adapter's parsing and identity rules can be exercised without
// a real provider; results from it are never evidence about REA itself (DESIGN
// §1, and the "fixture vs real provider" split issue #14 asks for).
//
// Behaviour is selected with FIXTURE_CASE:
//   ok              aligned, catalog in the documented order
//   shuffle         same tools, deliberately reordered (name lookup must not care)
//   version_drift   reports a different package version
//   missing_tool    omits import_evidence_bundle
//   no_required     advertises capture tools without their required input fields

import process from "node:process";

const HEX = "a".repeat(64);
const CASE = process.env.FIXTURE_CASE ?? "ok";

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

function tool(name, required) {
  return {
    name,
    description: `fixture ${name}`,
    inputSchema: { type: "object", properties: {}, required: [...required] },
    outputSchema: { type: "object" },
  };
}

function catalog() {
  const tools = [
    tool("binary_session", []),
    tool("inspect_web_network_capture", ["capture_path", "format"]),
    tool("analyze_javascript_application", []),
    tool("get_evidence_bundle", []),
    tool("export_evidence_bundle", ["path"]),
    tool("import_evidence_bundle", ["path"]),
    tool("close_binary", []),
  ];
  if (CASE === "missing_tool") {
    return tools.filter((entry) => entry.name !== "import_evidence_bundle");
  }
  if (CASE === "no_required") {
    return tools.map((entry) => ({ ...entry, inputSchema: { type: "object", properties: {}, required: [] } }));
  }
  if (CASE === "shuffle") {
    return [...tools].reverse();
  }
  return tools;
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
    if (CASE === "resource_constraint") {
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

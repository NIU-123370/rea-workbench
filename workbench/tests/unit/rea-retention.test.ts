import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ReaRetention } from "../../packages/adapters/rea/retention.ts";
import type { ReaSession, ToolOutcome } from "../../packages/adapters/rea/session.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import { reaEvidenceSchema } from "../../packages/contracts/rea-evidence.ts";

// The retention path's own promises (DESIGN §9 items 5-7, issue #14).
//
// The adapter exposes `issued`, the ordered list of names it asked the transport
// for, precisely so these properties are testable rather than commented: a caller
// that cancelled must have issued nothing, and a retained reference must not be
// marked committed before the reply that earned it has validated.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// The pinned provider's own application-graph envelope, recorded from the named
// contract at 98d8470d; the retention path must accept it verbatim.
const ENVELOPE_FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, "tests/fixtures/asar-application-envelope.json"), "utf8"),
) as Record<string, JsonValue>;

// The reference under test is the recorded envelope's own id: swapping it for a
// synthetic one would make the reply fail validation for a reason that has
// nothing to do with retention.
const PARSED_ENVELOPE = reaEvidenceSchema.parse(ENVELOPE_FIXTURE);
const RETAINED_ID = PARSED_ENVELOPE.evidence_id;

// `inspect_analysis_view` answers with the same envelope whose `normalized_result`
// is specialised to the requested view (rea-analysis-view.ts). The recorded
// analysis envelope is the PARENT record, so the view reply is built from it with
// the parent coordinates the provider names — this is the shape the retention path
// has to accept before it will hand a reference back.
const DIGEST = "d".repeat(64);
const VIEW_RECORD = {
  ...ENVELOPE_FIXTURE,
  operation: "inspect_analysis_view",
  normalized_result: {
    kind: "item",
    view: { kind: "item", collection: "modules", selector: { path: "index.js" } },
    item: { node_id: `jag_node_${DIGEST}` },
    parent_evidence_id: RETAINED_ID,
    parent_operation: "analyze_javascript_application",
    parent_digest: DIGEST,
    view_digest: DIGEST,
    artifact: { path: "/retained/view.json", sha256: DIGEST },
    coverage: {
      status: "complete-within-view",
      examined: 1,
      total: 1,
      next_offset: null,
      exhausted: true,
    },
    limitations: [],
    unknowns: [],
  },
};

class FakeSession {
  readonly issued: string[] = [];
  readonly unpersisted: Set<string> = new Set();
  replies: ToolOutcome[] = [];

  constructor(retainedId: string) {
    this.unpersisted.add(retainedId);
  }

  callTool(name: string, _args: JsonValue): Promise<{ ok: true; value: ToolOutcome } | { ok: false; error: { code: string; message: string } }> {
    this.issued.push(name);
    const next = this.replies.shift();
    if (next === undefined) {
      return Promise.resolve({ ok: false, error: { code: "MCP_TRANSPORT_CLOSED", message: "no reply queued" } });
    }
    return Promise.resolve({ ok: true, value: next });
  }

  markPersisted(evidenceId: string): void {
    this.unpersisted.delete(evidenceId);
  }

  get pendingPersistence(): string[] {
    return [...this.unpersisted].sort();
  }
}

function sessionWith(retainedId: string, replies: ToolOutcome[]) {
  const fake = new FakeSession(retainedId);
  fake.replies = replies;
  return { fake, retention: new ReaRetention({ session: fake as unknown as ReaSession }) };
}

function exportReply(path: string) {
  return {
    kind: "value",
    value: { result: { path, bytes: 12, records: 3, unknowns: 0 } },
  } as ToolOutcome;
}

describe("retention consumes a reference instead of re-running (§9 item 5)", () => {
  it("reads a retained record by reference and calls only the view operation", async () => {
    const { fake, retention } = sessionWith(RETAINED_ID, [
      { kind: "evidence", evidence: reaEvidenceSchema.parse(VIEW_RECORD) },
    ]);
    const outcome = await retention.resolveView({
      evidenceId: RETAINED_ID,
      view: { kind: "summary" },
    });
    expect(outcome.kind).toBe("view");
    expect(fake.issued).toEqual(["inspect_analysis_view"]);
    // The producer that created the record is never re-invoked (§9 item 5).
    expect(fake.issued).not.toContain("analyze_javascript_application");
    expect(fake.issued).not.toContain("binary_session");
  });

  it("refuses a reference that cannot exist before spending a call", async () => {
    const { fake, retention } = sessionWith(RETAINED_ID, []);
    const outcome = await retention.resolveView({
      evidenceId: "ev_not-a-real-digest",
      view: { kind: "summary" },
    });
    expect(outcome.kind).toBe("failure");
    expect(fake.issued).toEqual([]);
  });

  it("issues nothing when the caller has already cancelled", async () => {
    const { fake, retention } = sessionWith(RETAINED_ID, [
      { kind: "evidence", evidence: reaEvidenceSchema.parse(VIEW_RECORD) },
    ]);
    const outcome = await retention.resolveView({
      evidenceId: RETAINED_ID,
      view: { kind: "summary" },
      cancellation: { cancelled: () => true },
    });
    expect(outcome.kind).toBe("cancelled");
    expect(fake.issued).toEqual([]);
  });

  it("treats a deadline that passes mid-flight as cancelled, not as a retry", async () => {
    let cancelled = false;
    const { fake, retention } = sessionWith(RETAINED_ID, []);
    const first = await retention.commitBundle({
      evidenceId: RETAINED_ID,
      path: "/tmp/rea-evidence.json",
      cancellation: { cancelled: () => cancelled },
    });
    expect(first.kind).toBe("failure");
    expect(fake.issued).toEqual(["export_evidence_bundle"]);
    // The failure came from the transport, and a refused call is never re-issued.
    cancelled = true;
    const second = await retention.commitBundle({
      evidenceId: RETAINED_ID,
      path: "/tmp/rea-evidence.json",
      cancellation: { cancelled: () => cancelled },
    });
    expect(second.kind).toBe("cancelled");
    expect(fake.issued).toEqual(["export_evidence_bundle"]);
  });
});

describe("commit ordering before close (§9 item 6)", () => {
  it("clears the ledger only after a validated export reply", async () => {
    const { fake, retention } = sessionWith(RETAINED_ID, [exportReply("/tmp/rea-evidence.json")]);
    const outcome = await retention.commitBundle({
      evidenceId: RETAINED_ID,
      path: "/tmp/rea-evidence.json",
    });
    expect(outcome.kind).toBe("committed");
    expect(fake.pendingPersistence).toEqual([]);
  });

  it("keeps the reference unpersisted when the reply does not validate", async () => {
    // A reply that names the right shape but withholds a required count is not
    // proof of a committed bundle: the ledger stays dirty, so close_binary remains
    // illegal and nothing was cleared.
    const { fake, retention } = sessionWith(RETAINED_ID, [
      { kind: "value", value: { result: { path: "/tmp/rea-evidence.json", bytes: 12 } } } as ToolOutcome,
    ]);
    const outcome = await retention.commitBundle({
      evidenceId: RETAINED_ID,
      path: "/tmp/rea-evidence.json",
    });
    expect(outcome.kind).toBe("failure");
    expect(fake.pendingPersistence).toEqual([RETAINED_ID]);
  });

  it("keeps the reference unpersisted when the producer itself refuses", async () => {
    const { fake, retention } = sessionWith(RETAINED_ID, [
      {
        kind: "error",
        error: {
          code: "provider_unavailable",
          category: "unavailable",
          message: "provider is not running",
          retryable: true,
          remediation: { action: "restart the provider" },
        },
        retainedEvidenceId: RETAINED_ID,
      } as ToolOutcome,
    ]);
    const outcome = await retention.commitBundle({
      evidenceId: RETAINED_ID,
      path: "/tmp/rea-evidence.json",
    });
    expect(outcome.kind).toBe("failure");
    expect(fake.pendingPersistence).toEqual([RETAINED_ID]);
  });

  it("refuses a relative export path instead of letting the provider answer in prose", async () => {
    const { fake, retention } = sessionWith(RETAINED_ID, [exportReply("evidence.json")]);
    const outcome = await retention.commitBundle({
      evidenceId: RETAINED_ID,
      path: "evidence.json",
    });
    expect(outcome.kind).toBe("failure");
    expect(fake.issued).toEqual([]);
  });

  it("refuses to import a bundle whose path is relative", async () => {
    const { fake, retention } = sessionWith(RETAINED_ID, []);
    const imported = await retention.importBundle({ path: "evidence.json" });
    expect(imported.ok).toBe(false);
    expect(fake.issued).toEqual([]);
  });
});

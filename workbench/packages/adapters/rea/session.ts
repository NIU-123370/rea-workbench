import type { JsonValue } from "../../domain/json-value.ts";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { decodeToolResult } from "./envelope.ts";
import type { ReaEvidence, ReaToolError } from "../../contracts/rea-evidence.ts";
import type { RpcPeer } from "./protocol.ts";

// DESIGN §9: one connection owner per project session. Operations that can
// change the target are serialised on that owner, and retained Evidence stays a
// property of *this* connection: `close_binary` clears the ledger, so a fresh
// connection never inherits the old ids.

export type SessionFailure = {
  code: "EVIDENCE_UNPERSISTED" | "REA_CONTRACT_MISMATCH" | "MCP_TRANSPORT_CLOSED";
  message: string;
};

export type ToolOutcome =
  | { kind: "evidence"; evidence: ReaEvidence }
  | { kind: "value"; value: JsonValue }
  | { kind: "error"; error: ReaToolError; retainedEvidenceId: string | null };

export class ReaSession {
  readonly peer: RpcPeer;
  readonly retained: Set<string> = new Set();
  readonly unpersisted: Set<string> = new Set();
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(peer: RpcPeer) {
    this.peer = peer;
  }

  // Serialised because REA's own contract states that target-changing calls
  // queue behind the active lifecycle operation; two concurrent ones would race
  // the same session state (§9 item 1, §2).
  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async callTool(name: string, args: JsonValue): Promise<Result<ToolOutcome, SessionFailure>> {
    if (this.#closed) return err({ code: "MCP_TRANSPORT_CLOSED", message: "connection already closed" });
    const reply = await this.serialise(() => this.peer.request("tools/call", { name, arguments: args }));
    if (!reply.ok) return err({ code: "MCP_TRANSPORT_CLOSED", message: reply.error.message });
    const decoded = decodeToolResult(reply.value);
    if (!decoded.ok) return err({ code: "REA_CONTRACT_MISMATCH", message: decoded.error.reason });
    const outcome = decoded.value;
    if (outcome.kind === "evidence") {
      this.retained.add(outcome.evidence.evidence_id);
      this.unpersisted.add(outcome.evidence.evidence_id);
    }
    if (outcome.kind === "error" && outcome.retainedEvidenceId !== null) {
      this.retained.add(outcome.retainedEvidenceId);
      this.unpersisted.add(outcome.retainedEvidenceId);
    }
    return ok(outcome);
  }

  markPersisted(evidenceId: string): void {
    this.unpersisted.delete(evidenceId);
  }

  get pendingPersistence(): string[] {
    return [...this.unpersisted].sort();
  }

  // §9 item 6: preserve or commit every complete Evidence record *before*
  // closing, because closing empties the connection's ledger and the retained
  // references stop resolving afterwards.
  async closeBinary(args: JsonValue = {}): Promise<Result<ToolOutcome, SessionFailure>> {
    if (this.unpersisted.size > 0) {
      return err({
        code: "EVIDENCE_UNPERSISTED",
        message: `${this.unpersisted.size} evidence record(s) are not persisted yet`,
      });
    }
    const outcome = await this.callTool("close_binary", args);
    if (outcome.ok) {
      // The ledger is gone regardless of whether the reply echoed it.
      this.retained.clear();
      this.unpersisted.clear();
    }
    return outcome;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.peer.close();
  }
}

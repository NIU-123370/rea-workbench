import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { JsonValue } from "../../domain/json-value.ts";
import type { Result } from "../../domain/result.ts";

// Minimal MCP stdio client: newline-delimited JSON-RPC 2.0, as the spec's stdio
// transport requires. The protocol version is a negotiation, not a constant: we
// offer candidates and keep whatever the server answers, because the pinned
// baseline resolves that value through @modelcontextprotocol/client rather than
// declaring it in this repository (DESIGN §1).

export const PROTOCOL_CANDIDATES = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const CLIENT_INFO = { name: "rea-workbench", version: "0.1.0" };

export type RpcError = {
  code:
    | "REA_CONTRACT_MISMATCH"
    | "MCP_TRANSPORT_CLOSED"
    | "MCP_CALL_FAILED"
    | "MCP_TIMEOUT";
  message: string;
};

export type RpcPeer = {
  request(method: string, params?: JsonValue): Promise<Result<JsonValue, RpcError>>;
  notify(method: string, params?: JsonValue): Promise<Result<true, RpcError>>;
  close(): Promise<void>;
  readonly hasExited: boolean;
  readonly stderrTail: () => string;
};

type Pending = {
  resolve: (value: Result<JsonValue, RpcError>) => void;
  timer: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class LineRpc implements RpcPeer {
  nextId = 1;
  pending = new Map<number, Pending>();
  buffer = "";
  stderr: string[] = [];
  closed = false;
  hasExited = false;
  timeoutMs: number;

  child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Only the tail is kept, and never as evidence: raw provider stderr must
      // pass the diagnostics owner before it reaches any channel (DESIGN §12.1).
      this.stderr.push(chunk.slice(0, 400));
      if (this.stderr.length > 20) this.stderr.shift();
    });
    child.on("close", () => {
      this.closed = true;
      this.hasExited = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, error: { code: "MCP_TRANSPORT_CLOSED", message: "REA process exited" } });
      }
      this.pending.clear();
    });
  }

  stderrTail(): string {
    return this.stderr.join("").slice(-2000);
  }

  onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    const id = typeof message["id"] === "number" ? message["id"] : null;
    if (id === null) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (message["error"] !== undefined) {
      entry.resolve({
        ok: false,
        error: { code: "MCP_CALL_FAILED", message: JSON.stringify(message["error"]).slice(0, 200) },
      });
      return;
    }
    entry.resolve({ ok: true, value: (message["result"] ?? null) as JsonValue });
  }

  write(payload: JsonValue): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method: string, params: JsonValue = {}): Promise<Result<JsonValue, RpcError>> {
    if (this.closed) {
      return Promise.resolve({ ok: false, error: { code: "MCP_TRANSPORT_CLOSED", message: "transport closed" } });
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: "MCP_TIMEOUT", message: `${method} did not answer in time` } });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async notify(method: string, params: JsonValue = {}): Promise<Result<true, RpcError>> {
    if (this.closed) {
      return { ok: false, error: { code: "MCP_TRANSPORT_CLOSED", message: "transport closed" } };
    }
    this.write({ jsonrpc: "2.0", method, params });
    return { ok: true, value: true };
  }

  // Graceful first, then signal: a client that only closes its own pipe can
  // leave a provider process alive forever, and a leaked analysis process keeps
  // holding the target it owns (§11: ownership must be provable, not assumed).
  close(): Promise<void> {
    this.closed = true;
    this.child.stdin.end();
    return new Promise((resolve) => {
      const settle = () => {
        clearTimeout(grace);
        clearTimeout(hard);
        resolve();
      };
      const grace = setTimeout(() => this.child.kill("SIGTERM"), 100);
      const hard = setTimeout(() => this.child.kill("SIGKILL"), 300);
      this.child.once("close", settle);
      if (this.hasExited) settle();
    });
  }
}

export function connectReaStdio(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number; env?: Record<string, string> } = {},
): Result<RpcPeer, RpcError> {
  try {
    // An explicit environment is required to deviate from the host; the caller
    // (worker composition root) decides what the child sees at all (§12, D21).
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: options.env }),
    }) as ChildProcessWithoutNullStreams;
    return { ok: true, value: new LineRpc(child, options.timeoutMs ?? 15_000) };
  } catch (error) {
    return {
      ok: false,
      error: { code: "REA_CONTRACT_MISMATCH", message: `cannot spawn REA: ${String((error as Error).message)}` },
    };
  }
}

export async function handshake(peer: RpcPeer): Promise<Result<{ protocolVersion: string; serverInfo: JsonValue | null }, RpcError>> {
  const supported = PROTOCOL_CANDIDATES[0] as string;
  const answered = await peer.request("initialize", {
    protocolVersion: supported,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  if (!answered.ok) return answered;
  if (!isRecord(answered.value)) {
    return { ok: false, error: { code: "REA_CONTRACT_MISMATCH", message: "initialize reply is not an object" } };
  }
  const negotiated = answered.value["protocolVersion"];
  if (typeof negotiated !== "string" || negotiated.length === 0) {
    return { ok: false, error: { code: "REA_CONTRACT_MISMATCH", message: "initialize reply has no protocolVersion" } };
  }
  if (!PROTOCOL_CANDIDATES.includes(negotiated)) {
    return {
      ok: false,
      error: {
        code: "REA_CONTRACT_MISMATCH",
        message: `server negotiated ${negotiated}, which this client does not implement`,
      },
    };
  }
  await peer.notify("notifications/initialized");
  return {
    ok: true,
    value: { protocolVersion: negotiated, serverInfo: (answered.value["serverInfo"] ?? null) as JsonValue | null },
  };
}

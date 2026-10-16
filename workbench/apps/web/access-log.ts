import { redactText } from "../../packages/application/sanitizer.ts";
import type { SensitiveDeclaration } from "../../packages/application/sanitizer.ts";

// The access log (DESIGN §14: 禁止把 token 放 URL、query、referrer、access log 或审计正文).
//
// The rule this file exists to make impossible is the ordinary one: a request line
// that copies `GET <target>` into a log, which is exactly where a pairing code or a
// session value would end up if it ever travelled in a query. So a line is built from
// the matched route *template*, the method, a status number, a server-minted id and one
// of three words about the session. There is no field into which a caller's text, path,
// query, header or body could go, and the filter owner is run over the result anyway.

export type AccessLineInput = {
  method: string;
  // `/api/v1/projects/:projectId/events`, never the concrete target.
  route: string;
  status: number;
  requestId: string;
  sessionState: "paired" | "anonymous" | "revoked";
  // Named, bounded facts only: a count of events written, not their contents.
  sent?: number;
};

export function formatAccessLine(input: AccessLineInput, declaration: SensitiveDeclaration): string {
  const parts = [
    input.method.toUpperCase(),
    input.route,
    `status=${String(input.status)}`,
    `session=${input.sessionState}`,
    `requestId=${input.requestId}`,
  ];
  if (input.sent !== undefined) parts.push(`frames=${String(input.sent)}`);
  return redactText(parts.join(" "), declaration).text;
}

export class AccessLog {
  readonly lines: string[] = [];

  record(input: AccessLineInput, declaration: SensitiveDeclaration): string {
    const line = formatAccessLine(input, declaration);
    this.lines.push(line);
    return line;
  }

  // The log itself is bounded by count, not by a caller: a loopback service that
  // someone can drive from a browser still should not grow an unbounded array.
  overBudget(limit: number): number {
    return Math.max(0, this.lines.length - limit);
  }
}

import { redactText } from "../../packages/application/sanitizer.ts";

// Terminal output for the local startup path (DESIGN §12.1, §14).
//
// The design requires the pairing code to be shown in the operator's own terminal,
// so a startup path that prints nothing is not compliant either. This keeps that
// single line under the same rules as every other diagnostic: the sink is injected
// rather than `console`, the text goes through the filter owner, and the line is
// dropped outright when it still looks like a credential after filtering.

export type TerminalSink = {
  writeLine: (text: string) => void;
};

const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\bBearer\s+\S/i,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bpassword\s*[:=]\s*\S/i,
  /\btoken\s*[:=]\s*\S/i,
];

export class Terminal {
  readonly sink: TerminalSink;
  readonly lines: string[] = [];

  constructor(sink: TerminalSink) {
    this.sink = sink;
  }

  // Returns whether the line reached the terminal. A suppressed line is still
  // counted, so a caller can prove it attempted to print the pairing code without
  // the code itself going anywhere else.
  print(label: string, text: string): boolean {
    const line = `${label} ${text}`;
    const filtered = redactText(line, { declaredValues: [] });
    const candidate = filtered.text;
    if (filtered.excludedCount > 0 || CREDENTIAL_SHAPES.some((shape) => shape.test(candidate))) {
      this.lines.push(`${label} [suppressed]`);
      return false;
    }
    this.lines.push(candidate);
    this.sink.writeLine(`${candidate}\n`);
    return true;
  }
}

export function stdoutSink(stream: { write: (text: string) => unknown }): TerminalSink {
  return {
    writeLine(text: string): void {
      stream.write(text);
    },
  };
}

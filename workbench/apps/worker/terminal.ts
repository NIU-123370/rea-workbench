// The worker's startup printer is the application layer's, not a second one
// (DESIGN §12.1: the filtered-output owner is singular). Both local start commands
// print, so the implementation lives in `packages/application/terminal.ts`; this
// module keeps the worker's import path stable.
export { Terminal, stdoutSink } from "../../packages/application/terminal.ts";
export type { TerminalSink } from "../../packages/application/terminal.ts";

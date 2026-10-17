// The instruction vocabulary a capture may be given (§8's `BrowserAction` / `Locator`, issue #58's
// capture half).
//
// These three lists live here, node-free and zod-free, for the same reason `inspect.ts` owns the
// scopes and `comparators.ts` the normalizations: the page has to **offer** them by name, and the only
// other owner of them is `contracts/tasks.ts`, reached through zod, which §3 keeps out of `apps/web`.
// The contract re-exports the lists, so an action the worker accepts and an action the screen can
// render a row for are one vocabulary - never a list that drifts into "the door took something the
// page would not have shown".
//
// What is deliberately absent from all three: an evaluation or scripting kind. §8's paragraph under the
// table names the whole instruction surface a target may receive, and it is closed exactly because a
// `evaluate`-shaped option would let a form author write arbitrary JavaScript into a capture - the
// union in `tasks.ts` exists to make that unrepresentable, so nothing here may reintroduce it as an
// option, a suggestion or a default.

export const BROWSER_ACTION_KINDS = ["click", "fill", "waitFor"] as const;

export type BrowserActionKind = (typeof BROWSER_ACTION_KINDS)[number];

export function isBrowserActionKind(name: string): name is BrowserActionKind {
  return (BROWSER_ACTION_KINDS as readonly string[]).includes(name);
}

export const LOCATOR_KINDS = ["role", "testId"] as const;

export type LocatorKind = (typeof LOCATOR_KINDS)[number];

export function isLocatorKind(name: string): name is LocatorKind {
  return (LOCATOR_KINDS as readonly string[]).includes(name);
}

// `waitFor` takes one of exactly two observed states (§8). "network idle", "element attached" and
// similar are not options here: what the workbench may ask a capture to wait for is what the upstream
// provider can report, and inventing a third would be promising a wait that cannot be observed.
export const WAIT_STATES = ["visible", "hidden"] as const;

export type WaitState = (typeof WAIT_STATES)[number];

export function isWaitState(name: string): name is WaitState {
  return (WAIT_STATES as readonly string[]).includes(name);
}

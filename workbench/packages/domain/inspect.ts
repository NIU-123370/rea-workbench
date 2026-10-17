// §8 line 275's inspect scope: the two ways a directed investigation may decide what it is looking at.
//
// The vocabulary is node-free and zod-free for the same reason `comparators.ts` is: the page has to
// *offer* these two by name and to refuse to pick one for the operator, and the only other owner of
// the list is `contracts/tasks.ts`, which is reached through zod - a dependency §3 keeps out of
// `apps/web`. The contract re-exports the list below, so a scope the door accepts and a scope the
// screen can spell can never be two different lists.
//
// `static` reads the imported bytes only. `captured-runtime` additionally weighs what the capture
// observed while it ran, which is why it needs a target that has a capture behind it, and why an
// offline HAR import cannot answer every inspect this page can ask for. Neither is a default: the
// narrower scope is not the safer one, it is a different question, and §10 refuses to answer one on
// somebody's behalf to make a form go through.

export const INSPECT_SCOPES = ["static", "captured-runtime"] as const;

export type InspectScope = (typeof INSPECT_SCOPES)[number];

export function isInspectScope(name: string): name is InspectScope {
  return (INSPECT_SCOPES as readonly string[]).includes(name);
}

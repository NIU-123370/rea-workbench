// §10's closed list of normalizations a comparator policy may perform.
//
// The vocabulary lives here, node-free and zod-free, for the same reason `job-states.ts` does: a
// screen has to *name* what a policy will ignore - "会不会把 header 名大小写当成不同" is the whole
// difference between the two installed policies, and an operator choosing one is choosing a
// adjudication standard, not a UI option. Reaching the list through `contracts/verification.ts`
// would pull zod (and one hop beyond it, `node:crypto`) into the browser bundle, which §3 forbids
// for `apps/web`. The contract re-exports these names so both sides read one owner: a normalization
// the server accepts and one the page can label can never be two different lists.
//
// Method, encoded path, repeated query and body bytes are exact by default (§10). Anything looser
// has to be one of these named normalizations, which is what stops a policy from growing an
// "ignore volatile fields" escape hatch - and it is why no default is picked here either: the
// looser the option, the less a green run means.

export const COMPARATOR_NORMALIZATIONS = [
  "http-header-name-case",
  "json-key-order",
  "timestamp-second-rounding",
] as const;

export type ComparatorNormalization = (typeof COMPARATOR_NORMALIZATIONS)[number];

export function isComparatorNormalization(name: string): name is ComparatorNormalization {
  return (COMPARATOR_NORMALIZATIONS as readonly string[]).includes(name);
}

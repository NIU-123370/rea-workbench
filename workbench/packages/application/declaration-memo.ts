import type { Id } from "../domain/identity.ts";
import type { SensitiveDeclaration } from "./sanitizer.ts";

// The worker's in-memory memo of what an upload declared as sensitive (§12.1, §8 lines 272 and 306).
//
// A declaration cannot live in the job row: §12.1 keeps declared values out of both the persisted
// input and the request digest, and `taskForStorage` rebuilds the stored task field by field so a
// secret-bearing field is never *present* in what gets written. But the inspection that turns the
// uploaded bytes into evidence needs that list, and the runner drives it in a later turn than the
// request that supplied it. So the list lives here, in the same place §14 puts sessions: worker
// memory, gone on restart.
//
// Two states that look the same and are not:
//   - `record(jobId, [])` means the operator declared nothing, and the filter that runs with that
//     declaration is a real filter with an empty literal list;
//   - no entry at all means the memo lost it - after a restart, or for a job this process never
//     imported. That is the state D25 refuses (`declaration-context-unavailable`), and reading it as
//     "nothing was declared" would be exactly the silent-proceed §12.1 forbids.
export type DeclarationMemo = {
  record(jobId: Id, declaredValues: readonly string[]): void;
  peek(jobId: Id): SensitiveDeclaration | null;
  drop(jobId: Id): void;
  // What the doctor reports: a declaration held longer than the job that needs it is a leak, and a
  // number nobody can read is how a leak stays invisible.
  size(): number;
};

export function createDeclarationMemo(): DeclarationMemo {
  const held = new Map<string, SensitiveDeclaration>();
  return {
    record(jobId, declaredValues) {
      // Copied, so a caller mutating the array it passed cannot rewrite what the filter will use.
      held.set(jobId, { declaredValues: [...declaredValues] });
    },
    peek(jobId) {
      return held.get(jobId) ?? null;
    },
    drop(jobId) {
      held.delete(jobId);
    },
    size() {
      return held.size;
    },
  };
}

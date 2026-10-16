import type { Id } from "./identity.ts";

// Frozen plan versus full inventory (DESIGN §7.4). The plan denominator can
// never be shrunk after execution to manufacture a PASS.

export type ExclusionReasonCode = "outside-scope" | "superseded";

export type ExcludedVector = {
  vectorId: Id;
  reasonCode: ExclusionReasonCode;
  reason: string;
  excludedBehavior: string;
  supersededBy: Id | null;
};

export type InventoryCounts = {
  total: number;
  selected: number;
  excluded: number;
  blocked: number;
};

export function inventoryCounts(input: {
  inventoryVectorIds: readonly Id[];
  selectedVectorIds: readonly Id[];
  excluded: readonly ExcludedVector[];
  blockedVectorIds: readonly Id[];
}): InventoryCounts {
  const inventory = new Set(input.inventoryVectorIds);
  const selected = new Set(input.selectedVectorIds);
  const excluded = new Set<Id>();
  for (const entry of input.excluded) {
    if (excluded.has(entry.vectorId)) {
      throw new RangeError("excluded vectors must be unique");
    }
    excluded.add(entry.vectorId);
    if (!inventory.has(entry.vectorId)) {
      throw new RangeError("excluded vector is outside the frozen inventory snapshot");
    }
  }
  for (const id of selected) {
    if (!inventory.has(id)) {
      throw new RangeError("selected vector is outside the frozen inventory snapshot");
    }
    if (excluded.has(id)) {
      throw new RangeError("a vector cannot be both selected and excluded");
    }
  }
  if (selected.size !== input.selectedVectorIds.length) {
    throw new RangeError("selected vectors must be unique");
  }
  if (selected.size + excluded.size !== inventory.size) {
    throw new RangeError("selected and excluded must cover the frozen inventory snapshot");
  }
  const blocked = new Set(input.blockedVectorIds);
  for (const id of blocked) {
    if (!inventory.has(id)) {
      throw new RangeError("blocked vector is outside the frozen inventory snapshot");
    }
  }
  // `blocked` is an overlapping eligibility dimension, never a fourth term.
  return {
    total: inventory.size,
    selected: selected.size,
    excluded: excluded.size,
    blocked: blocked.size,
  };
}

export type CaseState = "passed" | "failed" | "blocked" | "skipped";

export type PlanCounts = {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
};

export function planCounts(cases: readonly { state: CaseState }[]): PlanCounts {
  const counts: PlanCounts = { total: cases.length, passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const entry of cases) {
    counts[entry.state] += 1;
  }
  return counts;
}

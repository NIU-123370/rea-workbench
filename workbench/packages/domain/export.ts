import type { Id } from "./identity.ts";
import type { DeliverabilityGate, ReportIdentities, VerificationReport } from "./report.ts";
import { passRate } from "./report.ts";

// What an export package may and may not claim (DESIGN §10 exports, §11 cleanup /
// PRD F11, issue #22).
//
// The rule under everything here is that a package never makes a promise a report did
// not already make. `verified-samples` is a label only a current, cleaned-up, published
// PASS can carry; anything else is a `draft`, and a draft has to say in the package
// itself why it is not verified — a file name the reader trusts and a status only a
// manifest footnote explains is how a stale report gets delivered as a pass.
//
// The manifest carries no digest of its own: its identity is the digest of the archive
// that holds it, so changing a field changes the bytes and the recorded digest together,
// and an old package can never be overwritten (§5).

export const EXPORT_LABELS = ["draft", "verified-samples"] as const;

export type ExportLabel = (typeof EXPORT_LABELS)[number];

export type ExportPart = { name: string; sha256: string; byteLength: number };

export type ExportManifestContent = {
  schemaVersion: 1;
  label: ExportLabel;
  packageKind: "zip-stored";
  projectId: Id;
  candidateId: Id;
  verificationId: Id | null;
  blueprintId: Id;
  planId: Id | null;
  // The eight bound identities, or null when nothing was verified: a draft must not be
  // able to fill these in with whatever the rows happen to say today.
  bound: ReportIdentities | null;
  statusNote: string[];
  deliverability: DeliverabilityGate;
  openApiVersion: string;
  parts: ExportPart[];
};

// A `verified-samples` package's note is empty precisely because the gate is the claim:
// a non-empty reason there would be a package labelled verified that something already
// said is not. A draft always says why.
export function statusNoteFor(label: ExportLabel, gate: DeliverabilityGate, hasVerification: boolean): string[] {
  if (label === "verified-samples") return gate.reasons;
  if (gate.reasons.length > 0) return gate.reasons;
  return hasVerification ? ["labelled-draft"] : ["no-verification-record"];
}

export function exportStatusDefects(
  label: ExportLabel,
  gate: DeliverabilityGate,
  note: readonly string[],
  verificationId: Id | null,
): string[] {
  if (label !== "verified-samples") {
    return note.length === 0 ? ["draft-status-note-missing"] : [];
  }
  const reasons = gate.canExportVerifiedSamples
    ? []
    : gate.reasons.map((reason: string) => `verified-samples-blocked:${reason}`);
  if (verificationId === null) reasons.push("verified-samples-blocked:no-verification-bound");
  return reasons;
}

// Only a relative local route. An absolute URL or a caller-supplied path would let a
// manifest point a client somewhere other than this workbench's own download (§8).
export function downloadUrlFor(projectId: Id, exportId: Id): string {
  return `/api/v1/projects/${projectId}/exports/${exportId}/download`;
}

export function isRelativeDownloadUrl(url: string): boolean {
  return url.startsWith("/api/v1/projects/") && !url.startsWith("//") && !/^[a-z]+:/i.test(url);
}

// The declared set of files a package may hold. An entry outside this list, or a missing
// one, is refused before the archive is assembled: the ZIP's own name checks
// (`packages/domain/zip.ts`) catch path traversal, this catches content substitution.
// The two report entries exist only when a verification is bound, because a draft with
// nothing verified cannot carry a report.
export const EXPORT_CORE_ENTRIES = [
  "MANIFEST.json",
  "adapter.ts",
  "openapi.json",
  "candidate-manifest.json",
  "blueprint.json",
] as const;

export const EXPORT_REPORT_ENTRIES = ["reports/verification.json", "reports/coverage.json"] as const;

export function declaredPackageEntries(bound: boolean): string[] {
  return bound ? [...EXPORT_CORE_ENTRIES, ...EXPORT_REPORT_ENTRIES] : [...EXPORT_CORE_ENTRIES];
}

export function packageEntryDefects(names: readonly string[], bound: boolean): string[] {
  const reasons: string[] = [];
  const declared = declaredPackageEntries(bound);
  const declaredSet = new Set<string>(declared);
  for (const name of names) {
    if (!declaredSet.has(name)) reasons.push(`undeclared-package-entry:${name}`);
  }
  for (const name of declared) {
    if (!names.includes(name)) reasons.push(`missing-package-entry:${name}`);
  }
  return reasons;
}

// Coverage is a projection of the published report, never a second measurement: the
// numbers a reader sees in the package are the ones the report froze, and the two
// denominators keep their §10 split (`counts` is the frozen plan, `inventory` the whole
// snapshot).
export function coverageOf(report: VerificationReport): Record<string, unknown> {
  return {
    result: report.result,
    planDenominator: report.counts.total,
    counts: {
      passed: report.counts.passed,
      failed: report.counts.failed,
      blocked: report.counts.blocked,
      skipped: report.counts.skipped,
    },
    passRate: passRate(report.counts),
    frozenScope: [...report.scope],
    inventory: {
      total: report.inventoryCounts.total,
      selected: report.inventoryCounts.selected,
      excluded: report.inventoryCounts.excluded,
      blocked: report.inventoryCounts.blocked,
    },
    excludedVectors: report.excludedVectors.map((entry) => ({
      vectorId: entry.vectorId,
      reasonCode: entry.reasonCode,
    })),
    limitations: [...report.limitations],
    note: "projected from the published report; no number here is recomputed",
  };
}

import { describe, expect, it } from "vitest";

import { asDigest } from "../../packages/domain/canonical-json.ts";
import { newId } from "../../packages/domain/identity.ts";
import type { PlanCounts } from "../../packages/domain/inventory.ts";
import type { DeliverabilityGate, ReportIdentities, VerificationReport } from "../../packages/domain/report.ts";
import {
  coverageOf,
  declaredPackageEntries,
  downloadUrlFor,
  exportStatusDefects,
  EXPORT_CORE_ENTRIES,
  EXPORT_REPORT_ENTRIES,
  isRelativeDownloadUrl,
  packageEntryDefects,
  statusNoteFor,
} from "../../packages/domain/export.ts";

// The label rules for an export package (DESIGN §10, §11 / PRD F11, issue #22).
//
// These cases exist because the two labels have to mean different things *in the
// package*, not only in the UI: a draft states why it is not verified, a
// `verified-samples` package states nothing beyond the gate that already passed, and
// neither may point a reader at a path this workbench does not serve.

const CANDIDATE = newId();
const PROJECT = newId();
const SAMPLE = newId();

function gate(reasons: string[]): DeliverabilityGate {
  return { canExportVerifiedSamples: reasons.length === 0, reasons };
}

describe("the label carries the gate that produced it", () => {
  it("a draft always states why it is not verified", () => {
    expect(statusNoteFor("draft", gate(["result-unknown", "report-unpublished"]), false)).toEqual([
      "result-unknown",
      "report-unpublished",
    ]);
    // Nothing blocking it and the operator still chose draft: the note says exactly that
    // rather than inventing a defect.
    expect(statusNoteFor("draft", gate([]), false)).toEqual(["no-verification-record"]);
    expect(statusNoteFor("draft", gate([]), true)).toEqual(["labelled-draft"]);
  });

  it("a verified-samples note is empty or the label is wrong", () => {
    expect(statusNoteFor("verified-samples", gate([]), true)).toEqual([]);
    expect(statusNoteFor("verified-samples", gate(["cleanup-pending"]), true)).toEqual(["cleanup-pending"]);
    expect(exportStatusDefects("verified-samples", gate(["cleanup-pending"]), ["cleanup-pending"], newId())).toEqual([
      "verified-samples-blocked:cleanup-pending",
    ]);
    // The label alone is not enough: with nothing bound, there is no current PASS to name.
    expect(exportStatusDefects("verified-samples", gate([]), [], null)).toEqual([
      "verified-samples-blocked:no-verification-bound",
    ]);
    expect(exportStatusDefects("verified-samples", gate([]), [], newId())).toEqual([]);
  });

  it("a draft whose note was dropped is refused, whatever the gate said", () => {
    // The note is what makes a draft a draft. An empty one is a defect even when the gate
    // itself had reasons to report.
    expect(exportStatusDefects("draft", gate(["result-unknown"]), [], newId())).toEqual(["draft-status-note-missing"]);
    expect(exportStatusDefects("draft", gate(["result-unknown"]), ["result-unknown"], newId())).toEqual([]);
    expect(exportStatusDefects("draft", gate([]), [], newId())).toEqual(["draft-status-note-missing"]);
  });
});

describe("the download route is only ever this API's own", () => {
  it("builds a relative path from the two ids and nothing else", () => {
    const url = downloadUrlFor(PROJECT, CANDIDATE);
    expect(url).toBe(`/api/v1/projects/${PROJECT}/exports/${CANDIDATE}/download`);
    expect(isRelativeDownloadUrl(url)).toBe(true);
  });

  it("refuses absolute spellings, protocol-relative ones and foreign hosts", () => {
    for (const url of [
      "http://127.0.0.1:4310/api/v1/projects/x/exports/y/download",
      "//example.com/api/v1/projects/x/exports/y/download",
      "file:///etc/passwd",
      "/api/v1/other/x/exports/y/download",
      "https://api.example.com/download",
    ]) {
      expect(isRelativeDownloadUrl(url), url).toBe(false);
    }
  });
});

describe("a package holds exactly the entries its label allows", () => {
  it("adds the two report entries only when a verification is bound", () => {
    expect(declaredPackageEntries(false)).toEqual([...EXPORT_CORE_ENTRIES]);
    expect(declaredPackageEntries(true)).toEqual([...EXPORT_CORE_ENTRIES, ...EXPORT_REPORT_ENTRIES]);
  });

  it("refuses an undeclared entry and a missing one", () => {
    const honest = declaredPackageEntries(true);
    expect(packageEntryDefects(honest, true)).toEqual([]);
    expect(packageEntryDefects([...honest, "holdout.json"], true)).toContain("undeclared-package-entry:holdout.json");
    expect(packageEntryDefects(honest.filter((name) => name !== "adapter.ts"), true)).toContain(
      "missing-package-entry:adapter.ts",
    );
    // A draft that promises report entries it cannot have is caught the same way.
    expect(packageEntryDefects([...EXPORT_CORE_ENTRIES, ...EXPORT_REPORT_ENTRIES], false)).toEqual([
      "undeclared-package-entry:reports/verification.json",
      "undeclared-package-entry:reports/coverage.json",
    ]);
  });
});

describe("coverage is a projection of the report, not a new measurement", () => {
  const report = (counts: Partial<PlanCounts> = {}): VerificationReport => {
    const planCounts: PlanCounts = { passed: 2, failed: 0, blocked: 0, skipped: 0, total: 2, ...counts };
    return {
      id: newId(),
      candidateId: CANDIDATE,
      result: "PASS",
      currentness: "current",
      digest: asDigest("a".repeat(64)),
      scope: ["getCart"],
      identities: {
        snapshotDigest: asDigest("1".repeat(64)),
        blueprintDigest: asDigest("2".repeat(64)),
        candidateDigest: asDigest("3".repeat(64)),
        vectorSetDigest: asDigest("4".repeat(64)),
        planDigest: asDigest("5".repeat(64)),
        inventoryDigest: asDigest("6".repeat(64)),
        comparatorDigest: asDigest("7".repeat(64)),
        runnerImageDigest: asDigest("8".repeat(64)),
      } satisfies ReportIdentities,
      counts: planCounts,
      inventoryCounts: { total: 5, selected: 2, excluded: 2, blocked: 1 },
      excludedVectors: [{ vectorId: SAMPLE, reasonCode: "outside-scope" }],
      outcomes: [],
      limitations: ["no retry semantics observed"],
    };
  };

  it("keeps §10's two denominators apart", () => {
    const coverage = coverageOf(report());
    expect(coverage.planDenominator).toBe(2);
    expect((coverage.inventory as { total: number }).total).toBe(5);
    expect(coverage.passRate).toBe(1);
    expect(coverage.result).toBe("PASS");
    expect(coverage.frozenScope).toEqual(["getCart"]);
    expect(coverage.excludedVectors).toEqual([{ vectorId: SAMPLE, reasonCode: "outside-scope" }]);
    expect(coverage.limitations).toEqual(["no retry semantics observed"]);
  });

  it("a blocked case is visible in coverage and is not smoothed over", () => {
    const blocked = coverageOf(report({ passed: 1, blocked: 1, total: 2 }));
    expect((blocked.counts as { blocked: number }).blocked).toBe(1);
    // passRate stays passed/total, so a blocked case lowers it instead of disappearing.
    expect(blocked.passRate).toBe(0.5);
  });

  it("an empty plan has no pass rate rather than a zero", () => {
    expect(coverageOf(report({ passed: 0, failed: 0, total: 0 })).passRate).toBeNull();
  });

  it("the projection never mutates the report it read", () => {
    const source = report();
    const snapshot = JSON.stringify(source);
    coverageOf(source);
    expect(JSON.stringify(source)).toBe(snapshot);
  });
});

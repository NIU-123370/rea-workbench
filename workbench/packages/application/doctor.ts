import type { JsonValue } from "../domain/json-value.ts";

// Doctor (DESIGN §14): a report, never a repair.
//
// Each check is injected, so the doctor can be run against a host that genuinely
// has Docker and REA and against this one, where it does not. "This build cannot
// verify X here" is a distinct answer from "X is fine", and the report says which
// one it is: a degraded run that reads as ready is how a broken install ships.

export type CheckName =
  | "toolchain"
  | "rea-package"
  | "rea-identity"
  | "sandbox-profile"
  | "broker-socket"
  | "network-lockdown"
  | "storage-layout"
  | "worker-lock"
  | "limits"
  // §10's trusted evaluator is a separate process this build does not ship, so a queued `verify`
  // job has no executor here. The doctor is the surface that says "this capability is absent" out
  // loud, which is what keeps `queued` from reading as "someone is working on it" (issue #75).
  | "verification-executor"
  // The same absence for the two kinds §8 line 275 can queue: a capture needs a browser lane and an
  // inspect needs the archive decoder, and the runner's kind list is `build` only. Kept as its own
  // name rather than folded into the one above because they are different absences - installing an
  // evaluator would not make a queued capture go anywhere (issue #58's last door).
  | "target-work-executor";

export type CheckOutcome =
  | { state: "ok"; facts: JsonValue }
  // Something is not enforced, but the operator chose a configuration where that
  // is acceptable (for example a capture-only install without a model endpoint).
  | { state: "degraded"; reasons: string[] }
  // A hard failure: the workbench must not present itself as usable.
  | { state: "failed"; reasons: string[] };

export type DoctorCheck = {
  name: CheckName;
  run: () => Promise<CheckOutcome> | CheckOutcome;
};

export type DoctorReport = {
  ready: boolean;
  degraded: boolean;
  checks: { name: CheckName; state: CheckOutcome["state"]; reasons: string[]; facts: JsonValue | null }[];
};

// Reasons are reason codes. A check that returns a path, a version string from an
// untrusted source or any config value breaks the §14 rule that the doctor reports
// names and safe reasons only, so the report builder filters to that shape.
export async function runDoctor(checks: readonly DoctorCheck[]): Promise<DoctorReport> {
  const report: DoctorReport = { ready: true, degraded: false, checks: [] };
  for (const check of checks) {
    let outcome: CheckOutcome;
    try {
      outcome = await check.run();
    } catch (error) {
      outcome = { state: "failed", reasons: [`probe-threw:${errorKind(error)}`] };
    }
    report.checks.push({
      name: check.name,
      state: outcome.state,
      reasons: "reasons" in outcome ? outcome.reasons.map(safeToken) : [],
      facts: "facts" in outcome ? outcome.facts : null,
    });
    if (outcome.state === "failed") report.ready = false;
    if (outcome.state === "degraded") report.degraded = true;
  }
  // A missing check is a failure of the doctor itself, not a silent pass.
  if (checks.length === 0) report.ready = false;
  return report;
}

function errorKind(error: unknown): string {
  if (error instanceof Error) return error.name.replace(/[^A-Za-z]/g, "");
  return typeof error;
}

function safeToken(text: string): string {
  // Keep codes, drop anything that looks like a path or a URL so a check cannot
  // leak a host location through the doctor output.
  const trimmed = text.trim();
  if (/^[\w.:=-]{1,80}$/.test(trimmed)) return trimmed;
  return "unprintable-reason";
}

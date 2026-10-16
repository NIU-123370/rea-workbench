import type { ReaEvidence } from "../../contracts/rea-evidence.ts";
import type { Result } from "../../domain/result.ts";
import { isReaEvidenceId } from "../../domain/identity.ts";

// Which envelope fields may become workbench index columns (DESIGN §4, §5).
//
// §5 is explicit that an index must not become a second semantic source, so the
// projection below only lifts identity fields the schema already fixed in
// §1-mirrored form; the complete envelope is preserved verbatim, snake_case and
// all, as an immutable artifact and is what `GET /projects/:p/evidence/:e`
// returns. Nothing here renames, defaults or "repairs" an upstream field.
//
// Semantic authentication of `evidence_id` is deliberately NOT recomputed: REA
// derives it from its own canonical projection of the record, and a workbench
// copy of that algorithm would drift from the owner it is meant to verify. The
// enforcing path is REA itself — `import_evidence_bundle` validates every
// Evidence ID and canonical manifest on read (DESIGN §9 item 6), which is wired
// up in S14 and tracked on issue #14.

export type ProjectionFailureReason = "evidence-id-malformed" | "envelope-not-authenticated";

export type ProjectionFailure = { code: "REA_CONTRACT_MISMATCH"; reason: ProjectionFailureReason };

export type ReaProviderIdentity = {
  id: string;
  name: string;
  version: string | null;
};

export type WorkbenchEvidenceIndex = {
  evidenceId: string;
  operation: string;
  confidence: ReaEvidence["confidence"];
  authority: ReaEvidence["authority"];
  provider: ReaProviderIdentity;
  // Kept separate from the stored artifact digest on purpose (§5 targets row).
  sourceSha256: string | null;
  identityReason: string | null;
  locationsRetained: boolean;
};

export function projectEvidenceIndex(
  evidence: ReaEvidence,
): Result<WorkbenchEvidenceIndex, ProjectionFailure> {
  if (!isReaEvidenceId(evidence.evidence_id)) {
    return {
      ok: false,
      error: { code: "REA_CONTRACT_MISMATCH", reason: "evidence-id-malformed" },
    };
  }
  const subject = evidence.subject;
  const sourceSha256 = subject ? subject.digest.sha256 : null;
  return {
    ok: true,
    value: {
      evidenceId: evidence.evidence_id,
      operation: evidence.operation,
      confidence: evidence.confidence,
      authority: evidence.authority,
      provider: {
        id: evidence.provider.id,
        name: evidence.provider.name,
        version: evidence.provider.version,
      },
      sourceSha256,
      // A withheld digest is a disclosed unknown, never an empty string and
      // never a re-derived value.
      identityReason: sourceSha256 === null ? "producer-withheld-or-declared-sensitive" : null,
      locationsRetained: evidence.locations.length > 0,
    },
  };
}

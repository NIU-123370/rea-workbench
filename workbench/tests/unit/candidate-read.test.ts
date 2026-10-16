import { describe, expect, it } from "vitest";

import { CANDIDATE_BODY_LIMIT_BYTES, CandidateReadService } from "../../packages/application/candidate-read.ts";
import { asDigest, digestBytes } from "../../packages/domain/canonical-json.ts";
import { asInstant, newId } from "../../packages/domain/identity.ts";
import type { Id } from "../../packages/domain/identity.ts";
import type { Actor } from "../../packages/application/actor.ts";
import type { JsonValue } from "../../packages/domain/json-value.ts";
import type { ArtifactRow, CandidateRow, StorageWriterPort } from "../../packages/application/ports.ts";
import type { ArtifactPort } from "../../packages/application/ports.ts";
import type { GateFailure } from "../../packages/application/gate-failure.ts";
import type { Result } from "../../packages/domain/result.ts";

// The candidate read's own edges, against a fake index (DESIGN §8 lines 295-296, §5).
//
// The integration file proves the happy path against real Builder bytes. This one exists for
// the branches a real generation cannot be talked into producing: a file over the inline
// limit, a manifest with no entries or two entries for one artifact, an artifact row that
// moved to another permission class, and bytes that no longer hash to what was promised.

const inspector: Actor = { actorId: "local-operator", actorKind: "inspector" };
const projectId: Id = newId();
const candidateId: Id = newId();
const blueprintId: Id = newId();

const FILE_A = new TextEncoder().encode("export const ROUTE = {};");
const SHA_A = digestBytes(FILE_A);

function artifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: newId(),
    projectId,
    jobId: null,
    class: "candidate",
    sha256: SHA_A,
    digestReason: null,
    byteLength: FILE_A.byteLength,
    storageKey: `projects/${projectId}/artifacts/candidate/${SHA_A}.ts`,
    mediaType: "text/typescript",
    createdAt: asInstant("2026-10-16T00:00:00.000Z"),
    ...overrides,
  };
}

function candidateWith(manifest: JsonValue): CandidateRow {
  return {
    id: candidateId,
    projectId,
    blueprintId,
    jobId: newId(),
    artifactId: newId(),
    digest: asDigest("a".repeat(64)),
    generatorJson: {},
    dependencyManifestJson: manifest,
  };

}

function serviceWith(input: {
  candidate?: CandidateRow | null;
  artifacts?: ArtifactRow[];
  bytes?: Uint8Array | null;
  readError?: string;
}): CandidateReadService {
  const rows = new Map((input.artifacts ?? []).map((row) => [String(row.id), row]));
  const candidate = input.candidate === undefined ? candidateWith({ files: [] }) : input.candidate;
  const storage = {
    transact(fn: (tx: unknown) => unknown) {
      const tx = {
        getCandidate: () => candidate,
        getArtifact: (_project: Id, id: Id) => rows.get(String(id)) ?? null,
      };
      return { ok: true, value: fn(tx) } as Result<unknown, never>;
    },
  } as unknown as StorageWriterPort;
  const artifacts = {
    async read() {
      if (input.readError !== undefined) {
        return { ok: false, error: { code: input.readError as "ARTIFACT_MISMATCH", message: "the store refused" } };
      }
      return input.bytes === null || input.bytes === undefined
        ? { ok: false, error: { code: "ARTIFACT_MISMATCH" as const, message: "no bytes" } }
        : { ok: true, value: input.bytes };
    },
  } as unknown as ArtifactPort;
  return new CandidateReadService({ storage, artifacts });
}

async function refusalOf(settled: Promise<Result<unknown, GateFailure>>): Promise<GateFailure> {
  const outcome = await settled;
  if (outcome.ok) throw new Error("expected a refusal, got a value");
  return outcome.error;
}

function entry(artifactRow: ArtifactRow) {
  return { path: "adapter.ts", sha256: artifactRow.sha256 as string, artifactId: artifactRow.id as string };
}

describe("what the candidate read refuses", () => {
  it("names the inline limit instead of truncating a big file", async () => {
    const row = artifact({ byteLength: CANDIDATE_BODY_LIMIT_BYTES + 1 });
    const service = serviceWith({ candidate: candidateWith({ files: [entry(row)] }), artifacts: [row], bytes: FILE_A });
    // Listing is allowed: the size is a fact about the file, and the reviewer needs it to
    // decide. Only the content route turns it into a refusal.
    const view = service.get(projectId, inspector, candidateId);
    if (!view.ok) throw new Error("a candidate with a large file still has a readable list");
    expect(view.value.files[0]?.byteLength).toBe(CANDIDATE_BODY_LIMIT_BYTES + 1);
    const denied = await refusalOf(service.file(projectId, inspector, candidateId, row.id));
    expect(denied.code).toBe("RESOURCE_LIMIT");
    expect(denied.reason).toBe("candidate-file-over-inline-limit");
    // The reply says how big it is and what the bound was, so the UI can offer the
    // download route rather than show half a file.
    expect(denied.details).toEqual({ byteLength: CANDIDATE_BODY_LIMIT_BYTES + 1, limit: CANDIDATE_BODY_LIMIT_BYTES });
  });

  it("rejects a manifest with no entries", async () => {
    const service = serviceWith({ candidate: candidateWith({ files: [] }) });
    const refused = await refusalOf(Promise.resolve(service.get(projectId, inspector, candidateId)));
    expect(refused.reason).toBe("candidate-manifest-unreadable");
  });

  it("rejects a manifest that names one artifact twice", async () => {
    const row = artifact();
    const service = serviceWith({
      candidate: candidateWith({ files: [entry(row), entry(row)] }),
      artifacts: [row],
    });
    const refused = await refusalOf(Promise.resolve(service.get(projectId, inspector, candidateId)));
    expect(refused.reason).toBe("candidate-manifest-duplicate-artifact");
  });

  it("keeps a candidate file inside the candidate permission class", async () => {
    const row = artifact({ class: "report" });
    const service = serviceWith({ candidate: candidateWith({ files: [entry(row)] }), artifacts: [row] });
    const refused = await refusalOf(Promise.resolve(service.get(projectId, inspector, candidateId)));
    expect(refused.code).toBe("ACCESS_DENIED");
    expect(refused.reason).toBe("candidate-artifact-class");
  });

  it("reports a manifest entry whose artifact row is gone", async () => {
    const row = artifact();
    const service = serviceWith({ candidate: candidateWith({ files: [entry(row)] }), artifacts: [] });
    const refused = await refusalOf(Promise.resolve(service.get(projectId, inspector, candidateId)));
    expect(refused.reason).toBe("candidate-artifact-missing");
  });

  it("will not show bytes that no longer hash to the promised digest", async () => {
    const row = artifact();
    const service = serviceWith({
      candidate: candidateWith({ files: [entry(row)] }),
      artifacts: [row],
      bytes: new TextEncoder().encode("different bytes entirely"),
    });
    const refused = await refusalOf(service.file(projectId, inspector, candidateId, row.id));
    expect(refused.code).toBe("STALE_INPUT");
    expect(refused.reason).toBe("candidate-file-digest-disagrees");
  });

  it("maps a store failure onto a named code rather than the port's own", async () => {
    const row = artifact();
    const service = serviceWith({ candidate: candidateWith({ files: [entry(row)] }), artifacts: [row], readError: "STAGING_UNVERIFIED" });
    const refused = await refusalOf(service.file(projectId, inspector, candidateId, row.id));
    expect(refused.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(refused.reason).toBe("candidate-file-unreadable");
  });

  it("answers a well-formed manifest with the file's own bytes", async () => {
    const row = artifact({ mediaType: "text/plain" });
    const service = serviceWith({ candidate: candidateWith({ files: [entry(row)] }), artifacts: [row], bytes: FILE_A });
    const view = service.get(projectId, inspector, candidateId);
    if (!view.ok) throw new Error("the manifest was well formed and still refused");
    // Language falls back to the media type's subtype rather than a guess from the name.
    expect(view.value.files[0]?.language).toBe("plain");
    const content = await service.file(projectId, inspector, candidateId, row.id);
    if (!content.ok) throw new Error("the read refused bytes that match their promise");
    expect(content.value.content).toBe("export const ROUTE = {};");
    expect(content.value.sha256).toBe(SHA_A);
    expect(JSON.stringify(view.value)).not.toContain(row.storageKey);
  });
});

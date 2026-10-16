import { candidateManifestSchema } from "../contracts/candidate.ts";
import { parseStrict } from "../contracts/parse.ts";
import type { Digest } from "../domain/canonical-json.ts";
import { asDigest, digestBytes } from "../domain/canonical-json.ts";
import { asId, type Id } from "../domain/identity.ts";
import type { Result } from "../domain/result.ts";
import type { Actor } from "./actor.ts";
import { isBuilder } from "./actor.ts";
import { gateFail, type GateFailure } from "./gate-failure.ts";
import type { ArtifactPort, StorageWriterPort } from "./ports.ts";

// The candidate file read (DESIGN §8 lines 295-296, §5 / PRD F08, issue #19).
//
// §8 gives this surface exactly two shapes: the list of files a candidate published, and
// the content of one of them. Both are derived from the manifest row the Builder committed
// and the artifact rows the store wrote - never from a path the caller supplied. That is
// what makes the route safe to mount at all: `:f` selects a manifest entry, so there is no
// string a client can send that reaches the filesystem.
//
// The content reply also re-hashes the bytes it read. A stored index that no longer matches
// its own file is a refusal rather than a silent read, because the alternative is showing a
// reviewer source code under a digest that never produced it.

// §8 says a file over the body limit is served through the same-origin authorized download
// instead of riding in a JSON string. The limit is declared here so the refusal is a number
// the UI can quote, not an implementation detail.
export const CANDIDATE_BODY_LIMIT_BYTES = 256 * 1024;

export type CandidateFileView = {
  id: Id;
  path: string;
  byteLength: number;
  language: string;
  sha256: Digest;
};

export type CandidateView = { id: Id; blueprintId: Id; digest: Digest; files: CandidateFileView[] };
export type CandidateFileContent = { fileId: Id; content: string; sha256: Digest };

// Language comes from the media type the store already holds for those bytes. The subtype
// is the fallback rather than a guess from the file name: a candidate that shipped
// `.ts` under some other media type is a fact worth showing, not a thing to rename.
function languageOf(mediaType: string): string {
  if (mediaType === "text/typescript") return "typescript";
  if (mediaType === "application/json") return "json";
  return mediaType.split("/")[1] ?? mediaType;
}

export class CandidateReadService {
  readonly storage: StorageWriterPort;
  readonly artifacts: ArtifactPort;

  constructor(deps: { storage: StorageWriterPort; artifacts: ArtifactPort }) {
    this.storage = deps.storage;
    this.artifacts = deps.artifacts;
  }

  // One pass over the rows, in the same transaction: a candidate whose manifest names an
  // artifact that is not there, or is not a candidate-class artifact of this project, is
  // reported as the inconsistency it is.
  private resolve(projectId: Id, actor: Actor, candidateId: Id): Result<CandidateView, GateFailure> {
    // The generation side already holds the frozen handoff it was built from. Reading a
    // committed candidate back through this route would hand it the control plane's view
    // of every file, so the actor check is first and journalled by the caller's envelope.
    if (isBuilder(actor)) {
      return gateFail("ACCESS_DENIED", "builder-may-not-read-candidate", "the Builder does not read committed candidates back");
    }
    const loaded = this.storage.transact((tx): Result<CandidateView, GateFailure> => {
      const candidate = tx.getCandidate(projectId, candidateId);
      if (candidate === null) return gateFail("NOT_FOUND", "candidate-unknown", "no candidate is addressed by that identifier in this project");
      const manifest = parseStrict(candidateManifestSchema, candidate.dependencyManifestJson);
      if (!manifest.ok) {
        return gateFail("REA_CONTRACT_MISMATCH", "candidate-manifest-unreadable", "the candidate row does not carry a manifest this read can resolve");
      }
      const seen = new Set<string>();
      const files: CandidateFileView[] = [];
      for (const entry of manifest.value.files) {
        if (seen.has(entry.artifactId)) {
          return gateFail("REA_CONTRACT_MISMATCH", "candidate-manifest-duplicate-artifact", "two manifest entries name the same artifact");
        }
        seen.add(entry.artifactId);
        const artifact = tx.getArtifact(projectId, asId(entry.artifactId));
        if (artifact === null) {
          return gateFail("REA_CONTRACT_MISMATCH", "candidate-artifact-missing", "a manifest entry names an artifact this project does not have");
        }
        if (artifact.class !== "candidate") {
          return gateFail("ACCESS_DENIED", "candidate-artifact-class", "a manifest entry points outside the candidate permission class");
        }
        if (artifact.sha256 !== entry.sha256) {
          return gateFail("STALE_INPUT", "candidate-artifact-disagrees", "the artifact row no longer matches the manifest that names it");
        }
        files.push({
          id: artifact.id,
          path: entry.path,
          byteLength: artifact.byteLength,
          language: languageOf(artifact.mediaType),
          sha256: asDigest(entry.sha256),
        });
      }
      return {
        ok: true,
        value: { id: candidate.id, blueprintId: candidate.blueprintId, digest: candidate.digest, files },
      };
    });
    if (!loaded.ok) return gateFail("CAPABILITY_UNAVAILABLE", loaded.error.code, loaded.error.message);
    return loaded.value;
  }

  get(projectId: Id, actor: Actor, candidateId: Id): Result<CandidateView, GateFailure> {
    return this.resolve(projectId, actor, candidateId);
  }

  // Where the bytes actually live. §5 keeps `storage_key` server-side, so this lookup is
  // deliberately not reachable through `CandidateView`: the reply shape has no field for it.
  private locate(projectId: Id, candidateId: Id, fileId: Id): Result<{ storageKey: string; sha256: Digest }, GateFailure> {
    const located = this.storage.transact((tx): Result<{ storageKey: string; sha256: Digest }, GateFailure> => {
      const candidate = tx.getCandidate(projectId, candidateId);
      if (candidate === null) return gateFail("NOT_FOUND", "candidate-unknown", "no candidate is addressed by that identifier in this project");
      const manifest = parseStrict(candidateManifestSchema, candidate.dependencyManifestJson);
      if (!manifest.ok) return gateFail("REA_CONTRACT_MISMATCH", "candidate-manifest-unreadable", "the candidate row does not carry a manifest this read can resolve");
      const entry = manifest.value.files.find((file) => file.artifactId === fileId);
      if (entry === undefined) {
        // Not a verdict about whether such a file exists anywhere: the selector is a
        // manifest id, and this candidate did not publish one by that name.
        return gateFail("NOT_FOUND", "candidate-file-unknown", "that file id is not part of this candidate's manifest");
      }
      const artifact = tx.getArtifact(projectId, asId(entry.artifactId));
      if (artifact === null || artifact.class !== "candidate" || artifact.sha256 !== entry.sha256) {
        return gateFail("STALE_INPUT", "candidate-artifact-disagrees", "the artifact row no longer matches the manifest that names it");
      }
      return { ok: true, value: { storageKey: artifact.storageKey, sha256: asDigest(entry.sha256) } };
    });
    if (!located.ok) return gateFail("CAPABILITY_UNAVAILABLE", located.error.code, located.error.message);
    return located.value;
  }

  async file(projectId: Id, actor: Actor, candidateId: Id, fileId: Id): Promise<Result<CandidateFileContent, GateFailure>> {
    const view = this.resolve(projectId, actor, candidateId);
    if (!view.ok) return view;
    const entry = view.value.files.find((file) => file.id === fileId);
    if (entry === undefined) {
      return gateFail("NOT_FOUND", "candidate-file-unknown", "that file id is not part of this candidate's manifest");
    }
    if (entry.byteLength > CANDIDATE_BODY_LIMIT_BYTES) {
      return gateFail("RESOURCE_LIMIT", "candidate-file-over-inline-limit", "this file is served through the download route, not as a JSON body", {
        byteLength: entry.byteLength,
        limit: CANDIDATE_BODY_LIMIT_BYTES,
      });
    }
    const located = this.locate(projectId, candidateId, fileId);
    if (!located.ok) return located;
    const stored = await this.artifacts.read(projectId, located.value.storageKey);
    if (!stored.ok) {
      return gateFail(stored.error.code === "ARTIFACT_MISMATCH" ? "STALE_INPUT" : "CAPABILITY_UNAVAILABLE", "candidate-file-unreadable", stored.error.message);
    }
    const actual = digestBytes(stored.value);
    if (actual !== located.value.sha256) {
      return gateFail("STALE_INPUT", "candidate-file-digest-disagrees", "the bytes stored under this key are not the bytes the manifest promised");
    }
    return {
      ok: true,
      value: { fileId: entry.id, content: new TextDecoder().decode(stored.value), sha256: located.value.sha256 },
    };
  }
}

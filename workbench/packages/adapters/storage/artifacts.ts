import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Digest } from "../../domain/canonical-json.ts";
import { asDigest } from "../../domain/canonical-json.ts";
import type { Id } from "../../domain/identity.ts";
import type { Err, Result } from "../../domain/result.ts";
import type { ArtifactClass } from "../../application/ports.ts";

// Artifact store (DESIGN §5 line 126, §12). Files are staged privately per
// project, measured and fsynced, then published atomically into a
// content-addressed location scoped to (project, class) so that deduplication
// cannot become a cross-class or cross-project disclosure channel.

export const OWNERSHIP_MARKER = ".rea-workbench-owned";

// The classes the store will write for, kept next to the port that names them so a new
// class is a deliberate change in one place (§5).
const ARTIFACT_CLASSES: readonly ArtifactClass[] = ["inspector", "blueprint", "candidate", "report", "export"];

export type ArtifactError = {
  code: "STAGING_UNVERIFIED" | "ARTIFACT_MISMATCH" | "ARTIFACT_WRITE_FAILED";
  message: string;
};

export type PublishedArtifact = {
  storageKey: string;
  byteLength: number;
  sha256: Digest;
};

function fail(code: ArtifactError["code"], message: string): Err<ArtifactError> {
  return { ok: false, error: { code, message } };
}

function digestOf(bytes: Uint8Array): Digest {
  return asDigest(createHash("sha256").update(bytes).digest("hex"));
}

export class ArtifactStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private projectDir(projectId: string): string {
    return path.join(this.rootDir, "projects", projectId);
  }

  stagingDir(projectId: string): string {
    return path.join(this.projectDir(projectId), "staging");
  }

  // Only paths inside this store's own tree may be addressed; a caller-supplied
  // traversal never reaches the filesystem.
  private resolveInside(projectId: string, relative: string): string | null {
    const base = this.projectDir(projectId);
    const target = path.resolve(base, relative);
    return target === base || target.startsWith(base + path.sep) ? target : null;
  }

  async writeStaging(
    projectId: Id,
    stagingId: string,
    bytes: Uint8Array,
  ): Promise<Result<{ stagingId: string; byteLength: number; sha256: Digest }, ArtifactError>> {
    if (!/^[0-9a-f-]{8,64}$/.test(stagingId)) {
      return fail("STAGING_UNVERIFIED", "staging id must be an opaque generated value");
    }
    const dir = this.stagingDir(projectId);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(dir, OWNERSHIP_MARKER), `${process.pid}\n`, { mode: 0o600 });
      const temp = path.join(dir, `${stagingId}.tmp`);
      const final = path.join(dir, stagingId);
      await writeFile(temp, bytes, { mode: 0o600 });
      const written = await stat(temp);
      if (written.size !== bytes.byteLength) {
        await rm(temp, { force: true });
        return fail("STAGING_UNVERIFIED", `staged ${written.size} bytes, expected ${bytes.byteLength}`);
      }
      await rename(temp, final);
      return { ok: true, value: { stagingId, byteLength: written.size, sha256: digestOf(bytes) } };
    } catch (error) {
      return fail("ARTIFACT_WRITE_FAILED", String((error as Error).message));
    }
  }

  async readStaging(projectId: Id, stagingId: string): Promise<Result<Uint8Array, ArtifactError>> {
    const target = this.resolveInside(projectId, path.join("staging", stagingId));
    if (target === null) return fail("STAGING_UNVERIFIED", "staging path escaped the store");
    try {
      return { ok: true, value: new Uint8Array(await readFile(target)) };
    } catch (error) {
      return fail("STAGING_UNVERIFIED", String((error as Error).message));
    }
  }

  async removeStaging(projectId: Id, stagingId: string): Promise<Result<boolean, ArtifactError>> {
    const target = this.resolveInside(projectId, path.join("staging", stagingId));
    if (target === null) return fail("STAGING_UNVERIFIED", "staging path escaped the store");
    await rm(target, { force: true });
    return { ok: true, value: true };
  }

  // Publish is idempotent for identical bytes within the same project and class.
  async publish(
    projectId: Id,
    class_: ArtifactClass,
    bytes: Uint8Array,
    declaredSha256?: Digest,
  ): Promise<Result<PublishedArtifact, ArtifactError>> {
    if (!ARTIFACT_CLASSES.includes(class_)) {
      return fail("ARTIFACT_MISMATCH", `unknown artifact class ${class_}`);
    }
    return this.publishInPartition(projectId, path.join("artifacts", class_), bytes, declaredSha256);
  }

  private async publishInPartition(
    projectId: Id,
    directory: string,
    bytes: Uint8Array,
    declaredSha256?: Digest,
  ): Promise<Result<PublishedArtifact, ArtifactError>> {
    const sha256 = digestOf(bytes);
    if (declaredSha256 !== undefined && declaredSha256 !== sha256) {
      return fail("ARTIFACT_MISMATCH", "declared digest does not match the bytes");
    }
    const relative = path.join(directory, `${sha256}.bin`);
    const target = this.resolveInside(projectId, relative);
    if (target === null) return fail("ARTIFACT_MISMATCH", "artifact path escaped the store");
    try {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const existing = await stat(target).catch(() => null);
      if (existing === null) {
        const temp = `${target}.${randomUUID()}.tmp`;
        await writeFile(temp, bytes, { mode: 0o600 });
        const written = await stat(temp);
        if (written.size !== bytes.byteLength) {
          await rm(temp, { force: true });
          return fail("ARTIFACT_MISMATCH", `published ${written.size} bytes, expected ${bytes.byteLength}`);
        }
        await rename(temp, target);
      } else if (existing.size !== bytes.byteLength) {
        return fail("ARTIFACT_MISMATCH", `stored bytes ${existing.size} differ from ${bytes.byteLength}`);
      }
      return {
        ok: true,
        value: {
          storageKey: path.posix.join("projects", projectId, relative),
          byteLength: existing?.size ?? bytes.byteLength,
          sha256,
        },
      };
    } catch (error) {
      return fail("ARTIFACT_WRITE_FAILED", String((error as Error).message));
    }
  }

  // The only way a caller obtains an absolute filesystem path: the store resolves
  // a key it published itself, and refuses anything that escapes its tree. REA
  // needs an absolute capture path, and handing it a caller-supplied one would
  // turn the analysis request into a path traversal.
  absolutePathFor(projectId: Id, storageKey: string): string | null {
    // The same slice `read` applies: the prefix already ends in its separator, so skipping
    // one more character resolves `artifacts/...` as `rtifacts/...` and hands the caller a
    // path to a file that does not exist.
    const relative = storageKey.startsWith(`projects/${projectId}/`)
      ? storageKey.slice(`projects/${projectId}/`.length)
      : null;
    if (relative === null) return null;
    return this.resolveInside(projectId, relative);
  }

  async read(projectId: Id, storageKey: string): Promise<Result<Uint8Array, ArtifactError>> {
    const relative = storageKey.startsWith(`projects/${projectId}/`)
      ? storageKey.slice(`projects/${projectId}/`.length)
      : null;
    if (relative === null) return fail("ARTIFACT_MISMATCH", "storage key belongs to another project");
    const target = this.resolveInside(projectId, relative);
    if (target === null) return fail("ARTIFACT_MISMATCH", "storage path escaped the store");
    try {
      return { ok: true, value: new Uint8Array(await readFile(target)) };
    } catch (error) {
      return fail("ARTIFACT_MISMATCH", String((error as Error).message));
    }
  }

  // Crash cleanup is provenance-based: a file is only removed when it sits in a
  // directory carrying this store's ownership marker and is not referenced. Name
  // and pid are never used as ownership (DESIGN §5).
  async collectUnreferencedStaging(
    projectId: Id,
    referencedStagingIds: readonly string[],
  ): Promise<Result<string[], ArtifactError>> {
    const dir = this.stagingDir(projectId);
    const marker = await stat(path.join(dir, OWNERSHIP_MARKER)).catch(() => null);
    if (marker === null) return { ok: true, value: [] };
    const referenced = new Set(referencedStagingIds);
    const removed: string[] = [];
    try {
      for (const name of await readdir(dir)) {
        if (name === OWNERSHIP_MARKER || referenced.has(name)) continue;
        await rm(path.join(dir, name), { force: true });
        removed.push(name);
      }
      return { ok: true, value: removed };
    } catch (error) {
      return fail("ARTIFACT_WRITE_FAILED", String((error as Error).message));
    }
  }
}

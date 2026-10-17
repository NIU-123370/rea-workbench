import { isId } from "../domain/identity.ts";
import type { Id } from "../domain/identity.ts";
import type { Result } from "../domain/result.ts";
import type { ProjectPage, ProjectSummary } from "../contracts/resources.ts";
import { PROJECT_LIST_DEFAULT_LIMIT, PROJECT_LIST_MAX_LIMIT } from "../contracts/resources.ts";
import type { Actor } from "./actor.ts";
import { isControlPlane } from "./actor.ts";
import { decodePageCursor, encodePageCursor } from "./page-cursor.ts";
import { gateFail, type GateFailure } from "./gate-failure.ts";
import type { ProjectRow, StorageWriterPort } from "./ports.ts";

// The project page (§8 line 270; PRD F01; issue #58).
//
// §8 names this read 仅本地操作者: a project's name and its two revision counters are the control
// plane's own inventory, and §7.3 gives a Builder the blueprint projection instead. So the role is
// decided before any row is looked at, and a refusal does not leak whether an id exists.
//
// The cursor is the last row's id, encoded by the shared codec: §8 gives the caller something to
// hand back, not something to author, and the codec's one real trap is that base64url decoding is
// lenient - so a cursor only counts as ours if it re-encodes to the characters it arrived as.

export type ProjectReadDeps = { readonly storage: StorageWriterPort };

export class ProjectReadService {
  readonly storage: StorageWriterPort;

  constructor(deps: ProjectReadDeps) {
    this.storage = deps.storage;
  }

  list(actor: Actor, input: { cursor: string | null; limit: number | null | undefined }): Result<ProjectPage, GateFailure> {
    if (!isControlPlane(actor)) {
      return gateFail("ACCESS_DENIED", "role-may-not-list-projects", "the project list is a control-plane view (§7.3)", {
        actorKind: actor.actorKind,
      });
    }
    const limit = input.limit ?? PROJECT_LIST_DEFAULT_LIMIT;
    if (limit > PROJECT_LIST_MAX_LIMIT) {
      return gateFail("RESOURCE_LIMIT", "projects-limit", `a project page is at most ${String(PROJECT_LIST_MAX_LIMIT)} rows`, {
        limit,
        maxLimit: PROJECT_LIST_MAX_LIMIT,
      });
    }
    let afterId: Id | null = null;
    if (input.cursor !== null) {
      const decoded = decodePageCursor(input.cursor, 1, "projects-cursor");
      if (!decoded.ok) return decoded;
      const [raw] = decoded.value as [string];
      if (!isId(raw)) return gateFail("INVALID_INPUT", "projects-cursor", "the page cursor is not one this server issued");
      afterId = raw;
    }
    // One row more than the page: that is how the read knows whether a nextCursor is a promise it
    // can keep, instead of a cursor pointing at a page the caller will find empty.
    const read = this.storage.transact((tx) => {
      const rows = tx.listProjectsAfter(afterId, limit + 1);
      return { page: rows.slice(0, limit), hasMore: rows.length > limit };
    });
    if (!read.ok) return gateFail("CAPABILITY_UNAVAILABLE", "projects-read-failed", "the project page could not be read");
    const items: ProjectSummary[] = read.value.page.map((row: ProjectRow) => ({
      id: row.id,
      name: row.name,
      graphRevision: row.graphRevision,
      inventoryRevision: row.inventoryRevision,
    }));
    const last = read.value.page[read.value.page.length - 1];
    return {
      ok: true,
      value: {
        items,
        nextCursor: read.value.hasMore && last !== undefined ? encodePageCursor([last.id]) : null,
      },
    };
  }
}

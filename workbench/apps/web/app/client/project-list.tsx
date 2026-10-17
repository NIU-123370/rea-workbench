"use client";

import { useCallback, useEffect, useState } from "react";

import { isSessionReason, PROJECTS_EMPTY_LINE, projectLine, projectsNotice, projectsPageOf } from "../../ui/view-model.ts";
import type { ProjectRow } from "../../ui/view-model.ts";
import { getJson, PairingForm } from "./workbench.tsx";

// The landing list (§8 line 270 / issue #58).
//
// Before this the page had a route keyed by a project id and no way to find one: `page.tsx` printed
// a template, so an operator arriving fresh had to already know the id - which is the one thing a
// list exists to remove. The cursor is carried verbatim from the previous response: it is a token
// this server minted, and a page that composed its own would be signing a request it was never
// given the authority to make.

const PAGE_LIMIT = 20;

export function ProjectList(): React.ReactElement {
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // The first paint is not yet a read. It shows the pairing instruction rather than 正在读取,
  // because a panel that spins while nothing can arrive is the failure the 样本 tab was caught at:
  // the session is what makes this list readable at all.
  const [notice, setNotice] = useState<string>(PROJECTS_EMPTY_LINE["no-session"]);
  // Whether what came back means "go pair". A fresh visitor has nowhere else to do that from: the
  // pairing form lives on a project page, and an operator who does not know a project id cannot get
  // to one - which is the dead end this list is here to remove.
  const [needsPairing, setNeedsPairing] = useState(true);

  const load = useCallback(async (cursor: string | null) => {
    const limit = `limit=${String(PAGE_LIMIT)}`;
    const got = await getJson(`/api/v1/projects?${cursor === null ? limit : `${limit}&cursor=${encodeURIComponent(cursor)}`}`);
    if (!got.ok) {
      setRows([]);
      setNextCursor(null);
      setNeedsPairing(isSessionReason(got.reason));
      setNotice(projectsNotice({ reason: got.reason, facts: got.facts }, 0));
      return;
    }
    const listed = projectsPageOf(got.value);
    setRows(listed.rows);
    setNextCursor(listed.nextCursor);
    setNeedsPairing(false);
    setNotice(projectsNotice(null, listed.rows.length));
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <section data-panel="project-list">
      <p>所有事实都从本机 API 读取；本页不带任何项目数据。</p>
      {needsPairing ? <PairingForm onPaired={() => void load(null)} /> : null}
      {rows.length === 0 ? (
        <p data-projects-empty>{notice}</p>
      ) : (
        <ul data-projects-count={String(rows.length)}>
          {rows.map((row) => (
            <li key={row.id} data-project-row={row.id}>
              <a href={`/project/${row.id}`}>{projectLine(row)}</a>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && notice !== "" ? <p data-projects-notice>{notice}</p> : null}
      {nextCursor === null ? (
        rows.length === 0 ? null : <p data-projects-end>没有更多项目了</p>
      ) : (
        <button type="button" data-projects-next={nextCursor.length} onClick={() => void load(nextCursor)}>
          下一页
        </button>
      )}
    </section>
  );
}

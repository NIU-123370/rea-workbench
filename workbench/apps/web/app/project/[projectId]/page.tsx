import { Suspense } from "react";

import { Workbench } from "../../client/workbench.tsx";

// One project's three columns (PRD F04 / issue #18). The path id is passed through
// untouched: the API, not this component, decides whether a project exists.

export default async function ProjectPage(props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  return (
    <Suspense fallback={<p>正在读取…</p>}>
      <Workbench projectId={projectId} />
    </Suspense>
  );
}

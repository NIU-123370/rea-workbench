import { ProjectList } from "./client/project-list.tsx";

// The landing route (issue #18, and §8 line 270's list from issue #58). It still shows no project
// data of its own: the list below is a client read through the same-origin proxy, so what appears
// is only what this visitor's session can read - an unpaired visitor sees the pairing instruction,
// not somebody else's project names.

export default function Home() {
  return (
    <section data-panel="landing">
      <h1>REA Workbench</h1>
      <ProjectList />
      <p>
        已经知道项目 id？直接打开：<a href="/project/00000000-0000-4000-8000-000000000000">/project/&lt;projectId&gt;</a>
      </p>
    </section>
  );
}

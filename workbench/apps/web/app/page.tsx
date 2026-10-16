// The landing route (issue #18). It deliberately shows no project data: a page can only
// display what the visitor's own session can read through the proxy, and this page holds
// no session of its own.

export default function Home() {
  return (
    <section data-panel="landing">
      <h1>REA Workbench</h1>
      <p>所有事实都从本机 API 读取；本页不带任何项目数据。</p>
      <p>
        打开某个项目的图：<a href="/project/00000000-0000-4000-8000-000000000000">/project/&lt;projectId&gt;</a>
      </p>
    </section>
  );
}

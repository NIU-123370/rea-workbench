import type { ReactNode } from "react";

import "./globals.css";

// The page shell DESIGN §3 names Next.js for (issue #18).
//
// The chrome carries no data: every fact on screen arrives through the UI proxy from the
// local API, so nothing here can show a claim the worker did not answer with.

export default function RootLayout(props: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <title>REA Workbench</title>
        <meta name="robots" content="noindex, nofollow" />
      </head>
      <body>
        <header>
          <strong>REA Workbench</strong>
          <nav>
            <a href="/">状态</a>
          </nav>
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

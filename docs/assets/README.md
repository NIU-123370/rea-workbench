# README visual assets

本目录保存 REA Workbench 的项目宣传素材。两张图均使用 Codex 内置 `image_gen.imagegen` 生成，未通过 API、CLI 或第三方素材库生成；文件已经复制到仓库，可直接供 README 引用。

这些图片表达产品设计愿景。**它们不是已实现 Web 界面的截图，也不是功能验证证据。** 请保留图中的概念标记及引用处的说明，不将图片中的示意结构、状态或产物当作当前实现状态。

## 素材

| 文件 | 尺寸 | 用途 | 说明 |
| --- | --- | --- | --- |
| [rea-workbench-hero.png](rea-workbench-hero.png) | 1672 × 941 | README 首屏项目宣传图 | 抽象软件结构与证据图谱；图内标记 `CONCEPT VISUAL` |
| [rea-workbench-concept.png](rea-workbench-concept.png) | 1672 × 941 | 三栏工作台设计愿景 | 图内标记 `INTERFACE CONCEPT · NOT A LIVE SCREENSHOT` |

视觉系列采用 graphite / midnight blue 底色、ice cyan 与 muted amber 点缀。保留 `observed`、`derived`、`inferred` 与 `unknown` 的语义区别；不使用虚构性能数字或验证完成率。

## 可复用的最终提示词

以下为每张资产实际发送给内置图像生成工具的完整最终提示词。工具参数均为 `transparent_background: false`，未传入参考图片。

### Hero

```text
Use case: ads-marketing
Asset type: polished wide README project hero banner for an open-source developer tool.
Primary request: Create an exceptionally designed editorial key visual for REA WORKBENCH, a local software archaeology and evidence-based analysis workbench. This is product vision art, not a screenshot of a shipping interface.
Scene/backdrop: A near-black graphite and midnight blue canvas, with a sophisticated abstract transparent software artifact sculpted from layered glass planes and precise wireframe traces. Fragmented program structures and fine luminous evidence nodes transition into a legible architectural constellation across the right two thirds. The constellation should feel like a calm, carefully reasoned discovery, not generic cybersecurity.
Composition/framing: Wide horizontal 16:9 canvas, ideally 2048 x 1152. Elegant magazine-cover hierarchy with generous negative space on the left. Put title at upper left, very large, two lines if needed: "REA" then "WORKBENCH". Put the exact subtitle below. The right side contains the beautiful evidence structure. Build in a subtle architectural baseline grid and tiny restrained numbered artifact tags as nonverbal detail only. A few fine amber, cyan, white luminous threads connect the glass evidence fragments to a cleaner architectural model at the far right. No crowded HUD.
Style/medium: premium developer-product campaign, physically based translucent glass sculpture with crisp typographic graphic design, restrained Swiss editorial layout. Purposeful, modern, tactile and technically literate. No photoreal computer hardware.
Color palette: charcoal, deep midnight blue, icy cyan and muted warm amber, soft off-white type. Refined low bloom; sharp contrast.
Text (verbatim): "REA WORKBENCH"; "From evidence to understanding"; "LOCAL SOFTWARE ARCHAEOLOGY"; "CONCEPT VISUAL".
Typography: large sophisticated neo-grotesk bold title, evenly tracked small uppercase eyebrow, precise compact subtitle; all four strings spelled exactly. Make "CONCEPT VISUAL" clearly legible in a small bottom-left outlined label.
Constraints: communicate software structure, evidence lineage and interpretation, not a real app screenshot. Keep excellent readability at GitHub README width. No fake performance metrics, percentages, progress indicators, verified/pass badges, feature completion claims, invented product logos or additional copy. No extra words.
Avoid: hooded hackers, locks, shields, coins, tokens, Matrix green rain, circuit-board stock art, neon rainbow, gaming aesthetic, busy UI panels, glossy neon blob, fake terminal output, command text, people, watermark.
```

### Interface concept

```text
Use case: ui-mockup
Asset type: wide product vision illustration for the README of the open-source REA Workbench project.
Primary request: Create a premium three-column software archaeology workbench interface concept, aligned with the following art direction. The product currently has foundation modules but NO real Web UI. This image MUST visibly identify itself as an INTERFACE CONCEPT, not a real screenshot or evidence of a completed feature.
Scene/backdrop: sophisticated near-black graphite and midnight blue canvas, subtle architectural grid, clean layered panels, precise evidence-line diagrams, restrained translucent glass depth. Use ice cyan, warm muted amber, and off-white accents. Premium developer-product editorial design, calm and legible. No computer device mockup: show the conceptual workspace straight-on with a small margin around it.
Composition/framing: Wide horizontal 16:9 image, ideally 2048 x 1152. Top brand header "REA WORKBENCH". Immediately below the brand, a conspicuous and clearly legible full-width small banner says exactly "INTERFACE CONCEPT · NOT A LIVE SCREENSHOT". Below that is one cohesive workspace with three clearly separated columns. The middle column is widest. Use generous whitespace and strong typography rather than many tiny UI controls.
Left column title, exact text: "Sandbox & Probes". Below, three elegant source tiles labeled "HAR", "ASAR", "Web". Small abstract file cards and fine line paths indicate intake, with one clear source path into the center. Keep the tiles high-contrast and airy.
Center column title, exact text: "Evidence Canvas". A large spacious constellation of about eight connected evidence cards. Visually differentiate four evidence kinds without claiming certainty: "observed", "derived", "inferred", "unknown". These exact words must be legible once each on four principal cards, and may form a small readable legend. observed is cyan, derived is a distinct desaturated blue, inferred is amber, unknown is soft gray with a dotted outline. Keep these classes semantically separate; derived MUST NOT be labeled observed. Use precise thin solid and dotted connectors, provenance-style small stacked source-card shapes. Show an unresolved question-mark-shaped node softly at the edge. No green/pass/checkmark statuses.
Right column title, exact text: "Clean-Room Studio". Three clean stacked output document cards labeled exactly "Contract", "TypeScript SDK", "Report". Show neutral schematic line blocks inside them, without fake code or unreadable prose. A final elegant amber outline framing the contract suggests careful review rather than completed verification.
Text (verbatim): "REA WORKBENCH"; "INTERFACE CONCEPT · NOT A LIVE SCREENSHOT"; "Sandbox & Probes"; "Evidence Canvas"; "Clean-Room Studio"; "HAR"; "ASAR"; "Web"; "observed"; "derived"; "inferred"; "unknown"; "Contract"; "TypeScript SDK"; "Report".
Typography: meticulous neo-grotesk typography; exact spelling, strong readable column headings, minimal small text. This is a design concept with deliberately simplified interface elements, not an imitation of a running application.
Constraints: every text item above should be readable at README width. No other words. No fake performance metrics, percentages, progress bars, verified/pass badges, green completion checks, invented capabilities, charts of benchmark numbers, real browser chrome, or implied completed runs. Distinct evidence certainty classes retain their meaning. The concept disclaimer must be obvious at the top.
Avoid: tiny illegible UI prose, a crowded dashboard, excessive glowing HUD, hooded hackers, locks, shields, coins, Matrix rain, circuit board stock art, video-game interface, terminal text, people, watermarks.
```

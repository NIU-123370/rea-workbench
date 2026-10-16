# Workbench 应用

这里是 REA Workbench 的实现代码；产品与架构口径见仓库根部 README 链接的设计文档，
本文件只讲怎么在本地把它跑起来、以及哪些门禁是真存在的。

## 工具链

`node` 与 `npm` 必须精确等于 `.nvmrc` / `package.json` 的 `engines`（Node `24.18.0`、
npm `11.16.0`）。CI 会硬校验版本号，不匹配直接失败。运行方式：

```sh
npm ci
```

## 门禁命令

| 命令 | 做什么 | 失败时 |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit`，严格模式 + `erasableSyntaxOnly`（禁 enum / namespace / 构造器参数属性） | 检查变红 |
| `npm run test:unit` | `tests/unit/**`，纯逻辑与契约层 | 检查变红 |
| `npm run test:integration` | `tests/integration/**`，真 SQLite 文件、真文件系统、锁与迁移 | 检查变红 |
| `npm run lint` | oxlint（`no-unused-vars` 等 96 条规则） | 检查变红 |
| `npm run review` | 本仓库自带的评审 bot：7 条设计规则扫描，产出 `.review/findings.json` 与 `.review/summary.md` | 有 P1 时退出码 1 |

评审 bot 在 PR 上会自动跑并把结论贴成一条 review（`REQUEST_CHANGES` 或 `COMMENT`）；
本地也可以单独跑 `npm run review`，规则表在 `infra/review/rules.mjs`。

## 目录与依赖方向

`packages/{domain,contracts,application,adapters/*}`、`apps/{worker,web,broker}`、
`infra/`、`tests/`。谁可以 import 谁由 `tests/unit/architecture.test.ts` 按设计文档
§3 校验；`packages/domain` 另有一条守卫只允许相对路径与 `node:crypto`。
新增模块目录必须同时在那两个测试里登记，否则检查会红。

## 已实现模块

| 模块                                        | 现在真正负责的事                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`                           | 主张三色投影、canonical JSON 与两类摘要、不透明 Id / Instant、向量与契约语义、目标 SDK 的 OpenAPI 3.1.1 文档与候选 ABI（`openapi.ts`）、STORED ZIP 与导出标签规则（`zip.ts` / `export.ts`） |
| `packages/contracts`                        | 严格 wire schema 与上游镜像：`rea-evidence.ts`（envelope）、`rea-web-capture.ts`（抓包）、`rea-static-analysis.ts`（`analyze_javascript_application`）、`sandbox.ts`（broker 四命令与 egress 策略）、`rea-analysis-view.ts` / `rea-evidence-bundle.ts`（保留与导入导出）、`verification.ts`（比较器具名版本与 evaluator 完成回执）、`export.ts`（导出记录、manifest 与 ZIP 下载回执） |
| `packages/application`                      | VectorService / PlanService / ContractService / BlueprintService、`static-analysis.ts`（ASAR 静态支路）、`builder-service.ts`（蓝图 → 候选的唯一生成口）、`job-read.ts`＋`graph-read.ts`＋`candidate-read.ts`（§8 的三个具名读）、`verification-service.ts`（验证报告的唯一生产者）、`export-service.ts`（打包与 verified-samples 闸门的唯一消费方）、DiagnosticsSanitizer、AuditService、决策与事务日志 |
| `packages/adapters/rea`                     | MCP 回复解码、Evidence 索引投影、HTTP 抓包事实读取、session 身份、具名 schema 对账（`schema-reconciliation.ts`）与按引用保留（`retention.ts`）                    |
| `packages/adapters/storage`                 | 唯一 SQLite 写连接、增量迁移、按摘要落地的不可变 artifact store、一致性备份                                                                                 |
| `packages/adapters/sandbox`                 | broker 命令渲染、egress 地址判定、broker 帧编解码；隔离效果未经宿主验证                                                                                     |
| `infra/review`                              | 评审 bot 的规则表与扫描器，产出 `.review/findings.json` 与 `.review/summary.md`                                                                            |
| `infra/release` / `infra/perf`            | `docs:check`（T01–T17 ↔ A01–A13 对账）与 T17 图更新 p95 测量器（写机器可读记录，不代表 A13 已达标）                                                        |
| `tests/{unit,integration,fixtures,support}` | 纯逻辑门禁、真 SQLite / 真文件门禁、固定 envelope fixture，以及跨套件共用的交接数据播种（`support/blueprint-seed.ts`）                                       |

Builder 生成支路（F08 / A07 / issue #19）的边界：

- 唯一入口是已冻结的蓝图交接（`builder-service.ts`）。请求里没有 target id、没有向量
  id、没有 artifact key，因此 holdout 样本在结构上无法被这里点名（§7.1 / §7.3）；只有
  `builder` 这一种 actor 能调用，其余 actor 在读取任何东西之前就被拒绝并记一条 `deny`。
  worker 侧只有一个具名命令 `candidate.generate` 通向它（§14：命令表是边界，测试里另写
  一份名单，新增名字必须同时改两处），命令只把帧上的 actor 原样交给服务，不自带身份。
- 候选只是「这些字节、这个摘要」的声明，不是结论：`candidates` 表没有 result / verdict /
  passed 列，本模块既不写也不 import 验证服务，门禁 `M10` 会杀掉任何往
  `generatorJson` 里塞判定字段的做法。
- 预算与截止时间都是拒绝而不是静默降级：`maxAttemptsPerBlueprint` 在事务前的预读与事务内
  的重新计数各查一次（并发的那条由后者拦下），`deadlineAt` 过期直接 `RESOURCE_LIMIT`；
  三次生成用完两条后，第三条连一个字节都不会发布。
- 文档里只有评审过的契约说过的事：schema 对象逐字透传，不补 `additionalProperties:false`
  装严格；`/api/cart/42` 不做模板泛化；`x-rea-error-cases` / `x-rea-limitations` /
  `x-rea-unknowns` 一并带着，不丢。适配器按评审的 method 与 path 建路由表，base URL 走
  `context` 参数而不是模块级状态。
- 候选字节现在有一条**具名读取路径**（§8 lines 295-296）：`GET /projects/:p/candidates/:c`
  列出这个候选发布过哪些文件（id 来自受校验 manifest、path 仅显示、字节数与语言取自 artifact 行），
  `GET .../files/:f` 取一个文件的内容并**当场重算摘要**——哈希与 manifest 承诺的不一致就拒绝，
  而不是把换过的字节显示出去。选择器只有 manifest file id：`Id` 是带品牌的 opaque UUID，
  路径形状的字符串连构造都构造不出来，`storage_key` 也不在任何回包里（§5 要求它仅服务端可见）。
  超过内文联调限额（`CANDIDATE_BODY_LIMIT_BYTES`）的文件是**具名拒绝**并带上大小与限额，不做截断。
- **Builder 现在真的是独立进程**（§2「独立进程 / 文件视图 / 无网络」、§5 line 425）：worker 把
  一份冻结交接件写进 `<dataDir>/builder-role/<runId>/`，用 `planBuilderLaunch` **重建**的环境
  spawn `apps/worker/builder-child.ts`，等它退出，然后**核验**而不是信任它交回的东西——文件集合
  必须恰好是声明的那三个、每个都在字节预算内、`openApiDigest` 由父进程按自己的 canonicalization
  预算重算比对、operation 列表必须与发出去的交接件一致。任何一条不过都是具名拒绝
  （`builder-role-output-set` / `-file-too-large` / `-digest-mismatch` /
  `-operation-mismatch` / `-timeout` / `-exited`），且**运行目录一定被清掉**。
  子进程看到的环境只有 `HOME`(=它自己的 run 目录)、`PATH`(固定的系统对)、`LANG`、
  `NO_COLOR`、`NODE_DISABLE_COLORS`：宿主 HOME、`WB_*`、provider 入口、代理、`NODE_OPTIONS`
  都不在里面——这一条不是断言，是用真 spawn 让子进程自己报出来的。
  崩溃留下的 run 目录在下次启动、拿到排他锁之后、服务第一条命令之前被回收，
  且只认 workbench 自己的 run id 形状（§5 禁止按名字猜）。
- 页面**能自己发现候选了**，走的是 §8 早就写好的那条路：`GET /projects/:p/jobs`
  （line 277，含持久 `resultRef`「可恢复构建/验证资源 ID」）+ 「一次成功的生成，其 resultRef
  就是 candidate ID」（line 294）。本仓原先两条都没兑现——命令表里没有 jobs 分页，
  `candidate.generate` 也从不把 candidate id 写回 job 行——所以我此前那句「§8 没有列候选的路由」
  是错的，正确说法是**路由在文档里、实现缺着**（issue #55 已按这个结论重写并关闭）。
  现在：`packages/application/job-read.ts` 是分页与单条读的唯一所有者，`job.get` 与 `jobs.list`
  都走 `projectJobRecord` 这一个投影（§8 要求 GET job / GET jobs / job.updated 用同一组具名时间
  字段，之前 `job.get` 手搓的对象少了 `cleanupRetryAt` 和 `error`，而那个投影函数存在了很久
  却没有被任何一条命令用过），`builder-service.ts` 在同一个事务里写 resultRef、把 job 推到
  succeeded 并补一条 `job.updated` 事件；已经 failed/cancelled/interrupted 的 job **不接受结果**
  （§11：终态不复活）。UI 侧「代码」Tab 的入口因此是推导出来的：作业页 → 最近一次成功的
  `build` → 它的 resultRef → `GET /candidates/:c` → 选一个文件取正文。
- **未验证 / 未实现的部分**：生成的 `adapter.ts` 从未被执行，`openapi.json` 也没喂给任何
  第三方 OpenAPI 校验器（本机不装依赖）——两条都只由本仓的单测断言其内容与摘要，「SDK
  真的能调用成功」不属于已证事实。独立**进程**不等于独立**沙箱**：这里没有容器、没有 namespace、
  没有 seccomp，那属于 §11 的 broker（仍未实现），所以「无网络」目前是靠「不给它任何端点/凭据、
  也不给它 RPC socket 路径」实现的，不是靠内核强制执行。
  「代码」Tab 现在只**读**：浏览器里没有任何入口能发起一次生成——§8 line 294 说
  `POST /projects/:p/candidates` 收 `{blueprintId, deadlineAt?}` 并回 202 JobRecord，
  而本仓的 `candidate.generate` 仍要调用方自带 `jobId` + 预算 + generator 描述，直接回候选摘要。
  把这条改成文档那个形状，等于让 worker 自己挑一个 §7.3 没有给过数字的生成预算，
  所以我没动它（这一条偏离记在这里，不在 README 里假装已经一致）。

导出与 verified-samples（F11 / issue #22）的边界：

- `deliverability()` 只在 `packages/domain/report.ts` 里定义，`export-service.ts` 是它唯一的
  消费方；标签不是 UI 的措辞而是这道闸门的输出：`verified-samples` 要求 current PASS、报告
  已发布、且清理完成——清理同时看 job 与它留下的 lease，任一侧不是 `complete` 就拒绝（§11
  说 cleanup 是独立状态，`succeeded` 不能覆盖 pending）。
- 草稿必须自己说明为什么不是已验证：`statusNote` 为空即拒绝出厂（闸门全绿也照样记
  `labelled-draft` / `no-verification-record`），已验证包的 note 必须为空，否则标签与理由并存
  本身就是矛盾。
- 下载前重新核验：读到的字节必须仍哈希到 artifact 行记录的摘要，`verified-samples` 还要重跑
  闸门并把 manifest 里的绑定身份与当前行比对；被拒的下载单独写一条 `deny` 审计（§10 / §12.2）。
- ZIP 只有 `STORED`：条目名在写入与读出两侧都验（绝对路径、`..`、反斜杠、盘符、目录项、重名
  一律拒），容量先计量再分配；`MANIFEST.json` 是唯一不列进自身 `parts` 的条目，包的摘要由
  `artifacts.sha256` 单一持有。
- **§5 的 class 枚举多了一个 `export`**：`exports.artifact_id` 在既有 schema 里就 FK 指向
  `artifacts`，而一个交付包同时含候选源码与已发布报告，把它塞进四个生产者 class 中的任何一个
  都会破坏「按 project+class 隔离」这条权限边界。因此迁移 `0005-artifact-export-class` 走
  create-copy-drop-rename 重建 CHECK，运行器在这类迁移上把外键强制暂时关掉（pragma 在事务内
  无效），并在提交前跑 `PRAGMA foreign_key_check` —— 检查不干净就整笔回滚。这是对 §5 的偏离，
  留给文档裁决。
- **未验证 / 未做的部分**：交付链路在集成测试里是「播种」出来的（候选来自真的 BuilderService，
  报告行与 artifact 由测试按 schema 一致地写入），不是从抓包到 PASS 的端到端；HTTP 层三条导出
  路由只测了路由、会话、CSRF、严格体与拒绝映射，**201 与 ZIP 字节的 happy path 还没在 HTTP 上
  走过**；UI 也还没有导出入口。

发布门禁：对账、测量与备份回滚（A12 / A13 / issue #23）：

- `npm run docs:check` 直接读 `docs/TESTPLAN.md` 的 §3 与 `docs/PRD.md` 的验收表，缺号、重号、
  越界、指向不存在的 A 编号、以及任何一条 A 没有任何 T 覆盖，都是命令失败而不是提示。当前读数
  17 条用例 / 13 条验收，0 条不一致；`infra/release/docs-check.mjs` 不复制文档内容，两份文档仍是
  唯一来源。
- 迁移运行器新增 `deferForeignKeys`：只有声明了它的迁移才在事务外临时关掉外键强制（pragma 在事务
  内被 SQLite 忽略），并且每种迁移提交前都跑 `PRAGMA foreign_key_check`——检查不干净就整笔回滚、
  不写 `schema_migrations`。未声明的迁移若试图删掉还有子行的父表，仍会被拒。
- 备份是两半：SQLite 一致性快照 + 逐 artifact 的 manifest（class / sha256 / 字节数 / storage_key，
  摘要被扣住时带 reason）。备份前先按清单核对文件存在且大小一致；核验时重新打开快照、比对行与
  manifest、并把磁盘文件再哈希一遍。缺文件、改内容、manifest 多写一条没跑过的迁移，都是具体原因
  而不是「成功」。旧构建读到不认识的迁移 id 就拒开库（`MIGRATION_UNKNOWN`），`planRestore` 同样
  拒恢复。
- 三件事是一对，不是一条：`npm run db:backup` 产出 bundle、`npm run db:verify -- <快照路径>`
  在它需要被恢复之前先报出「哪些文件对不上」，`npm run db:restore` 才动数据目录。**三条都先拿
  worker 那把排他锁**（`worker-still-running-close-it-first`）：一边有人写文件、一边生成
  manifest，得到的是一份描述「从未存在过的瞬间」的备份。verify 的退出码看 `reasons` 是否为空，
  而不是看有没有找到文件——「找到了但有一堆说不清」不是通过。
- `npm run db:restore -- --from <data dir>/backups/workbench-<stamp>.db` 是操作者的恢复入口，
  顺序就是它的全部设计（§13 line 453 / D23）：**先拿 worker 自己的排他锁**（拿不到就停，这条
  入口不可能和在线 worker 同时写），再确认 schema（`planRestore` 与 `planMigrations` 都会拒不
  认识的迁移 id），再按 manifest 把磁盘文件**重新哈希**核对，然后才给现状留一份安全快照、把
  快照**复制**到临时文件再原子 rename 到位（直接 rename 快照会吃掉操作者唯一能复核「恢复了什
  么」的证据），最后用同一套增量、可重入迁移器把它带到本构建版本。任何一步不过都在写盘之前拒，
  并给具体原因：`worker-still-running-close-it-first`、`backup-pair-incomplete`、
  `backup-manifest-shape`、`snapshot-schema-newer-than-build`、
  `artifact-files-do-not-match-the-manifest`、`restored-schema-unplannable`。旧的 `-wal` /
  `-shm` 随被替换的库一起删——留着就等于让 SQLite 有机会重放刚被退役的状态。
- **T17 只是本地测量，不是 A13 达标**：`npm run perf:t17` 用固定 fixture（1000 条记录 → 200 可见
  节点 + 400 边）量 `buildMiddlePanel` + `listView`，暖态 ≥30 次、nearest-rank p95；本机
  10-16 那轮 p50 0.16 ms / p95 0.27 ms / max 0.48 ms（40 个样本）。但记录里
  `gateHostSatisfied=false`，并且写明三件没量：浏览器渲染（这里没有真浏览器 lane）、HAR 导入耗时
  （需要 REA provider）、采集/模型等待。A13 要求 Linux x64 + 真浏览器，本仓未在真宿主上跑过，
  CI 也只把这条记录当 advisory 上传。

ASAR 静态支路（F12 / D05 / issue #24）的边界值得单独说清：

- 它只投影 REA 已经解析好的应用图，节点、边、边界计数与 unknown 一律按上游
  `file:line` 镜像（`packages/contracts/rea-static-analysis.ts`），上游 id 与
  `inferred` / `unknown` 这类事实状态原样保留，工作台不重算、不升级。
- 携带 `sensitiveValues` 的 ASAR 导入返回 **422
  `SENSITIVE_PROJECTION_UNSUPPORTED`**：固定基线 `98d8470d` 的
  `analyze_javascript_application` 根本没有敏感值入参（该字段只存在于
  `inspect_web_network_capture`），拒绝才是正确行为，假装支持不是。拒绝会让事务整体
  回滚，随后在独立事务里写下一条 `deny` 审计（DESIGN §12.2）。
- 静态事实永不自动生成运行时契约：`static-analysis.ts` 不实现也不调用
  `EvidenceFactsPort`，不 import 向量 / 契约 / 计划 / 蓝图服务，除审计外不写任何
  业务行，也没有把静态边写成 `basis:"observed"` 的通路。
- **不承诺任何 Electron 运行时**：ASAR 是归档，不含启动一个 Electron 应用所需的
  平台条件；本支路只做离线静态分析，动态行为保留为未知。

SDK 差分验证（DESIGN §10 / PRD F09 A08 / issue #20）的判据也单独说清：

- `POST` 完成回执是 `evaluatorCompletionSchema`，字段只有观测；带一个 `result:"PASS"`
  进去会被 strict schema 以未识别键拒收，并且拒收会写下一条 `deny` 审计。
- 只有 `actorKind:"evaluator"` 能记录；Builder 在解析负载之前就被拒，所以拒绝不会
  泄露可接受的形状。
- 报告发布前先复核 evaluator 留在 staging 的字节摘要，再发布**本模块推导出的**报告正文，
  然后在一个事务里写 artifact、`verifications` 行、`verification.completed` 事件与 allow
  审计；事务内还会重读候选/蓝图/计划/库存，任何一项移动即回滚。
- 八项身份（snapshot/blueprint/candidate/vectorSet/plan/inventory/comparator/runnerImage）
  任一不符 ⇒ 报告只作为 `identity-changed:<字段>` 的失效证据呈现，正文与 digest 不被改写。
- `counts` 是冻结计划的分母，`inventoryCounts` 是整快照的分母；计划不再穷尽库存时
  （新样本落进同一快照）验证被拒绝，而不是借一个更小的分母继续跑。

`tools/list` 的对账是**双向**的（DESIGN §9 第 2 条 / issue #14）：期望的一边由严格镜像
自己投影出来（`contracts/rea-advertised-shapes.ts`），观察的一边是这条连接刚返回的广告
形状，两个方向都比 properties 集、required 集与 `additionalProperties:false`。以前
`identity.ts` 手抄的 `REQUIRED_TOOLS` 表已经落后于它要总结的镜像（把
`analyze_javascript_application` 记成"无必填"，而且根本没有 `detail`），这正是这条规则
要防的东西。

真实 provider 的读数（2026-10-16，`98d8470d` 构建，node 24.18.0）：handshake
`2025-06-18`，173 个工具，广告出的 envelope **16 个字段全部 required**、
`additionalProperties:false`，`confidence` 与 `authority` 的枚举与镜像逐字一致——
所以 `rea-evidence.ts` 里那条"故意比上游 producer default 更严"的偏差不再是偏差。
`tests/integration/rea-live-provider.test.ts` 在设了 `REA_LIVE_BIN` 时才跑真会话，
没设就整支显式跳过，绝不把"没跑"算成"跑过"。

本地会话与 API（DESIGN §8 §14 / D30 / issue #17）的边界：

- 会话与配对码只活在 worker 进程的内存里；HTTP 侧不留副本，`session.read` 每个已认证
  请求都问一次 worker，所以重启/过期/撤销在下一次请求就被感到。
- 配对码绝不进 URL、query、referrer 或访问日志：路由只读 body，访问日志记的是匹配到的
  路由模板而不是请求目标，`revoke` 之后再查一次同一个 cookie 就是 401。
- `Idempotency-Key` 同键同摘要回放原结果（连响应体都逐字相同），不同 body ⇒ 409
  `IDEMPOTENCY_CONFLICT`；digest 前先把投影交给唯一过滤器，含认证结构的 body 直接被拒，
  不存在"给它算个摘要"这条路。
- SSE 的 `Last-Event-ID` 与 `after` 不能互相矛盾；游标不可恢复 ⇒ 409
  `EVENT_CURSOR_EXPIRED`，客户端被要求重读快照而不是补一个假事件。
- 架构规则里 `apps/web` 的内建模块白名单被显式放宽到 `node:http`/`node:net`/`node:path`
  三个传输件（DESIGN §3 就是把这个模块列为 HTTP/SSE），仍然不含 SQLite、文件系统写、
  子进程与 zod；对账用例同时断言这四类越界依旧报红。


三栏 UI（PRD F04 / DESIGN §6 / issue #18）现在的真实状态：

- 中栏的 SEEN / INFERRED / UNKNOWN **不重算**，全部走 `packages/domain/evidence.ts` 这个唯一
  owner；边只看自己那条 claim，节点颜色不会外溢（用例与变异都钉了这条）。
- 每个状态同时给图标、文字与缺口列表，颜色只是加强；列表视图渲染的是同一批 cell，
  所以换视图不会把"未知"洗成"看起来没事"。
- 未知项生成的是**定向调查草稿**：reason 词表映射到唯一那一种可能改变它的下一步；
  词表里没有的 reason 会被如实标成 `reasons-unmapped`，不编一个步骤。
- 右栏"代码"Tab 对 Builder 永久禁用（`builder-may-not-read-source`），"报告"要有已冻结蓝图；
  中栏只带 Evidence **引用**，正文走各自的鉴权读取。
- 中栏读的是 `GET /api/v1/projects/:projectId/graph`（§8 封闭命令表里新增的具名命令
  `graph.read`）：回来的只有行里存的 basis / validity / coverage / sourceEvidenceIds，
  没有任何"颜色"或"状态"字段，三色判定仍然只有 `projectClaim` 一个 owner。
- 画布是真的 React Flow，并且被 `tests/unit/architecture.test.ts` 的 `clientOnly` 规则关在
  `"use client"` 岛屿里：`apps/web` 的服务器半边（路由、`main.ts`）一旦 import 它就报红，
  把作用域放宽到整模块、把禁令删掉、把岛屿真正 import 进路由半边，三种变异都会红。
- 列表行同时带图标、文字与 `status-positive|caution|negative` 颜色类，并且"来源 N"与
  "创建定向调查"两个按钮就在行上——跳转与发起不依赖画布存在。
- "代码"Tab 对复核者是**真读**的：它先读作业页、挑出最近一次成功的 `build`、拿它的
  resultRef 当 candidate id，再列文件、按 manifest file id 取正文（§8 lines 277/294-296）。
  没有候选、没有成功的构建、或 resultRef 不是个 id，三种空态各说各的话，不合并成"暂无数据"。
  Monaco 依赖仍然是删掉的而不是挂着不用：展示用的是 `<pre>`，编辑器不属于这一条读取路径。
- 左栏的"任务/清理"现在来自作业页的第一行（§8：GET job、GET jobs 与 job.updated 用同一组
  具名时间字段，**左栏不从日志推断重试时间**）；在此之前它写死 `job: null`，所以那一格永远空着。

§8 的两扇审计窗口（lines 302-303）已经接通：`GET /projects/:p/audit` 读**这个项目的决定**，
`GET /audit` 读**不属于任何项目的那些行**（启动、配对、撤销、未认证拒绝，§12.2 列的那批）。
这不是「一个查询少个过滤条件」：两扇是两条不同的 SELECT（`project_id = ?` 对 `project_id IS NULL`），
`packages/application/audit-read.ts` 也故意不提供一个「projectId 可选」的调用——少传一次过滤条件
就等价于把别的项目的决定读进这一页，而那种默认值两种语义都说得通，所以一种也不给。
游标是 §8 写明的整数 `seq`（日志只追加，所以游标要么指着一行、要么被拒，不会被重新解释）；
页宽越界是具名 413，不是悄悄少给。回包字段就是 §12.2 那份清单，`safeMetadata` 是消毒器出来
的原文**逐字带过**，读侧不重述也不删字段——一本操作者不能确信「就是当时记下的那条」的日志不是日志。

§8 的 HTTP 面（issue #58）现在的真实刻度：文档那张表 **40 条路由**，本仓挂了 **19 条**，仍缺 **21 条**。
缺的这 23 条里，`GET /projects/:p`、`GET .../jobs/:j`、`GET .../evidence/:e`、`GET .../vectors/:v`、
`GET .../verification-plans/:v` 这五条已经补上——它们的命令一直都在，只是没有 HTTP 的门。
其余多数是**写动作**（`POST /imports`、`POST /vectors*`、`/contracts*`、`/verification-plans*`、
`/blueprints`、`/jobs/:j/cancel`、`/jobs/:j/cleanup-retry`、`POST /jobs`、`POST /verifications`）：
命令侧有实现，页面上点不到，所以「审阅样本 → 批契约 → 批计划 → 冻蓝图」这条真正改变项目状态的链
仍然只能由测试或脚本走完。注意 `POST /imports` 也在缺的那一半里——**HAR 导入目前没有浏览器可达的入口**。

还有一条同一轮里钉住的现状（issue #59）：`fromWorker()` 把 worker 的拒绝转成 HTTP 回包时，
`details` 里**只出 `reason` 一个键**。所以「带 `{byteLength, limit}` 的 RESOURCE_LIMIT」这类说法只在
服务层为真，过 HTTP 这一跳操作者看到的是 code＋message＋reason。本轮没有改它（放行 `details` 需要
一个具名键白名单，不能默认全透传），但用一条用例把「只出 reason」钉成被审视过的事实，
而不是没人看过的偶然。

浏览器实测（2026-10-16，真 Chrome 1440×832；worker、`npm run web`、`next dev` 三个真进程）：

- 终端签出的配对码在页面里换到会话（`会话：paired`），图读出 3 节点 / 2 边；
- React Flow 画出 3 个节点与 2 条带 `yields` / `precedes` 标签的边；缩放控件把 viewport 从
  `scale(2)` 改到 `scale(1.66667)` 再回到 `scale(2)`（停在默认 maxZoom=2，不是失灵）；
- "来源 1"与"创建定向调查"各生成一条队列项，kind 分别是 `read-evidence` 与 `capture-new`；
- 右栏 Tab 切换会换 body：契约给 assertion＋修订＋basis/validity，报告给三种 coverage 计数，
  代码给具名空态；三栏几何为 left 280@x=16、middle 821@x=312、right 260@x=1149，画布在 middle 内；
- **仍未测**：鼠标拖拽平移（只按了控件）、键盘焦点顺序与读屏朗读、`next build` 产物路径
  （本次走的是 `next dev`），以及真 REA provider 导入之后的图。

浏览器实测·第三轮（2026-10-17 04:46–04:52，真 Chrome 1600×1200，三个真进程；这一轮补的是
「来源」跳转与 §8 的读路由）：

- 中栏「来源 1」现在**读的是正文**：`GET .../evidence/ev_111…` 回 200，页面渲染
  `application/json · 229 字节 · sha256 1d3195ba…e44`，正文是那 229 字节的 envelope。
  同一份文件在磁盘上 `shasum -a 256` = `1d3195ba…e44`、229 字节——两个读数各自独立取到。
- 点击「来源」不再往队列里塞草稿（队列计数 0），而带缺口的格子点「创建定向调查」仍然入队一条
  `capture-new`（`unmappedReasons: []`）——「读得到」与「还缺证据」在页面上是两件事。
- 三条新读路由在同一轮里由页面直接取过：`GET /projects/:p` 回 6 个键
  （`recentJobIds` 有 2 条）、`GET /projects/:p/jobs/:j` 回 9 个键（含 `cleanupRetryAt`、`error`），
  不存在的 evidence id 回 `evidence-unknown`。
- 变异 16 支全杀、0 存活；其中一条曾存活（evidence 段的形状检查删掉后行为与 worker 自己的拒绝
  分不开），把四条读路的畸形段从 `404 *-unknown` 改成 `400 *-id-malformed` 之后才可区分——
  「你打错了」和「没有这个东西」本来就不该是同一个读数。
- 这一轮**没测**的：翻页在真实数据上的表现（作业页仍只有 2 行）、拖拽与读屏、`next build` 产物。

浏览器实测·第四轮（2026-10-17 05:06，真 Chrome + 三个真进程；这一轮测的是两扇审计窗口，
本条没有新增 UI，所以「在页面里走一遍」走的是 Next 的中继而不是某个新按钮）：

- `GET /api/v1/audit` 回 200、2 条，**非 null 的 `projectId` 数量是 0**，action 集合是
  `{session.pair}`——即这一页里只有真的不属于项目的行。
- `GET /api/v1/projects/:p/audit` 回 200、1 条，`projectId` 去重后**就是这一个项目**；
  两扇的 seq 无交集（在测试里断，浏览器里也各读各的）。
- `?after=abc` 是 400 `audit-after-malformed`，`?limit=501` 是 413 `audit-limit`；
  同一个浏览器会话里 `?after=0` 是合法的「从开头读」，所以 400 不是把 0 当空值的误伤。
- `/api/v1/audit` 是 Next 那个 `[...path]` 中继下的**新的顶层一段**，这一轮证明它能被路由到、
  且不会被 `…/projects/:p/audit` 的后缀分支抢走（那条分支的顺序在实现里是显式写在后面的，
  调换两个分支的变异被打红）。
- 这一轮仍**没有**给审计做任何界面：三栏看不到日志本。那是一个单独的界面活，不在 §8 路由表里。

浏览器实测·第二轮（2026-10-17 04:23–04:26，真 Chrome 1600×1200，同一套三个真进程；这一轮
把上面那条"代码给具名空态"读数是**作废**的，因为作业页与 resultRef 从那之后才通）：

- 播种脚本用真的 `BuilderService.generate()` 造候选，不是手插行：作业行落下来是
  `state=succeeded`、`resultRef = 7eb7919a-82ec-47d4-90bb-e4727cc801da`（候选 id 本身）。
  顺带证到一条：脚本第一次用 `inspector` actor 调生成，被 `only-the-builder-generates` 拒绝。
- 左栏那一格真的填上了：任务 `41f63f01-6aeb-491f-a8d8-e9b4db6f6ff1`、清理 `pending`。
- 「代码」Tab 自己发现候选并列出三个文件：`adapter.ts（typescript，1036 字节）`、
  `openapi.json（json，1363 字节）`、`candidate-manifest.json（json，258 字节）`；
  点第一个之后正文渲染 1036 个字符，首行
  `// Generated from a frozen REA Workbench blueprint. Do not edit by hand.`，
  `data-code-sha256="dc3449a3e08b77e927e6f8e99e4e34c3bb1c9b2405455bd951613579836415c4"`。
- 那个摘要与磁盘上真正存着的那份字节**独立对上**：`shasum -a 256` 对
  `projects/6732…/artifacts/candidate/dc3449a3…15c4.bin` 得到同一个值、同一个 1036 字节。
- 请求链就是设计的那四条，全 200：`…/graph` → `…/jobs?limit=50` → `…/candidates/<id>` →
  `…/candidates/<id>/files/<id>`；控制台里唯一的错误是配对之前那两次 `/session` 401（预期）。
- **这一轮仍未测**：由浏览器发起一次生成（页面上没有那个入口，见上文 §8 line 294 那条偏离）、
  分页游标在真实数据上的翻页（作业页只有一页）、以及 `next build` 产物路径。

## 还没有的东西

`npm run worker`、`npm run web`、`npm run doctor` 与 `npm run ui:dev` 现在都存在：worker 装配
自己（解析 `WB_*`、拿写锁、跑迁移、开本机 RPC，并把配对码只打在终端）；`npm run web` 是
API 进程本体（DESIGN §14 给 web 的只有 `WB_HOST`/`WB_PORT`/`WB_DATA_DIR` 三个字段，它不碰文件
系统、不 mint 会话，每个请求都走 worker 的私有 RPC socket）；`ui:dev` 起 Next 页面外壳，浏览
器只跟同源页面说话，`/api/v1/**` 由 `apps/web/app/lib/relay.ts` 转发到本机 API。
`http://127.0.0.1:4310` 上是真的：`POST /api/v1/session` 换 HttpOnly SameSite=Strict cookie +
csrfToken + reviewerId，变更请求要 `X-CSRF-Token` 与精确 Host/Origin，SSE 按 worker 已提交的
seq 投递，事件流在转发层是**流过去**而不是缓冲（`tests/unit/web-proxy-route.test.ts` 用一个
只发一帧就不说话的流把这条钉住）。`db:migrate` 与 `dev` 仍未实现——迁移由 worker 启动时执行
（没有独立的迁移命令），`.env.example` 还在队列里；宿主 broker 的契约与控制面门禁已落地
（issue #21，见下），但 `apps/broker` 进程本体仍未实现。本机没有 Docker 时，隔离类门禁一律
不可声明为已通过。

明确**未实现 / 未验证**的范围：

- ASAR 的导入 ingestion job、目标行与 artifact 落库尚未由 worker 装配接线
  （`apps/worker` 现在只注册 HAR 导入闭环）；`static-analysis.ts` 只做准入闸门与
  已持久化 envelope 的只读投影。
- 只交付 `detail: "complete"` 的内联图。`detail: "summary"` 的 envelope 返回
  503 `CAPABILITY_UNAVAILABLE`，因为读回完整图需要 `inspect_analysis_view` 访问
  REA 的保留会话，本支路尚未接通。
- 本仓库的测试从未让 REA 真去解析过一个 `.asar` 文件：`tests/fixtures/asar-application-envelope.json`
  是照固定基线的具名契约手工构造的，用来钉住 schema 与投影语义，不代表上游真实
  解析结果已在真样本上验证过。
- `evidence_id` 的语义摘要仍由 REA 自己校验；工作台只做形状校验，这一条差异记录
  在 issue #14。
- 候选执行器容器与 evaluator 容器仍未实现，性能门禁 A13 未测量；`verification-service.ts`
  落的是**控制面这一侧**：它只接受 evaluator 提交的观测，`result`、`counts` 与八项绑定身份
  全部由 worker 从自己已有的行推导，因此候选自报 PASS、伪造报告、改写请求在 schema 里
  根本没有可写的字段（DESIGN §10）。分容器与文件视图隔离本身在本机不可验证。受控 Web 采集的契约
  与读回通路已在 `contracts/rea-web-capture.ts` + `adapters/rea/capture-inspection.ts`
  落地，但只在 fixture 上验证过，真 provider 会话仍归 issue #14。

沙箱链路（issue #21）实现到「契约 + 控制面门禁 + Linux 命令渲染」这一层：四命令白名单、
非 root / 只读根目录 / tmpfs / cap-drop ALL / no-new-privileges / seccomp / browser sandbox
与 default-deny egress 在本机的单元与集成测试里可证。但**这些隔离效果在本机（macOS）不可
验证**，具体是：

- 没有真实容器执行——`apps/broker`（唯一持有调度权限的进程）尚未实现，测试一律注入 fake
  transport；
- 没有 seccomp profile 的实际加载；
- 没有 network namespace 对 egress 的实际拦截（本机只验证了地址与 CIDR 的判定逻辑）。

因此沙箱**不得被宣传为已支持的平台能力**：支持面固定为 Linux x64，且在 T19 的隔离验收于真实
Linux 宿主通过之前，`GET /health` 的 profile 必须继续报告 `available: false`。隔离条件不满足
时代码只拒绝、不回退到 `--no-sandbox`；平台判定由注入的 probe 提供，策略里不读
`process.platform`（`tests/integration/sandbox-broker.test.ts` 有守卫用例）。


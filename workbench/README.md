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
- **被 SIGKILL 的 worker 不再需要人手删文件**（issue #72）：`worker.lock` 与 `worker.rpc.sock`
  都是优雅停才清理的东西，硬死会把它们留在数据目录里，而在此之前留下的东西**永远**挡路。
  现在的判据是「能不能证明那个持有者不存在」：锁里记的 pid 用一次不发信号的 `kill(pid, 0)` 探，
  `ESRCH` 才算死、`EPERM`（有这个过程但我动不了它）算活；**读不出 pid 的锁一律不接管**——
  按 §2 的说法，那正是第二个写者的形状。接管本身仍是 `O_EXCL` 重新创建，所以两个同时醒来的
  启动者里只有一个赢，另一个由文件系统而不是由猜测挡回去。socket 那半改成本来就该做的事：
  先**去连一次**，连上了才允许说「有别的监听者」（旧代码在什么都没听的时候报的就是这个理由），
  连不上才认定那是本 workbench 自己的残留并删掉；不是 socket 的路径一律不删，删不掉就具名
  `socket-stale-removal-failed` 而不是假装成功。
  两条已知代价写在名字里：pid 可能被回收给无关进程（那时判活、拒绝启动——保守的那一侧），
  以及**残留的 pid 与本次启动者是同一个进程**时也不接管（测试里那两个并发启动者就是这样）。
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
- **生成的候选现在真的被跑过了**（`tests/integration/candidate-generation.test.ts` 最后那个 describe）：
  测试取的是**读门交回的字节**（`candidate.file`，也就是「代码」Tab 显示的那同一份），写成临时 ESM 模块
  `import` 进来，再对一台 loopback HTTP 桩调用 `invoke(operationId, sdkInput, {baseUrl})`，断言桩**收到的**
  方法、路径、正文与 `content-type`，以及回包原样回到调用方。这一跑就当众逮到一个缺陷：发射器原先给
  每个方法都带上 `body`，于是**任何生成的 GET 在 `fetch` 里就死**
  （`Request with GET/HEAD method cannot have body`），一次请求都发不出去——在此之前它不存在，因为没人跑过。
  修法是 bodyless 的方法（GET/HEAD）不带正文，且**给了非空 `sdkInput` 就按名拒绝**，而不是静默丢掉一部分输入
  （静默丢比崩更坏：调用方会以为评审过的输入发出去了）。同时 `invoke` 的分派从「一张表 + 每条一个 `if` 分支」
  收成**只有表**：旧形状里 `request` 内部那个 `route === undefined` 守卫永远走不到（`invoke` 已经拒过），
  把一支变异改成静默返回 `{invented: true}` 全绿通过——一条到不了的守卫不是守卫。
  仍未证的两条留着：`openapi.json` 没喂给任何**第三方** OpenAPI 校验器（本机不装依赖），
  而一条**方法名小写**的变异在任何 fetch 客户端上都观察不到（Fetch 规范把 known methods 规范化回大写），
  所以它是等价变异而不是测试漏洞——这一条连同上面那条到不了的守卫，都照实写在提交说明与 PR 正文里，不写成全杀。
  独立**进程**不等于独立**沙箱**：这里没有容器、没有 namespace、
  没有 seccomp，那属于 §11 的 broker（仍未实现），所以「无网络」目前是靠「不给它任何端点/凭据、
  也不给它 RPC socket 路径」实现的，不是靠内核强制执行。
  （这一段此前写的是「代码 Tab 只能读、页面上没有发起生成的入口」——那在 #57/#87 之后已经不成立：
  页面上有「发起生成」那一节，§8 line 294 的形状是门自己造的，预算来自 profile 的
  `maxGenerationAttempts`（§10 的显式预算，见第九轮读数）。留这段是为了记一次自我纠正的形状：
  README 也会过期，改代码时要顺手回读这些"仍未"的句子。）

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
- **导出包现在被"陌生读者"读过**（§10 / F11 说它是这台工作台唯一会以字节形式离开、被别人的程序打开的东西）。
  自家 `readZipArchive` 之外新增一条用例，用**独立**的中央目录走查去读标志位，因而逮到一个只有外人看得见的缺陷：
  `encodeName` 一直写的是 UTF-8 字节，但通用标志位第 11 位（APPNOTE 4.4.5「名字是 UTF-8」的**唯一**声明处）从没置过，
  于是任何按规范读的程序都把非 ASCII 条目名当 CP437 解——Python 的 `zipfile` 实测把 `报告/验证结果.txt` 显示成
  `Σ╕¡µûçσÉìσ¡ù.txt` 且按原名取不到内容，而本仓自己的读者两边都对（"只有自家读者认识"就是缺陷本身）。
  现在非 ASCII 名字置位、ASCII 名字保持不置，两边一致（本地头与中央目录的标志位与 CRC 必须相同，用例也钉这条）。
  同一条路上还有一处会静默烂掉：条目名长度是 16 位字段，超过 65535 字节的名字不会报错、只会把头里的长度写成
  `length mod 65536`，读者于是走进条目自己的字节里；`entryNameDefects` 加了对具名拒绝，边界值本身仍可写入并读回。
  第三方读法的手动读数与限制（Apple 自带 Info-ZIP 6.00 的列表在非 ASCII 名字上两种版本都打乱码，它不认 `-O`，
  所以判据取 `zipfile` 那一处，不把它的显示当尺子）写在提交正文里。
- 包里的 ZIP 时间戳是**被冻结事实的 instant**（蓝图的 `createdAt`），不是操作者按按钮的那一刻。
  一个包是「冻结事实的副本」，所以同一批事实两次导出必须哈希相同、共用一条 artifact 行（§5 的
  class 内去重）。原先写 `nowInstant()`，等于让这条去重去和时钟赛跑：DOS 时间字段是 2 秒粒度，
  跨过边界就把同样的字节再存一份——`tests/integration/export-service.test.ts` 里那条「两次导出
  只有一个包」的用例因此在真实机器上偶发发红（10-17 抓到）。现在那条用例中间隔 2.1 秒仍然成立，
  并且另有一条把包头 4 个时间字节**解码回来**与蓝图 instant 比对的断言，所以「一个常量」和
  「一个事实」两种写法也分得开。导出记录自己的时刻仍在 `exports.created_at`，包内报告可以晚于这个戳。
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
- **T17 的闸门原来会在没量过浏览器的跑次上报「A13 达标」**：`npm run perf:t17` 用固定 fixture
  （1000 条记录 → 200 可见节点 + 400 边）量 `buildMiddlePanel` + `listView`，暖态 ≥30 次、nearest-rank
  p95；本机 10-17 那轮 p50 0.19 ms / p95 0.37 ms / max 0.66 ms（40 个样本），`gateHostSatisfied=false`
  因为宿主是 darwin/arm64。**但 CI 那份记录不是**：`gh run download 39054251044 -n t17-record` 取回的
  文件写着 `hostIsLinuxX64:true`、`browserLane:false`、`unmeasured` 三条里第一条就是"浏览器渲染没量"，
  而 `gateHostSatisfied` 仍是 `true`——谓词读了它正在写的四个字段里的三个。A13 的句子是「从 worker
  原子提交到浏览器图/列表完成更新」，终点在浏览器，所以一个只量到视图模型的跑次永远不该算达标。
  现在记录多了一个 `lane` 块（`{driven:false}`，或被驱动时的每次测量 + p50/p95/max/cold + 浏览器版本
  + 它到底量的是哪份 fixture），谓词把 lane 的暖态样本数、lane 自己的 p95、以及 fixture 摘要必须与
  本次计数的那份一致都算进去；`ci.yml` 那条注释原本写"闸门在 lane 存在之前会报 false"，按制品读数是
  反的，一并改掉，并加了一步把这台 Linux 宿主的浏览器与 CPU 事实打印出来（lane 运行器要按实测的二进制
  名写，不猜）。**这一笔只把闸门改对，没有把 A13 变成达标**：真浏览器 lane 还不存在，因此 CI 上现在
  如实报 `gateHostSatisfied=false`，A13 与 #23 都仍未勾选。

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
  词表里没有的 reason 会被如实标成 `reasons-unmapped`，不编一个步骤。草稿本身仍只是记录
  （点格子不等于发请求），但其中 `inspect-runtime` 那一类现在**真能发出去**：页面下方的
  「定向调查」把手把它交给 §8 line 275 那道门，第十三轮读到的回执是 `202 JobRecord`。
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

§8 的库存分页（line 283）接通了：`GET /projects/:p/vectors` 收 `targetId`＋可选 `cursor`＋
可选 `limit`，回 `{inventoryRevision, items, nextCursor}`。三件事是这个路由的合同而不是优化：
报出**切这一页时的库存版本**，游标pin 了版本而库存又动了就是 **409**（不是把两个库存混进同一页）；
切在行自己的 `id` 上，所以翻页中途来了新捕获既不跳行也不重行；回的是那六个摘要字段、
**不带正文**——列表本身是披露面，正文只能走那条具名的单向量读。holdout 行**在查询里**就被排除
而不是读完再删：读完再删会让页比游标短、下一个游标指向一行调用者从没见过的行。
游标编解码抽成 `packages/application/page-cursor.ts` 一份（作业页与库存页共用；base64url 解码
是宽容的，所以唯一证明是「能原样回编」）。

§8 的 HTTP 面（issue #58）现在的真实刻度：文档那张表 **40 条路由**，本仓挂了 **39 条**，仍缺 **1 条**——
`GET /projects/:p/jobs/:j/preview`（304，卡的是「像素图由隔离 origin 提供」那半边：本 build 里**没有任何东西持有预览帧**
（`imageUrl`/`actionState` 全仓零命中，`buildLeftPanel` 的 `frameLabels` 没有生产者，
`artifacts` 的 class 名录里也没有 frame/preview），所以那道门今天能如实答的只有「没有画面」）。
**多出来的路由有 2 条**是文档表没有的：`GET /projects/:p/exports`（#22 交付时补的读门）与
`GET /comparator-policies`（issue #82：§8 line 297 的写门只收**已安装**的具名比较器，而全仓没有任何一条门
列得出那几个名字——于是"这个名字对不对"只能靠发一次会被拒的请求来问，而一次拒绝会写进审计日志）。
这条读门答的就是 `findComparatorPolicy` 查的那一份常量（不是第二份清单），并且**不带 default、不带
recommended、不重排序**：两条里 alphabetically 排第一的恰好是松的那档，而 §10 禁的正是把松的一档当默认。
页面上原来那个手打的输入框因此换成从这份清单里选（首项是"还没有选"，页面不预选任何一档）。

**query 面也按同一把尺子量了（issue #63）**。上面那段说的是"路由有没有挂"，这一节管的是"挂上的那条
收哪些参数"：路由表旁边多了一张 `ROUTE_QUERY`，逐条列出 §8 那一行点名的 query 名字，**表里没有的名字一律
具名拒绝**（`vectors-query-unknown` / `jobs-query-unknown` / `audit-query-unknown` / `graph-query-unknown` /
`events-query-unknown` / 其余路由 `query-not-accepted`），拒绝在会话与 CSRF 门**之后**、任何读动作之前。
这补的是一个此前没人抓的失败形状：`?visibility=holdout` 会被静静丢掉然后回一整页——那和 §14 已经禁止的
`limit=1.5` 被读成 1 是同一件事（**没被看的条件长得像被满足了的条件**）。细节只发名字与计数，
query 的**值**不回显（用例里用 `holdout-SECRET-VALUE` 钉着）。

同一把尺子立刻量出两处反向偏差，都记在这里而不是抹平：图读那一行 §8 只写 `afterRevision?:integer`，
而**这个 build 没有按修订读图的能力**（`graph.read` 的请求只有 `targetId?`），所以现在 `?afterRevision=3`
是被具名拒掉的——它不给一张"看起来过滤过了"的整图；反过来代码**多收一个 §8 没点的 `targetId`**，
因为 worker 自己的 `graphReadRequestSchema` 实现了它、回包也会说它选了哪个目标。
这两条都是文档侧要裁决的事（要么给 `afterRevision` 补上语义，要么把它从那一行拿掉；要么把 `targetId`
写进那一行），我按"代码已有的行为 + 文档点名的槽位不假装实现"处理，**没动 docs**。

还有一处要按同一标准纠正我自己：#63 的正文写着「PRD F06 要四个样本过滤维度（操作/覆盖状态/时间/库存版本）」——
**三份文档里搜不到"筛选"二字，F06 那一行也只是一个 P0 特性标题**（从持久 Evidence 创建/读取/审阅 vectors…）。
那四个维度是我从 `contracts/vectors.ts` 里那份 `vectorListQuerySchema` 反推出来的，而那份 schema 恰好
**零调用方**——把死代码当需求读，得出的"文档有洞"自然是幻觉。这是本仓第四次犯"没读全就宣称文档有洞"
（前三次：#19 的 §3 名录、#55 的 §8 路由、#58 的主张清单），已在本条 issue 的评论里公开改正。
`vectorListQuerySchema` 与它的类型一起删了（不留无人调用的契约），`vectorPageQuerySchema` 保留——
它是 worker 侧 `vector.list` 真在用的那个（composition 里 `safeParse`）。
这一轮补的是最后一条**挂得上**的 `POST /projects/:p/jobs`（275）。它缺的从来不是路由形状而是**判定者**，
所以门里每一条规则都指着一个已有的人：体的 `task` 是 `contracts/tasks.ts` 那份具名联合（本仓此前只有
契约测试读它，没有第二个调用者）；`expectedGraphRevision` 在这里是**必填并真的比对**——§8 表下那句
「依赖图版本的写入必须带 expectedGraphRevision」在 contract/plan 那两扇是"没有存储者所以具名拒收"，
在这一扇是有主之物（`projects.graph_revision`），对不上就 409 并报出两个数；`profileId` 走
worker 的 profile 名录问一句（§14：预算只从装好的 profile 来，名字不在就 503，不编数字），
`queueWaitMs` 因此是那一格的等待预算而不是门自己定的；capture 的 `startUrl` 与目标的 host 不同就 403
（§8：不能任意换目标；两侧主机名都不回显，§12.1 报名字不报值），而 §8 留的"profile 明确允许的 fixture
origin"那一半**没有判定者**——`profileSchema` 只有 `networkPolicyId`，没有 origin 名录，所以这里不写
一份假的 allowlist 去查；inspect 的空 `claimIds` 只在"该目标还没有主张"时合法（用
`listClaimsForTarget` 现读），非空则每一 id 都要 `getClaim` 查得到。
`sensitiveValues` 是这扇唯一的**双层**规则：帧里带着它走（执行者要用，与 272 的导入同一待遇），
但落库的 `input_json` 与两处 digest（journal 的与行的）都不含它——落库那份由 `taskForStorage`
逐字段重建而不是 copy+delete，因为"不能被写下的字段不在被写下的东西里"这句话只有重建才成立。
这道门也新添一格 doctor：`target-work-executor`——runner 仍只认 `build`，所以现在能排出来的
capture/inspect 行没有执行者；队列里没有这两类时它 `ok`（facts 是那两个计数），有就 degraded 报
`target-work-executor-not-installed`，形状与 #75 那格一致。
另外记一处**测试 rig 自己的陈旧**：`tests/integration/web-api.test.ts` 写的 profile 文件用的是
`image`/`network`/`hostMounts`/`wallClockMs` 那套词汇，`profileSchema` 从来没这些键——也就是说那份 profile
**一直解析失败**，registry 回的是"没有这个 profile"。此前没有一条测试问我要过 profile 里的数字（每个需要
数字的门都在更早的门被拒），所以这个洞不出声；这道门要 `queueWaitMs`，于是把 rig 的 profile 改成契约
真正的形状（`har-capture` + 八项 limits）。同一轮把 `JOB_RECORD_FIELDS` 收成一份具名常量：三扇门
（275/294/297）此前各抄一遍 §8 JobRecord 的九个字段名，抄三份就是三处会各自漂的清单。
这一轮补上的是 `POST /projects/:p/candidates`（294）——它缺的既不是命令也不是 schema，而是**执行者**：
以前 `queued` 只是「有人想过」，本仓没有任何东西把队列里的作业跑起来，所以生成只能由脚本同步触发。
这一轮补的是 `POST /projects/:p/imports`（272），它缺的不是命令而是**transport**：
`HttpRequest.body` 一直是 `chunk.toString("utf8")` 拼出来的文本，而一个文件部分是任意字节——
不是合法 UTF-8 的序列在到达门口之前就已经变成替换字符了。现在请求带着
`bodyBytes: Uint8Array<ArrayBuffer>` 进来，文本只是它的一个视图，JSON 门照旧读 `body`。
配额也跟着分成两个（§12「分别预留容量」）：JSON 仍是 64 KiB，multipart 整个体 6 MiB，
而 `file` 部分 **5 MiB 是由 RPC 帧的 8 MiB 反推的**（base64 是 4·⌈n/3⌉，再留给信封一点余地）；
超过它就是具名 413 并报出 `byteLength` 与 `maxBytes` 两个数，而不是让帧上限以传输错误的形式冒出来。
再大的上传要的是分块/staging 交接，本 build 没有，已单开 **issue #77**（四个点等裁决：
命令形状、谁在何时计量、断开后的部分 staging 归谁清、或者干脆把 profile 的 `maxUploadBytes`
降到这条路兑现得了的值）。
这个刻度是现算的：把 §8 表里每行的 `METHOD 路径` 抽出来，与 `api.ts` 路由表的
`method + template` 逐字比（`:p/:v/:j/...` 按上一段名词展开成路由里的那个参数名），
另外还多出 **1 条**路由是文档表里没有的——`GET /projects/:p/exports`（交付清单），
它是 #22 交付时补的读门，记在偏离里。
这 38 条里最近补上的是 `POST .../candidates`（294）与**worker 自己的作业执行者**（`packages/application/job-runner.ts`）：
门只写一行 `queued` 的 build 作业并回 202 JobRecord，跑它是进程内那条循环的事——扫队列（只看 `queued`、只认
`build` 这一类，`verify`/`inspect` 仍然**没有执行者**，那是 #75 与 ASAR 那两条具名空缺，不做假装跑得起来的样子）、
按 §11 的 `decideStart` 判过期、声明 running、跑完再落 succeeded/failed 并把 candidate id 写进 `resultRef`。
claim 与 settle 各是一个事务，中间的生成在 SQLite 之外发生（把 `BEGIN IMMEDIATE` 横跨一个 Builder 子进程，
就是写锁和 RPC 帧超时在抢同一分钟）。§7.3「只有 Builder 能生成」这条因此落在**worker 自己铸的角色身份**上
（`{actorId:"worker-job-runner", actorKind:"builder"}`，不在任何请求体里、不在任何回包字段里），
而 `candidate.generate` 那个命令名被取消了：它是这条命令表里唯一一处「客户端造作业 id、服务端照单执行」的地方。
预算的来源也随之唯一：`profile.limits.maxGenerationAttempts` 是**必填**字段，
§14 的「资源初值随 profile 锁定」在这里是可测的——一个没写这个数的 profile 直接 unavailable
（`profile-schema:limits.maxGenerationAttempts`），没装对应 profile 文件的 worker 在门口就 503
`generation-budget-unknown`，代码里一个数字都不填；`FALLBACK_PROFILE` 里那个 `1` 是七个既有占位数之外的
第八个同类占位，它只出现在 `available:false` 的条目上，而执行者读的键是 profile 自己的 id，够不到它。
其余最近补上的是三个创建门（`POST .../vectors`、`.../contracts`、`.../verification-plans`，
§8 的 282／286／289 行）与四个改变状态的动作门（三条 review ＋ `POST .../blueprints`，285／287／291／292 行）——
命令一直都在，缺的只是门，所以「**造样本 → 写契约 → 批契约 → 造计划 → 批计划 → 冻蓝图 → 生成**」这条整链
现在能由一个配对会话里的 HTTP 请求走完（浏览器实测见下；「生成」那一步的**页面按钮**还没有，见下文「还没有的东西」）。
每个记录类型只有**一份投影**
（`COMMIT_PROJECTIONS`）：创建门与审阅门回答的是同一行的同一件事，写成两份就是两份会各自漂的清单；
创建门回 201、审阅门回 200，这是 §8 那一列自己定的。冻结是 §8 line 261 点名的创建动作，所以它带 `Idempotency-Key`。
顺带把一条**没人读的声明**变成了规则：路由表上的 `requiresIdempotencyKey` 此前无任何消费者，
每个创建自己复述一遍检查（而且两处不一致——一处校验键的形状、一处只看有没有）；现在流水线统一
按声明校验形状（§8 的 200 字符上限），门不再各写一份。审阅门有三处与文档不一致，都是本轮裁决并写进代码的，等 #58 上由你确认：
①**审阅者是会话，不是请求体**——三个服务都把 reviewerId 存进冻结蓝图要引用的那条持久记录里，
照 §8 原样把体里的名字转发出去就等于让任一会话替别人签批，所以体的 schema 里没有这个键，
发它就来 400 并报出键名；②§8 写的 `note:string` 在存储模型与 §12.2 的日志字段表里都没有归属，
所以门拒绝它而不是收下后丢掉（页面不能以为自己记下了一个没人保存的理由）；③§8 的三条回包写的是
「200 TestVector／ContractRevision／VerificationPlan」，而当时封闭命令表里 `contract.*` 还没有读命令，
门只能出服务真正回答的那份回执（receipt），它是一份具名契约而不是命令返回值的转储。
`GET /contracts/:c` 与 `GET /verifications/:v` 是本轮补上的——两侧服务的 `read` 一直都在，
连「Builder 只读蓝图投影」那条拒绝都写好了，缺的只是封闭命令表上的两个名字和一扇门。
`GET /blueprints/:b` 是同一批里的第三条：`blueprint.handoff` 早就把那份 bundle 交给 Builder 了，
这一轮把它抬成控制面也能读的一扇门（`blueprint.read`），并只按 §8 那一列多给一个 `verificationPlanId`——
**而 Builder 拿不到它**（计划是 holdout 的另一半）。回包 schema 里根本没有能装 source manifest
或 holdout 清单的字段，这是那句「所有角色均不经此接口读取」的可检查版本。
`POST /projects/:p/verifications`（§8 line 297）是这一面第五扇**写**门，也是第一条回 **202** 的创建门：
它造的是一个还没跑的作业，不是一份报告。命令名 `verification.request`，请求体就是
`verificationRequestSchema` 自己（§8 那三个字段早就写好了，门不再抄一份会漂的副本），而这份 schema
里**没有能装比较策略代码的字段**——「不接受代码」于是是可检查的：这道门能发出去的东西只剩一个名字。
名字还得是 `INSTALLED_COMPARATOR_POLICIES` 里有的，否则 **400 `comparator-policy-not-installed`**，
`details.declaredCount` 是本 build 真的装了几个（浏览器读数 2）。候选不在本项目 → **404
`candidate-unknown`**，而角色闸门在查行之前：Builder / evaluator 拿一个不存在的候选来问，得到的也是
`role-may-not-request-verification`，这道门不能用来试探某个 id 是否存在。
`request_digest` 是对 `{candidateId, comparatorPolicyId, deadlineAt}` 的 canonicalJson 求摘要，不是占位值：
同一个幂等键换候选就是 **409 `idempotency-key-reused`**，两次不同候选落在不同摘要上。
作业落成为 `state=queued`、`cleanup_state=pending`、`target_id=null`、`result_ref=null`，
`verifications` 表一行都不许多（§10：报告是可信 evaluator 的产物）。
两层幂等各管一件事：HTTP 日志替同键重发答「那次决定」（命令只跑一次，日志里只有一条 allow），
worker 的 `UNIQUE (project_id, idempotency_key)` 替换键重发兜底。**这条分工是被变异逼出来的**：
把路由的 `requiresIdempotencyKey` 关掉（P12），整套测试仍然全绿——worker 边界把同一句拒绝补上了，
两个 owner 报同一个 `code`＋`reason`，只有措辞不同；补上「无键那次 400 必须由 HTTP 流水线先说」
这条断言才把两者分开。反过来 worker 侧那道键检查（P15/P16）不是装饰：没有它，空键会带着
`NOT_FOUND` 之外的答案走到存储、超长键会安静地写进一个 §14 说 200 字符上限的列里。
一处**故意没有加**的闸门：deadline 过期不在这里拒——§11 的作业状态机是唯一持有者
（`tests/unit/job-queue.test.ts:91` 已经证过 `deadline-expired`），再写一道就是第二份会漂移的裁决。
`POST /projects/:p/imports`（line 272）是这一面第一扇**收字节**的门，回 **202 `{targetId, job}`**。
它的规矩一条条都能指回文档：字段名录就是 §8 那一格列的四件（`file`／`kind`／`deadlineAt`／
`sensitiveValues`），第五个名字**报键名拒收**——worker 自己的命令其实支持 `recordOrdinals` 选段，
文档这行没写，所以门不替文档加料（这条偏离记在下面那串「文档给了字段而实现无处安放」旁边）；
`kind:'asar'` 有两种答案，按 §8 自己区分的顺序来：带 `sensitiveValues` 时 **422
`SENSITIVE_PROJECTION_UNSUPPORTED`**（那是调用方能改的东西），不带时 **503 `import-asar-not-wired`**
（本 build 只接了 HAR 闭环）；媒体类型只收 `CAPTURE_MEDIA_TYPES` 三个，越界回 422 并把允许表给出来。
文件名是**显示文本**：它进 `targets.original_locator` 前过一遍 basename，落盘路径是内容地址
`projects/<p>/artifacts/inspector/<sha256>.bin`，浏览器递 `../../../../etc/passwd` 也换不来一个路径。
回执的形状这轮改了一次：`harImportReceiptSchema` 原来同时写着 `jobId`＋`jobState`，而 §8 要的是
`job: JobRecord`——**同一件事的两个名字**，所以删掉前者，两处分支（新建与幂等重放）都改成
`projectJobRecord(那一行, 该行自己的 lease)` 现读，于是重放答的就是行现在的样子。
这一轮被自己的测试纠正的一条**真缺陷**：`sensitiveValues` 原本是在门口最后一步才并进过滤声明的，
于是它前面那些拒绝照旧用「没并进去」的声明去过滤——浏览器实测里，一个声明了 `image/png` 为敏感值的
调用方，在它自己那次的 422 回包中被**原样复读**了这个字符串。把声明的读取提到所有拒绝之前之后，
同一处答的是 `"mediaType":""`（被过滤器抹掉），§12.1 那句「每一条消息、细节与日志行都按声明过滤」
这才不是注释。变异批次里这条是 A11（把提前的声明改回空的）→ 用例红。
**一支活下来的变异**要说清楚：A17 把 `sensitiveValues` 不再交给 worker，88 条测试仍全绿——因为
HTTP 侧的幂等摘要守卫先把同一件事挡在了命令之前，两个 owner 在这条路径上重叠，今天从这道门
看不出 worker 那份过滤器有没有被喂到值。留着它是因为「声明不能变成持久列」的持有者是 §5 说的摄取服务，
不是门；但**它在本轮不可证**，别按「已验证 worker 侧也收到了声明」读。
三个创建门各有一处 §8 偏离，都是「文档给了字段而实现无处安放」：vector 的 `sensitiveValues`、
plan／contract 的 `expectedGraphRevision`（§7.4 让计划自己绑图版本）都由门**具名拒收**，
而 contract 不在 §8 line 261 的幂等清单里，所以那扇门没有键——浏览器实测同键重发拿到的是
revision 2 新行（`review=draft`），与 §8 line 286 的描述一致，也记在 #58 等你确认。
真浏览器读数（一个配对会话、页面自己的中继，2026-10-16）：审计日志按 seq 排出
`vector.create#2 → contract.create#3 → vector.review#4 → contract.review#8 → plan.build#11 →
plan.review#12 → blueprint.freeze#13`；计划那次 `exclusions` 交了一条越界样本，回执就是
`selectedCount 1 / excludedCount 1`；冻结 201 的 `auditSeq` 正是 13。契约审阅第一次是
**422 `schema-inputSchema-dialect-not-2020-12`**——门禁要求 JSON Schema 2020-12 方言，
这不是门的错，是门的证明。

冻结的回包同样是一张**具名回执**（blueprintId／两份摘要／planId／三个计数／auditSeq），因为 §8 那一行还
写了 `planDigest`、`scope`、`limitations`——它们在蓝图 artifact 的正文里，读回来要等 `GET /blueprints/:b`
那条命令；调用体里 §8 列的 `targetId`、`contractRevisionIds`、`expectedGraphRevision` 一律**拒收**并报出
键名，因为 §7.4 把这三样定义为「已批准计划的函数」，让调用方重述就等于让它替服务决定（并发令牌也换成
服务自己存的计划 revision）。真浏览器读数（同一会话）：未批准时冻结 **422 `BLUEPRINT_BLOCKED`**，
`details = {reason: "plan-not-approved", reasonCount: 1}`（理由列表本身不过界，issue #59）；依次批准
样本／契约／计划后冻结 **201** `publicVectorCount 1 · holdoutVectorCount 0 · contractCount 1 · auditSeq 7`，
同键重发得到**逐字段相同**的回执与**新的** `x-request-id`，审计日志里 `blueprint.freeze` 的 allow 只有
**一条**；200 字符的键正常受理，201 字符 **400 `idempotency-key-required`**。
注意 `POST /imports` 已经在那一半被补上了（本轮）——**HAR 导入现在有浏览器可达的入口了**，
但只有一次采集真从这道门进来过：路径、限额与拒绝形状是实测的，`file` 部分的上限是 5 MiB（#77）。

拒绝回包里的数字现在能到操作者（issue #59 已闭合）。做法是一份**具名键白名单**
（`packages/contracts/errors.ts` 的 `SAFE_DETAIL_KEYS`，21 个键：字节数、上限、代数、修订号两侧、
seq、`reasonCount`、`retryable`），两条边界各套同一份表：worker 在 `errorFrame()` 出进程前过滤，
web 侧 `worker-client.ts` 收到帧后按同一张表再过一遍。只按类型筛不够——`portCode: 4821` 是个数字，
而它的值本身就是配对码，所以名单与类型是两个条件（§12.1）。`details` 因此进了 RPC 契约
（`rpcFailureSchema` 里 required，缺它即 `reply-shape-rejected`），`fromWorker()` 出
`{reason, ...数字}` 而不再第三次复制这条规则；进程内自己造的拒绝（幂等摘要失败）改走 `refused()`，
键在调用点写死。新增的架构闸把「白名单里有没人发的键」变成红的：它按名字扫 `gateFail`/`fail` 的
details 字面量（含 `{ pinnedRevision }` 这种简写成员），21 个键每个都有真拒绝在发它；顺带这一扫
查出 `verification-service` 里两处把错误码起名成 `portCode` 的键（已改 `sourceCode`）。
实测：`GET .../evidence/:e` 读超大正文时页面拿到 `limit=1048576`、`byteLength=1048577`；
变异 21 支全杀（worker 不过滤／客户端只筛类型／契约把 details 变可选或删掉／中继丢数字或丢 reason／
名单删判定条件／加一个没人发的键／扫描器停用某个名字），另有 3 支按定义杀不掉：从名单里删掉一个
真键（白名单内容本身是评审决定）、删掉一条冗余夹具断言、把断言换成恒真式——最后一类是变异测试的
结构极限，只能靠看 diff。

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
- 右栏「样本」页签＝库存，它是**页面第一次真写一次决定**（10-17 第二次真浏览器复跑，读数如下）：
  播种后两行 draft、`data-inventory-revision="2"`；点第一行拿到
  `已批准该样本｜库存修订 3｜日志 seq 2`，该行按钮消失并换成「已决定，正文不可改」，另一行照旧有按钮；
  紧接着点第二行拿到 `库存修订 4｜日志 seq 3`——第二下能成，靠的是列表在决定后按 §8 line 283 重读到的
  新 `inventoryRevision`（写死旧值会 409）。两行 id 与作业日志独立对过一次：
  `GET .../audit?limit=20` 回 `seq 2 / seq 3`，两条 `vector.review`，`actorKind=reviewer`，
  `resourceId` 正是页面上那两行的 id。刷新整页后读数＝修订 4、两行 approved、按钮 0 个（决定存在库里，不是内存里）。
  Builder 角色下这个页签是禁用的，理由原文 `builder-may-not-decide-samples`（§7.3 的边界用同一个名字，不加 paraphrase）。
  这一页签最初渲染出的是**零行的空列表**：客户端按 `vectorId`/`reviewStatus` 读库存行，
  而 §8 line 283 的摘要叫 `id` 且评审状态在 `review.status` 里——用例全绿、页面却是空的，
  只有真浏览器看得见。现在那层映射是 `sampleRowsOf()`，回包解析（relay 的 `{data:…}` 信封＋
  `inventoryRevision`）收成 `samplesPageOf()`／`relayData()` 一份，拒绝行收成 `samplesRefusalLine()`，
  首读与决定后的重读走同一条路（两条路各写一遍就会漂，而漂的那半正是上面那个 409）。
- 同一个页签在**没有会话**时曾经一直显示「正在读取库存…」：worker 停掉之后 `GET /session` 直接 401，
  `load()` 在会话那一步就返回了，库存那格从没被赋过状态——页面在假装还在读，而顶栏已经写着「会话：unpaired」。
  现在它读 `SAMPLES_EMPTY_LINE["no-session"]`（第三种具名空态：没有会话／没有目标／该目标没有样本，
  三条两两不同且有各自的关键词用例）。worker 重新起来、换新配对码配上之后同一格回到
  「修订 4／两行 approved／0 个按钮」，证明这条线不是粘住的。
- 点击「来源」不再往队列里塞草稿（队列计数 0），而带缺口的格子点「创建定向调查」仍然入队一条
  `capture-new`（`unmappedReasons: []`）——「读得到」与「还缺证据」在页面上是两件事。
- 第三条读门（`GET .../blueprints/:b`）这轮是**在页面里把整条链走完之后读到的**：同一个配对会话里
  建计划 201 → 读计划 200（`review.status=draft`）→ 故意少交 `expectedInventoryRevision` 的审阅 **400**
  → 补齐后审阅 200 → 冻结 **201**（`blueprintId b9202368…`、`auditSeq 12`）→ 读蓝图 **200**，
  键集合恰好 `bundle,digest,id,scope,verificationPlanId`，`digest` 与冻结回执逐字相同、
  `verificationPlanId` 与刚建刚批的那个计划相同，`scope` 2 条、`bundle.publicVectors` 1 条、
  `bundle.contractRevisions` 1 条，整段回包里 `manifest|holdout` 一个都不匹配（大小写不敏感）。
  bundle 的七个键就是 §7.3 那份名录。中途还有一次真实读数：计划没批的时候去冻结拿到
  **422 `BLUEPRINT_BLOCKED`**，而路径里 id 写成 `undefined` 时命中的正是新加的
  `blueprint-id-malformed` 400——不是 404。
- 两条作业生命周期门（`POST .../jobs/:j/cancel`、`.../cleanup-retry`，2026-10-17 01:18 同源读数）：
  取消一个 `succeeded` 的作业 → **202 且状态仍是 `succeeded`/`cleanupState=complete`**（§8 写的
  「完成态返回现状」）；带字段的 cancel → **400 `rejectedKeys:["reason"]`**；
  cleanup-retry 不带幂等键 → **400 `idempotency-key-required`**；带上 → **202**
  `{jobId, cleanupState:"complete", retryAt:null, leaseIds:[], auditSeq:17}`（那个作业没有 lease，
  所以"没什么可排"如实报出来）；**同键重发拿到逐字相同的回包（`auditSeq` 仍是 17）而 `x-request-id` 换了**
  ——这就是幂等日志在起作用：重放的是那次决定，不是第二次执行。
  §11 的终态由 `canTransitionJob` 那张表持有，所以服务里**没有**再加一道"是否终态"的检查：
  变异 P1 证明那道检查与它守的规矩没有任何可观察差别，属于装饰，本轮把它删了。
- 项目分页（`GET /api/v1/projects`，2026-10-17 01:28 同源读数）：库里三个项目，`?limit=1` 逐页走 ——
  第一页 `browser-page-b`、游标 `YTQyNDM3…` **解码回来正是那一行的 id**（游标是服务端发的，不是调用方写的），
  第二页 `read-doors-pass`（`inventoryRevision=2`），第三页一行、游标为 null，**没有任何一页是空的**
  （`hasMore` 靠"多问一行"决定，这条被变异 Q2 验过：让它恒为真就会发出一条通向空页的游标）。
  拒绝侧：自造游标 → **400 `projects-cursor`**；`limit=abc` → **400 `projects-limit-malformed`**；
  `limit=5000` → **413** `{reason:"projects-limit", limit:5000, maxLimit:200}`——
  #59 那份具名键名单在这里第一次派上用场，两个数字真的过了 socket 到操作者眼前。
- 两条 target 门也在同一套 rig 里过了一遍（配对页面同源，2026-10-17 01:03）：
  `POST .../targets` 交 `HTTPS://Shop.Example/Cart/../checkout?x=1` → **201**
  `{kind:"url", snapshotDigest:null, identityReason:"url-declared-not-captured", auditSeq:14}`；
  `GET .../targets/:t` → **200**，八个键里**没有 locator**（§5），`evidenceIds:[]`、`importJobId:null`；
  带凭据的 URL → **400 `url-credentials-forbidden`**，`kind:"har"` → **400 `target-kind-needs-import`**。
  磁盘侧独立核：`targets.original_locator` 存的是**序列化后**的 `https://shop.example/checkout?x=1`
  （不是页面敲进去的那串），日志那一行 `actor_kind=reviewer`、`reason_code=url-declared`、
  `safe_metadata_json={"host":"shop.example"}`——记的是主机，不是 locator。
  顺带一条被测试纠正的期望：`url-host-missing` 那条规则**被删了**，因为 WHATWG 解析器让每一种
  「看着没有 host」的写法都直接解析失败（`http://`、`//host/x`、`http:`），而 `https:///path`
  反而把 `path` 提升成 host——留着那条检查就是留一条永远走不到的分支。
- 两条新读门在同一轮里由配对页面同源取过：`GET .../contracts/da06…` 回 200、16 个键，
  `digest` = `ec5d1eec…9e62` 与库里那一行逐字相同，`review.status` 是 `draft`；
  `GET .../verifications/01d2…` 回 200、12 个键（**没有** `staleness`——§8 那一列写的是报告本身，
  服务替自己调用方重算的那份新鲜度不出这道门），`result=PASS`、`counts.total=1`。
  磁盘侧独立核一次：`verifications.report_artifact_id → artifacts.sha256` =
  `181f46fb…0e8d`，同一份文件 `shasum -a 256` 得同一个值，文件里的 `result`/`counts` 与页面拿到的
  一致——「门服务的是存着的那份字节」这条只有这样才能算证过。
  同一路径上 `contracts/not-an-id` 回 400 `contract-id-malformed`、不存在的 verification id 回
  404 `verification-unknown`。
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

浏览器实测·第五轮（2026-10-17 05:21，同一套三个真进程）：库存分页在页面里由 `fetch` 直接走
Next 中继，读数逐条对过——无 `targetId` 与 `targetId=not-a-uuid` **都是 400
`vectors-target-required` 且不回显那串文本**；一个形状合法、无人拥有的 target 回 **200
`{inventoryRevision:1, items:[], nextCursor:null}`**（既不是 404 也不是 403：拿别人的 target
试探存在性需要「读不到」和「不存在」长得不一样，这一跳故意不给）；`limit=201` 是 413
`vector-limit`，`limit=1.5` 是 400 `vectors-limit-malformed`；伪造游标 `!!!!` 是 400
`vector-cursor`——**这一条是 worker 的编解码给的，边缘不预判**；`/vectors/<id>` 那条单读路由
仍然分得开（404 `vector-unknown`）。库存正文与 409 那条**不在这个 socket 上重测**：它需要真的
样本行，证明在 `vector-service.test.ts` 里（27 条，其中这个路由 8 条），那里有行。

浏览器实测·第六轮（2026-10-17 02:05–02:09，同一套三个真进程：worker＋`npm run web`（4310）＋
`next dev`（4496）；开 rig 前照 #72 那条老毛病走了一遍——`data/worker.lock` 里写着 pid 55268，
`ps -p 55268` 已不存在，`worker.rpc.sock` 用 `lsof` 确认没有活监听者，才把这两个陈旧文件删掉）：
配对后 `GET /session` 给 200、`csrfToken` 43 字符、`reviewerId=64cd4e19…`。同源 `fetch` 走这一扇新门：

- 先由 §8 line 295 那扇门确认候选是真的：`GET /projects/:p/candidates/7a03f405…` → **200**，
  键集合 `[blueprintId, digest, files, id]`。
- `POST /projects/:p/verifications`（键 `browser-verify-1`，体只有 §8 那三个字段）→ **202**，
  回包恰好 9 个键：`{id:e046b176…, kind:"verify", state:"queued", cleanupState:"pending",
  deadlineAt:null, retryAt:null, cleanupRetryAt:null, resultRef:null, error:null}`，
  `x-request-id 5740904a…`。
- **同键同体重发** → 回包与第一次**逐字节相同**，而 `x-request-id` 换成 `9289d49a…`：重放的是那次决定；
  日志里 `verification.request` 的 allow 只有**一条**（seq 20），命令确实只跑了一次。
- 同一行从读门回来：`GET /projects/:p/jobs/e046b176…` → **200**，与 202 的回包逐字节相同
  （一道投影，两扇门）；作业列表从 3 行变 4 行，新那行在最前。
- 拒绝侧四条各有形状：无键 **400** `idempotency-key-required`（message 是流水线那句
  "this creation needs an Idempotency-Key header"，不是 worker 的措辞）；体里塞 `comparatorCode`
  → **400** `rejectedKeys:["comparatorCode"]`；形状合法但不存在的候选 → **404** `candidate-unknown`；
  `comparatorPolicyId:"close-enough-v0"` → **400** `comparator-policy-not-installed`
  带 `declaredCount:2`；同一个键换一个候选 → **409** `idempotency-key-reused`。
- 磁盘侧独立核（第二个连接，`readOnly:true`，worker 仍持写锁）：那一行 `idempotency_key=browser-verify-1`、
  `request_digest=269eb29f…18a5`、`target_id=NULL`、`created_at=updated_at=02:05:45.597Z`；本项目
  `kind='verify'` 只有 **2** 行（播种那行 `succeeded` ＋ 我这行 `queued`）；`verifications` 计数仍是 **1**
  ——这一句是「请求造不出报告」的读数，不是注释；`events` 里那个 aggregate 只有 **1** 条
  `job.updated`，payload 是 `{"resourceIds":[e046b176…],"state":"queued"}`；`audit_entries`
  seq 20 的 `safe_metadata_json` 记的是 `{"comparatorPolicyId":"exact-http-v1"}`（记名字，不记体），
  seq 21 是那条 deny；被 404 的那个候选 id 在 `jobs` 里没有任何行。
- 页面自己读到的：重新加载后（`会话：paired`）左栏两行变成 `任务 e046b176-efd3-49ce-9047-7cd8a0d0b328`
  与 `清理 pending`——这一轮**没有加任何按钮**，作业页的第一行本来就是这么来的。
- 这一轮**没做也没法做的**：这个 `queued` 作业在本 build 里没有任何执行者。§10 说的可信 evaluator
  是另一个容器，它把 completion 交回 worker 的那条「具名 RPC」在封闭命令表里**还没有名字**
  （`VerificationService.complete` 至今只被测试调用），所以这道门造的是一份没人认领的工作。
  这不是门的问题，是缺另一扇门，已单开 **issue #75** 记录（命令名、evaluator capability、
  以及「谁把 queued 推到 running」三点等裁决）。

浏览器实测·第七轮（2026-10-17 04:11–04:16，三个真进程：worker＋web(4310)＋next dev(4496)；
这一轮换了两处 rig：`WB_REA_ENTRYPOINT` 指向 `tests/fixtures/rea-mcp-fixture.mjs`（记录的 tools/list
形状那份），因为 `capture.importHar` 要先有一个 provider 会话才建得出摄取服务；worker 是 **SIGTERM
优雅停**的，日志收在 `worker stopped`／`web stopped`，`worker.lock` 与 `worker.rpc.sock` 自己消失了
——这正是 #72 说的「只有非正常死才会留下陈旧文件」的反面证据）：

- 配对走页面表单（`Dv1eCWNK…` 一次性码），配对后 `GET /session` 200、`reviewerId=a7eb883a…`。
- `POST /projects/:p/imports`（同源 `fetch` + `FormData` + 一个 `File`，键 `browser-import-1`）→
  **202**，体恰好两个键 `{targetId:"1759a481…", job:{id:"61832ff6…", kind:"inspect", state:"queued",
  cleanupState:"pending", deadlineAt:null, retryAt:null, cleanupRetryAt:"2026-10-17T04:11:57.216Z",
  resultRef:null, error:null}}`。`cleanupRetryAt` 不是墙钟：投影的 `now` 取的是那一行的 `updated_at`
  （`job-queue.ts:111`），所以它是可重读的行派生值，不是每次读都变的数。
- 同键同体重发 → 回包**逐字节相同**而 `x-request-id` 换（`77837a47…`）；`har.import` 的 allow 日志
  只有 seq 23 与 24 两条（两次导入各一条，重发没跑命令）。
- **二进制那条**是这一轮的关键读数：浏览器造 4096 字节 `0x00..0xFF` 循环体 → **202**，
  `targets.source_sha256`＝`snapshot_digest`＝`artifacts.sha256`＝`c8f5d034…f193`，
  与我在另一台 shell 里对本地重建的同一串字节 `createHash` 出来的值逐字相同；
  落盘文件 `shasum -a 256` 同一个值，头 16 字节 `0001 0203 … 0f`，大小 4096，权限 `-rw-------`，
  键名就是内容地址。文本那条 87 字节同样对得上（`d27c19f9…524d88`）。
- 拒绝侧八条各有形状：无键 **400** `idempotency-key-required`（流水线那句措辞）；
  错 CSRF **403** `csrf-token-missing`；JSON 体 **400**（不是 multipart）；`image/png` **422**
  `import-media-type-unsupported` 带三个允许值；多带 `recordOrdinals` **400**
  `rejectedKeys:["recordOrdinals"]`；`kind:"asar"` **503** `import-asar-not-wired`；
  `kind:"asar"`＋`sensitiveValues` **422** `SENSITIVE_PROJECTION_UNSUPPORTED`（§8 那条自己区分的答案）；
  5 MiB＋1 字节 **413** `{byteLength:5242881, maxBytes:5242880}`。
- **一条测试抓到的真缺陷**：上面那两次 422 里，第一次（改门前）的回包把调用方自己声明为敏感的
  `image/png` **原样复读**了；把声明的读取提到所有拒绝之前之后，同一处的细节变成 `"mediaType":""`。
  这条后来固定成用例（A11 变异 → 红）。
- 页面自己读到：重载后 `会话：paired`，左栏 `任务 db52b6e9-1155-454e-8834-0dc3b1105139`／
  `清理 pending`／`画面 无画面：本次导入只带请求与响应，没有预览帧`——那句这次是**真话**，
  上传里确实一个预览帧都没有（本轮没有加任何按钮，也没有生产者）。
- 磁盘侧独立核（第二个连接 `readOnly:true`）：两条 inspect 作业都 `queued`、`target_id` 指着各自
  新建的 target、幂等键分别是 `browser-import-1`／`browser-import-bin`、两份 `request_digest` 不同；
  两条 `resource_leases` 的 ownership proof 是 `{"mintedBy":"har-import","jobId":…,"sourceArtifactId":…}`；
  `events` 各一条 `job.updated`，payload 是 `[jobId, targetId]`＋`state:"queued"`；
  `verifications` 计数仍是 1（导入造不出结论）。
- 这一轮**没做也没法做的**：`file` 部分 5 MiB 以上没有通路（#77），ASAR 那条只到「具名拒绝」，
  导入之后的 `capture.inspect` 跟进没从这道门跑过（它没有 HTTP 命令名，README 的「还没有的东西」里
  ASAR/HAR 解码那半仍按未接线读）。

浏览器实测·第八轮（2026-10-17 07:03–07:13 UTC，三个真进程：worker（数据目录 `rea-rig-s5/data`）＋
web(127.0.0.1:4310)＋`next dev apps/web -p 4496`；这一轮是**页面控件的第一轮**——落地清单（§8 line 270）、
作业两扇门（line 278-279）、验证请求（line 297）此前只有 HTTP 通路，操作员手上有门但没有按钮）：

- **这一轮先抓到一个静默缺陷**：用 `http://127.0.0.1:4496` 打开时页面渲染正常但**完全不 hydrate**——
  会话行停在 SSR 的 `会话：unknown`、点「改用列表视图」毫无反应、按配对按钮走的是浏览器**原生表单提交**
  （URL 变成 `/?`），而 console 里除了 HMR websocket 失败**没有任何报错**。Next 16 对不认识的 Host 拒发 dev
  资源，`next.config.mjs` 加上 `allowedDevOrigins: ["127.0.0.1", "localhost"]` 之后同一个 URL 的读数变成
  `会话：unpaired` 且视图切换生效；`localhost` 那侧打印 `[HMR] connected`。这行配置**没有加测试**（断言它
  等于把配置抄第二遍），证据就是上面这组前后读数。
- 中继的 origin 门与 API 的 §14 origin 门是**两道门**：dev 进程没带 `WB_UI_ORIGIN` 时，在 `localhost:4496`
  提交配对得到 **403 `proxy-origin-mismatch`**（中继只认自己配置的那一个 own origin；转发给 API 的 `origin`
  是中继重写的），带上 `WB_UI_ORIGIN=http://localhost:4496` 后同一次点击成功。默认值是一对
  `localhost:3000`／`127.0.0.1:4310`，改端口就得同时改这一个变量。
- 落地页首屏（未配对，SSR 就有）：`[data-panel="project-list"]` 在、行 0 条、空态逐字
  「还没有会话：项目清单要配对之后才读得到，用终端里打印的配对码建立会话。」，配对表单在同一屏。
- 用表单里的一次性码配对成功 → 列表立刻重读，两行逐字 `browser-round-8｜图 1｜库存 1`／
  `second-project｜图 1｜库存 1`，`data-projects-count="2"`，尾行「没有更多项目了」，「下一页」按钮 0 个
  （`nextCursor` 是 null；控件不为自己造游标）。
- 点行上的链接真的导航到 `/project/a3357b9d…`，会话行 `会话：paired`。cookie 是**按 origin 隔离**的：
  同一套 rig 换到 `127.0.0.1` 那侧读回来是 `unpaired`——这是浏览器的规则，不是页面的分支。
- 作业面板按 §11 决定给不给按钮：`verify｜succeeded｜清理 complete` 与 `build｜succeeded｜清理 pending`
  两行都**没有**取消按钮，位置上是那句「这一行已是终态 succeeded：§11 不让终态复活，取消只会返回现状」；
  前者的清理格写「作业行的清理状态是 complete，没有要重排的清理」，后者给 1 个「重排清理」。
- 按「重排清理」→ 面板行「已请求重排清理：没有可重排的清理（这扇门只回收自己发过的 staging，§5）」，
  重读后那一行仍是 `succeeded/pending`：门说没重排，页面就不显示成重排过。
- 代码 tab 自己找到候选 `b52b8b7e…`（作业 `resultRef` 那条路）与 3 个文件；新控件的比较器输入框**初值是空的**
  ——没有任何门列出装好的策略名（记在 #58），页面不替操作员猜一个。
- 填一个不存在的 `looser-than-anything-v9` → 「验证请求被拒：comparator-policy-not-installed（declaredCount 2）」，
  作业行**仍是 2 条**：被拒的请求连作业都不排（§10 那句在这里是可读的两件事）。
- 改成 `exact-http-normalized-v1` → 「已排入验证队列：作业 64150627-6478-4470-a24f-a0935d8f62ca（queued）」，
  列表头一行变成 `queued/pending`，两个按钮都在（非终态可取消、清理未完可重排）。
- 按「请求取消」→ 面板行「已请求取消，现在这一行是 cancelled」，那一行 `cancelled/pending`，全页取消按钮
  0 个、重排按钮 2 个：按钮的有无是 `jobActions` 一处判定，页面没有再写第二份。
- console 全程两条信息（React DevTools 提示、`[HMR] connected`）加**一条故意的 400**（那次不存在的比较器名），
  没有未捕获异常。变异：`mutate6.py` 16 条视图模型变异（U1-U16，含新抽出的 `isSessionReason`）**全被杀**，
  跑完 `RESTORED rc=0`——顺带修掉一件事：`mutate5.py` 的备份目录是 `if not exists` 才写，于是它把 14:54
  的旧快照当"还原"覆回了 `view-model.ts`，那一轮的 `RESTORED rc=1` 就是这件事的读数，不是测试红。
- 这一轮**没验到的**：截图与真指针点击都拿不到（in-app 浏览器 viewport 0×0，pointer 动作直接报
  `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`），上面所有动作是在真页面里派发真 DOM 事件、由 React 处理的，
  **像素层没核**；SSE `job.updated` 的推送没被观察——页面上每次状态变化都是门答完后**重新读清单**得来的；
  蓝图冻结（`POST /blueprints`）与 `candidate.generate` 在页面上仍然没有控件。

浏览器实测·第十六轮（2026-10-18 00:59–01:00 UTC，同一套三个真进程、worker 与 API 都没重启）：这一轮测的是
**§8 line 289 的造计划把手**，`data-panel="plan-build"`。它排在冻结那一节**之前**（`indexOf` 比较过），因为计划是冻结的输入：

- 首屏读数（项目 `5be90c73…`，两个都是本轮点出来的 URL 目标）：`data-plan-subject="blocked"`，句子逐字
  「这个目标还没有快照摘要：§8 line 274 说未捕获前身份未知，而计划绑的正是「这一次冻结的库存」。先导入一次采集（§8 line 272）或声明后跑一次 capture。」；
  `data-plan-contracts="empty"`（**不是** unreadable——日志读到了，里面确实没有 `contract-approved`），句子逐字「还没有已批准的契约：先批契约（§8 line 287），这一栏才有点得动的东西。」；
  `data-plan-rows="0"`（**没有硬塞的排除行**：`exclusions` 合法地可以为空），加按钮在；
  回执格是「尚未造计划：这一发只写一份草稿计划，批准要另走 §8 line 291。」。
- **那句话是真话而不是套话**，独立核对过：直接 `GET /projects/5be90c73…/targets/3d1a85ff…` 回包里
  `snapshotDigest` 就是 `null`——页面说"还没有快照"说的正是那一行的状态。
- **排除行的编辑本身在真页面上成立**（不需要快照就能测的那部分）：点「加一条排除」→ `data-plan-rows="1"`、
  `data-plan-reason="unanswered"`、successor 那一格**不存在**；把「哪一种说法」选成 superseded →
  successor 的 select **出现**（选项只有占位 `（空）`，因为本轮这个目标的库存是 0 条，页面不编样本行）；
  换回 outside-scope → successor 那一格**又消失**。删掉这一行 → 回到 `data-plan-rows="0"`。
- 空着点「造计划」：回执就是上面那句快照拒绝，**`/verification-plans` 出现 0 次**（资源计时里一条都没有）——
  门口那条 400 在这个 build 里根本走不到，因为页面自己先说了缺哪一样。
- console **0 条**（本轮整页重载过，连 Fast Refresh 那两条都没有），无未捕获异常。
- 这一轮**没在浏览器里走通的那半**（如实记在这里，别按已交付读）：**点到 201 的那条路**。它要一个"带快照的目标 +
  一条已批准的契约"同时存在，而这个 build 里 `capture` 与 `inspect` 作业都没有执行者（#75/#79 那一类缺席），
  页面上的采集上传虽会造出带快照的文件目标，契约却仍只能由脚本或同源 `fetch` 造（那是剩下那两扇创建门的账）。
  正向路径是靠 `tests/integration/web-api.test.ts` 那条**真门**用例证的：把页面三次读（日志／目标行／样本页）的回包
  喂进 `planDraftOf`，产出的体直接从 HTTP 门打出去 ⇒ **201**，`planCommitReceiptSchema` 解析过，
  `reviewStatus=draft · selectedCount=1 · excludedCount=0`，回执句子里有 planId、「草稿（还要 §8 line 291 的批准）」、
  「选中 1」且不含 `undefined`；再把一条"必需用例"排掉发出去 ⇒ **422 `vector-both-selected-and-excluded:<那条 id>`**，
  这一对恰好证明页面的门与门口的规则**分工**而非重复：必需用例是已批准契约的函数（§7.4），页面读不到那个集合，
  所以它不猜——发出去，让门点名。

浏览器实测·第十五轮（2026-10-18 00:38–00:40 UTC，**同一套三个真进程没重启**：这一笔只动 `apps/web`，worker 与 API 的代码没变，
所以第十四轮那个配对会话还在（配对码一次性，会话只活在那一个 worker 进程的内存里）；这一轮测的是**页面上最后一扇只有门没有把手的写动作**：
§8 line 273 的 `POST /projects/:p/targets`，`data-panel="target-declare"`）：

- 首屏（什么都还没打）：新节在编排节**之前**（`compareDocumentPosition` = 4，即 declare 在前），地址框 `value=""`、
  回执格是「尚未声明：这一发只写一行目标，不会去访问任何东西。」，采集节的主题行照旧指着上一次声明的那个目标
  （`目标 a97af19b…（声明出来的 URL）｜图修订 0｜profile 0 个可用，清单共 1 个`）。
- **打一个带凭据的地址再点**：回执逐字「这个地址还不能声明成目标：url-credentials-forbidden」，
  句子里没有 `hunter2` 也没有 `user:`；**`/targets` 那条 URL 在资源计时里出现 0 次**，也就是这一下压根没出网。
  这一句的**规则名与门口那条一模一样**（同一条用例把三个缺陷各打一遍 HTTP 门，逐条比 reason 字符串）。
- **打 `https://api.example/orders` 点「声明目标」**：一次 POST，回执逐字
  「已声明 URL 目标 3d1a85ff-874b-4c88-b5d0-07034c732c2a｜身份未知（url-declared-not-captured）｜日志 seq 6：要等一次采集真跑过，才有可比较的快照。」
  ——**没有把"已声明"说成"已就绪"**：§8 line 273 明写 URL 未捕获前身份未知，`snapshot_digest` 在库里就是 `null`。
  输入框自己清空（回执留着），所以下一次声明不会带着上一次的地址。
- **紧接着只看页面、不碰脚本**：采集节主题行的目标 id **换成了刚点出来的那一个**
  （`3d1a85ff…`），状态仍是 ready——这一条是"成功后整页重读"的证据：门写的那一行，页面是**读回来**的而不是照回执拼的。
  同时定向调查那一节自己翻成「这个目标是声明的 URL，背后还没有导入的字节…」（与 #58 第十三轮那条语义读数同一形状）。
- **然后一次纯点击的采集**：勾 profile `har-capture`、起点 `https://api.example/orders`、第 1 行 role=heading/name=订单 →
  「已排入采集：作业 de0bc4a7-9d53-4683-b103-24eba6e551eb（queued）」，作业面板三行（新行 queued、上一轮的 80be0166 queued、37c09a0c cancelled）。
- 库侧独立核对（只读连接，worker 仍持写锁）：那条作业的 `target_id` **等于刚声明的 `3d1a85ff…`**，
  `input_json` 里 `scenario.startUrl="https://api.example/orders"`、`actions[0].locator={kind:"role",role:"heading",name:"订单"}`、
  三个网络格 `false`；`targets` 表那两行的 `original_locator` 就是打进去的两个地址、`snapshot_digest` 均 `null`；
  日志 seq 6 是 `target.create|url-declared|{"host":"api.example"}`——**记的是 host 而不是 locator**（§5 不把可含凭据的 locator 写进日志），
  seq 7 才是 `job.request|job-queued|{"taskKind":"capture"}`。
- console 全程 2 条（`[Fast Refresh] rebuilding` / `done in 144ms`，即这一笔新代码被 dev 编译），**0 条报错**。
- 这一轮**没验到的**：截图（工具的路径白名单照旧既不收 `/tmp` 也不收工作区）；"成功后重读整页"这一条**没有自动守卫**——
  静态渲染不跑 effect，我把 `await load()` 删掉的话 unit 与 render 两条都不会红，所以这条只在浏览器里读到了；
  一次真采集的执行（`capture` 作业仍无执行者，与 `verify` 同一类已声明的缺席）。

浏览器实测·第十四轮（2026-10-18 00:20–00:26 UTC，三个真进程：worker（数据目录 `/private/tmp/wb-rig-1018/data`，
profile `har-capture`、`queueWaitMs:30000`、`maxGenerationAttempts:3`）＋web(127.0.0.1:4310)＋`next dev apps/web -p 4496`
（`WB_UI_ORIGIN=http://localhost:4496`）；这一轮测的是**页面最后一把手**：§8 line 275 的 capture 半边，
`data-panel="capture-compose"` 那一节（issue #58 的账到这里只剩三扇创建门，采集编排已经不是账了）：

- 落地页配对 → 新建项目 `browser-round-14-capture`（id `5be90c73…`）→ 用同源 `fetch` 打 §8 line 273 声明 URL 目标
  （201，`identityReason=url-declared-not-captured`，日志 seq 2 只记 `host:"shop.example"`）。**这一发是页面还没有把手的那扇门**，
  所以下面所有读数里 `targetId` 都来自这一次声明。
- **`GET /api/v1/health` 第一次在真页面上答 200**（本轮之前它只能是 503，见下面的"这一轮抓到的一条真缺陷"）。
  网络面板三条 `GET /health [200]`（每次 load 一条，dev 的 StrictMode 让 effect 跑两遍所以清单类 GET 成对出现），
  回包里的 profile 是 `har-capture｜available=false｜141.0.7390.107｜limits 7 个数`。
- 首屏（还没点任何东西）：标题下的主题行逐字「目标 a97af19b-6467-49dd-ad9c-a8bd77472584（声明出来的 URL）｜图修订 0｜profile 0 个可用，清单共 1 个」，
  `data-capture-subject="ready"`；profile 下拉两个 option——`（还没有选：这一格没有默认值）` 与
  `har-capture｜浏览器 141.0.7390.107｜本机不可用：host-platform-unverified-for-sandbox、host-cannot-enforce-sandbox、rea-package-digest-mismatch`；
  动作表 1 行、`data-capture-kind="click"`、`data-capture-locator="role"`，因此页面上只有 role/name 两个框，
  `data-capture-testid`/`data-capture-value`/`data-capture-wait` 三个选择器各 0 个命中；三个网络勾选框全 `checked=false`；
  回执格是「尚未发起：这一发只会排一个采集作业，不会给出结论。」。
- **空着点「发起采集」** → 回执逐字「还没有选 profile：它固定的是沙箱、镜像摘要与限额，§10 不许页面替你挑一个。」，
  而且**没有 POST 出去**：网络面板里 74→75 之间一条请求都没有（`/jobs` 只有 `?limit=50` 的两条 GET）。
- **填好再点**（profile `har-capture`、startUrl `https://shop.example/cart`、第 1 行 role=button/name=加入购物车、
  点「加一行动作」后第 2 行改成 waitFor＋testId=receipt＋visible、勾 requestBody） → 一次 `POST /jobs [202]`，
  请求体逐字（433 字节）`{"targetId":"a97af19b…","expectedGraphRevision":0,"task":{"kind":"capture","profileId":"har-capture",
  "scenario":{"startUrl":"https://shop.example/cart","actions":[{"kind":"click","locator":{"kind":"role","role":"button","name":"加入购物车"}},
  {"kind":"waitFor","locator":{"kind":"testId","value":"receipt"},"state":"visible"}]},"network":{"requestBody":true,"responseBody":false,"headerValues":false}}}`
  ——**没有 `timeoutMs`、没有 `sensitiveValues`**，因为那两格空着；`Idempotency-Key: e0a9ddcd-5153-47e3-9180-c2a69c099916` 是这一次点击自己的。
  回执「已排入采集：作业 37c09a0c-514b-4b40-87b4-d29ee5a85119（queued）」，作业面板当场多出一行。
- 数据库里那一行（只读连接查 `workbench.db`）：`kind=capture state=queued cleanup_state=pending
  deadline_at=2026-10-17T16:24:15.653Z`——**请求里没写 deadlineAt**，这个时刻是 profile 的 `queueWaitMs` 30 秒加上去的（§11/§14）；
  `input_json` 与发出去的体一致（两个动作、`requestBody:true`），`request_digest=148925e5…`。日志 seq 3 是
  `job.request|allow|job-queued|{"taskKind":"capture"}`。
- **门口那一发被页面上的规则先挡住**：把 startUrl 换成 `http://user:hunter2@shop.example/cart` 再点，
  回执逐字「startUrl 不能用作采集起点：url-credentials-forbidden」，句子里**没有** `hunter2` 也没有用户名（§12.1 只发名字），
  并且**依旧没有 POST**——网络面板从头到尾只有两条 `POST /jobs`，第三条点击没有产生请求。
- **两格可选项答了才走**：startUrl 改 `https://shop.example/checkout`、timeoutMs 填 45000、敏感值填 `sesame-secret-value`
  → 第二条 `POST /jobs [202]`（497 字节，体里多出的正是 `"timeoutMs":45000,"sensitiveValues":["sesame-secret-value"]`），
  作业 `80be0166…`。**存下来的那一行里没有那个秘密**：`input_json` 只到 `"timeoutMs":45000` 为止，
  两条 capture 行的 `input_json`＋`request_digest`＋`audit` 全库扫一遍含 `sesame-secret-value` 的行数 = **0**（§8 line 308 与 §12.1 在真页面上对上了）。
- 取消把手对这一发同样有效：点旧作业的「请求取消」→ 页面上那行落定 `data-job-state="cancelled"`，按钮只剩「重排清理」，
  句子是「这一行已是终态 cancelled：§11 不让终态复活，取消只会返回现状」。
- 重载整页：主题行重新由三条读算出来（还是 ready），五个输入格全部回空、profile 回到 `""`、动作表 1 行 `click`、
  回执回到「尚未发起…」——**页面上没有任何一处把上一次的编排留在内存之外**。
- console 全程 2 条（`[Fast Refresh] rebuilding` / `done in 146ms`，那正是这一轮新代码被 dev 编译的那两行），**0 条报错**。
- **这一轮抓到的一条真缺陷（同一笔里修掉了）**：编排控件要读 health 拿 profile 名字，而 `GET /health` 在本仓**从来没能答出 200**——
  路由挂着，但它 `parseStrict(healthResponseSchema, …)` 的那一步必红：`ProfileRegistry.healthView()` 交出的体里
  少了契约要的 `schemaVersion`，而 `limits` 是整个 `profile.limits` 直接透传、多了契约没点的 `maxGenerationAttempts`
  （strictObject 认多余键就是 `unrecognized_keys`）⇒ 每一次 `GET /health` 都是 503 `health-shape`。
  之所以十三轮之前没人发现：**页面上没有任何一处读 health**，而 `tests/integration/web-api.test.ts` 里唯一那条 health 用例
  断的是"没会话时拒"，红在这一步之前。现在两侧各有一道守卫：`healthView()` 的输出被 `effectiveProfileSchema` 逐字段解析
  （`tests/unit/boot-and-profiles.test.ts`，含 limits 七个键名的清单），加上本轮三条集成用例真的 `GET /health` 并要 200。
  同一笔里还删了 `contracts/boot.ts` 的 `healthProfileSchema`/`HealthProfile`：零调用方，而且它和活的 `effectiveProfileSchema`
  对 `schemaVersion` 的说法**相反**（一个不收这个键，一个必填）——两个持有者迟早让投影跟自己不一致。
  **一处仍要与文档对质**（已开 issue）：§14 line 475 的 limits 清单只有 7 个数，而 `contracts/boot.ts` 的 profile 声明要求
  第 8 个 `maxGenerationAttempts`（§7.3 的修复次数预算）；文档没点名的这个字段现在只活在配置侧，health 与 broker 描述符都不带它。
- 这一轮**没验到的**：真浏览器里截图（工具的路径白名单既不收 `/tmp` 也不收工作区，所以读数全部来自 a11y 快照、DOM 查询与网络面板）；
  `localhost:4496` 之外没有第二个 origin 的对照；一次真采集的执行（runner 仍然只认 `build`，`capture` 作业停在 `queued` ——
  与 `verify` 同一条已声明的缺席，见 #75/#79）；`vector.create`、`contract`、`plan.build`、`POST /projects/:p/targets` 四扇门仍没有把手。

浏览器实测·第十三轮（2026-10-17 11:33–11:45 UTC，同一套三个真进程：worker（数据目录 `rea-rig-s9/data`）＋
web(127.0.0.1:4310)＋`next dev` 在 4496（`WB_UI_ORIGIN=http://localhost:4496`）；这一轮测的是 §8 line 275
的 **inspect 把手**，issue #58 剩下的最后一格页面动作）：

- rig 播种两个项目（一个 `har` 目标 + 两条主张，一个只有声明的 URL 目标）；第一次播种脚本因为
  `asDigest` 导错模块而中途死掉，于是**多出一个"有项目、没有目标"的第三种状态**，这一格反而白送了一个
  真读数（见下）。配对码一次性、约 15 分钟，每次重启 worker 都要重新配。
- 先用 `127.0.0.1:4496` 打开时被自己的 §14 门拒了：落地页逐字「项目清单读取被拒：proxy-referer-mismatch」——
  UI origin 钉的是 `localhost:4496`，换到那个域名才成。这条不是故障，是那道门在起作用。
- 进入 har 项目 `66433cda…`：`data-inspect-subject="ready"`，逐字
  「目标 612fc048-d1d0-47c1-ba93-1a729009dd70｜HAR 导入的字节｜图修订 0（这一发带着它，图动了门口回 409 而不是默默扩大范围）」；
  勾选框两条逐字「cart 路由在 401 时不写 body（修订 1｜覆盖 unknown（coverage-unknown））」与
  「cart 路由在 include 非空时返回 items[]（修订 1｜覆盖 unknown（coverage-unknown））」；口径三档逐字
  「（还没有选：页面不默认任何一档）」（`selected`）、「只看已导入的字节（静态）」、「连同捕获当时的运行时观测」，
  `select.value` 是空串。
- **什么都没答时点发起：一次请求都没发。** 只填问题不勾口径 → 「还没有确定调查口径（只看已导入的字节 /
  连同捕获当时的运行时观测）：两者问的不是同一件事，§10 不许页面替你默认一档。」；全空 →
  「问题还空着：§8 要求 inspect 带非空 question，格子缺什么本身不构成一次提问。」；
  两次 `window.fetch` 计数到的 POST 都是 **0 条**。
- 勾 1 条主张 + 选 `static` + 提交：恰好 1 条 POST，体逐字
  `{"targetId":"612fc048-…","expectedGraphRevision":0,"task":{"kind":"inspect","claimIds":["c94a4320-…"],"question":"这两条主张在 401 分支上还成立吗？","scope":"static"}}`，
  带一把一次性 `Idempotency-Key`；回执「已排入定向调查：作业 df1f0f7f-e957-415a-881e-a09f231c0b71（queued）」，
  作业面板当场长出「inspect｜queued｜清理 pending」，事件流那行变成「…（最后一条 seq 31）」。
- 磁盘侧独立核（第二个连接 `readOnly:true`，不走页面）：那一行的 `input_json` 与浏览器发出的体**逐字相同**
  （问题原文、claim id、scope 都在），`request_digest=bd2b7eeba6009dd7…`，`deadline_at=11:35:13.444Z`
  = 建行时刻 11:34:43.444Z + rig profile 的 30 秒排队（不是页面写的），`idempotency_key` 就是那次点击的键；
  `events` 表 seq 31 是 `job.updated`、`aggregate_id` 正是那个作业——页面上的 seq 与日志里的 seq 是同一个数。
- URL 项目 `47c85a59…`：`data-inspect-subject="blocked"`，逐字「这个目标是声明的 URL，背后还没有导入的字节：
  inspect 读的是导入内容，门口会以 inspect-needs-file-target 拒收。先上传 HAR 或 ASAR。」；把问题与口径都填好
  再点，POST 仍是 **0 条**——这道拒绝发生在出门之前，而且说的是门会给的那个 reason。
- 「有项目、没有目标」那一格：逐字「图读没有给出 targetId：定向调查必须有目标，而本项目当前的视图里没有这个格位。」
  **这一轮就是在这里抓到我自己的过度声明**：主张清单那一段当时会印「本目标还没有任何主张：这一发只能是首次分析…」，
  而这个项目根本没有目标——那句话是对"某个目标"的判断，页面没读到目标时不配说它。收窄成
  `inspectClaimsNoteFor`（无读、无目标都返回 `null`）并补了四条用例，回到同一个页面重读：那句已经不出现了。
- 一次真状态转移（顺手读到）：在 har 项目里用页面同源 `fetch` 声明一个 URL 目标（201）之后，下一次整页重读
  把图读命名的目标换成了那个 URL 目标，于是 inspect 把手自己翻成上面那句 URL 拒绝，之前勾选的 claim
  也从清单里消失（这正是"勾了清单里没有的"那条守卫防的形状）。同一次读数里
  `graphRevision` 是 **0 → 0**：声明目标不是图写，所以它触发不了 409。
- 并发令牌是真的，不是装饰：在 `6b2e7ad7…`（har 目标 + 1 条主张、`graph_revision=1`）用真指针点勾选框、
  a11y `fill` 填问题与口径，然后把该项目的 `graph_revision` 由**库侧**推到 2（本 build 里页面能碰到的任何动作
  都不写图——capture/inspect 没有执行者，那是 #75——所以要制造一个"图动了"只能出此一手），再点一次发起：
  「定向调查请求被拒：graph-revision-changed（actual 2 · expected 1）」，`inspect` 作业行数 **0**，表单内容原样留着；
  把计数改回 1 再点，同一张表单就拿到 202「已排入定向调查：作业 075ecc8a-…（queued）」，事件流 seq 33。
  ⇒ 409 只关于令牌本身，别的路径没被它顺带挡住。
- console 最后一条页面加载 **0 条消息**；本轮**没能**用截图（MCP 截图工具的路径白名单同时拒了 `/tmp` 与工作区路径），
  所有读数都是文本回执逐字抄的。

本轮**没有验到 / 不该按已交付读**的：capture 那一半仍发不出去，是面板上那句具名说明而不是一个按钮（`scenario.actions`
需要编排控件）；`inquiryQueueLine` 的新文案这次没被点击路径覆盖——这四个项目的格子本轮都没有带 §6 缺口的行
（列表里 `button[data-inquiry]` 计数 0），所以那句话只有 headless 渲染与用例读数，点格子入队那一路仍是第十一/十二轮的读数；
`expectedGraphRevision` 的 409 是**库侧改计数**制造的，不是真图写；`inspect` 作业会一直停在 `queued`（没有执行者，#75）。

闸门读数（改完最后一处再全量重跑）：typecheck 两份 tsconfig 全绿；lint 202 文件 0 条；`test:unit` **638 通过 / 38 文件**；
`test:integration` **458 通过 + 6 跳过 / 25 文件**；`npm run review` 扫 195 文件 **0 命中**；`docs:check` 用例 17 / 验收 13；
`perf:t17` rc=0 且 `gateHostSatisfied=false`（#23 的宿主条件，本轮没动）。变异 **17 支：16 支被杀，1 支按定义杀不掉**——
`<select>` 由 `value` 受控时 React 根本不渲染 option 上的 `selected`，所以"注入一个 selected 的 option"是**空操作**而非漏洞；
换成真会犯错的那一笔（把受控 `value={inspectScope}` 写成 `value="static"`）立刻被渲染用例杀掉。

浏览器实测·第十二轮（2026-10-17 10:49 UTC，同一套三个真进程；这一轮测的是**代码 tab 上那格比较器**，
issue #82 收口的地方——写门只收已安装的名字，而此前页面上没有任何东西能列出它们）：

- 打开代码 tab：`#comparator-policy` 的 `data-comparator-list="ready"`，三个 option 逐字是
  「（还没有选：页面不默认任何一档）」、「exact-http-v1｜v1.0.0｜什么都不视为相同（逐字节严格）」、
  「exact-http-normalized-v1｜v1.0.0｜会视为相同：header 名大小写、JSON 键序」，而 `select.value` 是
  `""`——**清单从 worker 读，预选一个是不行的**。
- 什么都不选就点「发起验证」→ 面板写「还没有选比较器策略：差别是裁决口径（把哪些差异视为相同），§10
  不许页面替你默认一档。」，并且**没有发出请求**：`GET /jobs` 计数前后都是 11 行 / verify 3 行。
- 选 `exact-http-v1` 再点 → 「已排入验证队列：作业 9767f062-f69a-4100-8f06-d4548c0b2fa9（queued）」，
  计数 12 / verify 4，作业面板第一行就是 `9767f062=queued`，流那一行的尾部 seq 到 30（#85 那条订阅）。
- 变异：`mutate17.py` 八条（门里加 default／门答空表／worker 列出门会拒的名字／worker 按字母序回／
  页面给不认识的归一化起名／"读不到"折进"没安装"／先报清单再报没会话／页面替操作员预选）**8/8 全杀**，
  跑完逐字节还原 + 三支测试现跑 `rc=0`。**运行器自己错过一次**：四条给页面所有者的用例我把 config 传成了
  integration 那份，vitest 找不到文件 ⇒ `rc=1` 且没有 `Tests` 汇总行，于是第一批把它们全报成"存活"——
  换成 unit 配置后四条全杀。这是第三次"变异脚本的判定自己会骗人"（前两次是 ANSI 吞掉汇总行、`l.startswith`
  永不匹配），⇒ **每条"全杀/全绿"都要先看那一次运行到底有没有跑到测试**。
- 这一轮**没读到的一格**：`data-comparator-list` 的另两个状态（`unreadable`／`empty`）在真浏览器里没被
  触发过——要让读门答不上来得换一个不会答的 worker，而这会把同一页面上其他读数一起弄脏。它们有单元测试
  （三种句子两两不同、各自含自己的关键词，且"空清单"与"读不到"不共用状态），以及一条 unpaired 时的
  401 集成用例；页面上这两句目前只有代码路径保证。

浏览器实测·第十一轮（2026-10-17 09:15–09:27 UTC，同一套三个真进程；这一轮是**页面第一次订阅 §13 的
`job.updated`**（issue #85），所以读的全部是「不重载时屏幕会不会自己动」）：

- rig 的两处自伤记录，都值一行：worker 的 `WB_REA_ENTRYPOINT` 必须是**存在的文件**（本轮用仓库自己的
  `tests/fixtures/rea-mcp-fixture.mjs`），而那个位置参数是**包目录**（`rea-rig-s9/pkg`）——把它指到仓库根
  得到的是一格 `check limits=failed limits-unknown-no-profile`，随后生成门按 `generation-budget-unknown`
  拒；两处都是"报错在别处"的形状，不写下来下一轮还会撞。配对码是一次性的，且会话只活在那个 worker 进程的
  记忆里（§14），所以每重启一次 worker 浏览器就得重新配对。
- 配对完成后 **400ms 内**面板就是「作业状态由 §13 的 job.updated 推送。」。这一句在修之前永远停在
  「正在接 §13 的事件流，还没有连上。」，对照读数是同一次打开的两条路：直连 API 的响应头 `+6ms`，
  经中继的响应头 `+1267ms`——`+1267` 恰好等于第一条事件落地的时刻，即**中继在第一个字节之前不发响应头**，
  于是空闲的流在浏览器看来还没连上。补的东西是流上的第一帧 `: stream-open`（SSE 的注释行，客户端按规范必须
  忽略），它不携带任何状态，只证明字节在动。
- **点「为该蓝图发起一次生成」** → 回执「已排队生成：作业 17bd0cac-…（queued）」；同一页面**不重载**，
  约 1.6 秒后面板尾部的 seq 从 25 跳到 28、第一行成为 `build｜failed`，worker 那边同一件是
  `runner failed job=17bd0cac… reason=generation-budget-exhausted`。中间那格 `running` 落在两次采样之间，
  读到的是"三次推送都到了、行自己动了"，不是一屏抓到全部三个状态。
- 按 queued 的 verify 行的「请求取消」→ 1.3 秒内该行 `cancelled/pending`。**但这一句当时是点击自己的重读
  带来的**：面板 seq 仍停在 28——取消门改了作业行却没写事件。本轮补两处写者（`job-lifecycle.ts` 的 cancel
  与 `recovery.ts` 的 interrupted），并由新测试钉住两面：同一件第二次取消（行没动）→ 开着的流 600ms 静默，
  而第一次取消 → 帧里 `aggregateId=jobId`、payload 逐字 `{resourceIds:[jobId],state:"cancelled"}`。
  `job.cleanup-retry` 仍**不写事件**，因为 §11 没让作业行动、它只重排租约——给没动的行发状态才是撒谎。
- 停进程的读数：**0.236 秒**（同一改动落地前的另一版实测 0.462 秒，都是页面还订阅着的时候），web 进程自己
  走干净并打出 `web stopped`。这是本轮改出来的行为——订阅之前不会遇到（空闲流当场结束），加了泵循环之后
  第一次停就是停不掉：老进程挂在 `server.close()` 上等一个没有理由关闭的标签页，只能 SIGKILL（那一笔真的
  发生在这轮的中途，读数就是 `kill -TERM` 之后进程仍在）。现在 `startWebServer` 自己收尾：停泵、结束响应，
  再关监听；`ends a live stream when the process is stopped` 就是这条的回归测试。
- 断开的这句话**多久**出现：页面先读到「作业状态由 §13 的 job.updated 推送。」，`kill -TERM` 之后
  **23ms** 的那一次采样就已经是「事件流已断开：下面这些行是上一次读到的快照，不是现在的状态。」
  （上一版同一件事实测 0.84 秒；更早一次在一个 EventSource 建在改动之前的旧页面上要二十多秒）。
  这三档差值都来自浏览器自己的重连判定，不是页面的判定，所以这条只作为"会说谎的那一格被堵住"的证据，
  不作为延迟指标。
- 变异：`mutate14.py` 十条（前导帧、泵的空转不结束、停止时不收流、两处 `job.updated` 写者与它们的
  反例）**8 杀 2 存**，两条存下来的都是 `writableEnded` 上的守卫——按"杀不掉且因检查无可观察差别就改语义"
  处理：`take()` 改成**先看关闭再看队列**（旧顺序会把已排队的帧交给一个已被停止结束的响应），两处守卫收敛成
  一处并把写帧的循环抽成 `writeStreamFrames`，新增 `tests/unit/web-server-frames.test.ts` 三条把它钉住；
  复跑 `mutate15.py` 五条，N1-N4 全杀，**N5 仍存**（`stopStream` 里不调 `pump.close()`：差别只在尾还会
  多轮询一次，没有任何测试能读到），留着是因为流的拥有者该由打开它的地方关。两批跑完都逐字节核对还原
  （`identical=True`）并现跑三支测试 `rc=0`。
- 这一轮**没验到的**：截图与真指针点击仍拿不到（viewport 0×0），以上都是真页面里派发真 DOM 事件；
  **两个标签页互相看见**没测——本轮只证明了一个订阅者收得到，多标签的扇出靠的是同一份 outbox，没读；
  `graph.updated`／`evidence.committed`／`report.stale` 这些别的事件名页面**不监听**（只有 `job.updated`
  会让面板重读），这是选择不是遗漏：其余面板各有各的门。

浏览器实测·第十轮（2026-10-17 08:39–08:40 UTC，同一套三个真进程；这一轮加的是**页面上剩下的两把手**：
落地页的「创建项目」（§8 的 `POST /projects`）与样本 tab 的「上传采集」（line 272 的 multipart 门），
顺带把六个写控件共用的两句"能不能发"收成一处）：

- 空名字点击 → 「还没有写项目名：这道门收的就是一个名字，空着不算一次创建。」；只填空白（`"   "`）同一句；
  **两次都没有发出请求**（列表仍是 2 行），因为这句话是页面自己说的，不是 400 回来的。
- 填 `made-from-the-page` → 「已建项目 made-from-the-page｜图 0｜id fbe7d6e4-0e0a-4365-8921-6d2354deaa50」，
  列表立刻重读成 3 行，新那行是 `made-from-the-page｜图 0｜库存 0`——图 0 是 §8 那一列自己要求的字段。
- 新项目的样本 tab：先点「上传」（没选文件）→ 「还没有选文件：这道门只收 multipart 的 `file` 部分，空体不算一次导入。」，
  作业面板仍 0 行；`GET /projects/:p` 的 `targetIds` 仍为空——这句话也没有换到一次请求。
- 用 `DataTransfer` 放进一个真 HAR（一条 `GET https://shop.example/api/cart` 记录）并声明两个敏感值 →
  「已收下采集文件：目标 932c392a-110b-4270-8942-f98e9c0af053｜作业 inspect a02529e6-654d-446b-b8ce-289c08fcd9c3（queued）」；
  处理函数随后 `load()` 重读整页：`targetIds` 真的有那一个目标、`GET /jobs` 里那一行是 `inspect/queued/pending`、
  库存栏从「本项目还没有目标」变成带 `data-inventory-revision="0"` 的清单。
- 同一栏换 `kind:"asar"` **带**敏感值 → 「采集上传被拒：import-asar-sensitive-values-unsupported」（422）；
  把敏感值清空再点 → 「采集上传被拒：import-asar-not-wired」（503）。**门里那两条不同的路在页面上是两句话**，
  页面没有先替它们做任何校验。
- console 只有两条信息 + 那两条**故意的** 422/503，没有未捕获异常。

页面控件之外的两处变化：`sessionGate` / `projectDraftOf` / `uploadDraftOf` 是新的三个持有者——六个写控件以前
各写一遍「有没有令牌」「体的必填字段齐不齐」，现在只有一处；`postJson` 与新的 `postForm` 共用同一个 `post`
（ multipart 的 `content-type` 必须由浏览器带 boundary，所以它是唯一一处不写这个头的地方）。

浏览器实测·第九轮（2026-10-17 08:12–08:17 UTC，三个真进程：worker（数据目录 `rea-rig-s9/data`）＋
web(127.0.0.1:4310)＋`next dev apps/web -p 4496`（`WB_UI_ORIGIN=http://localhost:4496`）；这一轮测的是
**契约 tab 上新增的两扇门**：冻结蓝图（§8 line 292）与发起生成（line 294）。rig 的准备脚本只写到
`seedReviewChain` 那一层（草稿样本/草稿契约/草稿计划，用仓库自己的 support helper），三次批准是在页面里
用同源 `fetch` 打的，冻结与生成则是**点按钮**）：

- 落地页配对成功 → 两行 `browser-round-9-plain｜图 1｜库存 1`、`browser-round-9-freezable｜图 1｜库存 2`。
- 进入项目页、批准之前：冻结栏逐字「还没有已批准的计划：批计划（§8 line 291）之后，这一栏才有点得动的东西。」，
  生成栏逐字「还没有冻结过的蓝图：先在上面点「冻结蓝图」，§8 line 294 才有点得动的一行。」，按钮各 0 个；
  此时 `GET /audit` 回 **0 条**——两句空态说的都是真话，不是兜底文案。
- 三条 review 门 200 之后（`vector-approved`／`contract-approved`／`plan-approved`，日志 seq 2/3/4），
  重载页面 → 冻结栏出现 1 个按钮，`data-blueprint-freeze="766880ca…"`。
- **点「冻结该计划为蓝图」** → 回执逐字「已冻结蓝图 762494d4-c94b-4a5c-8456-fb3ebfb36740｜公开 1｜保留 0｜
  契约 1｜日志 seq 5」；处理函数答完自己重读日志，所以栏位当场变成
  「已批准的计划都已经冻结过蓝图了：再一次冻结要的是一个新计划，不是同一个的第二遍。」、按钮归 0，
  而生成栏**无需重载**就出现了那个蓝图的按钮。
- **点「为该蓝图发起一次生成」** → 「已排队生成：作业 ea85380c…（queued）」——回包是作业行不是候选（§10）。
  约 1.5 秒后读 `GET /jobs`：那一行已经 `succeeded` 且 `resultRef=d6e7073c-007d-4765-9762-d78b2d3c0fdc`，
  执行者是 worker 自己的泵循环（`RUNNER_POLL_MS=250`），页面上没有任何脚本触发过它。
- 重载 → 代码 tab 的候选就是那个 `resultRef`：`adapter.ts（typescript，1033 字节）` 等 3 个文件，
  点开 `adapter.ts` 读到正文首行「// Generated from a frozen REA Workbench blueprint…」与它的 `sha256`。
  **这一条就是 #57 第四个完成条件在浏览器里的读数**：从「冻结」这一次点击起，链不再需要播种脚本。
- 预算是真门：连点四次生成得到 4 个不同作业（每次点击一个 `Idempotency-Key`），三个 `succeeded`
  （候选 `d6e7073c…`／`11175fa4…`／`5cf42a4b…`），第四个 `failed`，其 `error` 是完整 ApiError：
  `{code:"RESOURCE_LIMIT", message:"generation-budget-exhausted", retryable:false,`
  `details:{attempt:4, maxAttempts:3}, requestId:"969c67de-39b0-498f-b299-b958a30e6323"}`
  ——`maxAttempts` 正是 rig 的 profile 里那个 3，`requestId` 是那次点击带的键。日志里成对出现
  `candidate.request|build-job-queued`（控制面造工作）与 `builder.generate|candidate-generated`
  （worker 的 Builder 身份做工作），最后一条是 `builder.generate|generation-budget-exhausted` 的 deny。
- console 全程 2 条信息（React DevTools 提示、`[HMR] connected`），**0 条报错**。
- **本轮抓到的一条真缺口**：作业面板只在「自己那扇门答完之后」重读清单，泵循环推进的行不会自己来——
  读数里出现过 `queued` 与四个 `succeeded` 并存的一屏（那是上一次读的快照，不是服务在骗人）。
  §13 的事件流与 SSE 门本仓已经通了，缺的是这个页面没订阅。已写进「还没有的东西」，并单开 issue。
- 这一轮**没验到的**：截图与真指针点击（in-app 浏览器 viewport 仍是 0×0，所有动作是在真页面里派发真 DOM
  事件、由真 React 处理）；SSE 推送路径（上面那条缺口本身就是它）；一次真模型生成（Builder 子进程产的
  是 fixture 入口下的确定性文件）；`verify` 作业的跟进仍没有执行者（#75），这轮 4 个 build 作业里没有
  一个是被「跑验证」的。

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

- 页面上的写控件现在覆盖到「建项目 → 声明 URL 目标 → 上传采集 → 采集编排 → 定向调查 → 批 → 冻 → 生成」以及作业的两扇门（第九、十轮有浏览器
  读数）：**有**按钮的是落地清单、新建项目、配对表单、采集上传、**声明 URL 目标（第十五轮）**、**发起一次采集（第十四轮的编排控件）**、**定向调查**、**造验证计划（第十六轮）**、样本决定、作业取消、清理重排、验证请求、
  蓝图冻结、发起生成；**没有**控件的是 `vector.create` 与 `contract`(草稿) 两扇创建门——
  它们的必填输入要从证据正文里派生（record ordinal、schema 体、requiredCases 联集），页面上做一个能填的
  表就等于做一个会猜的表，所以这三扇仍靠 `fetch` 驱动，是 issue #58 剩下的账。冻结与生成能上页面，是因为 §8 没有计划与蓝图的**清单**门，
  本页改从 §8 line 302 的本项目决策日志里读「哪些计划已批准、哪些蓝图已冻结」：一条 journal 行都不自己造，
  读不到日志就说读不到（`FREEZE_EMPTY_LINE` 的三种空态各有自己的句子）。
- §10 的 evaluator 有了一条**具名命令**（`verification.complete`，PR #84 之后由这一笔加上，issue #75 的
  第一条），但**没有 evaluator 进程**：runner 依旧只认 `build`（V1 变异钉着"放开 kinds 就跑红"），所以
  `verify` 作业仍然停在 `queued`。这条缺席现在由 doctor 的一格说出来：`verification-executor` 在没有
  verify 作业时是 `ok`（facts 只有 `queuedVerifyCount: 0`），一旦队列里等着一件就 `degraded` 报
  `verification-executor-not-installed`——一条已排入 `build` 作业不会让它报警，两件事是不同的缺席。
  completion 体的 schema 是硬门：少字段按缺的名字拒，多带一个 §10 没点名的键（试的是自报结论）按那个
  键名拒；角色门在 schema **之前**，builder 与 inspector 拿到的是自己的理由而不是"体不对"。
  **这一笔补上的是完成回执与工作行之间的绑定**（issue #75 里"#56 型空缺"那一类：规矩写在唯一持有者里，
  但非测试的调用方从来没有走过它）。此前 `completion.jobId` 被抄进两条 artifact 与 verification 行，
  而**没有任何一处去读那行 job**：报告可以把整条来源指向一个从来不是作业的 id，而真正被 §8 line 297 排出来的
  那一行在完成之后仍是 `queued`、`result_ref` 空着——也就是说 §8 line 277 的「含持久 resultRef，可恢复构建/验证
  资源 ID」只对 build 成立。现在同一笔事务里按 §11 走：job 不存在 → `verification-job-unknown`；kind 不是
  verify → `verification-job-kind-mismatch`（带 `jobKind` 这个名字）；那一行自己请求的 candidate 或比较器与回执
  不一致 → `verification-job-request-mismatch`，**只发字段名不发两边的值**（§12.1），而且
  `input_json` 读不出这两个名字时算**不匹配**而不是"没有约束"（否则一只手写空行就接受了任何回执）；
  已经是 `succeeded` → `verification-job-already-completed`（验证行是不可改证据，再跑一次是新请求，不像 build
  那样允许修复尝试把指针改指下一个 candidate —— **这一条是我按 §11/§5 的语义做的判断，文档没有逐字这么写**）；
  `cancelled/failed/interrupted/cancelling` → `verification-job-terminal` 带它读到的状态（终态不复活）。
  放行时 queued 先被同一个 `transition` owner 推到 running 再到 succeeded——**照 `builder-service.ts` 已有的做法**，
  §11 的图里没有 queued→succeeded 这条边——然后 `result_ref` 写成这次 verification 的 id、`cleanup_state` 原样
  留着 `pending`（§11 清理是独立状态），并补一条 `job.updated` 事件，`resourceIds` 是 `[作业, 验证]` 两个 id。
  **`verification.claim` 是 #75 的认领那半**（PR 见下）：§11 说 `queued` 只能去 failed/cancelled，
  结果只有 `running` 能拿——所以在没有容器、也没有 evaluator 进程的 build 里，这条具名命令就是
  `verify` 行离开 `queued` 的唯一去路，而它的角色门只认 evaluator（§7.3：控制面**请求**作业，evaluator
  **做**作业；所以 inspector 拿到的是"你不是那个角色"，不是"队列空"）。
  三种答案，不是两种形状：`claimed`（作业 + 它绑定的 candidate/blueprint/plan/target/snapshot/比较器，
  全是 id 与摘要，**没有任何字段能承载结论**）、`idle`（本项目没有排队的工作——这是一个答案，不是错误，
  而且**不写日志**：evaluator 是轮询的，一次没活可干不构成一次权限裁决，§12.2 记的是 allow/deny），
  以及 `failed`（那一行自己的 `deadlineAt` 已经过了：§11 要求它落到 failed 并保存明确错误，
  所以这一笔是**提交**后再回答，而不是把拒绝抛出去让事务回滚——后者会让一个过期作业永远 `queued` 地被拒下去）。
  扫描沿 `decideStart` 与 `transition` 这两个既有 owner（不在这里再造一个时钟或一条状态表），
  并且限定项目 + kind；bind 不回来的行（candidate/blueprint 已经不在了）**留在 queued** 并被具名拒绝，
  因为一个 evaluator 拿到却无法执行的 running 行就是"看起来开始跑了"的假象。
  仍然**没有**的东西不变：没有 evaluator 进程来调用这扇门，runner 依旧只认 `build`，所以今天
  没有任何非测试的发起方会把 `verify` 作业认领走；上面那格 doctor 报警照旧，它说的正是"进程不在"。
  字节走 staging 还是 RPC body 这一条也仍是文档侧的开放问题（本仓按 `evaluatorCompletionSchema` 的
  `reportStagingId + reportSha256`，即前者）。
  一处既有的顺序值得知道：报告的 artifact 正文是在事务**之前**发布的（publish-then-commit），所以
  "回执被门拒了"会留下一份没被任何行引用的正文——这不是这一笔引入的（drift 那条拒绝早就是同一个形状），
  记在这里是因为我新加的拒绝让这条路更容易被读到。
- §8 line 275 的**两半把手现在都在页面上**（第十四轮补的是 capture 那一半，第十三轮补的是 inspect 那一半）：
  编排控件不按自由文本收动作——`packages/domain/capture.ts` 一份具名清单同时喂给页面与契约（第十四轮的守卫用例把
  三者按值钉在一起），所以"能填的表"与"能收的体"不可能各长一份。剩下的账不在这一道上，在下面三条里：
  `vector.create` 与 `contract`(草稿) 两扇创建门**没有控件，而且现在也做不出诚实的控件**：`vector.create` 的
  `source.record` 要的是 `recordOrdinal` 或 `transactionId`，而 §8 与"记录"有关的路由只有 line 281 那一条
  `GET /evidence/:e`——它回的是**一个信封**，不是"这个目标下的记录序号清单"。也就是说那一格只能让操作者
  **手打一个他没读到的整数**，而 §8 line 282 后半句写的是门自己从 source 取 request/response、不接受调用方伪造：
  手打 ordinal 一旦被门接受，就是"调用方挑了一条它没读到的记录"，这条门的存在理由被页面自己拆掉。
  要在页面上做这两扇，先得有一道"列出目标下记录序号"的读门——**§8 没有这一道**，我也不会为它悄悄加第 3 条表外路由（#58 已挂 2 条等裁决）。
  `contract` 的 `inputSchema`/`behaviorSpec` 同理：那是审阅者写的承诺（审阅那道门还要求 JSON Schema 2020-12 方言），
  自由文本框不会让它变成"派生"。
  对照之下 `plan.build` 就能做，也已经在第十六轮做了：它要的五个字段**全都读得到**（项目行的 targetId、目标行的快照摘要、
  日志里的已批准契约、样本页的库存修订与那批行号）。"能不能上页面"这条线，画在"每个字段有没有一次读作来源"上。
  §8 line 273 的声明 URL 目标在第十五轮补上了把手，于是"配对 → 建项目 → 声明地址 → 编排并排一次采集"
  这一条链在浏览器里**一次脚本都不用**（那轮的读数就是全部靠点出来的）。
  inspect 那一半的做法是：目标取图读自己给的 `targetId`，
  类型由 `GET /projects/:p/targets/:t` 读回来（页面不再猜 `kind`），主张清单取同一张图读的 `claims[]`，
  并发令牌取项目行的 `graphRevision`——操作者只回答两件事：问什么、勾选哪几条。
  两件事都没答之前不发请求（口径不默认任何一档，§10）；`claimIds` 为空只在"这一格图还没有主张"时允许，
  有主张却不勾是具名拒绝；勾了清单里没有的 id 也是具名拒绝（图读与表单不一致时不静默少发）。
  这些句子与门的做法是两处独立的规则还是同一件事，由 `web-api.test.ts` 里那两条对账用例钉着：
  把页面三次真读的回包喂回 `inspectDraftOf`，产出的体直接从 HTTP 门打出去拿 202；
  反过来把页面的 URL 拒绝与门自己的 `inspect-needs-file-target` 放在同一条用例里读。
  先前我在这里写过"页面挑不出这个目标已有的主张"——那是我没读全 `contracts/graph.ts` 就下的判断，
  纠正同时写回 #58 的评论。
  顺手改掉的一处同类问题：`buildLeftPanel` 的参数原本**要求**调用方交出 `target.kind` 与 `snapshotDigest`，
  而图读根本不给这两样——于是组件里写着 `{ kind: "har", snapshotDigest: null }` 两个字面量在编。
  没有任何地方渲染它们，所以没有一条测试抓得到；参数收窄成 `{ id }` 之后，编译期就不允许再编（typecheck
  是硬门禁，这就是这条的守卫）。
- 页面**已订阅 §13 的 `job.updated`**（issue #85，第十一轮读到的是不重载就翻页）：一帧到达就是"整页重读"，
  面板不由事件自己拼状态，读门仍是页面唯一的来源；断开时那一行改说「下面这些行是上一次读到的快照，不是现在的
  状态」。仍然留着的两格边界：`job.cleanup-retry` 只重排租约、不改作业行，所以它**不产生**事件（写了就是
  给没动的行编状态）；别的事件名（`graph.updated`／`evidence.committed`／`report.stale`）页面不监听，
  多标签页之间的扇出没在真浏览器里读过。
- 作业失败的原因现在**只有一个写者**：`packages/application/job-queue.ts` 的 `jobErrorFromFailure`，
  执行者与 HAR 导入两处都走它。此前导入那两处写的是 `{code, reason}`——`JobRecord.error` 按 §8 是
  `ApiError`，于是一个失败行不是「一行失败」，而是让那个项目**每一页作业都读不出来**；本轮由 V17 变异钉住
  （改回旧形状即红）。§11 里 `interrupted`／从没跑起来的行 `error` 是 null，不是空对象。

- 换 UI 端口要同时换 `WB_UI_ORIGIN`：中继只认它启动时读到的那一个 own origin，浏览器用别的 host 或端口
  打开就拿到 403 `proxy-origin-mismatch`（第八轮那次先被拒、配上变量后同一次点击成功，就是这个形状）。

- ASAR 的导入 ingestion job、目标行与 artifact 落库尚未由 worker 装配接线
  （`apps/worker` 现在只注册 HAR 导入闭环，所以 `kind:"asar"` 的上传在门口就具名拒绝：
  503 `import-asar-not-wired`，带声明时按 §8 先回 422）；HAR 上传这轮有了 HTTP 入口，
  但**导入之后的解码跟进没有**——`capture.inspect` 不在封闭命令表里，作业会停在 `queued`
  （与 #75 那半边是同一类空缺：造得出工作，接不了工作）。`static-analysis.ts` 只做准入闸门与
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
  根本没有可写的字段（DESIGN §10）。**由此产生的一条真实空缺**：`POST /projects/:p/verifications`
  把作业排成 `queued` 之后，本 build 里没有任何执行者来认领它——§10 说的「具名 completion RPC」
  在封闭命令表里还没有名字，`VerificationService.complete` 至今只被测试调用（缺口本身记在
  **issue #75**；同一类空缺在 `candidates`/`jobs` 那两条创建路由上是 #57）。分容器与文件视图
  隔离本身在本机不可验证。受控 Web 采集的契约
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


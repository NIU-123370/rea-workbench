# 测试、发布与回滚计划

状态：V0.1 规划稿，Workbench 运行时、接口、容器配置及下述 Workbench 测试命令尚未实现；本文没有声称这些检查已执行或通过。产品验收编号以 [PRD.md](PRD.md) 的 A01–A13 为准，字段和状态以 [DESIGN.md](DESIGN.md) 为准。

## 1. 验证目标与范围

验证本地单人工作流：导入目标或录制受控 Web 场景 → 保留 REA Evidence 与来源 → 展示 claim/edge 三色和缺口 → 审批不可变蓝图 → 隔离生成 TypeScript HTTP SDK 与 OpenAPI → 在受控 mock 和录制样本上比较请求序列化、响应解析 → 导出带输入身份、覆盖和限制的结果。

完整闭环覆盖 Web URL 主动采集与 HAR 1.2 离线导入。ASAR 只验证离线静态提取与明确的动态未知提示。任意 Electron 应用运行、原生程序执行、后端业务重实现、所有输入等价、真实服务端正确性和法律合规结论不在 V0.1 验证范围。

测试遵循固定 REA 基线的 [测试规范](https://github.com/morluto/rea/blob/98d8470d36cfbf7cd25820a4ed430aebae20c0c5/docs/testing.md) 与 [工具设计规范](https://github.com/morluto/rea/blob/98d8470d36cfbf7cd25820a4ed430aebae20c0c5/docs/tool-design.md)：优先真实公开 CLI/MCP 和产品工作流，再验证生产边界，最后用模块测试覆盖难以稳定复现的 distinct semantics。缺失的真实 provider、浏览器、容器或平台能力必须记录为未验证，不能用模拟结果替代。

## 2. 测试层次与运行环境

| 层次     | 主要范围                                                                         | 能证明什么                             | 不能据此证明什么                                 |
| -------- | -------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| 单测     | Evidence 投影、claim/edge 门禁、revision 失效、比较规则、状态转换、错误契约      | 明确输入下的领域语义及失败分类         | MCP、SQLite、浏览器和隔离真正生效                |
| 集成     | 真实 SQLite 事务与 WAL、摘要文件发布、真实 MCP envelope/会话、broker RPC、流恢复 | 对应生产边界及资源生命周期             | 使用 fake provider 时的真实 REA/浏览器分析行为   |
| 端到端   | UI 经 API、worker、REA、真实浏览器/容器到导出报告                                | 运行记录覆盖的平台上整条公开工作流     | 其他 OS/CPU/provider、互联网任意站点与未观察输入 |
| 负向隔离 | Builder、目标页面、网络和权限拒绝                                                | 实际执行身份下权限边界与审计           | Docker 对所有恶意内核利用均安全                  |
| 恢复演练 | 取消、崩溃、断电等效中断、备份恢复、升级回滚                                     | 指定故障点和版本组合下的数据与资源恢复 | 未演练版本的迁移或无备份数据恢复                 |
| 性能门禁 | 固定硬件下 1,000 条 HAR、200 个可见节点，暖态图更新与冷态记录                    | 固定规模与环境下的 p95 交互延迟        | 无容量上限、其他设备或互联网目标的交互性能       |

开发和 CI 使用固定 REA 基线的 Node.js 24.18.0、npm 11.16.0；安装版本由上游固定提交的 [.nvmrc](https://github.com/morluto/rea/blob/98d8470d36cfbf7cd25820a4ed430aebae20c0c5/.nvmrc) 和 [package.json#packageManager](https://github.com/morluto/rea/blob/98d8470d36cfbf7cd25820a4ed430aebae20c0c5/package.json) 决定，测试程序不得安装或升级无关宿主软件。记录 REA 版本/提交、MCP schema 版本、浏览器和镜像摘要、操作系统、CPU 架构、SQLite schema、比较策略与依赖锁摘要。

基准夹具使用项目自有的本地 HTTP fixture 和合成 HAR，不访问第三方业务账号。成功主路径使用完整的成功/错误响应、重定向、Unicode、重复 query/header、空响应体及可审阅的字节表示，固定公开集与 holdout，预期报告 PASS。缺失正文、不可比较的脱敏、矛盾、过期、unsafe integer 等按具体限制独立列为负向场景，预期阻断蓝图、UNKNOWN 或 FAIL；测试套件通过代表这些预期全部成立，不能要求每个负向报告也 PASS。普通认证排除不自动阻断所有行为；仅在排除影响声明范围的必要比较信息时阻断。外部站点或真实用户录制另做经授权的人工验证，不替代确定性的发布门禁。

fake provider 只用于稳定注入 unavailable、超时、畸形输出和取消等条件；验收报告必须标明 `fake`。真实 REA MCP 分析夹具、真实 Playwright 浏览器、真实隔离执行与真实 SQLite 恢复分别单列记录。任何一项真实环境不可用时使用命名 skip，相关验收保持未验证；不能因此发布为完整 V0.1。

## 3. 验收用例矩阵

| 用例 | 对应验收          | 层次与场景                                                                                                                                                                                                                       | 必须成立的断言                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T01  | A01 导入身份      | 集成 + E2E：HAR/ASAR 导入，Unicode 路径、同名不同内容、重复导入、导入后修改源文件                                                                                                                                                | 目标与不可变快照绑定；路径与摘要语义分离；不串项目；重复请求不重复提交；修改后的源文件不能冒充原快照；ASAR 不被动态执行。                                                                                                                                                                                                                                          |
| T02  | A01、A03、A06     | 边界 + API 集成：HAR 解析、重复键/base64、producer ordinal、缺失/空/脱敏数据；从持久 Evidence 创建、读取、审阅 vectors；错误来源和样本摘要                                                                                       | 保留 REA 已解析值、序号及来源；VectorService 是唯一生产者；operationId/sdkInput 独立定义，oracle 独立审阅；缺必需信息留 blocked；GET 按权限过滤；审阅绑定不可变摘要，不能改写来源。                                                                                                                                                                                |
| T03  | A02 Web 采集      | E2E：用户启动 fixture 采集、点击、停止并检查 HAR/Evidence                                                                                                                                                                        | 捕获范围、环境和运行身份可追溯；停止后保留已获得事实；请求响应与场景关联不被误称为函数级因果；目标超出授权网络范围时停止或明确拒绝。                                                                                                                                                                                                                               |
| T04  | A03 三态来源      | 单测 + MCP 集成：observed、derived、inferred、unknown gap、人工 approve、混合来源与局部覆盖                                                                                                                                      | observed 仅对有来源的具体主张显示绿色；derived/inferred 黄色，缺口红色；approve 不修改 confidence；原始 Evidence 身份、authority、limitations、coverage 不丢失。                                                                                                                                                                                                   |
| T05  | A03、A06          | 集成：只有同时间窗的点击与请求、推断路由模板、缺失 IPC 边、互相矛盾证据                                                                                                                                                          | 时间关联不提升为 causality；未知边保持未知；禁止通过隐藏红边或手动涂绿获得可构建蓝图；显示阻断原因及相关证据。                                                                                                                                                                                                                                                     |
| T06  | A04、A05          | API + SQLite 集成 + E2E：会话 bootstrap、重复创建、断线重连、事件乱序、过期 revision；并发 API/worker 读写与 worker 中断                                                                                                         | POST session 消费终端一次性 token，仅签发 HttpOnly/SameSite=Strict cookie；GET session 给 csrfToken/reviewerId；token 不进 URL/持久化；会话由 worker 内存拥有、重启失效；无会话/错误 CSRF 拒绝；只有 worker 持 SQLite 写连接，API 经本地 RPC；幂等/游标/revision 保持一致。                                                                                        |
| T07  | A05 隔离          | 真实执行边界：Builder 读源码/Evidence/Inspector 日志，调用 REA，访问网络/宿主/其他项目/Docker socket，目标提示注入；候选读 oracle/写报告；读取拒绝审计                                                                           | 文件系统、进程身份、工具网关与网络策略落实拒绝；Builder 仅见批准蓝图与公开 vectors；候选与 evaluator 分容器/文件视图；拒绝、审阅、范围排除、会话建立和清理重试写 audit_entries；全局 GET /audit 与项目 GET /projects/:p/audit 仅操作者可读，分 scope 返回且无原文/秘密；holdout 不进 Builder 上下文。                                                              |
| T08  | A06 蓝图门禁      | 单测 + 集成：required 黄/红主张及边、矛盾/过期/缺覆盖、跨目标、未审阅/审批后修改；库存 scope 排除、冻结计划后删 blocked                                                                                                          | 每个 required derived/inferred 或 UNKNOWN 均阻断；边独立判定；审批绑定摘要；scope 外非 required 可逐项说明排除及未覆盖行为，矛盾/required 缺口不得排除；构建前冻结计划，之后删样本/缩分母拒绝；缩小 scope 须新契约/计划/蓝图且保留旧结果。                                                                                                                         |
| T09  | A07 SDK + OpenAPI | E2E：从有效蓝图生成 SDK、OpenAPI 和交付 manifest；恶意标签/路径注入                                                                                                                                                              | 生成目录不越界；候选代码可构建；OpenAPI 按声明版本验证，operationId 与契约引用稳定；内容不含原始静态切片或凭据；只描述已批准范围，不把单样本推导为完整后台规范。                                                                                                                                                                                                   |
| T10  | A08 差分口径      | 单测 + 真实 runner：固定 invoke ABI、operationId/sdkInput、外部 fixture 观测 method/path/重复 query/body/header、独立 expectedOutcome；公开集、holdout 及负向 fixture                                                            | 故意改坏请求/解码会失败，不接受候选自报 PASS；缺 oracle 留 blocked；counts.total 固定计划分母，inventoryCounts.total 含快照内全部 excluded/blocked；零样本、计划内跳过/失效/不完整不 PASS；负向 fixture 命中预期阻断/UNKNOWN/FAIL 才算用例通过；holdout 明细不反馈 Builder。                                                                                       |
| T11  | A06、A08          | 集成：逐一改变目标快照、contractRevision、planDigest、inventoryDigest、blueprintDigest、candidateDigest、vectorSetDigest、comparatorDigest、runnerImageDigest，篡改存储文件、旧 blocked 向量补足 oracle 后形成 superseded 修订链 | 旧评估立即失效；摘要核验失败阻止验证与导出；报告绑定 verificationPlanId 及 identities 中的所有摘要；不得把旧 PASS 挂到新计划、代码或目标。                                                                                                                                                                                                                         |
| T12  | A09 取消与清理    | 真实进程/容器边界：queued/running 取消、broker 暂不可用/永久失败、队列 deadline、worker 崩溃、清理失败与重复 cleanup-retry、身份复用                                                                                             | GET job/GET jobs/job.updated 的 deadlineAt、retryAt、cleanupRetryAt 一致，无值为 null；队列与清理重试分开；queued 暂不可用留队列至 deadline；永久启动失败或截止未启动转 failed，取消转 cancelled；job/cleanup 独立；POST cleanup-retry 只清理 owned 资源、不重复业务、不伪造 job 结果；重启将遗留运行标记 interrupted，保留 lease/Evidence；身份未知不杀无关资源。 |
| T13  | A10 限额          | 边界：输入、解析展开、事件、输出、磁盘/内存/CPU/进程数/时间越限；DESIGN §14 全部 WB_* 配置合法/非法值                                                                                                                            | 在昂贵分配前按真实表示限制；不静默截断成完整结果，低磁盘/ENOMEM 不发布半写 artifact；配置错误启动前拒绝，GET /health 的 effectiveProfiles 与已校验配置解析结果一致且不回显凭据；失败仍执行或保留清理任务。                                                                                                                                                         |
| T14  | A02、A10          | 真实网络边界：redirect、DNS 变化、IPv4/IPv6 loopback、私网、link-local、云 metadata、代理绕过、目标容器直接联网                                                                                                                  | 每跳与实际连接遵守目标授权；默认拒绝宿主和非授权网段；本地 fixture 仅通过显式测试范围放行；仅 Playwright route 拦截不能算通过；不默认关闭浏览器安全机制。                                                                                                                                                                                                          |
| T15  | A11 离线与脱敏    | HAR 离线 E2E：关闭外网、认证/显式敏感值、普通 token-looking query、子进程环境；ASAR 敏感声明；启动、MCP、broker/清理错误注入                                                                                                     | HAR 不抓取记录 URL；DiagnosticsSanitizer 统一覆盖契约正文/蓝图 payload、API/SSE、jobs.error_json、resource_leases.last_error_json、日志、审计、diff 和导出；固定 schema 字段不改写；普通输入保留，无 ambient env 持久化；敏感声明仅当前内存，恢复丢声明不重跑；ASAR 不支持声明返回 422，owned staging 清理。                                                       |
| T16  | A12 备份升级回滚  | 真实 SQLite/文件系统：WAL 中有提交、迁移中断、缺失/损坏 artifact、新旧 schema 不兼容、旧版本恢复                                                                                                                                 | 备份通过 SQLite 一致性备份机制与完整文件清单恢复；schema 迁移可验证并有记录；不对不兼容数据库直接启动旧程序；恢复后项目、来源、批准、结果失效状态和资源 lease 一致。                                                                                                                                                                                               |
| T17  | A13 性能门禁      | 真实 Linux x64 浏览器：固定 1,000 条 HAR、200 个可见节点；干净启动记录冷态，预热后至少 30 次有效图更新                                                                                                                           | 记录硬件、版本、fixture/镜像摘要及每次测量；从 worker 原子提交到浏览器图/列表完成更新计算 p95，暖态 p95 ≤ 1 秒；冷态、导入耗时、采集/模型等待分列，不靠减少节点/样本或删除慢测量达标。                                                                                                                                                                             |

补充 T06 的跨 session 断言：get_evidence_bundle 只读当前 ledger；断开后旧 retained ID 不可用，完整 Evidence 可按具名契约 inline 使用，或先用 import_evidence_bundle({path}) 导入已导出文件再使用 retained ID。校验失败不能半导入，成功导入不代表 target/provider 进程恢复。

补充 T08/T11 的修订链断言：旧 blocked 向量留在库存并标 superseded/supersededBy，新计划仅引用批准叶版本；旧计划的 required 集合和结果不变。矛盾 Evidence 不能靠替换消失；并发批准两个后继返回 revision 冲突。T06 还需刷新页面后经具名 GET 恢复契约、蓝图、代码与报告，不能依赖创建响应或 SSE 正文。

## 4. 边界、错误与状态断言

API 所有失败使用 `{ "error": { "code": "…", "message": "…", "retryable": false, "details": {}, "requestId": "…" } }`，字段类型及允许的错误 code 由命名契约校验。缺字段、未知字段、无效枚举、错误类型、超范围值和版本冲突均在对应拥有边界拒绝；不能由 UI 自行猜测。校验最终对外 JSON Schema 的声明 dialect 与实际客户端兼容性，不能只检查内部 TypeScript 类型。

验证 job 合法状态 `queued/running/cancelling/succeeded/failed/cancelled/interrupted` 和 cleanup 状态 `pending/complete/failed`。broker 暂不可用时 queued 留队列至 deadline；永久启动失败或 deadline 到期未启动允许 queued → failed，queued 取消 → cancelled。`POST /projects/:p/jobs/:j/cleanup-retry` 只推进 cleanup，不重新运行 capture/inspect/build/verify，也不改变其业务结论；重试失败继续持有 lease。候选程序运行成功、job 成功、评估 PASS、资源清理完成分别断言；例如“发现差异并成功生成报告”可以是 job succeeded + 评估 FAIL，不能混成执行故障。

评估 PASS 要求固定输入身份下冻结计划中所有 required 样本都可执行且比较通过，并且没有 required 覆盖缺口。计划在构建/运行前由审阅冻结，selected 来自契约 requiredCases 的 vectorIds 联集，不能重复维护另一份公开/保留样本名单。缺 oracle 的样本若已在计划内必须计入 blocked，不可删除、改为非 required 或缩分母以制造 PASS。库存中 scope 外或不能支持此行为且非 required 的样本，只能在审阅阶段记录具体排除理由及未覆盖行为；矛盾或 required 缺口不能靠排除消失。缩小 scope 必须新建契约、计划和蓝图，保留原始报告及其固定分母。

明确差异为 FAIL；数据不足、超时、跳过、失效或比较不适用为 UNKNOWN。若既有明确差异又有未完成项，整体为 FAIL 并保留不完整计数。UI 的 `counts` 显示冻结计划的 passed、failed、blocked、skipped、total 及公开集/holdout；unknown 用例计入 blocked，`counts.total` 等于冻结计划样本数，`passRate = passed / counts.total`，仅零计划为 null。另报 `inventoryCounts:{total,selected,excluded,blocked}`：total 含完整库存快照，selected/excluded 是审阅选择分组，blocked 是可与它们重叠的资格维度，不将四项相加；排除原因和未覆盖范围可追溯。库存总数不作 passRate 分母；计划有样本但全被阻断时 passRate 为 0 且整体 UNKNOWN，不能显示通过。

DiagnosticsSanitizer 是全部诊断输出的唯一拥有者；注入带敏感值的 job 启动错误、broker/清理错误、MCP 异常、API 校验详情与日志，逐项检查数据库错误列、API、SSE、审计和导出；另将敏感值注入契约正文、schema、示例及公开样本，断言保存前与 handoff 序列化后的检查均阻断，人工批准不能绕过，也不能静默改写已批准摘要。只清理载荷值，固定 schema 键/状态/错误码不允许因字符串替换被破坏；transport credentials 使用结构化排除，显式敏感声明仅存当前执行内存，重启不可缺声明静默重跑。

检查路径穿越、符号链接越界、解压炸弹、HTML/Markdown/Monaco 渲染注入、恶意标签和工具结果中的提示注入。静态片段与 HTTP payload 作为数据展示；不能作为控制指令或 UI 脚本。完整合法 REA Evidence 只读保留，脱敏交接为派生制品，不改写原 ID；含认证的原始上传仅在 owned staging 中短期存在，完成唯一来源分析后清理。

## 5. 计划命令与当前可用检查

以下命令规划在未来 `workbench/` 包中提供；当前尚未实现，不应将其写为已经可运行或已经通过的验证：

```bash
npm ci
npm run doctor
npm run db:migrate
npm run dev
npm run build
npm run start
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run docs:check
```

其中 `doctor` 只检查环境并输出缺项，不自动安装 Docker、浏览器、Node.js、npm、Java 或 Ghidra；`db:migrate` 必须在先展示变更并获得操作批准、完成一致性备份后执行。浏览器/runner 的 fixture 与镜像准备方式必须在实现后与实际锁定版本一起补充，不能让测试偷偷升级宿主工具。

以下是固定基线 REA 源码仓库中的检查命令，须先按 [README](../README.md) 获取独立源码 checkout，并从该 checkout 根目录执行；仅解压本套五份文档无法运行它们。无论是否运行，都不能视为 Workbench 验收，实际结果以交付说明为准：

```bash
npm run build:cached
npm run test:local -- src/domain/evidence.test.ts
npm run docs:check
```

实现后，发布记录应列出执行的精确命令、版本、退出结果、真实或 fake 环境、命名 skip、artifact/report 摘要。单元测试通过不能代替真实 Web/HAR E2E、隔离和恢复验收。

## 6. 发布步骤

1. 固定候选版本、REA 兼容版本、依赖锁、浏览器与 runner 镜像摘要，记录支持的宿主平台和 SQLite schema。默认仅监听 loopback；在实现前验证实际端口、请求来源校验与本地会话访问控制，不能因本地部署而省略其他网页访问本机服务的防护。
2. 在独立临时数据目录完成 typecheck、单测、集成与 T01–T17 所需真实 E2E；T17 保存至少 30 次暖态测量及冷态记录，p95 ≤ 1 秒为正式发布门禁。检查已知风险和未验证矩阵；A01–A13 任一必需真实验证缺失或失败时，不把该候选发布为通过验收的 V0.1；可保留明确标注的实验版本。
3. 展示安装/迁移计划及新增或修改路径，取得本次操作批准后暂停新任务并等待已拥有任务结束或取消。确认所有资源的 cleanup 状态；失败 lease 记录到备份中，不能为了发布删除其归属记录。
4. 使用 SQLite backup API 等一致性机制生成数据库快照，保存 schema/应用版本和摘要文件 manifest；校验备份能在独立目录打开，清单中每个所需 artifact 摘要匹配。不能仅复制主 `.db` 文件而忽略 WAL 中已提交事务。
5. 保留旧应用与镜像摘要、配置和恢复点；在备份副本上先演练迁移。迁移失败时停止切换，不启动新 worker 继续处理半迁移状态。对真实数据执行迁移后做完整性、外键和 artifact 引用核验。
6. 启动新版本，校验 DESIGN §14 的完整 WB_* 配置及 GET /health 的 effectiveProfiles；通过终端一次性 token 建立本地会话，执行 doctor 与本地 fixture smoke：导入 HAR → 创建/审阅样本 → 查看来源与缺口 → 审阅契约并冻结计划/蓝图 → 生成 SDK/OpenAPI → 比较 → 导出 manifest。核查旧报告失效规则、脱敏输出和 cleanup，再恢复任务接收。
7. 保存发布证据：版本清单、测试报告、备份位置、迁移结果、实际 provider/平台范围和未验证项。对一次性 smoke 的资源等待清理完成，清理失败明确保留 cleanup-retry 入口与审计记录。

## 7. 回滚步骤

1. 出现证据错绑、隔离失效、不可恢复迁移、错误 PASS 或持续无法清理资源时，停止接收新任务并记录故障；按所有权取消新版本运行，保留已获 Evidence、诊断和 lease，避免直接删除容器或数据目录掩盖问题。
2. 核对旧应用支持的 schema。只有验证为向后兼容时才允许旧应用使用当前数据库；否则停止所有写入，将当前数据库及新增 artifacts 另存为故障恢复点，恢复发布前的一致性备份到新的数据目录。禁止盲目执行 down migration 或让旧程序碰不兼容 schema。
3. 核验恢复点的数据库完整性、artifact manifest 与摘要、项目和目标身份；重新核对仍存在资源的 lease。无法证明归属的资源保持 unknown，不凭复用的 PID、路径或相似名称杀进程。
4. 启动固定的旧版本及其镜像，完成 HAR 离线导入、来源查看和报告读取 smoke；复核恢复点后的审批、候选与测试结论未被错误保留。确认数据库和清理状态后才恢复接收任务。
5. 明确回滚可能丢失恢复点后的逻辑提交；这些数据已保留在独立故障恢复点，不承诺自动合并。需要恢复时通过版本兼容的导入/修复流程逐项核验，不能直接拼接 SQLite 文件。记录恢复耗时、未恢复范围和后续处理。

## 8. 已知风险与发布限制

| 风险                                           | 当前约束与验证方式                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 容器共享宿主内核，浏览器与生成代码可能利用漏洞 | 无 privileged、无宿主/socket 挂载、最小权限与独立网络；T07/T14 证明已配置边界，不声称绝对安全；高风险可执行样本不属于 V0.1。       |
| HAR 只含生产者保留的历史事实                   | 缺 body、重定向上下文、缓存、Service Worker、WebSocket、TLS pinning 等记录限制；T02/T03 不将缺失解释为空或证明因果。               |
| 有限样本不足以证明所有行为                     | 公开集与 holdout 分开，声明实际比较范围；T10/T11 阻止零样本 PASS、过期结论和后端等价宣传。                                         |
| 契约与样本可能包含受限内容                     | 保留来源和授权声明，结构化认证排除与显式敏感值规则覆盖交接和日志；洁净室流程不自动构成法律合规证明。                               |
| 外部模型改变本地数据边界                       | V0.1 默认离线生成/验证；没有本地 Agent 能力时生成步骤保持不可用，不静默切换云模型；外部模型接入需独立范围和验证。                  |
| 单机 SQLite、磁盘和日志增长                    | worker 唯一写连接，API 经 RPC；WAL、真实表示限额与备份；T06/T13/T16 验证并发、容量和恢复，T17 验证有限规模延迟；不承诺跨机高可用。 |
| 不同宿主 Docker 与浏览器行为不一致             | 逐个平台记录真实验证；未运行的平台标记未验证。ASAR 的静态成功不代表该应用动态可运行。                                              |
| Agent 可能被目标文本诱导或对已知样本过拟合     | T07 验证权限拒绝、T10 保留 holdout；隔离不依赖模型服从，公开样本通过不替代独立评估。                                               |
| broker 中断、PID 复用或清理失败                | 资源 lease 与任务结果独立，失败保留 ownership 和重试；T12 不把失联视为已退出或把未知视为外部资源。                                 |

尚无 Workbench 真实测试、性能基线、容量测量、真实 provider 或平台通过记录。A13/T17 是实现后的必需门禁，当前没有测量并不表示已满足；实现后必须用记录替换这些未知项，并保持不支持和未验证范围可见。

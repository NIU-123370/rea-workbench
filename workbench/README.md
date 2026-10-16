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
| `packages/domain`                           | 主张三色投影、canonical JSON 与两类摘要、不透明 Id / Instant、向量与契约语义                                                                               |
| `packages/contracts`                        | 严格 wire schema 与上游镜像：`rea-evidence.ts`（envelope）、`rea-web-capture.ts`（抓包）、`rea-static-analysis.ts`（`analyze_javascript_application`）、`sandbox.ts`（broker 四命令与 egress 策略）、`rea-analysis-view.ts` / `rea-evidence-bundle.ts`（保留与导入导出）、`verification.ts`（比较器具名版本与 evaluator 完成回执） |
| `packages/application`                      | VectorService / PlanService / ContractService / BlueprintService、`static-analysis.ts`（ASAR 静态支路）、`verification-service.ts`（验证报告的唯一生产者）、DiagnosticsSanitizer、AuditService、决策与事务日志 |
| `packages/adapters/rea`                     | MCP 回复解码、Evidence 索引投影、HTTP 抓包事实读取、session 身份、具名 schema 对账（`schema-reconciliation.ts`）与按引用保留（`retention.ts`）                    |
| `packages/adapters/storage`                 | 唯一 SQLite 写连接、增量迁移、按摘要落地的不可变 artifact store、一致性备份                                                                                 |
| `packages/adapters/sandbox`                 | broker 命令渲染、egress 地址判定、broker 帧编解码；隔离效果未经宿主验证                                                                                     |
| `infra/review`                              | 评审 bot 的规则表与扫描器，产出 `.review/findings.json` 与 `.review/summary.md`                                                                            |
| `tests/{unit,integration,fixtures}`         | 纯逻辑门禁、真 SQLite / 真文件门禁与固定 envelope fixture                                                                                                   |

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

## 还没有的东西

`npm run worker` 与 `npm run doctor` 现在存在：前者装配 worker（解析 `WB_*`、拿写
锁、跑迁移、开本机 RPC），后者只报告不改宿主。`db:migrate` 与 `dev` 仍未实现——
迁移由 worker 启动时执行（没有独立的迁移命令），HTTP API 与
会话配对（`apps/web`，issue #17）与 `.env.example` 都还在队列里；宿主 broker 的契约与控制面门禁已落地（issue #21，见下），但 `apps/broker` 进程本体仍未实现。本机没有 Docker 时，隔离类门禁一律不可声明为已通过。

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


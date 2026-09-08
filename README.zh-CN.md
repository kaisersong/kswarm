# KSwarm

> 你有多个 AI agent，但协调它们比干活本身还难。KSwarm 让你只定义目标，剩下的——规划、派发、质量验收、交付——全部自动完成。你的 agent 变成了一支团队。

基于 [Intent Broker](https://github.com/kaisersong/intent-broker) 的多智能体项目协调系统。定义一个目标，KSwarm 将其分解为分阶段任务，派发给最合适的 agent，审核质量，交付结果。

[English](README.md) | 简体中文

---

## Xiaok Desktop 集成基线

文档按 **2026-09-07** 的源码核对，KSwarm 包版本为 **0.9.3**。Xiaok Desktop 已发布版本为 **1.5.1**；其 release workflow 固定检出本仓库的 `desktop-v1.5.1` 标签。当前工作区的新增改动不会自动进入已发布安装包。

- **项目事实来源**：KSwarm 持久化 project、task、workflow run、并行组、review gate 和产物元数据；Desktop 展示看板、Graph、任务详情、干预与交付状态。
- **Room-first 创建**：用户先在协作空间讨论，再通过受信任的确认路径创建项目。`/projects/room-first` 校验凭据、成员和源消息；Xiaok 的 agent 工具只准备提案。
- **执行与恢复**：任务交给真实 Desktop 或外部 agent runtime，通过 Intent Broker 传递请求和结果；lease、健康检查、休眠恢复和明确的失败状态支持重试。
- **工作流交接**：下游节点可读取有大小限制的上游摘要和产物引用；检查点、并行组、依赖与交付门禁保存在 KSwarm，前端不推导“完成”。
- **交付依据**：artifact registry、独立评审、evidence contract、冻结候选产物与带认证的 CAS 写入约束项目交付。文字总结或 broker 投递成功不能替代有效产物。
- **会话内协作边界**：Xiaok 自动启动的 SubAgent 属于当前会话，不等于创建 KSwarm 项目。提示词、SubAgent 展示、Goal、定时任务、录音和 Computer Use 由 Xiaok 或插件负责。

### 关联项目

| 项目 | 职责与集成 |
|---|---|
| [xiaok-cli](https://github.com/kaisersong/xiaok-cli) | CLI 与 Desktop；用户交互、模型执行、工具、知识库、自动化；Desktop 打包并管理 KSwarm sidecar。 |
| [intent-broker](https://github.com/kaisersong/intent-broker) | participant、presence、持久化协作空间、事件、任务交接和回复投递。 |
| [kai-xiaok-plugins](https://github.com/kaisersong/kai-xiaok-plugins) | 报告、幻灯片、画布、会议转写回退和 macOS Computer Use 的 skill / MCP 能力。 |

源码构建时四个仓库放在同一父目录。Desktop 会打包 KSwarm 的 `src`、`scripts`、`package.json`、`ws` 依赖以及生成的 worker override；发布前需对齐关联仓库快照，并在 Xiaok 跑 packaging contract。构建步骤见 [Xiaok 中文 README](https://github.com/kaisersong/xiaok-cli/blob/master/README.zh-CN.md#开发)。

## v0.9.3 新特性：Gate / Evidence / 产物流水线加固

KSwarm `v0.9.3` 新增 canonical artifact registry、contract-kind registry、gate evaluator、gate evidence acceptor、reviewer independence 检查、risk floor、frozen-final-candidate 模块，用于更严格的项目完成治理，以及一个限制在工作区内的 artifact path resolver。

- **Canonical Artifact Registry**：提交的任务产物会注册进一条 canonical 记录，后续 gate 检查和最终交付审批读取同一份一致来源，而不是各自临时推导 artifact identity。
- **Gate Evaluator 和 Evidence Acceptor**：质量评审 gate 现在通过 hydrated gate facts 评估、通过统一的 acceptor 路径接受证据，包括 TOCTOU-safe 的读取路径，防止 gate 检查时确认过的证据在使用前被替换。
- **Reviewer Independence**：如果 reviewer 是被评审 artifact 的唯一生产者，dispatch 阶段直接拒绝，堵住"自己审自己"的漏洞；共同生产或与该 artifact 无关的 reviewer 不受影响。
- **Risk Floor 与依赖策略**：`hub-create-tasks` 和 `hub-human-add-tasks` 现在应用明确的依赖策略，提交的 plan 携带 risk floor，使下游 gate 无论任务如何创建都有一致的最低门槛。
- **Frozen Final Candidate**：批准最终交付物时会冻结批准时对应的候选快照，防止批准悄悄漂移到底层 artifact 的另一个版本。
- **ReviewCondition 与最终审批**：阻塞条件保存 service-owned reviewer identity 和 evidence refs；最终交付审批会在任何状态修改前，对 current review、未解决条件、artifact 完整性和幂等重放执行权威 preflight。
- **v2 Evidence Contract 默认拒绝**：已注册但没有 validator 的 v2 contract family 返回 `unsupported_evidence_contract`；dependency gate 要求同一份新鲜、独立的 evaluation 绑定当前 source 与 consumed artifact identity。
- **认证与 CAS Artifact 上传**：artifact mutation 必须携带 desktop mutation token 和已存在的 `projectId`；默认只能新建，更新必须提供匹配的 `expectedSha256`，返回 hash 按实际存储 bytes 计算。
- **Artifact Path Resolver 容器化**：HTTP 上传、全局读取和 auto-worker 直接写入共用 containment 校验，在落盘前拒绝 traversal 与 symlink escape。
- **回归测试覆盖**：新增聚焦测试套件覆盖 gate-bypass 回归、`submit_result` 时的 canonical artifact 注册、已移除的"无独立 reviewer 时自动通过"兜底逻辑、project-read-model 在 revision drift 时的自动关闭，以及一个端到端 hash-mismatch 修复场景。

## v0.9.2 新特性

- **Workflow 节点间上游 Output 传递**：`compactNodeOutput(node)` 提取已完成节点的结构化 compact（摘要 + 产物路径 + 小字段，单字段 ≤2KB，单节点 ≤4KB）。`enrichWorkflowNodeInput(workflowRun, input, { nodeId })` 收集所有已完成 `dependsOn` 上游（总量 10KB cap，溢出优雅降级为 summary-only）。`dispatchWorkflowNode` 把含 `upstreamOutputs` 的 enriched input 传给 broker/desktop，但持久化前 strip 掉（派生数据不落盘）。`dispatchWorkflowScriptAgentNode` 新增可选 `{ dependsOn }` 参数。
- **Sanitize upstreamOutputs**：`NODE_MUTATION_KEYS` 增加 `upstreamOutputs`，agent 不能把上游数据 echo 回自己的 output mutation。
- **降级日志**：`compactNodeOutput` 和 `enrichWorkflowNodeInput` 的所有 catch 块现在输出 `console.warn`（由 silent 标志控制）。

## v0.9.1 新特性

- **PO Review Verdict 容错**：当 PO 明确通过验收时，缺失 evidence 格式（verdict 字段）不再阻断任务。review gate 现在把没有结构化 verdict 的显式通过视为有效批准，而不是拒绝提交。
- **Resume Workflow 策略**：`handleContinueProject` 现在支持对 blocked script-generated workflow 使用 `resume_workflow` 策略。被阻塞的 workflow 可以被解除阻塞并恢复执行，无需从头重跑。

## v0.8.2 新特性

- **持久化并行 Workflow Group**：script-generated workflow run 现在可以在分支派发前创建由 KSwarm 管控的 `parallelGroups`。分组状态、完成计数、失败策略和时间戳都会随 workflow run 持久化。
- **分支元数据与脚本 Checkpoint**：动态分支节点会记录 `parallelGroupId`、fan-out key/label、required/schema/evidence 标记和脚本 checkpoint，Desktop 可以直接从 KSwarm snapshot 解释并行进度。
- **脚本终态决策**：可信 script runtime 可以正常完成，也可以用结构化 `blocked`、`needs_replanning` 或 `needs_rubric_clarification` 终态阻塞 run，而不是把所有脚本都伪装成 completed。
- **并行脚本 HTTP 契约**：server 新增 `/script/parallel-groups`，`/script/nodes` 会透传分支元数据，`/script/complete` 支持结构化 terminal 数据。
- **Workflow 测试覆盖**：`npm run test:workflow` 已包含 durable parallel group 测试，同时保留 script-generated workflow 控制面和 API contract 测试。
- **Desktop v1.4.3 看板呈现**：Xiaok Desktop v1.4.3 直接消费这些 `parallelGroups`、分支元数据和脚本 checkpoint —— 在每张项目任务卡片上显示细分段进度条（来自 `summary.completed/running/failed`），并新增右侧 `TaskDetailDrawer`，按阶段展示完整节点列表（含并行分组、fan-out 标签、失败策略、单节点状态 / Agent / 错误）。KSwarm 协议和数据模型未变。

## v0.8.1 新特性

- **Script-Generated Workflow Run**：KSwarm 现在负责受控动态 workflow script 的持久化控制面状态，包括 proposal、approved run、script runtime node、动态 agent node、节点 handoff、节点结果和完成状态。
- **从产出物 Agent 节点交付**：项目级 script workflow 完成时，如果 `script-runtime` 只有编排元数据，KSwarm 会从最终产出 artifact 的 agent 节点生成项目交付物。
- **强输出合同校验**：项目交付会校验终态任务的硬输出要求；要求 `report_html` 的 workflow 必须挂上可读 HTML artifact，不能只用 markdown/json 辅助产物通过。
- **项目实例身份**：新项目使用 UUID 风格实例 ID，并支持 `clientRequestKey` 做幂等创建；同名项目不再被误合并为同一个项目实例。
- **Desktop API 契约**：HTTP API 新增 script workflow proposal/start/node/complete 端点，并支持创建项目时关闭自动 PO 规划，便于受控 workflow E2E 验证。

## 架构

```
人类（通过 Web UI / CLI / IM）
    ↓ 目标 + 要求
┌──────────────────────────────────────────────────────┐
│                   KSwarm Hub                          │
│                                                      │
│  目标 → 计划 → 审批 → 派发 → 验收 → 交付              │
│       (PO Agent)                                     │
└────────────┬─────────────────────────────────────────┘
             │ intent-broker 协议
             │ (request_task / submit_result / review / ...)
             ↓
┌────────────────────────────────────────────────────────┐
│                   Intent Broker                         │
│  WebSocket • 在线状态 • 消息路由 • 分组                  │
└────┬──────────┬──────────┬──────────┬─────────────────┘
     ↓          ↓          ↓          ↓
   Claude     Codex      小K       Qoder      (worker agents)
```

---

## 工作原理

### Plan-Do 执行模式

KSwarm 采用结构化的 **Plan-Do** 模式，不是简单的目标拆解后扔出去：

1. **PO 生成 Plan** — 深度分析目标，分阶段任务拆解，每项给出验收标准
2. **人类审批** — 在执行开始前审核计划
3. **阶段感知派发** — 只派发当前阶段的任务；下一阶段等待
4. **运行时安全执行** — 派发会结合 agent 健康、能力和 active-run lease
5. **文件化交接** — 大上下文、任务要求、证据合同和产物合同写入 handoff 文件，不再塞进超长 broker 消息
6. **质量验收** — PO 读取实际产物内容，对照验收标准评估
7. **返工循环** — 验收不通过的任务带具体反馈打回
8. **自动汇总** — 所有阶段完成后，PO 生成最终交付物

### 核心设计决策

| 决策 | 原因 |
|------|------|
| Hub 是纯状态机 | Hub 内不做 LLM 调用——确定性、可测试、快速 |
| PO Agent 做所有决策 | 规划、派发策略、质量门控——一个负责人 |
| 关键节点需人类确认 | 审批计划、关闭项目——人类始终有最终控制权 |
| 阶段感知派发 | 防止过早并行执行；尊重依赖链 |
| Runtime 健康门控 | 在线但无法执行的 agent 会被降级、冷却并绕开 |
| 交付物合同 | PPTX 等强输出要求会在 PO 验收前校验 |
| 可恢复规划 | PO 制定计划中断后可在项目详情页重新制定计划 |
| 执行边界 | Xiaok Desktop 种子 agent 必须走完整 Desktop agent runtime；KSwarm 只做项目管理，不伪装成 LLM worker |

---

## 功能特性

### 核心

- **结构化计划** — PO 分析目标，创建分阶段计划，含理由和验收标准
- **任务状态机** — `pending → dispatched → accepted → in_progress → submitted → done`，含返工循环
- **质量验收** — PO 读取产物内容（不只看文件名），评估实质性
- **阶段感知派发** — 只派发最早未完成阶段的任务；防止过早并行
- **能力感知路由** — 派发和失败重试会选择健康且具备任务/输出能力的 agent
- **Runtime Watchdog** — 通过 heartbeat、stdout/stderr telemetry 和 stale-run 检测避免 CLI 静默卡死
- **持久化动态工作流并行状态** — script-generated workflow 分支可以被分组、计数、checkpoint，并展示到 Desktop，而不是依赖 runtime 内存状态
- **交付物合同** — 显式 PPTX/HTML/Markdown 任务会在验收前校验产物类型
- **计划重试恢复** — PO 制定计划阶段中断的项目可安全重新启动规划
- **文件化 Handoff Package** — 任务上下文写入可持久化交接包，agent 从文件读取大段要求和上游产物
- **证据合同** — 本月/最近类调研任务可要求来源证据和当前日期基线，证据不足时不通过验收
- **正式交付文件** — 最终交付 alias 使用项目/目标生成的文件名，而不是内部 task ID
- **运行时边界约束** — KSwarm maintenance worker 只处理状态、日志、打包等项目管理工作，用户任务交给真正 agent 执行
- **持久化** — 生产状态使用按实体持久化的 SQLite，并支持旧 JSON 迁移；显式 JSON backend 保留给兼容场景和测试

### Web UI

- **看板** — 4 列看板（待处理 / 进行中 / 待审核 / 已完成）
- **计划视图** — 阶段进度、验收标准、每个任务的验收反馈
- **实时更新** — WebSocket 推送所有状态变更
- **产物预览** — 内联 Markdown/HTML/JSON 预览 + 下载
- **任务管理** — 取消任务、中途加任务、手动派发

### Agent 支持

- **多运行时** — Claude Code、Codex CLI、小K 或任何兼容 broker 的 agent
- **能力匹配** — 根据 agent 技能分配任务
- **健康监控** — 结合 runtime probe、心跳和配置的 watchdog 阈值识别停滞任务并触发恢复
- **并行执行** — 同一阶段内多个 agent 并行工作

---

## 快速开始

需要 Node.js ≥ 22.22.0、已运行的 Intent Broker，以及至少一个已配置且能通过健康探测的 agent runtime。以下各段均从 `kswarm` 仓库根目录执行；长期运行的进程使用独立终端。若由 Desktop 管理 sidecar，优先使用 Desktop 服务控制，避免重复启动。

安装依赖并启动 API（默认端口 4400）：

```bash
npm ci
npm run server
```

在另一终端启动独立 Web UI：

```bash
npm ci --prefix web
npm run dev --prefix web -- --port 5173
```

访问 http://localhost:5173。外部 CLI worker 可通过以下入口启动，参数替换为实际注册的 agent ID 和代号：

```bash
node scripts/auto-worker.js <agent-id> <alias>
```

KSwarm 本身不提供模型账号或模型推理；Desktop seed agent 由完整 Desktop runtime 执行。

---

## 使用方式

### 创建项目

在 Desktop 协作空间中明确目标、成员和产物要求，确认后创建项目。Room-first HTTP 创建需要受信任的 Desktop mutation 凭据、`requestSource: "user"`、Room 成员和源消息依据；旧 `/projects` 创建接口也要求凭据，不能用匿名 curl 绕过确认。

独立开发时可先只读检查服务与项目列表：

```bash
curl http://localhost:4400/health
curl http://localhost:4400/projects
```

具体请求合同以 [HTTP 路由](src/server/index.js) 为准。

### 项目生命周期

```
已创建 → [人类审批] → 进行中 → [任务执行] → 已交付 → [人类关闭] → 已关闭
```

### API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/projects` | GET | 列出所有项目 |
| `/projects` | POST | 受信任用户创建项目 |
| `/projects/room-first` | POST | 从已确认的协作空间与源消息创建项目 |
| `/projects/:id` | GET | 项目详情（任务、计划、产物） |
| `/projects/:id/approve` | POST | 审批项目（开始执行） |
| `/projects/:id/retry-plan` | POST | PO 制定计划中断或过期后重新触发规划 |
| `/projects/:id/plan` | POST | PO 提交结构化计划 |
| `/projects/:id/dispatch` | POST | 派发可用任务 |
| `/projects/:id/tasks/:taskId/review` | POST | PO 质量验收 |
| `/projects/:id/tasks/:taskId/done` | POST | 标记任务完成 |
| `/projects/:id/tasks/:taskId/cancel` | POST | 取消任务 |
| `/projects/:id/deliver` | POST | 提交最终交付物 |
| `/projects/:id/close` | POST | 人类关闭项目 |

---

## 配置

环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KSWARM_HOME` | `~/.kswarm` | 数据目录（状态、工作区、产物） |
| `BROKER_URL` | `http://127.0.0.1:4318` | Intent Broker 地址 |
| `PORT` | `4400` | API 服务端口 |

---

## 项目结构

```
kswarm/
├── src/
│   ├── core/
│   │   ├── hub.js           # 状态机 + 项目/任务管理
│   │   ├── task-board.js    # 任务状态机 + 转换
│   │   ├── persistence.js   # SQLite 持久化 + 旧 JSON adapter
│   │   └── event-log.js     # 事件日志
│   ├── server/
│   │   └── index.js         # HTTP API + WebSocket 服务
│   └── net/
│       └── broker-client.js  # Intent Broker WebSocket 客户端
├── scripts/
│   └── auto-worker.js       # PO + Worker agent 运行时，含 run telemetry
├── web/
│   └── src/                  # React + Tailwind 前端
├── test/                     # 单元测试 + 集成测试
└── package.json
```

---

## 依赖要求

- Node.js ≥ 22.22.0
- [Intent Broker](https://github.com/kaisersong/intent-broker) 在本地运行
- 至少一个 LLM 驱动的 agent（Claude Code、Codex CLI 等）

---

## 测试

```bash
npm test              # 默认场景套件
npm run test:all      # 完整单元/集成/E2E 回归套件
npm run test:e2e-p0   # P0 集成场景
```

---

## 版本历史

**v0.9.3** — Gate、evidence 与 artifact 流水线加固：canonical artifact/contract registry、默认拒绝的 evidence contract、reviewer independence、frozen final candidate、带认证的 CAS 写入，以及限制在工作区内的 artifact 路径。

**v0.9.2** — Desktop 派发 workflow 节点的上游 output 传递、字段清理与降级日志。

**v0.9.1** — PO review 与 workflow 恢复修复：PO 明确通过验收时，缺失 evidence 格式（verdict 字段）不再阻断任务；`handleContinueProject` 支持对 blocked script-generated workflow 使用 `resume_workflow` 策略，允许被阻塞的 workflow 解除阻塞并恢复执行，无需从头重跑。

**v0.9.0** — 并行调度与中断恢复：桌面 worker 并发数从 1 解锁为可配置上限（默认 3，范围 1-10，通过 `KSWARM_MAX_WORKER_INSTANCES` 环境变量或桌面端配置）；`suspendedAt` 任务标记实现优雅休眠/关机，唤醒后自动刷新 lease 恢复执行；`defer_recovery` 动作为尚未上线的 agent 提供 20 秒重连宽限；`systemSuspended` 标志在宿主休眠期间抑制 watchdog 与恢复逻辑；通过临时文件+重命名实现崩溃安全的原子状态持久化；卡住运行 watchdog 默认值提升至 5 分钟心跳超时和 20 分钟最大运行时间；新增 `/runtime/suspend` 和 `/runtime/resume` 端点供 Electron powerMonitor 集成；SIGTERM 优雅关机时标记所有活跃任务为 suspended 再退出。

**v0.8.0** — Swarm 执行边界与证据版本：Xiaok Desktop 种子 agent 任务改派到完整 Desktop agent runtime，不再由本地 auto-worker 执行；任务 handoff package 把大上下文和产物合同文件化；来源/证据合同校准本月、最近类调研验收；artifact-first 完成规则避免空产物摘要；最终交付物使用正式文件名和 delivery alias；失败/阻塞的历史 retry 子任务不再拖住项目交付。

**v0.7.0** — 可靠执行加固：runtime 探测与健康冷却、基于能力的派发/重试路由、带 heartbeat/stdout/stderr telemetry 的卡住运行 watchdog、PPTX/HTML/Markdown 强交付物合同、显式 PPTX 演示任务的确定性本地执行器兜底、active run 重启恢复，以及 PO 制定计划中断后的重试入口。

**v0.6.0** — Plan-Do 执行模式：结构化计划含阶段、质量验收读取产物内容、阶段感知派发、离线 worker 自动接管（PO 代执行）、返工循环、重启后持久化。

**v0.5.0** — Web UI：看板、计划视图、WebSocket 实时更新、产物预览、任务取消。

**v0.4.0** — 质量验收系统：PO 读取产物并对照验收标准评估；通过/不通过含反馈；返工循环。

**v0.3.0** — 持久化：项目数据在服务器重启后保留；防抖 JSON 状态文件。

**v0.2.0** — 接入真实 intent-broker；多 agent 派发；auto-worker 运行时。

**v0.1.0** — 初始原型：模板规划器、模拟派发、demo。

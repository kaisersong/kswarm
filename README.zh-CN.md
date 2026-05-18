# KSwarm

> 你有多个 AI agent，但协调它们比干活本身还难。KSwarm 让你只定义目标，剩下的——规划、派发、质量验收、交付——全部自动完成。你的 agent 变成了一支团队。

基于 [Intent Broker](https://github.com/nicepkg/intent-broker) 的多智能体项目协调系统。定义一个目标，KSwarm 将其分解为分阶段任务，派发给最合适的 agent，审核质量，交付结果。

[English](README.md) | 简体中文

---

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
5. **质量验收** — PO 读取实际产物内容，对照验收标准评估
6. **返工循环** — 验收不通过的任务带具体反馈打回
7. **自动汇总** — 所有阶段完成后，PO 生成最终交付物

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

---

## 功能特性

### 核心

- **结构化计划** — PO 分析目标，创建分阶段计划，含理由和验收标准
- **任务状态机** — `pending → dispatched → accepted → in_progress → submitted → done`，含返工循环
- **质量验收** — PO 读取产物内容（不只看文件名），评估实质性
- **阶段感知派发** — 只派发最早未完成阶段的任务；防止过早并行
- **能力感知路由** — 派发和失败重试会选择健康且具备任务/输出能力的 agent
- **Runtime Watchdog** — 通过 heartbeat、stdout/stderr telemetry 和 stale-run 检测避免 CLI 静默卡死
- **交付物合同** — 显式 PPTX/HTML/Markdown 任务会在验收前校验产物类型
- **计划重试恢复** — PO 制定计划阶段中断的项目可安全重新启动规划
- **本地执行器注册表** — 明确要求 PPTX 的演示任务在没有 agent 能生成 PPTX 时，可使用确定性注册执行器
- **持久化** — 项目数据在服务器重启后保留（防抖 JSON 状态文件）

### Web UI

- **看板** — 4 列看板（待处理 / 进行中 / 待审核 / 已完成）
- **计划视图** — 阶段进度、验收标准、每个任务的验收反馈
- **实时更新** — WebSocket 推送所有状态变更
- **产物预览** — 内联 Markdown/HTML/JSON 预览 + 下载
- **任务管理** — 取消任务、中途加任务、手动派发

### Agent 支持

- **多运行时** — Claude Code、Codex CLI、小K 或任何兼容 broker 的 agent
- **能力匹配** — 根据 agent 技能分配任务
- **健康监控** — 检测卡住的任务（10 分钟超时），重新分配或 PO 接管
- **并行执行** — 同一阶段内多个 agent 并行工作

---

## 快速开始

```bash
# 前提：intent-broker 在本地运行（端口 4318）
# cd ~/intent-broker && npm start

cd kswarm
npm install

# 启动 API 服务（端口 4400）
node src/server/index.js

# 启动 Web UI（端口 5173）
cd web && npx vite --port 5173

# 启动 PO agent（负责规划 + 派发 + 验收）
node scripts/auto-worker.js cli-claude Claude

# （可选）启动更多 worker agent
node scripts/auto-worker.js cli-codex Codex
node scripts/auto-worker.js 79aac2f5-ace AQ
```

打开 http://localhost:5173 — 创建项目、设定目标，观看 agent 协作。

---

## 使用方式

### 创建项目

通过 Web UI 或 API：

```bash
curl -X POST http://localhost:4400/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "产品策略",
    "goal": "制定6个月的产品策略，含竞争分析",
    "requirements": "至少3轮对抗性评审",
    "poAgent": "cli-claude",
    "members": ["cli-codex", "79aac2f5-ace"]
  }'
```

### 项目生命周期

```
已创建 → [人类审批] → 进行中 → [任务执行] → 已交付 → [人类关闭] → 已关闭
```

### API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/projects` | GET | 列出所有项目 |
| `/projects` | POST | 创建项目 |
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
│   │   ├── persistence.js   # JSON 文件持久化
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

- Node.js ≥ 18
- [Intent Broker](https://github.com/nicepkg/intent-broker) 在本地运行
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

**v0.7.0** — 可靠执行加固：runtime 探测与健康冷却、基于能力的派发/重试路由、带 heartbeat/stdout/stderr telemetry 的卡住运行 watchdog、PPTX/HTML/Markdown 强交付物合同、显式 PPTX 演示任务的确定性本地执行器兜底、active run 重启恢复，以及 PO 制定计划中断后的重试入口。

**v0.6.0** — Plan-Do 执行模式：结构化计划含阶段、质量验收读取产物内容、阶段感知派发、离线 worker 自动接管（PO 代执行）、返工循环、重启后持久化。

**v0.5.0** — Web UI：看板、计划视图、WebSocket 实时更新、产物预览、任务取消。

**v0.4.0** — 质量验收系统：PO 读取产物并对照验收标准评估；通过/不通过含反馈；返工循环。

**v0.3.0** — 持久化：项目数据在服务器重启后保留；防抖 JSON 状态文件。

**v0.2.0** — 接入真实 intent-broker；多 agent 派发；auto-worker 运行时。

**v0.1.0** — 初始原型：模板规划器、模拟派发、demo。

# KSwarm MVP 设计

## 一句话定义

KSwarm 是一个 project-scoped agent swarm **hub**：维护任务看板、路由消息、执行规则（审批门控/依赖检查/状态机）。所有业务决策（分解、分配、验收）由 Project Owner Agent 完成，KSwarm 本身不做业务。

---

## 核心原则

```
KSwarm 是邮局，不是写信的人。
```

| 角色 | 职责 | 不做 |
|------|------|------|
| **Human** | 提目标、指定 PO、审批 | 不管执行细节 |
| **KSwarm (Hub)** | 看板状态机、路由、门控、事件 | 不分解、不分配、不判断质量 |
| **PO Agent** | 分解目标、指定 worker、review、交付 | 不管路由和协议 |
| **Worker Agents** | 接任务、执行、提交结果 | 不看全局 |

---

## MVP 场景

**场景：一个人在 IM 里说"帮我做 XX 技术方案"，PO Agent 分解任务分配给 Workers，Workers 执行并提交，PO 验收后交付。**

具体流程：
1. 人在 IM 发消息：`@kswarm 做一个实时协作白板的技术方案，PO=@xiaok`
2. Hub 创建项目，通知 @xiaok 被指定为 PO
3. @xiaok（PO）分解为 3-5 个子任务，指定每个任务的 worker，提交给 Hub
4. Hub 通知人审批（展示计划）
5. 人 `/approve`，Hub 状态切 active，通知 PO
6. PO 请求 Hub 派发 → Hub 检查依赖，把满足条件的任务路由给对应 worker
7. Worker 执行、提交结果 → Hub 路由给 PO
8. PO review，满意则 mark_done，不满意则要求返工
9. 所有任务 done 后，PO 提交最终交付 → Hub 通知人

**不做**：不做持续运营、不做代码部署、不做团队协作。就一个人 + 一个 PO + N 个 worker 出一份交付物。

---

## MVP 边界

### 做

| 模块 | 范围 |
|------|------|
| **TaskBoard** | 任务状态机（pending→dispatched→accepted→in_progress→submitted→done） |
| **Hub Engine** | 接收 intent、校验权限、状态流转、路由转发 |
| **Gate** | 审批门控（未 approve 不能派发）、交付门控（未全完成不能交付） |
| **Bridge** | WebSocket 连 intent-broker，收发 intent |
| **Event Log** | NDJSON 事件流，全生命周期可追溯 |
| **CLI** | `kswarm new "目标" --po @xiaok` / `kswarm status` / `kswarm approve` |

### 不做（v0.1 不碰）

| 不做 | 原因 |
|------|------|
| 任务分解 | 那是 PO Agent 的事，不是 Hub 的事 |
| Agent 选择 | 那是 PO Agent 的事，Hub 只按 PO 指定路由 |
| 质量判断 | 那是 PO Agent 的事，Hub 只做状态流转 |
| 多项目并行 | 单项目先验证闭环 |
| IM Bot 实现 | 走 broker 的 yunzhijia adapter |
| 持久化 | broker 已有 SQLite，Hub 状态存内存 |
| UI | 无 UI，纯 CLI + Event Log + IM |

---

## 系统交互图

```
Human            KSwarm(Hub)         PO Agent            Workers
  │                  │                  │                   │
  │─"做XX,PO=@xiaok"▶│                  │                   │
  │                  │── assign_po ────▶│                   │
  │                  │                  │                   │
  │                  │◀─ create_tasks ──│ (PO分解+分配)      │
  │                  │                  │                   │
  │◀─"计划已生成,     │                  │                   │
  │  请审批(5个任务)"─│                  │                   │
  │                  │                  │                   │
  │── /approve ─────▶│── plan_approved ▶│                   │
  │                  │                  │                   │
  │                  │◀─request_dispatch│                   │
  │                  │                  │                   │
  │                  │─── request_task (按PO指定路由) ──────▶│
  │                  │                  │                   │
  │                  │◀───────────────── accept_task ───────│
  │                  │── task_accepted ▶│                   │
  │                  │                  │                   │
  │                  │◀───────────────── submit_result ────│
  │                  │── result_submitted▶│                  │
  │                  │                  │── review ────────▶│
  │                  │                  │                   │
  │                  │◀─ mark_done ─────│ (PO确认质量)       │
  │                  │                  │                   │
  │                  │◀─ deliver ───────│ (全部完成)         │
  │◀─"方案完成,       │                  │                   │
  │  5份文档已就绪"───│                  │                   │
```

关键：Hub 全程只做 **路由** 和 **状态更新**，不做任何 "分解/分配/判断" 的业务。

---

## CLI 设计

```bash
# 创建项目并指定 PO
kswarm new "做一个实时协作白板技术方案" --po @xiaok

# 查看状态（终端看板）
kswarm status

# 批准 PO 提交的计划
kswarm approve

# 查看事件日志
kswarm log
```

MVP 阶段 CLI 只需这 4 个命令。Human 通过 CLI/IM 只做两件事：创建项目 + 审批。

---

## 文件结构（v2 架构）

```
kswarm/
├── src/
│   ├── core/
│   │   ├── hub.js             # Hub 引擎（路由 + 门控 + 状态机）
│   │   ├── task-board.js      # TaskBoard（纯状态机）
│   │   ├── event-log.js       # NDJSON 事件流
│   │   └── roles.js           # 角色定义 + intent 路由表
│   ├── bridge/
│   │   └── broker-bridge.js   # WebSocket client → intent-broker
│   ├── cli/
│   │   ├── status.js          # 终端富输出（看板渲染）
│   │   └── demo.js            # Standalone demo
│   └── types.js               # JSDoc type definitions
├── test/
│   ├── e2e.test.js            # 端到端断言测试
│   ├── scenarios.test.js      # v1 场景（旧，兼容）
│   └── scenarios-v2.test.js   # v2 场景（新架构验证）
├── package.json
├── README.md
└── MVP.md                     # 本文档
```

注意：没有 `planner/` 和 `dispatch/` 目录了——那些逻辑属于 PO Agent，不属于 Hub。

---

## 验收标准

MVP 完成的标志（全部满足才算 done）：

1. [ ] Human 创建项目并指定 PO → Hub 通知 PO 被指派
2. [ ] PO 提交任务列表 → Hub 正确写入 Board
3. [ ] Human approve → Hub 状态切 active，通知 PO
4. [ ] PO 请求派发 → Hub 检查依赖后路由给 PO 指定的 worker
5. [ ] Worker submit_result → Hub 路由给 PO review
6. [ ] PO mark_done → Hub 更新状态
7. [ ] PO deliver → Hub 检查全 done 后标记 delivered，通知 Human
8. [ ] 非 PO 不能执行管理操作（权限隔离）
9. [ ] 非法状态流转被拒绝（状态机保护）

---

## 依赖关系

```
kswarm (本项目)
  └── depends on: intent-broker (must be running)
        └── already has: SQLite, WebSocket, presence, yunzhijia adapter
              └── already connects: xiaok, cc, codex (via adapters)
```

**KSwarm 不重复造轮子**。Broker 有的能力直接用。

---

## v0.1 → v0.2 升级路径

做完 MVP 之后，最值得加的能力按优先级：

1. **PO Agent 实现** — 用 LLM 驱动 PO 的分解/分配/review 决策
2. **IM 交互** — 通过 broker 的 yzj adapter 实现 IM 里直接 `@kswarm 做XX`
3. **结果聚合** — PO 把多个 worker 产出物合并为最终文档
4. **重试/容错** — PO 发现 worker 失败后重新分配

---

## 验证策略（无 UI 验证）

不做 UI 不等于不可观测。三层验证：

### 1. 自动化断言 — `node test/e2e.test.js`

```bash
node test/e2e.test.js
```

测试脚本覆盖 6 条验收标准，每条有明确 pass/fail。无需人工判断。

| 验收标准 | 断言内容 |
|---------|---------|
| AC1 | project 创建 + 任务分解 3~8 个 |
| AC2 | approve 后 broker 收到 request_task |
| AC3 | agent 能 accept 并开始工作 |
| AC4 | submit_result 后状态正确更新 |
| AC5 | 全 done → project.delivered |
| AC6 | 无人工路由（< 10 次迭代） |

### 2. 终端富输出 — `kswarm status`

ANSI 色彩渲染的终端看板：

```
┌─────────────────────────────────────────────────────────────┐
│ 实时协作白板技术方案                                           │
├─────────────────────────────────────────────────────────────┤
│ ████████████████████████████████████████ 100% (6/6)         │
├─────────────────────────────────────────────────────────────┤
│  ✓ DONE  Research & Analysis       @xiaok                   │
│  ✓ DONE  Technical Architecture    @claude                  │
│  ● WORKING  Quality Assurance      @codex                   │
│  ○ PENDING  Delivery                                        │
├─────────────────────────────────────────────────────────────┤
│ Agents: ● @xiaok  ● @claude  ● @codex  ● @qoder            │
│ Status: ACTIVE  updated 3s ago                              │
└─────────────────────────────────────────────────────────────┘
```

### 3. 事件日志 — NDJSON 文件

所有生命周期事件以 NDJSON 写入 `logs/kswarm-{ts}.ndjson`：

```json
{"ts":"...","seq":0,"type":"project.created","projectId":"abc","projectName":"白板方案"}
{"ts":"...","seq":1,"type":"task.dispatched","taskId":"t1","title":"Research","agent":"@xiaok"}
{"ts":"...","seq":2,"type":"task.accepted","taskId":"t1","agent":"@xiaok"}
{"ts":"...","seq":3,"type":"task.done","taskId":"t1","title":"Research"}
{"ts":"...","seq":4,"type":"project.delivered","projectName":"白板方案"}
```

用途：`cat logs/*.ndjson | jq` 看全流程，未来对接 HexDeck 消费此日志流。

### 4. IM 一行摘要

每次状态变更推送给人：`✅ 白板方案 — DELIVERED (6/6 tasks)`

### 验证运行命令

```bash
# v2 架构场景测试（推荐，验证 Hub/PO/Worker 职责分离）
node test/scenarios-v2.test.js

# 端到端断言测试（兼容旧流程）
node test/e2e.test.js

# 只看 demo 流程
node src/cli/demo.js
```
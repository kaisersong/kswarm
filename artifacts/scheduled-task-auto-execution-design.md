# [PM 需求] 定时任务默认改为允许自动执行 — 方案设计

> 项目：KSwarm  
> 日期：2026-06-03  
> 作者：xiaok (技术智能体)  
> 版本：v1.0

---

## 1. 需求分析

### 1.1 当前状态

KSwarm 现有项目执行流程：

```
Human 创建项目 → PO 自动规划 → Human 审批(approve) → PO 派发(dispatch) → Workers 执行 → PO 确认 → Human 关闭
```

关键门控点：

| 阶段 | 控制者 | 自动化程度 |
|------|--------|-----------|
| 创建项目 | Human | 手动 |
| PO 制定计划 | PO Agent | 自动 (`autoStartPlanning` 默认 true) |
| **审批计划** | **Human** | **必须手动点击"审批"** |
| 派发任务 | PO | 自动（approve 后 PO 可自动 dispatch） |
| 确认完成 | PO | 自动 |
| 关闭项目 | Human | 手动 |

**当前问题**：
- 所有项目必须 Human 手动审批才能进入执行阶段，无法支持"定时触发、无人值守"的场景
- `executionMode='auto'` 枚举已定义但无实际语义差异——它和 `'direct'` 行为完全一致
- 缺乏 cron/schedule 模型，无法让项目按时间周期自动创建和运行

### 1.2 需求解读

本需求包含两层含义：

> **第一层**：新增「定时任务」能力——用户可以创建一个会周期性自动触发的项目（如每天早上 9 点生成日报），到达触发时间后，项目自动创建、规划、审批、派发、执行，无需人工介入。

> **第二层**：「默认允许自动执行」——当用户创建一个定时任务时，默认 `autoApprove=true`，跳过 Human 审批门控。同时，现有的 `executionMode='auto'` 也应获得真正的语义：创建项目时如果指定 `executionMode='auto'`，且 `autoApprove=true`，则 PO 完成规划后自动激活项目。

### 1.3 核心用例

| 场景 | 描述 | 调度需求 |
|------|------|---------|
| 日报生成 | 每个工作日 18:00 生成当日工作总结 | `0 18 * * 1-5` |
| 竞品监控 | 每周一 9:00 抓取竞品动态并分析 | `0 9 * * 1` |
| 数据看板 | 每小时更新一次关键指标 | `0 * * * *` |
| 代码质量扫描 | 每次 push 后触发（webhook 触发） | 事件触发（非 cron） |
| 一次性延迟任务 | 30 分钟后生成会议纪要 | `once`, delay 1800s |

---

## 2. 方案设计

### 2.1 核心架构

新增两个核心模块：

```
kswarm/
├── src/
│   ├── core/
│   │   ├── hub.js                    # 修改：支持 autoApprove 逻辑
│   │   ├── schedule-store.js         # 新增：定时任务持久化存储
│   │   └── schedule-engine.js        # 新增：定时触发器引擎
│   └── server/
│       └── index.js                  # 修改：新增 /schedules CRUD API
└── web/
    └── src/
        └── components/
            └── projects/
                ├── CreateProjectModal.jsx    # 修改：新增定时任务配置区
                ├── ScheduleList.jsx          # 新增：定时任务列表页
                └── ScheduleEditModal.jsx     # 新增：编辑定时配置弹窗
```

### 2.2 数据模型

#### 2.2.1 Schedule 实体

```javascript
// src/core/schedule-store.js
const Schedule = {
  id: "sch_abc123",                    // 唯一 ID，UUID v7
  name: "每日日报",                     // 定时任务名称
  description: "每个工作日生成工作日报",   // 描述
  
  // 项目模板 —— 每次触发时以此为模板创建新项目
  projectTemplate: {
    name: "日报 {date}",
    goal: "生成本日工作总结报告",
    requirements: "基于 Zulip 日志...",
    poAgent: "xiaok",
    members: ["claude-code"],
    executionMode: "auto",            // 默认为 auto
    autoApprove: true,                // 默认 true — 不等待人工审批
    workFolder: "~/kswarm-reports/daily"
  },
  
  // 时间策略
  schedule: {
    type: "cron",                     // "cron" | "interval" | "once"
    cron: "0 18 * * 1-5",            // cron 表达式（type=cron 时）
    interval: null,                   // 间隔秒数（type=interval 时）
    timezone: "Asia/Shanghai",        // 时区
    startAt: "2026-06-04T00:00:00Z", // 开始时间
    endAt: null,                      // 可选：结束时间
    maxRuns: null,                    // 可选：最大执行次数
    lastTriggeredAt: null,            // 最近一次触发时间
    nextTriggerAt: null,              // 下一次触发时间（预计算）
    missedPolicy: "skip",             // 错过策略："skip" | "catch_up" | "fire_once"
  },
  
  // 状态与统计
  status: "active",                   // "active" | "paused" | "completed" | "disabled"
  runCount: 0,                        // 已执行次数
  lastRunId: null,                    // 最近一次触发的 projectId
  lastRunStatus: null,                // "success" | "failed" | "partial"
  
  // 自动审批配置
  autoExecution: {
    autoApprove: true,                // 默认 true：PO 规划完成后自动审批
    autoDispatch: true,               // approve 后自动派发
    autoDeliver: false,               // 默认 false：所有任务完成后自动交付
    autoClose: false,                 // 默认 false：交付后自动关闭
  },
  
  // 失败处理
  failurePolicy: {
    maxRetries: 2,                    // 失败重试次数
    retryDelay: 300,                  // 重试延迟（秒）
    onFailure: "notify",              // "notify" | "skip" | "retry"
    notifyChannel: null,              // 通知渠道
  },
  
  // 元数据
  createdBy: "human",
  createdAt: "2026-06-03T12:00:00Z",
  updatedAt: "2026-06-03T12:00:00Z",
  tags: ["report", "daily"],
};
```

#### 2.2.2 Project 扩展字段

```javascript
// 现有 Project 实体新增字段
Project {
  // ...现有字段
  
  // 新增：如果此项目由定时任务触发，关联 schedule 信息
  scheduleId: null,          // 来源 Schedule.id
  scheduleRunIndex: null,    // 第几次触发（从 1 开始）
  
  // 新增：自动执行策略（覆盖项目级别的心智模型）
  autoExecution: {
    autoApprove: false,      // PO 规划完成后是否自动 approval
    autoDispatch: true,      // approve 后是否自动 dispatch（现有行为 already）
    autoDeliver: false,
    autoClose: false,
  },
  
  // 修改：executionMode 新增语义
  // "direct"            — 标准模式，需 Human 审批
  // "auto"              — 🆕 自动模式：如果 autoApprove=true 则全自动执行
  // "workflow_preferred" — 维持现有语义
}
```

#### 2.2.3 执行模式语义表

| 字段组合 | Human 审批 | 行为 |
|---------|-----------|------|
| `executionMode='direct'`, `autoApprove=false` | **需要** | 现有标准流程 |
| `executionMode='direct'`, `autoApprove=true` | **不需要** | PO 规划完→项目自动 active→PO 自动 dispatch |
| `executionMode='auto'`, `autoApprove=false` | **需要** | 等价 direct（向后兼容）|
| `executionMode='auto'`, `autoApprove=true` | **不需要** | 全自动执行（定时任务默认） |

### 2.3 Schedule Engine 设计

```javascript
// src/core/schedule-engine.js
//
// 调度引擎：
// 1. 每秒 tick 检查所有 active schedule
// 2. 根据 cron/interval 判断是否该触发
// 3. 触发时：创建项目 → 等待 PO 规划 → auto approve → dispatch
// 4. 处理错过、失败重试等边界情况

function createScheduleEngine({ hub, persistence, eventLog, brokerClient }) {
  let timer = null;
  const schedules = new Map();
  let tickInterval = 1000; // 1 秒精度

  // 从持久化恢复 schedules
  function restore(loadedSchedules) { ... }

  // 核心 tick 循环
  function tick() {
    const now = new Date();
    for (const [id, schedule] of schedules) {
      if (schedule.status !== 'active') continue;
      if (shouldTrigger(schedule, now)) {
        triggerSchedule(schedule, now);
      }
    }
  }

  // 判断是否该触发
  function shouldTrigger(schedule, now) {
    const next = schedule.schedule.nextTriggerAt;
    if (!next || new Date(next) > now) return false;
    return true;
  }

  // 触发定时任务 —— 创建项目实例
  async function triggerSchedule(schedule, triggeredAt) {
    const projectId = createProjectInstanceId();
    const projectName = resolveTemplate(schedule.projectTemplate.name, triggeredAt);
    
    const project = hub.createProject({
      id: projectId,
      name: projectName,
      ...schedule.projectTemplate,
      executionMode: "auto",
      autoApprove: schedule.autoExecution.autoApprove !== false,
      scheduleId: schedule.id,
      scheduleRunIndex: schedule.runCount + 1,
    });

    // 更新 schedule 统计
    schedule.runCount++;
    schedule.lastTriggeredAt = triggeredAt.toISOString();
    schedule.lastRunId = projectId;
    schedule.lastRunStatus = 'running';
    schedule.schedule.nextTriggerAt = computeNextTrigger(schedule);
    
    // 自动审批前需要等待 PO 完成规划
    // 机制：监听 hub event 'po.assigned' + 'tasks.created'，然后自动调用 handleApprove
    await waitForPoPlanning(projectId, schedule);
    
    persistence.save();
  }

  // 等待 PO 完成规划，然后自动审批
  async function waitForPoPlanning(projectId, schedule) {
    const maxWaitMs = schedule.failurePolicy.retryDelay * 1000 || 5 * 60 * 1000;
    // 轮询检查 project plan 是否就绪
    for (let elapsed = 0; elapsed < maxWaitMs; elapsed += 2000) {
      await sleep(2000);
      const project = hub.getProject(projectId);
      if (project?.plan) {
        // 自动审批
        hub.handleApprove(projectId);
        // 自动 dispatch
        hub.handleRequestDispatch(projectId, project.poAgent);
        return;
      }
    }
    // 超时处理
    handleScheduleFailure(schedule, projectId, 'po_planning_timeout');
  }

  return { start, stop, restore, addSchedule, updateSchedule, removeSchedule, getSchedules };
}
```

### 2.4 Hub 修改点

#### 2.4.1 `createProject` 扩展

```javascript
function createProject({ ..., autoApprove = false, scheduleId = null, scheduleRunIndex = null }) {
  // ...existing fields...
  project.autoExecution = {
    autoApprove: Boolean(autoApprove),
    autoDispatch: true,
    autoDeliver: false,
    autoClose: false,
  };
  project.scheduleId = scheduleId || null;
  project.scheduleRunIndex = scheduleRunIndex || null;
  // ...
}
```

#### 2.4.2 自动审批钩子

在 PO 提交 plan/tasks 后，Hub 自动检查：

```javascript
// 在 handleCreateTasks 完成后增加自动审批逻辑
function handleCreateTasks(projectId, taskList, fromAgent) {
  // ... existing task creation logic ...

  // 自动审批检查
  const project = projects.get(projectId);
  if (project.autoExecution?.autoApprove && project.status !== 'active') {
    const approveResult = handleApprove(projectId);
    if (approveResult.ok) {
      eventLog.emit('project.auto_approved', { projectId, reason: 'auto_execution' });
      // 自动派发
      const dispatchResult = handleRequestDispatch(projectId, project.poAgent);
      eventLog.emit('project.auto_dispatched', { projectId, dispatchCount: dispatchResult.dispatched.length });
    }
  }
}
```

---

## 3. API 设计

### 3.1 Schedule CRUD

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/schedules` | 列出所有定时任务 |
| `POST` | `/api/schedules` | 创建定时任务 |
| `GET` | `/api/schedules/:id` | 获取定时任务详情 |
| `PUT` | `/api/schedules/:id` | 更新定时任务配置 |
| `DELETE` | `/api/schedules/:id` | 删除定时任务 |
| `POST` | `/api/schedules/:id/pause` | 暂停 |
| `POST` | `/api/schedules/:id/resume` | 恢复 |
| `POST` | `/api/schedules/:id/trigger` | 手动触发一次 |
| `GET` | `/api/schedules/:id/runs` | 查看历史执行记录 |

### 3.2 创建定时任务请求体

```json
POST /api/schedules
{
  "name": "每日日报",
  "description": "每个工作日生成工作日报",
  "projectTemplate": {
    "goal": "生成本日工作总结报告",
    "requirements": "基于 Zulip 日志...",
    "poAgent": "xiaok",
    "members": ["claude-code"]
  },
  "schedule": {
    "type": "cron",
    "cron": "0 18 * * 1-5",
    "timezone": "Asia/Shanghai"
  },
  "autoExecution": {
    "autoApprove": true,
    "autoDispatch": true
  }
}
```

### 3.3 修改现有 API

```json
POST /api/projects
{
  "name": "竞品分析",
  "goal": "...",
  "poAgent": "xiaok",
  "executionMode": "auto",      // 🆕 支持 auto 模式
  "autoApprove": true            // 🆕 允许跳过 Human 审批
}
```

---

## 4. 前端设计

### 4.1 创建项目弹窗 — 新增「定时执行」区块

在 `CreateProjectModal.jsx` 中新增一个 tab/toggle：

```
┌─────────────────────────────────────────┐
│  新建项目                         [×]    │
├─────────────────────────────────────────┤
│  项目名称  [________________]            │
│  目标      [________________]            │
│  ...                                     │
│                                          │
│  ── 定时执行 (可选) ──────────────────   │
│  ☐ 启用定时执行                          │
│    执行周期: [每天 ▼] [18:00]           │
│    时区:     [Asia/Shanghai ▼]          │
│    ☑ 自动审批（跳过人工确认）            │
│    ☐ 自动关闭（完成后自动关闭项目）       │
│    失败策略: [跳过本次 ▼]               │
│                                          │
│  [取消]             [创建并启用]         │
└─────────────────────────────────────────┘
```

### 4.2 定时任务列表页

新增 `ScheduleList.jsx` 页面：

```
┌──────────────────────────────────────────────────┐
│  定时任务                           [+ 新建定时任务] │
├──────────────────────────────────────────────────┤
│  ● 每日工作日报         每天 18:00         已运行 23 次 │
│    下次触发: 2026-06-04 18:00  |  最近: 成功       │
│    [暂停] [立即执行] [编辑]                         │
│                                                   │
│  ○ 每周竞品监控         周一 09:00          已暂停  │
│    [恢复] [编辑] [删除]                             │
│                                                   │
│  ● 数据看板更新         每小时              已运行 156 次 │
│    下次触发: 2026-06-03 15:00                    │
└──────────────────────────────────────────────────┘
```

---

## 5. 里程碑时间线

| 阶段 | 内容 | 预估工作量 | 交付物 |
|------|------|-----------|--------|
| **M1: 数据模型** | Schedule 实体定义、持久化、store | 2 天 | `schedule-store.js`、测试 |
| **M2: Schedule Engine** | tick 循环、cron 解析、触发逻辑 | 3 天 | `schedule-engine.js`、测试 |
| **M3: Hub 自动审批** | autoApprove 钩子、auto dispatch | 2 天 | hub.js 修改、测试 |
| **M4: API 层** | Schedule CRUD、项目 API 扩展 | 2 天 | server/index.js API 路由 |
| **M5: 前端** | 创建项目集成、ScheduleList 页面 | 3 天 | 新组件、i18n |
| **M6: 集成测试** | E2E 定时触发→执行→交付闭环 | 2 天 | E2E 测试 |
| **M7: 文档** | README、API 文档更新 | 1 天 | 文档更新 |

**总计预估：15 个工作日**（约 3 周，单人开发）

---

## 6. 风险分析

### 风险 1：cron 解析精度与时区

- **问题**：Node.js 原生不支持 cron，需要引入 `cron-parser` 或 `node-cron` 库；时区转换容易出错
- **缓解**：使用成熟的 `cron-parser` 库（npm 周下载 200 万+），所有时间统一用 UTC 存储，前端展示时转本地时区
- **后备**：如果 cron-parser 引入有问题，先用 `setInterval` 实现 `interval` 模式，cron 模式延期到 v2

### 风险 2：Server 重启导致定时任务丢失触发

- **问题**：Schedule Engine 在内存中运行，server 重启后可能错过触发窗口
- **缓解**：startup 时 quick-scan 所有 active schedule，计算 `nextTriggerAt`，对已错过的按 `missedPolicy` 处理（默认 `skip`）
- **重要**：持久化 schedule 状态到 disk（利用现有 persistence 框架），每次触发后立即写盘

### 风险 3：PO 规划超时导致自动审批无法进行

- **问题**：定时任务触发后创建了项目，PO 如果卡住（LLM 超时、broker 断连），自动审批无法触发
- **缓解**：
  - `waitForPoPlanning()` 设置超时（默认 5 分钟）
  - 超时后标记 schedule.lastRunStatus='failed'，触发 failurePolicy
  - 失败后按 `onFailure` 策略处理（notify/retry/skip）
- **后备**：超时后的项目保留为 `planning` 状态，Humann 可在 UI 中手动审批或重试

### 风险 4：定时任务大量并发触发

- **问题**：如果有 10+ 个 schedule 同时触发，会创建 10+ 个并发项目，可能导致 broker/LLM 拥塞
- **缓解**：
  - schedule engine 内部加并发限制（默认最大同时触发 3 个项目）
  - 超过并发上限的 schedule 排队，按触发时间顺序依次启动
  - server 级别已有 `effectiveAgentConcurrency` 机制保护 worker agent

### 风险 5：autoApprove 默认值变更的向后兼容性

- **问题**：如果 API 默认把 `autoApprove` 改为 `true`，现有调用方（如 cli/desktop）可能意外触发自动审批
- **缓解**：
  - API 层面：仅当 `executionMode='auto'` 时默认 `autoApprove=true`，`executionMode='direct'`（默认值）时 `autoApprove` 保持 `false`
  - 即：只对显式声明要自动执行的项目自动审批，不影响现有流程
  - 定时任务创建时默认 `executionMode='auto'`

### 风险 6：依赖第三方 cron 库的稳定性

- **问题**：引入 `cron-parser` 增加外部依赖
- **缓解**：`cron-parser` 是轻量库（零依赖），API 稳定
- **替代方案**：如不允许外部依赖，可自实现简易 cron 解析（仅支持分钟、小时、星期三个字段），覆盖 80% 用例

---

## 7. 关键决策点（需要 PM 确认）

1. **默认执行模式**：定时任务的 `autoExecution.autoApprove` 默认 `true`（跳过审批），是否接受？
2. **自动关闭**：全自动流程是否需要 `autoClose=true`（所有任务 done 后自动关闭项目）？还是保留人工关闭为最后一步？
3. **失败通知**：定时任务失败后，通知方式选什么？Web UI 内的 bell icon 还是 external channel（Zulip/邮件）？
4. **定时粒度**：最小支持到分钟级（cron 秒级）还是小时级就够？
5. **并发上限**：最多同时执行几个定时任务？建议默认 3。

---

## 8. 实现入口

推荐实现顺序：

```
Phase 0: 当前文档评审 + 决策确认 (PM)
Phase 1: Schedule 数据模型 + 持久化 (schedule-store.js)
Phase 2: Schedule Engine 核心 tick 循环 + cron 解析
Phase 3: Hub autoApprove 钩子 + 全自动流程
Phase 4: Schedule CRUD API + 项目 API 扩展
Phase 5: 前端组件 (ScheduleList + CreateProjectModal 改造)
Phase 6: E2E 测试全覆盖
Phase 7: 文档 + changelog
```

---

## 附录 A：cron 表达式示例

| 表达式 | 含义 |
|--------|------|
| `0 9 * * *` | 每天 9:00 |
| `0 18 * * 1-5` | 工作日 18:00 |
| `0 9 * * 1` | 每周一 9:00 |
| `0 0 1 * *` | 每月 1 号 0:00 |
| `0 */2 * * *` | 每 2 小时 |

## 附录 B：文件影响范围

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/core/schedule-store.js` | **新增** | Schedule 实体 CRUD + 持久化 |
| `src/core/schedule-engine.js` | **新增** | 定时触发引擎 |
| `src/core/hub.js` | 修改 | createProject 扩展 + autoApprove 钩子 |
| `src/server/index.js` | 修改 | /schedules API 路由 + 启动 schedule engine |
| `src/server/auto-worker-process.js` | 无变更 | 不受影响 |
| `web/src/hooks/useKSwarm.js` | 修改 | 新增 schedule API 封装 |
| `web/src/components/projects/CreateProjectModal.jsx` | 修改 | 新增定时配置区 |
| `web/src/components/projects/ScheduleList.jsx` | **新增** | 定时任务列表 |
| `web/src/components/projects/ScheduleEditModal.jsx` | **新增** | 编辑弹窗 |
| `web/src/i18n/zh.json` | 修改 | 国际化 string |
| `web/src/i18n/en.json` | 修改 | 国际化 string |
| `package.json` | 修改 | 新增 `cron-parser` 依赖 |

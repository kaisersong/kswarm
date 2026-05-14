# KSwarm 项目状态总结

## 当前可运行状态

所有服务链路已验证通过：
- **Intent Broker**: `cd ~/projects/intent-broker && npm start` → port 4318
- **KSwarm Server**: `cd ~/projects/kswarm && node src/server/index.js` → port 4400
- **Auto Workers**: `node scripts/auto-worker.js auto-worker-1 Bot-Alpha` & `node scripts/auto-worker.js auto-worker-2 Bot-Beta`
- **Vite Dev Server**: `cd web && npx vite --port 5188` → port 5188

## 架构

```
Human (Web UI :5188)
  ↓ REST API
KSwarm Server (:4400)  ←→  Intent Broker (:4318)  ←→  Auto Workers
  ↓                                                      ↑
Hub (hub.js)                                        broker-client.js
```

角色模型: Human > PO > Worker
- Human: 创建项目、审批、添加任务、关闭项目
- PO: 自动分解目标、派发任务、确认完成
- Worker: 执行任务、生成 artifact

## 已完成功能

1. **完整项目生命周期**: 创建→PO自动规划→Human审批→自动dispatch→Workers执行→PO自动confirm→Human关闭
2. **Per-project workspace**: `~/.kswarm/projects/<id>/artifacts/` 自动创建，支持自定义路径
3. **真实 artifact 存储**: Workers 产出 markdown 报告，按项目隔离存储
4. **i18n**: 中/英文切换，跟随系统
5. **Kanban board**: 5列看板 (Pending/Dispatched/In Progress/Review/Done)
6. **Activity Timeline**: 完整事件时间线，显示 who/what/when
7. **Artifact Preview**: 点击可预览 MD/HTML/TXT，其他格式可下载
8. **工作目录选择器**: showDirectoryPicker() 浏览器原生目录选择
9. **智能体管理**: 自动扫描 broker + Web UI 一键启动新 Worker
10. **PO 自动化**: assign_po → decompose → create tasks → dispatch → review → confirm

## 关键文件

- `src/server/index.js` — API server (REST + WebSocket + Agent CRUD + workspace)
- `src/core/hub.js` — Hub 核心逻辑 (状态机、事件日志、Human actions)
- `src/core/agent-store.js` — Agent 实体管理 (CRUD、持久化、LLM config resolution)
- `src/llm/` — LLM 抽象层 (provider factory + OpenAI/Anthropic/Ollama clients)
- `src/net/broker-client.js` — WebSocket broker 客户端
- `scripts/auto-worker.js` — Worker+PO 双角色 agent (从 server 拉取配置、LLM 集成)
- `web/src/App.jsx` — React 入口
- `web/src/components/ProjectPanel.jsx` — 项目面板 (创建表单、详情、看板、时间线、交付物、预览)
- `web/src/components/AgentPanel.jsx` — Agent 管理面板 (创建、配置 LLM、启动/停止、归档)
- `web/src/hooks/useKSwarm.js` — React hook (WebSocket + HTTP API + Agent CRUD)
- `web/src/i18n/` — 国际化 (zh.json, en.json, index.jsx)
- `.env.example` — 环境变量配置参考

## 最新改动（本次会话）

1. **Agent 实体模型重构（对齐 multica 架构）**：
   - `src/core/agent-store.js` — 完整 Agent 数据模型：name, description, instructions, provider, model, baseUrl, apiKey, customEnv, customArgs, capabilities, roles, status, runtimeId, maxConcurrentTasks
   - Agent = 配置包（what to do），Runtime = 执行引擎（where to execute）
   - 持久化到 `~/.kswarm/agents.json`，支持 soft-delete (archive/restore)
   - API key 脱敏（list 时显示 ****）

2. **Agent CRUD API（对齐 multica /api/agents）**：
   ```
   GET    /agents              — 列表（支持 ?include_archived=true）
   POST   /agents              — 创建 agent
   GET    /agents/:id          — 获取详情
   PUT    /agents/:id          — 更新配置
   DELETE /agents/:id          — 归档（soft delete）
   POST   /agents/:id/archive  — 归档
   POST   /agents/:id/restore  — 恢复
   POST   /agents/:id/start    — 启动 worker（spawn 进程 + 注入 agent config）
   POST   /agents/:id/stop     — 停止
   GET    /agents/:id/llm      — 获取解析后的 LLM 配置
   GET    /llm/providers       — 列出支持的 provider 类型
   ```

3. **Auto-worker 重构**：
   - 启动时从 server 拉取 agent 配置（`GET /agents/:id`）
   - 使用 agent.instructions 作为 system prompt
   - LLM provider 从 agent 配置构建（fallback 到环境变量）
   - PO 分解 + Worker artifact 生成均使用 agent 自己的 LLM

4. **前端更新**：
   - `useKSwarm` hook 新增: agents state、createAgent、updateAgent、archiveAgent、startAgent、stopAgent
   - `AgentPanel` 重写: 创建 Agent 表单（含 LLM 配置）、编辑面板、启动/停止/归档操作、状态指示

5. **LLM 集成**：
   - `src/llm/providers/openai.js` — OpenAI-compatible (DeepSeek/Moonshot/Together)
   - `src/llm/providers/anthropic.js` — Claude
   - `src/llm/providers/ollama.js` — 本地模型
   - Per-agent model selection 优先级: agent.model > env var > provider default

## 待做 / 已知问题

- Web UI 的 showDirectoryPicker() 只返回 handle.name（相对名），不是绝对路径——浏览器安全限制
- 项目全部自动 done 后没有自动提示 Human 关闭（需要人工点）
- 项目数据没有持久化——server 重启后丢失（Agent 已持久化，项目待加）
- Web UI 的 ProjectPanel 创建项目时 PO/成员选择需要适配新的 Agent API
- Agent start 后 worker 进程退出时没有自动将 status 设回 offline（需要进程监控）
- 未实现 model discovery（目前 model 需要用户手填）

## 参考项目

**multica** (`~/projects/refre-proj/multica`)

用于对齐 agent 管理和 LLM 配置的设计模式：

### 核心架构模式
- **Agent = 配置包, Runtime = 执行引擎**: Agent 存 what (instructions, model, env, skills)，Runtime 表示 where to execute。一个 Runtime 可服务多个 Agent。
- **Per-agent model 选择**: 每个 agent 有独立的 `model` 字段，优先级: agent.model > daemon env > provider default
- **Unified Backend interface**: 所有 provider (claude, codex, gemini, copilot, opencode, hermes...) 实现单一 `Backend.Execute(ctx, prompt, opts) → *Session`

### Agent 数据模型（值得对齐的字段）
- `name`, `description`, `instructions` (system prompt)
- `runtime_id` + `runtime_mode` (local/cloud)
- `runtime_config` (JSON blob)
- `model` (per-agent LLM model)
- `custom_env` (per-agent 环境变量/secrets)
- `custom_args` (per-agent CLI 参数)
- `mcp_config` (MCP 服务配置)
- `visibility` (workspace/private)
- `status` (idle/working/blocked/error/offline)
- `max_concurrent_tasks`

### API 结构
```
GET/POST /api/agents
GET/PUT  /api/agents/{id}
POST     /api/agents/{id}/archive   (soft delete)
POST     /api/agents/{id}/restore
GET      /api/agents/{id}/tasks
GET/PUT  /api/agents/{id}/skills
```

### 关键设计选择
1. Model discovery: 静态 catalog + 动态发现混合（known providers 用静态列表，volatile CLI 用 live discovery + 60s cache）
2. Env/secrets 脱敏: custom_env 值对非 owner 显示 "****"，保留 key 可见
3. Presence 派生在前端: 后端只存原始事实（task status, runtime heartbeat），前端计算 availability + workload
4. Soft-delete + task cascade: 归档 agent 时自动取消其活跃任务
5. 两级自定义参数: Runtime 级别 ExtraArgs + per-agent CustomArgs

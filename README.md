# KSwarm

> You have multiple AI agents — but coordinating them is harder than the work itself. KSwarm lets you define a goal, and it handles the rest: planning, dispatching, quality review, and delivery. Your agents become a team.

A multi-agent project coordination system built on [Intent Broker](https://github.com/nicepkg/intent-broker). Define a goal, KSwarm decomposes it into phased tasks, dispatches to the best available agents, reviews quality, and delivers results.

English | [简体中文](README.zh-CN.md)

---

## Architecture

```
Human (via Web UI / CLI / IM)
    ↓ goal + requirements
┌──────────────────────────────────────────────────────┐
│                   KSwarm Hub                          │
│                                                      │
│  Goal → Plan → Approve → Dispatch → Review → Deliver │
│       (PO Agent)                                     │
└────────────┬─────────────────────────────────────────┘
             │ intent-broker protocol
             │ (request_task / submit_result / review / ...)
             ↓
┌────────────────────────────────────────────────────────┐
│                   Intent Broker                         │
│  WebSocket • Presence • Message Routing • Groups       │
└────┬──────────┬──────────┬──────────┬─────────────────┘
     ↓          ↓          ↓          ↓
   Claude     Codex      XiaoK     Qoder      (worker agents)
```

---

## How It Works

### Plan-Do Execution Model

KSwarm uses a structured **Plan-Do** model, not fire-and-forget task decomposition:

1. **PO generates a Plan** — Deep analysis, phased task breakdown, acceptance criteria per item
2. **Human approves** — Review the plan before execution starts
3. **Phase-aware dispatch** — Only the current phase's tasks are dispatched; next phase waits
4. **Runtime-safe execution** — dispatch routes through agent health, capability, and active-run leases
5. **Quality review** — PO reads actual artifact content and evaluates against acceptance criteria
6. **Rework loop** — Failed reviews send tasks back with specific feedback
7. **Auto-synthesis** — When all phases complete, PO generates a final deliverable

### Key Design Decisions

| Decision | Why |
|----------|-----|
| Hub is a pure state machine | No LLM calls in the hub — deterministic, testable, fast |
| PO Agent makes all decisions | Planning, dispatch strategy, quality gates — one accountable owner |
| Human gates at key moments | Approve plans, close projects — human stays in control |
| Phase-aware dispatch | Prevents premature parallel execution; respects dependency chains |
| Runtime health gates | Agents that are online but unable to execute are degraded, cooled down, and routed around |
| Deliverable contracts | Hard output requests such as PPTX are validated before PO review |
| Recoverable planning | Interrupted PO planning can be retried from the project detail page |

---

## Features

### Core

- **Structured Planning** — PO analyzes goals, creates phased plans with rationale and acceptance criteria
- **Task State Machine** — `pending → dispatched → accepted → in_progress → submitted → done` with rework loop
- **Quality Review** — PO reads artifact content (not just filenames) and evaluates substance
- **Phase-aware Dispatch** — Only earliest incomplete phase dispatches; prevents premature parallel work
- **Capability-aware Routing** — Retries and dispatches route to healthy agents with matching task/output capability
- **Runtime Watchdogs** — Heartbeats, stdout/stderr telemetry, and stale-run detection prevent silent CLI hangs
- **Deliverable Contracts** — Explicit PPTX/HTML/Markdown tasks are validated before review
- **Plan Retry Recovery** — Projects interrupted during PO planning can be restarted safely
- **Local PPTX Fallback** — Presentation tasks can use a deterministic local executor when no agent can produce PPTX
- **Persistence** — Projects survive server restarts (debounced JSON state file)

### Web UI

- **Kanban Board** — 4-column board (Pending / In Progress / Submitted / Done)
- **Plan View** — Phase progress, acceptance criteria, review feedback per task
- **Real-time Updates** — WebSocket push for all state changes
- **Artifact Preview** — Inline markdown/HTML/JSON preview with download
- **Task Management** — Cancel tasks, add tasks mid-project, manual dispatch

### Agents

- **Multi-runtime Support** — Claude Code, Codex CLI, XiaoK, or any broker-compatible agent
- **Capability Matching** — Assign tasks based on agent skills
- **Health Monitor** — Detects stuck tasks (10min timeout), reassigns or PO takes over
- **Concurrent Execution** — Multiple agents work in parallel within a phase

---

## Quick Start

```bash
# Prerequisites: intent-broker running on localhost:4318
# cd ~/intent-broker && npm start

cd kswarm
npm install

# Start the API server (port 4400)
node src/server/index.js

# Start the web UI (port 5173)
cd web && npx vite --port 5173

# Start PO agent (will handle planning + dispatch + review)
node scripts/auto-worker.js cli-claude Claude

# (Optional) Start additional worker agents
node scripts/auto-worker.js cli-codex Codex
node scripts/auto-worker.js 79aac2f5-ace AQ
```

Open http://localhost:5173 — create a project, set a goal, and watch agents collaborate.

---

## Usage

### Create a Project

Via Web UI or API:

```bash
curl -X POST http://localhost:4400/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Product Strategy",
    "goal": "Create a 6-month product strategy with competitive analysis",
    "requirements": "At least 3 rounds of adversarial review",
    "poAgent": "cli-claude",
    "members": ["cli-codex", "79aac2f5-ace"]
  }'
```

### Project Lifecycle

```
Created → [Human Approves] → Active → [Tasks Execute] → Delivered → [Human Closes] → Closed
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/projects` | GET | List all projects |
| `/projects` | POST | Create project |
| `/projects/:id` | GET | Project detail (tasks, plan, artifacts) |
| `/projects/:id/approve` | POST | Approve project (starts execution) |
| `/projects/:id/retry-plan` | POST | Re-trigger PO planning after an interrupted or stale plan attempt |
| `/projects/:id/plan` | POST | PO submits structured plan |
| `/projects/:id/dispatch` | POST | Dispatch available tasks |
| `/projects/:id/tasks/:taskId/review` | POST | PO quality review |
| `/projects/:id/tasks/:taskId/done` | POST | Mark task done |
| `/projects/:id/tasks/:taskId/cancel` | POST | Cancel task |
| `/projects/:id/deliver` | POST | Submit final deliverable |
| `/projects/:id/close` | POST | Human closes project |

---

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `KSWARM_HOME` | `~/.kswarm` | Data directory (state, workspaces, artifacts) |
| `BROKER_URL` | `http://127.0.0.1:4318` | Intent Broker address |
| `PORT` | `4400` | API server port |

---

## Project Structure

```
kswarm/
├── src/
│   ├── core/
│   │   ├── hub.js           # State machine + project/task management
│   │   ├── task-board.js    # Task state machine + transitions
│   │   ├── persistence.js   # JSON file persistence
│   │   └── event-log.js     # Event logging
│   ├── server/
│   │   └── index.js         # HTTP API + WebSocket server
│   └── net/
│       └── broker-client.js  # Intent Broker WebSocket client
├── scripts/
  │   └── auto-worker.js       # PO + Worker agent runtime with run telemetry
├── web/
│   └── src/                  # React + Tailwind frontend
├── test/                     # Unit + integration tests
└── package.json
```

---

## Requirements

- Node.js ≥ 18
- [Intent Broker](https://github.com/nicepkg/intent-broker) running locally
- At least one LLM-powered agent (Claude Code, Codex CLI, etc.)

---

## Testing

```bash
npm test              # Default scenario suite
npm run test:all      # Full unit/integration/e2e regression suite
npm run test:e2e-p0   # P0 integration scenarios
```

---

## Version History

**v0.7.0** — Reliable execution hardening: runtime probes and health cooldowns, capability-aware dispatch/retry routing, stalled-run watchdogs with heartbeat/stdout/stderr telemetry, strict deliverable contracts for PPTX/HTML/Markdown tasks, deterministic local PPTX fallback, restart recovery for active runs, and retryable planning when the PO planning phase is interrupted.

**v0.6.0** — Plan-Do execution model: structured planning with phases, quality review with artifact content reading, phase-aware dispatch, offline worker fallback (PO auto-takes-over), rework loop, persistence across restarts.

**v0.5.0** — Web UI: kanban board, plan view, real-time WebSocket updates, artifact preview, task cancel.

**v0.4.0** — Quality review system: PO reads artifacts and evaluates against acceptance criteria; pass/fail with feedback; rework loop.

**v0.3.0** — Persistence: projects survive server restarts; debounced JSON state file.

**v0.2.0** — Connected to real intent-broker; multi-agent dispatch; auto-worker runtime.

**v0.1.0** — Initial prototype: template planner, mock dispatch, demo.

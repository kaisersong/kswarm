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
4. **Quality review** — PO reads actual artifact content and evaluates against acceptance criteria
5. **Rework loop** — Failed reviews send tasks back with specific feedback
6. **Auto-synthesis** — When all phases complete, PO generates a final deliverable

### Key Design Decisions

| Decision | Why |
|----------|-----|
| Hub is a pure state machine | No LLM calls in the hub — deterministic, testable, fast |
| PO Agent makes all decisions | Planning, dispatch strategy, quality gates — one accountable owner |
| Human gates at key moments | Approve plans, close projects — human stays in control |
| Phase-aware dispatch | Prevents premature parallel execution; respects dependency chains |
| Offline worker fallback | If assigned worker is offline, PO takes over execution automatically |

---

## Features

### Core

- **Structured Planning** — PO analyzes goals, creates phased plans with rationale and acceptance criteria
- **Task State Machine** — `pending → dispatched → accepted → in_progress → submitted → done` with rework loop
- **Quality Review** — PO reads artifact content (not just filenames) and evaluates substance
- **Phase-aware Dispatch** — Only earliest incomplete phase dispatches; prevents premature parallel work
- **Offline Fallback** — PO auto-detects offline workers and takes over execution
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
│   └── auto-worker.js       # PO + Worker agent runtime
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
npm test              # All tests (80 scenarios)
npm run test:hub      # Hub unit tests
npm run test:plan     # Plan flow integration tests
```

---

## Version History

**v0.6.0** — Plan-Do execution model: structured planning with phases, quality review with artifact content reading, phase-aware dispatch, offline worker fallback (PO auto-takes-over), rework loop, persistence across restarts.

**v0.5.0** — Web UI: kanban board, plan view, real-time WebSocket updates, artifact preview, task cancel.

**v0.4.0** — Quality review system: PO reads artifacts and evaluates against acceptance criteria; pass/fail with feedback; rework loop.

**v0.3.0** — Persistence: projects survive server restarts; debounced JSON state file.

**v0.2.0** — Connected to real intent-broker; multi-agent dispatch; auto-worker runtime.

**v0.1.0** — Initial prototype: template planner, mock dispatch, demo.

# KSwarm

> You have multiple AI agents — but coordinating them is harder than the work itself. KSwarm lets you define a goal, and it handles the rest: planning, dispatching, quality review, and delivery. Your agents become a team.

A multi-agent project coordination system built on [Intent Broker](https://github.com/nicepkg/intent-broker). Define a goal, KSwarm decomposes it into phased tasks, dispatches to the best available agents, reviews quality, and delivers results.

English | [简体中文](README.zh-CN.md)

---

## Xiaok Desktop v1.4.20 Integration Baseline

- KSwarm remains the project and workflow control plane packaged with Xiaok Desktop v1.4.20. Desktop owns service startup, health/version probing, user-facing diagnostics, loop result UI, and the Automations surface; KSwarm owns project state, task state, workflow runs, review gates, and deliverable metadata.
- **Workflow nodes can now automatically receive upstream output**: `enrichWorkflowNodeInput` collects completed upstream node outputs via `dependsOn` edges and injects them into the dispatched input. Desktop `buildKSwarmWorkflowNodePrompt` renders these as a structured "upstream reference" section. All new logic follows degradation-first: any failure skips injection silently (never blocks dispatch).
- Completion evidence is consumed by Xiaok loop diagnostics. KSwarm project snapshots, task artifacts, workflow node outputs, and deliverable records remain the source data Desktop uses to verify that a completed project actually has inspectable artifact evidence.
- Xiaok Desktop v1.4.20 adds loop-result visibility and LoopContract evaluation on the Desktop side. This does not require a KSwarm protocol migration: task completion, project delivery, and workflow progress still flow through the existing project/task/workflow snapshot contract.
- The active packaged sidecar is KSwarm `0.9.2`, including upstream output handoff, suspend/resume recovery, durable parallel workflow contracts, PO review verdict tolerance, and resume_workflow strategy for blocked script-generated workflows.
- The Desktop release workflow for `desktop-v1.4.20` checks out this repository before packaging, so this README baseline should move with Xiaok Desktop release tags even when the KSwarm sidecar version remains unchanged.

## What's New in v0.9.2

- **Workflow Node Upstream Output Handoff** — `compactNodeOutput(node)` extracts a structured compact of a completed node's output: summary, artifact paths, and small inline fields (capped per-field 2KB, per-node 4KB). `enrichWorkflowNodeInput(workflowRun, input, { nodeId })` collects all completed `dependsOn` upstream outputs (10KB total cap, graceful summary-only fallback on overflow). `dispatchWorkflowNode` passes the enriched input to broker/desktop but strips `upstreamOutputs` before persisting to node state (derived data, not stored). `dispatchWorkflowScriptAgentNode` gains an optional `{ dependsOn }` parameter for script-created nodes.
- **Sanitize upstreamOutputs** — `NODE_MUTATION_KEYS` now includes `upstreamOutputs` so agents cannot echo upstream data back as their own output mutation.
- **Degradation Logging** — All `compactNodeOutput` and `enrichWorkflowNodeInput` catch blocks now emit `console.warn` (gated by silent flag) for observability.

## What's New in v0.9.1

- **PO Review Verdict Tolerance** — When PO explicitly passes a review, missing evidence format (verdict field) no longer blocks the task. The review gate now treats an explicit pass without a structured verdict as a valid approval instead of rejecting the submission.
- **Resume Workflow Strategy** — `handleContinueProject` now supports the `resume_workflow` strategy for blocked script-generated workflows. Previously blocked workflows can be unblocked and resumed without restarting from scratch.

## What's New in v0.8.2

- **Durable Parallel Workflow Groups** — script-generated workflow runs can now create KSwarm-owned `parallelGroups` before branch dispatch. Group status, completion counters, failure policy, and timestamps are persisted with the workflow run.
- **Branch Metadata and Script Checkpoints** — dynamic branch nodes store `parallelGroupId`, fan-out key/label, required/schema/evidence flags, and script checkpoints so Desktop can explain parallel progress from KSwarm snapshots.
- **Script Terminal Decisions** — trusted script runtimes can finish normally or block a run with structured `blocked`, `needs_replanning`, or `needs_rubric_clarification` terminal decisions instead of forcing every script to appear completed.
- **HTTP Contract for Parallel Scripts** — the server exposes `/script/parallel-groups`, forwards branch metadata through `/script/nodes`, and accepts structured terminal data on `/script/complete`.
- **Workflow Test Coverage** — `npm run test:workflow` now includes durable parallel group coverage in addition to script-generated workflow control-plane and API contract tests.
- **Surfaced in Desktop v1.4.3 Kanban** — Xiaok Desktop v1.4.3 consumes these `parallelGroups`, branch metadata, and script checkpoints directly on each project task card (a slim multi-segment progress bar fed by `summary.completed/running/failed`) and a right-side `TaskDetailDrawer` (full node list grouped by phase, with parallel groups, fan-out labels, failure policy, and per-node status / agent / error). No KSwarm protocol or data model change is needed.

## What's New in v0.8.1

- **Script-Generated Workflow Runs** — KSwarm now owns durable control-plane state for trusted dynamic workflow scripts: proposals, approved runs, script runtime nodes, dynamic agent nodes, node handoffs, node results, and completion.
- **Artifact-Producing Agent Delivery** — Project-level script workflows can deliver from the final artifact-producing agent node when the script runtime node only contains orchestration metadata.
- **Required Output Enforcement** — Project delivery validates terminal task hard outputs, so a workflow requiring `report_html` must attach a readable HTML artifact instead of passing with markdown/json side products.
- **Project Instance Identity** — New projects use UUID-style instance IDs and client request keys for idempotency. Same-name projects are no longer collapsed into one project instance.
- **Desktop API Contract** — The HTTP API exposes script workflow proposal/start/node/complete endpoints and supports creating projects without auto-starting PO planning for controlled workflow E2E tests.

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
5. **File-based handoff** — large task context, requirements, evidence contracts, and artifact contracts are written to handoff files instead of oversized broker messages
6. **Quality review** — PO reads actual artifact content and evaluates against acceptance criteria
7. **Rework loop** — Failed reviews send tasks back with specific feedback
8. **Auto-synthesis** — When all phases complete, PO generates a final deliverable

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
| Execution boundary | Xiaok Desktop seed agents must run in the full Desktop agent runtime; KSwarm does project management and never pretends to be an LLM worker |

---

## Features

### Core

- **Structured Planning** — PO analyzes goals, creates phased plans with rationale and acceptance criteria
- **Task State Machine** — `pending → dispatched → accepted → in_progress → submitted → done` with rework loop
- **Quality Review** — PO reads artifact content (not just filenames) and evaluates substance
- **Phase-aware Dispatch** — Only earliest incomplete phase dispatches; prevents premature parallel work
- **Capability-aware Routing** — Retries and dispatches route to healthy agents with matching task/output capability
- **Runtime Watchdogs** — Heartbeats, stdout/stderr telemetry, and stale-run detection prevent silent CLI hangs
- **Durable Dynamic Workflow Parallelism** — script-generated workflow branches can be grouped, counted, checkpointed, and surfaced to Desktop without relying on runtime memory
- **Deliverable Contracts** — Explicit PPTX/HTML/Markdown tasks are validated before review
- **Plan Retry Recovery** — Projects interrupted during PO planning can be restarted safely
- **File Handoff Packages** — Task context is written to durable handoff packages so agents read large requirements and prior artifacts from files
- **Evidence Contracts** — Recent/monthly research tasks can require source evidence and current-date grounding before review passes
- **Formal Delivery Files** — Final delivery aliases use project/goal-based filenames instead of internal task IDs
- **Runtime Boundary Enforcement** — KSwarm maintenance workers can manage state, logs, and packaging, but user tasks are handed to real agents
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

**v0.9.1** — PO review and workflow resume fix: when PO explicitly passes a review, missing evidence format (verdict field) no longer blocks the task; `handleContinueProject` supports `resume_workflow` strategy for blocked script-generated workflows, allowing them to be unblocked and resumed without restarting from scratch.

**v0.9.0** — Parallel dispatch and interruption recovery: desktop worker concurrency unlocked from 1 to configurable max (default 3, range 1-10 via `KSWARM_MAX_WORKER_INSTANCES` env or desktop config); `suspendedAt` task marker for graceful sleep/shutdown with automatic lease-refresh resume; `defer_recovery` action with 20s grace period for agents not yet online; `systemSuspended` flag suppresses watchdog and recovery during host sleep; atomic state persistence via temp-file-and-rename; stalled-run watchdog defaults bumped to 5-minute heartbeat timeout and 20-minute max run time; `/runtime/suspend` and `/runtime/resume` endpoints for Electron powerMonitor integration; SIGTERM graceful shutdown marks active tasks suspended before exit.

**v0.8.0** — Swarm execution boundary and evidence release: Xiaok Desktop seed agents are routed to the full Desktop agent runtime instead of local auto-worker execution; task handoff packages move large context and artifact contracts into files; source/evidence contracts calibrate recent and monthly research review; artifact-first completion prevents empty summary-only results; final deliverables use formal filenames and delivery aliases; failed/blocked historical retry children no longer hold project delivery hostage.

**v0.7.0** — Reliable execution hardening: runtime probes and health cooldowns, capability-aware dispatch/retry routing, stalled-run watchdogs with heartbeat/stdout/stderr telemetry, strict deliverable contracts for PPTX/HTML/Markdown tasks, deterministic local executor fallback for explicit PPTX presentation tasks, restart recovery for active runs, and retryable planning when the PO planning phase is interrupted.

**v0.6.0** — Plan-Do execution model: structured planning with phases, quality review with artifact content reading, phase-aware dispatch, offline worker fallback (PO auto-takes-over), rework loop, persistence across restarts.

**v0.5.0** — Web UI: kanban board, plan view, real-time WebSocket updates, artifact preview, task cancel.

**v0.4.0** — Quality review system: PO reads artifacts and evaluates against acceptance criteria; pass/fail with feedback; rework loop.

**v0.3.0** — Persistence: projects survive server restarts; debounced JSON state file.

**v0.2.0** — Connected to real intent-broker; multi-agent dispatch; auto-worker runtime.

**v0.1.0** — Initial prototype: template planner, mock dispatch, demo.

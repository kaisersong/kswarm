/**
 * KSwarm Architecture — Role Separation
 *
 * ═══════════════════════════════════════════════════════════════
 * 核心原则：KSwarm 是 Hub，不是 Brain
 * ═══════════════════════════════════════════════════════════════
 *
 * KSwarm 只做三件事：
 * 1. 路由 — 消息在 Human / PO / Workers 之间传递
 * 2. 看板 — 管理 task 状态机（pending→dispatched→accepted→done）
 * 3. 规则 — 执行门控（审批、依赖、超时）
 *
 * KSwarm 不做：
 * ✗ 目标分解（那是 PO 的事）
 * ✗ 任务分配决策（那是 PO 的事）
 * ✗ 结果判断（那是 PO 的事）
 * ✗ 任何业务逻辑
 *
 * ═══════════════════════════════════════════════════════════════
 *
 * 角色定义：
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Human (人)                                                  │
 * │  - 提出目标                                                   │
 * │  - 指定 Project Owner                                        │
 * │  - 审批关键节点                                               │
 * │  - 接收最终交付                                               │
 * └────────────────────────────┬──────────────────────────────────┘
 *                              │ IM / CLI
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────┐
 * │  KSwarm (Hub)                                                │
 * │  - 维护 TaskBoard 状态                                        │
 * │  - 路由 intent（不解释、不判断）                                │
 * │  - 执行规则：依赖检查、审批门控、超时告警                        │
 * │  - 可观测性：事件日志、status 输出                              │
 * └────────────────────────────┬──────────────────────────────────┘
 *                              │ intent-broker protocol
 *                              ▼
 * ┌──────────────────────────────────────────────────────────────┐
 * │  Project Owner (PO Agent)                                     │
 * │  - 接收目标，分解为任务                                         │
 * │  - 决定每个任务派给谁                                          │
 * │  - 通过 KSwarm API 创建任务、指定 assignee                      │
 * │  - 跟踪进度，决定是否需要返工/调整                              │
 * │  - 聚合结果，提交最终交付物给 Human                             │
 * └────────────────────────────┬──────────────────────────────────┘
 *                              │ intent-broker protocol
 *                              ▼
 * ┌──────────────────────────────────────────────────────────────┐
 * │  Worker Agents (@xiaok, @claude, @codex, @qoder)              │
 * │  - 接收任务，执行，提交结果                                     │
 * │  - 不知道项目全貌，只看到自己的 task                             │
 * │  - 可以向 PO 提问/反馈                                         │
 * └──────────────────────────────────────────────────────────────┘
 *
 * ═══════════════════════════════════════════════════════════════
 * 流程时序：
 * ═══════════════════════════════════════════════════════════════
 *
 *   Human          KSwarm(Hub)         PO Agent          Workers
 *     │                │                  │                 │
 *     │─ "做XX方案"───▶│                  │                 │
 *     │  + 指定PO=@xiaok                  │                 │
 *     │                │─ assign_po ─────▶│                 │
 *     │                │                  │                 │
 *     │                │◀─ create_tasks ──│                 │
 *     │                │   (PO分解出任务)   │                 │
 *     │                │   (PO指定assignee) │                 │
 *     │                │                  │                 │
 *     │◀─ "计划已生成   │                  │                 │
 *     │   请审批" ─────│                  │                 │
 *     │                │                  │                 │
 *     │─ /approve ────▶│                  │                 │
 *     │                │─ dispatch ──────────────────────▶  │
 *     │                │  (按PO的分配，发给指定worker)         │
 *     │                │                  │                 │
 *     │                │◀─────────────────────── progress ──│
 *     │                │─ notify ────────▶│                 │
 *     │                │  (PO收到进度)      │                 │
 *     │                │                  │                 │
 *     │                │◀─────────────────────── result ────│
 *     │                │─ notify ────────▶│                 │
 *     │                │                  │─ review ──────▶ │
 *     │                │                  │  (PO判断质量)     │
 *     │                │                  │                 │
 *     │                │◀─ mark_done ─────│                 │
 *     │                │                  │                 │
 *     │                │◀─ deliver ───────│                 │
 *     │◀─ "方案完成"──│                  │                 │
 *     │                │                  │                 │
 *
 * ═══════════════════════════════════════════════════════════════
 * KSwarm Hub API (PO 和 Worker 调用的接口)：
 * ═══════════════════════════════════════════════════════════════
 *
 * Intent: create_tasks    — PO → Hub，提交分解好的任务列表
 * Intent: assign_task     — PO → Hub，指定某个任务给某个 worker
 * Intent: request_dispatch— PO → Hub，请求派发（Hub 检查依赖后执行）
 * Intent: mark_done       — PO → Hub，确认某个任务完成
 * Intent: deliver         — PO → Hub，提交最终交付物
 *
 * Intent: accept_task     — Worker → Hub，接受任务
 * Intent: report_progress — Worker → Hub，报告进度
 * Intent: submit_result   — Worker → Hub，提交结果
 * Intent: ask_question    — Worker → Hub → PO，向 PO 提问
 *
 * Intent: approve         — Human → Hub，审批通过
 * Intent: reject          — Human → Hub，审批拒绝
 *
 * Hub 对所有 intent 只做：
 * 1. 校验（格式、权限）
 * 2. 状态流转（更新 board）
 * 3. 路由（转发给目标方）
 * 4. 记录（写 event log）
 */

export const ROLES = {
  HUMAN: 'human',
  HUB: 'hub',
  PO: 'project_owner',
  WORKER: 'worker',
};

/**
 * Hub 处理的 intent 类型及路由规则
 */
export const HUB_INTENTS = {
  // Human → Hub
  create_project: { from: 'human', action: 'create_project_and_assign_po' },
  approve: { from: 'human', action: 'gate_open' },
  reject: { from: 'human', action: 'gate_close' },

  // PO → Hub
  create_tasks: { from: 'po', action: 'add_to_board' },
  assign_task: { from: 'po', action: 'update_board_assignment' },
  request_dispatch: { from: 'po', action: 'dispatch_if_deps_met' },
  mark_done: { from: 'po', action: 'update_board_status' },
  deliver: { from: 'po', action: 'mark_delivered_and_notify_human' },

  // Worker → Hub
  accept_task: { from: 'worker', action: 'update_board_status_and_notify_po' },
  report_progress: { from: 'worker', action: 'update_and_forward_to_po' },
  submit_result: { from: 'worker', action: 'update_and_forward_to_po' },
  ask_question: { from: 'worker', action: 'forward_to_po' },
};

/**
 * ═══════════════════════════════════════════════════════════════
 * Unified role policy (single source of truth)
 * ═══════════════════════════════════════════════════════════════
 *
 * Historically three different `hasRole` helpers disagreed on what an
 * agent with empty/missing `roles` meant: readiness treated it as a
 * universal match, while replacement and PO selection treated it as no
 * match. That let a role-less agent receive new work yet never rescue
 * failing work, and let the UI offer a role-less agent as PO even though
 * any plan retry would discard it.
 *
 * Unified semantics:
 *   - A role-less agent is WORKER-eligible everywhere (worker-universal).
 *   - A role-less agent is NEVER auto-eligible as PROJECT OWNER; PO
 *     requires the explicit `project_owner` role.
 */

function normalizeAgentRoles(agent) {
  return Array.isArray(agent?.roles) ? agent.roles.filter(Boolean) : [];
}

/** Strict membership: does the agent explicitly declare this role? */
export function agentHasExplicitRole(agent, role) {
  if (!role) return true;
  return normalizeAgentRoles(agent).includes(role);
}

/**
 * Role match used by gating layers. Role-less agents match `worker`
 * (and any non-PO role) but must explicitly declare `project_owner`.
 */
export function agentMatchesRole(agent, role) {
  if (!role) return true;
  if (role === ROLES.PO) return agentHasExplicitRole(agent, ROLES.PO);
  const roles = normalizeAgentRoles(agent);
  if (roles.length === 0) return true;
  return roles.includes(role);
}

/** Worker-eligible: role-less or explicitly a worker. */
export function isWorkerEligible(agent) {
  if (!agent) return false;
  const roles = normalizeAgentRoles(agent);
  if (roles.length === 0) return true;
  return roles.includes(ROLES.WORKER);
}

/** PO-eligible: must explicitly declare project_owner. */
export function isProjectOwnerEligible(agent) {
  if (!agent) return false;
  return agentHasExplicitRole(agent, ROLES.PO);
}

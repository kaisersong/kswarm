/**
 * Built-in workflows for KSwarm control-plane operations.
 *
 * Phase 1 intentionally supports deterministic, read-only workflows only.
 * These workflows inspect existing project state and produce KSwarm-owned
 * diagnosis snapshots. They do not spawn agents or execute user scripts.
 */

import { applyWorkflowEvent, createWorkflowRun } from './workflow-run.js';

export const PROJECT_DIAGNOSE_WORKFLOW_ID = 'project-diagnose';

export function createProjectDiagnoseWorkflowRun({
  project,
  tasks = [],
  projectHealth = null,
  dispatchPlan = null,
  requestedBy = 'human',
  now = Date.now(),
} = {}) {
  if (!project?.id) {
    const error = new Error('project_required');
    error.code = 'project_required';
    throw error;
  }

  const diagnosis = buildProjectDiagnosis({ project, tasks, projectHealth, dispatchPlan });
  let run = createWorkflowRun({
    id: `wf-${project.id}-${PROJECT_DIAGNOSE_WORKFLOW_ID}-${now}`,
    projectId: project.id,
    workflowId: PROJECT_DIAGNOSE_WORKFLOW_ID,
    title: '项目诊断工作流',
    requestedBy,
    source: 'builtin',
    phases: [
      { id: 'inspect', title: '检查项目状态' },
      { id: 'recommend', title: '生成处理建议' },
    ],
    nodes: [
      { id: 'collect-project-state', phaseId: 'inspect', title: '收集项目状态', kind: 'control' },
      { id: 'classify-blockers', phaseId: 'inspect', title: '识别阻塞与等待原因', kind: 'control', dependsOn: ['collect-project-state'] },
      { id: 'recommend-actions', phaseId: 'recommend', title: '生成下一步建议', kind: 'review', dependsOn: ['classify-blockers'] },
    ],
    diagnosis,
    now,
  });

  const outputs = {
    'collect-project-state': {
      projectStatus: project.status || null,
      taskCount: tasks.length,
      healthState: diagnosis.healthState,
    },
    'classify-blockers': {
      blockedTasks: diagnosis.blockedTasks,
      waitingCount: diagnosis.waitingCount,
      dispatchableCount: diagnosis.dispatchableCount,
    },
    'recommend-actions': {
      recommendedActions: diagnosis.recommendedActions,
    },
  };

  for (const nodeId of ['collect-project-state', 'classify-blockers', 'recommend-actions']) {
    run = applyWorkflowEvent(run, { type: 'node_started', nodeId }, { now });
    run = applyWorkflowEvent(run, { type: 'node_completed', nodeId, output: outputs[nodeId] }, { now });
  }
  return run;
}

export function buildProjectDiagnosis({ project = {}, tasks = [], projectHealth = null, dispatchPlan = null } = {}) {
  const healthState = projectHealth?.state || projectHealth?.status || null;
  const blockedTasks = collectBlockedTasks({ tasks, projectHealth, dispatchPlan });
  const dispatchableCount = countDispatchable(dispatchPlan, tasks);
  const waitingCount = Array.isArray(dispatchPlan?.waiting)
    ? dispatchPlan.waiting.length
    : (dispatchPlan?.skipped || []).filter(item => String(item.reason || '').includes('busy')).length;
  const recommendedActions = recommendActions({ healthState, blockedTasks, dispatchableCount, waitingCount, project });

  return {
    healthState,
    gate: projectHealth?.gate || dispatchPlan?.projectGate || null,
    blockedTasks,
    dispatchableCount,
    waitingCount,
    recommendedActions,
  };
}

function collectBlockedTasks({ tasks = [], projectHealth = null, dispatchPlan = null }) {
  const byId = new Map();
  for (const reason of projectHealth?.reasons || []) {
    if (!reason?.taskId) continue;
    byId.set(reason.taskId, { taskId: reason.taskId, message: reason.message || reason.reason || '任务已阻塞' });
  }
  for (const item of dispatchPlan?.blocked || []) {
    const taskId = item.taskId || item.id;
    if (!taskId || byId.has(taskId)) continue;
    byId.set(taskId, { taskId, message: item.reason || '任务依赖未满足' });
  }
  for (const task of tasks) {
    if (task.status !== 'blocked' || byId.has(task.id)) continue;
    byId.set(task.id, { taskId: task.id, message: task.blockedReason || task.failureReason || '任务已阻塞' });
  }
  return [...byId.values()];
}

function countDispatchable(dispatchPlan, tasks) {
  if (Array.isArray(dispatchPlan?.dispatchedTasks)) return dispatchPlan.dispatchedTasks.length;
  if (Array.isArray(dispatchPlan?.dispatchable)) return dispatchPlan.dispatchable.length;
  return tasks.filter(task => task.status === 'pending' && task.assignedAgent).length;
}

function recommendActions({ healthState, blockedTasks, dispatchableCount, waitingCount, project }) {
  if (blockedTasks.length > 0 || ['blocked', 'failed', 'repair_output_contract'].includes(String(healthState || ''))) {
    return [{ id: 'continue_project', label: '继续处理阻塞', reason: '项目存在阻塞或失败任务，需要由 KSwarm 推进恢复路径' }];
  }
  if (dispatchableCount > 0 && project.status === 'active') {
    return [{ id: 'dispatch_tasks', label: '派发可执行任务', reason: '存在可派发任务，且项目处于 active 状态' }];
  }
  if (waitingCount > 0) {
    return [{ id: 'wait_for_agents', label: '等待 Agent 空闲', reason: '当前主要瓶颈是 Agent 忙碌或容量不足' }];
  }
  return [{ id: 'observe', label: '继续观察项目状态', reason: '未发现需要立即干预的问题' }];
}

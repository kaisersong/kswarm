/**
 * TaskBoard — Pure state machine for tasks
 *
 * KSwarm Hub 的核心数据结构。
 * 只管状态，不做决策。
 *
 * Board 不知道：
 * - 为什么某个任务要分给某个 agent（PO 决定的）
 * - 任务内容对不对（PO 判断的）
 * - 下一步该做什么（PO 驱动的）
 *
 * Board 只知道：
 * - 当前有哪些任务
 * - 每个任务的状态
 * - 每个任务的依赖是否满足
 * - 状态流转是否合法
 */

import {
  buildTaskAliases,
  isExecutableTaskInput,
  makeRunId,
  normalizeExistingTask,
  normalizeTasksForProject,
} from './task-identity.js';

const VALID_TRANSITIONS = {
  pending: ['dispatched', 'failed', 'blocked', 'cancelled'],
  dispatched: ['accepted', 'pending', 'failed', 'blocked', 'cancelled'],  // pending = 超时退回
  accepted: ['in_progress', 'pending', 'failed', 'blocked', 'cancelled'],  // pending = agent 放弃
  in_progress: ['submitted', 'pending', 'failed', 'blocked', 'cancelled'],  // pending = rework redispatch
  submitted: ['done', 'in_progress', 'pending', 'blocked', 'cancelled'],    // pending = PO 要求返工并重新派发
  done: ['in_progress'],  // PO quality review can reopen for rework
  failed: ['pending', 'blocked'],  // 可重新派发或人工阻塞
  blocked: ['pending', 'cancelled'],
  cancelled: [],  // terminal
};

export function createTaskBoard(projectId = 'legacy-project') {
  const tasks = new Map();  // taskId → task
  let aliases = new Map();

  function rebuildAliases() {
    aliases = buildTaskAliases(projectId, [...tasks.values()]);
  }

  function resolveTaskId(taskId) {
    if (tasks.has(taskId)) return taskId;
    return aliases.get(taskId) || null;
  }

  /**
   * PO 提交任务列表（批量创建）
   */
  function addTasks(taskList) {
    const result = addTasksChecked(taskList);
    return result.ok ? result.taskIds : [];
  }

  function addTasksChecked(taskList) {
    const normalized = normalizeTasksForProject(projectId, taskList, [...tasks.values()]);
    if (!normalized.ok) return normalized;

    for (const task of normalized.tasks) {
      // Skip if task already exists (prevents duplicate submissions resetting state)
      if (tasks.has(task.id)) continue;
      tasks.set(task.id, {
        ...task,
        status: 'pending',
        assignedAgent: task.assignedAgent || null,
        assignedExecutor: task.assignedExecutor || null,
        result: null,
        attempt: task.attempt || 1,
        maxAttempts: task.maxAttempts || 2,
        failureReason: task.failureReason || null,
        failureHistory: Array.isArray(task.failureHistory) ? task.failureHistory : [],
        runtimeFailureCount: task.runtimeFailureCount || 0,
        qualityFailureCount: task.qualityFailureCount || 0,
        qualityReviewHistory: Array.isArray(task.qualityReviewHistory) ? task.qualityReviewHistory : [],
        rejectedSubmissions: Array.isArray(task.rejectedSubmissions) ? task.rejectedSubmissions : [],
        lastFailureClass: task.lastFailureClass || null,
        blockedAt: task.blockedAt || null,
        blockedReason: task.blockedReason || null,
        blockKind: task.blockKind || null,
        nextActions: Array.isArray(task.nextActions) ? task.nextActions : [],
        isCompositeParent: task.isCompositeParent === true,
        childTaskIds: Array.isArray(task.childTaskIds) ? [...task.childTaskIds] : [],
        parentTaskId: task.parentTaskId || null,
        activeRunId: task.activeRunId || null,
        runLease: task.runLease || null,
        runTelemetry: task.runTelemetry || null,
        selectedRoute: task.selectedRoute || null,
        preferredAssignedAgent: task.preferredAssignedAgent || null,
        lastRunLease: task.lastRunLease || null,
        recoveryStatus: task.recoveryStatus || null,
        recoveryReason: task.recoveryReason || null,
        startedAt: task.startedAt || null,
        completedAt: task.completedAt || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    rebuildAliases();
    return { ok: true, taskIds: normalized.tasks.map(t => t.id) };
  }

  /**
   * 状态流转（带合法性检查）
   */
  function transition(taskId, newStatus, meta = {}) {
    const resolvedTaskId = resolveTaskId(taskId);
    const task = resolvedTaskId ? tasks.get(resolvedTaskId) : null;
    if (!task) return { ok: false, error: 'task_not_found' };

    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return { ok: false, error: `invalid_transition: ${task.status} → ${newStatus}` };
    }

    const oldStatus = task.status;
    const now = Date.now();
    task.status = newStatus;
    task.updatedAt = now;

    if (meta.assignedAgent) task.assignedAgent = meta.assignedAgent;
    if (Object.prototype.hasOwnProperty.call(meta, 'assignedExecutor')) task.assignedExecutor = meta.assignedExecutor || null;
    if (Object.prototype.hasOwnProperty.call(meta, 'assignedRuntimeInstance')) task.assignedRuntimeInstance = meta.assignedRuntimeInstance || null;
    if (Object.prototype.hasOwnProperty.call(meta, 'result')) task.result = meta.result;
    if (meta.failureReason) task.failureReason = meta.failureReason;
    if (meta.failureClass) task.lastFailureClass = meta.failureClass;
    if (meta.selectedRoute) task.selectedRoute = meta.selectedRoute;
    if (meta.preferredAssignedAgent) task.preferredAssignedAgent = meta.preferredAssignedAgent;
    if (meta.runTelemetry) {
      task.runTelemetry = {
        ...(task.runTelemetry || {}),
        ...meta.runTelemetry,
        updatedAt: now,
      };
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'qualityFailureCount')) task.qualityFailureCount = meta.qualityFailureCount;
    if (Object.prototype.hasOwnProperty.call(meta, 'runtimeFailureCount')) task.runtimeFailureCount = meta.runtimeFailureCount;
    if (newStatus === 'dispatched') {
      task.startedAt = null;
      task.activeRunId = meta.runId || makeRunId(task.id, task.attempt || 1);
      if (meta.assignedAgent) task.assignedAgent = meta.assignedAgent;
      task.runLease = {
        runId: task.activeRunId,
        projectId,
        taskId: task.id,
        assignedAgent: task.assignedAgent || null,
        assignedRuntimeInstance: task.assignedRuntimeInstance || null,
        assignedExecutor: task.assignedExecutor || null,
        attempt: task.attempt || 1,
        status: 'dispatched',
        createdAt: now,
        lastHeartbeatAt: now,
        leaseExpiresAt: meta.leaseExpiresAt || (now + (meta.leaseTimeoutMs || 600_000)),
        artifactManifest: [],
        submissionAcked: false,
      };
      task.runTelemetry = meta.runTelemetry || null;
      task.recoveryStatus = null;
      task.recoveryReason = null;
    }
    if (newStatus === 'accepted' && task.runLease) {
      task.runLease.status = 'accepted';
      task.runLease.assignedAgent = task.assignedAgent || meta.assignedAgent || task.runLease.assignedAgent || null;
      task.runLease.assignedRuntimeInstance = task.assignedRuntimeInstance || meta.assignedRuntimeInstance || task.runLease.assignedRuntimeInstance || null;
      task.runLease.assignedExecutor = task.assignedExecutor || meta.assignedExecutor || task.runLease.assignedExecutor || null;
      task.runLease.lastHeartbeatAt = now;
      task.runLease.leaseExpiresAt = meta.leaseExpiresAt || (now + (meta.leaseTimeoutMs || 600_000));
    }
    if (newStatus === 'in_progress') {
      task.startedAt = now;
      if (task.runLease) {
        task.runLease.status = 'in_progress';
        task.runLease.startedAt = now;
        task.runLease.lastHeartbeatAt = now;
        task.runLease.leaseExpiresAt = meta.leaseExpiresAt || (now + (meta.leaseTimeoutMs || 600_000));
      }
    }
    if (newStatus === 'pending') {
      if (task.runLease) {
        task.lastRunLease = { ...task.runLease, status: 'expired', expiredAt: now };
      }
      task.runLease = null;
      task.runTelemetry = null;
      task.selectedRoute = null;
      task.assignedExecutor = null;
      task.assignedRuntimeInstance = null;
      task.activeRunId = null;
      task.startedAt = null;
      task.blockedAt = null;
      task.blockedReason = null;
      task.blockKind = null;
      task.nextActions = [];
    }
    if (['submitted', 'done', 'failed', 'blocked', 'cancelled'].includes(newStatus)) {
      if (task.runLease) {
        task.lastRunLease = {
          ...task.runLease,
          status: newStatus,
          lastHeartbeatAt: now,
          submissionAcked: newStatus === 'submitted' ? true : task.runLease.submissionAcked,
        };
      }
      task.runLease = null;
      if (newStatus !== 'submitted') task.runTelemetry = null;
      task.activeRunId = null;
    }
    if (newStatus === 'done') task.completedAt = now;
    if (newStatus === 'failed') task.failedAt = now;
    if (newStatus === 'blocked') {
      task.blockedAt = now;
      task.blockedReason = meta.blockedReason || meta.failureReason || task.blockedReason || '任务已阻塞';
      task.blockKind = meta.blockKind || task.blockKind || 'task_blocked';
      task.nextActions = Array.isArray(meta.nextActions) ? [...meta.nextActions] : (task.nextActions || []);
    }

    return { ok: true, taskId: task.id, from: oldStatus, to: newStatus, runId: task.activeRunId || meta.runId || null };
  }

  function blockTask(taskId, blockInfo = {}) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (task.status === 'blocked') {
      task.blockedReason = blockInfo.blockedReason || blockInfo.reason || task.blockedReason;
      task.blockKind = blockInfo.blockKind || task.blockKind;
      task.nextActions = Array.isArray(blockInfo.nextActions) ? [...blockInfo.nextActions] : (task.nextActions || []);
      task.lastFailureClass = blockInfo.failureClass || task.lastFailureClass;
      task.updatedAt = Date.now();
      return { ok: true, taskId: task.id, alreadyBlocked: true };
    }
    return transition(task.id, 'blocked', {
      blockedReason: blockInfo.blockedReason || blockInfo.reason,
      blockKind: blockInfo.blockKind,
      nextActions: blockInfo.nextActions,
      failureClass: blockInfo.failureClass,
      failureReason: blockInfo.blockedReason || blockInfo.reason,
      qualityFailureCount: blockInfo.qualityFailureCount,
      runtimeFailureCount: blockInfo.runtimeFailureCount,
    });
  }

  function completeCompositeParent(parentTaskId, result = null, meta = {}) {
    const parent = getTask(parentTaskId);
    if (!parent) return { ok: false, error: 'task_not_found' };
    if (!parent.isCompositeParent) return { ok: false, error: 'not_composite_parent' };
    const children = (parent.childTaskIds || []).map(id => getTask(id)).filter(Boolean);
    if (children.length !== (parent.childTaskIds || []).length) return { ok: false, error: 'child_task_missing' };
    const incomplete = children.filter(child => child.status !== 'done');
    if (incomplete.length > 0) {
      return { ok: false, error: 'children_not_done', incompleteTaskIds: incomplete.map(child => child.id) };
    }
    const now = Date.now();
    const oldStatus = parent.status;
    parent.status = 'done';
    parent.result = result;
    parent.completedAt = now;
    parent.updatedAt = now;
    parent.completedBy = meta.completedBy || 'composite_children';
    return { ok: true, taskId: parent.id, from: oldStatus, to: 'done' };
  }

  function completeRetryParent(parentTaskId, result = null, meta = {}) {
    const parent = getTask(parentTaskId);
    if (!parent) return { ok: false, error: 'task_not_found' };
    if (parent.isCompositeParent) return { ok: false, error: 'composite_parent_not_retry_parent' };
    if (parent.status === 'done') return { ok: true, taskId: parent.id, alreadyDone: true };

    const now = Date.now();
    const oldStatus = parent.status;
    parent.status = 'done';
    parent.result = result;
    parent.completedAt = now;
    parent.updatedAt = now;
    parent.completedBy = meta.completedBy || 'retry_child';
    parent.completedByTaskId = meta.completedByTaskId || null;
    parent.recoveredFromStatus = oldStatus;
    parent.recoveredAt = now;
    parent.recoveredBy = meta.recoveredBy || 'retry_child';
    parent.recoveryStatus = 'completed_by_retry';
    parent.recoveryReason = meta.recoveryReason || 'retry_child_completed';
    parent.activeRunId = null;
    parent.runLease = null;
    parent.runTelemetry = null;
    return { ok: true, taskId: parent.id, from: oldStatus, to: 'done' };
  }

  function validateRun(taskId, runId, workerAgent) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const assignedActor = task.assignedExecutor || task.assignedRuntimeInstance || task.assignedAgent;
    if (workerAgent && assignedActor && assignedActor !== workerAgent) {
      return {
        ok: false,
        error: 'wrong_assigned_agent',
        assignedAgent: task.assignedAgent,
        assignedRuntimeInstance: task.assignedRuntimeInstance || null,
        assignedExecutor: task.assignedExecutor || null,
      };
    }
    if (task.activeRunId && runId && task.activeRunId !== runId) {
      return { ok: false, error: 'stale_task_run', activeRunId: task.activeRunId, runId };
    }
    if (task.activeRunId && !runId) {
      return { ok: false, error: 'missing_run_id', activeRunId: task.activeRunId };
    }
    if (!task.activeRunId && runId && task.lastRunLease?.runId && task.lastRunLease.runId !== runId) {
      return { ok: false, error: 'stale_task_run', lastRunId: task.lastRunLease.runId, runId };
    }
    return { ok: true, task };
  }

  function recoverSubmission(taskId, result, meta = {}) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (!['cancelled', 'failed', 'in_progress', 'accepted', 'dispatched'].includes(task.status)) {
      return { ok: false, error: `cannot_recover_from_status: ${task.status}` };
    }
    const oldStatus = task.status;
    task.status = 'submitted';
    task.result = result;
    task.reviewResult = null;
    task.updatedAt = Date.now();
    if (task.runLease) {
      task.lastRunLease = { ...task.runLease, status: 'recovered', recoveredAt: task.updatedAt };
    }
    task.runLease = null;
    task.activeRunId = null;
    task.recoveredFromStatus = oldStatus;
    task.recoveredAt = task.updatedAt;
    task.recoveredBy = meta.recoveredBy || meta.fromAgent || 'human';
    task.recoveredRunId = meta.runId || result?.runId || null;
    task.recoveryStatus = 'recovered';
    task.recoveryReason = meta.recoveryReason || 'recover_submission';
    return { ok: true, taskId: task.id, from: oldStatus, to: 'submitted' };
  }

  function resetStaleRun(taskId, reason = 'lease_expired') {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (!['dispatched', 'accepted', 'in_progress'].includes(task.status)) {
      return { ok: false, error: `cannot_reset_from_status: ${task.status}` };
    }
    const now = Date.now();
    const oldStatus = task.status;
    if (task.runLease) {
      task.lastRunLease = { ...task.runLease, status: 'expired', expiredAt: now, recoveryReason: reason };
    }
    task.status = 'pending';
    task.activeRunId = null;
    task.runLease = null;
    task.startedAt = null;
    task.updatedAt = now;
    task.recoveryStatus = 'redispatch_ready';
    task.recoveryReason = reason;
    return { ok: true, taskId: task.id, from: oldStatus, to: 'pending', reason };
  }

  function markRecoveryStatus(taskId, status, reason = null) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    task.recoveryStatus = status;
    task.recoveryReason = reason;
    task.updatedAt = Date.now();
    return { ok: true, taskId: task.id, recoveryStatus: status, recoveryReason: reason };
  }

  function updateRunTelemetry(taskId, telemetry = {}) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (!task.runLease) return { ok: false, error: 'no_active_run' };
    const now = Date.now();
    task.runTelemetry = {
      ...(task.runTelemetry || {}),
      ...telemetry,
      updatedAt: now,
    };
    task.runLease.lastHeartbeatAt = telemetry.lastHeartbeatAt || now;
    task.updatedAt = now;
    return { ok: true, taskId: task.id };
  }

  /**
   * 依赖检查：哪些 pending 任务的所有前置已 done
   */
  function getDispatchable() {
    const allTasks = [...tasks.values()];
    return allTasks
      .filter(t => t.status === 'pending')
      .filter(t => !t.isCompositeParent)
      .filter(t => !t.unresolvedDependencies || t.unresolvedDependencies.length === 0)
      .filter(t => (t.dependencies || []).every(depRef => {
        const depId = resolveTaskId(depRef);
        const dep = depId ? tasks.get(depId) : null;
        return dep && dep.status === 'done';
      }));
  }

  /**
   * 项目是否全部完成
   */
  function isAllDone() {
    if (tasks.size === 0) return false;
    return [...tasks.values()].every(t => isTaskDoneForProjectCompletion(t));
  }

  function isTaskDoneForProjectCompletion(task) {
    if (task.status === 'done' || task.status === 'cancelled') return true;
    if (!task.parentTaskId) return false;
    const parentId = resolveTaskId(task.parentTaskId) || task.parentTaskId;
    const parent = tasks.get(parentId);
    return Boolean(parent && (parent.status === 'done' || parent.status === 'cancelled'));
  }

  function getTask(id) {
    const taskId = resolveTaskId(id);
    return taskId ? tasks.get(taskId) : undefined;
  }
  function getAllTasks() { return [...tasks.values()]; }

  /**
   * 阶段感知派发：只返回指定阶段中可派发的任务
   */
  function getDispatchableInPhase(phaseId) {
    return getDispatchable().filter(t => t.phaseId === phaseId);
  }

  /**
   * 获取某阶段的完成状态
   */
  function getPhaseStatus(phaseId) {
    const phaseTasks = [...tasks.values()].filter(t => t.phaseId === phaseId);
    return {
      total: phaseTasks.length,
      pending: phaseTasks.filter(t => t.status === 'pending').length,
      done: phaseTasks.filter(t => t.status === 'done').length,
      inProgress: phaseTasks.filter(t => !['pending', 'done', 'cancelled', 'failed'].includes(t.status)).length,
      failed: phaseTasks.filter(t => t.status === 'failed').length,
    };
  }

  /**
   * 获取整体 plan 进度（按阶段聚合）
   */
  function getPlanProgress() {
    const all = [...tasks.values()];
    const phaseIds = [...new Set(all.map(t => t.phaseId).filter(Boolean))];
    return {
      phases: phaseIds.map(id => ({ phaseId: id, ...getPhaseStatus(id) })),
      total: all.length,
      done: all.filter(t => t.status === 'done').length,
    };
  }

  function getStats() {
    const all = [...tasks.values()];
    return {
      total: all.length,
      pending: all.filter(t => t.status === 'pending').length,
      dispatched: all.filter(t => t.status === 'dispatched').length,
      inProgress: all.filter(t => ['accepted', 'in_progress'].includes(t.status)).length,
      submitted: all.filter(t => t.status === 'submitted').length,
      done: all.filter(t => t.status === 'done').length,
      failed: all.filter(t => t.status === 'failed').length,
      blocked: all.filter(t => t.status === 'blocked').length,
    };
  }

  /**
   * Restore tasks from persisted state (no status reset)
   */
  function loadTasks(taskArray) {
    tasks.clear();
    for (const task of taskArray) {
      const normalized = normalizeExistingTask(projectId, task);
      if (!isExecutableTaskInput(normalized)) continue;
      clearStaleRecoveredReview(normalized);
      tasks.set(normalized.id, normalized);
    }
    rebuildAliases();
    for (const task of tasks.values()) {
      const refs = Array.isArray(task.dependencyRefs) ? task.dependencyRefs : (task.dependencies || []);
      const deps = [];
      const unresolved = [];
      for (const ref of refs) {
        const depId = resolveTaskId(ref);
        if (depId) deps.push(depId);
        else unresolved.push(ref);
      }
      task.dependencies = deps;
      task.unresolvedDependencies = unresolved;
    }
  }

  function clearStaleRecoveredReview(task) {
    if (task.status !== 'submitted') return;
    if (task.recoveryStatus !== 'recovered') return;
    if (task.reviewResult?.passed !== false) return;
    const recoveredAt = Number(task.recoveredAt || 0);
    const reviewedAt = Number(task.reviewResult.reviewedAt || 0);
    if (!recoveredAt) return;
    if (!reviewedAt || reviewedAt < recoveredAt) {
      task.reviewResult = null;
    }
  }

  return {
    addTasks,
    addTasksChecked,
    transition,
    blockTask,
    completeCompositeParent,
    completeRetryParent,
    validateRun,
    recoverSubmission,
    resetStaleRun,
    markRecoveryStatus,
    updateRunTelemetry,
    resolveTaskId,
    getDispatchable,
    getDispatchableInPhase,
    getPhaseStatus,
    getPlanProgress,
    isAllDone,
    getTask,
    getAllTasks,
    getStats,
    loadTasks,
  };
}

/**
 * Restore a task board from serialized task array
 */
export function restoreTaskBoard(taskArray, projectId = 'legacy-project') {
  const board = createTaskBoard(projectId);
  board.loadTasks(taskArray);
  return board;
}

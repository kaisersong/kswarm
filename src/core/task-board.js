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

const VALID_TRANSITIONS = {
  pending: ['dispatched', 'failed', 'cancelled'],
  dispatched: ['accepted', 'pending', 'cancelled'],  // pending = 超时退回
  accepted: ['in_progress', 'pending', 'cancelled'],  // pending = agent 放弃
  in_progress: ['submitted', 'failed', 'cancelled'],
  submitted: ['done', 'in_progress', 'cancelled'],    // in_progress = PO 要求返工
  done: ['in_progress'],  // PO quality review can reopen for rework
  failed: ['pending'],  // 可重新派发
  cancelled: [],  // terminal
};

export function createTaskBoard() {
  const tasks = new Map();  // taskId → task

  /**
   * PO 提交任务列表（批量创建）
   */
  function addTasks(taskList) {
    for (const task of taskList) {
      // Skip if task already exists (prevents duplicate submissions resetting state)
      if (tasks.has(task.id)) continue;
      tasks.set(task.id, {
        ...task,
        status: 'pending',
        assignedAgent: task.assignedAgent || null,
        result: null,
        attempt: task.attempt || 1,
        maxAttempts: task.maxAttempts || 2,
        failureReason: task.failureReason || null,
        parentTaskId: task.parentTaskId || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return taskList.map(t => t.id);
  }

  /**
   * 状态流转（带合法性检查）
   */
  function transition(taskId, newStatus, meta = {}) {
    const task = tasks.get(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };

    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return { ok: false, error: `invalid_transition: ${task.status} → ${newStatus}` };
    }

    const oldStatus = task.status;
    task.status = newStatus;
    task.updatedAt = Date.now();

    if (meta.assignedAgent) task.assignedAgent = meta.assignedAgent;
    if (meta.result) task.result = meta.result;
    if (meta.failureReason) task.failureReason = meta.failureReason;
    if (newStatus === 'done') task.completedAt = Date.now();
    if (newStatus === 'failed') task.failedAt = Date.now();

    return { ok: true, taskId, from: oldStatus, to: newStatus };
  }

  /**
   * 依赖检查：哪些 pending 任务的所有前置已 done
   */
  function getDispatchable() {
    const allTasks = [...tasks.values()];
    return allTasks
      .filter(t => t.status === 'pending')
      .filter(t => (t.dependencies || []).every(depRef => {
        // Try by ID first, then by title match
        const dep = tasks.get(depRef) || allTasks.find(x => x.title === depRef);
        return dep && dep.status === 'done';
      }));
  }

  /**
   * 项目是否全部完成
   */
  function isAllDone() {
    if (tasks.size === 0) return false;
    return [...tasks.values()].every(t => t.status === 'done' || t.status === 'cancelled');
  }

  function getTask(id) { return tasks.get(id); }
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
    };
  }

  /**
   * Restore tasks from persisted state (no status reset)
   */
  function loadTasks(taskArray) {
    for (const task of taskArray) {
      tasks.set(task.id, task);
    }
  }

  return { addTasks, transition, getDispatchable, getDispatchableInPhase, getPhaseStatus, getPlanProgress, isAllDone, getTask, getAllTasks, getStats, loadTasks };
}

/**
 * Restore a task board from serialized task array
 */
export function restoreTaskBoard(taskArray) {
  const board = createTaskBoard();
  board.loadTasks(taskArray);
  return board;
}

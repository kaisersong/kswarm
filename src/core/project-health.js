const ACTIVE_STATUSES = new Set(['dispatched', 'accepted', 'in_progress']);

export function deriveProjectHealth({ project = {}, tasks = [], dispatchPlan = null } = {}) {
  const counts = countStatuses(tasks);
  const blockedTasks = tasks.filter(task => task.status === 'blocked');

  if (blockedTasks.length > 0) {
    return {
      state: 'blocked',
      gate: 'blocked_tasks',
      counts,
      reasons: blockedTasks.map(task => ({
        taskId: task.id,
        message: task.blockedReason || task.failureReason || '任务已阻塞',
        nextActions: task.nextActions || [],
      })),
    };
  }

  if (counts.submitted > 0) {
    return { state: 'needs_review', gate: 'submitted_tasks', counts, reasons: [] };
  }
  if (tasks.some(task => ACTIVE_STATUSES.has(task.status))) {
    return { state: 'running', gate: null, counts, reasons: [] };
  }
  if (dispatchPlan?.projectGate) {
    return {
      state: 'waiting',
      gate: dispatchPlan.projectGate,
      counts,
      reasons: [
        ...(dispatchPlan.skipped || []).map(item => ({ taskId: item.taskId, message: item.reason, agent: item.agent })),
        ...(dispatchPlan.blocked || []).map(item => ({ taskId: item.taskId, message: item.reason, dependencies: item.dependencies })),
      ],
    };
  }
  if (dispatchPlan?.dispatchedTasks?.length > 0) {
    return { state: 'dispatchable', gate: null, counts, reasons: [] };
  }
  if (tasks.length > 0 && tasks.every(task => ['done', 'cancelled'].includes(task.status))) {
    return { state: project.status === 'closed' ? 'closed' : 'complete', gate: null, counts, reasons: [] };
  }
  return { state: 'idle', gate: null, counts, reasons: [] };
}

function countStatuses(tasks) {
  return {
    total: tasks.length,
    pending: tasks.filter(task => task.status === 'pending').length,
    dispatched: tasks.filter(task => task.status === 'dispatched').length,
    accepted: tasks.filter(task => task.status === 'accepted').length,
    inProgress: tasks.filter(task => task.status === 'in_progress').length,
    submitted: tasks.filter(task => task.status === 'submitted').length,
    done: tasks.filter(task => task.status === 'done').length,
    failed: tasks.filter(task => task.status === 'failed').length,
    blocked: tasks.filter(task => task.status === 'blocked').length,
    cancelled: tasks.filter(task => task.status === 'cancelled').length,
  };
}

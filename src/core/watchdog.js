/**
 * KSwarm — Watchdog: Timeout Detection & Auto-Recovery
 *
 * Periodically scans all project task boards for stuck tasks.
 * Automatically retries or marks tasks as permanently failed.
 */

/**
 * @param {Object} opts
 * @param {Function} opts.listProjects - Returns array of { id, status }
 * @param {Function} opts.getBoard - (projectId) => TaskBoard instance
 * @param {Function} opts.onTimeout - (projectId, task, action) callback when timeout triggers
 * @param {number} [opts.intervalMs=60000] - Check interval
 * @param {number} [opts.timeoutMs=600000] - Task timeout (default 10 min)
 * @param {number} [opts.maxRetries=2] - Max retries before permanent failure
 */
export function createWatchdog(opts) {
  const {
    listProjects,
    getBoard,
    onTimeout,
    intervalMs = 60_000,
    timeoutMs = 600_000,
    maxRetries = 2,
  } = opts;

  const retryCounts = new Map(); // taskId → retry count
  let timer = null;

  function check(now = Date.now()) {
    const projects = listProjects();
    const actions = [];

    for (const project of projects) {
      if (project.status === 'closed' || project.status === 'delivered') continue;

      const board = getBoard(project.id);
      if (!board) continue;

      const tasks = board.getAllTasks();
      for (const task of tasks) {
        if (!['dispatched', 'accepted', 'in_progress'].includes(task.status)) continue;

        const elapsed = now - (task.updatedAt || task.createdAt || now);
        if (elapsed < timeoutMs) continue;

        // Task has timed out
        const retries = retryCounts.get(task.id) || 0;
        let action;

        if (retries >= maxRetries) {
          // Permanently fail
          action = handlePermanentFailure(board, task);
        } else {
          // Retry: reset to pending
          action = handleRetry(board, task, retries);
        }

        if (action) {
          actions.push({ projectId: project.id, taskId: task.id, ...action });
          if (onTimeout) onTimeout(project.id, task, action);
        }
      }
    }
    return actions;
  }

  function handleRetry(board, task, currentRetries) {
    let result;
    if (task.status === 'in_progress') {
      // in_progress → failed → pending
      result = board.transition(task.id, 'failed');
      if (!result.ok) return null;
      result = board.transition(task.id, 'pending');
    } else {
      // dispatched/accepted → pending (direct valid transition)
      result = board.transition(task.id, 'pending');
    }

    if (result.ok) {
      retryCounts.set(task.id, currentRetries + 1);
      return { action: 'retry', retry: currentRetries + 1 };
    }
    return null;
  }

  function handlePermanentFailure(board, task) {
    let result;
    if (task.status === 'in_progress') {
      result = board.transition(task.id, 'failed');
    } else {
      // dispatched/accepted → pending → failed is not valid
      // dispatched/accepted: transition to pending first, but we want failed
      // Actually for dispatched/accepted, we go pending then we just leave as pending
      // but since max retries exceeded, go in_progress path if possible
      // Simplest: just mark as cancelled for non-in_progress stuck tasks at max retries
      result = board.transition(task.id, 'cancelled');
    }
    if (result.ok) {
      return { action: 'failed_permanently', finalStatus: result.to };
    }
    return null;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => check(), intervalMs);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getRetryCount(taskId) {
    return retryCounts.get(taskId) || 0;
  }

  function resetRetries(taskId) {
    retryCounts.delete(taskId);
  }

  return { check, start, stop, getRetryCount, resetRetries };
}

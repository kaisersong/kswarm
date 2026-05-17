export const ACTIVE_TASK_STATUSES = new Set(['dispatched', 'accepted', 'in_progress']);

export function planDispatch({ projectId, tasks = [], allActiveTasks = [] } = {}) {
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const busyAgents = new Set(
    allActiveTasks
      .filter(task => ACTIVE_TASK_STATUSES.has(task.status))
      .map(task => task.assignedAgent)
      .filter(Boolean)
  );

  const dispatchedTasks = [];
  const skipped = [];
  const blocked = [];

  for (const task of tasks) {
    if (task.status !== 'pending' || task.isCompositeParent) continue;

    const pendingDeps = getPendingDependencies(task, taskMap);
    if (pendingDeps.length > 0) {
      blocked.push({ taskId: task.id, reason: 'dependency_pending', dependencies: pendingDeps });
      continue;
    }
    if (Array.isArray(task.unresolvedDependencies) && task.unresolvedDependencies.length > 0) {
      blocked.push({ taskId: task.id, reason: 'dependency_unresolved', dependencies: [...task.unresolvedDependencies] });
      continue;
    }
    if (!task.assignedAgent) {
      skipped.push({ taskId: task.id, reason: 'unassigned_task' });
      continue;
    }
    if (busyAgents.has(task.assignedAgent)) {
      skipped.push({ taskId: task.id, reason: 'agent_busy', agent: task.assignedAgent });
      continue;
    }

    dispatchedTasks.push(task);
    busyAgents.add(task.assignedAgent);
  }

  return {
    projectId,
    dispatchedTasks,
    skipped,
    blocked,
    projectGate: deriveProjectGate({ dispatchedTasks, skipped, blocked, tasks }),
  };
}

export function getActiveTasksAcrossBoards(boards) {
  const active = [];
  for (const [projectId, board] of boards.entries()) {
    for (const task of board.getAllTasks()) {
      if (ACTIVE_TASK_STATUSES.has(task.status)) active.push({ ...task, projectId: task.projectId || projectId });
    }
  }
  return active;
}

function getPendingDependencies(task, taskMap) {
  const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
  return deps.filter(depId => {
    const dep = taskMap.get(depId);
    return !dep || dep.status !== 'done';
  });
}

function deriveProjectGate({ dispatchedTasks, skipped, blocked, tasks }) {
  if (dispatchedTasks.length > 0) return null;
  const pendingCount = tasks.filter(task => task.status === 'pending' && !task.isCompositeParent).length;
  if (pendingCount === 0) return null;
  if (skipped.length > 0 && skipped.every(item => item.reason === 'agent_busy')) return 'waiting_for_busy_agents';
  if (blocked.length > 0 && skipped.length === 0) return 'waiting_for_dependencies';
  if (skipped.length > 0 && skipped.every(item => item.reason === 'unassigned_task')) return 'waiting_for_assignment';
  return null;
}

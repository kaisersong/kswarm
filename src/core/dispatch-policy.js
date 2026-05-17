import { planTaskRoute } from './capability-router.js';

export const ACTIVE_TASK_STATUSES = new Set(['dispatched', 'accepted', 'in_progress']);

export function planDispatch({ projectId, tasks = [], allActiveTasks = [], agentProfiles = null, executors = [], now = Date.now() } = {}) {
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const shouldCheckCapabilities = hasAgentProfiles(agentProfiles);
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
    if (shouldCheckCapabilities) {
      const availableAgents = listAgentProfiles(agentProfiles).filter(agent => !busyAgents.has(agent.id));
      const route = planTaskRoute({ task, agents: availableAgents, executors, now });
      if (!route.ok) {
        skipped.push({ taskId: task.id, reason: route.reason, agent: task.assignedAgent });
        continue;
      }
      const selectedAgent = route.selectedAgentId || route.selectedExecutorId;
      const routedTask = {
        ...task,
        assignedAgent: selectedAgent,
        preferredAssignedAgent: task.assignedAgent,
        selectedRoute: route,
      };
      dispatchedTasks.push(routedTask);
      busyAgents.add(selectedAgent);
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

function listAgentProfiles(agentProfiles) {
  if (agentProfiles instanceof Map) return [...agentProfiles.values()];
  if (Array.isArray(agentProfiles)) return agentProfiles;
  if (agentProfiles && typeof agentProfiles === 'object') return Object.values(agentProfiles);
  return [];
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
  if (skipped.length > 0 && skipped.every(item => isCapabilitySkipReason(item.reason))) return 'waiting_for_capable_agent';
  if (blocked.length > 0 && skipped.length === 0) return 'waiting_for_dependencies';
  if (skipped.length > 0 && skipped.every(item => item.reason === 'unassigned_task')) return 'waiting_for_assignment';
  return null;
}

function hasAgentProfiles(agentProfiles) {
  if (agentProfiles instanceof Map) return agentProfiles.size > 0;
  if (Array.isArray(agentProfiles)) return agentProfiles.length > 0;
  return Boolean(agentProfiles && typeof agentProfiles === 'object' && Object.keys(agentProfiles).length > 0);
}

function isCapabilitySkipReason(reason = '') {
  return (
    reason === 'agent_missing' ||
    reason.startsWith('runtime_') ||
    reason.startsWith('capability_missing:') ||
    reason.startsWith('output_missing:')
  );
}

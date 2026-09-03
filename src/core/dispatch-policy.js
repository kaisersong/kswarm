import { planTaskRoute } from './capability-router.js';
import { evaluateDependencySatisfaction } from './gate-evaluator.js';

export const ACTIVE_TASK_STATUSES = new Set(['dispatched', 'accepted', 'in_progress']);

export function planDispatch({
  projectId,
  tasks = [],
  allActiveTasks = [],
  agentProfiles = null,
  now = Date.now(),
  agentConcurrency = {},
  dependencyPolicies = {},
  gateEvaluationsByTaskId = {},
  consumedArtifactIdsByTaskId = {},
  consumedArtifactIdsByDependencyTaskId = {},
  currentGateFactsByTaskId = {},
  schemaV2 = false,
} = {}) {
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const shouldCheckCapabilities = hasAgentProfiles(agentProfiles);
  const activeCounts = countActiveTasksByAgent(
    allActiveTasks
      .filter(task => ACTIVE_TASK_STATUSES.has(task.status))
      .filter(task => !isReworkReadyForDispatch(task)),
  );

  const dispatchedTasks = [];
  const skipped = [];
  const blocked = [];

  for (const task of tasks) {
    if (!isDispatchCandidate(task) || task.isCompositeParent) continue;

    const taskConsumedArtifactIds = Object.prototype.hasOwnProperty.call(consumedArtifactIdsByTaskId, task.id)
      ? consumedArtifactIdsByTaskId[task.id]
      : consumedArtifactIdsByDependencyTaskId;
    const pendingDeps = getPendingDependencies(task, taskMap, {
      dependencyPolicies,
      gateEvaluationsByTaskId,
      consumedArtifactIdsByDependencyTaskId: taskConsumedArtifactIds,
      currentGateFactsByTaskId,
      schemaV2,
    });
    if (pendingDeps.length > 0) {
      blocked.push({ taskId: task.id, reason: 'dependency_pending', dependencies: pendingDeps });
      continue;
    }
    if (Array.isArray(task.unresolvedDependencies) && task.unresolvedDependencies.length > 0) {
      blocked.push({ taskId: task.id, reason: 'dependency_unresolved', dependencies: [...task.unresolvedDependencies] });
      continue;
    }
    if (Number.isFinite(task.retryNotBefore) && task.retryNotBefore > now) {
      blocked.push({ taskId: task.id, reason: 'retry_backoff', retryNotBefore: task.retryNotBefore });
      continue;
    }
    if (!task.assignedAgent) {
      skipped.push({ taskId: task.id, reason: 'unassigned_task' });
      continue;
    }
    if (isAgentAtCapacity(task.assignedAgent, activeCounts, agentConcurrency)) {
      skipped.push({
        taskId: task.id,
        reason: getAgentLimit(task.assignedAgent, agentConcurrency) > 1 ? 'xiaok_capacity_full' : 'agent_busy',
        agent: task.assignedAgent,
      });
      continue;
    }
    if (shouldCheckCapabilities) {
      const availableAgents = listAgentProfiles(agentProfiles).filter(agent => !isAgentAtCapacity(agent.id, activeCounts, agentConcurrency));
      const route = planTaskRoute({ task, agents: availableAgents, now });
      if (!route.ok) {
        skipped.push({ taskId: task.id, reason: route.reason, agent: task.assignedAgent });
        continue;
      }
      const selectedAgent = route.selectedAgentId;
      const routedTask = {
        ...task,
        assignedAgent: selectedAgent || task.assignedAgent,
        assignedExecutor: null,
        preferredAssignedAgent: task.assignedAgent,
        selectedRoute: route,
      };
      dispatchedTasks.push(routedTask);
      incrementActiveCount(activeCounts, selectedAgent || task.assignedAgent);
      continue;
    }

    dispatchedTasks.push(task);
    incrementActiveCount(activeCounts, task.assignedAgent);
  }

  return {
    projectId,
    dispatchedTasks,
    skipped,
    blocked,
    projectGate: deriveProjectGate({ dispatchedTasks, skipped, blocked, tasks }),
  };
}

function countActiveTasksByAgent(activeTasks) {
  const counts = new Map();
  for (const task of activeTasks) {
    if (!task.assignedAgent) continue;
    incrementActiveCount(counts, task.assignedAgent);
  }
  return counts;
}

function incrementActiveCount(counts, agentId) {
  if (!agentId) return;
  counts.set(agentId, (counts.get(agentId) || 0) + 1);
}

function getAgentLimit(agentId, agentConcurrency = {}) {
  const limit = Number(agentConcurrency?.[agentId] || 1);
  return Number.isFinite(limit) && limit > 0 ? limit : 1;
}

function isAgentAtCapacity(agentId, activeCounts, agentConcurrency) {
  if (!agentId) return false;
  return (activeCounts.get(agentId) || 0) >= getAgentLimit(agentId, agentConcurrency);
}

export function isReworkReadyForDispatch(task = {}) {
  const hasQualityFailureContext = (
    task.reviewResult?.passed === false ||
    Number(task.qualityFailureCount || 0) > 0 ||
    task.lastFailureClass === 'quality_content_failed' ||
    task.lastFailureClass === 'quality_evidence_missing'
  );

  if (
    task.status === 'blocked' &&
    task.blockKind === 'quality_gate_blocked' &&
    !task.activeRunId &&
    !task.runLease
  ) {
    return hasQualityFailureContext;
  }

  return (
    task.status === 'in_progress' &&
    !task.activeRunId &&
    !task.runLease &&
    hasQualityFailureContext
  );
}

function isDispatchCandidate(task = {}) {
  return task.status === 'pending' || isReworkReadyForDispatch(task);
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

/**
 * 唯一依赖判定入口（design §8.2）：委托 gate-evaluator.js:evaluateDependencySatisfaction，
 * 不再自行维护 `dep.status === 'done'` 的私有判断。
 *
 * 返回值保持向后兼容：依赖任务 ID 的数组（不满足的依赖）。
 */
function getPendingDependencies(task, taskMap, {
  dependencyPolicies = {},
  gateEvaluationsByTaskId = {},
  consumedArtifactIdsByDependencyTaskId = {},
  currentGateFactsByTaskId = {},
  schemaV2 = false,
} = {}) {
  const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
  if (deps.length === 0) return [];

  const dependencyTasks = deps
    .map(depId => taskMap.get(depId))
    .filter(Boolean);

  const evaluation = evaluateDependencySatisfaction({
    task,
    dependencyTasks,
    dependencyPolicies,
    gateEvaluationsByTaskId,
    consumedArtifactIdsByDependencyTaskId,
    currentGateFactsByTaskId,
    schemaV2,
  });

  return evaluation.blockedDependencies.map(b => b.dependencyTaskId);
}

function deriveProjectGate({ dispatchedTasks, skipped, blocked, tasks }) {
  if (dispatchedTasks.length > 0) return null;
  const pendingCount = tasks.filter(task => task.status === 'pending' && !task.isCompositeParent).length;
  if (pendingCount === 0) return null;
  if (skipped.length > 0 && skipped.every(item => item.reason === 'xiaok_capacity_full')) return 'waiting_for_xiaok_capacity';
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

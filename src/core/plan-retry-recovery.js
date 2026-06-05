import { appendQualityPlanningGuidance } from './quality-rules.js';
import { isProjectOwnerEligible } from './roles.js';

const PRE_APPROVAL_STATUSES = new Set(['draft', 'created', 'planning']);
const FINAL_STATUSES = new Set(['delivered', 'closed']);
const XIAOK_PO_SEED_ID = 'xiaok-po';
const XIAOK_LEGACY_SEED_ID = 'xiaok';
const CLI_XIAOK_ID = 'cli-xiaok';
const DESKTOP_AGENT_RUNTIME_SOURCE = 'desktop-agent-runtime';

function taskCount(tasks) {
  return Array.isArray(tasks) ? tasks.length : 0;
}

function hasPlan(project) {
  return Boolean(project?.plan);
}

function isArchived(agent) {
  return agent?.archivedAt != null;
}

function isProjectOwner(agent) {
  return isProjectOwnerEligible(agent);
}

function isXiaokRuntime(agent) {
  return agent?.runtimeType === 'xiaok' || agent?.id === XIAOK_PO_SEED_ID || agent?.id === CLI_XIAOK_ID;
}

function isDesktopRuntimeAgent(agent) {
  return agent?.runtimeSource === DESKTOP_AGENT_RUNTIME_SOURCE || agent?.id === XIAOK_PO_SEED_ID;
}

function isStaleXiaokRuntimeWithoutExecutor(agent) {
  return Boolean(
    agent &&
    isXiaokRuntime(agent) &&
    !agent.runtimePath &&
    !isDesktopRuntimeAgent(agent)
  );
}

function isUsableCurrentPo(agent) {
  return Boolean(agent) &&
    !isArchived(agent) &&
    agent.id !== XIAOK_LEGACY_SEED_ID &&
    !isStaleXiaokRuntimeWithoutExecutor(agent) &&
    isProjectOwner(agent);
}

function currentPoSelectionSource(project) {
  return project?.agentSelection?.poAgent?.source || null;
}

function isPreservableExplicitCurrentPo(project, agent) {
  return currentPoSelectionSource(project) === 'explicit_user' &&
    Boolean(agent) &&
    !isArchived(agent) &&
    agent.id !== XIAOK_LEGACY_SEED_ID &&
    isProjectOwner(agent);
}

function activeAgents(agents) {
  return Array.isArray(agents) ? agents.filter(agent => !isArchived(agent)) : [];
}

function findPreferredPoAgent(agents) {
  return (
    agents.find(agent => agent.id === XIAOK_PO_SEED_ID && isProjectOwner(agent)) ||
    agents.find(agent => agent.id === CLI_XIAOK_ID && isProjectOwner(agent)) ||
    agents.find(agent => agent.id !== XIAOK_LEGACY_SEED_ID && isXiaokRuntime(agent) && !isStaleXiaokRuntimeWithoutExecutor(agent) && isProjectOwner(agent)) ||
    agents.find(agent => agent.id === XIAOK_LEGACY_SEED_ID && isProjectOwner(agent)) ||
    agents.find(isProjectOwner) ||
    null
  );
}

export function isInterruptedPlanProject(project, tasks = []) {
  return project?.status === 'active' && !hasPlan(project) && taskCount(tasks) === 0;
}

export function canRetryPlanForProject(project, tasks = []) {
  const status = project?.status;
  if (!status || FINAL_STATUSES.has(status)) return false;
  if (PRE_APPROVAL_STATUSES.has(status)) return true;
  return isInterruptedPlanProject(project, tasks);
}

export function normalizeProjectForPlanRetry(project, tasks = []) {
  if (!project) return { ok: false, error: 'project_not_found' };
  if (!canRetryPlanForProject(project, tasks)) {
    return { ok: false, error: 'plan_retry_not_allowed' };
  }

  const previousStatus = project.status;
  project.plan = null;
  project.planArtifact = null;

  if (project.status === 'planning' || isInterruptedPlanProject({ ...project, status: previousStatus }, tasks)) {
    project.status = 'created';
  }

  return {
    ok: true,
    previousStatus,
    status: project.status,
    normalizedStatus: previousStatus !== project.status,
  };
}

export function resolvePlanRetryPoAgent(project, agents = []) {
  const previousPoAgent = project?.poAgent || null;
  const active = activeAgents(agents);
  const current = active.find(agent => agent.id === previousPoAgent) || null;

  if (isPreservableExplicitCurrentPo(project, current)) {
    return {
      poAgent: current.id,
      previousPoAgent,
      changed: false,
      reason: 'explicit_user_po_preserved',
    };
  }

  if (isUsableCurrentPo(current)) {
    return {
      poAgent: current.id,
      previousPoAgent,
      changed: false,
      reason: 'current_po_usable',
    };
  }

  const preferred = findPreferredPoAgent(active);
  const poAgent = preferred?.id || previousPoAgent;
  const changed = Boolean(poAgent && poAgent !== previousPoAgent);

  return {
    poAgent,
    previousPoAgent,
    changed,
    reason: changed ? 'preferred_xiaok_po' : 'no_replacement_available',
  };
}

export function buildPlanRetryAssignPoIntent(project) {
  const projectId = project?.id;
  return {
    taskId: projectId,
    threadId: `thread-${projectId}`,
    payload: {
      projectId,
      projectName: project?.name || '',
      name: project?.name || '',
      goal: project?.goal || '',
      requirements: project?.requirements || '',
      planningGuidance: appendQualityPlanningGuidance(project?.planningGuidance || '', project?.qualityPlanningGuidance || ''),
      members: Array.isArray(project?.members) ? project.members : [],
    },
  };
}

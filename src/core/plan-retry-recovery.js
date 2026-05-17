const PRE_APPROVAL_STATUSES = new Set(['draft', 'created', 'planning']);
const FINAL_STATUSES = new Set(['delivered', 'closed']);

function taskCount(tasks) {
  return Array.isArray(tasks) ? tasks.length : 0;
}

function hasPlan(project) {
  return Boolean(project?.plan);
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

const DESKTOP_SEED_IDS = new Set(['xiaok-po', 'xiaok-worker']);

export function classifyExecutionBoundary(agent = {}) {
  if (
    agent.runtimeSource === 'desktop-agent-runtime' ||
    (agent.runtimeType === 'xiaok' && DESKTOP_SEED_IDS.has(agent.id) && !agent.runtimePath)
  ) {
    return { kind: 'desktop_agent_runtime', localAutoWorkerAllowed: false };
  }
  return { kind: 'local_or_external_agent_adapter', localAutoWorkerAllowed: true };
}

export function canSpawnAutoWorkerForTask({ agent, taskKind = 'user_task', allowMaintenanceWorker = false } = {}) {
  const boundary = classifyExecutionBoundary(agent);
  if (boundary.localAutoWorkerAllowed) return { ok: true, boundary };
  if (taskKind === 'maintenance_job' && allowMaintenanceWorker) return { ok: true, boundary };
  return { ok: false, error: 'desktop_runtime_required', boundary };
}

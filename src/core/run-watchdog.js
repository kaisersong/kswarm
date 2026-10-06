const ACTIVE_STATUSES = new Set(['dispatched', 'accepted', 'in_progress']);

export function planStalledRunActions({
  projectId,
  tasks = [],
  now = Date.now(),
  heartbeatTimeoutMs = 300_000,
  noOutputWarningMs = 180_000,
  maxRunMs = 1_200_000,
  maxResearchRunMs = 3_600_000,
  maxQueueMs = 3_600_000,
  systemSuspended = false,
} = {}) {
  const actions = [];

  if (systemSuspended) return actions;

  for (const task of tasks) {
    if (!ACTIVE_STATUSES.has(task.status)) continue;
    if (task.suspendedAt) continue;
    if (isWorkflowOwnedTask(task)) continue;
    const runId = task.activeRunId || task.runLease?.runId;
    if (!runId) continue;

    const lease = task.runLease || {};
    const telemetry = task.runTelemetry || {};
    const queued = task.status === 'accepted' && telemetry.executionState === 'queued';
    const queuedAt = lease.createdAt || task.createdAt || now;
    const startedAt = task.startedAt || lease.startedAt || telemetry.startedAt || queuedAt;
    const lastHeartbeatAt = telemetry.lastHeartbeatAt || lease.lastHeartbeatAt || startedAt;
    const lastOutputAt = latestTimestamp(
      telemetry.lastStdoutAt,
      telemetry.lastStderrAt,
      telemetry.lastArtifactAt,
      lease.artifactManifest?.length > 0 ? lease.lastHeartbeatAt : null,
    );

    const logicalAgentId = task.assignedAgent || lease.assignedAgent || null;
    const runtimeAgentId = task.assignedRuntimeInstance || lease.assignedRuntimeInstance || logicalAgentId;
    const base = {
      projectId,
      taskId: task.id,
      runId,
      agentId: runtimeAgentId,
      logicalAgentId,
    };

    const missingHeartbeat = now - lastHeartbeatAt >= heartbeatTimeoutMs;
    const exceededQueue = queued && now - queuedAt >= maxQueueMs;
    const externalResearch = task.evidenceContract?.version === 1
      && task.evidenceContract.kind === 'external_source_v1'
      && task.evidenceContract.required === true;
    const runBudget = externalResearch ? maxResearchRunMs : maxRunMs;
    const exceededMaxRun = !queued && now - startedAt >= runBudget;
    if (missingHeartbeat || exceededMaxRun || exceededQueue) {
      const reason = exceededQueue ? 'queue_timeout' : exceededMaxRun ? 'max_run_time' : 'heartbeat_timeout';
      actions.push({ ...base, type: 'mark_runtime_stalled', reason });
      actions.push({ ...base, type: 'request_cancel_run', reason });
      continue;
    }

    if (queued) continue;
    const reference = lastOutputAt || startedAt;
    if (now - reference >= noOutputWarningMs) {
      actions.push({ ...base, type: 'stalled_warning', reason: 'no_output' });
    }
  }

  return actions;
}

function latestTimestamp(...values) {
  const timestamps = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function isWorkflowOwnedTask(task) {
  if (!task || typeof task !== 'object') return false;
  if (task.assignedExecutor === 'workflow') return true;
  if (task.execution?.strategy === 'workflow') return true;
  const runId = task.activeRunId || task.runLease?.runId || '';
  return typeof runId === 'string' && runId.startsWith('workflow-');
}

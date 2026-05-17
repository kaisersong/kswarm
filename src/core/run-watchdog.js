const ACTIVE_STATUSES = new Set(['dispatched', 'accepted', 'in_progress']);

export function planStalledRunActions({
  projectId,
  tasks = [],
  now = Date.now(),
  heartbeatTimeoutMs = 120_000,
  noOutputWarningMs = 180_000,
  maxRunMs = 900_000,
} = {}) {
  const actions = [];

  for (const task of tasks) {
    if (!ACTIVE_STATUSES.has(task.status)) continue;
    const runId = task.activeRunId || task.runLease?.runId;
    if (!runId) continue;

    const lease = task.runLease || {};
    const telemetry = task.runTelemetry || {};
    const startedAt = telemetry.startedAt || lease.createdAt || task.updatedAt || task.createdAt || now;
    const lastHeartbeatAt = telemetry.lastHeartbeatAt || lease.lastHeartbeatAt || startedAt;
    const lastOutputAt = latestTimestamp(
      telemetry.lastStdoutAt,
      telemetry.lastStderrAt,
      telemetry.lastArtifactAt,
      lease.artifactManifest?.length > 0 ? lease.lastHeartbeatAt : null,
    );

    const base = {
      projectId,
      taskId: task.id,
      runId,
      agentId: task.assignedAgent || lease.assignedAgent || null,
    };

    const missingHeartbeat = now - lastHeartbeatAt >= heartbeatTimeoutMs;
    const exceededMaxRun = now - startedAt >= maxRunMs;
    if (missingHeartbeat || exceededMaxRun) {
      const reason = exceededMaxRun ? 'max_run_time' : 'heartbeat_timeout';
      actions.push({ ...base, type: 'mark_runtime_stalled', reason });
      actions.push({ ...base, type: 'request_cancel_run', reason });
      continue;
    }

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

export const XIAOK_PO_AGENT_ID = 'xiaok-po';
export const XIAOK_WORKER_AGENT_ID = 'xiaok-worker';
export const DEFAULT_MAX_WORKER_INSTANCES = 3;
export const DEFAULT_MAX_PO_PROJECT_INSTANCES = 5;

export function createRuntimeInstancePool(options = {}) {
  const maxWorkerInstances = options.maxWorkerInstances ?? DEFAULT_MAX_WORKER_INSTANCES;
  const maxPoProjectInstances = options.maxPoProjectInstances ?? DEFAULT_MAX_PO_PROJECT_INSTANCES;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const instances = new Map();
  let sequence = 0;

  function nextInstanceId(logicalAgentId, role, projectId = null) {
    sequence += 1;
    if (role === 'project_owner' && projectId) {
      return `${logicalAgentId}@proj-${projectId}`;
    }
    return `${logicalAgentId}@inst-${sequence.toString(36)}`;
  }

  function isWorkerPooled(logicalAgentId) {
    return logicalAgentId === XIAOK_WORKER_AGENT_ID;
  }

  function isPoPooled(logicalAgentId) {
    return logicalAgentId === XIAOK_PO_AGENT_ID;
  }

  function activeInstancesFor(logicalAgentId, role = null) {
    return [...instances.values()].filter(instance => (
      instance.logicalAgentId === logicalAgentId &&
      (!role || instance.role === role) &&
      instance.status !== 'offline' &&
      instance.status !== 'failed'
    ));
  }

  function createInstance({ logicalAgentId, role, projectId = null }) {
    const instance = {
      instanceId: nextInstanceId(logicalAgentId, role, projectId),
      logicalAgentId,
      role,
      projectId,
      status: 'starting',
      pid: null,
      runtimeId: null,
      currentTaskId: null,
      startedAt: now(),
      lastHeartbeatAt: null,
      failureReason: null,
    };
    instances.set(instance.instanceId, instance);
    return instance;
  }

  function ensureWorkerInstance(logicalAgentId) {
    if (!isWorkerPooled(logicalAgentId)) {
      return { ok: false, error: 'not_pooled_agent', logicalAgentId };
    }

    const existing = activeInstancesFor(logicalAgentId, 'worker');
    const idle = existing.find(instance => instance.status === 'idle');
    if (idle) return { ok: true, instanceId: idle.instanceId, instance: idle, created: false };

    if (existing.length >= maxWorkerInstances) {
      return { ok: false, error: 'capacity_full', logicalAgentId, limit: maxWorkerInstances };
    }

    const instance = createInstance({ logicalAgentId, role: 'worker' });
    return { ok: true, instanceId: instance.instanceId, instance, created: true };
  }

  function ensureProjectPoInstance(logicalAgentId, projectId) {
    if (!isPoPooled(logicalAgentId)) {
      return { ok: false, error: 'not_pooled_agent', logicalAgentId };
    }
    if (!projectId) return { ok: false, error: 'missing_project_id', logicalAgentId };

    const existing = activeInstancesFor(logicalAgentId, 'project_owner');
    const current = existing.find(instance => instance.projectId === projectId);
    if (current) return { ok: true, instanceId: current.instanceId, instance: current, created: false };

    if (existing.length >= maxPoProjectInstances) {
      return { ok: false, error: 'capacity_full', logicalAgentId, projectId, limit: maxPoProjectInstances };
    }

    const instance = createInstance({ logicalAgentId, role: 'project_owner', projectId });
    return { ok: true, instanceId: instance.instanceId, instance, created: true };
  }

  function patchInstance(instanceId, patch) {
    const instance = instances.get(instanceId);
    if (!instance) return { ok: false, error: 'instance_not_found', instanceId };
    Object.assign(instance, patch, { lastHeartbeatAt: now() });
    return { ok: true, instance };
  }

  function markInstanceWorking(instanceId, meta = {}) {
    return patchInstance(instanceId, {
      status: 'working',
      currentTaskId: meta.taskId || null,
      failureReason: null,
    });
  }

  function markInstanceIdle(instanceId) {
    return patchInstance(instanceId, {
      status: 'idle',
      currentTaskId: null,
      failureReason: null,
    });
  }

  function markInstanceOnline(instanceId, meta = {}) {
    return patchInstance(instanceId, {
      status: meta.status || 'idle',
      pid: meta.pid ?? instances.get(instanceId)?.pid ?? null,
      runtimeId: meta.runtimeId ?? instances.get(instanceId)?.runtimeId ?? null,
      failureReason: null,
    });
  }

  function markInstanceFailed(instanceId, reason = 'runtime_instance_failed') {
    return patchInstance(instanceId, {
      status: 'failed',
      currentTaskId: null,
      failureReason: reason,
    });
  }

  function markInstanceOffline(instanceId) {
    return patchInstance(instanceId, {
      status: 'offline',
      currentTaskId: null,
    });
  }

  function getAgentConcurrency() {
    return { [XIAOK_WORKER_AGENT_ID]: maxWorkerInstances };
  }

  function getInstance(instanceId) {
    return instances.get(instanceId) || null;
  }

  function listInstances() {
    return [...instances.values()].map(instance => ({ ...instance }));
  }

  function summarizeByAgent() {
    const summary = {};
    for (const instance of instances.values()) {
      const item = summary[instance.logicalAgentId] || {
        logicalAgentId: instance.logicalAgentId,
        total: 0,
        starting: 0,
        idle: 0,
        working: 0,
        waiting: 0,
        failed: 0,
        offline: 0,
      };
      item.total += 1;
      item[instance.status] = (item[instance.status] || 0) + 1;
      summary[instance.logicalAgentId] = item;
    }
    return summary;
  }

  return {
    ensureWorkerInstance,
    ensureProjectPoInstance,
    getAgentConcurrency,
    markInstanceWorking,
    markInstanceIdle,
    markInstanceOnline,
    markInstanceFailed,
    markInstanceOffline,
    getInstance,
    listInstances,
    summarizeByAgent,
  };
}

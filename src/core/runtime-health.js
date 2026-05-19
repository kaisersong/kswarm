const DEFAULT_COOLDOWNS = [0, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const ROUTABLE_STATES = new Set(['healthy']);
const TASK_LEVEL_FAILURE_CLASSES = new Set(['model_empty_output']);

export function createUnknownRuntimeHealth(overrides = {}) {
  return {
    state: 'unknown',
    checkedAt: null,
    lastProbeAt: null,
    lastProbeOk: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureClass: null,
    lastError: null,
    consecutiveRuntimeFailures: 0,
    cooldownUntil: null,
    childPid: null,
    activeRunId: null,
    activeTaskId: null,
    startedAt: null,
    lastStdoutAt: null,
    lastStderrAt: null,
    lastArtifactAt: null,
    outputCapabilities: [],
    taskCapabilities: [],
    probe: null,
    ...overrides,
  };
}

export function recordProbeResult(current = {}, probe = {}, now = Date.now()) {
  const base = normalizeHealth(current);
  let state = 'degraded';

  if (probe.commandOk && probe.generationOk) {
    state = 'healthy';
  } else if (probe.commandOk && probe.generationSkipped) {
    state = 'limited';
  }

  return {
    ...base,
    state,
    checkedAt: now,
    lastProbeAt: now,
    lastProbeOk: state === 'healthy' || state === 'limited',
    lastError: probe.error || null,
    lastFailureAt: state === 'degraded' ? now : base.lastFailureAt,
    lastFailureClass: state === 'degraded' ? (probe.failureClass || 'runtime_probe_failed') : base.lastFailureClass,
    consecutiveRuntimeFailures: state === 'healthy' ? 0 : base.consecutiveRuntimeFailures,
    cooldownUntil: state === 'healthy' ? null : base.cooldownUntil,
    outputCapabilities: mergeCapabilities(base.outputCapabilities, probe.outputCapabilities),
    taskCapabilities: mergeCapabilities(base.taskCapabilities, probe.taskCapabilities),
    probe: {
      commandOk: Boolean(probe.commandOk),
      generationOk: probe.generationOk === undefined ? null : Boolean(probe.generationOk),
      generationSkipped: Boolean(probe.generationSkipped),
      durationMs: typeof probe.durationMs === 'number' ? probe.durationMs : null,
      error: probe.error || null,
    },
  };
}

export function recordRuntimeFailure(current = {}, failure = {}, now = Date.now(), options = {}) {
  const base = normalizeHealth(current);
  const failureClass = failure.failureClass || 'agent_error';

  if (TASK_LEVEL_FAILURE_CLASSES.has(failureClass)) {
    return {
      ...base,
      checkedAt: now,
      lastFailureAt: now,
      lastFailureClass: failureClass,
      lastError: failure.error || failure.errorMessage || failure.feedback || null,
    };
  }

  const count = (base.consecutiveRuntimeFailures || 0) + 1;
  const cooldownThreshold = options.cooldownThreshold ?? 2;
  const cooldownUntil = count >= cooldownThreshold
    ? now + cooldownForCount(count, options.cooldowns)
    : null;

  return {
    ...base,
    state: cooldownUntil ? 'cooldown' : failureClass === 'runtime_stalled' ? 'stalled' : 'degraded',
    checkedAt: now,
    lastFailureAt: now,
    lastFailureClass: failureClass,
    lastError: failure.error || failure.errorMessage || failure.feedback || null,
    consecutiveRuntimeFailures: count,
    cooldownUntil,
  };
}

export function recordRuntimeSuccess(current = {}, success = {}, now = Date.now()) {
  const base = normalizeHealth(current);
  return {
    ...base,
    state: 'healthy',
    checkedAt: now,
    lastSuccessAt: now,
    lastFailureAt: null,
    lastFailureClass: null,
    lastError: null,
    consecutiveRuntimeFailures: 0,
    cooldownUntil: null,
    activeTaskId: success.taskId || null,
    activeRunId: success.runId || null,
    outputCapabilities: mergeCapabilities(base.outputCapabilities, success.outputCapabilities),
    taskCapabilities: mergeCapabilities(base.taskCapabilities, success.taskCapabilities),
  };
}

export function isRoutable(agent = {}, requiredCapabilities = [], requiredOutputs = [], now = Date.now()) {
  const health = normalizeHealth(agent.runtimeHealth);
  const state = health.state || 'unknown';

  if (state === 'cooldown' && (!health.cooldownUntil || now < health.cooldownUntil)) {
    return { ok: false, reason: 'runtime_cooldown' };
  }
  if (!ROUTABLE_STATES.has(state)) {
    return { ok: false, reason: `runtime_${state}` };
  }

  const taskCapabilities = new Set(normalizeCapabilities(health.taskCapabilities));
  for (const capability of normalizeCapabilities(requiredCapabilities)) {
    if (!taskCapabilities.has(capability)) {
      return { ok: false, reason: `capability_missing:${capability}` };
    }
  }

  const outputCapabilities = new Set(normalizeCapabilities(health.outputCapabilities));
  for (const output of normalizeOutputs(requiredOutputs)) {
    if (!outputCapabilities.has(output)) {
      return { ok: false, reason: `output_missing:${output}` };
    }
  }

  return { ok: true, reason: null };
}

function normalizeHealth(health) {
  return createUnknownRuntimeHealth(health && typeof health === 'object' ? health : {});
}

function cooldownForCount(count, configured = DEFAULT_COOLDOWNS) {
  const table = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_COOLDOWNS;
  return table[Math.min(count, table.length - 1)] || table[table.length - 1] || DEFAULT_COOLDOWNS[1];
}

function mergeCapabilities(a = [], b = []) {
  return [...new Set([...normalizeCapabilities(a), ...normalizeCapabilities(b)])];
}

function normalizeCapabilities(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function normalizeOutputs(outputs = []) {
  if (!Array.isArray(outputs)) return [];
  return outputs
    .map(output => {
      if (typeof output === 'string') return output;
      return output?.type || output?.format || output?.kind || '';
    })
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

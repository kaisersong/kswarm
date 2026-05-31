import { canonicalizeOutputType, normalizeOutputTypes } from './output-types.js';

const DEFAULT_PRESENCE_MAX_AGE_MS = 120_000;
const DESKTOP_RUNTIME_SOURCE = 'desktop-agent-runtime';
const DESKTOP_SEED_AGENT_IDS = new Set(['xiaok-po', 'xiaok-worker']);

export function normalizeReadinessProbeResult(input = {}, now = Date.now()) {
  const ok = Boolean(input.ok);
  return {
    agentId: normalizeId(input.agentId || input.participantId || input.targetParticipantId),
    participantId: normalizeId(input.participantId || input.agentId || input.targetParticipantId),
    probeId: input.probeId || null,
    ok,
    reason: ok ? null : normalizeReason(input.reason || input.error || input.failureClass || 'readiness_probe_failed'),
    checkedAt: Number(input.checkedAt || now),
    expiresAt: Number(input.expiresAt || 0) || null,
    runtimeSource: input.runtimeSource || null,
    taskCapabilities: normalizeList(input.taskCapabilities || input.capabilities),
    outputCapabilities: normalizeList(input.outputCapabilities),
  };
}

export function classifyAgentReadiness(agent, options = {}) {
  const now = Number(options.now || Date.now());
  const role = normalizeId(options.role);
  const selectedBy = options.selectedBy || options.source || null;
  const agentId = normalizeId(agent?.id || options.agentId);
  const base = {
    agentId: agentId || null,
    role: role || null,
    selectedBy,
    ready: false,
    readiness: 'unavailable',
    reason: null,
    checks: [],
    participantId: agentId || null,
    capacity: normalizeCapacity(options.capacity),
    canCreateRuntimeInstance: normalizeCanCreateRuntimeInstance(options.capacity),
  };

  if (!agent) return fail(base, 'agent_missing');
  if (agent.archivedAt != null) return fail(base, 'agent_archived');
  if (role && !hasRole(agent, role)) return fail(base, `role_missing:${role}`);

  base.checks.push('agent_exists');
  if (role) base.checks.push('role_match');

  const runtimeHealth = normalizeRuntimeHealth(agent.runtimeHealth);
  const runtimeState = normalizeId(runtimeHealth.state || agent.status || 'unknown');
  if (runtimeState === 'cooldown') return fail(base, 'runtime_cooldown', 'unavailable');
  if (runtimeState && !['healthy', 'idle', 'unknown', 'starting'].includes(runtimeState)) {
    return fail(base, `runtime_${runtimeState}`, runtimeState === 'starting' ? 'starting' : 'unavailable');
  }
  if (runtimeState === 'healthy' || runtimeState === 'idle') base.checks.push('runtime_healthy');

  const taskCapabilities = capabilitySource(runtimeHealth.taskCapabilities, agent.taskCapabilities || agent.capabilities);
  for (const capability of normalizeRequiredCapabilities(options.requiredCapabilities)) {
    if (!taskCapabilities.has(capability)) return fail(base, `capability_missing:${capability}`, 'limited');
  }

  const outputCapabilities = outputCapabilitySource(runtimeHealth.outputCapabilities, agent.outputCapabilities);
  for (const output of normalizeRequiredOutputs(options.requiredOutputs)) {
    if (!outputCapabilities.has(output)) return fail(base, `output_missing:${output}`, 'limited');
  }
  if (options.requiredOutputs || options.requiredCapabilities) base.checks.push('capabilities_match');

  if (base.capacity === 'failed') return fail(base, 'runtime_capacity_failed');
  if (base.capacity === 'busy') {
    base.readiness = 'limited';
    base.reason = 'waiting_for_capacity';
    base.checks.push('runtime_capacity_busy');
    return base;
  }
  if (base.capacity === 'available') base.checks.push('runtime_capacity_available');

  if (isDesktopRuntimeAgent(agent)) {
    const participant = findParticipant(options.participants, agentId, now, options.presenceMaxAgeMs);
    if (!participant) return fail(base, 'broker_participant_missing');
    base.participantId = participant.participantId || agentId;
    base.checks.push('broker_online');

    const probe = findProbeResult(options.probeResults, agentId, now);
    if (!probe) return fail(base, 'readiness_probe_missing', 'starting');
    if (!probe.ok) {
      const reason = probe.reason || 'readiness_probe_failed';
      if (role === 'project_owner' && agentId === 'xiaok-po' && reason === 'readiness_probe_timeout') {
        base.checks.push('readiness_probe_deferred');
        return {
          ...base,
          ready: true,
          readiness: 'ready',
          reason: null,
        };
      }
      return fail(base, reason);
    }
    base.checks.push('readiness_probe_ok');
  }

  return {
    ...base,
    ready: true,
    readiness: 'ready',
    reason: null,
  };
}

export function deriveProjectPreparation({
  project,
  agents = [],
  participants = [],
  probeResults = {},
  capacityByAgentId = {},
  requiredWorkerOutputs = [],
  now = Date.now(),
} = {}) {
  const checks = [];
  const blockers = [];
  const replacements = Array.isArray(project?.agentSelection?.replacements)
    ? project.agentSelection.replacements.slice()
    : [];
  const agentMap = new Map((Array.isArray(agents) ? agents : []).map(agent => [normalizeId(agent?.id), agent]));
  const poAgentId = normalizeId(project?.agentSelection?.poAgent?.agentId || project?.poAgent);
  const poSource = project?.agentSelection?.poAgent?.source || 'system_migration';

  if (poAgentId) {
    const readiness = classifyAgentReadiness(agentMap.get(poAgentId), {
      agentId: poAgentId,
      role: 'project_owner',
      selectedBy: poSource,
      participants,
      probeResults,
      capacity: capacityByAgentId[poAgentId],
      now,
    });
    checks.push(readiness);
    if (!readiness.ready) blockers.push(toBlocker(readiness));
  } else {
    blockers.push({
      agentId: null,
      role: 'project_owner',
      selectedBy: poSource,
      reason: 'po_agent_missing',
      readiness: 'unavailable',
    });
  }

  const selectedMembers = normalizeSelectedMembers(project);
  for (const member of selectedMembers) {
    const readiness = classifyAgentReadiness(agentMap.get(member.agentId), {
      agentId: member.agentId,
      role: 'worker',
      selectedBy: member.source,
      participants,
      probeResults,
      capacity: capacityByAgentId[member.agentId],
      requiredOutputs: requiredWorkerOutputs,
      now,
    });
    checks.push(readiness);
    if (!readiness.ready) blockers.push(toBlocker(readiness));
  }

  return {
    state: blockers.length > 0 ? 'blocked' : 'ready',
    checkedAt: Number(now),
    generation: Number(project?.preparation?.generation || 0) + 1,
    checks,
    blockers,
    replacements,
  };
}

export function selectDefaultSeedWorkerReplacement({
  project,
  preparation,
  agents = [],
  participants = [],
  probeResults = {},
  capacityByAgentId = {},
  requiredWorkerOutputs = [],
  now = Date.now(),
  candidateAgentId = 'xiaok-worker',
} = {}) {
  if (!project || !preparation || preparation.state !== 'blocked') return null;
  const selectedMembers = normalizeSelectedMembers(project);
  if (selectedMembers.length === 0) return null;
  if (selectedMembers.some(member => member.source === 'explicit_user')) return null;
  if (selectedMembers.some(member => member.agentId === candidateAgentId)) return null;

  const workerBlockers = (Array.isArray(preparation.blockers) ? preparation.blockers : [])
    .filter(blocker => blocker.role === 'worker');
  if (workerBlockers.length === 0) return null;
  if (workerBlockers.some(blocker => blocker.selectedBy === 'explicit_user')) return null;

  const agentMap = new Map((Array.isArray(agents) ? agents : []).map(agent => [normalizeId(agent?.id), agent]));
  const readiness = classifyAgentReadiness(agentMap.get(candidateAgentId), {
    agentId: candidateAgentId,
    role: 'worker',
    selectedBy: 'default_seed',
    participants,
    probeResults,
    capacity: capacityByAgentId[candidateAgentId],
    requiredOutputs: requiredWorkerOutputs,
    now,
  });
  if (!readiness.ready) return null;

  return {
    role: 'worker',
    fromAgentIds: selectedMembers.map(member => member.agentId),
    toAgentId: candidateAgentId,
    source: 'default_seed',
    reason: 'default_seed_worker_unavailable',
    readiness,
  };
}

function normalizeSelectedMembers(project) {
  const fromSelection = Array.isArray(project?.agentSelection?.members)
    ? project.agentSelection.members
    : [];
  if (fromSelection.length > 0) {
    return fromSelection
      .map(member => ({
        agentId: normalizeId(member?.agentId || member?.id || member),
        source: member?.source || 'system_migration',
      }))
      .filter(member => member.agentId);
  }
  return (Array.isArray(project?.members) ? project.members : [])
    .map(member => ({ agentId: normalizeId(member), source: 'system_migration' }))
    .filter(member => member.agentId);
}

function toBlocker(readiness) {
  return {
    agentId: readiness.agentId,
    role: readiness.role,
    selectedBy: readiness.selectedBy,
    reason: readiness.reason,
    readiness: readiness.readiness,
    participantId: readiness.participantId || null,
    capacity: readiness.capacity || 'unknown',
  };
}

function fail(base, reason, readiness = 'unavailable') {
  return {
    ...base,
    ready: false,
    readiness,
    reason,
  };
}

function normalizeRuntimeHealth(health) {
  return health && typeof health === 'object' ? health : {};
}

function capabilitySource(primary = [], fallback = []) {
  const primaryList = normalizeList(primary);
  const source = primaryList.length > 0 ? primaryList : normalizeList(fallback);
  return new Set(source);
}

function normalizeRequiredCapabilities(values = []) {
  return normalizeList(values);
}

function normalizeRequiredOutputs(values = []) {
  return normalizeOutputTypes(values.map(value => {
    if (typeof value === 'string') return value;
    if (value?.enforcement && value.enforcement !== 'hard') return '';
    return value?.type || value?.format || value?.kind || '';
  }));
}

function normalizeList(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function outputCapabilitySource(primary = [], fallback = []) {
  const primaryList = normalizeOutputTypes(primary);
  const source = primaryList.length > 0 ? primaryList : normalizeOutputTypes(fallback);
  return new Set(source);
}

function normalizeId(value) {
  return String(value || '').trim();
}

function normalizeReason(value) {
  return normalizeId(value) || 'readiness_probe_failed';
}

function hasRole(agent, role) {
  return !role || (Array.isArray(agent?.roles) && agent.roles.includes(role));
}

function isDesktopRuntimeAgent(agent) {
  return agent?.runtimeSource === DESKTOP_RUNTIME_SOURCE || DESKTOP_SEED_AGENT_IDS.has(agent?.id);
}

function findParticipant(participants = [], agentId, now, maxAge = DEFAULT_PRESENCE_MAX_AGE_MS) {
  const list = Array.isArray(participants) ? participants : [];
  return list.find(participant => {
    const participantId = normalizeId(participant?.participantId || participant?.id || participant);
    if (participantId !== agentId) return false;
    const lastSeenAt = Number(participant?.lastSeenAt || participant?.updatedAt || participant?.seenAt || 0);
    if (!lastSeenAt) return true;
    return Number(now) - lastSeenAt <= maxAge;
  }) || null;
}

function findProbeResult(probeResults = {}, agentId, now) {
  const raw = probeResults instanceof Map ? probeResults.get(agentId) : probeResults[agentId];
  if (!raw) return null;
  const normalized = normalizeReadinessProbeResult({ agentId, ...raw }, now);
  if (normalized.expiresAt && Number(now) > normalized.expiresAt) return null;
  return normalized;
}

function normalizeCapacity(capacity) {
  if (!capacity) return 'unknown';
  if (typeof capacity === 'string') return capacity;
  return capacity.capacity || capacity.state || 'unknown';
}

function normalizeCanCreateRuntimeInstance(capacity) {
  if (!capacity || typeof capacity === 'string') return null;
  if (typeof capacity.canCreateRuntimeInstance === 'boolean') return capacity.canCreateRuntimeInstance;
  return null;
}

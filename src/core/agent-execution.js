const DESKTOP_AGENT_RUNTIME_SOURCE = 'desktop-agent-runtime';
const XIAOK_DESKTOP_HOST_PARTICIPANT_ID = 'xiaok-desktop';
const DESKTOP_SEED_AGENT_IDS = new Set(['xiaok-po', 'xiaok-worker']);

export function resolveAgentExecution(agent = {}) {
  const declared = normalizeDeclaredExecution(agent.execution);
  if (declared) return declared;

  if (isHostedDesktopAgent(agent)) {
    return { mode: 'hosted', hostParticipantId: XIAOK_DESKTOP_HOST_PARTICIPANT_ID };
  }

  const participantId = normalizeId(agent.participantId || agent.id);
  if (participantId) return { mode: 'self_running', participantId };
  return null;
}

export function resolveBrokerDispatchTarget(agent = {}) {
  const execution = resolveAgentExecution(agent);
  if (execution?.mode === 'hosted') {
    return {
      executionMode: 'hosted',
      targetParticipantId: execution.hostParticipantId,
      targetAgentId: normalizeId(agent.id) || undefined,
      hostParticipantId: execution.hostParticipantId,
    };
  }
  if (execution?.mode === 'self_running') {
    return {
      executionMode: 'self_running',
      targetParticipantId: execution.participantId,
    };
  }
  const fallback = normalizeId(agent.id || agent.participantId);
  return {
    executionMode: 'self_running',
    targetParticipantId: fallback,
  };
}

export function resolveIncomingLogicalAgent({ fromParticipantId, payload } = {}) {
  return normalizeId(payload?.participantId || payload?.targetAgentId || payload?.agentId || fromParticipantId);
}

export function getBrokerPresenceParticipantId(agent = {}) {
  const execution = resolveAgentExecution(agent);
  if (execution?.mode === 'hosted') return execution.hostParticipantId;
  if (execution?.mode === 'self_running') return execution.participantId;
  return normalizeId(agent.id || agent.participantId);
}

export function isHostedAgent(agent = {}) {
  return resolveAgentExecution(agent)?.mode === 'hosted';
}

function normalizeDeclaredExecution(execution) {
  if (!execution || typeof execution !== 'object') return null;
  if (execution.mode === 'hosted') {
    const hostParticipantId = normalizeId(execution.hostParticipantId);
    return hostParticipantId ? { mode: 'hosted', hostParticipantId } : null;
  }
  if (execution.mode === 'self_running') {
    const participantId = normalizeId(execution.participantId);
    return participantId ? { mode: 'self_running', participantId } : null;
  }
  return null;
}

function isHostedDesktopAgent(agent = {}) {
  return Boolean(
    agent.runtimeSource === DESKTOP_AGENT_RUNTIME_SOURCE ||
    (agent.runtimeType === 'xiaok' && DESKTOP_SEED_AGENT_IDS.has(agent.id) && !agent.runtimePath)
  );
}

function normalizeId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}


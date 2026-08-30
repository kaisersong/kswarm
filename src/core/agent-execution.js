const DESKTOP_AGENT_RUNTIME_SOURCE = 'desktop-agent-runtime';
const XIAOK_DESKTOP_HOST_PARTICIPANT_ID = 'xiaok-desktop';
const DESKTOP_SEED_AGENT_IDS = new Set(['xiaok-po', 'xiaok-worker']);

export function resolveAgentExecution(agent = {}) {
  const declared = normalizeDeclaredExecution(agent.execution);
  if (declared) return declared;

  if (isHostedDesktopAgent(agent)) {
    return { mode: 'hosted', hostParticipantId: XIAOK_DESKTOP_HOST_PARTICIPANT_ID };
  }

  // Only an EXPLICIT participantId constitutes a self-running route. A bare
  // agent id is a display name, not a transport address — resolving it as a
  // participant is the bare-participant fallback design §9.2 forbids.
  const participantId = normalizeId(agent.participantId);
  if (participantId) return { mode: 'self_running', participantId };
  return null;
}

export function resolveBrokerDispatchTarget(agent = {}) {
  const execution = resolveAgentExecution(agent);
  if (shouldUseDesktopFallback(agent, execution)) {
    return {
      executionMode: 'hosted_fallback',
      targetParticipantId: XIAOK_DESKTOP_HOST_PARTICIPANT_ID,
      targetAgentId: normalizeId(agent.id) || undefined,
      hostParticipantId: XIAOK_DESKTOP_HOST_PARTICIPANT_ID,
      fallbackRuntime: 'desktop_current_model',
    };
  }
  if (execution?.mode === 'hosted') {
    // A hosted logical agent declaring a conflicting direct participant id is
    // an identity conflict, not a routing choice (design §9.2): fail closed.
    const declaredParticipantId = normalizeId(agent.participantId);
    if (declaredParticipantId && declaredParticipantId !== execution.hostParticipantId) {
      return { ok: false, code: 'agent_route_identity_conflict' };
    }
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
  // Route resolution fails CLOSED: an agent with no resolvable identity has
  // no target — never fall back to a bare participant id or broadcast
  // (design §9.2).
  return { ok: false, code: 'agent_route_unavailable' };
}

function shouldUseDesktopFallback(agent, execution) {
  if (agent?.fallbackToDesktopModel !== true || execution?.mode !== 'self_running') return false;
  const state = normalizeId(agent?.runtimeHealth?.state).toLowerCase();
  const status = normalizeId(agent?.status).toLowerCase();
  return ['degraded', 'unhealthy', 'error', 'failed', 'offline', 'cooldown', 'stalled'].includes(state)
    || ['error', 'failed', 'offline'].includes(status);
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

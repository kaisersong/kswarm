const DESKTOP_AGENT_RUNTIME_SOURCE = 'desktop-agent-runtime';
const DESKTOP_SEED_WORKER_ID = 'xiaok-worker';

export function getEffectiveAgentConcurrency({ baseConcurrency = {}, agents = [] } = {}) {
  const concurrency = { ...(baseConcurrency || {}) };
  for (const agent of listAgents(agents)) {
    if (agent?.id === DESKTOP_SEED_WORKER_ID && agent.runtimeSource === DESKTOP_AGENT_RUNTIME_SOURCE) {
      concurrency[DESKTOP_SEED_WORKER_ID] = 1;
    }
  }
  return concurrency;
}

function listAgents(agents) {
  if (agents instanceof Map) return [...agents.values()];
  if (Array.isArray(agents)) return agents;
  if (agents && typeof agents === 'object') return Object.values(agents);
  return [];
}

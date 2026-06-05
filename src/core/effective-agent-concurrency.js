export function getEffectiveAgentConcurrency({ baseConcurrency = {}, agents = [] } = {}) {
  return { ...(baseConcurrency || {}) };
}

function listAgents(agents) {
  if (agents instanceof Map) return [...agents.values()];
  if (Array.isArray(agents)) return agents;
  if (agents && typeof agents === 'object') return Object.values(agents);
  return [];
}

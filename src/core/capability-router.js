import { isRoutable } from './runtime-health.js';
import { inferTaskRequirements } from './task-requirements.js';

export function evaluateTaskRoute(task = {}, agent = null, now = Date.now()) {
  if (!agent) return { ok: false, reason: 'agent_missing' };
  const requirements = inferTaskRequirements(task);
  const route = isRoutable(
    agent,
    requirements.requiredCapabilities || [],
    (requirements.requiredOutputs || []).filter(output => output.enforcement !== 'soft'),
    now,
  );

  return {
    ...route,
    agentId: agent.id || null,
    requiredCapabilities: requirements.requiredCapabilities || [],
    requiredOutputs: requirements.requiredOutputs || [],
  };
}

export function planTaskRoute({ task = {}, agents = [], executors = [], now = Date.now() } = {}) {
  const requirements = inferTaskRequirements(task);
  const orderedAgents = orderAgentsByPreference(agents, task.assignedAgent);
  const skipped = [];

  for (const agent of orderedAgents) {
    const route = evaluateTaskRoute({ ...task, ...requirements }, agent, now);
    if (route.ok) {
      return {
        ok: true,
        selectedAgentId: agent.id,
        selectedExecutorId: null,
        skipped,
        requirements,
      };
    }
    skipped.push({ agentId: agent?.id || null, reason: route.reason });
  }

  for (const executor of executors || []) {
    const route = executorRoutable(executor, requirements);
    if (route.ok) {
      return {
        ok: true,
        selectedAgentId: null,
        selectedExecutorId: executor.id,
        skipped,
        requirements,
      };
    }
    skipped.push({ executorId: executor?.id || null, reason: route.reason });
  }

  return {
    ok: false,
    selectedAgentId: null,
    selectedExecutorId: null,
    skipped,
    requirements,
    reason: skipped[0]?.reason || 'no_route',
  };
}

export function findAgentProfile(agentProfiles = [], agentId) {
  if (!agentId) return null;
  if (agentProfiles instanceof Map) return agentProfiles.get(agentId) || null;
  if (Array.isArray(agentProfiles)) return agentProfiles.find(agent => agent?.id === agentId) || null;
  if (agentProfiles && typeof agentProfiles === 'object') return agentProfiles[agentId] || null;
  return null;
}

function orderAgentsByPreference(agents, assignedAgent) {
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  if (!assignedAgent) return list;
  return [
    ...list.filter(agent => agent.id === assignedAgent),
    ...list.filter(agent => agent.id !== assignedAgent),
  ];
}

function executorRoutable(executor = {}, requirements = {}) {
  const taskCaps = new Set(normalizeList(executor.taskCapabilities));
  const outputCaps = new Set(normalizeList(executor.outputCapabilities));

  for (const capability of normalizeList(requirements.requiredCapabilities)) {
    if (!taskCaps.has(capability)) return { ok: false, reason: `capability_missing:${capability}` };
  }
  for (const output of requirements.requiredOutputs || []) {
    if (output?.enforcement === 'soft') continue;
    const type = typeof output === 'string' ? output : output.type;
    if (!outputCaps.has(String(type || '').toLowerCase())) return { ok: false, reason: `output_missing:${type}` };
  }
  return { ok: true };
}

function normalizeList(values = []) {
  if (!Array.isArray(values)) return [];
  return values.map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
}

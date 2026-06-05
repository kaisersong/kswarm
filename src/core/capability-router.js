import { isRoutable } from './runtime-health.js';
import { inferTaskRequirements } from './task-requirements.js';
import { canonicalizeOutputType, normalizeOutputTypes } from './output-types.js';
import { isWorkerEligible } from './roles.js';

export function evaluateTaskRoute(task = {}, agent = null, now = Date.now()) {
  if (!agent) return { ok: false, reason: 'agent_missing' };
  const requirements = inferTaskRequirements(task);
  const route = isRoutable(
    agent,
    requirements.requiredCapabilities || [],
    (requirements.requiredOutputs || []).filter(output => output.enforcement !== 'soft'),
    now,
  );

  if (!route.ok && route.reason === 'runtime_degraded' && isRecoverableContentFailureRetry(task, agent, now)) {
    return {
      ok: true,
      reason: null,
      agentId: agent.id || null,
      requiredCapabilities: requirements.requiredCapabilities || [],
      requiredOutputs: requirements.requiredOutputs || [],
      recoveredRuntimeFailure: 'model_empty_output',
    };
  }

  return {
    ...route,
    agentId: agent.id || null,
    requiredCapabilities: requirements.requiredCapabilities || [],
    requiredOutputs: requirements.requiredOutputs || [],
  };
}

export function planTaskRoute({ task = {}, agents = [], now = Date.now() } = {}) {
  const requirements = inferTaskRequirements(task);
  const orderedAgents = orderAgentsByPreference(agents, task.assignedAgent)
    .filter(agent => shouldConsiderAgentForTask(agent, task));
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
    if (limitedAssignedRuntimeMatches({ agent, task, requirements, route })) {
      return {
        ok: true,
        selectedAgentId: agent.id,
        selectedExecutorId: null,
        skipped,
        requirements,
        limitedAssignedRuntime: true,
      };
    }
    skipped.push({ agentId: agent?.id || null, reason: route.reason });
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

function shouldConsiderAgentForTask(agent, task = {}) {
  if (!agent) return false;
  if (agent.id === task.assignedAgent) return true;
  return isWorkerEligible(agent);
}

function limitedAssignedRuntimeMatches({ agent, task, requirements, route }) {
  if (!agent || !task || route?.reason !== 'runtime_limited') return false;
  if (!task.assignedAgent || agent.id !== task.assignedAgent) return false;
  const requiredCapabilities = normalizeList(requirements.requiredCapabilities);
  const requiredOutputs = normalizeHardOutputs(requirements.requiredOutputs);
  if (requiredCapabilities.length === 0 && requiredOutputs.length === 0) return false;

  const health = agent.runtimeHealth || {};
  const taskCaps = new Set(normalizeList(health.taskCapabilities));
  for (const capability of requiredCapabilities) {
    if (!taskCaps.has(capability)) return false;
  }

  const outputCaps = new Set(normalizeOutputTypes(health.outputCapabilities));
  for (const output of requiredOutputs) {
    if (!outputCaps.has(output)) return false;
  }

  return true;
}

function isRecoverableContentFailureRetry(task = {}, agent = {}, now = Date.now()) {
  if (!task.assignedAgent || agent.id !== task.assignedAgent) return false;
  const health = agent.runtimeHealth || {};
  if (health.cooldownUntil && Number(health.cooldownUntil) > now) return false;
  if (String(health.lastFailureClass || '') === 'runtime_stalled') return false;
  const failureText = [
    task.lastFailureClass,
    task.failureReason,
    task.blockedReason,
    health.lastFailureClass,
    health.lastError,
  ].filter(Boolean).join('\n');
  return /model_empty_output|content_too_short|empty output|both failed to generate output/i.test(failureText);
}

function normalizeList(values = []) {
  if (!Array.isArray(values)) return [];
  return values.map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
}

function normalizeHardOutputs(outputs = []) {
  if (!Array.isArray(outputs)) return [];
  return outputs
    .filter(output => !(output && typeof output === 'object' && output.enforcement === 'soft'))
    .map(output => (typeof output === 'string' ? output : output?.type))
    .map(value => canonicalizeOutputType(value))
    .filter(Boolean);
}

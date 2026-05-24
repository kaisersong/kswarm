import { isRoutable } from './runtime-health.js';

const BASIC_INVOCATION_FAILURES = new Set([
  'runtime_offline',
  'runtime_missing',
  'runtime_unavailable',
  'runtime_stalled',
  'handoff_failed',
  'handoff_missing',
  'handoff_create_failed',
  'desktop_runtime_error',
  'broker_unavailable',
  'websocket_open_timeout',
  'model_empty_output',
]);

const OUTPUT_CONTRACT_FAILURES = new Set([
  'artifact_type_mismatch',
  'artifact_missing',
  'artifact_invalid',
  'inline_artifact_forbidden',
  'artifact_hash_mismatch',
  'artifact_path_escape',
]);

const QUALITY_FAILURES = new Set([
  'quality_content_failed',
  'quality_evidence_missing',
  'source_evidence_missing',
  'po_quality_failed',
]);

const TASK_LEVEL_FAILURES = new Set([
  'source_provider_unavailable',
]);

export function classifyFailureForReplacement(failureClass, context = {}) {
  const normalized = normalizeFailureClass(failureClass);
  if (OUTPUT_CONTRACT_FAILURES.has(normalized)) {
    return { failureClass: normalized, bucket: 'output_contract_failure' };
  }
  if (QUALITY_FAILURES.has(normalized)) {
    return { failureClass: normalized, bucket: 'quality_failure' };
  }
  if (TASK_LEVEL_FAILURES.has(normalized)) {
    return { failureClass: normalized, bucket: 'task_level_failure' };
  }
  if (
    normalized === 'model_empty_output' &&
    Number(context.consecutiveTaskFailures || context.emptyOutputFailures || 0) < 2
  ) {
    return { failureClass: normalized, bucket: 'task_level_failure' };
  }
  if (BASIC_INVOCATION_FAILURES.has(normalized)) {
    return { failureClass: normalized, bucket: 'basic_invocation_failure' };
  }
  return { failureClass: normalized, bucket: 'unknown_failure' };
}

export function planAgentReplacement({
  task = {},
  failureClass,
  agents = [],
  selection = {},
  priorReplacements = [],
  replacementBudget = {},
  now = Date.now(),
} = {}) {
  const classification = classifyFailureForReplacement(failureClass, {
    consecutiveTaskFailures: task.consecutiveTaskFailures,
    emptyOutputFailures: task.emptyOutputFailures || (failureClass === 'model_empty_output' ? task.attempt : 0),
  });
  const base = {
    action: null,
    bucket: classification.bucket,
    failureClass: classification.failureClass,
    taskId: task.id || null,
    fromAgentId: task.assignedAgent || null,
    toAgentId: null,
    candidates: [],
    reason: null,
  };

  if (classification.bucket === 'output_contract_failure') {
    return { ...base, action: 'repair_output_contract', reason: classification.failureClass };
  }
  if (classification.bucket === 'quality_failure') {
    return { ...base, action: 'repair_quality', reason: classification.failureClass };
  }
  if (classification.bucket === 'task_level_failure') {
    return { ...base, action: 'repair_task', reason: classification.failureClass };
  }
  if (classification.bucket !== 'basic_invocation_failure') {
    return { ...base, action: 'needs_diagnosis', reason: classification.failureClass };
  }

  const perTaskBudget = Number(replacementBudget.perTask ?? replacementBudget.task ?? 1);
  if ((Array.isArray(priorReplacements) ? priorReplacements.length : 0) >= perTaskBudget) {
    return { ...base, action: 'recovery_budget_exceeded', reason: 'per_task_replacement_budget_exceeded' };
  }

  const candidates = rankReplacementCandidates({
    task,
    agents,
    now,
  });

  if (selection.source === 'explicit_user') {
    return {
      ...base,
      action: 'needs_user_confirmation',
      candidates,
      reason: 'explicit_user_selection',
    };
  }

  const best = candidates[0];
  if (!best) {
    return { ...base, action: 'no_replacement_available', candidates, reason: 'no_ready_candidate' };
  }

  return {
    ...base,
    action: 'replace',
    toAgentId: best.agentId,
    candidates,
    reason: classification.failureClass,
  };
}

function rankReplacementCandidates({ task = {}, agents = [], now = Date.now() }) {
  const requiredCapabilities = normalizeList(task.requiredCapabilities || task.capabilities);
  const requiredOutputs = normalizeOutputs(task.requiredOutputs || task.outputs);
  const currentAgent = normalizeId(task.assignedAgent);
  const preferredMembers = new Set(normalizeList(task.projectMembers || task.members));

  return (Array.isArray(agents) ? agents : [])
    .filter(agent => agent && !agent.archivedAt)
    .filter(agent => normalizeId(agent.id) && normalizeId(agent.id) !== currentAgent)
    .filter(agent => hasRole(agent, 'worker'))
    .map(agent => {
      const route = isRoutable(agent, requiredCapabilities, requiredOutputs, now);
      return {
        agent,
        route,
        score: candidateScore(agent, preferredMembers),
      };
    })
    .filter(candidate => candidate.route.ok)
    .sort((a, b) => b.score - a.score || normalizeId(a.agent.id).localeCompare(normalizeId(b.agent.id)))
    .map(candidate => ({
      agentId: candidate.agent.id,
      reason: 'ready',
      score: candidate.score,
    }));
}

function candidateScore(agent, preferredMembers) {
  let score = 0;
  if (preferredMembers.has(normalizeId(agent.id))) score += 20;
  if (agent.id === 'xiaok-worker') score += 10;
  if (agent.runtimeHealth?.state === 'healthy') score += 5;
  if (agent.status && agent.status !== 'offline') score += 1;
  return score;
}

function hasRole(agent, role) {
  return Array.isArray(agent?.roles) && agent.roles.includes(role);
}

function normalizeFailureClass(value) {
  return normalizeId(value || 'agent_error');
}

function normalizeId(value) {
  return String(value || '').trim();
}

function normalizeList(values = []) {
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

import assert from 'node:assert/strict';
import {
  classifyFailureForReplacement,
  planAgentReplacement,
} from '../src/core/agent-replacement.js';

const readyWorker = {
  id: 'xiaok-worker',
  roles: ['worker'],
  runtimeHealth: {
    state: 'healthy',
    taskCapabilities: ['research'],
    outputCapabilities: ['markdown'],
  },
};

const qoder = {
  id: 'cli-qoder',
  roles: ['worker'],
  runtimeHealth: {
    state: 'healthy',
    taskCapabilities: ['research'],
    outputCapabilities: ['markdown'],
  },
};

assert.equal(classifyFailureForReplacement('runtime_offline').bucket, 'basic_invocation_failure');
assert.equal(classifyFailureForReplacement('handoff_failed').bucket, 'basic_invocation_failure');
assert.equal(classifyFailureForReplacement('artifact_type_mismatch').bucket, 'output_contract_failure');
assert.equal(classifyFailureForReplacement('quality_content_failed').bucket, 'quality_failure');
assert.equal(classifyFailureForReplacement('source_provider_unavailable').bucket, 'task_level_failure');

{
  const plan = planAgentReplacement({
    task: {
      id: 'task-1',
      assignedAgent: 'bad-worker',
      requiredOutputs: ['markdown'],
      requiredCapabilities: ['research'],
    },
    failureClass: 'runtime_offline',
    agents: [readyWorker, qoder],
    selection: { source: 'default_seed' },
    priorReplacements: [],
  });
  assert.equal(plan.action, 'replace');
  assert.equal(plan.toAgentId, 'xiaok-worker');
}

{
  const plan = planAgentReplacement({
    task: { id: 'task-2', assignedAgent: 'bad-worker', requiredOutputs: ['markdown'] },
    failureClass: 'runtime_offline',
    agents: [readyWorker],
    selection: { source: 'explicit_user' },
    priorReplacements: [],
  });
  assert.equal(plan.action, 'needs_user_confirmation');
  assert.equal(plan.candidates[0].agentId, 'xiaok-worker');
}

{
  const plan = planAgentReplacement({
    task: { id: 'task-3', assignedAgent: 'xiaok-worker', requiredOutputs: ['markdown'] },
    failureClass: 'artifact_type_mismatch',
    agents: [readyWorker, qoder],
    selection: { source: 'default_seed' },
    priorReplacements: [],
  });
  assert.equal(plan.action, 'repair_output_contract');
  assert.equal(plan.toAgentId, null);
}

{
  const plan = planAgentReplacement({
    task: { id: 'task-4', assignedAgent: 'bad-worker', requiredOutputs: ['markdown'] },
    failureClass: 'runtime_offline',
    agents: [readyWorker, qoder],
    selection: { source: 'default_seed' },
    priorReplacements: [{ fromAgentId: 'bad-worker', toAgentId: 'cli-qoder', failureClass: 'runtime_offline' }],
  });
  assert.equal(plan.action, 'recovery_budget_exceeded');
  assert.equal(plan.toAgentId, null);
}

{
  const firstEmpty = planAgentReplacement({
    task: { id: 'task-5', assignedAgent: 'bad-worker', attempt: 1, requiredOutputs: ['markdown'] },
    failureClass: 'model_empty_output',
    agents: [readyWorker],
    selection: { source: 'default_seed' },
    priorReplacements: [],
  });
  assert.equal(firstEmpty.action, 'repair_task');

  const repeatedEmpty = planAgentReplacement({
    task: { id: 'task-5-retry', assignedAgent: 'bad-worker', attempt: 2, requiredOutputs: ['markdown'] },
    failureClass: 'model_empty_output',
    agents: [readyWorker],
    selection: { source: 'default_seed' },
    priorReplacements: [],
  });
  assert.equal(repeatedEmpty.action, 'replace');
  assert.equal(repeatedEmpty.toAgentId, 'xiaok-worker');
}

console.log('agent-replacement tests passed');

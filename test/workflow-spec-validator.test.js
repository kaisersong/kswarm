/**
 * KSwarm — workflow IR validation contract tests
 *
 * Run: node test/workflow-spec-validator.test.js
 */

import assert from 'node:assert/strict';
import {
  validateWorkflowBudget,
  validateWorkflowSpec,
} from '../src/core/workflow-spec.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function validRubric() {
  return {
    id: 'agent-review-diagnosis-rubric',
    title: 'Agent 复核诊断验收标准',
    machineChecks: [
      {
        id: 'diagnosis_schema',
        title: '诊断输出结构合法',
        checkKind: 'schema',
        required: true,
        inputRefs: ['worker-diagnosis'],
      },
    ],
    judgmentChecks: [
      {
        id: 'review_evidence',
        title: '复核结论有证据',
        prompt: '检查 reviewer 是否引用 worker diagnosis 的证据。',
        evidenceRequired: true,
        reviewerCount: 1,
        required: true,
      },
    ],
    disagreementPolicy: 'block',
  };
}

function validSpec(overrides = {}) {
  return {
    kind: 'kswarm_workflow_spec_v1',
    id: 'agent-review-smoke',
    name: 'Agent 复核诊断',
    description: 'Worker 诊断项目，Reviewer 对抗性复核，Gate 归约。',
    scope: { projectId: 'proj-1' },
    budgets: { maxNodes: 3, maxParallelism: 1, maxAgents: 2, maxMinutes: 10, maxTokens: 12_000 },
    permissions: { toolCategories: ['read_project_state'], allowWrite: false, allowShell: false, allowNetwork: false, allowRenderer: false },
    outputContract: { kind: 'diagnosis', requiredArtifactTypes: [] },
    acceptanceRubric: validRubric(),
    phases: [
      {
        id: 'inspect',
        title: 'Agent 诊断',
        nodes: [
          {
            id: 'worker-diagnose-project',
            title: 'Worker 项目诊断',
            kind: 'agent',
            required: true,
            inputRefs: ['project.snapshot'],
            agentSelector: { requiredCapabilities: ['project_diagnosis'] },
            outputSchema: { type: 'object', required: ['summary'] },
            evidenceRequired: true,
            permissions: { toolCategories: ['read_project_state'] },
            failurePolicy: { strategy: 'block' },
          },
        ],
      },
      {
        id: 'review',
        title: '对抗性复核',
        nodes: [
          {
            id: 'reviewer-adversarial-check',
            title: 'Reviewer 对抗性检查',
            kind: 'review',
            dependsOn: ['worker-diagnose-project'],
            required: true,
            inputRefs: ['worker-diagnose-project.output'],
            agentSelector: { requiredCapabilities: ['review_gate'] },
            outputSchema: { type: 'object', required: ['reviewDecision'] },
            evidenceRequired: true,
            permissions: { toolCategories: ['read_project_state'] },
            failurePolicy: { strategy: 'block' },
          },
        ],
      },
      {
        id: 'reduce',
        title: '门禁归约',
        nodes: [
          {
            id: 'reduce-review-gate',
            title: '归约 review gate',
            kind: 'reduce',
            dependsOn: ['reviewer-adversarial-check'],
            required: true,
            inputRefs: ['reviewer-adversarial-check.reviewDecision'],
            outputSchema: { type: 'object', required: ['status'] },
            evidenceRequired: true,
            permissions: { toolCategories: ['read_project_state'] },
            failurePolicy: { strategy: 'block' },
          },
        ],
      },
    ],
    ...overrides,
  };
}

test('accepts minimal formal workflow spec with explicit acceptance rubric', () => {
  const result = validateWorkflowSpec(validSpec(), {
    policy: { maxNodes: 8, maxParallelism: 3, maxAgents: 4, maxMinutes: 30, maxTokens: 30_000 },
    capabilities: ['project_diagnosis', 'review_gate'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.normalized.nodeCount, 3);
  assert.deepEqual(result.normalized.nodeIds, ['worker-diagnose-project', 'reviewer-adversarial-check', 'reduce-review-gate']);
});

test('rejects formal workflow spec without acceptanceRubric', () => {
  const spec = validSpec({ acceptanceRubric: undefined });
  const result = validateWorkflowSpec(spec, { capabilities: ['project_diagnosis', 'review_gate'] });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'acceptance_rubric_required');
});

test('rejects unsupported node kind before execution', () => {
  const spec = validSpec();
  spec.phases[0].nodes[0].kind = 'script';

  const result = validateWorkflowSpec(spec, { capabilities: ['project_diagnosis', 'review_gate'] });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported_node_kind');
  assert.equal(result.nodeId, 'worker-diagnose-project');
});

test('rejects dependency cycles and unknown dependencies in workflow IR', () => {
  const unknown = validSpec();
  unknown.phases[1].nodes[0].dependsOn = ['missing-node'];
  const unknownResult = validateWorkflowSpec(unknown, { capabilities: ['project_diagnosis', 'review_gate'] });
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.error, 'unknown_dependency');

  const cycle = validSpec();
  cycle.phases[0].nodes[0].dependsOn = ['reduce-review-gate'];
  const cycleResult = validateWorkflowSpec(cycle, { capabilities: ['project_diagnosis', 'review_gate'] });
  assert.equal(cycleResult.ok, false);
  assert.equal(cycleResult.error, 'dependency_cycle');
});

test('rejects over-budget spec using hard policy limits', () => {
  const result = validateWorkflowBudget(validSpec(), {
    maxNodes: 2,
    maxParallelism: 1,
    maxAgents: 2,
    maxMinutes: 10,
    maxTokens: 12_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'budget_max_nodes_exceeded');
});

test('rejects undeclared permission and missing agent capability', () => {
  const permissionSpec = validSpec();
  permissionSpec.phases[0].nodes[0].permissions = { toolCategories: ['write_files'] };
  const permissionResult = validateWorkflowSpec(permissionSpec, { capabilities: ['project_diagnosis', 'review_gate'] });
  assert.equal(permissionResult.ok, false);
  assert.equal(permissionResult.error, 'permission_not_allowed');
  assert.equal(permissionResult.nodeId, 'worker-diagnose-project');

  const capabilityResult = validateWorkflowSpec(validSpec(), { capabilities: ['project_diagnosis'] });
  assert.equal(capabilityResult.ok, false);
  assert.equal(capabilityResult.error, 'missing_agent_capability');
  assert.equal(capabilityResult.capability, 'review_gate');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} workflow spec validator tests passed`);

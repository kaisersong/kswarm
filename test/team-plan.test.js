import assert from 'node:assert/strict';
import { getCapabilityCatalog } from '../src/core/capability-catalog.js';
import { createProjectTeamPlan } from '../src/core/team-planner.js';

const catalog = getCapabilityCatalog();
const project = { id: 'project-1', projectRevision: 7, poAgent: 'xiaok-po', members: ['xiaok-worker'] };
const baseAgents = [
  { id: 'xiaok-po', runtimeType: 'xiaok', roles: ['project_owner'], capabilities: ['planning'], runtimeHealth: { state: 'ready' } },
  { id: 'xiaok-worker', runtimeType: 'xiaok', roles: ['worker'], capabilities: ['writing'], runtimeHealth: { state: 'ready' } },
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('reuses the existing project member before proposing a new agent', () => {
  const result = createProjectTeamPlan({
    project,
    agents: baseAgents,
    catalog,
    needs: [{ needKey: 'writer', requiredCapabilities: ['writing'], responsibilities: ['draft'], requiresIndependentReviewer: false }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.roles[0].decision, 'reuse');
  assert.equal(result.plan.roles[0].preferredExistingAgentId, 'xiaok-worker');
  assert.equal(result.plan.projectRevision, 7);
});

test('requires a separate reviewer and rejects plans exceeding the team cap', () => {
  const separation = createProjectTeamPlan({
    project,
    agents: baseAgents,
    catalog,
    needs: [
      { needKey: 'writer', requiredCapabilities: ['writing'], responsibilities: ['draft'], requiresIndependentReviewer: true },
      { needKey: 'reviewer', requiredCapabilities: ['review'], responsibilities: ['review'], requiresIndependentReviewer: false },
    ],
  });
  assert.equal(separation.ok, true);
  assert.notEqual(separation.plan.roles[0].preferredExistingAgentId, separation.plan.roles[1].preferredExistingAgentId);

  const oversized = createProjectTeamPlan({
    project: { ...project, members: ['a', 'b', 'c', 'd', 'e'] },
    agents: baseAgents,
    catalog,
    needs: [{ needKey: 'specialist', requiredCapabilities: ['review'], responsibilities: ['review'], requiresIndependentReviewer: false }],
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error, 'needs_manual_scope');
});

let passed = 0;
for (const { name, fn } of tests) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
console.log(`team-plan: ${passed}/${tests.length} passed`);

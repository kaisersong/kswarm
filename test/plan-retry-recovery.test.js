import assert from 'node:assert/strict';
import {
  buildPlanRetryAssignPoIntent,
  canRetryPlanForProject,
  normalizeProjectForPlanRetry,
  resolvePlanRetryPoAgent,
} from '../src/core/plan-retry-recovery.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function project(status, plan = null) {
  return { id: 'proj-test', name: 'Test Project', status, plan, planArtifact: plan ? 'plan.md' : null };
}

test('allows retry for normal pre-approval planning states', () => {
  for (const status of ['draft', 'created', 'planning']) {
    assert.equal(canRetryPlanForProject(project(status), []), true, status);
  }
});

test('allows retry for empty active project with no plan', () => {
  assert.equal(canRetryPlanForProject(project('active'), []), true);
});

test('does not allow retry for active projects with a plan or tasks', () => {
  assert.equal(canRetryPlanForProject(project('active', { version: 1 }), []), false);
  assert.equal(canRetryPlanForProject(project('active'), [{ id: 'task-1', status: 'pending' }]), false);
});

test('normalizes interrupted active project back to created on retry', () => {
  const p = project('active');
  const result = normalizeProjectForPlanRetry(p, []);

  assert.equal(result.ok, true);
  assert.equal(result.normalizedStatus, true);
  assert.equal(p.status, 'created');
  assert.equal(p.plan, null);
  assert.equal(p.planArtifact, null);
});

test('blocks delivered and closed projects', () => {
  for (const status of ['delivered', 'closed']) {
    const p = project(status);
    const result = normalizeProjectForPlanRetry(p, []);
    assert.equal(result.ok, false, status);
    assert.equal(result.error, 'plan_retry_not_allowed');
    assert.equal(p.status, status);
  }
});

test('reassigns legacy xiaok PO to the dedicated xiaok-po seed during plan retry', () => {
  const result = resolvePlanRetryPoAgent(
    { ...project('created'), poAgent: 'xiaok' },
    [
      { id: 'xiaok', name: 'xiaok', runtimeType: 'xiaok', roles: ['project_owner', 'worker'], status: 'idle' },
      { id: 'xiaok-po', name: 'PO-Agent', runtimeType: 'xiaok', roles: ['project_owner'], status: 'offline' },
      { id: 'xiaok-worker', name: 'Worker-Agent', runtimeType: 'xiaok', roles: ['worker'], status: 'offline' },
    ],
  );

  assert.equal(result.poAgent, 'xiaok-po');
  assert.equal(result.previousPoAgent, 'xiaok');
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'preferred_xiaok_po');
});

test('preserves a healthy custom project owner PO during plan retry', () => {
  const result = resolvePlanRetryPoAgent(
    { ...project('created'), poAgent: 'custom-po' },
    [
      { id: 'custom-po', name: 'Custom PO', runtimeType: 'codex', roles: ['project_owner'], status: 'offline' },
      { id: 'xiaok-po', name: 'PO-Agent', runtimeType: 'xiaok', roles: ['project_owner'], status: 'offline' },
    ],
  );

  assert.equal(result.poAgent, 'custom-po');
  assert.equal(result.previousPoAgent, 'custom-po');
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'current_po_usable');
});

test('builds retry assign_po intent with the same project context as project creation', () => {
  const intent = buildPlanRetryAssignPoIntent({
    id: 'proj-test',
    name: 'Test Project',
    goal: 'Ship the report',
    requirements: 'Use markdown',
    members: ['xiaok-worker'],
  });

  assert.deepEqual(intent, {
    taskId: 'proj-test',
    threadId: 'thread-proj-test',
    payload: {
      projectId: 'proj-test',
      projectName: 'Test Project',
      name: 'Test Project',
      goal: 'Ship the report',
      requirements: 'Use markdown',
      members: ['xiaok-worker'],
    },
  });
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}
console.log(`\n${passed}/${tests.length} plan retry recovery tests passed`);

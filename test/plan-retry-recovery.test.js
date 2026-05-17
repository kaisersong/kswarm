import assert from 'node:assert/strict';
import {
  canRetryPlanForProject,
  normalizeProjectForPlanRetry,
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

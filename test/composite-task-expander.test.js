/**
 * KSwarm — composite task expansion tests
 *
 * Run: node test/composite-task-expander.test.js
 */

import assert from 'node:assert/strict';
import { expandCompositeTasks } from '../src/core/composite-task-expander.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('composite deliverable task expands into draft, review, and final children atomically', () => {
  const expanded = expandCompositeTasks([
    {
      id: 'talk-report',
      title: '技术大会演讲报告',
      brief: '生成报告并做独立评审后输出终版',
      assignedAgent: 'writer',
      composite: true,
      dependencies: ['research'],
    },
  ], {
    projectId: 'proj-a',
    members: ['writer', 'reviewer'],
    poAgent: 'po',
  });

  assert.equal(expanded.ok, true);
  assert.equal(expanded.tasks.length, 4);

  const parent = expanded.tasks.find(t => t.id === 'talk-report');
  const draft = expanded.tasks.find(t => t.id === 'talk-report-draft');
  const review = expanded.tasks.find(t => t.id === 'talk-report-review');
  const final = expanded.tasks.find(t => t.id === 'talk-report-final');

  assert.equal(parent.isCompositeParent, true);
  assert.deepEqual(parent.childTaskIds, ['talk-report-draft', 'talk-report-review', 'talk-report-final']);
  assert.equal(parent.assignedAgent, null);
  assert.equal(draft.parentTaskId, 'talk-report');
  assert.deepEqual(draft.dependencies, ['research']);
  assert.equal(review.assignedAgent, 'reviewer');
  assert.deepEqual(review.dependencies, ['talk-report-draft']);
  assert.equal(review.evidenceContract.kind, 'review_iteration_v1');
  assert.deepEqual(final.dependencies, ['talk-report-review']);
});

test('expansion refuses a composite task when no independent reviewer is available', () => {
  const expanded = expandCompositeTasks([
    {
      id: 'talk-report',
      title: '技术大会演讲报告',
      assignedAgent: 'writer',
      composite: true,
    },
  ], {
    projectId: 'proj-a',
    members: ['writer'],
    poAgent: 'po',
  });

  assert.equal(expanded.ok, false);
  assert.equal(expanded.error, 'no_independent_reviewer');
  assert.equal(expanded.taskId, 'talk-report');
});

test('non-composite tasks are preserved and enriched with contracts', () => {
  const expanded = expandCompositeTasks([
    { id: 'research', title: '收集大会受众资料', assignedAgent: 'researcher' },
  ], {
    projectId: 'proj-a',
    members: ['researcher', 'reviewer'],
    poAgent: 'po',
  });

  assert.equal(expanded.ok, true);
  assert.equal(expanded.tasks.length, 1);
  assert.equal(expanded.tasks[0].id, 'research');
  assert.ok(expanded.tasks[0].executionContract);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} composite task expander tests passed`);
}

/**
 * test/hub-plan.test.js — Plan-Do 模型单元测试
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

function setup() {
  return createHub({ silent: true });
}

function createTestProject(hub) {
  return hub.createProject({
    id: 'proj-plan-1',
    name: 'Test Plan Project',
    goal: 'Test the plan-do model',
    requirements: '2 rounds review',
    poAgent: 'po-1',
    members: ['w-1', 'w-2'],
  });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── handleSubmitPlan ────────────────────────────────────────────────

test('submitPlan: stores plan on project', () => {
  const hub = setup();
  createTestProject(hub);

  const plan = {
    analysis: 'Deep analysis of the goal',
    successCriteria: ['Criterion 1', 'Criterion 2'],
    phases: [
      {
        id: 'phase-1', name: 'Research',
        items: [
          { id: 'item-1', title: 'Write draft', brief: 'Write initial draft', assignedAgent: 'w-1', dependencies: [], acceptanceCriteria: 'Must be >500 words' },
        ],
      },
      {
        id: 'phase-2', name: 'Review',
        items: [
          { id: 'item-2', title: 'Review draft', brief: 'Adversarial review', assignedAgent: 'w-2', dependencies: ['Write draft'], acceptanceCriteria: 'Must have 3+ critique points' },
        ],
      },
    ],
  };

  const result = hub.handleSubmitPlan('proj-plan-1', plan, 'po-1');
  assert.ok(result.ok);
  assert.equal(result.plan.version, 1);
  assert.equal(result.plan.phases.length, 2);

  const project = hub.getProject('proj-plan-1');
  assert.equal(project.status, 'planning');
  assert.ok(project.plan);
  assert.equal(project.plan.analysis, 'Deep analysis of the goal');
});

test('submitPlan: rejects non-PO', () => {
  const hub = setup();
  createTestProject(hub);
  const result = hub.handleSubmitPlan('proj-plan-1', { phases: [] }, 'w-1');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_po');
});

// ─── handleApprove guard ─────────────────────────────────────────────

test('approve: rejects immediately after creation (no plan, no tasks — real user flow)', () => {
  const hub = setup();
  createTestProject(hub);
  // User creates project and immediately clicks approve — PO hasn't had time to generate plan
  const result = hub.handleApprove('proj-plan-1');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_plan_or_tasks');
  // Project should still be in created status
  assert.equal(hub.getProject('proj-plan-1').status, 'created');
});

test('approve: succeeds after PO submits plan (real user flow)', () => {
  const hub = setup();
  createTestProject(hub);

  // Step 1: User creates project, tries approve immediately → rejected
  assert.equal(hub.handleApprove('proj-plan-1').ok, false);

  // Step 2: PO receives assign_po, generates plan and submits
  hub.handleSubmitPlan('proj-plan-1', {
    analysis: 'Deep analysis of the goal',
    successCriteria: ['Criterion 1'],
    phases: [{ id: 'p1', name: 'Phase 1', items: [
      { id: 'item-1', title: 'Task 1', brief: 'Do it', status: 'planned', assignedAgent: 'w-1', dependencies: [], acceptanceCriteria: 'Must pass' },
    ]}],
  }, 'po-1');
  assert.equal(hub.getProject('proj-plan-1').status, 'planning');

  // Step 3: PO creates tasks from plan
  hub.handleCreateTasks('proj-plan-1', [
    { id: 'item-1', title: 'Task 1', brief: 'Do it', assignedAgent: 'w-1', phaseId: 'p1', planItemId: 'item-1', dependencies: [] },
  ], 'po-1');

  // Step 4: User sees plan + tasks, clicks approve → succeeds
  const result = hub.handleApprove('proj-plan-1');
  assert.ok(result.ok);
  assert.equal(hub.getProject('proj-plan-1').status, 'active');
});

test('approve: succeeds when tasks exist (backward compat, no plan)', () => {
  const hub = setup();
  createTestProject(hub);
  hub.handleCreateTasks('proj-plan-1', [{ id: 't1', title: 'Task 1', brief: 'Do something' }], 'po-1');
  const result = hub.handleApprove('proj-plan-1');
  assert.ok(result.ok);
});

test('approve: full realistic sequence — create → plan → tasks → approve → dispatch', () => {
  const hub = setup();
  createTestProject(hub);

  // 1. Immediately after creation: no plan, no tasks
  assert.equal(hub.getProject('proj-plan-1').status, 'created');
  assert.equal(hub.getProject('proj-plan-1').plan, null);
  assert.equal(hub.getBoard('proj-plan-1').getAllTasks().length, 0);

  // 2. PO submits plan
  hub.handleSubmitPlan('proj-plan-1', {
    analysis: 'test analysis',
    phases: [
      { id: 'p1', name: 'Phase 1', items: [
        { id: 'item-1', title: 'Draft', brief: 'Write draft', status: 'planned', assignedAgent: 'w-1', dependencies: [] },
      ]},
      { id: 'p2', name: 'Phase 2', items: [
        { id: 'item-2', title: 'Review', brief: 'Review draft', status: 'planned', assignedAgent: 'w-2', dependencies: ['Draft'] },
      ]},
    ],
  }, 'po-1');
  assert.equal(hub.getProject('proj-plan-1').status, 'planning');

  // 3. PO creates tasks from plan items
  hub.handleCreateTasks('proj-plan-1', [
    { id: 'item-1', title: 'Draft', brief: 'Write draft', assignedAgent: 'w-1', phaseId: 'p1', dependencies: [] },
    { id: 'item-2', title: 'Review', brief: 'Review draft', assignedAgent: 'w-2', phaseId: 'p2', dependencies: ['Draft'] },
  ], 'po-1');
  assert.equal(hub.getBoard('proj-plan-1').getAllTasks().length, 2);

  // 4. Human approves
  const r = hub.handleApprove('proj-plan-1');
  assert.ok(r.ok);
  assert.equal(hub.getProject('proj-plan-1').status, 'active');

  // 5. Dispatch — only Phase 1
  const d = hub.handleRequestDispatch('proj-plan-1', 'po-1');
  assert.ok(d.ok);
  assert.deepEqual(d.dispatched, ['proj-plan-1__item-1']);
  assert.equal(hub.getBoard('proj-plan-1').getTask('item-2').status, 'pending');
});

// ─── handleQualityReview ─────────────────────────────────────────────

test('qualityReview: passed → task done', () => {
  const hub = setup();
  createTestProject(hub);

  // Setup: create tasks, approve, dispatch, accept, work, submit
  hub.handleCreateTasks('proj-plan-1', [
    { id: 't1', title: 'Task 1', brief: 'Do it', planItemId: 'item-1' },
  ], 'po-1');
  hub.handleApprove('proj-plan-1');

  const board = hub.getBoard('proj-plan-1');
  board.transition('t1', 'dispatched');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');
  board.transition('t1', 'submitted');

  const result = hub.handleQualityReview('proj-plan-1', 't1', { passed: true, feedback: 'Great work' }, 'po-1');
  assert.ok(result.ok);
  assert.equal(board.getTask('t1').status, 'done');
  assert.equal(board.getTask('t1').reviewResult.passed, true);
  assert.equal(board.getTask('t1').reviewResult.feedback, 'Great work');
});

test('qualityReview: failed → task rework', () => {
  const hub = setup();
  createTestProject(hub);

  hub.handleCreateTasks('proj-plan-1', [
    { id: 't1', title: 'Task 1', brief: 'Do it' },
  ], 'po-1');
  hub.handleApprove('proj-plan-1');

  const board = hub.getBoard('proj-plan-1');
  board.transition('t1', 'dispatched');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');
  board.transition('t1', 'submitted');

  const result = hub.handleQualityReview('proj-plan-1', 't1', { passed: false, feedback: 'Needs more detail' }, 'po-1');
  assert.ok(result.ok);
  assert.equal(result.rework, true);
  assert.equal(board.getTask('t1').status, 'in_progress');
  assert.equal(board.getTask('t1').reviewResult.passed, false);
});

test('qualityReview: updates plan item status on pass', () => {
  const hub = setup();
  createTestProject(hub);

  const plan = {
    analysis: 'test',
    phases: [{ id: 'p1', name: 'P1', items: [
      { id: 'item-1', title: 'Task 1', brief: 'Do it', status: 'planned', assignedAgent: 'w-1', dependencies: [], acceptanceCriteria: 'Must pass' },
    ]}],
  };
  hub.handleSubmitPlan('proj-plan-1', plan, 'po-1');
  hub.handleCreateTasks('proj-plan-1', [
    { id: 't1', title: 'Task 1', brief: 'Do it', planItemId: 'item-1' },
  ], 'po-1');
  hub.handleApprove('proj-plan-1');

  const board = hub.getBoard('proj-plan-1');
  board.transition('t1', 'dispatched');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');
  board.transition('t1', 'submitted');

  hub.handleQualityReview('proj-plan-1', 't1', { passed: true, feedback: 'OK' }, 'po-1');

  const project = hub.getProject('proj-plan-1');
  const item = project.plan.phases[0].items[0];
  assert.equal(item.status, 'completed');
});

// ─── handleRevisePlan ────────────────────────────────────────────────

test('revisePlan: adds new item + creates task', () => {
  const hub = setup();
  createTestProject(hub);

  hub.handleSubmitPlan('proj-plan-1', {
    analysis: 'test',
    phases: [{ id: 'p1', name: 'P1', items: [
      { id: 'item-1', title: 'Task 1', brief: 'Original', status: 'planned', assignedAgent: 'w-1', dependencies: [] },
    ]}],
  }, 'po-1');

  const result = hub.handleRevisePlan('proj-plan-1', {
    reason: 'Need extra task',
    changes: [
      { type: 'add', phaseId: 'p1', item: { id: 'item-new', title: 'New Task', brief: 'Added later', assignedAgent: 'w-2', dependencies: ['Task 1'], acceptanceCriteria: 'Must work' } },
    ],
  }, 'po-1');

  assert.ok(result.ok);
  assert.equal(result.version, 2);

  const project = hub.getProject('proj-plan-1');
  assert.equal(project.plan.phases[0].items.length, 2);
  assert.equal(project.plan.revisions.length, 1);

  // Task should exist on board
  const board = hub.getBoard('proj-plan-1');
  const task = board.getTask('item-new');
  assert.ok(task);
  assert.equal(task.title, 'New Task');
});

test('revisePlan: drops item + cancels task', () => {
  const hub = setup();
  createTestProject(hub);

  hub.handleSubmitPlan('proj-plan-1', {
    analysis: 'test',
    phases: [{ id: 'p1', name: 'P1', items: [
      { id: 'item-1', title: 'Task 1', brief: 'Will be dropped', status: 'planned', assignedAgent: 'w-1', dependencies: [] },
    ]}],
  }, 'po-1');

  // Create the task on board
  hub.handleCreateTasks('proj-plan-1', [{ id: 'item-1', title: 'Task 1', brief: 'Will be dropped' }], 'po-1');

  const result = hub.handleRevisePlan('proj-plan-1', {
    reason: 'No longer needed',
    changes: [{ type: 'drop', itemId: 'item-1', reason: 'Redundant' }],
  }, 'po-1');

  assert.ok(result.ok);
  const project = hub.getProject('proj-plan-1');
  assert.equal(project.plan.phases[0].items[0].status, 'dropped');

  const board = hub.getBoard('proj-plan-1');
  assert.equal(board.getTask('item-1').status, 'cancelled');
});

test('revisePlan: modifies item field', () => {
  const hub = setup();
  createTestProject(hub);

  hub.handleSubmitPlan('proj-plan-1', {
    analysis: 'test',
    phases: [{ id: 'p1', name: 'P1', items: [
      { id: 'item-1', title: 'Task 1', brief: 'Old brief', status: 'planned', assignedAgent: 'w-1', dependencies: [] },
    ]}],
  }, 'po-1');

  hub.handleRevisePlan('proj-plan-1', {
    reason: 'Clarify requirements',
    changes: [{ type: 'modify', itemId: 'item-1', field: 'brief', newValue: 'Updated brief with more detail' }],
  }, 'po-1');

  const project = hub.getProject('proj-plan-1');
  assert.equal(project.plan.phases[0].items[0].brief, 'Updated brief with more detail');
  assert.equal(project.plan.version, 2);
});

// ─── Phase-aware dispatch ────────────────────────────────────────────

test('dispatch: dependency-aware — independent later phases can dispatch', () => {
  const hub = setup();
  createTestProject(hub);

  hub.handleSubmitPlan('proj-plan-1', {
    analysis: 'test',
    phases: [
      { id: 'p1', name: 'Phase 1', items: [
        { id: 'item-1', title: 'T1', brief: 'Phase 1 task', status: 'planned', assignedAgent: 'w-1', dependencies: [] },
      ]},
      { id: 'p2', name: 'Phase 2', items: [
        { id: 'item-2', title: 'T2', brief: 'Phase 2 task', status: 'planned', assignedAgent: 'w-2', dependencies: [] },
      ]},
    ],
  }, 'po-1');

  hub.handleCreateTasks('proj-plan-1', [
    { id: 'item-1', title: 'T1', brief: 'Phase 1 task', assignedAgent: 'w-1', phaseId: 'p1', dependencies: [] },
    { id: 'item-2', title: 'T2', brief: 'Phase 2 task', assignedAgent: 'w-2', phaseId: 'p2', dependencies: [] },
  ], 'po-1');
  hub.handleApprove('proj-plan-1');

  // Dispatch — independent tasks from later phases can run without a phase gate.
  const result = hub.handleRequestDispatch('proj-plan-1', 'po-1');
  assert.ok(result.ok);
  assert.deepEqual(result.dispatched.sort(), ['proj-plan-1__item-1', 'proj-plan-1__item-2']);

  // Phase 2 task should no longer be held back just because phase 1 exists.
  const board = hub.getBoard('proj-plan-1');
  assert.equal(board.getTask('item-2').status, 'dispatched');
});

test('dispatch: explicit dependencies still gate later phase work', () => {
  const hub = setup();
  createTestProject(hub);

  hub.handleSubmitPlan('proj-plan-1', {
    analysis: 'test',
    phases: [
      { id: 'p1', name: 'Phase 1', items: [{ id: 'item-1', title: 'T1', brief: 'P1', status: 'planned', assignedAgent: 'w-1', dependencies: [] }] },
      { id: 'p2', name: 'Phase 2', items: [{ id: 'item-2', title: 'T2', brief: 'P2', status: 'planned', assignedAgent: 'w-2', dependencies: ['item-1'] }] },
    ],
  }, 'po-1');

  hub.handleCreateTasks('proj-plan-1', [
    { id: 'item-1', title: 'T1', brief: 'P1', assignedAgent: 'w-1', phaseId: 'p1', dependencies: [] },
    { id: 'item-2', title: 'T2', brief: 'P2', assignedAgent: 'w-2', phaseId: 'p2', dependencies: ['item-1'] },
  ], 'po-1');
  hub.handleApprove('proj-plan-1');

  // Dispatch and complete phase 1
  hub.handleRequestDispatch('proj-plan-1', 'po-1');
  const board = hub.getBoard('proj-plan-1');
  board.transition('item-1', 'accepted');
  board.transition('item-1', 'in_progress');
  board.transition('item-1', 'submitted');
  board.transition('item-1', 'done');

  // Now the explicit dependency is satisfied and phase 2 can dispatch.
  const result2 = hub.handleRequestDispatch('proj-plan-1', 'po-1');
  assert.ok(result2.ok);
  assert.deepEqual(result2.dispatched, ['proj-plan-1__item-2']);
});

test('dispatch: without plan, dispatches all (backward compat)', () => {
  const hub = setup();
  createTestProject(hub);

  hub.handleCreateTasks('proj-plan-1', [
    { id: 't1', title: 'Task 1', brief: 'A', assignedAgent: 'w-1', dependencies: [] },
    { id: 't2', title: 'Task 2', brief: 'B', assignedAgent: 'w-2', dependencies: [] },
  ], 'po-1');
  hub.handleApprove('proj-plan-1');

  const result = hub.handleRequestDispatch('proj-plan-1', 'po-1');
  assert.ok(result.ok);
  assert.equal(result.dispatched.length, 2);
});

// ─── Task board phase methods ────────────────────────────────────────

test('taskBoard: getPhaseStatus returns correct counts', () => {
  const hub = setup();
  createTestProject(hub);

  hub.handleCreateTasks('proj-plan-1', [
    { id: 't1', title: 'T1', brief: 'A', assignedAgent: 'w-1', phaseId: 'p1' },
    { id: 't2', title: 'T2', brief: 'B', assignedAgent: 'w-2', phaseId: 'p1' },
    { id: 't3', title: 'T3', brief: 'C', assignedAgent: 'w-1', phaseId: 'p2' },
  ], 'po-1');

  const board = hub.getBoard('proj-plan-1');
  board.transition('t1', 'dispatched');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');
  board.transition('t1', 'submitted');
  board.transition('t1', 'done');

  const status = board.getPhaseStatus('p1');
  assert.equal(status.total, 2);
  assert.equal(status.done, 1);
  assert.equal(status.pending, 1);
});

test('taskBoard: getPlanProgress aggregates all phases', () => {
  const hub = setup();
  createTestProject(hub);

  hub.handleCreateTasks('proj-plan-1', [
    { id: 't1', title: 'T1', brief: 'A', phaseId: 'p1' },
    { id: 't2', title: 'T2', brief: 'B', phaseId: 'p1' },
    { id: 't3', title: 'T3', brief: 'C', phaseId: 'p2' },
  ], 'po-1');

  const board = hub.getBoard('proj-plan-1');
  const progress = board.getPlanProgress();
  assert.equal(progress.total, 3);
  assert.equal(progress.done, 0);
  assert.equal(progress.phases.length, 2);
});

// ─── Idempotency guards ─────────────────────────────────────────────

test('approve: idempotent — second approve returns ok but alreadyActive', () => {
  const hub = setup();
  createTestProject(hub);
  hub.handleCreateTasks('proj-plan-1', [{ id: 't1', title: 'Task 1', brief: 'Do it' }], 'po-1');
  const r1 = hub.handleApprove('proj-plan-1');
  assert.ok(r1.ok);
  assert.equal(r1.alreadyActive, undefined);

  const r2 = hub.handleApprove('proj-plan-1');
  assert.ok(r2.ok);
  assert.equal(r2.alreadyActive, true);
});

test('submitPlan: rejects duplicate plan submission', () => {
  const hub = setup();
  createTestProject(hub);
  const plan = { analysis: 'test', phases: [{ id: 'p1', name: 'P1', items: [] }] };

  const r1 = hub.handleSubmitPlan('proj-plan-1', plan, 'po-1');
  assert.ok(r1.ok);

  const r2 = hub.handleSubmitPlan('proj-plan-1', plan, 'po-1');
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'plan_already_exists');
});

test('addTasks: rejects duplicate task IDs without overwriting existing task', () => {
  const hub = setup();
  createTestProject(hub);
  hub.handleCreateTasks('proj-plan-1', [
    { id: 't1', title: 'Original', brief: 'First version' },
  ], 'po-1');

  const board = hub.getBoard('proj-plan-1');
  board.transition('t1', 'dispatched');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');

  // Try to re-add same ID — should reject the batch and not overwrite
  const result = hub.handleCreateTasks('proj-plan-1', [
    { id: 't1', title: 'Duplicate', brief: 'Should be ignored' },
    { id: 't2', title: 'New task', brief: 'Should be added' },
  ], 'po-1');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'duplicate_local_task_id');
  assert.equal(board.getTask('t1').title, 'Original');
  assert.equal(board.getTask('t1').status, 'in_progress');
  assert.equal(board.getTask('t2'), undefined);
});

test('qualityReview: double-review race returns alreadyReviewed', () => {
  const hub = setup();
  createTestProject(hub);
  hub.handleCreateTasks('proj-plan-1', [{ id: 't1', title: 'Task 1', brief: 'Do it' }], 'po-1');
  hub.handleApprove('proj-plan-1');

  const board = hub.getBoard('proj-plan-1');
  board.transition('t1', 'dispatched');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');
  board.transition('t1', 'submitted');

  const r1 = hub.handleQualityReview('proj-plan-1', 't1', { passed: true, feedback: 'Good' }, 'po-1');
  assert.ok(r1.ok);
  assert.equal(board.getTask('t1').status, 'done');

  // Second review of same task (race condition) → should be no-op
  const r2 = hub.handleQualityReview('proj-plan-1', 't1', { passed: false, feedback: 'Bad' }, 'po-1');
  assert.ok(r2.ok);
  assert.equal(r2.alreadyReviewed, true);
  assert.equal(board.getTask('t1').status, 'done'); // not reworked
});

// ─── Run ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${t.name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`  结果: ${passed}/${passed + failed} 通过, ${failed} 失败`);
console.log(`${'─'.repeat(50)}\n`);

if (failed > 0) process.exit(1);

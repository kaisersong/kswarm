/**
 * test/plan-flow.test.js — Plan-Do 端到端集成测试
 *
 * 测试完整 Plan-Do 流程：
 * 创建项目 → PO 提交 Plan → 审批 → 阶段派发 → 质量验收（通过/返工）→ 阶段推进 → 修订 Plan → 最终交付
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

function setup() {
  return createHub({ silent: true });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── Helper: create project + submit plan + create tasks ───────

function setupProjectWithPlan(hub) {
  hub.createProject({
    id: 'proj-flow',
    name: 'Flow Test',
    goal: 'End-to-end plan-do test',
    requirements: 'Must pass quality review',
    poAgent: 'po-1',
    members: ['w-1', 'w-2'],
  });

  const plan = {
    analysis: 'This is a test project requiring 2 phases',
    successCriteria: ['All tasks completed', 'Quality review passed', 'Synthesis produced'],
    phases: [
      {
        id: 'p1', name: 'Phase 1 - Draft',
        items: [
          { id: 'item-1', title: 'Write draft', brief: 'Write initial draft', status: 'planned', assignedAgent: 'w-1', dependencies: [], acceptanceCriteria: 'Must be >500 words' },
          { id: 'item-2', title: 'Create diagram', brief: 'Create architecture diagram', status: 'planned', assignedAgent: 'w-2', dependencies: [], acceptanceCriteria: 'Must be SVG format' },
        ],
      },
      {
        id: 'p2', name: 'Phase 2 - Review',
        items: [
          { id: 'item-3', title: 'Review draft', brief: 'Adversarial review', status: 'planned', assignedAgent: 'w-2', dependencies: ['Write draft'], acceptanceCriteria: 'Must have 3+ critique points' },
          { id: 'item-4', title: 'Final revision', brief: 'Revise based on review', status: 'planned', assignedAgent: 'w-1', dependencies: ['Review draft'], acceptanceCriteria: 'Address all critiques' },
        ],
      },
    ],
  };

  hub.handleSubmitPlan('proj-flow', plan, 'po-1');

  // Create tasks from plan items
  const tasks = [];
  for (const phase of plan.phases) {
    for (const item of phase.items) {
      tasks.push({
        id: item.id,
        title: item.title,
        brief: item.brief,
        assignedAgent: item.assignedAgent,
        dependencies: item.dependencies,
        phaseId: phase.id,
        planItemId: item.id,
        acceptanceCriteria: item.acceptanceCriteria,
      });
    }
  }
  hub.handleCreateTasks('proj-flow', tasks, 'po-1');

  return hub;
}

// ─── Full lifecycle ─────────────────────────────────────────────

test('full flow: plan → approve → phase dispatch → review → rework → next phase', () => {
  const hub = setupProjectWithPlan(setup());

  // 1. Verify plan stored correctly
  const project = hub.getProject('proj-flow');
  assert.equal(project.plan.version, 1);
  assert.equal(project.plan.phases.length, 2);
  assert.equal(project.status, 'planning');

  // 2. Approve → active
  const approveResult = hub.handleApprove('proj-flow');
  assert.ok(approveResult.ok);
  assert.equal(hub.getProject('proj-flow').status, 'active');

  // 3. First dispatch: only Phase 1 tasks
  const dispatch1 = hub.handleRequestDispatch('proj-flow', 'po-1');
  assert.ok(dispatch1.ok);
  assert.deepEqual(dispatch1.dispatched.sort(), ['item-1', 'item-2']);

  // Phase 2 tasks should NOT be dispatched
  const board = hub.getBoard('proj-flow');
  assert.equal(board.getTask('item-3').status, 'pending');
  assert.equal(board.getTask('item-4').status, 'pending');

  // 4. Workers execute Phase 1
  board.transition('item-1', 'accepted');
  board.transition('item-1', 'in_progress');
  board.transition('item-1', 'submitted');

  board.transition('item-2', 'accepted');
  board.transition('item-2', 'in_progress');
  board.transition('item-2', 'submitted');

  // 5. Quality review item-1: FAIL → rework
  const review1 = hub.handleQualityReview('proj-flow', 'item-1', {
    passed: false, feedback: 'Only 200 words, need 500+',
  }, 'po-1');
  assert.ok(review1.ok);
  assert.equal(review1.rework, true);
  assert.equal(board.getTask('item-1').status, 'in_progress');

  // 6. Quality review item-2: PASS
  const review2 = hub.handleQualityReview('proj-flow', 'item-2', {
    passed: true, feedback: 'Good SVG diagram',
  }, 'po-1');
  assert.ok(review2.ok);
  assert.equal(board.getTask('item-2').status, 'done');

  // Verify plan item status updated
  assert.equal(project.plan.phases[0].items[1].status, 'completed');

  // 7. Worker reworks item-1, resubmits
  board.transition('item-1', 'submitted');

  // 8. Quality review item-1 again: PASS
  const review1b = hub.handleQualityReview('proj-flow', 'item-1', {
    passed: true, feedback: 'Now 600 words, meets criteria',
  }, 'po-1');
  assert.ok(review1b.ok);
  assert.equal(board.getTask('item-1').status, 'done');

  // 9. Phase 1 all done → dispatch Phase 2
  const dispatch2 = hub.handleRequestDispatch('proj-flow', 'po-1');
  assert.ok(dispatch2.ok);
  // item-3 has no dependency issues (Write draft is done), but item-4 depends on Review draft
  assert.deepEqual(dispatch2.dispatched, ['item-3']);

  // 10. Complete Phase 2
  board.transition('item-3', 'accepted');
  board.transition('item-3', 'in_progress');
  board.transition('item-3', 'submitted');
  hub.handleQualityReview('proj-flow', 'item-3', { passed: true, feedback: '5 critiques listed' }, 'po-1');
  assert.equal(board.getTask('item-3').status, 'done');

  // Now item-4 should be dispatchable
  const dispatch3 = hub.handleRequestDispatch('proj-flow', 'po-1');
  assert.deepEqual(dispatch3.dispatched, ['item-4']);

  board.transition('item-4', 'accepted');
  board.transition('item-4', 'in_progress');
  board.transition('item-4', 'submitted');
  hub.handleQualityReview('proj-flow', 'item-4', { passed: true, feedback: 'All critiques addressed' }, 'po-1');
  assert.equal(board.getTask('item-4').status, 'done');

  // 11. All tasks done
  assert.ok(board.isAllDone());

  // 12. Check plan progress
  const progress = board.getPlanProgress();
  assert.equal(progress.total, 4);
  assert.equal(progress.done, 4);
  assert.equal(progress.phases.length, 2);
});

test('plan revision: add + drop items mid-flight', () => {
  const hub = setupProjectWithPlan(setup());
  hub.handleApprove('proj-flow');

  // Dispatch Phase 1
  hub.handleRequestDispatch('proj-flow', 'po-1');
  const board = hub.getBoard('proj-flow');

  // Complete item-1
  board.transition('item-1', 'accepted');
  board.transition('item-1', 'in_progress');
  board.transition('item-1', 'submitted');
  hub.handleQualityReview('proj-flow', 'item-1', { passed: true, feedback: 'OK' }, 'po-1');

  // Revise plan: drop item-2, add new item
  const revision = hub.handleRevisePlan('proj-flow', {
    reason: 'Diagram not needed, adding peer review instead',
    changes: [
      { type: 'drop', itemId: 'item-2', reason: 'Diagram no longer needed' },
      {
        type: 'add', phaseId: 'p1',
        item: { id: 'item-5', title: 'Peer review draft', brief: 'Get peer feedback', assignedAgent: 'w-2', dependencies: ['Write draft'], acceptanceCriteria: 'Provide 3+ suggestions' },
      },
    ],
  }, 'po-1');

  assert.ok(revision.ok);
  assert.equal(revision.version, 2);

  const project = hub.getProject('proj-flow');
  assert.equal(project.plan.version, 2);
  assert.equal(project.plan.revisions.length, 1);

  // item-2 should be dropped/cancelled
  const p1Items = project.plan.phases[0].items;
  assert.equal(p1Items.find(i => i.id === 'item-2').status, 'dropped');
  assert.equal(board.getTask('item-2').status, 'cancelled');

  // item-5 should exist
  assert.equal(p1Items.length, 3);
  assert.ok(board.getTask('item-5'));
  assert.equal(board.getTask('item-5').title, 'Peer review draft');
});

test('approve guard: requires plan or tasks', () => {
  const hub = setup();
  hub.createProject({
    id: 'proj-guard',
    name: 'Guard Test',
    goal: 'Test approve guard',
    poAgent: 'po-1',
    members: [],
  });

  // No plan, no tasks → reject
  const r1 = hub.handleApprove('proj-guard');
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'no_plan_or_tasks');

  // Submit plan → approve works
  hub.handleSubmitPlan('proj-guard', {
    analysis: 'Simple test',
    phases: [{ id: 'p1', name: 'P1', items: [] }],
  }, 'po-1');
  const r2 = hub.handleApprove('proj-guard');
  assert.ok(r2.ok);
});

test('backward compat: projects without plan work normally', () => {
  const hub = setup();
  hub.createProject({
    id: 'proj-legacy',
    name: 'Legacy Project',
    goal: 'No plan',
    poAgent: 'po-1',
    members: ['w-1'],
  });

  // Create tasks directly (no plan)
  hub.handleCreateTasks('proj-legacy', [
    { id: 't1', title: 'Task A', brief: 'Do A', assignedAgent: 'w-1', dependencies: [] },
    { id: 't2', title: 'Task B', brief: 'Do B', assignedAgent: 'w-1', dependencies: ['Task A'] },
  ], 'po-1');

  // Approve works without plan
  const r = hub.handleApprove('proj-legacy');
  assert.ok(r.ok);

  // Dispatch works without plan (no phase filtering)
  const d = hub.handleRequestDispatch('proj-legacy', 'po-1');
  assert.ok(d.ok);
  assert.deepEqual(d.dispatched, ['t1']); // t2 has dependency

  // Complete t1 → t2 becomes dispatchable
  const board = hub.getBoard('proj-legacy');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');
  board.transition('t1', 'submitted');
  board.transition('t1', 'done');

  const d2 = hub.handleRequestDispatch('proj-legacy', 'po-1');
  assert.deepEqual(d2.dispatched, ['t2']);
});

test('quality review: non-PO rejected', () => {
  const hub = setupProjectWithPlan(setup());
  hub.handleApprove('proj-flow');
  hub.handleRequestDispatch('proj-flow', 'po-1');

  const board = hub.getBoard('proj-flow');
  board.transition('item-1', 'accepted');
  board.transition('item-1', 'in_progress');
  board.transition('item-1', 'submitted');

  const r = hub.handleQualityReview('proj-flow', 'item-1', { passed: true }, 'w-1');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_po');
});

test('phase progress: tracks correctly across mixed statuses', () => {
  const hub = setupProjectWithPlan(setup());
  hub.handleApprove('proj-flow');
  hub.handleRequestDispatch('proj-flow', 'po-1');

  const board = hub.getBoard('proj-flow');

  // item-1: done
  board.transition('item-1', 'accepted');
  board.transition('item-1', 'in_progress');
  board.transition('item-1', 'submitted');
  board.transition('item-1', 'done');

  // item-2: in_progress
  board.transition('item-2', 'accepted');
  board.transition('item-2', 'in_progress');

  const p1 = board.getPhaseStatus('p1');
  assert.equal(p1.total, 2);
  assert.equal(p1.done, 1);
  assert.equal(p1.inProgress, 1);
  assert.equal(p1.pending, 0);

  const p2 = board.getPhaseStatus('p2');
  assert.equal(p2.total, 2);
  assert.equal(p2.done, 0);
  assert.equal(p2.pending, 2);

  const progress = board.getPlanProgress();
  assert.equal(progress.total, 4);
  assert.equal(progress.done, 1);
  assert.equal(progress.phases.length, 2);
});

// ─── Run ─────────────────────────────────────────────────────────

let passed = 0, failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  \u2713 ${t.name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${t.name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log(`\n${'\u2500'.repeat(50)}`);
console.log(`  Plan-Do Flow: ${passed}/${passed + failed} passed, ${failed} failed`);
console.log(`${'\u2500'.repeat(50)}\n`);

if (failed > 0) process.exit(1);

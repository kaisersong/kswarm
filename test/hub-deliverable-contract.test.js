/**
 * KSwarm — hub deliverable contract integration tests
 *
 * Run: node test/hub-deliverable-contract.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('hub rejects markdown-only submission for an explicit pptx task before PO review', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-pptx', name: 'PPTX Project', goal: 'goal', poAgent: 'po', members: ['worker'] });
  hub.handleCreateTasks('proj-pptx', [
    {
      id: 'deck',
      title: '技术大会演讲报告',
      brief: '最终交付物必须是 PPTX 文件（.pptx），不是 Markdown 文档。',
      assignedAgent: 'worker',
    },
  ], 'po');
  hub.handleApprove('proj-pptx');
  hub.handleRequestDispatch('proj-pptx', 'po');

  const board = hub.getBoard('proj-pptx');
  const task = board.getTask('deck');
  const runId = task.activeRunId;
  assert.equal(hub.handleAcceptTask('proj-pptx', 'deck', 'worker', runId).ok, true);
  assert.equal(hub.handleProgress('proj-pptx', 'deck', 'started', 'worker', runId).ok, true);

  const rejected = hub.handleSubmitResult('proj-pptx', 'deck', {
    summary: '已经完成技术大会演讲报告内容，包含主题、结构、章节摘要、讲稿要点、受众分析、时间安排、演示节奏和后续建议，可以用于准备演讲材料。',
    artifacts: [{ filename: 'deck-report.md', path: 'artifacts/deck-report.md', mimeType: 'text/markdown' }],
  }, 'worker', runId);

  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'deliverable_contract_failed');
  assert.equal(rejected.failureClass, 'artifact_type_mismatch');
  assert.equal(board.getTask('deck').status, 'failed');
  assert.equal(board.getTask('deck').lastFailureClass, 'artifact_type_mismatch');
  assert.equal(board.getTask('deck').rejectedSubmissions.length, 1);
});

function setupDeliverableProject() {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-d', name: 'Deliver', goal: 'goal', poAgent: 'po', members: ['worker'] });
  hub.handleCreateTasks('proj-d', [{ id: 'item-1', title: 'Work', assignedAgent: 'worker' }], 'po');
  hub.handleApprove('proj-d');
  const board = hub.getBoard('proj-d');
  return { hub, board };
}

function driveTaskToDone(hub, board) {
  hub.handleRequestDispatch('proj-d', 'po');
  const task = board.getTask('item-1');
  const runId = task.activeRunId;
  hub.handleAcceptTask('proj-d', 'item-1', 'worker', runId);
  hub.handleProgress('proj-d', 'item-1', 'started', 'worker', runId);
  board.transition('item-1', 'submitted', { result: { summary: 'done' }, runId });
  board.transition('item-1', 'done');
}

test('handleDeliver refuses when validateDelivery fails and keeps project active', () => {
  const { hub, board } = setupDeliverableProject();
  driveTaskToDone(hub, board);

  const result = hub.handleDeliver('proj-d', { summary: 's' }, 'po', {
    validateDelivery: () => ({ ok: false, error: 'delivery_empty' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'delivery_empty');
  assert.equal(hub.getProject('proj-d').status, 'active');
});

test('handleDeliver no longer directly delivers; it registers a candidate awaiting user approval (design §8.2/§8.3)', () => {
  const { hub, board } = setupDeliverableProject();
  driveTaskToDone(hub, board);
  board.getTask('item-1').reviewResult = { passed: true, feedback: '' };

  const options = { validateDelivery: () => ({ ok: true }), taskId: 'item-1' };
  const first = hub.handleDeliver('proj-d', { summary: 's' }, 'po', options);
  assert.equal(first.ok, true);
  assert.equal(first.status, 'awaiting_user_approval');
  assert.equal(first.awaitingUserApproval, true);
  assert.ok(first.finalDeliverable?.deliverableId, 'handleDeliver 应该注册一个 FinalDeliverable candidate');
  // 关键收敛点：handleDeliver 本身绝不能让 project 进入 delivered 状态。
  // 只有 approveFinalDeliverable（要求 requestSource='user'）才能做到。
  assert.notEqual(hub.getProject('proj-d').status, 'delivered');
  assert.equal(hub.getProject('proj-d').deliveredAt, undefined);

  // 同一 PO 再次调用 handleDeliver（未提供 submissionIdempotencyKey）：由于生成的
  // idempotency key 基于 projectId/fromAgent/summary 派生，相同 summary 的重复调用
  // 应该复用同一个 candidate，而不是创建第二个。
  const second = hub.handleDeliver('proj-d', { summary: 's' }, 'po', options);
  assert.equal(second.ok, true);
  assert.equal(second.finalDeliverable.deliverableId, first.finalDeliverable.deliverableId);

  // 只有显式的用户批准才能让项目进入 delivered。
  const board2 = board;
  assert.ok(board2, 'board should still exist');
  const approval = hub.approveFinalDeliverable(
    'proj-d',
    first.finalDeliverable.deliverableId,
    { approvalIdempotencyKey: 'approve-1' },
    { requestSource: 'user', actorId: 'desktop-main' },
  );
  assert.equal(approval.ok, true);
  assert.equal(hub.getProject('proj-d').status, 'delivered');
  assert.equal(typeof hub.getProject('proj-d').deliveredAt, 'number');
});

test('handleDeliver is idempotent once the project is already delivered (post user-approval)', () => {
  const { hub, board } = setupDeliverableProject();
  driveTaskToDone(hub, board);
  board.getTask('item-1').reviewResult = { passed: true, feedback: '' };

  const registered = hub.handleDeliver('proj-d', { summary: 's' }, 'po', {
    validateDelivery: () => ({ ok: true }),
    taskId: 'item-1',
  });
  assert.equal(registered.ok, true);
  hub.approveFinalDeliverable(
    'proj-d',
    registered.finalDeliverable.deliverableId,
    { approvalIdempotencyKey: 'approve-1' },
    { requestSource: 'user', actorId: 'desktop-main' },
  );
  const deliveredAt = hub.getProject('proj-d').deliveredAt;
  assert.equal(typeof deliveredAt, 'number');

  const second = hub.handleDeliver('proj-d', { summary: 's2' }, 'po');
  assert.equal(second.ok, true);
  assert.equal(second.alreadyDelivered, true);
  assert.equal(hub.getProject('proj-d').deliveredAt, deliveredAt);
});

test('handleDeliver is gated by tasks_not_all_done', () => {
  const { hub } = setupDeliverableProject();
  const result = hub.handleDeliver('proj-d', { summary: 's' }, 'po');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'tasks_not_all_done');
});


test('registerFinalDeliverable binds an idempotency key to every canonical submission field', () => {
  const variants = [
    ['artifact identity', ({ payload }) => ({ ...payload, artifactRef: 'b.md' })],
    ['service hash', ({ payload, workspacePath }) => {
      writeFileSync(join(workspacePath, 'a.md'), '# Changed');
      return payload;
    }],
    ['kind', ({ payload }) => ({ ...payload, kind: 'none' })],
    ['expected format', ({ payload }) => ({ ...payload, expectedFormat: 'none' })],
    ['workspace binding', ({ payload, alternateWorkspacePath }) => ({
      ...payload,
      workspacePath: alternateWorkspacePath,
    })],
    ['source', ({ payload }) => ({ ...payload, source: 'script_workflow' })],
    ['submitter', ({ payload }) => ({ ...payload, submittedBy: 'reviewer' })],
    ['task binding', ({ payload }) => ({ ...payload, taskId: 'other-task' })],
    ['workflow binding', ({ payload }) => ({ ...payload, workflowRunId: 'other-run' })],
  ];

  for (const [field, mutate] of variants) {
    const hub = createHub({ silent: true });
    hub.createProject({ id: 'proj-fp', name: 'Fingerprint', goal: 'goal', poAgent: 'po', members: [] });
    const workspacePath = mkdtempSync(join(tmpdir(), 'kswarm-final-fp-'));
    const alternateWorkspacePath = mkdtempSync(join(tmpdir(), 'kswarm-final-fp-alt-'));
    writeFileSync(join(workspacePath, 'a.md'), '# A');
    writeFileSync(join(workspacePath, 'b.md'), '# B');
    writeFileSync(join(alternateWorkspacePath, 'a.md'), '# A');
    const context = { requestSource: 'agent', actorId: 'po' };
    const payload = {
      kind: 'file',
      artifactRef: 'a.md',
      expectedFormat: 'markdown',
      workspacePath,
      submissionIdempotencyKey: 'same-key',
      source: 'task_board',
      submittedBy: 'po',
    };

    const first = hub.registerFinalDeliverable('proj-fp', payload, context);
    assert.equal(first.ok, true, field);
    assert.match(first.finalDeliverable.submissionFingerprint, /^[a-f0-9]{64}$/);
    const snapshot = structuredClone(first.finalDeliverable);
    const replay = hub.registerFinalDeliverable('proj-fp', payload, context);
    assert.equal(replay.idempotent, true, field);
    assert.equal(replay.finalDeliverable, first.finalDeliverable, field);
    assert.deepEqual(first.finalDeliverable, snapshot, field);

    const conflict = hub.registerFinalDeliverable(
      'proj-fp',
      mutate({ payload, workspacePath, alternateWorkspacePath }),
      context,
    );
    assert.deepEqual(conflict, { ok: false, error: 'idempotency_conflict' }, field);
    assert.deepEqual(first.finalDeliverable, snapshot, field);
  }
});

test('legacy handleDeliver fallback key distinguishes different artifacts despite identical summaries', () => {
  const { hub, board } = setupDeliverableProject();
  driveTaskToDone(hub, board);
  const workspacePath = mkdtempSync(join(tmpdir(), 'kswarm-legacy-fp-'));
  writeFileSync(join(workspacePath, 'a.md'), '# A');
  writeFileSync(join(workspacePath, 'b.md'), '# B');
  const options = { validateDelivery: () => ({ ok: true }), expectedFormat: 'markdown', workspacePath };
  const first = hub.handleDeliver('proj-d', { summary: 'same', artifactRef: 'a.md' }, 'po', options);
  const second = hub.handleDeliver('proj-d', { summary: 'same', artifactRef: 'b.md' }, 'po', options);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.finalDeliverable.deliverableId, second.finalDeliverable.deliverableId);
});

test('legacy handleDeliver explicit key rejects a different payload without mutating the candidate', () => {
  const { hub, board } = setupDeliverableProject();
  driveTaskToDone(hub, board);
  const options = {
    validateDelivery: () => ({ ok: true }),
    kind: 'none',
    submissionIdempotencyKey: 'legacy-explicit-key',
  };

  const first = hub.handleDeliver('proj-d', { summary: 'first summary' }, 'po', options);
  const replay = hub.handleDeliver('proj-d', { summary: 'first summary' }, 'po', options);
  const conflict = hub.handleDeliver('proj-d', { summary: 'different summary' }, 'po', options);

  assert.equal(first.ok, true);
  assert.equal(replay.finalDeliverable, first.finalDeliverable);
  assert.deepEqual(conflict, { ok: false, error: 'idempotency_conflict' });
  assert.deepEqual(first.finalDeliverable.legacyDeliverablePayload, { summary: 'first summary' });
});

test('legacy summary-only fallback key binds the complete payload without mutating replays', () => {
  const { hub, board } = setupDeliverableProject();
  driveTaskToDone(hub, board);
  const options = { validateDelivery: () => ({ ok: true }), kind: 'none' };

  const first = hub.handleDeliver('proj-d', { summary: 'first summary' }, 'po', options);
  const replay = hub.handleDeliver('proj-d', { summary: 'first summary' }, 'po', options);
  const different = hub.handleDeliver('proj-d', { summary: 'different summary' }, 'po', options);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.finalDeliverable, first.finalDeliverable);
  assert.deepEqual(first.finalDeliverable.legacyDeliverablePayload, { summary: 'first summary' });
  assert.equal(different.ok, true);
  assert.notEqual(different.finalDeliverable.deliverableId, first.finalDeliverable.deliverableId);
  assert.deepEqual(first.finalDeliverable.legacyDeliverablePayload, { summary: 'first summary' });
});

function registerApprovalCandidate(hub, {
  requestSource = 'agent',
  taskId = 'item-1',
  requiresReview = true,
  submissionIdempotencyKey = 'gate-candidate',
} = {}) {
  return hub.registerFinalDeliverable('proj-d', {
    kind: 'none',
    taskId,
    requiresReview,
    source: 'task_board',
    submittedBy: requestSource === 'user' ? 'desktop-user' : 'worker',
    submissionIdempotencyKey,
  }, {
    requestSource,
    actorId: requestSource === 'user' ? 'desktop-user' : 'worker',
  });
}

function snapshotApprovalState(hub) {
  return {
    project: structuredClone(hub.getProject('proj-d')),
    deliverables: structuredClone(hub.listFinalDeliverables('proj-d')),
    decisions: structuredClone(hub.listReviewGateDecisions('proj-d')),
    conditions: structuredClone(hub.listReviewConditions('proj-d')),
    events: structuredClone(hub.getEventLog().getEvents()),
  };
}

function runSmokeReview(hub, status, findings = []) {
  const started = hub.startAgentReviewSmokeWorkflow('proj-d');
  const worker = hub.handleWorkflowNodeResult({
    workflowRunId: started.workflowRun.id,
    nodeId: 'worker-diagnose-project',
    attempt: started.dispatches[0].attempt,
    handoffId: started.dispatches[0].handoffId,
    fromAgent: started.dispatches[0].targetParticipantId,
    output: { summary: 'done' },
  });
  const reviewDispatch = worker.dispatches[0];
  const reviewed = hub.handleWorkflowNodeReview({
    workflowRunId: started.workflowRun.id,
    nodeId: 'reviewer-adversarial-check',
    attempt: reviewDispatch.attempt,
    handoffId: reviewDispatch.handoffId,
    fromAgent: reviewDispatch.targetParticipantId,
    reviewDecision: { status, reason: status, evidenceRefs: ['review:f1'] },
    output: { reviewEvidence: { findings } },
  });
  assert.equal(reviewed.ok, true);
  return reviewed.workflowRun;
}

function createBlockingCondition(hub) {
  runSmokeReview(hub, 'needs_rework', [{ id: 'f1', blocking: true }]);
  return hub.listReviewConditions('proj-d')[0];
}

function assertApprovalRejectedWithoutMutation(hub, deliverableId, expectedError, approvalKey) {
  const before = snapshotApprovalState(hub);
  const result = hub.approveFinalDeliverable(
    'proj-d',
    deliverableId,
    { approvalIdempotencyKey: approvalKey },
    { requestSource: 'user', actorId: 'desktop-user' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, expectedError);
  assert.deepEqual(snapshotApprovalState(hub), before);
}

test('approval requires a current passed review for a review-required task-bound candidate', () => {
  const { hub, board } = setupDeliverableProject();
  driveTaskToDone(hub, board);
  const registered = registerApprovalCandidate(hub);
  assert.equal(registered.ok, true);

  assertApprovalRejectedWithoutMutation(
    hub,
    registered.finalDeliverable.deliverableId,
    'final_deliverable_review_required',
    'approve-missing-review',
  );
});

test('approval rejects a current failed review even when a user candidate opts out of required review', () => {
  for (const requestSource of ['agent', 'user']) {
    const { hub, board } = setupDeliverableProject();
    driveTaskToDone(hub, board);
    board.getTask('item-1').reviewResult = { passed: false, feedback: 'failed' };
    const registered = registerApprovalCandidate(hub, {
      requestSource,
      requiresReview: false,
      submissionIdempotencyKey: `failed-review-${requestSource}`,
    });
    assert.equal(registered.ok, true);

    assertApprovalRejectedWithoutMutation(
      hub,
      registered.finalDeliverable.deliverableId,
      'final_deliverable_review_failed',
      `approve-failed-review-${requestSource}`,
    );
  }
});

test('approval rejects open and evidence-submitted blocking conditions without side effects', () => {
  for (const conditionStatus of ['open', 'evidence_submitted']) {
    const { hub, board } = setupDeliverableProject();
    driveTaskToDone(hub, board);
    board.getTask('item-1').reviewResult = { passed: true, feedback: '' };
    const registered = registerApprovalCandidate(hub, {
      submissionIdempotencyKey: `blocked-${conditionStatus}`,
    });
    const condition = createBlockingCondition(hub);
    if (conditionStatus === 'evidence_submitted') {
      const submitted = hub.submitReviewConditionEvidence(
        'proj-d',
        condition.conditionId,
        { evidenceRefs: ['artifact:proof'] },
        { requestSource: 'agent', actorId: 'worker' },
      );
      assert.equal(submitted.ok, true);
    }

    assertApprovalRejectedWithoutMutation(
      hub,
      registered.finalDeliverable.deliverableId,
      'open_review_conditions',
      `approve-${conditionStatus}`,
    );
  }
});

test('workflow-bound approval uses the bound run current gate decision', () => {
  for (const status of ['passed', 'needs_rework']) {
    const { hub, board } = setupDeliverableProject();
    driveTaskToDone(hub, board);
    const workflowRun = runSmokeReview(hub, status);
    const registered = hub.registerFinalDeliverable('proj-d', {
      kind: 'none',
      workflowRunId: workflowRun.id,
      source: 'script_workflow',
      submittedBy: 'worker',
      submissionIdempotencyKey: `workflow-${status}`,
    }, { requestSource: 'agent', actorId: 'worker' });
    assert.equal(registered.ok, true);

    if (status === 'passed') {
      const approved = hub.approveFinalDeliverable(
        'proj-d',
        registered.finalDeliverable.deliverableId,
        { approvalIdempotencyKey: 'approve-workflow-passed' },
        { requestSource: 'user', actorId: 'desktop-user' },
      );
      assert.equal(approved.ok, true);
    } else {
      assertApprovalRejectedWithoutMutation(
        hub,
        registered.finalDeliverable.deliverableId,
        'final_deliverable_review_failed',
        'approve-workflow-failed',
      );
    }
  }
});

test('only a user-origin candidate may skip a missing review', () => {
  const userSetup = setupDeliverableProject();
  driveTaskToDone(userSetup.hub, userSetup.board);
  const userCandidate = registerApprovalCandidate(userSetup.hub, {
    requestSource: 'user',
    taskId: null,
    requiresReview: false,
    submissionIdempotencyKey: 'user-no-review',
  });
  const approved = userSetup.hub.approveFinalDeliverable(
    'proj-d',
    userCandidate.finalDeliverable.deliverableId,
    { approvalIdempotencyKey: 'approve-user-no-review' },
    { requestSource: 'user', actorId: 'desktop-user' },
  );
  assert.equal(approved.ok, true);

  const agentSetup = setupDeliverableProject();
  driveTaskToDone(agentSetup.hub, agentSetup.board);
  const agentCandidate = registerApprovalCandidate(agentSetup.hub, {
    requestSource: 'agent',
    taskId: null,
    requiresReview: false,
    submissionIdempotencyKey: 'agent-no-review',
  });
  assert.equal(agentCandidate.finalDeliverable.requiresReview, true);
  assertApprovalRejectedWithoutMutation(
    agentSetup.hub,
    agentCandidate.finalDeliverable.deliverableId,
    'final_deliverable_review_required',
    'approve-agent-no-review',
  );
});

test('approval replay with the same key is stable while a different key reruns current review checks', () => {
  const { hub, board } = setupDeliverableProject();
  driveTaskToDone(hub, board);
  board.getTask('item-1').reviewResult = { passed: true, feedback: '' };
  const registered = registerApprovalCandidate(hub);
  const approved = hub.approveFinalDeliverable(
    'proj-d',
    registered.finalDeliverable.deliverableId,
    { approvalIdempotencyKey: 'approve-stable' },
    { requestSource: 'user', actorId: 'desktop-user' },
  );
  assert.equal(approved.ok, true);
  const approvedSnapshot = structuredClone(approved.finalDeliverable);
  board.getTask('item-1').reviewResult = { passed: false, feedback: 'new failure' };
  hub.getProject('proj-d').planRevisionRequired = { taskId: 'item-1', feedback: 'new blocker' };

  const replay = hub.approveFinalDeliverable(
    'proj-d',
    registered.finalDeliverable.deliverableId,
    { approvalIdempotencyKey: 'approve-stable' },
    { requestSource: 'user', actorId: 'desktop-user' },
  );
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.finalDeliverable, approvedSnapshot);

  hub.getProject('proj-d').planRevisionRequired = null;
  assertApprovalRejectedWithoutMutation(
    hub,
    registered.finalDeliverable.deliverableId,
    'final_deliverable_review_failed',
    'approve-different',
  );
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
  console.log(`\n${passed}/${tests.length} hub deliverable contract tests passed`);
}

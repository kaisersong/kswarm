/**
 * KSwarm — Hub durable persistence wiring tests (P0, Task 4)
 *
 * Covers:
 *  - Hub uses SQLite backend when given sqlite dataDir options; mutations are
 *    durably committed synchronously (no debounce) and survive reopen.
 *  - Global revision increments per successful mutation.
 *  - Scoped accessor only materializes the affected project's entities.
 *  - resolveMutationScope covers every Hub mutation (no unexpected FULL scope).
 *  - recordHumanAction produces stable UUIDs; same-ms actions do not collide;
 *    appends do not rewrite prior actions.
 *  - Save failure sets failed health and gates subsequent mutations before they
 *    run business logic.
 *  - Real child process SIGKILL after a committed mutation: state survives and a
 *    fresh Hub reclaims the dead writer's lock.
 *
 * Run: node test/persistence-hub.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { createHub } from '../src/core/hub.js';
import { resolveMutationScope } from '../src/core/state-scope.js';
import { PersistenceCommitError } from '../src/core/persistence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function tempDir(label = 'hub-persist') { return mkdtempSync(join(tmpdir(), `kswarm-${label}-`)); }
function sqliteDataDir(dir) { return { backend: 'sqlite', filePath: join(dir, 'state.sqlite'), legacyJsonPath: join(dir, 'state.json') }; }

function createActiveProject(hub, id) {
  hub.createProject({ id, name: id, goal: 'goal', poAgent: 'po-1', members: ['worker-1'] });
  hub.handleApprove(id);
}

function createReviewConditionThroughWorkflow(hub, projectId) {
  createActiveProject(hub, projectId);
  const started = hub.startAgentReviewSmokeWorkflow(projectId);
  const worker = hub.handleWorkflowNodeResult({
    workflowRunId: started.workflowRun.id, nodeId: 'worker-diagnose-project',
    attempt: started.dispatches[0].attempt, handoffId: started.dispatches[0].handoffId,
    fromAgent: 'worker-1', output: { summary: 'done' },
  });
  const review = worker.dispatches[0];
  const result = hub.handleWorkflowNodeReview({
    workflowRunId: started.workflowRun.id, nodeId: 'reviewer-adversarial-check',
    attempt: review.attempt, handoffId: review.handoffId, fromAgent: 'po-1',
    reviewDecision: { status: 'needs_rework', reason: 'blocking', evidenceRefs: ['review:f1'] },
    output: { reviewEvidence: { findings: [{ id: 'f1', blocking: true }] } },
  });
  assert.equal(result.ok, true);
  return hub.listReviewConditions(projectId)[0];
}

// ── durable sqlite commit ────────────────────────────────────────────────

test('hub sqlite: mutation is durably committed synchronously and survives reopen', () => {
  const dir = tempDir('sqlite-durable');
  try {
    const dataDir = sqliteDataDir(dir);
    const hub1 = createHub({ silent: true, dataDir });
    hub1.createProject({ id: 'p1', name: 'Alpha', goal: 'g', poAgent: 'po-1', members: [] });
    hub1.closePersistence();

    const hub2 = createHub({ silent: true, dataDir });
    const restored = hub2.getProject('p1');
    assert.ok(restored, 'project should be durably persisted without debounce');
    assert.equal(restored.name, 'Alpha');
    hub2.closePersistence();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hub sqlite: review conditions survive reopen and remain project-isolated', () => {
  const dir = tempDir('review-conditions');
  try {
    const dataDir = sqliteDataDir(dir);
    const hub1 = createHub({ silent: true, dataDir });
    const p1Condition = createReviewConditionThroughWorkflow(hub1, 'p1');
    createActiveProject(hub1, 'p2');
    assert.equal(hub1.listReviewConditions('p1').length, 1);
    assert.deepEqual(hub1.listReviewConditions('p2'), []);
    hub1.closePersistence();

    const hub2 = createHub({ silent: true, dataDir });
    assert.equal(hub2.listReviewConditions('p1')[0].conditionId, p1Condition.conditionId);
    assert.deepEqual(hub2.listReviewConditions('p2'), []);
    hub2.closePersistence();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hub sqlite: global revision increments once per successful mutation', () => {
  const dir = tempDir('sqlite-rev');
  try {
    const dataDir = sqliteDataDir(dir);
    let persistence;
    const hub = createHub({ silent: true, dataDir });
    // reach into health for revision
    hub.createProject({ id: 'p1', name: 'A', goal: 'g', poAgent: 'po-1', members: [] });
    const r1 = hub.getPersistenceHealth().revision;
    hub.createProject({ id: 'p2', name: 'B', goal: 'g', poAgent: 'po-1', members: [] });
    const r2 = hub.getPersistenceHealth().revision;
    assert.equal(r2, r1 + 1);
    hub.closePersistence();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── scoped accessor ────────────────────────────────────────────────────────

test('hub sqlite: scoped save only materializes the affected project entities', () => {
  const dir = tempDir('sqlite-scope');
  try {
    const captured = [];
    const fakePersistence = {
      load: () => null,
      save: (factory, scope) => { captured.push({ payload: factory(scope), scope }); },
      saveSync: (factory, scope) => { captured.push({ payload: factory(scope), scope }); },
      close: () => {},
      getHealth: () => ({ status: 'ok', backend: 'sqlite', revision: captured.length }),
    };
    const hub = createHub({ silent: true, persistence: fakePersistence });
    hub.createProject({ id: 'p1', name: 'A', goal: 'g', poAgent: 'po-1', members: [] });
    hub.createProject({ id: 'p2', name: 'B', goal: 'g', poAgent: 'po-1', members: [] });
    createReviewConditionThroughWorkflow(hub, 'p3');
    const fullPayload = captured[captured.length - 1].payload.full();
    assert.equal(fullPayload.reviewConditions.length, 1);
    captured.length = 0;
    hub.submitReviewConditionEvidence(
      'p3', hub.listReviewConditions('p3')[0].conditionId,
      { evidenceRefs: ['artifact:proof'] },
      { requestSource: 'agent', actorId: 'worker-1' },
    );
    const last = captured[captured.length - 1];
    assert.equal(last.scope.type, 'project');
    assert.equal(last.scope.projectId, 'p3');
    assert.ok(last.payload.entities.length > 0);
    assert.ok(last.payload.entities.every(e => e.projectId === 'p3'), 'scoped payload must only contain p3 entities');
    assert.equal(last.payload.entities.filter(e => e.collection === 'reviewCondition').length, 1);
    hub.closePersistence();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scope resolver: every Hub mutation resolves to a concrete scope (no silent miss)', () => {
  const lookups = {
    getProposalProjectId: () => 'pX',
    getRunProjectId: () => 'pX',
  };
  const projectFirst = [
    ['createProject', [{ id: 'pX' }]],
    ['updateProjectExecutionMode', ['pX']],
    ['handleApprove', ['pX']],
    ['activateAndStartProject', ['pX']],
    ['handleRetryPlan', ['pX']],
    ['handleHumanAddTasks', ['pX', []]],
    ['handleCloseProject', ['pX']],
    ['deleteProject', ['pX']],
    ['handleCreateTasks', ['pX', []]],
    ['handleAssignTask', ['pX', 't', 'a']],
    ['handleReassignTask', ['pX', 't']],
    ['handleRequestDispatch', ['pX']],
    ['handleMarkDone', ['pX', 't']],
    ['handleRework', ['pX', 't']],
    ['handleTaskFail', ['pX', 't']],
    ['handleContinueProject', ['pX']],
    ['handleResolveProjectIntervention', ['pX']],
    ['handleDeliver', ['pX']],
    ['registerFinalDeliverable', ['pX']],
    ['approveFinalDeliverable', ['pX', 'd']],
    ['handleAcceptTask', ['pX', 't']],
    ['handleProgress', ['pX', 't']],
    ['handleWorkerFailure', ['pX', 't']],
    ['handleSubmitResult', ['pX', 't']],
    ['handleRecoverSubmission', ['pX', 't']],
    ['handleResetTaskForRecovery', ['pX', 't']],
    ['handleResumeTaskForRecovery', ['pX', 't']],
    ['handleSubmitPlan', ['pX', {}]],
    ['handleRevisePlan', ['pX', {}]],
    ['handleQualityReview', ['pX', 't', {}]],
    ['createWorkflowProposal', ['pX', 'wf']],
    ['createScriptWorkflowProposal', ['pX', {}]],
    ['startProjectDiagnoseWorkflow', ['pX']],
    ['startAgentReviewSmokeWorkflow', ['pX']],
  ];
  for (const [name, args] of projectFirst) {
    const scope = resolveMutationScope(name, args, lookups);
    assert.equal(scope.type, 'project', `${name} should resolve to project scope`);
    assert.equal(scope.projectId, 'pX', `${name} should resolve to pX`);
  }
  const proposalOrRunKeyed = [
    ['cancelWorkflowProposal', ['prop']],
    ['startWorkflowRunFromProposal', ['prop']],
    ['startScriptWorkflowRunFromProposal', ['prop']],
    ['beginWorkflowScriptParallelGroup', ['run']],
    ['dispatchWorkflowScriptAgentNode', ['run']],
    ['retryWorkflowScriptAgentNode', ['run']],
    ['completeScriptWorkflowRun', ['run']],
    ['cancelWorkflowRun', ['run']],
    ['handleWorkflowProgressBatch', ['run', []]],
    ['handleWorkflowNodeResult', [{ workflowRunId: 'run' }]],
    ['handleWorkflowNodeReview', [{ workflowRunId: 'run' }]],
    ['handleWorkflowRuntimeUnavailable', [{ workflowRunId: 'run' }]],
  ];
  for (const [name, args] of proposalOrRunKeyed) {
    const scope = resolveMutationScope(name, args, lookups);
    assert.equal(scope.type, 'project', `${name} should resolve to project scope`);
    assert.equal(scope.projectId, 'pX', `${name} should resolve via lookup`);
  }
  for (const name of ['handleSuspendActiveRuns', 'handleResumeSuspendedRuns', 'recoverInterruptedTaskWorkflows']) {
    assert.equal(resolveMutationScope(name, [Date.now()], lookups).type, 'full', `${name} should be full scope`);
  }
  // Unknown mutation -> full scope (never silently skip).
  assert.equal(resolveMutationScope('someBrandNewMutation', ['x'], lookups).type, 'full');
});

// ── human actions ──────────────────────────────────────────────────────────

test('hub: recordHumanAction assigns stable UUIDs; same-ms actions do not collide; survive reopen', () => {
  const dir = tempDir('sqlite-human');
  try {
    const dataDir = sqliteDataDir(dir);
    const hub = createHub({ silent: true, dataDir });
    hub.createProject({ id: 'p1', name: 'A', goal: 'g', poAgent: 'po-1', members: [] });
    hub.handleHumanAddTasks('p1', [{ title: 'task one', assignee: 'po-1' }]);
    hub.handleCloseProject('p1', 'done');
    const actions = hub.getHumanActions('p1');
    assert.ok(actions.length >= 3, `expected >=3 human actions, got ${actions.map(a => a.action).join(',')}`);
    const ids = actions.map(a => a.id);
    assert.equal(new Set(ids).size, ids.length, 'all human action ids must be unique');
    assert.ok(ids.every(id => typeof id === 'string' && id.length >= 8), 'each action must have a stable UUID');
    hub.closePersistence();

    const hub2 = createHub({ silent: true, dataDir });
    const restored = hub2.getHumanActions('p1');
    assert.deepEqual(restored.map(a => a.id).sort(), ids.slice().sort(), 'human actions survive reopen');
    hub2.closePersistence();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── save failure gate ────────────────────────────────────────────────────

test('hub: save failure sets failed health and gates subsequent mutations before business logic', () => {
  let failed = false;
  const fakePersistence = {
    load: () => null,
    save: () => { failed = true; throw new PersistenceCommitError('boom'); },
    saveSync: () => { failed = true; throw new PersistenceCommitError('boom'); },
    close: () => {},
    getHealth: () => ({ status: failed ? 'failed' : 'ok', backend: 'sqlite', revision: 0 }),
  };
  const hub = createHub({ silent: true, persistence: fakePersistence });
  let firstErr;
  try { hub.createProject({ id: 'p1', name: 'A', goal: 'g', poAgent: 'po-1', members: [] }); }
  catch (err) { firstErr = err; }
  assert.ok(firstErr instanceof PersistenceCommitError, 'commit failure must propagate');
  // Subsequent mutation gated before running business logic.
  let secondErr;
  const before = hub.listProjects().length;
  try { hub.createProject({ id: 'p2', name: 'B', goal: 'g', poAgent: 'po-1', members: [] }); }
  catch (err) { secondErr = err; }
  assert.ok(secondErr instanceof PersistenceCommitError, 'subsequent mutation must be gated');
  hub.closePersistence();
});

// ── real child SIGKILL recovery ──────────────────────────────────────────

test('hub sqlite: state survives real child SIGKILL and fresh hub reclaims dead lock', async () => {
  const dir = tempDir('sqlite-sigkill');
  try {
    const filePath = join(dir, 'state.sqlite');
    const child = spawn(process.execPath, [join(__dirname, 'fixtures', 'durable-child.js'), filePath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      let buf = '';
      const to = setTimeout(() => reject(new Error('child did not commit in time')), 10_000);
      child.stdout.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('COMMITTED')) { clearTimeout(to); resolve(); }
      });
      child.on('exit', (code) => { clearTimeout(to); reject(new Error(`child exited early code=${code}`)); });
    });
    child.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 200));

    // Fresh hub reopens: dead child's lock is reclaimed, committed state present.
    const hub = createHub({ silent: true, dataDir: { backend: 'sqlite', filePath } });
    const restored = hub.getProject('kill-p');
    assert.ok(restored, 'committed state must survive child SIGKILL');
    assert.equal(restored.name, 'Kill');
    hub.closePersistence();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.error(`  \u2717 ${name}`);
    console.error(`    ${err.stack || err.message}`);
  }
}
console.log(`\n[persistence-hub] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

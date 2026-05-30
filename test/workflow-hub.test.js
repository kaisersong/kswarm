/**
 * KSwarm — workflow hub integration tests
 *
 * Run: node test/workflow-hub.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeTempDir(label = 'workflow-hub') {
  return mkdtempSync(join(tmpdir(), `kswarm-${label}-`));
}

function createActiveProject(hub, id = 'proj-workflow') {
  const project = hub.createProject({
    id,
    name: '动态工作流项目',
    goal: '验证 workflow 控制面',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
  });
  const added = hub.handleHumanAddTasks(id, [
    { title: '输出诊断材料', assignedAgent: 'xiaok-worker' },
  ]);
  assert.equal(added.ok, true);
  const approved = hub.handleApprove(id);
  assert.equal(approved.ok, true);
  return project;
}

test('starts project-diagnose workflow and records a durable run event', () => {
  const dir = makeTempDir('start');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);

    const result = hub.startProjectDiagnoseWorkflow('proj-workflow', { requestedBy: 'human', now: 1770000000000 });

    assert.equal(result.ok, true);
    assert.equal(result.workflowRun.workflowId, 'project-diagnose');
    assert.equal(result.workflowRun.status, 'completed');
    assert.equal(result.workflowRun.nodes.some(node => node.kind === 'agent_task'), false);
    assert.equal(hub.listProjectWorkflowRuns('proj-workflow').length, 1);
    assert.equal(hub.getWorkflowRun(result.workflowRun.id).id, result.workflowRun.id);

    const events = hub.getEventLog().getEvents().filter(event => event.type === 'workflow.run.completed');
    assert.equal(events.length, 1);
    assert.equal(events[0].workflowRunId, result.workflowRun.id);
    assert.equal(events[0].projectId, 'proj-workflow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow runs are isolated per project and sorted newest first', () => {
  const dir = makeTempDir('list');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub, 'proj-a');
    createActiveProject(hub, 'proj-b');

    const older = hub.startProjectDiagnoseWorkflow('proj-a', { requestedBy: 'human', now: 1770000000000 }).workflowRun;
    const newer = hub.startProjectDiagnoseWorkflow('proj-a', { requestedBy: 'human', now: 1770000005000 }).workflowRun;
    hub.startProjectDiagnoseWorkflow('proj-b', { requestedBy: 'human', now: 1770000010000 });

    const runs = hub.listProjectWorkflowRuns('proj-a');
    assert.deepEqual(runs.map(run => run.id), [newer.id, older.id]);
    assert.equal(runs.every(run => run.projectId === 'proj-a'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow runs survive hub restart through persisted state', async () => {
  const dir = makeTempDir('persist');
  try {
    const dataDir = join(dir, 'state.json');
    const first = createHub({ eventLogDir: join(dir, 'events-a'), dataDir, silent: true });
    createActiveProject(first, 'proj-restore');
    const started = first.startProjectDiagnoseWorkflow('proj-restore', { requestedBy: 'human', now: 1770000000000 });
    first.persistState();
    await new Promise(resolve => setTimeout(resolve, 650));

    const second = createHub({ eventLogDir: join(dir, 'events-b'), dataDir, silent: true });
    const restored = second.listProjectWorkflowRuns('proj-restore');
    assert.equal(restored.length, 1);
    assert.equal(restored[0].id, started.workflowRun.id);
    assert.equal(restored[0].status, 'completed');
    assert.equal(restored[0].diagnosis.recommendedActions[0].id, 'dispatch_tasks');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} workflow hub tests passed`);

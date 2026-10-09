import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/core/hub.js';
import { stageProjectActivity, readProjectActivity, ProjectActivityReservations, activityMutationCriticalBudget } from '../src/core/project-activity.js';

function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kswarm-activity-'));
  const dataDir = { backend: 'sqlite', filePath: join(root, 'state.sqlite'), legacyJsonPath: join(root, 'state.json') };
  const hub = createHub({ silent: true, dataDir, ...extra });
  t.after(() => { hub.closePersistence(); rmSync(root, { recursive: true, force: true }); });
  return { hub, dataDir };
}
const project = { id: 'p', name: 'Project', goal: 'g', poAgent: 'po', members: [] };

test('project activity is durably replayable across a real SQLite reopen', t => {
  const { hub, dataDir } = fixture(t);
  hub.createProject(project);
  const created = hub.getProjectActivity('p');
  assert.equal(created.events[0].kind, 'accepted');
  assert.ok(created.nextCursor >= 1);
  assert.equal(hub.updateProjectExecutionMode('p', 'workflow_preferred').ok, true);
  const active = hub.getProjectActivity('p', { after: created.nextCursor });
  assert.ok(active.events.length);
  assert.ok(active.events.every(event => event.kind !== 'completed'));
  hub.closePersistence();
  const reopened = createHub({ silent: true, dataDir });
  try { assert.deepEqual(reopened.getProjectActivity('p'), hub.getProjectActivity('p')); }
  finally { reopened.closePersistence(); }
});

test('failed source commit never exposes its staged activity', () => {
  let durable;
  let fail = false;
  let failed = false;
  const persistence = {
    load: () => null,
    save(build) { if (fail) { failed = true; throw new Error('commit fault'); } durable = structuredClone(build().full()); },
    getHealth: () => ({ status: failed ? 'failed' : 'ok' }),
  };
  const hub = createHub({ silent: true, persistence });
  hub.createProject(project);
  const before = hub.getProjectActivity('p');
  const notices = [];
  hub.subscribeProjectActivity(event => notices.push(event));
  fail = true;
  assert.throws(() => hub.updateProjectExecutionMode('p', 'workflow_preferred'), /commit fault/);
  assert.deepEqual(hub.getProjectActivity('p'), before);
  assert.equal(notices.length, 0);
  assert.equal(hub.getProject('p').activityEventSeq, before.nextCursor);
  assert.equal(durable.projects[0].activityEventSeq, before.nextCursor);
});
test('a save failure outside adapter health still fences dirty business state from later commits', () => {
  let fail = false;
  const saves = [];
  const persistence = { load: () => null, getHealth: () => ({ status: 'ok' }),
    save(build) { if (fail) throw new Error('pre-BEGIN payload fault'); saves.push(structuredClone(build().full())); } };
  const hub = createHub({ silent: true, persistence });
  hub.createProject(project);
  const before = hub.getProjectActivity('p'); fail = true;
  assert.throws(() => hub.updateProjectExecutionMode('p', 'workflow_preferred'), /pre-BEGIN payload fault/);
  fail = false;
  assert.throws(() => hub.updateProjectExecutionMode('p', 'direct'), /failed state/);
  assert.deepEqual(hub.getProjectActivity('p'), before);
  assert.equal(saves.length, 1);
});

test('activity pagination rejects invalid cursors and does not confuse child completion with project completion', t => {
  const { hub } = fixture(t);
  hub.createProject(project);
  assert.throws(() => hub.getProjectActivity('p', { after: -1 }), /invalid_activity_cursor/);
  assert.throws(() => hub.getProjectActivity('p', { limit: 1000 }), /invalid_activity_limit/);
  const page = hub.getProjectActivity('p', { after: 0, limit: 1 });
  assert.equal(page.events.length, 1);
  assert.equal(page.snapshot.status, 'created');
  assert.ok(page.sourceDataEpoch);
});

test('source progress storms are coalesced before commit while critical transitions survive', () => {
  const value = { ...project };
  stageProjectActivity(value, { status: 'created' }, [{ type: 'project.created', payload: {} }]);
  for (let index = 0; index < 10000; index++) {
    stageProjectActivity(value, { status: 'active', projectRevision: index }, [{ type: 'task.progress', payload: { summary: `progress ${index}` } }]);
  }
  stageProjectActivity(value, { status: 'closed' }, [{ type: 'project.closed', payload: {} }]);
  const page = readProjectActivity(value);
  assert.ok(page.events.length < 20);
  assert.equal(page.events.at(-1).kind, 'cancelled');
  assert.equal(page.snapshot.status, 'closed');
});
test('long-running ordinary progress compacts sparsely without dropping retained critical facts', () => {
  const value = { ...project };
  const clock = Date.now;
  let now = clock(); Date.now = () => now;
  try {
    stageProjectActivity(value, { status: 'created' }, [{ type: 'project.created', payload: {} }]);
    for (let index = 0; index < 10000; index++) {
      now += 1001;
      stageProjectActivity(value, { status: 'active', projectRevision: index }, [{ type: 'task.progress', payload: { summary: `progress ${index}` } }]);
      if (index % 500 === 0) stageProjectActivity(value, { status: 'active' }, [{ type: 'review.required', payload: { summary: `approval ${index}` } }]);
    }
    const page = readProjectActivity(value, { limit: 200 });
    assert.ok(value.activityEventOutbox.length <= 277);
    assert.equal(value.activityEventOutbox.filter(item => item.kind === 'input_required').length, 20);
    assert.ok(page.gapRanges.some(range => range.reason === 'progress_compacted'));
    assert.ok(page.coveredThrough < page.headSeq);
    const second = readProjectActivity(value, { after: page.coveredThrough, limit: 200 });
    assert.equal(second.coveredThrough, second.headSeq);
  } finally { Date.now = clock; }
});
test('50000 alternating deletion reasons remain bounded without crossing a retained critical fact, including clipped pages', () => {
  const now = Date.now();
  const value = { ...project, activityDataEpoch: 'epoch', activityEventSeq: 50001, activitySnapshot: { status: 'active' },
    activityGapRanges: Array.from({ length: 50000 }, (_, index) => ({ from: index + 1, through: index + 1,
      reason: index % 2 ? 'retention_expired' : 'progress_compacted' })).filter(range => range.from !== 25001),
    activityEventOutbox: [ { kind: 'input_required', eventId: 'critical', sourceSequence: 25001, occurredAt: now },
      { kind: 'progress', eventId: 'expired', sourceSequence: 50001, occurredAt: now - 8 * 86400_000 } ] };
  stageProjectActivity(value, { status: 'active' }, [{ type: 'task.progress', payload: {} }]);
  assert.equal(value.activityGapRanges.length, 2);
  assert.ok(value.activityGapRanges.every(range => range.reason === 'mixed_retention_compaction'));
  assert.ok(value.activityGapRanges.every(range => !(range.from <= 25001 && range.through >= 25001)));
  const first = readProjectActivity(value, { after: 20000, limit: 1 });
  assert.equal(first.events[0].eventId, 'critical');
  assert.equal(first.coveredThrough, 25001);
  assert.equal(first.gapRanges[0].from, 20001);
  assert.equal(first.gapRanges[0].reason, 'mixed_retention_compaction');
  const second = readProjectActivity(value, { after: first.coveredThrough, limit: 1 });
  assert.equal(second.coveredThrough, 50002);
  assert.equal(second.gapRanges[0].from, 25002);
});
test('a final critical fact can use the last slot without a following ordinary fact failing the batch', () => {
  const value = { ...project, activityDataEpoch: 'epoch', activityEventSeq: 4095, activitySnapshot: { status: 'active' },
    activityEventOutbox: Array.from({ length: 4095 }, (_, index) => ({ kind: 'input_required', sourceSequence: index + 1, eventId: `p#${index + 1}`, occurredAt: Date.now() })) };
  assert.doesNotThrow(() => stageProjectActivity(value, { status: 'delivered', deliveredAt: 100 }, [
    { type: 'project.delivered', payload: {} }, { type: 'final_deliverable.approved', payload: {} },
  ]));
  assert.equal(value.activityEventOutbox.length, 4096);
  assert.equal(value.activityEventOutbox.at(-1).kind, 'completed');
  assert.equal(value.activityEventSeq, 4096);
});
test('metadata updates to an already terminal project do not allocate another terminal fact', () => {
  const value = { ...project };
  stageProjectActivity(value, { status: 'delivered', deliveredAt: 100, projectRevision: 1 }, [{ type: 'project.delivered', payload: {} }]);
  stageProjectActivity(value, { status: 'delivered', deliveredAt: 100, projectRevision: 2 });
  assert.equal(value.activityEventOutbox.filter(item => item.kind === 'completed').length, 1);
  assert.equal(value.activityEventOutbox.at(-1).kind, 'progress');
});

test('delivery completion and a user closing without accepted delivery remain distinct source facts', () => {
  const delivered = { ...project, id: 'delivered' };
  stageProjectActivity(delivered, { status: 'delivered', deliveredAt: 100 }, [{ type: 'project.delivered', payload: { finalDeliverableId: 'artifact-ref' } }]);
  assert.equal(readProjectActivity(delivered).events.at(-1).kind, 'completed');
  const closed = { ...project, id: 'closed' };
  stageProjectActivity(closed, { status: 'closed' }, [{ type: 'project.closed', payload: {} }]);
  assert.equal(readProjectActivity(closed).events.at(-1).kind, 'cancelled');
});

test('known critical saturation rejects before business mutation while unrelated projects remain writable', t => {
  const { hub } = fixture(t);
  hub.createProject(project);
  const p = hub.getProject('p');
  p.activityEventOutbox = Array.from({ length: 4096 }, (_, index) => ({ kind: 'input_required', occurredAt: Date.now(), sourceSequence: index + 1 }));
  const before = hub.getProjectActivity('p');
  const notices = []; hub.subscribeProjectActivity(value => notices.push(value));
  assert.throws(() => hub.handleCloseProject('p'), /project_activity_capacity_exceeded/);
  assert.equal(hub.getProject('p').status, 'created');
  assert.equal(hub.getPersistenceHealth().status, 'ok');
  assert.deepEqual(hub.getProjectActivity('p'), before);
  assert.equal(notices.length, 0);
  assert.throws(() => hub.updateProjectExecutionMode('p', 'workflow_preferred'), /project_activity_capacity_exceeded/);
  hub.createProject({ ...project, id: 'other' });
  assert.equal(hub.updateProjectExecutionMode('other', 'workflow_preferred').ok, true);
});

test('concurrent admissions cannot both reserve the last critical slot; committed consumption and failure release do not leak capacity', () => {
  const reservations = new ProjectActivityReservations();
  const value = { activityEventOutbox: Array.from({ length: 4095 }, () => ({ kind: 'input_required' })) };
  const first = reservations.reserve('p', value, 1);
  assert.throws(() => reservations.reserve('p', value, 1), /project_activity_capacity_exceeded/);
  first.release(); first.release();
  const second = reservations.reserve('p', value, 1); second.consume(1);
  value.activityEventOutbox.push({ kind: 'completed' });
  assert.throws(() => reservations.reserve('p', value, 1), /project_activity_capacity_exceeded/);
  second.release();
  assert.doesNotThrow(() => reservations.reserve('other', {}, 1).release());
  assert.throws(() => activityMutationCriticalBudget('newUnreviewedWriter'), /unreviewed_project_activity_mutation/);
});
test('real FULL team metadata invalidation leaves a saturated terminal project healthy and does not duplicate its terminal', t => {
  const { hub } = fixture(t);
  hub.createProject({ ...project, members: ['worker'] }); hub.handleCloseProject('p');
  const p = hub.getProject('p');
  p.activityEventSeq = 4096;
  p.activityEventOutbox = Array.from({ length: 4096 }, (_, index) => ({ kind: 'input_required', occurredAt: Date.now(), sourceSequence: index + 1, eventId: `p#${index + 1}` }));
  const revision = p.projectRevision;
  assert.doesNotThrow(() => hub.invalidateTeamPlansForAgent('worker'));
  assert.equal(p.projectRevision, revision + 1);
  assert.equal(p.activityEventOutbox.length, 4096);
  assert.equal(hub.getPersistenceHealth().status, 'ok');
  hub.createProject({ ...project, id: 'other' });
  assert.equal(hub.updateProjectExecutionMode('other', 'workflow_preferred').ok, true);
});

test('direct workspace and server writers reject known pressure before any asynchronous check or business mutation', t => {
  let calls = 0;
  const { hub } = fixture(t, { brokerClient: { verifyWorkspaceMappingTicket: async () => { calls++; return {}; } } });
  hub.createProject(project);
  const p = hub.getProject('p');
  p.activityEventOutbox = Array.from({ length: 4096 }, (_, i) => ({ kind: 'input_required', sourceSequence: i + 1, occurredAt: Date.now() }));
  for (const action of [() => hub.applyWorkspaceMapping('p', {}, { requestSource: 'user' }), () => hub.dispatchWorkspaceTask('p', {}), () => hub.submitWorkspaceTaskResult('p', {}), () => hub.mutateProjectState('p', () => { p.status = 'closed'; })]) {
    assert.throws(action, /project_activity_capacity_exceeded/);
  }
  assert.equal(calls, 0); assert.equal(p.status, 'created'); assert.equal(hub.getPersistenceHealth().status, 'ok');
});
test('unwrapped persistence cannot append or announce source facts; an admitted production mutation can', t => {
  const { hub } = fixture(t); hub.createProject(project);
  const before = hub.getProjectActivity('p'); const p = hub.getProject('p');
  const notices = []; hub.subscribeProjectActivity(value => notices.push(value));
  p.projectRevision += 1; hub.persistState();
  assert.equal(notices.length, 0);
  assert.deepEqual(hub.getProjectActivity('p'), before);
  hub.mutateProjectState('p', () => { p.projectRevision += 1; });
  assert.ok(hub.getProjectActivity('p').headSeq > before.headSeq);
});
test('actual in-progress task observations move execution forward while metadata-only observations do not claim started', () => {
  const value = { ...project };
  stageProjectActivity(value, { status: 'active', tasks: [{ id: 'task', status: 'in_progress' }] }, [{ type: 'task.progress', payload: { taskId: 'task', stage: 'started' } }]);
  assert.equal(value.activityEventOutbox.at(-1).executionStarted, true);
});

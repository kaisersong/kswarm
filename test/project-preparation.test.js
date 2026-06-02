import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/core/hub.js';

const now = 1779550000000;

const desktopPo = {
  id: 'xiaok-po',
  name: 'Xiaok PO',
  roles: ['project_owner'],
  runtimeType: 'xiaok',
  runtimeSource: 'desktop-agent-runtime',
  runtimeHealth: {
    state: 'healthy',
    taskCapabilities: ['planning', 'research'],
    outputCapabilities: ['markdown'],
  },
};

const desktopWorker = {
  id: 'xiaok-worker',
  name: 'Xiaok Worker',
  roles: ['worker'],
  runtimeType: 'xiaok',
  runtimeSource: 'desktop-agent-runtime',
  runtimeHealth: {
    state: 'healthy',
    taskCapabilities: ['research'],
    outputCapabilities: ['markdown'],
  },
};

function createMockBridge() {
  const sent = [];
  return {
    send(message) {
      sent.push(message);
    },
    getSentOf(kind) {
      return sent.filter(message => message.kind === kind);
    },
  };
}

function createProject(hub, overrides = {}) {
  return hub.createProject({
    id: overrides.id || 'proj-prep',
    name: 'Preparation Project',
    goal: 'Verify preparation gate',
    poAgent: overrides.poAgent || 'xiaok-po',
    members: overrides.members || ['xiaok-worker'],
    agentSelection: overrides.agentSelection || {
      poAgent: { agentId: overrides.poAgent || 'xiaok-po', source: 'default_seed' },
      members: (overrides.members || ['xiaok-worker']).map(agentId => ({ agentId, source: 'default_seed' })),
    },
    preparationContext: overrides.preparationContext,
    autoAssignPo: overrides.autoAssignPo,
  });
}

{
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });

  const project = createProject(hub, {
    preparationContext: {
      agents: [desktopPo, desktopWorker],
      participants: [],
      probeResults: {},
      now,
    },
  });

  assert.equal(project.status, 'created');
  assert.equal(project.preparation.state, 'blocked');
  assert.equal(project.preparation.blockers[0].agentId, 'xiaok-po');
  assert.equal(project.preparation.blockers[0].reason, 'broker_participant_missing');
  assert.equal(bridge.getSentOf('assign_po').length, 0);
}

{
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });

  const project = createProject(hub, {
    id: 'proj-ready',
    preparationContext: {
      agents: [desktopPo, desktopWorker],
      participants: [
        { participantId: 'xiaok-po', lastSeenAt: now },
        { participantId: 'xiaok-worker', lastSeenAt: now },
      ],
      probeResults: {
        'xiaok-po': { ok: true, checkedAt: now },
        'xiaok-worker': { ok: true, checkedAt: now },
      },
      now,
    },
  });

  assert.equal(project.preparation.state, 'ready');
  const assignPoMessages = bridge.getSentOf('assign_po');
  assert.equal(assignPoMessages.length, 1);
  assert.equal(assignPoMessages[0].toParticipantId, 'xiaok-po');
}

{
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });

  const project = createProject(hub, {
    id: 'proj-auto-start-disabled',
    autoAssignPo: false,
    preparationContext: {
      agents: [desktopPo, desktopWorker],
      participants: [
        { participantId: 'xiaok-po', lastSeenAt: now },
        { participantId: 'xiaok-worker', lastSeenAt: now },
      ],
      probeResults: {
        'xiaok-po': { ok: true, checkedAt: now },
        'xiaok-worker': { ok: true, checkedAt: now },
      },
      now,
    },
  });

  assert.equal(project.preparation.state, 'ready');
  assert.equal(bridge.getSentOf('assign_po').length, 0);
  const events = hub.getEventLog().getEvents().map(event => event.type);
  assert.equal(events.includes('po.assigned'), false);
}

{
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });

  const project = createProject(hub, {
    id: 'proj-explicit',
    poAgent: 'cli-qoder',
    members: ['xiaok-worker'],
    agentSelection: {
      poAgent: { agentId: 'cli-qoder', source: 'explicit_user' },
      members: [{ agentId: 'xiaok-worker', source: 'default_seed' }],
    },
    preparationContext: {
      agents: [desktopWorker],
      participants: [{ participantId: 'xiaok-worker', lastSeenAt: now }],
      probeResults: { 'xiaok-worker': { ok: true, checkedAt: now } },
      now,
    },
  });

  assert.equal(project.poAgent, 'cli-qoder');
  assert.equal(project.preparation.state, 'blocked');
  assert.equal(project.preparation.blockers[0].agentId, 'cli-qoder');
  assert.equal(project.preparation.blockers[0].selectedBy, 'explicit_user');
  assert.equal(bridge.getSentOf('assign_po').length, 0);
}

{
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });

  const project = createProject(hub, {
    id: 'proj-invalid-member',
    members: ['xiaok-worker', null, { source: 'default_seed' }, ''],
    agentSelection: {
      poAgent: { agentId: 'xiaok-po', source: 'default_seed' },
      members: [
        { agentId: 'xiaok-worker', source: 'default_seed' },
        { agentId: { source: 'default_seed' }, source: 'default_seed' },
        null,
      ],
    },
    preparationContext: {
      agents: [desktopPo, desktopWorker],
      participants: [
        { participantId: 'xiaok-po', lastSeenAt: now },
        { participantId: 'xiaok-worker', lastSeenAt: now },
      ],
      probeResults: {
        'xiaok-po': { ok: true, checkedAt: now },
        'xiaok-worker': { ok: true, checkedAt: now },
      },
      now,
    },
  });

  assert.deepEqual(project.members, ['xiaok-worker']);
  assert.deepEqual(project.agentSelection.members, [
    { agentId: 'xiaok-worker', source: 'default_seed' },
  ]);
  assert.equal(project.preparation.state, 'ready');
  assert.equal(project.preparation.blockers.some(blocker => blocker.agentId === '[object Object]'), false);
}

{
  const stateFile = join(mkdtempSync(join(tmpdir(), 'kswarm-legacy-prep-')), 'state.json');
  writeFileSync(stateFile, JSON.stringify({
    projects: [
      {
        id: 'proj-legacy-prep',
        name: 'Legacy Preparation Project',
        goal: 'Verify legacy preparation cleanup',
        poAgent: 'xiaok-po',
        members: ['xiaok-worker', null],
        agentSelection: {
          poAgent: { agentId: 'xiaok-po', source: 'default_seed' },
          members: [
            { agentId: 'xiaok-worker', source: 'default_seed' },
            { agentId: { source: 'default_seed' }, source: 'default_seed' },
          ],
        },
        preparation: {
          state: 'blocked',
          checkedAt: now,
          generation: 2,
          checks: [
            { agentId: 'xiaok-po', role: 'project_owner', ready: true, readiness: 'ready' },
            { agentId: 'xiaok-worker', role: 'worker', ready: true, readiness: 'ready' },
            { agentId: '[object Object]', role: 'worker', ready: false, readiness: 'unavailable', reason: 'agent_missing' },
          ],
          blockers: [
            { agentId: '[object Object]', role: 'worker', reason: 'agent_missing', readiness: 'unavailable' },
          ],
          replacements: [],
        },
        status: 'planning',
        createdAt: now,
      },
    ],
    boards: [{ projectId: 'proj-legacy-prep', tasks: [] }],
    workflowRuns: [],
    workflowProposals: [],
  }));

  const hub = createHub({ silent: true, dataDir: stateFile });
  const project = hub.getProject('proj-legacy-prep');

  assert.deepEqual(project.members, ['xiaok-worker']);
  assert.deepEqual(project.agentSelection.members, [
    { agentId: 'xiaok-worker', source: 'default_seed' },
  ]);
  assert.equal(project.preparation.state, 'ready');
  assert.deepEqual(project.preparation.blockers, []);
  assert.equal(project.preparation.checks.some(check => check.agentId === '[object Object]'), false);
}

console.log('project-preparation tests passed');

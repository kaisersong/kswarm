import assert from 'node:assert/strict';
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

console.log('project-preparation tests passed');

import assert from 'node:assert/strict';
import {
  classifyAgentReadiness,
  deriveProjectPreparation,
  normalizeReadinessProbeResult,
  selectDefaultSeedWorkerReplacement,
} from '../src/core/agent-readiness.js';

const now = 1779550000000;

const desktopPo = {
  id: 'xiaok-po',
  roles: ['project_owner'],
  runtimeType: 'xiaok',
  runtimeSource: 'desktop-agent-runtime',
  execution: { mode: 'hosted', hostParticipantId: 'xiaok-desktop' },
  runtimeHealth: {
    state: 'healthy',
    taskCapabilities: ['planning', 'research'],
    outputCapabilities: ['markdown', 'report_html'],
  },
};

const desktopWorker = {
  id: 'xiaok-worker',
  roles: ['worker'],
  runtimeType: 'xiaok',
  runtimeSource: 'desktop-agent-runtime',
  execution: { mode: 'hosted', hostParticipantId: 'xiaok-desktop' },
  runtimeHealth: {
    state: 'healthy',
    taskCapabilities: ['research', 'analysis'],
    outputCapabilities: ['markdown', 'report_html'],
  },
};

{
  const readiness = classifyAgentReadiness(desktopPo, {
    role: 'project_owner',
    participants: [{ participantId: 'xiaok-desktop', lastSeenAt: now }],
    probeResults: { 'xiaok-po': { ok: true, checkedAt: now } },
    now,
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.reason, null);
  assert.equal(readiness.participantId, 'xiaok-desktop');
}

{
  const readiness = classifyAgentReadiness(desktopPo, {
    role: 'project_owner',
    participants: [],
    probeResults: {},
    now,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, 'broker_participant_missing');
}

{
  const readiness = classifyAgentReadiness({
    ...desktopWorker,
    outputCapabilities: ['json'],
    runtimeHealth: {
      ...desktopWorker.runtimeHealth,
      outputCapabilities: ['json'],
    },
  }, {
    role: 'worker',
    requiredOutputs: [{ type: 'markdown', enforcement: 'hard' }],
    participants: [{ participantId: 'xiaok-desktop', lastSeenAt: now }],
    probeResults: { 'xiaok-worker': { ok: true, checkedAt: now } },
    now,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, 'output_missing:markdown');
}

{
  const readiness = classifyAgentReadiness({
    ...desktopWorker,
    outputCapabilities: ['json'],
    runtimeHealth: {
      ...desktopWorker.runtimeHealth,
      outputCapabilities: ['markdown'],
    },
  }, {
    role: 'worker',
    requiredOutputs: [{ type: 'markdown', enforcement: 'hard' }],
    participants: [{ participantId: 'xiaok-desktop', lastSeenAt: now }],
    probeResults: { 'xiaok-worker': { ok: true, checkedAt: now } },
    now,
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.reason, null);
}

{
  const readiness = classifyAgentReadiness(desktopWorker, {
    role: 'worker',
    requiredOutputs: [{ type: 'html_report', enforcement: 'hard' }],
    participants: [{ participantId: 'xiaok-desktop', lastSeenAt: now }],
    probeResults: { 'xiaok-worker': { ok: true, checkedAt: now } },
    now,
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.reason, null);
}

{
  const readiness = classifyAgentReadiness(desktopWorker, {
    role: 'worker',
    participants: [{ participantId: 'xiaok-desktop', lastSeenAt: now }],
    probeResults: { 'xiaok-worker': { ok: false, reason: 'model_config_missing', checkedAt: now } },
    now,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, 'model_config_missing');
}

{
  const readiness = classifyAgentReadiness(desktopPo, {
    role: 'project_owner',
    participants: [{ participantId: 'xiaok-desktop', lastSeenAt: now }],
    probeResults: { 'xiaok-po': { ok: false, reason: 'readiness_probe_timeout', checkedAt: now } },
    now,
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.reason, null);
  assert.ok(readiness.checks.includes('readiness_probe_deferred'));
}

{
  const readiness = classifyAgentReadiness(desktopWorker, {
    role: 'worker',
    participants: [{ participantId: 'xiaok-desktop', lastSeenAt: now }],
    probeResults: { 'xiaok-worker': { ok: false, reason: 'readiness_probe_timeout', checkedAt: now } },
    now,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, 'readiness_probe_timeout');
}

{
  const project = {
    id: 'proj-1',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
    agentSelection: {
      poAgent: { agentId: 'xiaok-po', source: 'default_seed' },
      members: [{ agentId: 'xiaok-worker', source: 'default_seed' }],
    },
  };
  const prep = deriveProjectPreparation({
    project,
    agents: [desktopPo, desktopWorker],
    participants: [
      { participantId: 'xiaok-desktop', lastSeenAt: now },
    ],
    probeResults: {
      'xiaok-po': { ok: true, checkedAt: now },
      'xiaok-worker': { ok: true, checkedAt: now },
    },
    capacityByAgentId: {
      'xiaok-worker': { capacity: 'available', canCreateRuntimeInstance: true },
    },
    now,
  });
  assert.equal(prep.state, 'ready');
  assert.equal(prep.blockers.length, 0);
  assert.equal(prep.checks.find(check => check.agentId === 'xiaok-worker').capacity, 'available');
}

{
  const project = {
    id: 'proj-2',
    poAgent: 'cli-qoder',
    members: ['xiaok-worker'],
    agentSelection: {
      poAgent: { agentId: 'cli-qoder', source: 'explicit_user' },
      members: [{ agentId: 'xiaok-worker', source: 'default_seed' }],
    },
  };
  const prep = deriveProjectPreparation({
    project,
    agents: [desktopWorker],
    participants: [{ participantId: 'xiaok-desktop', lastSeenAt: now }],
    probeResults: { 'xiaok-worker': { ok: true, checkedAt: now } },
    now,
  });
  assert.equal(prep.state, 'blocked');
  assert.equal(prep.blockers[0].agentId, 'cli-qoder');
  assert.equal(prep.blockers[0].selectedBy, 'explicit_user');
}

{
  const probe = normalizeReadinessProbeResult({
    agentId: 'xiaok-po',
    ok: false,
    error: 'model_config_missing',
  }, now);
  assert.equal(probe.ok, false);
  assert.equal(probe.reason, 'model_config_missing');
  assert.equal(probe.checkedAt, now);
}

{
  const project = {
    id: 'proj-3',
    poAgent: 'xiaok-po',
    members: ['cli-xiaok', 'xiaok'],
    agentSelection: {
      poAgent: { agentId: 'xiaok-po', source: 'default_seed' },
      members: [
        { agentId: 'cli-xiaok', source: 'default_seed' },
        { agentId: 'xiaok', source: 'default_seed' },
      ],
    },
  };
  const cooldownWorker = id => ({
    id,
    roles: ['worker'],
    runtimeHealth: { state: 'cooldown', outputCapabilities: ['markdown'], taskCapabilities: ['research'] },
  });
  const prep = deriveProjectPreparation({
    project,
    agents: [desktopPo, cooldownWorker('cli-xiaok'), cooldownWorker('xiaok'), desktopWorker],
    participants: [
      { participantId: 'xiaok-desktop', lastSeenAt: now },
    ],
    probeResults: {
      'xiaok-po': { ok: true, checkedAt: now },
      'xiaok-worker': { ok: true, checkedAt: now },
    },
    now,
  });

  const replacement = selectDefaultSeedWorkerReplacement({
    project,
    preparation: prep,
    agents: [desktopPo, cooldownWorker('cli-xiaok'), cooldownWorker('xiaok'), desktopWorker],
    participants: [
      { participantId: 'xiaok-desktop', lastSeenAt: now },
    ],
    probeResults: {
      'xiaok-po': { ok: true, checkedAt: now },
      'xiaok-worker': { ok: true, checkedAt: now },
    },
    now,
  });

  assert.equal(prep.state, 'blocked');
  assert.equal(replacement.toAgentId, 'xiaok-worker');
  assert.deepEqual(replacement.fromAgentIds, ['cli-xiaok', 'xiaok']);
}

{
  const project = {
    id: 'proj-4',
    poAgent: 'xiaok-po',
    members: ['cli-qoder'],
    agentSelection: {
      poAgent: { agentId: 'xiaok-po', source: 'default_seed' },
      members: [{ agentId: 'cli-qoder', source: 'explicit_user' }],
    },
  };
  const prep = deriveProjectPreparation({
    project,
    agents: [desktopPo, { id: 'cli-qoder', roles: ['worker'], runtimeHealth: { state: 'cooldown' } }, desktopWorker],
    participants: [
      { participantId: 'xiaok-desktop', lastSeenAt: now },
    ],
    probeResults: {
      'xiaok-po': { ok: true, checkedAt: now },
      'xiaok-worker': { ok: true, checkedAt: now },
    },
    now,
  });

  assert.equal(selectDefaultSeedWorkerReplacement({
    project,
    preparation: prep,
    agents: [desktopPo, desktopWorker],
    participants: [{ participantId: 'xiaok-desktop', lastSeenAt: now }],
    probeResults: { 'xiaok-worker': { ok: true, checkedAt: now } },
    now,
  }), null);
}

console.log('agent-readiness tests passed');

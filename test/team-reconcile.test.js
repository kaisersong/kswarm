import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getCapabilityCatalog } from '../src/core/capability-catalog.js';
import { createProjectTeamPlan } from '../src/core/team-planner.js';
import { createTeamOperationStore } from '../src/core/team-operation-store.js';
import { createTeamProvisioningHub } from '../src/core/persistence-hub.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'kswarm-team-'));
  const project = { id: 'project-1', name: 'Alpha', projectRevision: 4, poAgent: 'po', members: [] };
  const agents = new Map([{ id: 'po', roles: ['project_owner'], capabilities: ['planning'], runtimeHealth: { state: 'ready' } }]);
  const hub = {
    getProject: () => project,
    setProjectTeamPlan: (_projectId, plan) => { project.teamPlan = plan; return { ok: true, project }; },
    attachTeamOperationMembers: (_projectId, input) => {
      project.members = [...new Set([...project.members, ...input.agentIds])];
      project.projectRevision += 1;
      return { ok: true, project };
    },
  };
  const agentStore = {
    get: (id) => agents.get(id) ?? null,
    list: () => [...agents.values()],
    create: (agent) => { agents.set(agent.id, agent); return { ok: true, agent }; },
  };
  const operations = createTeamOperationStore({ filePath: join(directory, 'team-operations.json') });
  return { directory, project, agents, hub, agentStore, operations };
}

test('writes the journal before GET-first provisioning and retries by client request key', () => {
  const fixture = createFixture();
  try {
    const catalog = getCapabilityCatalog();
    const planResult = createProjectTeamPlan({
      project: fixture.project,
      agents: fixture.agentStore.list(),
      catalog,
      needs: [{ needKey: 'reviewer', requiredCapabilities: ['review'], responsibilities: ['review'], requiresIndependentReviewer: false }],
    });
    assert.equal(planResult.ok, true);
    fixture.hub.setProjectTeamPlan(fixture.project.id, planResult.plan);
    const coordinator = createTeamProvisioningHub({ hub: fixture.hub, agentStore: fixture.agentStore, operationStore: fixture.operations, catalog });

    const first = coordinator.reconcile({ projectId: fixture.project.id, planDigest: planResult.plan.planDigest, expectedProjectRevision: 4, clientRequestKey: 'request-1', requestSource: 'user' });
    assert.equal(first.ok, true);
    assert.equal(first.operation.status, 'applied');
    assert.equal(fixture.operations.get(first.operation.id).status, 'applied');
    assert.equal(fixture.project.members.length, 1);

    const repeated = coordinator.reconcile({ projectId: fixture.project.id, planDigest: planResult.plan.planDigest, expectedProjectRevision: 4, clientRequestKey: 'request-1', requestSource: 'user' });
    assert.equal(repeated.ok, true);
    assert.equal(repeated.operation.id, first.operation.id);
    assert.equal(fixture.project.members.length, 1);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects stale plans and desired-agent provenance conflicts without overwriting', () => {
  const fixture = createFixture();
  try {
    const catalog = getCapabilityCatalog();
    const plan = {
      projectId: fixture.project.id,
      projectRevision: 4,
      catalogVersion: catalog.catalogVersion,
      planDigest: 'plan-digest',
      roles: [{ roleKey: 'reviewer', displayName: 'Reviewer', roles: ['worker'], requiredCapabilities: ['review'], responsibilities: [], decision: 'create', reasonCode: 'capability_gap' }],
    };
    fixture.hub.setProjectTeamPlan(fixture.project.id, plan);
    const coordinator = createTeamProvisioningHub({ hub: fixture.hub, agentStore: fixture.agentStore, operationStore: fixture.operations, catalog });
    fixture.project.projectRevision = 5;
    const stale = coordinator.reconcile({ projectId: fixture.project.id, planDigest: plan.planDigest, expectedProjectRevision: 4, clientRequestKey: 'stale', requestSource: 'user' });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, 'stale_plan');
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('returns the latest durable team operation for a project', () => {
  const fixture = createFixture();
  try {
    const first = fixture.operations.createOrReuse({
      projectId: fixture.project.id,
      planDigest: 'plan-1',
      expectedProjectRevision: 4,
      clientRequestKey: 'request-1',
      provisioningIntents: [],
      reusedAgentIds: [],
    });
    const second = fixture.operations.createOrReuse({
      projectId: fixture.project.id,
      planDigest: 'plan-2',
      expectedProjectRevision: 4,
      clientRequestKey: 'request-2',
      provisioningIntents: [],
      reusedAgentIds: [],
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(fixture.operations.findLatestByProject(fixture.project.id).id, second.operation.id);
    assert.equal(fixture.operations.findLatestByProject('missing'), null);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
console.log(`team-reconcile: ${passed}/${tests.length} passed`);

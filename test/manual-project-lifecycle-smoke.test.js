import assert from 'node:assert/strict';
import {
  buildProjectPayload,
  isDeliveredWithExpectedArtifacts,
  parseArgs,
  shouldApprove,
  summarizeDetail,
} from '../scripts/manual-project-lifecycle-smoke.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('manual smoke requires explicit yes by default', () => {
  const args = parseArgs([]);
  assert.equal(args.yes, false);
  assert.equal(args.apiUrl, 'http://127.0.0.1:4400');
});

test('project payload uses default seed agent selection', () => {
  const payload = buildProjectPayload({
    name: 'Smoke',
    goal: 'Goal',
    poAgent: 'xiaok-po',
    members: ['xiaok-po', 'xiaok-worker'],
  });

  assert.equal(payload.poAgent, 'xiaok-po');
  assert.deepEqual(payload.members, ['xiaok-worker']);
  assert.deepEqual(payload.agentSelection, {
    poAgent: { agentId: 'xiaok-po', source: 'default_seed' },
    members: [{ agentId: 'xiaok-worker', source: 'default_seed' }],
  });
});

test('delivery validation requires delivered project and html artifact by default', () => {
  assert.equal(isDeliveredWithExpectedArtifacts(
    { project: { status: 'active' } },
    { ok: true, manifest: { artifacts: [{ filename: 'report.html' }] } },
  ), false);

  assert.equal(isDeliveredWithExpectedArtifacts(
    { project: { status: 'delivered' } },
    { ok: true, manifest: { artifacts: [{ filename: 'report.md', type: 'markdown' }] } },
  ), false);

  assert.equal(isDeliveredWithExpectedArtifacts(
    { project: { status: 'delivered' } },
    { ok: true, manifest: { artifacts: [{ filename: 'report.html', type: 'html' }] } },
  ), true);
});

test('detail summary is compact and stable', () => {
  const summary = summarizeDetail({
    project: { status: 'active' },
    plan: { version: 1 },
    tasks: [
      { status: 'done' },
      { status: 'pending' },
      { status: 'pending' },
    ],
    projectIntervention: { primaryAction: { strategy: 'notify_po_review' } },
  });

  assert.deepEqual(summary, {
    project: 'active',
    plan: true,
    tasks: { done: 1, pending: 2 },
    intervention: 'notify_po_review',
  });
});

test('manual smoke approves both created and planning projects once a plan exists', () => {
  assert.equal(shouldApprove({ project: { status: 'created' }, plan: { version: 1 } }), true);
  assert.equal(shouldApprove({ project: { status: 'planning' }, plan: { version: 1 } }), true);
  assert.equal(shouldApprove({ project: { status: 'active' }, plan: { version: 1 } }), false);
  assert.equal(shouldApprove({ project: { status: 'planning' }, plan: null }), false);
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
  console.log(`\n${passed}/${tests.length} manual smoke script tests passed`);
}

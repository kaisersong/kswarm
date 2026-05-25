import assert from 'node:assert/strict';
import { applyBrokerPresenceToAgentProfiles } from '../src/core/broker-presence.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('desktop runtime agent missing from broker presence is marked offline for routing', () => {
  const [agent] = applyBrokerPresenceToAgentProfiles([
    {
      id: 'xiaok-worker',
      status: 'idle',
      runtimeSource: 'desktop-agent-runtime',
      runtimeHealth: {
        state: 'healthy',
        outputCapabilities: ['markdown', 'report_html'],
        taskCapabilities: ['analysis'],
      },
    },
  ], new Set());

  assert.equal(agent.status, 'offline');
  assert.equal(agent.brokerOnline, false);
  assert.equal(agent.runtimeHealth.state, 'offline');
});

test('desktop runtime agent present on broker is refreshed as healthy', () => {
  const [agent] = applyBrokerPresenceToAgentProfiles([
    {
      id: 'xiaok-worker',
      status: 'offline',
      runtimeSource: 'desktop-agent-runtime',
      capabilities: ['analysis'],
      outputCapabilities: ['markdown', 'report_html'],
      runtimeHealth: {
        state: 'offline',
        outputCapabilities: [],
        taskCapabilities: [],
      },
    },
  ], new Set(['xiaok-worker']));

  assert.equal(agent.status, 'idle');
  assert.equal(agent.brokerOnline, true);
  assert.equal(agent.runtimeHealth.state, 'healthy');
  assert.deepEqual(agent.runtimeHealth.taskCapabilities, ['analysis']);
  assert.deepEqual(agent.runtimeHealth.outputCapabilities, ['markdown', 'report_html']);
});

test('non-desktop agents keep their stored status when broker presence is absent', () => {
  const [agent] = applyBrokerPresenceToAgentProfiles([
    {
      id: 'cli-qoder',
      status: 'idle',
      runtimeSource: 'cli',
      runtimeHealth: { state: 'healthy' },
    },
  ], new Set());

  assert.equal(agent.status, 'idle');
  assert.equal(agent.runtimeHealth.state, 'healthy');
  assert.equal(agent.brokerOnline, false);
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
  console.log(`\n${passed}/${tests.length} broker presence tests passed`);
}

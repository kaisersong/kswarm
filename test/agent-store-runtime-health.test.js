/**
 * KSwarm — agent store runtime health tests
 *
 * Run: node test/agent-store-runtime-health.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function importFreshAgentStore(home) {
  process.env.HOME = home;
  const url = pathToFileURL(join(process.cwd(), 'src/core/agent-store.js'));
  url.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test('agent store initializes and persists runtime health defaults', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kswarm-agent-store-'));
  try {
    const { createAgentStore } = await importFreshAgentStore(home);
    const store = createAgentStore();
    const created = store.create({
      id: 'cli-md',
      name: 'CLI Markdown',
      runtimeType: 'claude',
      runtimePath: '/bin/echo',
      capabilities: ['analysis'],
    });

    assert.equal(created.ok, true);
    const agent = store.get('cli-md');
    assert.equal(agent.runtimeHealth.state, 'unknown');
    assert.deepEqual(agent.runtimeHealth.outputCapabilities, ['markdown']);
    assert.deepEqual(agent.runtimeHealth.taskCapabilities, ['analysis']);

    const health = {
      ...agent.runtimeHealth,
      state: 'limited',
      lastProbeOk: true,
      lastProbeAt: 1779050000000,
    };
    const updated = store.updateRuntimeHealth('cli-md', health);
    assert.equal(updated.ok, true);
    assert.equal(store.get('cli-md').runtimeHealth.state, 'limited');

    const persisted = JSON.parse(readFileSync(join(home, '.kswarm', 'agents.json'), 'utf-8'));
    assert.equal(persisted.find(a => a.id === 'cli-md').runtimeHealth.state, 'limited');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy agents loaded without runtimeHealth receive defaults on read', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kswarm-agent-store-'));
  try {
    const storeDir = join(home, '.kswarm');
    const agentsFile = join(storeDir, 'agents.json');
    await import('node:fs').then(fs => fs.mkdirSync(storeDir, { recursive: true }));
    await import('node:fs').then(fs => fs.writeFileSync(agentsFile, JSON.stringify([
      { id: 'legacy', name: 'Legacy', runtimeType: 'qoder', capabilities: ['planning'], roles: ['worker'] },
    ], null, 2)));

    const { createAgentStore } = await importFreshAgentStore(home);
    const store = createAgentStore();
    const agent = store.get('legacy');

    assert.equal(agent.runtimeHealth.state, 'unknown');
    assert.deepEqual(agent.runtimeHealth.outputCapabilities, ['markdown']);
    assert.deepEqual(agent.runtimeHealth.taskCapabilities, ['planning']);
    assert.equal(existsSync(agentsFile), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
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
if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} agent store runtime health tests passed`);
}

/**
 * KSwarm — default seed agent contract tests
 *
 * Run: node test/agent-store-seed-contract.test.js
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

test('empty store seeds dedicated desktop xiaok PO and worker without CLI runtime paths', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kswarm-agent-seeds-'));
  try {
    const { createAgentStore } = await importFreshAgentStore(home);
    const store = createAgentStore();
    const agents = store.list();
    const ids = agents.map(agent => agent.id).sort();

    assert.deepEqual(ids, ['xiaok-po', 'xiaok-worker']);
    assert.equal(agents.some(agent => agent.id === 'xiaok'), false);

    const po = store.get('xiaok-po');
    const worker = store.get('xiaok-worker');

    assert.equal(po.runtimeType, 'xiaok');
    assert.equal(po.runtimeSource, 'desktop-agent-runtime');
    assert.equal(po.runtimePath ?? null, null);
    assert.deepEqual(po.roles, ['project_owner']);
    assert.equal(po.provider ?? null, null);
    assert.equal(po.apiKey ?? null, null);
    assert.equal(po.model ?? null, null);
    assert.equal(po.baseUrl ?? null, null);
    assert.equal(worker.runtimeType, 'xiaok');
    assert.equal(worker.runtimeSource, 'desktop-agent-runtime');
    assert.equal(worker.runtimePath ?? null, null);
    assert.deepEqual(worker.roles, ['worker']);
    assert.equal(worker.provider ?? null, null);
    assert.equal(worker.apiKey ?? null, null);
    assert.equal(worker.model ?? null, null);
    assert.equal(worker.baseUrl ?? null, null);

    const persisted = JSON.parse(readFileSync(join(home, '.kswarm', 'agents.json'), 'utf-8'));
    assert.equal(persisted.some(agent => agent.id === 'xiaok'), false);
    assert.equal(persisted.find(agent => agent.id === 'xiaok-po').runtimePath ?? null, null);
    assert.equal(persisted.find(agent => agent.id === 'xiaok-worker').runtimePath ?? null, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('desktop xiaok seed agents do not inherit environment LLM provider config', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kswarm-agent-seeds-'));
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousOpenAiModel = process.env.OPENAI_MODEL;
  process.env.OPENAI_API_KEY = 'sk-env-openai';
  process.env.OPENAI_MODEL = 'gpt-env';
  try {
    const { createAgentStore } = await importFreshAgentStore(home);
    const store = createAgentStore();

    for (const id of ['xiaok-po', 'xiaok-worker']) {
      const agent = store.get(id);
      assert.equal(agent.runtimeSource, 'desktop-agent-runtime');
      assert.equal(agent.provider ?? null, null);
      assert.equal(agent.apiKey ?? null, null);
      assert.equal(agent.model ?? null, null);
      assert.equal(agent.baseUrl ?? null, null);
    }
  } finally {
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousOpenAiModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousOpenAiModel;
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy desktop xiaok seed provider secrets are scrubbed on load', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kswarm-agent-seeds-'));
  try {
    const storeDir = join(home, '.kswarm');
    const agentsFile = join(storeDir, 'agents.json');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(agentsFile, JSON.stringify([
      {
        id: 'xiaok-po',
        name: 'PO-Agent',
        runtimeType: 'xiaok',
        runtimePath: '/usr/local/bin/xiaok',
        provider: 'anthropic',
        apiKey: 'sk-old',
        model: 'claude-old',
        baseUrl: 'https://api.example.test',
        roles: ['project_owner'],
      },
      {
        id: 'third-party-openai',
        name: 'Explicit OpenAI Worker',
        runtimeType: 'custom',
        provider: 'openai',
        apiKey: 'sk-third-party',
        model: 'gpt-third-party',
        roles: ['worker'],
      },
    ], null, 2));

    const { createAgentStore } = await importFreshAgentStore(home);
    const store = createAgentStore();

    const po = store.get('xiaok-po');
    assert.equal(po.runtimeSource, 'desktop-agent-runtime');
    assert.equal(po.runtimePath ?? null, null);
    assert.equal(po.provider ?? null, null);
    assert.equal(po.apiKey ?? null, null);
    assert.equal(po.model ?? null, null);
    assert.equal(po.baseUrl ?? null, null);

    const explicit = store.get('third-party-openai');
    assert.equal(explicit.provider, 'openai');
    assert.equal(explicit.apiKey, 'sk-third-party');
    assert.equal(explicit.model, 'gpt-third-party');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('desktop xiaok seed agents expose broad task capabilities and report html output', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kswarm-agent-seeds-'));
  try {
    const { createAgentStore } = await importFreshAgentStore(home);
    const store = createAgentStore();

    for (const id of ['xiaok-po', 'xiaok-worker']) {
      const agent = store.get(id);
      const taskCapabilities = new Set(agent.runtimeHealth.taskCapabilities);
      const outputCapabilities = new Set(agent.runtimeHealth.outputCapabilities);

      for (const capability of [
        'research',
        'analysis',
        'source_research',
        'web_research',
        'report_generation',
        'presentation_generation',
        'slide_generation',
        'documentation',
        'review',
      ]) {
        assert.equal(taskCapabilities.has(capability), true, `${id} missing ${capability}`);
      }

      assert.equal(outputCapabilities.has('markdown'), true);
      assert.equal(outputCapabilities.has('html'), true);
      assert.equal(outputCapabilities.has('report_html'), true);
      assert.equal(outputCapabilities.has('slide_html'), false);
      assert.equal(outputCapabilities.has('pptx'), false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy desktop xiaok seed agents are upgraded to broad task capabilities', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kswarm-agent-seeds-'));
  try {
    const storeDir = join(home, '.kswarm');
    const agentsFile = join(storeDir, 'agents.json');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(agentsFile, JSON.stringify([
      {
        id: 'xiaok-po',
        name: 'PO-Agent',
        runtimeType: 'xiaok',
        roles: ['project_owner'],
        capabilities: ['planning'],
        runtimeHealth: { state: 'unknown', taskCapabilities: ['planning'], outputCapabilities: ['markdown'] },
      },
      {
        id: 'xiaok-worker',
        name: 'Worker-Agent',
        runtimeType: 'xiaok',
        roles: ['worker'],
        capabilities: ['coding', 'testing', 'design', 'planning'],
        runtimeHealth: { state: 'unknown', taskCapabilities: ['coding', 'testing', 'design', 'planning'], outputCapabilities: ['markdown'] },
      },
    ], null, 2));

    const { createAgentStore } = await importFreshAgentStore(home);
    const store = createAgentStore();

    for (const id of ['xiaok-po', 'xiaok-worker']) {
      const agent = store.get(id);
      assert.equal(agent.runtimeHealth.taskCapabilities.includes('source_research'), true, `${id} not upgraded`);
      assert.equal(agent.runtimeHealth.taskCapabilities.includes('web_research'), true, `${id} not upgraded`);
      assert.equal(agent.runtimeHealth.outputCapabilities.includes('report_html'), true, `${id} not upgraded with report html output`);
      assert.equal(agent.runtimeHealth.outputCapabilities.includes('slide_html'), false, `${id} should not claim slide output`);
      assert.equal(agent.runtimeHealth.outputCapabilities.includes('pptx'), false, `${id} should not claim pptx output`);
    }

    const persisted = JSON.parse(readFileSync(agentsFile, 'utf-8'));
    assert.equal(persisted.find(agent => agent.id === 'xiaok-po').runtimeHealth.taskCapabilities.includes('source_research'), true);
    assert.equal(persisted.find(agent => agent.id === 'xiaok-worker').runtimeHealth.taskCapabilities.includes('web_research'), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy xiaok runtime aliases are upgraded to broad task capabilities', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kswarm-agent-seeds-'));
  try {
    const storeDir = join(home, '.kswarm');
    const agentsFile = join(storeDir, 'agents.json');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(agentsFile, JSON.stringify([
      {
        id: 'cli-xiaok',
        name: 'xiaok',
        runtimeType: 'xiaok',
        runtimePath: '/usr/local/bin/xiaok',
        roles: ['project_owner', 'worker'],
        capabilities: ['coding', 'testing', 'design', 'planning'],
        runtimeHealth: {
          state: 'healthy',
          taskCapabilities: ['coding', 'testing', 'design', 'planning'],
          outputCapabilities: ['markdown', 'html', 'report_html'],
        },
      },
    ], null, 2));

    const { createAgentStore } = await importFreshAgentStore(home);
    const store = createAgentStore();
    const agent = store.get('cli-xiaok');

    assert.equal(agent.runtimePath, '/usr/local/bin/xiaok');
    assert.equal(agent.runtimeHealth.taskCapabilities.includes('source_research'), true);
    assert.equal(agent.runtimeHealth.taskCapabilities.includes('presentation_generation'), true);
    assert.equal(agent.runtimeHealth.outputCapabilities.includes('report_html'), true);
    assert.equal(agent.runtimeHealth.outputCapabilities.includes('slide_html'), false);
    assert.equal(agent.runtimeHealth.outputCapabilities.includes('pptx'), false);
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
  console.log(`\n${passed}/${tests.length} agent store seed contract tests passed`);
}

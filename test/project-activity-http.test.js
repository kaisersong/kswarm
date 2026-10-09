import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createHub } from '../src/core/hub.js';

test('real activity HTTP requires the host credential and replays only committed source state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kswarm-activity-http-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const dataDir = { backend: 'sqlite', filePath: join(root, 'state.sqlite'), legacyJsonPath: join(root, 'state.json') };
  const hub = createHub({ silent: true, dataDir });
  hub.createProject({ id: 'fixture', name: 'Fixture', goal: 'Read-only test', poAgent: 'po', members: [], autoAssignPo: false });
  const expected = hub.getProjectActivity('fixture'); hub.closePersistence();
  const child = spawn(process.execPath, ['src/server/index.js'], { cwd: process.cwd(),
    env: { ...process.env, HOME: root, USERPROFILE: root, KSWARM_DATA_ROOT: root, KSWARM_PORT: String(port), BROKER_URL: 'http://127.0.0.1:1', KSWARM_DESKTOP_MUTATION_TOKEN: 'fixture-credential' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* startup */ }
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('isolated server startup failed');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const health = await (await fetch(`${base}/health`)).json();
    assert.deepEqual(health.workflowCapabilities, {
      schemaVersion: 'kswarm_workflow_patterns_v1', compiledContract: false, patternPublicView: false,
    });
    assert.ok(health.features.includes('dynamic_workflows'));
    assert.equal((await fetch(`${base}/projects/fixture/activity`)).status, 401);
    const headers = { 'x-kswarm-mutation-token': 'fixture-credential' };
    assert.equal((await fetch(`${base}/projects/fixture/activity-identity`)).status, 401);
    const identityResponse = await fetch(`${base}/projects/fixture/activity-identity`, { headers });
    assert.equal(identityResponse.status, 200);
    assert.deepEqual(Object.keys(await identityResponse.json()).sort(), ['ok','projectId','roomId','sourceDataEpoch']);
    const response = await fetch(`${base}/projects/fixture/activity`, { headers });
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.sourceDataEpoch, expected.sourceDataEpoch);
    assert.deepEqual(page.events, expected.events);
    assert.equal((await fetch(`${base}/projects/fixture/activity?limit=999`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/projects/no-such-project/activity`, { headers })).status, 404);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}, { timeout: 15000 });

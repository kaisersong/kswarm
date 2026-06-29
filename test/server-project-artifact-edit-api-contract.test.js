/**
 * KSwarm project artifact edit API contract.
 *
 * Runs a real server on a temporary port and HOME so artifact writes do not
 * touch the user's local ~/.kswarm state.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

let total = 0;
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  total++;
  if (cond) {
    passed++;
    console.log(`    ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`    ✗ FAIL: ${msg}`);
  }
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 1500)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

async function putJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

console.log('\n╔═══════════════════════════════════════════════════╗');
console.log('║   KSwarm — Project Artifact Edit API Contract     ║');
console.log('╚═══════════════════════════════════════════════════╝');

const tempHome = mkdtempSync(join(tmpdir(), 'kswarm-artifact-edit-'));
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['src/server/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    HOME: tempHome,
    KSWARM_PORT: String(port),
    BROKER_URL: 'http://127.0.0.1:9',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
child.stdout.on('data', chunk => logs.push(String(chunk)));
child.stderr.on('data', chunk => logs.push(String(chunk)));

try {
  await waitForServer(baseUrl, child);

  const projectId = 'proj-artifact-edit-api';
  const upload = await postJson(baseUrl, '/artifacts', {
    projectId,
    filename: 'task-report.html',
    content: '<!doctype html><html><body><h1>Old title</h1></body></html>',
  });
  assert(upload.res.status === 201, `project artifact upload returns 201 (got ${upload.res.status})`);
  assert(upload.data?.ok === true, 'project artifact upload returns ok');

  const update = await putJson(baseUrl, `/projects/${projectId}/artifacts/task-report.html`, {
    content: '<!doctype html><html><body><h1>New title</h1></body></html>',
  });
  assert(update.res.status === 200, `project artifact PUT returns 200 (got ${update.res.status})`);
  assert(update.data?.ok === true, 'project artifact PUT returns ok');

  const readBack = await fetch(`${baseUrl}/projects/${projectId}/artifacts/task-report.html`);
  const text = await readBack.text();
  assert(readBack.status === 200, `project artifact GET returns 200 (got ${readBack.status})`);
  assert(text.includes('<h1>New title</h1>'), 'project artifact GET returns updated content');

  const missingContent = await putJson(baseUrl, `/projects/${projectId}/artifacts/task-report.html`, {});
  assert(missingContent.res.status === 400, `project artifact PUT rejects missing content (got ${missingContent.res.status})`);
  assert(missingContent.data?.error === 'content_required', 'project artifact PUT reports content_required');
} catch (err) {
  failed++;
  failures.push(err.message || String(err));
  console.error(err);
  console.error(logs.join('').slice(-4000));
} finally {
  await stopServer(child);
  rmSync(tempHome, { recursive: true, force: true });
}

console.log(`\n  Result: ${passed}/${total} assertions passed`);
if (failed > 0) {
  console.error(`  ${failed} failure(s):`);
  for (const failure of failures) console.error(`   - ${failure}`);
  process.exit(1);
}

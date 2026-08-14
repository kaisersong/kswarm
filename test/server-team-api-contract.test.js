import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamApiContract, redactAgentForTransport } from '../src/core/persistence-hub.js';

const contract = createTeamApiContract();
assert.equal(contract.allowProxy({ method: 'POST', path: '/projects/p1/team/plan', responseKind: 'json' }), true);
assert.equal(contract.allowProxy({ method: 'POST', path: '/agents', responseKind: 'json' }), false);
assert.equal(contract.allowProxy({ method: 'GET', path: '/agents/abc/', responseKind: 'text' }), false);
assert.equal(contract.allowProxy({ method: 'GET', path: '/agents/%2fsecret', responseKind: 'json' }), false);

const redacted = redactAgentForTransport({ id: 'agent-1', apiKey: 'secret', baseUrl: 'https://secret.example', customEnv: { TOKEN: 'secret' }, runtimePath: '/secret/path', execution: { credential: 'secret' } });
assert.equal('apiKey' in redacted, false);
assert.equal('baseUrl' in redacted, false);
assert.equal('customEnv' in redacted, false);
assert.equal('runtimePath' in redacted, false);
assert.equal('execution' in redacted, false);

async function freePort() {
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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited: ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function request(baseUrl, path, method, body, token = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-kswarm-mutation-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => null) };
}

const home = mkdtempSync(join(tmpdir(), 'kswarm-team-api-'));
const port = await freePort();
const token = 'test-desktop-mutation-token';
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['src/server/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, HOME: home, KSWARM_PORT: String(port), BROKER_URL: 'http://127.0.0.1:9', KSWARM_DESKTOP_MUTATION_TOKEN: token },
  stdio: 'ignore',
});

try {
  await waitForServer(baseUrl, child);
  const directMutation = await request(baseUrl, '/agents', 'POST', { name: 'blocked' });
  assert.equal(directMutation.response.status, 401);

  const created = await request(baseUrl, '/projects', 'POST', {
    name: 'Team API project', goal: 'Review a document', poAgent: 'xiaok-po', members: ['xiaok-worker'], autoStartPlanning: false,
  }, token);
  assert.equal(created.response.status, 201);
  const projectId = created.body.project.id;
  const unauthorizedDelete = await request(baseUrl, `/projects/${projectId}`, 'DELETE');
  assert.equal(unauthorizedDelete.response.status, 401);

  const archived = await request(baseUrl, '/agents/xiaok-worker/archive', 'POST', {}, token);
  assert.equal(archived.response.status, 200);
  const project = await (await fetch(`${baseUrl}/projects/${projectId}`)).json();
  const revision = project.project.projectRevision;
  const catalog = await (await fetch(`${baseUrl}/agents/capability-catalog`)).json();
  const proposal = await request(baseUrl, `/projects/${projectId}/team/plan`, 'POST', {
    requestSource: 'user', expectedProjectRevision: revision, catalogVersion: catalog.catalogVersion,
    needs: [{ needKey: 'reviewer', requiredCapabilities: ['review'], responsibilities: ['review'], requiresIndependentReviewer: false }],
  }, token);
  assert.equal(proposal.response.status, 200);
  assert.equal(proposal.body.plan.roles[0].decision, 'create');

  const applied = await request(baseUrl, `/projects/${projectId}/team/reconcile`, 'POST', {
    requestSource: 'user', expectedProjectRevision: revision, planDigest: proposal.body.plan.planDigest, clientRequestKey: 'team-apply-1',
  }, token);
  assert.equal(applied.response.status, 200);
  assert.equal(applied.body.operation.status, 'applied');
  const operationSnapshot = await request(
    baseUrl,
    `/projects/${projectId}/team/operations/${applied.body.operation.id}`,
    'GET',
  );
  assert.equal(operationSnapshot.response.status, 200);
  assert.equal(operationSnapshot.body.operation.id, applied.body.operation.id);
  assert.equal(operationSnapshot.body.operation.projectId, projectId);
  const latestOperationSnapshot = await request(
    baseUrl,
    `/projects/${projectId}/team/operations/latest`,
    'GET',
  );
  assert.equal(latestOperationSnapshot.response.status, 200);
  assert.equal(latestOperationSnapshot.body.operation.id, applied.body.operation.id);
  const agentId = applied.body.operation.createdAgentIds[0];
  const agent = await (await fetch(`${baseUrl}/agents/${agentId}`)).json();
  assert.equal('apiKey' in agent.agent, false);
  assert.equal('baseUrl' in agent.agent, false);
  assert.equal('runtimePath' in agent.agent, false);
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  rmSync(home, { recursive: true, force: true });
}

console.log('server-team-api-contract: 1/1 passed');

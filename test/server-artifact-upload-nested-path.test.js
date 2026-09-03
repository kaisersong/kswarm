import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const home = mkdtempSync(join(tmpdir(), 'kswarm-artifact-upload-'));
const port = await freePort();
const token = 'test-desktop-mutation-token';
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['src/server/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    HOME: home,
    KSWARM_PORT: String(port),
    BROKER_URL: 'http://127.0.0.1:9',
    KSWARM_DESKTOP_MUTATION_TOKEN: token,
  },
  stdio: 'ignore',
});

let passed = 0;
const total = 9;

async function upload(payload, mutationToken = token) {
  const headers = { 'content-type': 'application/json' };
  if (mutationToken !== null) headers['x-kswarm-mutation-token'] = mutationToken;
  const response = await fetch(`${baseUrl}/artifacts`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

try {
  await waitForServer(baseUrl, child);

  const created = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kswarm-mutation-token': token },
    body: JSON.stringify({
      name: 'Artifact Upload Project',
      goal: 'test',
      poAgent: 'xiaok-po',
      members: ['xiaok-worker'],
      autoStartPlanning: false,
    }),
  });
  assert.equal(created.status, 201);
  const project = (await created.json()).project;
  const artifactsDir = join(home, '.kswarm', 'projects', project.id, 'artifacts');

  {
    const payload = { filename: 'unauthorized.txt', content: 'forbidden', projectId: project.id };
    const missing = await upload(payload, null);
    const wrong = await upload(payload, 'wrong-token');
    assert.equal(missing.response.status, 401);
    assert.equal(wrong.response.status, 401);
    assert.equal(existsSync(join(artifactsDir, 'unauthorized.txt')), false);
    passed++;
    console.log('✓ missing and invalid mutation credentials are rejected before writing');
  }

  {
    const result = await upload({ filename: 'global.txt', content: 'forbidden' });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, 'project_id_required');
    assert.equal(existsSync(join(home, '.kswarm', 'artifacts')), false);
    passed++;
    console.log('✓ projectId is required and global mutation is disabled');
  }

  {
    const missingProjectId = 'missing-project';
    const result = await upload({ filename: 'ghost.txt', content: 'forbidden', projectId: missingProjectId });
    assert.equal(result.response.status, 404);
    assert.equal(result.body.error, 'project_not_found');
    assert.equal(existsSync(join(home, '.kswarm', 'projects', missingProjectId)), false);
    passed++;
    console.log('✓ unknown projects are rejected without creating a workspace');
  }

  {
    const invalidPaths = [
      '../escape.txt',
      '%2e%2e/encoded-escape.txt',
      '/absolute.txt',
      '..\\backslash-escape.txt',
    ];
    for (const filename of invalidPaths) {
      const result = await upload({ filename, content: 'forbidden', projectId: project.id });
      assert.equal(result.response.status, 400, `${filename}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.error, 'invalid_artifact_path');
    }
    assert.equal(existsSync(join(artifactsDir, 'escape.txt')), false);
    assert.equal(existsSync(join(artifactsDir, '%2e%2e_encoded-escape.txt')), false);
    assert.equal(existsSync(join(artifactsDir, '.._backslash-escape.txt')), false);
    passed++;
    console.log('✓ traversal, encoded traversal, absolute, and backslash escapes are rejected');
  }

  const nestedPath = 'artifacts/tasks/task-1/run-1/review-evidence.json';
  const initialText = JSON.stringify({ verdict: 'passed', note: '你好' });
  const initialBytes = Buffer.from(initialText, 'utf8');
  let initialHash;

  {
    const result = await upload({ filename: nestedPath, content: initialText, projectId: project.id });
    initialHash = sha256(initialBytes);
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.artifact.filename, 'review-evidence.json');
    assert.equal(result.body.artifact.sha256, initialHash);
    assert.deepEqual(readFileSync(join(artifactsDir, nestedPath)), initialBytes);

    const readBack = await fetch(`${baseUrl}${result.body.artifact.url}`);
    assert.equal(readBack.status, 200);
    assert.deepEqual(Buffer.from(await readBack.arrayBuffer()), initialBytes);
    passed++;
    console.log('✓ nested UTF-8 artifact creation returns a service-owned byte hash');
  }

  {
    const result = await upload({ filename: nestedPath, content: 'overwrite', projectId: project.id });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error, 'artifact_already_exists');
    assert.deepEqual(readFileSync(join(artifactsDir, nestedPath)), initialBytes);
    passed++;
    console.log('✓ existing artifacts are create-only without a CAS precondition');
  }

  {
    const result = await upload({
      filename: nestedPath,
      content: 'wrong CAS overwrite',
      projectId: project.id,
      expectedSha256: '0'.repeat(64),
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error, 'artifact_sha256_mismatch');
    assert.equal(result.body.actualSha256, initialHash);
    assert.deepEqual(readFileSync(join(artifactsDir, nestedPath)), initialBytes);
    passed++;
    console.log('✓ a stale CAS hash is rejected without changing existing bytes');
  }

  {
    const updatedText = JSON.stringify({ verdict: 'failed', note: '已更新' });
    const updatedBytes = Buffer.from(updatedText, 'utf8');
    const result = await upload({
      filename: nestedPath,
      content: updatedText,
      projectId: project.id,
      expectedSha256: initialHash,
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.artifact.sha256, sha256(updatedBytes));
    assert.deepEqual(readFileSync(join(artifactsDir, nestedPath)), updatedBytes);
    passed++;
    console.log('✓ a matching CAS hash atomically updates the artifact');
  }

  {
    const binaryBytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    const result = await upload({
      filename: 'artifacts/tasks/task-1/run-1/binary.bin',
      content: binaryBytes.toString('base64'),
      encoding: 'base64',
      projectId: project.id,
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.artifact.sha256, sha256(binaryBytes));
    assert.deepEqual(readFileSync(join(artifactsDir, 'artifacts/tasks/task-1/run-1/binary.bin')), binaryBytes);
    passed++;
    console.log('✓ base64 artifacts are hashed from decoded bytes');
  }
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed}/${total} server artifact upload security tests passed`);
if (passed !== total) process.exitCode = 1;

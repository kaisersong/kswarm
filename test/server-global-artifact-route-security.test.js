/**
 * KSwarm — legacy global GET /artifacts/(.+) route security contract
 *
 * 设计依据：design §3.5；评审记录第七轮
 *   （legacy global GET artifact 是未消毒 traversal/read 旁路）
 *
 * 验证真实 HTTP server 上这条路由：
 *   1. 无 mutation token 时拒绝（401），不再匿名可读；
 *   2. 有效 token + 合法顶层文件名时可读；
 *   3. traversal payload 被拒绝，不能读到 root 之外的文件；
 *   4. 响应不再带 Access-Control-Allow-Origin: *。
 *
 * Run: node test/server-global-artifact-route-security.test.js
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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

const home = mkdtempSync(join(tmpdir(), 'kswarm-global-artifact-'));
const port = await freePort();
const token = 'test-desktop-mutation-token';
const baseUrl = `http://127.0.0.1:${port}`;

// 在真实的全局 artifacts 目录（KSWARM_HOME/artifacts）里预先放一个已知文件，
// 供合法读取和 traversal 尝试共同参照。KSWARM_HOME 由 HOME 派生（.kswarm）。
const kswarmHome = join(home, '.kswarm');
const globalArtifactsDir = join(kswarmHome, 'artifacts');
mkdirSync(globalArtifactsDir, { recursive: true });
writeFileSync(join(globalArtifactsDir, 'known.txt'), 'known content');

// 在 HOME 之外放一个 secret 文件，作为 traversal 的攻击目标。
const secretDir = mkdtempSync(join(tmpdir(), 'kswarm-secret-'));
writeFileSync(join(secretDir, 'secret.txt'), 'top secret content');

const child = spawn(process.execPath, ['src/server/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, HOME: home, KSWARM_PORT: String(port), BROKER_URL: 'http://127.0.0.1:9', KSWARM_DESKTOP_MUTATION_TOKEN: token },
  stdio: 'ignore',
});

let passed = 0;
const total = 5;

try {
  await waitForServer(baseUrl, child);

  // Test 1: 无 token 时拒绝
  {
    const response = await fetch(`${baseUrl}/artifacts/known.txt`);
    assert.equal(response.status, 401, 'anonymous request must be rejected');
    passed++;
    console.log('✓ anonymous GET /artifacts/known.txt is rejected (401)');
  }

  // Test 2: 有效 token + 合法顶层文件名时可读，且无通配 CORS 头
  {
    const response = await fetch(`${baseUrl}/artifacts/known.txt`, {
      headers: { 'x-kswarm-mutation-token': token },
    });
    assert.equal(response.status, 200, 'authorized top-level file read must succeed');
    const text = await response.text();
    assert.equal(text, 'known content');
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      null,
      'the wildcard CORS header must be removed (design §3.5)',
    );
    passed++;
    console.log('✓ authorized GET /artifacts/known.txt succeeds without a wildcard CORS header');
  }

  // Test 3: raw traversal 被拒绝
  {
    const response = await fetch(`${baseUrl}/artifacts/..%2F..%2F..%2Ftmp%2Fescape.txt`, {
      headers: { 'x-kswarm-mutation-token': token },
    });
    assert.notEqual(response.status, 200, 'traversal payload must not succeed');
    passed++;
    console.log('✓ URL-encoded traversal payload is rejected');
  }

  // Test 4: nested path 被拒绝（allowNested=false，legacy global root 只能读顶层文件）
  {
    mkdirSync(join(globalArtifactsDir, 'sub'), { recursive: true });
    writeFileSync(join(globalArtifactsDir, 'sub', 'nested.txt'), 'nested content');
    const response = await fetch(`${baseUrl}/artifacts/sub%2Fnested.txt`, {
      headers: { 'x-kswarm-mutation-token': token },
    });
    assert.notEqual(response.status, 200, 'nested path must be rejected on the legacy global root');
    passed++;
    console.log('✓ nested path under the legacy global root is rejected (allowNested=false)');
  }

  // Test 5: 不存在的文件返回 404，而不是意外读到别的东西
  {
    const response = await fetch(`${baseUrl}/artifacts/does-not-exist.txt`, {
      headers: { 'x-kswarm-mutation-token': token },
    });
    assert.equal(response.status, 404);
    passed++;
    console.log('✓ a non-existent top-level artifact returns 404');
  }
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  rmSync(home, { recursive: true, force: true });
  rmSync(secretDir, { recursive: true, force: true });
}

console.log(`\n${passed}/${total} server global artifact route security tests passed`);
if (passed !== total) process.exitCode = 1;

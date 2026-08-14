#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..');
const brokerRoot = resolve(repoRoot, '..', 'intent-broker');
const tempRoot = mkdtempSync(join(tmpdir(), 'kswarm-full-e2e-'));
const homeDir = join(tempRoot, 'home');
const mutationToken = `e2e-${process.pid}-${Date.now()}`;
const runtimePath = join(testDir, 'fixtures', 'fake-xiaok-cli.mjs');
const children = new Set();

mkdirSync(homeDir, { recursive: true });

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

function startProcess(label, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.on('data', chunk => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${label}:stderr] ${chunk}`));
  child.once('exit', () => children.delete(child));
  return child;
}

async function waitFor(url, predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (response.ok && predicate(body)) return body;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    waitForExit(child),
    new Promise(resolveWait => setTimeout(resolveWait, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function main() {
  const [brokerPort, kswarmPort] = await Promise.all([reservePort(), reservePort()]);
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;
  const kswarmUrl = `http://127.0.0.1:${kswarmPort}`;
  const sharedEnv = {
    ...process.env,
    HOME: homeDir,
    BROKER_URL: brokerUrl,
    KSWARM_API: kswarmUrl,
    KSWARM_DESKTOP_MUTATION_TOKEN: mutationToken,
    KSWARM_E2E_RUNTIME_PATH: runtimePath,
    KSWARM_AGENT_RUNTIME_TYPE: 'xiaok',
    KSWARM_AGENT_RUNTIME_PATH: runtimePath,
    KSWARM_AGENT_RUNTIME_MODEL: 'e2e-fixture',
  };

  const broker = startProcess('broker', process.execPath, ['--experimental-sqlite', 'src/cli.js'], {
    cwd: brokerRoot,
    env: {
      ...sharedEnv,
      PORT: String(brokerPort),
      INTENT_BROKER_CONFIG: join(tempRoot, 'missing-config.json'),
      INTENT_BROKER_LOCAL_CONFIG: join(tempRoot, 'missing-local-config.json'),
      INTENT_BROKER_DB: join(tempRoot, 'intent-broker.db'),
      INTENT_BROKER_SOCKET_PATH: '',
      ENABLE_HUMAN_ESCALATION: '0',
    },
  });
  await waitFor(`${brokerUrl}/health`, body => body.ok === true, 'intent-broker');

  const kswarm = startProcess('kswarm', process.execPath, ['src/server/index.js'], {
    cwd: repoRoot,
    env: {
      ...sharedEnv,
      KSWARM_PORT: String(kswarmPort),
    },
  });
  await waitFor(
    `${kswarmUrl}/health`,
    body => body.ok === true && body.brokerConnected === true,
    'kswarm',
  );

  const testProcess = startProcess('e2e', process.execPath, ['test/e2e-full-flow.test.js'], {
    cwd: repoRoot,
    env: sharedEnv,
  });
  const result = await waitForExit(testProcess);
  if (result.code !== 0) {
    throw new Error(`E2E flow exited with code ${result.code ?? 'null'} signal ${result.signal ?? 'none'}`);
  }

  await stopChild(kswarm);
  await stopChild(broker);
}

try {
  await main();
} finally {
  await Promise.all([...children].map(stopChild));
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
}

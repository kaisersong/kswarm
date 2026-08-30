/**
 * Fake-executable integration for the Pi harness runner
 * (design §3 requirements, §7 test order step 2).
 *
 * A fake `pi` script captures argv/cwd/env, then exercises: success,
 * blank output, non-zero exit, secret-free env, timeout kill.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { runPiHarness, PI_OUTPUT_LIMIT_BYTES, PI_TIMEOUT_MS } from '../src/core/pi-cli-harness.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const fakeDir = mkdtempSync(join(tmpdir(), 'kswarm-pi-fake-'));
const workDir = mkdtempSync(join(tmpdir(), 'kswarm-pi-work-'));
mkdirSync(workDir, { recursive: true });

function writeFakePi(name, body) {
  const script = join(fakeDir, name);
  writeFileSync(script, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return script;
}

test('success: captures exact argv, cwd and returns trimmed stdout', async () => {
  const script = writeFakePi('ok.js', `
    const fs = require('node:fs');
    const [argv, cwd, envKeys] = process.argv.slice(2);
    fs.writeFileSync(process.env.PI_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), hasOpenAI: 'OPENAI_API_KEY' in process.env }));
    process.stdout.write('  task complete  \\n');
  `);
  const capture = join(fakeDir, 'capture.json');
  const result = await runPiHarness(script, 'Do the task', '', workDir, {
    parentEnv: { PATH: process.env.PATH, OPENAI_API_KEY: 'sk-leak' },
    extraEnv: { PI_CAPTURE: capture },
    timeoutMs: 15_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.text, 'task complete');

  const captured = JSON.parse(readFileSync(capture, 'utf8'));
  // prompt is the single trailing argv element; flags precede it
  assert.deepEqual(captured.argv.slice(0, 4), ['--print', '--mode', 'text', '--no-session']);
  assert.equal(captured.argv[captured.argv.length - 1], 'Do the task');
  assert.equal(captured.cwd, realpathSync(workDir));
  // injected secret must NOT reach the child env (allowlist drops it)
  assert.equal(captured.hasOpenAI, false);
});

test('model is forwarded as --model when provided', async () => {
  const capture = join(fakeDir, 'capture-model.json');
  const script = writeFakePi('model.js', `
    require('node:fs').writeFileSync(process.env.PI_CAPTURE, JSON.stringify(process.argv.slice(2)));
  `);
  await runPiHarness(script, 'task', 'grok-4.5', workDir, {
    extraEnv: { PI_CAPTURE: capture }, timeoutMs: 15_000,
  });
  const argv = JSON.parse(readFileSync(capture, 'utf8'));
  assert.deepEqual(argv.slice(4, 6), ['--model', 'grok-4.5']);
});

test('blank stdout is a failure even with exit code 0', async () => {
  const script = writeFakePi('blank.js', `process.exit(0);`);
  const result = await runPiHarness(script, 'task', '', workDir, { timeoutMs: 15_000 });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, 'empty_output');
});

test('non-zero exit with stderr is classified, not swallowed', async () => {
  const script = writeFakePi('authfail.js', `
    process.stderr.write('Error: invalid api key\\n');
    process.exit(1);
  `);
  const result = await runPiHarness(script, 'task', '', workDir, { timeoutMs: 15_000 });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, 'auth');
  assert.equal(result.retryable, false);
});

test('timeout kills the child and reports a retryable timeout', async () => {
  const script = writeFakePi('slow.js', `setInterval(() => {}, 1000);`);
  const startedAt = Date.now();
  const result = await runPiHarness(script, 'task', '', workDir, { timeoutMs: 700 });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, 'timeout');
  assert.equal(result.retryable, true);
  assert.ok(Date.now() - startedAt < 10_000, 'child must be killed, not awaited forever');
});

test('abort signal cancels the run as aborted, not model_failed', async () => {
  const script = writeFakePi('slow2.js', `setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  const promise = runPiHarness(script, 'task', '', workDir, { timeoutMs: 60_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, 'aborted');
  assert.equal(result.retryable, false);
});

test('oversized stdout is cut off with output_limit instead of OOM', async () => {
  const script = writeFakePi('flood.js', `
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 100; i++) process.stdout.write(chunk);
  `);
  const result = await runPiHarness(script, 'task', '', workDir, { timeoutMs: 30_000 });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, 'output_limit');
  assert.ok(result.text.length <= PI_OUTPUT_LIMIT_BYTES + 1024);
});

test('missing executable fails closed as spawn error', async () => {
  const result = await runPiHarness(join(fakeDir, 'does-not-exist.js'), 'task', '', workDir, { timeoutMs: 5_000 });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, 'spawn_failed');
});

test('runner defaults: timeout and output limit are finite and positive', () => {
  assert.ok(PI_TIMEOUT_MS > 0 && PI_TIMEOUT_MS <= 10 * 60_000);
  assert.ok(PI_OUTPUT_LIMIT_BYTES > 0 && PI_OUTPUT_LIMIT_BYTES <= 8 * 1024 * 1024);
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
  console.log(`\n${passed}/${tests.length} pi fake-executable integration tests passed`);
}

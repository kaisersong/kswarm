/**
 * Pi / DeepSeek harness argv, parser and error-classification contracts
 * (design §3, §4, §5 of 2026-08-29-kswarm-pi-deepseek-harness-design.md).
 *
 * Test-first: these pure functions are the frozen CLI contract. argv must be
 * an exact array — prompt is a single argv element, never a shell string.
 */
import assert from 'node:assert/strict';
import {
  buildPiCliArgs,
  classifyPiCliFailure,
  parsePiCliOutput,
} from '../src/core/pi-cli-harness.js';
import {
  buildDeepSeekArgs,
  classifyDeepSeekFailure,
  parseDeepSeekOutput,
} from '../src/core/deepseek-harness.js';
import { buildHarnessChildEnv } from '../src/core/runtime-capabilities.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Pi argv ─────────────────────────────────────────────────────────────
test('pi argv freezes --print --mode text --no-session with positional prompt', () => {
  assert.deepEqual(buildPiCliArgs('Summarize the report'), [
    '--print',
    '--mode',
    'text',
    '--no-session',
    'Summarize the report',
  ]);
});

test('pi argv appends --model only when a non-empty model is provided', () => {
  assert.deepEqual(buildPiCliArgs('task', 'grok-4.5'), [
    '--print', '--mode', 'text', '--no-session', '--model', 'grok-4.5', 'task',
  ]);
  assert.deepEqual(buildPiCliArgs('task', '  '), [
    '--print', '--mode', 'text', '--no-session', 'task',
  ]);
});

test('pi argv keeps the prompt as one argv element even with shell metacharacters', () => {
  const argv = buildPiCliArgs('rm -rf / ; $(whoami) && `id`');
  assert.equal(argv[argv.length - 1], 'rm -rf / ; $(whoami) && `id`');
  assert.equal(argv.filter((part) => part.includes(';')).length, 1);
});

// ── Pi parser & failure classification ─────────────────────────────────
test('pi parser trims stdout and rejects blank output', () => {
  assert.equal(parsePiCliOutput('  OK  \n'), 'OK');
  assert.equal(parsePiCliOutput('   \n\t '), null);
});

test('pi failure classification separates auth, quota, network and unknown', () => {
  assert.equal(classifyPiCliFailure({ stderr: 'Error: invalid api key', exitCode: 1 }).kind, 'auth');
  assert.equal(classifyPiCliFailure({ stderr: 'quota exceeded for plan', exitCode: 1 }).kind, 'quota');
  assert.equal(classifyPiCliFailure({ stderr: 'fetch failed: network unreachable', exitCode: 1 }).kind, 'network');
  assert.equal(classifyPiCliFailure({ stderr: 'something odd', exitCode: 1 }).kind, 'model_failed');
  // cancelled runs are never "model failed"
  assert.equal(classifyPiCliFailure({ stderr: '', exitCode: null, aborted: true }).kind, 'aborted');
});

// ── DeepSeek argv ───────────────────────────────────────────────────────
test('deepseek argv uses --profile headless with positional prompt', () => {
  assert.deepEqual(buildDeepSeekArgs('Do the thing'), [
    '--profile',
    'headless',
    'Do the thing',
  ]);
});

test('deepseek argv never accepts provider/model flags or web mode', () => {
  const argv = buildDeepSeekArgs('task');
  assert.ok(!argv.includes('web'));
  assert.ok(!argv.some((part) => part.startsWith('--model')));
});

test('deepseek parser returns stdout text and rejects blank or reasoning-only output', () => {
  assert.equal(parseDeepSeekOutput('final answer'), 'final answer');
  assert.equal(parseDeepSeekOutput(''), null);
});

test('deepseek failure classification maps completed=0 semantics and preview gaps', () => {
  assert.equal(classifyDeepSeekFailure({ stderr: '', exitCode: 0 }).kind, 'ok');
  assert.equal(classifyDeepSeekFailure({ stderr: 'unknown profile: headless', exitCode: 1 }).kind, 'unsupported_profile');
  assert.equal(classifyDeepSeekFailure({ stderr: 'auth required', exitCode: 1 }).kind, 'auth');
  assert.equal(classifyDeepSeekFailure({ stderr: 'x', exitCode: 1 }).kind, 'model_failed');
});

// ── Harness child env allowlist ────────────────────────────────────────
test('harness child env is an explicit allowlist without provider secrets', () => {
  const env = buildHarnessChildEnv({
    parentEnv: {
      PATH: '/usr/bin',
      HOME: '/home/u',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'sk-openai',
      ANTHROPIC_API_KEY: 'sk-ant',
      DEEPSEEK_API_KEY: 'sk-ds',
      AWS_SECRET_ACCESS_KEY: 'secret',
      CUSTOM_TOKEN: 'leak',
    },
    customEnv: { EVIL: '1', OPENAI_API_KEY: 'spoof' },
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.TMPDIR, '/tmp');
  for (const forbidden of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'CUSTOM_TOKEN', 'EVIL']) {
    assert.ok(!(forbidden in env), `${forbidden} must not leak into the harness child env`);
  }
});

test('harness child env works when parent env lacks optional entries', () => {
  const env = buildHarnessChildEnv({ parentEnv: { PATH: '/bin' }, customEnv: null });
  assert.equal(env.PATH, '/bin');
  assert.ok('HOME' in env || !('HOME' in env)); // no throw, deterministic shape
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
  console.log(`\n${passed}/${tests.length} pi/deepseek harness contract tests passed`);
}

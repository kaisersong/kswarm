/**
 * Pi CLI one-shot harness (design §4 of 2026-08-29-kswarm-pi-deepseek-harness-design.md).
 *
 * Frozen argv contract (pi 0.73.1):
 *   pi --print --mode text --no-session [--model <model>] <prompt>
 *
 * - argv is an exact array handed to spawn(shell:false); the prompt is a
 *   single argv element, never a shell string.
 * - stdout is the final answer; stderr is diagnostics/reasoning only.
 * - env is the harness allowlist (no provider secrets, no customEnv).
 * - non-zero exit, blank stdout, timeout, abort and oversize output are all
 *   failures with distinct, classified error kinds.
 */
import { spawn } from 'node:child_process';
import { buildHarnessChildEnv } from './runtime-capabilities.js';

export const PI_TIMEOUT_MS = 10 * 60_000;
export const PI_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

export function buildPiCliArgs(prompt, model = '') {
  return [
    '--print',
    '--mode',
    'text',
    '--no-session',
    ...(String(model || '').trim() ? ['--model', String(model).trim()] : []),
    String(prompt || ''),
  ];
}

export function parsePiCliOutput(stdout = '') {
  const text = String(stdout || '').trim();
  return text === '' ? null : text;
}

const PI_AUTH_PATTERNS = [/invalid api key/i, /unauthorized/i, /not logged in/i, /authentication/i, /api key/i];
const PI_QUOTA_PATTERNS = [/quota/i, /rate limit/i, /usage limit/i, /billing/i];
const PI_NETWORK_PATTERNS = [/network/i, /fetch failed/i, /econnrefused/i, /etimedout/i, /enotfound/i, /unreachable/i];

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyPiCliFailure({ stderr = '', exitCode = null, aborted = false } = {}) {
  if (aborted) {
    return { kind: 'aborted', retryable: false };
  }
  if (exitCode === null || exitCode === undefined) {
    return { kind: 'timeout', retryable: true };
  }
  const text = String(stderr || '');
  if (matchesAny(text, PI_AUTH_PATTERNS)) {
    return { kind: 'auth', retryable: false };
  }
  if (matchesAny(text, PI_QUOTA_PATTERNS)) {
    return { kind: 'quota', retryable: true };
  }
  if (matchesAny(text, PI_NETWORK_PATTERNS)) {
    return { kind: 'network', retryable: true };
  }
  return { kind: 'model_failed', retryable: true };
}

/**
 * Run one Pi task. `extraEnv` passes harness-own runtime controls (e.g. the
 * capture file in tests) — it is merged AFTER the allowlist and must never
 * contain provider secrets in production paths.
 */
export function runPiHarness(runtimePath, prompt, model = '', workFolder = '', options = {}) {
  return new Promise((resolve) => {
    const argv = buildPiCliArgs(prompt, model);
    const env = {
      ...buildHarnessChildEnv({ parentEnv: options.parentEnv ?? process.env, customEnv: null }),
      ...(options.extraEnv || {}),
    };
    let child;
    try {
      child = spawn(runtimePath, argv, {
        cwd: workFolder || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        shell: false,
      });
    } catch (error) {
      resolve({ ok: false, errorKind: 'spawn_failed', retryable: false, stderr: String(error?.message || error) });
      return;
    }

    const timeoutMs = options.timeoutMs ?? PI_TIMEOUT_MS;
    const outputLimit = options.outputLimitBytes ?? PI_OUTPUT_LIMIT_BYTES;
    const startedAt = Date.now();

    let stdout = '';
    let stderr = '';
    let stdoutCapped = false;
    let settled = false;

    const timer = setTimeout(() => killChild('timeout'), timeoutMs);
    const abortListener = () => killChild('abort');
    if (options.signal) {
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    function killChild(reason) {
      if (child.killed) return;
      child.kill(reason === 'abort' ? 'SIGTERM' : 'SIGKILL');
      // grace period, then hard kill the whole process group
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, KILL_GRACE_MS).unref();
    }

    function settle(payload) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', abortListener);
      resolve(payload);
    }

    child.stdout.on('data', (chunk) => {
      if (stdoutCapped) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, 'utf8') > outputLimit) {
        stdoutCapped = true;
        killChild('output_limit');
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      const failure = stdoutCapped
        ? { kind: 'output_limit', retryable: false, text: stdout.slice(0, outputLimit) }
        : { kind: 'spawn_failed', retryable: false };
      settle({
        ok: false,
        errorKind: failure.kind,
        retryable: failure.retryable,
        ...(failure.text !== undefined ? { text: failure.text } : {}),
        stderr: String(error?.message || error),
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('close', (code, signal) => {
      const durationMs = Date.now() - startedAt;
      if (stdoutCapped) {
        // diagnostic truncated summary only (design §3: 超限即停)
        settle({ ok: false, errorKind: 'output_limit', retryable: false, durationMs, text: stdout.slice(0, outputLimit) });
        return;
      }
      if (options.signal?.aborted) {
        settle({ ok: false, errorKind: 'aborted', retryable: false, durationMs });
        return;
      }
      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        settle({ ok: false, errorKind: 'timeout', retryable: true, durationMs });
        return;
      }
      const text = parsePiCliOutput(stdout);
      if (code === 0 && text !== null) {
        settle({ ok: true, text, exitCode: code, stderr: stderr.slice(0, 2_000), durationMs });
        return;
      }
      if (text === null && code === 0) {
        settle({ ok: false, errorKind: 'empty_output', retryable: true, exitCode: code, durationMs });
        return;
      }
      const failure = classifyPiCliFailure({ stderr, exitCode: code });
      settle({
        ok: false,
        exitCode: code,
        stderr: stderr.slice(0, 2_000),
        durationMs,
        errorKind: failure.kind,
        retryable: failure.retryable,
      });
    });
  });
}

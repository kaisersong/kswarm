/**
 * DeepSeek Harness (`dsh`) one-shot harness contract
 * (design §5 of 2026-08-29-kswarm-pi-deepseek-harness-design.md).
 *
 * Target form (pending a versioned, real-binary verification):
 *   dsh --profile headless <prompt>
 *
 * stdout carries only the final assistant text, reasoning lives on stderr,
 * `completed` exits 0, everything else exits 1. The official CLI is still
 * developer preview: this module freezes the argv/parser/classifier so the
 * fake-executable contract test pins the shape, but the runtime stays
 * `supported=false` in the capability registry until a real headless probe
 * passes on the target machine.
 */

export function buildDeepSeekArgs(prompt) {
  return [
    '--profile',
    'headless',
    String(prompt || ''),
  ];
}

export function parseDeepSeekOutput(stdout = '') {
  const text = String(stdout || '').trim();
  return text === '' ? null : text;
}

const DSH_AUTH_PATTERNS = [/auth/i, /unauthorized/i, /credential/i, /login/i];
const DSH_PROFILE_PATTERNS = [/unknown profile/i, /profile.*not found/i, /missing profile/i];

export function classifyDeepSeekFailure({ stderr = '', exitCode = null, aborted = false } = {}) {
  if (aborted) return { kind: 'aborted', retryable: false };
  if (exitCode === 0) return { kind: 'ok', retryable: true };
  if (exitCode === null || exitCode === undefined) return { kind: 'timeout', retryable: true };
  const text = String(stderr || '');
  if (DSH_PROFILE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: 'unsupported_profile', retryable: false };
  }
  if (DSH_AUTH_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: 'auth', retryable: false };
  }
  return { kind: 'model_failed', retryable: true };
}

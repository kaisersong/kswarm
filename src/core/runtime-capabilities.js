/**
 * Runtime capability registry — the single source of truth for native CLI
 * runtime support (design §3 of 2026-08-29-kswarm-pi-deepseek-harness-design.md).
 *
 * Every consumer (selection, /runtimes catalog, agent create validation,
 * probe, auto-worker) reads this registry; keeping a second allowlist
 * anywhere is a contract violation flagged by the adversarial review.
 *
 * Capability fields:
 *   type            — stable runtime id used across KSwarm and Desktop
 *   executable      — discovery bin name
 *   harnessId       — which argv builder/runner owns this runtime
 *   supported       — creation allowed? requires verified harness contract
 *   probe           — { generation: boolean } readiness probe policy
 *   modelPolicy     — 'optional_flag' | 'none'
 *   sessionPolicy   — 'no_session' | 'cli_owned'
 *   unsupportedReason — stable reasonCode when supported=false
 */

import { buildPiCliArgs } from './pi-cli-harness.js';

export const RUNTIME_CAPABILITIES = Object.freeze([
  { type: 'xiaok-cli', executable: 'xiaok', harnessId: 'xiaok', supported: true, probe: { generation: false }, modelPolicy: 'optional_flag', sessionPolicy: 'cli_owned' },
  { type: 'claude', executable: 'claude', harnessId: 'claude', supported: true, probe: { generation: true }, modelPolicy: 'optional_flag', sessionPolicy: 'cli_owned' },
  { type: 'codex', executable: 'codex', harnessId: 'codex', supported: true, probe: { generation: true }, modelPolicy: 'optional_flag', sessionPolicy: 'cli_owned' },
  { type: 'opencode', executable: 'opencode', harnessId: 'opencode', supported: true, probe: { generation: true }, modelPolicy: 'optional_flag', sessionPolicy: 'cli_owned' },
  { type: 'gemini', executable: 'gemini', harnessId: 'gemini', supported: true, probe: { generation: true }, modelPolicy: 'optional_flag', sessionPolicy: 'cli_owned' },
  { type: 'qoder', executable: 'qodercli', harnessId: 'qoder', supported: true, probe: { generation: false }, modelPolicy: 'optional_flag', sessionPolicy: 'cli_owned' },
  { type: 'kimi', executable: 'kimi', harnessId: 'kimi-cli', supported: true, probe: { generation: true }, modelPolicy: 'optional_flag', sessionPolicy: 'cli_owned' },
  {
    // Pi harness contract frozen at pi 0.73.1 (design §4):
    // pi --print --mode text --no-session [--model <model>] <prompt>
    type: 'pi',
    executable: 'pi',
    harnessId: 'pi-cli',
    supported: true,
    probe: { generation: true },
    modelPolicy: 'optional_flag',
    sessionPolicy: 'no_session',
    verifiedVersionRange: '0.73.x',
  },
  { type: 'hermes', executable: 'hermes', harnessId: null, supported: false, probe: { generation: false }, modelPolicy: 'none', sessionPolicy: 'cli_owned', unsupportedReason: 'runtime_unsupported' },
  { type: 'copilot', executable: 'copilot', harnessId: null, supported: false, probe: { generation: false }, modelPolicy: 'none', sessionPolicy: 'cli_owned', unsupportedReason: 'runtime_unsupported' },
  { type: 'cursor', executable: 'cursor-agent', harnessId: null, supported: false, probe: { generation: false }, modelPolicy: 'none', sessionPolicy: 'cli_owned', unsupportedReason: 'runtime_unsupported' },
  { type: 'kiro', executable: 'kiro-cli', harnessId: null, supported: false, probe: { generation: false }, modelPolicy: 'none', sessionPolicy: 'cli_owned', unsupportedReason: 'runtime_unsupported' },
  { type: 'openclaw', executable: 'openclaw', harnessId: null, supported: false, probe: { generation: false }, modelPolicy: 'none', sessionPolicy: 'cli_owned', unsupportedReason: 'runtime_unsupported' },
  {
    // DeepSeek official `dsh` CLI is developer preview; headless contract is
    // NOT verified on this machine (no dsh binary, no versioned probe
    // evidence). detected-but-unsupported per design §5/§9 until a real
    // `dsh --profile headless` probe passes.
    type: 'deepseek',
    executable: 'dsh',
    harnessId: 'deepseek-dsh',
    supported: false,
    probe: { generation: false },
    modelPolicy: 'none',
    sessionPolicy: 'cli_owned',
    unsupportedReason: 'deepseek_headless_not_verified',
  },
]);

const CAPABILITY_BY_TYPE = new Map(RUNTIME_CAPABILITIES.map((capability) => [capability.type, capability]));

export function getRuntimeCapability(runtimeType) {
  return CAPABILITY_BY_TYPE.get(normalizeType(runtimeType)) ?? null;
}

export function isSupportedRuntimeType(runtimeType) {
  const capability = getRuntimeCapability(runtimeType);
  return Boolean(capability?.supported);
}

export function listSupportedCliRuntimeTypes() {
  return RUNTIME_CAPABILITIES.filter((capability) => capability.supported).map((capability) => capability.type);
}

export function supportsGenerationProbe(runtimeType) {
  return Boolean(getRuntimeCapability(runtimeType)?.probe?.generation);
}

/**
 * Stable `/runtimes` catalog entry: detected/supported/callability/reasonCode.
 * `supported` is a creation gate, NOT readiness — callability starts at
 * `unknown` until a real generation probe runs (adversarial review point 1).
 */
export function runtimeCatalogEntry(runtimeType, { detected = false, path = null } = {}) {
  const capability = getRuntimeCapability(runtimeType);
  const supported = Boolean(capability?.supported);
  return {
    type: normalizeType(runtimeType),
    detected: Boolean(detected),
    supported,
    path: path || null,
    callability: supported ? (detected ? 'unknown' : 'unavailable') : 'unavailable',
    reasonCode: supported
      ? (detected ? null : 'runtime_not_detected')
      : (capability?.unsupportedReason ?? 'runtime_unsupported'),
  };
}

const GENERATION_PROBE_PROMPT = 'Reply with exactly OK. Do not use tools or modify files.';

/**
 * Readiness probe argv per runtime. Reuses the runtime's own harness argv
 * builder so the probe exercises the exact production contract — with a
 * side-effect-free prompt (design §2 goal 3).
 */
export function generationProbeArgv(runtimeType, model = '') {
  switch (normalizeType(runtimeType)) {
    case 'claude':
      return ['-p', GENERATION_PROBE_PROMPT, '--output-format', 'text', '--permission-mode', 'plan'];
    case 'codex':
      return ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', ...(model ? ['--model', model] : []), GENERATION_PROBE_PROMPT];
    case 'opencode':
      return ['run', '--format', 'json', ...(model ? ['--model', model] : []), GENERATION_PROBE_PROMPT];
    case 'gemini':
      return ['-p', GENERATION_PROBE_PROMPT, '-o', 'text', ...(model ? ['-m', model] : [])];
    case 'pi':
      // exact production contract with a side-effect-free prompt (design §4)
      return buildPiCliArgs(GENERATION_PROBE_PROMPT, model);
    default:
      return null;
  }
}

const HARNESS_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']);

/**
 * Explicit allowlist child env for native CLI harnesses (design §3):
 * PATH/HOME/TMPDIR/locale only. Provider secrets and caller customEnv are
 * dropped — the CLI reads its own credentials from its own config files.
 */
export function buildHarnessChildEnv({ parentEnv = {}, customEnv = null } = {}) {
  const env = {};
  for (const key of HARNESS_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  // customEnv is intentionally ignored for native CLI harnesses; do not
  // spread it, do not log it, do not forward it.
  void customEnv;
  return env;
}

function normalizeType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

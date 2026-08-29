import { execFileSync } from 'node:child_process';
import { createUnknownRuntimeHealth, recordProbeResult, recordRuntimeSuccess } from './runtime-health.js';
import { buildKimiCliArgs } from './kimi-cli-harness.js';

const GENERATION_PROBE_PROMPT = 'Reply with exactly OK. Do not use tools or modify files.';
const GENERATION_PROBE_TYPES = new Set(['claude', 'codex', 'opencode', 'gemini', 'kimi']);

export function supportsGenerationProbe(runtimeType) {
  return GENERATION_PROBE_TYPES.has(String(runtimeType || '').trim().toLowerCase());
}

export async function probeAgentGeneration(agent = {}, options = {}) {
  if (!agent.runtimePath || !supportsGenerationProbe(agent.runtimeType)) {
    return { ok: false, output: '', unsupported: true };
  }
  const runCommand = options.runCommand || defaultRunCommand;
  const args = generationProbeArgs(agent.runtimeType, agent.model);
  const startedAt = Date.now();
  const output = await runCommand(agent.runtimePath, args, { timeout: options.timeoutMs || 30_000 });
  return {
    ok: Boolean(String(output || '').trim()),
    output: String(output || '').trim(),
    durationMs: Date.now() - startedAt,
  };
}

export async function probeAgentRuntime(agent = {}, options = {}) {
  const now = options.now ?? Date.now();
  const startedAt = Date.now();
  const runCommand = options.runCommand || defaultRunCommand;
  const enableGenerationProbe = options.enableGenerationProbe === true;
  const generationProbe = options.generationProbe || null;

  const base = {
    agentId: agent.id || null,
    runtimeType: agent.runtimeType || null,
    runtimePath: agent.runtimePath || null,
  };

  if (!agent.runtimeType || agent.runtimeType === 'builtin' || agent.runtimeType === 'xiaok') {
    const runtimeHealth = recordRuntimeSuccess(defaultHealth(agent), {
      outputCapabilities: defaultOutputCapabilities(agent),
      taskCapabilities: defaultTaskCapabilities(agent),
    }, now);
    return {
      ...base,
      probe: 'skip',
      message: agent.runtimeType === 'xiaok' ? 'xiaok builtin runtime' : 'No CLI runtime (builtin/API mode)',
      healthy: true,
      callability: 'limited',
      durationMs: Date.now() - startedAt,
      runtimeHealth,
    };
  }

  if (!agent.runtimePath) {
    const runtimeHealth = recordProbeResult(defaultHealth(agent), {
      commandOk: false,
      generationOk: false,
      error: 'runtimePath not set',
      outputCapabilities: defaultOutputCapabilities(agent),
      taskCapabilities: defaultTaskCapabilities(agent),
    }, now);
    return {
      ...base,
      probe: 'fail',
      message: 'runtimePath not set',
      error: 'runtimePath not set',
      healthy: false,
      callability: 'unavailable',
      durationMs: Date.now() - startedAt,
      runtimeHealth,
    };
  }

  try {
    const output = await probeCommand(agent.runtimePath, runCommand);
    let generationOk = false;
    let generationSkipped = true;
    let generationError = null;

    if (enableGenerationProbe && generationProbe) {
      generationSkipped = false;
      try {
        const generationResult = await generationProbe(agent);
        generationOk = typeof generationResult === 'object'
          ? generationResult?.ok === true && Boolean(String(generationResult?.output || '').trim())
          : Boolean(generationResult);
      } catch (err) {
        generationError = err.message || String(err);
      }
    }

    const runtimeHealth = recordProbeResult(defaultHealth(agent), {
      commandOk: true,
      generationOk,
      generationSkipped,
      error: generationError,
      outputCapabilities: defaultOutputCapabilities(agent),
      taskCapabilities: defaultTaskCapabilities(agent),
      durationMs: null,
    }, now);

    return {
      ...base,
      probe: 'ok',
      version: firstLine(output),
      healthy: generationSkipped || generationOk,
      callability: generationSkipped ? 'limited' : generationOk ? 'available' : 'unavailable',
      durationMs: Date.now() - startedAt,
      ...(generationError ? { message: generationError, error: generationError } : {}),
      runtimeHealth,
    };
  } catch (err) {
    const message = err.message?.slice(0, 200) || 'CLI not responding';
    const runtimeHealth = recordProbeResult(defaultHealth(agent), {
      commandOk: false,
      generationOk: false,
      error: message,
      outputCapabilities: defaultOutputCapabilities(agent),
      taskCapabilities: defaultTaskCapabilities(agent),
    }, now);
    return {
      ...base,
      probe: 'fail',
      message,
      error: message,
      healthy: false,
      callability: 'unavailable',
      durationMs: Date.now() - startedAt,
      runtimeHealth,
    };
  }
}

async function probeCommand(runtimePath, runCommand) {
  try {
    return await runCommand(runtimePath, ['--version']);
  } catch {
    return runCommand(runtimePath, ['--help']);
  }
}

function defaultRunCommand(runtimePath, args, options = {}) {
  return execFileSync(runtimePath, args, {
    encoding: 'utf-8',
    timeout: options.timeout || 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function generationProbeArgs(runtimeType, model) {
  switch (String(runtimeType || '').toLowerCase()) {
    case 'claude':
      return ['-p', GENERATION_PROBE_PROMPT, '--output-format', 'text', '--permission-mode', 'plan'];
    case 'codex':
      return ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', ...(model ? ['--model', model] : []), GENERATION_PROBE_PROMPT];
    case 'opencode':
      return ['run', '--format', 'json', ...(model ? ['--model', model] : []), GENERATION_PROBE_PROMPT];
    case 'gemini':
      return ['-p', GENERATION_PROBE_PROMPT, '-o', 'text', ...(model ? ['-m', model] : [])];
    case 'kimi':
      return buildKimiCliArgs(GENERATION_PROBE_PROMPT, model);
    default:
      return [];
  }
}

function defaultHealth(agent) {
  return createUnknownRuntimeHealth({
    ...(agent.runtimeHealth || {}),
    outputCapabilities: defaultOutputCapabilities(agent),
    taskCapabilities: defaultTaskCapabilities(agent),
  });
}

function defaultOutputCapabilities(agent = {}) {
  if (Array.isArray(agent.outputCapabilities) && agent.outputCapabilities.length > 0) return normalizeList(agent.outputCapabilities);
  if (Array.isArray(agent.runtimeHealth?.outputCapabilities) && agent.runtimeHealth.outputCapabilities.length > 0) {
    return normalizeList(agent.runtimeHealth.outputCapabilities);
  }
  if (agent.runtimeType === 'builtin' || agent.runtimeType === 'xiaok') return ['markdown', 'html'];
  return ['markdown'];
}

function defaultTaskCapabilities(agent = {}) {
  if (Array.isArray(agent.taskCapabilities) && agent.taskCapabilities.length > 0) return normalizeList(agent.taskCapabilities);
  if (Array.isArray(agent.runtimeHealth?.taskCapabilities) && agent.runtimeHealth.taskCapabilities.length > 0) {
    return normalizeList(agent.runtimeHealth.taskCapabilities);
  }
  return normalizeList(agent.capabilities || []);
}

function normalizeList(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  )];
}

function firstLine(output = '') {
  return String(output || '').trim().split('\n')[0].slice(0, 100) || '(--help ok)';
}

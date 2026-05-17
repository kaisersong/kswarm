import { execFileSync } from 'node:child_process';
import { createUnknownRuntimeHealth, recordProbeResult, recordRuntimeSuccess } from './runtime-health.js';

export async function probeAgentRuntime(agent = {}, options = {}) {
  const now = options.now ?? Date.now();
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
      healthy: false,
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
        generationOk = Boolean(await generationProbe(agent));
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
      healthy: true,
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
      healthy: false,
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

function defaultRunCommand(runtimePath, args) {
  return execFileSync(runtimePath, args, {
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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

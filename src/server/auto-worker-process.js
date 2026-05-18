import { spawn as defaultSpawn } from 'node:child_process';

export function resolveNodeExecutable({ env = process.env, execPath = process.execPath } = {}) {
  return env.KSWARM_NODE_PATH || execPath;
}

export function createAutoWorkerSpawnConfig({
  scriptPath,
  agentId,
  alias = 'Worker',
  customArgs = [],
  cwd,
  env = process.env,
  execPath = process.execPath,
}) {
  return {
    command: resolveNodeExecutable({ env, execPath }),
    args: [scriptPath, agentId, alias, ...customArgs],
    options: {
      cwd,
      env,
      stdio: 'ignore',
      detached: true,
    },
  };
}

export function spawnAutoWorkerProcess(config, { spawnFn = defaultSpawn, onError } = {}) {
  let child;
  try {
    child = spawnFn(config.command, config.args, config.options);
  } catch (err) {
    if (onError) onError(err);
    return { ok: false, error: err.message, child: null };
  }

  if (child && typeof child.once === 'function') {
    child.once('error', err => {
      if (onError) onError(err);
    });
  }

  if (!child?.pid) {
    return { ok: false, error: 'worker_spawn_failed:no_pid', child };
  }

  if (typeof child.unref === 'function') child.unref();
  return { ok: true, child, pid: child.pid };
}

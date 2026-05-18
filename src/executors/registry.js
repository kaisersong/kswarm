import { presentationPptxExecutor } from './presentation-pptx-executor.js';

export function createLocalExecutorRegistry(executors = []) {
  const byId = new Map();
  for (const executor of executors) {
    if (!executor?.id || typeof executor.execute !== 'function') continue;
    byId.set(executor.id, executor);
    for (const alias of executor.aliases || []) {
      if (alias) byId.set(alias, executor);
    }
  }

  return {
    list() {
      const listed = [];
      const seen = new Set();
      for (const executor of byId.values()) {
        if (seen.has(executor.id)) continue;
        seen.add(executor.id);
        listed.push(toManifest(executor));
      }
      return listed;
    },
    has(id) {
      return byId.has(id);
    },
    async execute(id, context) {
      const executor = byId.get(id);
      if (!executor) return { ok: false, error: 'executor_not_found', executorId: id };
      return executor.execute(context);
    },
  };
}

export function createBuiltInLocalExecutorRegistry() {
  return createLocalExecutorRegistry([presentationPptxExecutor]);
}

function toManifest(executor) {
  const manifest = typeof executor.manifest === 'function'
    ? executor.manifest()
    : executor.manifest || executor;
  return {
    id: executor.id,
    taskCapabilities: Array.isArray(manifest.taskCapabilities) ? manifest.taskCapabilities : [],
    outputCapabilities: Array.isArray(manifest.outputCapabilities) ? manifest.outputCapabilities : [],
  };
}

const SUPPORTED_CLI_RUNTIME_TYPES = Object.freeze([
  'xiaok-cli',
  'claude',
  'codex',
  'opencode',
  'gemini',
  'qoder',
  'kimi',
]);

export function listSupportedCliRuntimeTypes() {
  return [...SUPPORTED_CLI_RUNTIME_TYPES];
}

export function isSupportedCliRuntimeType(runtimeType) {
  return SUPPORTED_CLI_RUNTIME_TYPES.includes(normalizeRuntimeType(runtimeType));
}

export function resolveAgentRuntimeSelection(input = {}, detectedRuntimes = []) {
  const runtimeType = normalizeRuntimeType(input.runtimeType);
  if (!isSupportedCliRuntimeType(runtimeType)) {
    throw new Error(`runtime_unsupported:${runtimeType || 'unknown'}`);
  }

  const detected = detectedRuntimes.find(runtime => normalizeRuntimeType(runtime?.type) === runtimeType);
  if (!detected?.path) throw new Error(`runtime_unavailable:${runtimeType}`);

  return {
    runtimeType,
    runtimePath: detected.path,
    runtimeModel: String(detected.model || '').trim() || null,
    provider: null,
    model: null,
    baseUrl: null,
    apiKey: null,
  };
}

function normalizeRuntimeType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

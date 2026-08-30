import { isSupportedRuntimeType, listSupportedCliRuntimeTypes as registryList } from './runtime-capabilities.js';

// Single owner: the capability registry decides which CLI runtimes are
// creatable. This module must NOT keep a second allowlist (adversarial
// review point 2).
export function listSupportedCliRuntimeTypes() {
  return registryList();
}

export function isSupportedCliRuntimeType(runtimeType) {
  return isSupportedRuntimeType(runtimeType);
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

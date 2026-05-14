/**
 * Model catalog — static list of known models per provider.
 * Aligned with multica's pkg/agent/models.go pattern.
 *
 * Providers with stable catalogs (Claude Code, Codex) use static lists.
 * Providers with mutable catalogs (cursor, hermes, kimi) would use
 * dynamic discovery via CLI — fall back to static on failure.
 */

/** @typedef {{ id: string, label: string, provider: string, default: boolean }} ModelInfo */

const CLAUDE_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', default: true },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'anthropic', default: false },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', default: false },
];

const OPENAI_MODELS = [
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai', default: true },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'openai', default: false },
  { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', provider: 'openai', default: false },
  { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', provider: 'openai', default: false },
];

const OLLAMA_MODELS = [
  { id: 'llama3.1', label: 'Llama 3.1', provider: 'ollama', default: true },
  { id: 'mistral', label: 'Mistral', provider: 'ollama', default: false },
  { id: 'qwen2.5', label: 'Qwen 2.5', provider: 'ollama', default: false },
  { id: 'deepseek-coder', label: 'DeepSeek Coder', provider: 'ollama', default: false },
];

/** @type {ModelInfo[]} */
const STATIC_CATALOG = [...CLAUDE_MODELS, ...OPENAI_MODELS, ...OLLAMA_MODELS];

/**
 * Get models for a provider.
 * @param {string} provider
 * @returns {ModelInfo[]}
 */
export function getModels(provider) {
  return STATIC_CATALOG.filter(m => m.provider === provider);
}

/**
 * Get default model for a provider.
 * @param {string} provider
 * @returns {ModelInfo | null}
 */
export function getDefaultModel(provider) {
  return STATIC_CATALOG.find(m => m.provider === provider && m.default) || null;
}

/**
 * List all providers that have a static model catalog.
 * @returns {string[]}
 */
export function getCatalogProviders() {
  return [...new Set(STATIC_CATALOG.map(m => m.provider))];
}

/**
 * Resolve the effective model for an agent.
 * Priority: agent.model > env default > catalog default.
 * @param {object} agent
 * @returns {string | null}
 */
export function resolveModel(agent) {
  if (agent.model) return agent.model;

  // Try provider-specific defaults
  if (agent.provider) {
    const defaultModel = getDefaultModel(agent.provider);
    if (defaultModel) return defaultModel.id;
  }

  return null;
}

/**
 * LLM Provider Factory
 *
 * Creates a provider instance from config object.
 */

import { createOpenAIProvider } from './providers/openai.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createOllamaProvider } from './providers/ollama.js';

const FACTORIES = {
  openai: createOpenAIProvider,
  anthropic: createAnthropicProvider,
  ollama: createOllamaProvider,
};

/**
 * Create a provider instance from config.
 * @param {{ provider: string, [key: string]: any }} config
 */
export function createProvider(config) {
  if (!config || !config.provider) {
    throw new Error('LLM config must include a "provider" field (openai | anthropic | ollama)');
  }
  const factory = FACTORIES[config.provider];
  if (!factory) {
    throw new Error(`Unknown LLM provider: "${config.provider}". Supported: ${Object.keys(FACTORIES).join(', ')}`);
  }
  return factory(config);
}

/**
 * List supported provider types.
 */
export function listProviders() {
  return Object.keys(FACTORIES);
}

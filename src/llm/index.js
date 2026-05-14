/**
 * KSwarm LLM Module
 *
 * Provides LLM provider creation for agents.
 * Agent LLM configuration is now stored in the Agent entity (agent-store.js).
 *
 * Usage:
 *   import { createProvider } from '../llm/index.js';
 *   const llm = createProvider({ provider: 'openai', apiKey: '...', model: '...' });
 *   const result = await llm.chat([{ role: 'user', content: 'Hello' }]);
 */

export { createProvider, listProviders } from './provider.js';

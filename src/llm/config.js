/**
 * Agent LLM Configuration Management
 *
 * Stores per-agent LLM configs in ~/.kswarm/llm-agents.json
 * Supports:
 * - Per-agent independent config
 * - Clone from another agent (inherit provider settings)
 * - Env-var-based default fallback
 *
 * Config file structure:
 * {
 *   "default": { provider, apiKey, baseUrl, model, ... },
 *   "agents": {
 *     "agent-id-1": { provider, apiKey, ... },
 *     "agent-id-2": { cloneFrom: "agent-id-1" },
 *   }
 * }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.kswarm');
const CONFIG_FILE = join(CONFIG_DIR, 'llm-agents.json');

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfigFile() {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return { default: null, agents: {} };
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return { default: null, agents: {} };
  }
}

function saveConfigFile(data) {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Build default config from environment variables.
 */
function envDefault() {
  // Try OpenAI-compatible first
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    };
  }
  // Then Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    };
  }
  // Then Ollama (no key needed)
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
    return {
      provider: 'ollama',
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      model: process.env.OLLAMA_MODEL || 'llama3.1',
    };
  }
  return null;
}

/**
 * Resolve config for a specific agent. Resolution order:
 * 1. Agent-specific config in file
 * 2. If agent config has `cloneFrom`, resolve the referenced agent
 * 3. File-level default
 * 4. Environment variable default
 */
export function resolveAgentConfig(agentId) {
  const file = loadConfigFile();

  // 1. Agent-specific
  const agentConf = file.agents?.[agentId];
  if (agentConf) {
    // 2. Clone support
    if (agentConf.cloneFrom) {
      const source = file.agents?.[agentConf.cloneFrom];
      if (source && !source.cloneFrom) {
        return { ...source, _resolvedFrom: agentConf.cloneFrom };
      }
      // If source not found or circular, fall through to default
    } else {
      return agentConf;
    }
  }

  // 3. File-level default
  if (file.default) return file.default;

  // 4. Env default
  return envDefault();
}

/**
 * Set config for a specific agent.
 */
export function setAgentConfig(agentId, config) {
  const file = loadConfigFile();
  if (!file.agents) file.agents = {};
  file.agents[agentId] = config;
  saveConfigFile(file);
}

/**
 * Set the default config (used by agents without their own config).
 */
export function setDefaultConfig(config) {
  const file = loadConfigFile();
  file.default = config;
  saveConfigFile(file);
}

/**
 * Clone one agent's config to another.
 */
export function cloneAgentConfig(targetAgentId, sourceAgentId) {
  const file = loadConfigFile();
  if (!file.agents) file.agents = {};
  file.agents[targetAgentId] = { cloneFrom: sourceAgentId };
  saveConfigFile(file);
}

/**
 * Remove an agent's config (will fall back to default).
 */
export function removeAgentConfig(agentId) {
  const file = loadConfigFile();
  if (file.agents?.[agentId]) {
    delete file.agents[agentId];
    saveConfigFile(file);
  }
}

/**
 * List all agent configs.
 */
export function listAgentConfigs() {
  const file = loadConfigFile();
  return {
    default: file.default || envDefault(),
    agents: file.agents || {},
  };
}

/**
 * Get the config file path (for display).
 */
export function getConfigPath() {
  return CONFIG_FILE;
}

/**
 * Agent Store — 管理 Agent 实体的 CRUD 和持久化
 *
 * 对齐 multica 架构：
 * - Agent = 配置包 (what to do: instructions, model, env, skills)
 * - Runtime = 执行引擎 (where to execute: worker process)
 *
 * 持久化: ~/.kswarm/agents.json (未来可换 SQLite)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { createUnknownRuntimeHealth } from './runtime-health.js';

const KSWARM_HOME = join(homedir(), '.kswarm');
const AGENTS_FILE = join(KSWARM_HOME, 'agents.json');

// ─── Agent Schema ─────────────────────────────────────────────────────────────
// Aligned with multica's Agent model

/**
 * @typedef {Object} Agent
 * @property {string} id
 * @property {string} name - Display name (unique)
 * @property {string} description
 * @property {string} instructions - System prompt for this agent
 * @property {'openai'|'anthropic'|'ollama'|null} provider
 * @property {string|null} model - LLM model identifier
 * @property {string|null} baseUrl - Provider API base URL
 * @property {string|null} apiKey - Provider API key
 * @property {Object} customEnv - Per-agent environment variables
 * @property {string[]} customArgs - Per-agent CLI arguments
 * @property {string[]} capabilities - What this agent can do
 * @property {string[]} roles - worker, project_owner
 * @property {number} maxConcurrentTasks
 * @property {'idle'|'working'|'blocked'|'error'|'offline'} status
 * @property {string|null} runtimeId - Which runtime process is serving this agent
 * @property {'local'|'cloud'} runtimeMode
 * @property {number} createdAt
 * @property {number|null} archivedAt
 * @property {string|null} archivedBy
 */

const AGENT_DEFAULTS = {
  description: '',
  instructions: '',
  provider: null,
  model: null,
  baseUrl: null,
  apiKey: null,
  customEnv: {},
  customArgs: [],
  capabilities: ['coding', 'testing', 'design', 'planning'],
  roles: ['worker'],
  maxConcurrentTasks: 6,
  status: 'offline',
  runtimeId: null,
  runtimeMode: 'local',
  runtimeHealth: null,
  createdAt: null,
  archivedAt: null,
  archivedBy: null,
};

// ─── Known Agent CLIs to probe (multica-style) ───────────────────────────────
const KNOWN_AGENT_CLIS = [
  { type: 'xiaok-cli',bin: 'xiaok',         envPath: 'KSWARM_XIAOK_PATH',    envModel: 'KSWARM_XIAOK_MODEL',    displayName: 'xiaok-cli', description: 'xiaok CLI（使用 xiaok 已配置的模型）' },
  { type: 'xiaok-cli',bin: 'xiaok-cli',     envPath: 'KSWARM_XIAOK_CLI_PATH',envModel: 'KSWARM_XIAOK_CLI_MODEL', displayName: 'xiaok-cli', description: 'xiaok-cli 智能体（使用 xiaok 已配置的模型）' },
  { type: 'claude',   bin: 'claude',        envPath: 'KSWARM_CLAUDE_PATH',   envModel: 'KSWARM_CLAUDE_MODEL',   displayName: 'Claude',    description: 'Anthropic Claude Code CLI（第三方）' },
  { type: 'codex',    bin: 'codex',         envPath: 'KSWARM_CODEX_PATH',    envModel: 'KSWARM_CODEX_MODEL',    displayName: 'Codex',     description: 'OpenAI Codex CLI（第三方）' },
  { type: 'opencode', bin: 'opencode',      envPath: 'KSWARM_OPENCODE_PATH', envModel: 'KSWARM_OPENCODE_MODEL', displayName: 'OpenCode',  description: 'OpenCode CLI（第三方，多 provider）' },
  { type: 'gemini',   bin: 'gemini',        envPath: 'KSWARM_GEMINI_PATH',   envModel: 'KSWARM_GEMINI_MODEL',   displayName: 'Gemini',    description: 'Google Gemini CLI（第三方）' },
  { type: 'hermes',   bin: 'hermes',        envPath: 'KSWARM_HERMES_PATH',   envModel: 'KSWARM_HERMES_MODEL',   displayName: 'Hermes',    description: 'Hermes Agent CLI（第三方）' },
  { type: 'copilot',  bin: 'copilot',       envPath: 'KSWARM_COPILOT_PATH',  envModel: 'KSWARM_COPILOT_MODEL',  displayName: 'Copilot',   description: 'GitHub Copilot CLI（第三方）' },
  { type: 'cursor',   bin: 'cursor-agent',  envPath: 'KSWARM_CURSOR_PATH',   envModel: 'KSWARM_CURSOR_MODEL',   displayName: 'Cursor',    description: 'Cursor Agent CLI（第三方）' },
  { type: 'kimi',     bin: 'kimi',          envPath: 'KSWARM_KIMI_PATH',     envModel: 'KSWARM_KIMI_MODEL',     displayName: 'Kimi',      description: 'Kimi Agent CLI（第三方）' },
  { type: 'kiro',     bin: 'kiro-cli',      envPath: 'KSWARM_KIRO_PATH',     envModel: 'KSWARM_KIRO_MODEL',     displayName: 'Kiro',      description: 'Kiro Agent CLI（第三方）' },
  { type: 'openclaw', bin: 'openclaw',      envPath: 'KSWARM_OPENCLAW_PATH', envModel: 'KSWARM_OPENCLAW_MODEL', displayName: 'OpenClaw',  description: 'OpenClaw Agent CLI（第三方）' },
  { type: 'pi',       bin: 'pi',            envPath: 'KSWARM_PI_PATH',       envModel: 'KSWARM_PI_MODEL',       displayName: 'Pi',        description: 'Pi Agent CLI（第三方）' },
  { type: 'qoder',    bin: 'qodercli',      envPath: 'KSWARM_QODER_PATH',    envModel: 'KSWARM_QODER_MODEL',    displayName: 'Qoder',     description: 'Qoder CLI（第三方）' },
];

function _which(cmd) {
  // Try execSync with PATH
  try {
    const result = execSync(`/usr/bin/which ${cmd} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
    const path = result.trim().split('\n')[0];
    if (path && path.startsWith('/')) return path;
  } catch { /* fall through */ }

  // Probe common locations (covers NVM, Homebrew, local installs)
  const home = homedir();
  const nvmDir = process.env.NVM_DIR || `${home}/.nvm`;
  const candidates = [
    `/usr/local/bin/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
    `${home}/.local/bin/${cmd}`,
    `${home}/.opencode/bin/${cmd}`,
  ];

  // Scan all NVM node versions for the binary
  try {
    const versionsDir = `${nvmDir}/versions/node`;
    if (existsSync(versionsDir)) {
      const versions = readdirSync(versionsDir);
      for (const v of versions) {
        candidates.push(`${versionsDir}/${v}/bin/${cmd}`);
      }
    }
  } catch { /* ignore */ }

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function _detectAgentCLIs() {
  const detected = [];
  for (const cli of KNOWN_AGENT_CLIS) {
    const binPath = process.env[cli.envPath] || cli.bin;
    const resolvedPath = _which(binPath);
    if (resolvedPath) {
      detected.push({
        type: cli.type,
        path: resolvedPath,
        model: (process.env[cli.envModel] || '').trim(),
        displayName: cli.displayName,
        description: cli.description,
      });
    }
  }
  return detected;
}

function _detectEnvLLM() {
  // Generic provider (from xiaok or custom env)
  if (process.env.KSWARM_API_KEY && process.env.KSWARM_BASE_URL) {
    return {
      provider: 'openai',  // xiaok uses OpenAI-compatible protocol
      apiKey: process.env.KSWARM_API_KEY,
      baseUrl: process.env.KSWARM_BASE_URL,
      model: process.env.KSWARM_MODEL || 'auto',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    };
  }
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
    return {
      provider: 'ollama',
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      model: process.env.OLLAMA_MODEL || 'llama3.1',
    };
  }
  return {};
}

// ─── Store Implementation ─────────────────────────────────────────────────────

export function createAgentStore() {
  let agents = new Map(); // id → Agent

  // Load from disk
  _load();

  // Seed defaults on cold start (empty store)
  _seedIfEmpty();

  function _load() {
    mkdirSync(KSWARM_HOME, { recursive: true });
    if (existsSync(AGENTS_FILE)) {
      try {
        const data = JSON.parse(readFileSync(AGENTS_FILE, 'utf-8'));
        if (Array.isArray(data)) {
          for (const a of data) agents.set(a.id, normalizeAgent(a));
        }
      } catch { /* ignore corrupt file */ }
    }
  }

  function _seedIfEmpty() {
    // Ensure xiaok desktop seed agent exists (single agent with PO + Worker roles)
    const hasXiaok = agents.has('xiaok');
    if (hasXiaok) return;

    const llmConfig = _detectEnvLLM();
    const desc = llmConfig.provider
      ? `xiaok 智能体 (${llmConfig.provider}/${llmConfig.model})`
      : 'xiaok 智能体（请在 xiaok 设置中配置模型 provider）';
    const defaults = {
      ...AGENT_DEFAULTS,
      runtimeType: 'xiaok',
      capabilities: ['coding', 'testing', 'design', 'planning'],
      ...llmConfig,
    };

    const xiaok = {
      ...defaults,
      id: 'xiaok',
      name: 'xiaok',
      description: desc,
      instructions: '你是 xiaok 内置智能体，既能担任项目负责人（PO）进行任务规划、派发和审核，也能作为执行者完成具体任务。',
      roles: ['project_owner', 'worker'],
      status: 'idle',
      createdAt: Date.now(),
    };
    agents.set(xiaok.id, normalizeAgent(xiaok));

    _save();
    console.log(`[AgentStore] Seed: ensured xiaok PO+Worker agents`);
  }

  function _save() {
    mkdirSync(KSWARM_HOME, { recursive: true });
    const arr = Array.from(agents.values()).filter(a => !a.archivedAt);
    // Also save archived in a separate section for recovery
    const archived = Array.from(agents.values()).filter(a => a.archivedAt);
    writeFileSync(AGENTS_FILE, JSON.stringify([...arr, ...archived], null, 2), 'utf-8');
  }

  // ─── CRUD ─────────────────────────────────────────────────────────

  function create(data) {
    // Validate name uniqueness
    const existing = Array.from(agents.values()).find(
      a => a.name === data.name && !a.archivedAt
    );
    if (existing) {
      return { error: `Agent name "${data.name}" already exists`, code: 409 };
    }

    const agent = {
      ...AGENT_DEFAULTS,
      ...data,
      id: data.id || randomUUID().slice(0, 12),
      createdAt: Date.now(),
      archivedAt: null,
    };

    // Ensure required fields
    if (!agent.name) return { error: 'name is required', code: 400 };

    agents.set(agent.id, normalizeAgent(agent));
    _save();
    return { ok: true, agent: agents.get(agent.id) };
  }

  function get(id) {
    return agents.get(id) || null;
  }

  function getByName(name) {
    return Array.from(agents.values()).find(a => a.name === name && !a.archivedAt) || null;
  }

  function list({ includeArchived = false } = {}) {
    const all = Array.from(agents.values());
    if (includeArchived) return all;
    return all.filter(a => !a.archivedAt);
  }

  function update(id, patch) {
    const agent = agents.get(id);
    if (!agent) return { error: 'agent not found', code: 404 };
    if (agent.archivedAt) return { error: 'agent is archived', code: 410 };

    // Name uniqueness check if name is being changed
    if (patch.name && patch.name !== agent.name) {
      const conflict = Array.from(agents.values()).find(
        a => a.name === patch.name && !a.archivedAt && a.id !== id
      );
      if (conflict) return { error: `Agent name "${patch.name}" already exists`, code: 409 };
    }

    // Merge patch (shallow for top-level, deep for objects)
    const updated = { ...agent };
    for (const [key, val] of Object.entries(patch)) {
      if (key === 'id' || key === 'createdAt') continue; // immutable
      if (key === 'customEnv' && typeof val === 'object') {
        updated.customEnv = { ...agent.customEnv, ...val };
      } else {
        updated[key] = val;
      }
    }

    agents.set(id, normalizeAgent(updated));
    _save();
    return { ok: true, agent: agents.get(id) };
  }

  function archive(id) {
    const agent = agents.get(id);
    if (!agent) return { error: 'agent not found', code: 404 };
    if (agent.archivedAt) return { error: 'already archived', code: 410 };

    agent.archivedAt = Date.now();
    agent.status = 'offline';
    agent.runtimeId = null;
    _save();
    return { ok: true, agent };
  }

  function restore(id) {
    const agent = agents.get(id);
    if (!agent) return { error: 'agent not found', code: 404 };
    if (!agent.archivedAt) return { ok: true, agent }; // already active

    agent.archivedAt = null;
    agent.archivedBy = null;
    _save();
    return { ok: true, agent };
  }

  function remove(id) {
    // Hard delete (use archive for soft delete)
    if (!agents.has(id)) return { error: 'agent not found', code: 404 };
    agents.delete(id);
    _save();
    return { ok: true };
  }

  // ─── Status Management ────────────────────────────────────────────

  function setStatus(id, status, runtimeId = undefined) {
    const agent = agents.get(id);
    if (!agent) return;
    agent.status = status;
    if (runtimeId !== undefined) agent.runtimeId = runtimeId;
    _save();
  }

  function setOnline(id, runtimeId) {
    setStatus(id, 'idle', runtimeId);
  }

  function setOffline(id) {
    setStatus(id, 'offline', null);
  }

  function updateRuntimeHealth(id, runtimeHealth) {
    const agent = agents.get(id);
    if (!agent) return { error: 'agent not found', code: 404 };
    agent.runtimeHealth = normalizeRuntimeHealth(agent, runtimeHealth);
    _save();
    return { ok: true, agent };
  }

  /** Reset all agents to offline — call on server startup (old processes are dead) */
  function resetAllOffline() {
    let count = 0;
    for (const agent of agents.values()) {
      // Skip builtin/xiaok agents - they don't have worker processes
      if (agent.runtimeType === 'xiaok' || agent.runtimeType === 'builtin') continue;
      if (agent.status !== 'offline' && !agent.archivedAt) {
        agent.status = 'offline';
        agent.runtimeId = null;
        count++;
      }
    }
    if (count > 0) _save();
    return count;
  }

  // ─── LLM Config Resolution ───────────────────────────────────────

  /**
   * Get the LLM config for an agent (for creating a provider instance)
   */
  function getLLMConfig(id) {
    const agent = agents.get(id);
    if (!agent) return null;
    if (!agent.provider) return null;
    return {
      provider: agent.provider,
      apiKey: agent.apiKey,
      baseUrl: agent.baseUrl,
      model: agent.model,
    };
  }

  /**
   * Resolve LLM config with env fallback (for agents without explicit config)
   */
  function resolveLLMConfig(id) {
    const explicit = getLLMConfig(id);
    if (explicit) return explicit;

    // Env fallback
    if (process.env.OPENAI_API_KEY) {
      return {
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      };
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return {
        provider: 'anthropic',
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      };
    }
    if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
      return {
        provider: 'ollama',
        baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
        model: process.env.OLLAMA_MODEL || 'llama3.1',
      };
    }
    return null;
  }

  // ─── Redaction (for non-owner visibility) ─────────────────────────

  function redact(agent) {
    if (!agent) return null;
    const copy = { ...agent };
    if (copy.apiKey) copy.apiKey = '****';
    if (copy.customEnv && Object.keys(copy.customEnv).length > 0) {
      copy.customEnv = Object.fromEntries(
        Object.keys(copy.customEnv).map(k => [k, '****'])
      );
      copy.customEnvRedacted = true;
    }
    return copy;
  }

  return {
    create,
    get,
    getByName,
    list,
    update,
    archive,
    restore,
    remove,
    setStatus,
    setOnline,
    setOffline,
    updateRuntimeHealth,
    resetAllOffline,
    getLLMConfig,
    resolveLLMConfig,
    redact,
    getStorePath: () => AGENTS_FILE,
    getKnownCLIs: () => KNOWN_AGENT_CLIS.map(c => ({ type: c.type, bin: c.bin, displayName: c.displayName, description: c.description })),
    detectCLIs: () => _detectAgentCLIs(),
  };
}

function normalizeAgent(agent) {
  if (!agent) return agent;
  const normalized = {
    ...AGENT_DEFAULTS,
    ...agent,
  };
  normalized.runtimeHealth = normalizeRuntimeHealth(normalized, normalized.runtimeHealth);
  return normalized;
}

function normalizeRuntimeHealth(agent, runtimeHealth = null) {
  const outputCapabilities = normalizeCapabilityList(
    runtimeHealth?.outputCapabilities?.length
      ? runtimeHealth.outputCapabilities
      : defaultOutputCapabilities(agent)
  );
  const taskCapabilities = normalizeCapabilityList(
    runtimeHealth?.taskCapabilities?.length
      ? runtimeHealth.taskCapabilities
      : (agent.taskCapabilities || agent.capabilities || AGENT_DEFAULTS.capabilities)
  );
  return createUnknownRuntimeHealth({
    ...(runtimeHealth || {}),
    outputCapabilities,
    taskCapabilities,
  });
}

function defaultOutputCapabilities(agent = {}) {
  if (Array.isArray(agent.outputCapabilities) && agent.outputCapabilities.length > 0) return agent.outputCapabilities;
  if (agent.runtimeType === 'builtin' || agent.runtimeType === 'xiaok') return ['markdown', 'html'];
  return ['markdown'];
}

function normalizeCapabilityList(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  )];
}

/**
 * Agent Registry — Tracks known agent capabilities
 *
 * Supplements broker's presence with capability metadata.
 * Hub needs to know WHAT each agent can do, not just that they're online.
 *
 * Profiles can be:
 * - Pre-configured (static config)
 * - Self-reported (agent sends capabilities on register)
 * - Learned (from past task success/failure)
 */

/** @type {Map<string, import('../types.js').AgentProfile>} */

export function createAgentRegistry(presets = []) {
  const agents = new Map();

  // Load presets
  for (const preset of presets) {
    agents.set(preset.participantId, { ...preset, status: 'offline' });
  }

  function register(profile) {
    agents.set(profile.participantId, profile);
  }

  function updateStatus(participantId, status) {
    const agent = agents.get(participantId);
    if (agent) agent.status = status;
  }

  function markBusy(participantId) {
    updateStatus(participantId, 'busy');
  }

  function markAvailable(participantId) {
    updateStatus(participantId, 'available');
  }

  function markOffline(participantId) {
    updateStatus(participantId, 'offline');
  }

  function getAvailable() {
    return [...agents.values()].filter(a => a.status === 'available');
  }

  function getAll() {
    return [...agents.values()];
  }

  function findByCapability(capability) {
    return [...agents.values()].filter(a => a.capabilities.includes(capability));
  }

  return {
    register,
    updateStatus,
    markBusy,
    markAvailable,
    markOffline,
    getAvailable,
    getAll,
    findByCapability,
  };
}

/**
 * Default agent presets — what we know about commonly available agents.
 */
export const DEFAULT_AGENT_PRESETS = [
  {
    participantId: 'xiaok-default',
    alias: '@xiaok',
    capabilities: ['engineering', 'coding', 'typescript', 'documentation', 'research', 'analysis', 'product', 'requirements'],
    role: 'engineer',
    status: 'offline',
  },
  {
    participantId: 'claude-code-default',
    alias: '@claude',
    capabilities: ['engineering', 'coding', 'architecture', 'system-design', 'testing', 'qa'],
    role: 'architect',
    status: 'offline',
  },
  {
    participantId: 'codex-default',
    alias: '@codex',
    capabilities: ['engineering', 'coding', 'testing', 'qa', 'devops', 'deployment'],
    role: 'engineer',
    status: 'offline',
  },
  {
    participantId: 'qoder-default',
    alias: '@qoder',
    capabilities: ['research', 'analysis', 'documentation', 'product', 'requirements'],
    role: 'analyst',
    status: 'offline',
  },
];

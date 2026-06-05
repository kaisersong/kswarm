import { getBrokerPresenceParticipantId, isHostedAgent } from './agent-execution.js';

const DESKTOP_RUNTIME_SOURCE = 'desktop-agent-runtime';
const DESKTOP_SEED_AGENT_IDS = new Set(['xiaok-po', 'xiaok-worker']);

export function applyBrokerPresenceToAgentProfiles(agents = [], onlineAgentIds = null) {
  if (!(onlineAgentIds instanceof Set)) return Array.isArray(agents) ? agents : [];
  return (Array.isArray(agents) ? agents : []).map(agent => {
    const brokerParticipantId = getBrokerPresenceParticipantId(agent);
    const brokerOnline = Boolean(brokerParticipantId && onlineAgentIds.has(brokerParticipantId));
    if (!isDesktopRuntimeAgent(agent)) return { ...agent, brokerOnline };

    if (!brokerOnline) {
      return {
        ...agent,
        brokerParticipantId,
        status: 'offline',
        brokerOnline: false,
        runtimeHealth: {
          ...(agent.runtimeHealth || {}),
          state: 'offline',
        },
      };
    }

    return {
      ...agent,
      brokerParticipantId,
      status: agent.status === 'offline' ? 'idle' : agent.status,
      brokerOnline: true,
      runtimeHealth: {
        ...(agent.runtimeHealth || {}),
        state: 'healthy',
        taskCapabilities: agent.taskCapabilities || agent.capabilities || agent.runtimeHealth?.taskCapabilities || [],
        outputCapabilities: agent.outputCapabilities || agent.runtimeHealth?.outputCapabilities || [],
      },
    };
  });
}

function isDesktopRuntimeAgent(agent) {
  return Boolean(
    agent &&
    (isHostedAgent(agent) || agent.runtimeSource === DESKTOP_RUNTIME_SOURCE || DESKTOP_SEED_AGENT_IDS.has(agent.id))
  );
}

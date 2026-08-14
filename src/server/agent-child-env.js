export function buildAgentChildEnv(agent, agentId, env = process.env, runtime = {}) {
  const childEnv = { ...env, ...agent.customEnv };
  if (agent.provider) {
    if (agent.provider === 'openai') {
      if (agent.apiKey) childEnv.OPENAI_API_KEY = agent.apiKey;
      if (agent.baseUrl) childEnv.OPENAI_BASE_URL = agent.baseUrl;
      if (agent.model) childEnv.OPENAI_MODEL = agent.model;
    } else if (agent.provider === 'anthropic') {
      if (agent.apiKey) childEnv.ANTHROPIC_API_KEY = agent.apiKey;
      if (agent.model) childEnv.ANTHROPIC_MODEL = agent.model;
    } else if (agent.provider === 'ollama') {
      if (agent.baseUrl) childEnv.OLLAMA_BASE_URL = agent.baseUrl;
      if (agent.model) childEnv.OLLAMA_MODEL = agent.model;
    }
  }
  childEnv.KSWARM_AGENT_ID = agentId;
  if (runtime.logicalAgentId) childEnv.KSWARM_LOGICAL_AGENT_ID = runtime.logicalAgentId;
  if (runtime.projectId) childEnv.KSWARM_PROJECT_ID = runtime.projectId;
  if (agent.runtimeType) childEnv.KSWARM_AGENT_RUNTIME_TYPE = agent.runtimeType;
  if (agent.runtimePath) childEnv.KSWARM_AGENT_RUNTIME_PATH = agent.runtimePath;
  if (agent.runtimeModel || agent.model) childEnv.KSWARM_AGENT_RUNTIME_MODEL = agent.runtimeModel || agent.model;
  return childEnv;
}

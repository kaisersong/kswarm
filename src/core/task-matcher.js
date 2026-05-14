/**
 * KSwarm — Smart Task-to-Agent Matcher
 *
 * Replaces round-robin assignment with capability-based, load-aware matching.
 */

// Keyword map: capability → related keywords (multilingual)
const CAPABILITY_KEYWORDS = {
  coding: ['implement', 'code', 'develop', 'build', 'create', 'write', 'program', 'function', 'module', 'api', '编码', '开发', '实现', '编写'],
  testing: ['test', 'verify', 'validate', 'qa', 'unit test', 'e2e', 'coverage', '测试', '验证', '测试用例'],
  design: ['design', 'architecture', 'schema', 'ui', 'ux', 'wireframe', 'layout', '设计', '架构', '界面'],
  analysis: ['analyze', 'research', 'investigate', 'review', 'audit', 'evaluate', '分析', '调研', '研究', '评估'],
  planning: ['plan', 'decompose', 'organize', 'roadmap', 'strategy', '规划', '计划', '分解'],
  writing: ['document', 'write', 'draft', 'report', 'readme', 'specification', '文档', '撰写', '报告', '方案'],
  devops: ['deploy', 'ci', 'cd', 'docker', 'kubernetes', 'infra', 'pipeline', '部署', '运维'],
};

/**
 * Compute a capability match score between task text and an agent's capabilities.
 * @param {string} taskText - Combined task title + brief
 * @param {string[]} capabilities - Agent's capability list (e.g. ['coding', 'testing'])
 * @returns {number} Score (higher = better match)
 */
export function computeCapabilityScore(taskText, capabilities) {
  if (!taskText || !capabilities || capabilities.length === 0) return 0;

  const text = taskText.toLowerCase();
  let score = 0;

  for (const cap of capabilities) {
    const capLower = cap.toLowerCase();
    // Direct capability name match in text
    if (text.includes(capLower)) {
      score += 3;
      continue;
    }
    // Keyword expansion match
    const keywords = CAPABILITY_KEYWORDS[capLower];
    if (keywords) {
      for (const kw of keywords) {
        if (text.includes(kw)) {
          score += 1;
        }
      }
    }
  }
  return score;
}

/**
 * Match a task to the best available agent.
 * @param {{ title: string, brief: string }} task
 * @param {{ id: string, capabilities: string[], maxConcurrentTasks: number }[]} agents
 * @param {Map<string, number>|Object} currentLoads - agentId → current in-progress task count
 * @returns {string} Best agent ID
 */
export function matchTaskToAgent(task, agents, currentLoads) {
  if (!agents || agents.length === 0) return null;
  if (agents.length === 1) return agents[0].id;

  const loads = currentLoads instanceof Map ? currentLoads : new Map(Object.entries(currentLoads || {}));
  const taskText = `${task.title || ''} ${task.brief || ''}`;

  // Filter out overloaded agents
  const available = agents.filter(a => {
    const max = a.maxConcurrentTasks || 5;
    const current = loads.get(a.id) || 0;
    return current < max;
  });

  // If all overloaded, use full list anyway (best effort)
  const candidates = available.length > 0 ? available : agents;

  // Score each candidate
  const scored = candidates.map(agent => ({
    agent,
    score: computeCapabilityScore(taskText, agent.capabilities || []),
    load: loads.get(agent.id) || 0,
  }));

  // Sort: highest score first, then lowest load
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.load - b.load;
  });

  return scored[0].agent.id;
}

/**
 * Assign tasks to agents using smart matching.
 * @param {Array} tasks - Array of { title, brief, assignedAgent? }
 * @param {Array} agents - Array of agent objects with capabilities
 * @param {Map|Object} currentLoads - agentId → current load
 * @returns {Array} Tasks with assignedAgent filled in
 */
export function assignTasksSmartly(tasks, agents, currentLoads) {
  const loads = currentLoads instanceof Map ? new Map(currentLoads) : new Map(Object.entries(currentLoads || {}));

  return tasks.map(task => {
    if (task.assignedAgent) return task; // Already assigned by decomposer

    const agentId = matchTaskToAgent(task, agents, loads);
    // Increment load for the assigned agent (for subsequent assignments)
    loads.set(agentId, (loads.get(agentId) || 0) + 1);
    return { ...task, assignedAgent: agentId };
  });
}

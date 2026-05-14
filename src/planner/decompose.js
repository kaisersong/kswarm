/**
 * Planner — Goal decomposition into tasks
 *
 * Takes a natural language goal + deliverable definition,
 * produces a task DAG that can be dispatched via broker.
 *
 * v0.1: Template-based decomposition
 * v0.3+: LLM-based intelligent decomposition
 */

import { randomUUID } from 'crypto';

/**
 * Decompose a goal into a task list with dependencies.
 *
 * @param {Object} params
 * @param {string} params.projectId
 * @param {string} params.goal
 * @param {import('../types.js').Deliverable} params.deliverable
 * @returns {import('../types.js').HubTask[]}
 */
export function decomposeGoal({ projectId, goal, deliverable }) {
  const tasks = [];
  const id = () => randomUUID().slice(0, 10);

  // Phase 1: Research (no deps)
  const research = {
    id: id(),
    projectId,
    title: 'Research & Analysis',
    brief: `Investigate the landscape for: "${goal}". Analyze market, users, competitors. Output findings document.`,
    requiredCapabilities: ['research', 'analysis'],
    dependencies: [],
    status: 'pending',
    assignedAgent: null,
    result: null,
    createdAt: Date.now(),
    completedAt: null,
  };
  tasks.push(research);

  // Phase 2: Requirements (depends on research)
  const requirements = {
    id: id(),
    projectId,
    title: 'Requirements & Specification',
    brief: `Define product requirements for: "${goal}". Write user stories, acceptance criteria, MVP scope. Deliverable: ${deliverable.description}`,
    requiredCapabilities: ['product', 'requirements'],
    dependencies: [research.id],
    status: 'pending',
    assignedAgent: null,
    result: null,
    createdAt: Date.now(),
    completedAt: null,
  };
  tasks.push(requirements);

  // Phase 3: Architecture (depends on requirements)
  const architecture = {
    id: id(),
    projectId,
    title: 'Technical Architecture',
    brief: `Design architecture for: "${goal}". Define components, APIs, data models, tech stack.`,
    requiredCapabilities: ['architecture', 'system-design'],
    dependencies: [requirements.id],
    status: 'pending',
    assignedAgent: null,
    result: null,
    createdAt: Date.now(),
    completedAt: null,
  };
  tasks.push(architecture);

  // Phase 4: Implementation (depends on architecture)
  const implementation = {
    id: id(),
    projectId,
    title: 'Implementation',
    brief: `Build: "${goal}". Follow architecture spec. Produce working code with tests.`,
    requiredCapabilities: ['engineering', 'coding'],
    dependencies: [architecture.id],
    status: 'pending',
    assignedAgent: null,
    result: null,
    createdAt: Date.now(),
    completedAt: null,
  };
  tasks.push(implementation);

  // Phase 5: QA (depends on implementation)
  const qa = {
    id: id(),
    projectId,
    title: 'Quality Assurance',
    brief: `Test and review: "${goal}". Verify acceptance criteria: ${deliverable.acceptanceCriteria.join('; ')}`,
    requiredCapabilities: ['testing', 'qa'],
    dependencies: [implementation.id],
    status: 'pending',
    assignedAgent: null,
    result: null,
    createdAt: Date.now(),
    completedAt: null,
  };
  tasks.push(qa);

  // Phase 6: Delivery (depends on QA)
  const delivery = {
    id: id(),
    projectId,
    title: 'Delivery',
    brief: `Ship: "${goal}". Deploy, verify deliverable: "${deliverable.description}". Expected artifacts: ${deliverable.expectedArtifacts.join(', ')}`,
    requiredCapabilities: ['devops', 'deployment'],
    dependencies: [qa.id],
    status: 'pending',
    assignedAgent: null,
    result: null,
    createdAt: Date.now(),
    completedAt: null,
  };
  tasks.push(delivery);

  return tasks;
}

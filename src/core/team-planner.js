import { createHash } from 'node:crypto';
import { getCapabilityCatalog, normalizeAgentCapabilities, validateCapabilityNeeds } from './capability-catalog.js';

export const TEAM_POLICY = Object.freeze({ maxTotalAgents: 6, maxNewAgents: 3 });

function activeAgent(agent) {
  if (!agent || agent.archivedAt) return false;
  if (agent.status === 'error') return false;
  if (agent.runtimeHealth?.state === 'offline' || agent.runtimeHealth?.state === 'error') return false;
  return true;
}

function agentSatisfies(agent, need, requiredRoles = ['worker']) {
  if (!activeAgent(agent)) return false;
  const roles = new Set(Array.isArray(agent.roles) ? agent.roles : []);
  if (!requiredRoles.every(role => roles.has(role))) return false;
  const capabilities = new Set(normalizeAgentCapabilities(agent));
  return need.requiredCapabilities.every(capability => capabilities.has(capability));
}

function stablePlanDigest(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function normalizeProjectMemberIds(project = {}) {
  return [...new Set([project.poAgent, ...(Array.isArray(project.members) ? project.members : [])]
    .filter(value => typeof value === 'string' && value.trim()))];
}

export function createProjectTeamPlan({ project, agents = [], needs, catalog = getCapabilityCatalog(), policy = TEAM_POLICY }) {
  if (!project?.id || !Number.isInteger(project.projectRevision)) return { ok: false, error: 'invalid_project_revision' };
  const validated = validateCapabilityNeeds(needs, catalog);
  if (!validated.ok) return validated;

  const allAgents = Array.isArray(agents) ? agents.filter(activeAgent) : [];
  const projectMemberIds = normalizeProjectMemberIds(project);
  const projectAgents = projectMemberIds.map(id => allAgents.find(agent => agent.id === id)).filter(Boolean);
  const reservedAgentIds = new Set();
  const roles = [];
  let creates = 0;

  for (const need of validated.needs) {
    const separationRequired = need.requiresIndependentReviewer || roles.some(role => role.requiresIndependentReviewer);
    const match = [...projectAgents, ...allAgents]
      .filter((agent, index, list) => list.findIndex(candidate => candidate.id === agent.id) === index)
      .find(agent => agentSatisfies(agent, need) && (!separationRequired || !reservedAgentIds.has(agent.id)));
    const decision = match ? 'reuse' : 'create';
    if (match) reservedAgentIds.add(match.id);
    if (!match) creates += 1;
    roles.push({
      roleKey: need.needKey,
      displayName: need.needKey,
      roles: ['worker'],
      requiredCapabilities: need.requiredCapabilities,
      responsibilities: need.responsibilities,
      requiresIndependentReviewer: need.requiresIndependentReviewer,
      preferredExistingAgentId: match?.id,
      decision,
      reasonCode: match
        ? (projectMemberIds.includes(match.id) ? 'project_member_capability_match' : 'existing_agent_capability_match')
        : 'capability_gap',
    });
  }

  const existingCount = projectMemberIds.length;
  if (creates > policy.maxNewAgents || existingCount + creates > policy.maxTotalAgents) {
    return { ok: false, error: 'needs_manual_scope' };
  }
  const digestInput = {
    projectId: project.id,
    projectRevision: project.projectRevision,
    catalogVersion: catalog.catalogVersion,
    roles: roles.map(({ preferredExistingAgentId, ...role }) => ({ ...role, preferredExistingAgentId: preferredExistingAgentId || null })),
  };
  return {
    ok: true,
    plan: {
      projectId: project.id,
      projectRevision: project.projectRevision,
      status: roles.every(role => role.decision === 'reuse') ? 'applied' : 'proposed',
      outcome: roles.every(role => role.decision === 'reuse') ? 'no_change' : 'proposal',
      catalogVersion: catalog.catalogVersion,
      roles,
      planDigest: stablePlanDigest(digestInput),
      generatedAt: Date.now(),
    },
  };
}

import { createHash } from 'node:crypto';
import { getCapabilityCatalog } from './capability-catalog.js';
import { createProjectTeamPlan } from './team-planner.js';

const SECRET_AGENT_FIELDS = ['apiKey', 'baseUrl', 'customEnv', 'runtimePath', 'execution'];

export function redactAgentForTransport(agent) {
  if (!agent || typeof agent !== 'object') return agent;
  const copy = { ...agent };
  for (const field of SECRET_AGENT_FIELDS) delete copy[field];
  return copy;
}

function normalizePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || /%2f|%5c/i.test(path)) return null;
  const pathname = path.split('?')[0].replace(/\/+$/, '') || '/';
  return pathname.includes('..') ? null : pathname;
}

export function createTeamApiContract() {
  const allowedReadPaths = [/^\/projects(?:\/[^/]+)?$/, /^\/agents$/, /^\/agents\/[^/]+$/];
  const allowedSemanticMutations = [/^\/projects\/[^/]+\/team\/(?:plan|reconcile)$/];
  return {
    normalizePath,
    allowProxy({ method, path, responseKind = 'json' }) {
      const normalized = normalizePath(path);
      if (!normalized) return false;
      if (method === 'GET') return responseKind === 'json' && allowedReadPaths.some(pattern => pattern.test(normalized));
      return responseKind === 'json' && allowedSemanticMutations.some(pattern => pattern.test(normalized));
    },
  };
}

export function createMutationAuthority({ token = '' } = {}) {
  const mutationPath = (method, path) => method !== 'GET' || /^\/agents\/[^/]+\/probe$/.test(path || '');
  return {
    authorize({ method, path, headers = {}, requestSource }) {
      const normalized = normalizePath(path);
      if (!normalized) return { ok: false, error: 'invalid_path' };
      if (!mutationPath(method, normalized)) return { ok: true, path: normalized };
      const provided = headers['x-kswarm-mutation-token'] || headers['X-KSwarm-Mutation-Token'];
      if (!token || provided !== token) return { ok: false, error: 'mutation_credential_required', status: 401 };
      if (requestSource !== 'user') return { ok: false, error: 'request_source_denied', status: 403 };
      return { ok: true, path: normalized };
    },
  };
}

function desiredAgentId(projectId, planDigest, roleKey) {
  const suffix = createHash('sha256').update(`${projectId}:${planDigest}:${roleKey}`).digest('hex').slice(0, 16);
  return `team-${suffix}`;
}

function matchingProvenance(agent, operationId, roleKey) {
  return agent?.provisioning?.operationId === operationId && agent.provisioning.roleKey === roleKey;
}

export function createTeamProvisioningHub({ hub, agentStore, operationStore, catalog = getCapabilityCatalog() }) {
  if (!hub || !agentStore || !operationStore) throw new Error('hub, agentStore, and operationStore are required');
  function plan({ projectId, expectedProjectRevision, catalogVersion, needs }) {
    const project = hub.getProject(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.projectRevision !== expectedProjectRevision) return { ok: false, error: 'stale_plan' };
    if (catalogVersion !== catalog.catalogVersion) return { ok: false, error: 'stale_catalog' };
    const result = createProjectTeamPlan({ project, agents: agentStore.list({ includeArchived: false }), needs, catalog });
    if (!result.ok) return result;
    hub.setProjectTeamPlan(projectId, result.plan);
    return result;
  }

  function reconcile({ projectId, planDigest, expectedProjectRevision, clientRequestKey, requestSource }) {
    if (requestSource !== 'user') return { ok: false, error: 'request_source_denied' };
    const existing = operationStore.findByClientRequest(projectId, clientRequestKey);
    if (existing) {
      if (existing.planDigest !== planDigest) return { ok: false, error: 'client_request_conflict' };
      return { ok: true, reused: true, operation: existing };
    }
    const project = hub.getProject(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.projectRevision !== expectedProjectRevision) return { ok: false, error: 'stale_plan' };
    const teamPlan = project.teamPlan;
    if (!teamPlan || teamPlan.planDigest !== planDigest || teamPlan.status === 'stale') return { ok: false, error: 'stale_plan' };
    if (teamPlan.catalogVersion !== catalog.catalogVersion) return { ok: false, error: 'stale_catalog' };
    const provisioningIntents = teamPlan.roles.filter(role => role.decision === 'create').map(role => ({
      intentId: desiredAgentId(projectId, planDigest, role.roleKey),
      desiredAgentId: desiredAgentId(projectId, planDigest, role.roleKey),
      roleKey: role.roleKey,
      status: 'pending',
    }));
    const created = operationStore.createOrReuse({
      projectId,
      planDigest,
      expectedProjectRevision,
      clientRequestKey,
      provisioningIntents,
      reusedAgentIds: teamPlan.roles.filter(role => role.decision === 'reuse').map(role => role.preferredExistingAgentId).filter(Boolean),
    });
    if (!created.ok || created.reused) return created;
    const operation = created.operation;
    const attachedAgentIds = [...operation.reusedAgentIds];
    for (const intent of operation.provisioningIntents) {
      const role = teamPlan.roles.find(candidate => candidate.roleKey === intent.roleKey);
      let agent = agentStore.get(intent.desiredAgentId);
      if (agent && !matchingProvenance(agent, operation.id, intent.roleKey)) {
        operationStore.update(operation.id, { status: 'failed', errorCode: 'agent_id_conflict' });
        return { ok: false, error: 'agent_id_conflict', operation: operationStore.get(operation.id) };
      }
      if (!agent) {
        const result = agentStore.create({
          id: intent.desiredAgentId,
          name: `Team ${role.displayName} ${intent.desiredAgentId.slice(-6)}`,
          description: `Managed team role: ${role.roleKey}`,
          instructions: role.responsibilities.join('\n'),
          runtimeType: 'xiaok',
          runtimeSource: 'desktop-agent-runtime',
          provider: null,
          model: null,
          baseUrl: null,
          apiKey: null,
          roles: role.roles,
          capabilities: role.requiredCapabilities,
          taskCapabilities: role.requiredCapabilities,
          provisioning: { operationId: operation.id, roleKey: intent.roleKey },
        });
        if (!result.ok) {
          operationStore.updateIntent(operation.id, intent.intentId, { status: 'failed' });
          operationStore.update(operation.id, { status: 'failed', errorCode: result.error || 'provisioning_failed' });
          return { ok: false, error: result.error || 'provisioning_failed', operation: operationStore.get(operation.id) };
        }
        agent = result.agent;
        operationStore.update(operation.id, { createdAgentIds: [...operation.createdAgentIds, agent.id] });
      }
      operationStore.updateIntent(operation.id, intent.intentId, { status: 'provisioned' });
      attachedAgentIds.push(agent.id);
      operationStore.updateIntent(operation.id, intent.intentId, { status: 'attached' });
    }
    const attach = hub.attachTeamOperationMembers(projectId, { operationId: operation.id, agentIds: [...new Set(attachedAgentIds)] });
    if (!attach?.ok) {
      operationStore.update(operation.id, { status: 'failed', errorCode: attach?.error || 'attach_failed' });
      return { ok: false, error: attach?.error || 'attach_failed', operation: operationStore.get(operation.id) };
    }
    const finalOperation = operationStore.update(operation.id, { status: 'applied', attachedAgentIds: [...new Set(attachedAgentIds)] });
    return { ok: true, operation: finalOperation, project: attach.project };
  }
  return { plan, reconcile };
}

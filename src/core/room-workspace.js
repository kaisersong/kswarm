import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export const ROOM_WORKSPACE_PROTOCOL = 'room_workspace_v1';

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new Error('workspace_payload_invalid');
}

export function workspaceDigest(kind, value) {
  return createHash('sha256').update(`xiaok.room-workspace.v1/${kind}\n${canonical(value)}`).digest('hex');
}

export function validateMappingPayload(project, request, ticket) {
  const p = request.payload;
  if (!p || workspaceDigest('mapping', p) !== request.payloadDigest) return {ok:false,error:'mapping_digest_mismatch'};
  if (!ticket || ticket.ticketId !== request.ticketId || ticket.operationId !== request.operationId
    || ticket.payloadDigest !== request.payloadDigest || !ticket.userPrincipal || !Number.isSafeInteger(ticket.roomSequence)) {
    return {ok:false,error:'mapping_ticket_mismatch'};
  }
  for (const field of ['projectId','roomId','workspaceId','originHostId','bindingId','generation','expectedProjectRevision']) {
    if (p[field] === undefined || ticket[field] !== p[field]) return {ok:false,error:'mapping_ticket_mismatch'};
  }
  if (p.projectId !== project.id || p.roomId !== project.primaryRoomId) return {ok:false,error:'mapping_project_scope_mismatch'};
  if (!Number.isSafeInteger(p.generation) || p.generation < 1) return {ok:false,error:'mapping_generation_invalid'};
  // main validates containment in the shared root; KSwarm independently validates
  // the applied work/artifact directories and never creates conventional folders.
  for (const field of ['workFolder','artifactsDir']) {
    if (!isAbsolute(p[field] || '') || !statSync(p[field]).isDirectory() || realpathSync(p[field]) !== p[field]) {
      return {ok:false,error:'mapping_directory_invalid'};
    }
  }
  const rel=relative(p.workFolder,p.artifactsDir);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return {ok:false,error:'mapping_artifacts_outside_workfolder'};
  return {ok:true};
}

export function validateWorkspaceClaim(project, response, taskId) {
  const m=project.workspaceMapping, c=response?.claim, config=response?.config;
  if (!m || m.state !== 'active' || !response?.ok || !c || !config) return {ok:false,error:'workspace_claim_invalid'};
  if ((c.executionState || c.status) !== 'running' || (c.authorizationState && c.authorizationState !== 'valid')) return {ok:false,error:'workspace_claim_not_running'};
  if (c.protocolVersion !== 1 || !c.claimId || !c.runId || c.projectId !== project.id
    || c.contextScope?.kind !== 'project' || c.contextScope.projectId !== project.id
    || (c.taskId && c.taskId !== taskId) || c.mappingRevision !== m.mappingRevision) return {ok:false,error:'workspace_claim_scope_mismatch'};
  for (const key of ['roomId','workspaceId','originHostId','bindingId','generation']) {
    if (c[key] !== m[key]) return {ok:false,error:'workspace_binding_mismatch'};
  }
  if (config.phase !== 'active' || config.activeBindingId !== c.bindingId || config.generation !== c.generation
    || config.workspaceId !== c.workspaceId || config.originHostId !== c.originHostId) return {ok:false,error:'workspace_mapping_required'};
  try {
    for (const key of ['workFolder','artifactsDir']) {
      if (realpathSync(m[key]) !== m[key] || !statSync(m[key]).isDirectory()) return {ok:false,error:'workspace_directory_unavailable'};
      const identity=m.directoryIdentities?.[key], current=statSync(m[key]);
      if (identity && (identity.dev !== current.dev || identity.ino !== current.ino)) return {ok:false,error:'workspace_directory_replaced'};
    }
  } catch { return {ok:false,error:'workspace_directory_unavailable'}; }
  return {ok:true,claim:c};
}

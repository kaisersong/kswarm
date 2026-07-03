import { randomBytes } from 'node:crypto';

const TRANSPORT_TO_REQUEST_CONTEXT = {
  desktop_ipc: {
    requestSource: 'user',
    actorKind: 'desktop_user',
  },
  agent_tool: {
    requestSource: 'agent',
    actorKind: 'agent_runtime',
  },
  scheduler_executor: {
    requestSource: 'scheduler',
    actorKind: 'timed_action_scheduler',
  },
  internal_reconciler: {
    requestSource: 'system_reconciler',
    actorKind: 'kswarm_internal',
  },
};

export function createMutationTokenRegistry({ now = Date.now, httpAdminEnabled = false } = {}) {
  const tokens = new Map();
  const nowFn = typeof now === 'function' ? now : () => now;

  function issue({ transport, issuedTo, tokenId, expiresAt } = {}) {
    if (!transport) throw new Error('transport_required');
    const token = `kswarm-mut-${randomBytes(24).toString('base64url')}`;
    const credential = {
      transport,
      tokenId: tokenId || `${transport}-${tokens.size + 1}`,
      issuedTo: issuedTo || transport,
      ...(expiresAt ? { expiresAt } : {}),
      issuedAt: new Date(nowFn()).toISOString(),
    };
    tokens.set(token, credential);
    return { token, credential };
  }

  function resolve(token) {
    const credential = tokens.get(String(token || ''));
    if (!credential) return { ok: false, error: 'unauthorized_transport' };
    if (credential.transport === 'http_admin' && httpAdminEnabled !== true) {
      return { ok: false, error: 'http_admin_disabled' };
    }
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= nowFn()) {
      return { ok: false, error: 'unauthorized_transport' };
    }
    return { ok: true, credential };
  }

  return {
    issue,
    resolve,
    size: () => tokens.size,
  };
}

export function resolveMutationRequestContext({
  registry,
  token,
  claimedRequestSource,
  sessionId,
  runtimeTaskId,
  timedActionRunId,
} = {}) {
  if (!registry || typeof registry.resolve !== 'function') {
    return { ok: false, error: 'mutation_token_registry_required' };
  }
  const resolved = registry.resolve(token);
  if (!resolved.ok) return resolved;

  const credential = resolved.credential;
  const base = TRANSPORT_TO_REQUEST_CONTEXT[credential.transport];
  if (!base) return { ok: false, error: 'unauthorized_transport' };
  const requestContext = {
    requestSource: base.requestSource,
    actorId: credential.issuedTo || credential.tokenId,
    actorKind: base.actorKind,
    transport: credential.transport,
    ...(sessionId ? { sessionId } : {}),
    ...(runtimeTaskId ? { runtimeTaskId } : {}),
    ...(timedActionRunId ? { timedActionRunId } : {}),
  };
  const claimMismatch = Boolean(claimedRequestSource && claimedRequestSource !== requestContext.requestSource);
  return {
    ok: true,
    requestContext,
    credential: {
      transport: credential.transport,
      tokenId: credential.tokenId,
      issuedTo: credential.issuedTo,
      ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    },
    audit: {
      claimMismatch,
      ...(claimMismatch ? { claimedRequestSource, actualRequestSource: requestContext.requestSource } : {}),
    },
  };
}

export function sanitizeRequestContext(value) {
  if (!value || typeof value !== 'object') return null;
  const requestSource = value.requestSource;
  if (!['user', 'agent', 'scheduler', 'system_reconciler'].includes(requestSource)) return null;
  return {
    requestSource,
    actorId: String(value.actorId || requestSource),
    actorKind: value.actorKind || requestSource,
    transport: value.transport || requestSource,
    ...(value.sessionId ? { sessionId: String(value.sessionId) } : {}),
    ...(value.runtimeTaskId ? { runtimeTaskId: String(value.runtimeTaskId) } : {}),
    ...(value.timedActionRunId ? { timedActionRunId: String(value.timedActionRunId) } : {}),
  };
}

import {createOriginalPreparationBrokerClient} from '../core/original-preparation-transport.js';
/**
 * Broker Client — 连接 intent-broker 的通用 WebSocket + HTTP 客户端
 *
 * 所有参与者（Hub / PO / Worker）都用这个客户端连接 broker。
 * 各自的身份由 participantId 和 kind 区分。
 */

import WebSocket from 'ws';

const DEFAULT_BROKER = 'http://127.0.0.1:4318';

export function createBrokerClient({
  brokerUrl = DEFAULT_BROKER,
  participantId,
  kind = 'agent',
  alias = null,
  roles = [],
  capabilities = [],
  projectName = null,
  onIntent = null,
  onConnect = null,
  onDisconnect = null,
  silent = false,
  roomSystemToken = process.env.INTENT_BROKER_KSWARM_TOKEN || null,
  fetchImpl = fetch,
  preparationSource = null,
} = {}) {
  let actualClient;
  let ws = null;
  let connected = false;
  let reconnectTimer = null;
  let sealed = false;
  let reconnectAllowed = true;
  let closing = null;
  const lifetime = new AbortController();
  const closedError = Object.assign(Error('broker_client_closed'), { code: 'broker_client_closed' });
  const pending = new Set();
  const sockets = new Map();
  const closeErrors = new Set();
  function assertOpen() { if (sealed) throw closedError; lifetime.signal.throwIfAborted(); }
  function run(fn, args) {
    if (sealed) return Promise.reject(closedError);
    // Register before destructuring, toJSON or any other user-code reentry.
    let resolve, reject;
    const work = new Promise((done, failed) => { resolve = done; reject = failed; });
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    try { resolve(fn(...args)); } catch (error) { reject(error); }
    return work;
  }
  function notify(callback, ...args) {
    try { const value = callback?.(...args); if (value && typeof value.then === 'function') void Promise.resolve(value).catch(error => log('callback failed', error)); }
    catch (error) { log('callback failed', error); }
  }
  function stopSocket(record) {
    if (record.stopping) return;
    record.stopping = true;
    record.resolveHandshake(false);
    const socket = record.socket;
    try {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.close();
    } catch (error) { closeErrors.add(error); }
    if (sockets.has(socket)) {
      record.timer = setTimeout(() => {
        record.timer = null;
        if (sockets.has(socket)) { try { socket.terminate(); } catch (error) { closeErrors.add(error); } }
      }, 1000);
      record.timer.unref?.();
    }
  }

  const httpBase = brokerUrl.replace(/\/$/, '');
  const wsUrl = `${httpBase.replace('http', 'ws')}/ws?participantId=${encodeURIComponent(participantId)}`;

  function log(...args) {
    if (!silent) { try { console.log(`[${alias || participantId}]`, ...args); } catch { /* diagnostics cannot interrupt drain */ } }
  }

  // ─── HTTP helpers ────────────────────────────────────────────────

  async function httpPost(path, body) {
    const url = `${httpBase}${path}`, init = {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: lifetime.signal,
    };
    assertOpen();
    const resp = await fetchImpl(url, init);
    return resp.json();
  }

  async function httpGet(path) {
    const url = `${httpBase}${path}`; assertOpen();
    const resp = await fetchImpl(url, { signal: lifetime.signal });
    return resp.json();
  }

  async function roomRequest(path, { method = 'GET', body } = {}) {
    if (!roomSystemToken) return { ok: false, code: 'room_authentication_required' };
    const url = `${httpBase}${path}`, init = {
      method,
      signal: lifetime.signal,
      headers: {
        'x-intent-broker-room-token': roomSystemToken,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    assertOpen();
    const resp = await fetchImpl(url, init);
    return resp.json();
  }

  // ─── Registration ────────────────────────────────────────────────

  async function register() {
    const result = await httpPost('/participants/register', {
      participantId,
      kind,
      alias: alias || participantId,
      roles,
      capabilities,
      inboxMode: 'realtime',
      context: projectName ? { projectName } : {},
    });
    log('registered as', result.alias || alias);
    return result;
  }

  // ─── WebSocket ───────────────────────────────────────────────────

  function connect() {
    assertOpen();
    reconnectAllowed = true;
    const existing = sockets.get(ws);
    if (existing && !existing.stopping && ws.readyState <= WebSocket.OPEN) return existing.handshake;
    let resolveHandshake, resolveClosed;
    const handshake = new Promise(resolve => { resolveHandshake = resolve; });
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    assertOpen();
    const socket = new WebSocket(wsUrl);
    const record = { socket, handshake, closed, resolveHandshake, stopping: false, timer: null };
    sockets.set(socket, record);
    ws = socket;
    connected = false;
    const current = () => ws === socket && !sealed && reconnectAllowed && !record.stopping;
    socket.on('open', () => {
      if (!current()) { resolveHandshake(false); stopSocket(record); return; }
      connected = true;
      log('WebSocket connected');
      notify(onConnect);
      resolveHandshake(current());
    });
    socket.on('message', data => {
      if (!current()) return;
      try { const msg = JSON.parse(data.toString()); if (msg.type === 'new_intent') notify(onIntent, msg.event); }
      catch { /* ignore malformed */ }
    });
    socket.on('error', () => { if (socket.readyState !== WebSocket.OPEN) resolveHandshake(false); });
    socket.once('close', () => {
      clearTimeout(record.timer);
      sockets.delete(socket);
      resolveHandshake(false);
      resolveClosed();
      if (ws !== socket) return;
      connected = false;
      log('WebSocket disconnected');
      if (!current()) return;
      notify(onDisconnect);
      // A notification can synchronously close/disconnect the same instance.
      if (!current()) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!sealed && reconnectAllowed) void run(connect, []).catch(error => log('reconnect failed', error));
      }, 2000);
    });
    return handshake;
  }

  function disconnect() {
    reconnectAllowed = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connected = false;
    for (const record of sockets.values()) stopSocket(record);
  }

  function close() {
    if (closing) return closing;
    sealed = true;
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...pending]);
      await Promise.all([...sockets.values()].map(record => record.closed));
      if (closeErrors.size) throw new AggregateError([...closeErrors], 'broker_client_close_unconfirmed');
    });
    void closing.catch(() => {});
    lifetime.abort(closedError);
    disconnect();
    return closing;
  }

  // ─── Send Intent ─────────────────────────────────────────────────

  async function sendIntent({ kind: intentKind, taskId = null, threadId = null, to = null, payload = {} }) {
    const body = {
      intentId: `${participantId}-${intentKind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: intentKind,
      opaque: true,
      fromParticipantId: participantId,
      taskId,
      threadId,
      to: to || { mode: 'broadcast' },
      payload,
    };
    return httpPost('/intents', body);
  }

  // ─── Convenience: send to specific participant ───────────────────

  async function sendTo(targetId, intentKind, { taskId, threadId, payload } = {}) {
    return sendIntent({
      kind: intentKind,
      taskId: taskId || null,
      threadId: threadId || null,
      to: { mode: 'participant', participants: [targetId] },
      payload: payload || {},
    });
  }

  // ─── Inbox ───────────────────────────────────────────────────────

  async function readInbox({ after = 0, limit = 50 } = {}) {
    return httpGet(`/inbox/${participantId}?after=${after}&limit=${limit}`);
  }

  async function getRoomSnapshot(roomId) {
    return roomRequest(`/rooms/${encodeURIComponent(roomId)}`);
  }

  async function acquireRoomMembershipLease(input) {
    return roomRequest(`/rooms/${encodeURIComponent(input.roomId)}/membership-leases`, {
      method: 'POST',
      body: input,
    });
  }

  async function publishRoomProjectEvent(input) {
    return roomRequest(`/rooms/${encodeURIComponent(input.roomId)}/project-events`, {
      method: 'POST',
      body: input,
    });
  }

  function workspaceRequest(action, input) {
    return roomRequest(`/rooms/${encodeURIComponent(input.roomId)}/workspace/${action}`, {method:'POST',body:input});
  }

  const lifetimeMethods = {
    register,
    connect,
    disconnect,
    close,
    sendIntent,
    sendTo,
    readInbox,
    getRoomSnapshot,
    acquireRoomMembershipLease,
    publishRoomProjectEvent,
    verifyWorkspaceMappingTicket: input => workspaceRequest('verify-mapping-ticket',input),
    verifyWorkspaceClaim: input => workspaceRequest('verify-claim',input),
    verifyWorkspaceCommitTicket: input => workspaceRequest('verify-commit-ticket',input),
    workspaceMappingApplied: input => workspaceRequest('mapping-applied',input),
    workspaceMappingRejected: input => workspaceRequest('mapping-rejected',input),
    httpPost,
    httpGet,
    isConnected: () => !sealed && connected,
    getParticipantId: () => participantId,
  };
  for (const key of Object.keys(lifetimeMethods)) {
    if (['disconnect', 'close', 'isConnected', 'getParticipantId'].includes(key)) continue;
    const original = lifetimeMethods[key];
    lifetimeMethods[key] = (...args) => run(original, args);
  }
  actualClient=createOriginalPreparationBrokerClient({preparationSource,fetchSdk:fetchImpl,httpBase,participantId,methods:lifetimeMethods});
  return actualClient;
}

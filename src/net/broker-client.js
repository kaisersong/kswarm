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
} = {}) {
  let ws = null;
  let connected = false;
  let reconnectTimer = null;

  const httpBase = brokerUrl.replace(/\/$/, '');
  const wsUrl = `${httpBase.replace('http', 'ws')}/ws?participantId=${encodeURIComponent(participantId)}`;

  function log(...args) {
    if (!silent) console.log(`[${alias || participantId}]`, ...args);
  }

  // ─── HTTP helpers ────────────────────────────────────────────────

  async function httpPost(path, body) {
    const resp = await fetch(`${httpBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.json();
  }

  async function httpGet(path) {
    const resp = await fetch(`${httpBase}${path}`);
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
    return new Promise((resolve) => {
      ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        connected = true;
        log('WebSocket connected');
        onConnect?.();
        resolve(true);
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'connected') {
            // Initial connection ack
            return;
          }
          if (msg.type === 'new_intent') {
            onIntent?.(msg.event);
          }
        } catch (e) {
          // ignore malformed
        }
      });

      ws.on('close', () => {
        connected = false;
        log('WebSocket disconnected');
        onDisconnect?.();
        // Auto-reconnect
        reconnectTimer = setTimeout(connect, 2000);
      });

      ws.on('error', (err) => {
        if (!connected) resolve(false);
      });
    });
  }

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
    connected = false;
  }

  // ─── Send Intent ─────────────────────────────────────────────────

  async function sendIntent({ kind: intentKind, taskId = null, threadId = null, to = null, payload = {} }) {
    const body = {
      intentId: `${participantId}-${intentKind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: intentKind,
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

  return {
    register,
    connect,
    disconnect,
    sendIntent,
    sendTo,
    readInbox,
    httpPost,
    httpGet,
    isConnected: () => connected,
    getParticipantId: () => participantId,
  };
}

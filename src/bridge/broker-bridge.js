/**
 * Broker Bridge — Connects Hub to Intent Broker
 *
 * Responsibilities:
 * - WebSocket connection to broker
 * - Send intents (request_task, cancel_task, etc.)
 * - Receive events (accept_task, report_progress, submit_result)
 * - Map broker events to Hub actions
 *
 * This is the ONLY module that talks to intent-broker directly.
 */

import WebSocket from 'ws';

const DEFAULT_BROKER_URL = 'ws://127.0.0.1:4318/ws';

export function createBrokerBridge({ brokerUrl = DEFAULT_BROKER_URL, hubParticipantId = 'swarm-hub' } = {}) {
  let ws = null;
  let connected = false;
  const handlers = new Map(); // kind -> handler[]
  let reconnectTimer = null;

  function connect() {
    ws = new WebSocket(brokerUrl);

    ws.on('open', () => {
      connected = true;
      console.log(`[bridge] Connected to broker at ${brokerUrl}`);
      // Register as participant
      send({
        type: 'register',
        participantId: hubParticipantId,
        alias: '@hub',
        kind: 'coordinator',
        projectName: '*' // Hub monitors all projects
      });
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        dispatch(event);
      } catch (e) {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      connected = false;
      console.log('[bridge] Disconnected from broker, reconnecting...');
      reconnectTimer = setTimeout(connect, 3000);
    });

    ws.on('error', (err) => {
      // Will trigger close → reconnect
    });
  }

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
    connected = false;
  }

  function send(message) {
    if (ws && connected) {
      ws.send(JSON.stringify(message));
    }
  }

  function dispatch(event) {
    const kind = event.kind || event.type;
    const kindHandlers = handlers.get(kind) || [];
    for (const handler of kindHandlers) {
      handler(event);
    }
    // Wildcard handlers
    const allHandlers = handlers.get('*') || [];
    for (const handler of allHandlers) {
      handler(event);
    }
  }

  function on(kind, handler) {
    if (!handlers.has(kind)) handlers.set(kind, []);
    handlers.get(kind).push(handler);
  }

  // ─── Intent senders (Hub → Broker) ──────────────────────────────────

  function requestTask({ taskId, title, brief, targetAlias, targetParticipantId, projectName }) {
    send({
      type: 'intent',
      kind: 'request_task',
      taskId,
      fromParticipantId: hubParticipantId,
      toParticipantId: targetParticipantId || null,
      payload: {
        title,
        brief,
        targetAlias,
        projectName,
        assignmentMode: targetParticipantId ? 'direct' : 'broadcast'
      }
    });
  }

  function requestApproval({ taskId, title, summary, options, threadId }) {
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    send({
      type: 'intent',
      kind: 'request_approval',
      taskId,
      threadId,
      fromParticipantId: hubParticipantId,
      payload: {
        approvalId,
        summary: title,
        body: { summary, detailText: summary },
        actions: options || ['approve', 'reject']
      }
    });
    return approvalId;
  }

  function cancelTask({ taskId, reason }) {
    send({
      type: 'intent',
      kind: 'cancel_task',
      taskId,
      fromParticipantId: hubParticipantId,
      payload: { reason }
    });
  }

  return {
    connect,
    disconnect,
    on,
    send,
    requestTask,
    requestApproval,
    cancelTask,
    isConnected: () => connected,
  };
}

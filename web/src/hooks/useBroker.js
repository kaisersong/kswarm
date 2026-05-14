/**
 * Broker Hook — 连接 intent-broker 的 WebSocket + HTTP
 *
 * 提供:
 * - 实时事件流 (WebSocket)
 * - HTTP API 调用 (participants, intents, inbox)
 * - 连接状态
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const BROKER_HTTP = '/api';
const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const BROKER_WS = `${wsProto}//${window.location.host}/ws`;

function normalizeEvent(ev) {
  return { ...ev, timestamp: ev.timestamp || ev.createdAt };
}

export function useBroker(participantId = 'kswarm-web') {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState([]);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  // WebSocket connection with proper reconnect
  useEffect(() => {
    let closed = false;

    function connect() {
      const url = `${BROKER_WS}?participantId=${participantId}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          reconnectTimer.current = setTimeout(connect, 3000);
        }
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'new_intent') {
            setEvents(prev => [normalizeEvent(msg.event), ...prev].slice(0, 200));
          }
        } catch {}
      };
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [participantId]);

  // HTTP helpers
  const httpGet = useCallback(async (path) => {
    const resp = await fetch(`${BROKER_HTTP}${path}`);
    return resp.json();
  }, []);

  const httpPost = useCallback(async (path, body) => {
    const resp = await fetch(`${BROKER_HTTP}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.json();
  }, []);

  // Register as web viewer with approver role
  useEffect(() => {
    httpPost('/participants/register', {
      participantId,
      kind: 'human',
      alias: 'web-viewer',
      roles: ['viewer', 'approver'],
      capabilities: [],
      context: { projectName: 'kswarm' },
    }).catch(() => {});
  }, [participantId, httpPost]);

  // Fetch recent events on mount
  useEffect(() => {
    httpGet('/events/replay?limit=10000').then(data => {
      if (data?.items) {
        // Filter to only task-relevant events and take latest 200
        const relevant = data.items
          .filter(e => e.kind !== 'participant_presence_updated' && e.kind !== 'participant_alias_updated')
          .map(normalizeEvent);
        setEvents(relevant.slice(-200).reverse());
      }
    }).catch(() => {});
  }, [httpGet]);

  return { connected, events, httpGet, httpPost };
}

/**
 * Fetch participants list
 */
export async function fetchParticipants() {
  const resp = await fetch(`${BROKER_HTTP}/participants`);
  const data = await resp.json();
  return data.participants || [];
}

/**
 * Fetch health
 */
export async function fetchHealth() {
  const resp = await fetch(`${BROKER_HTTP}/health`);
  return resp.json();
}

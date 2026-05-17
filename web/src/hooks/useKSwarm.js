/**
 * useKSwarm — React hook for connecting to the KSwarm API Server.
 *
 * Unified version: merges xiaok's feature set (taskFailed, heartbeat, liveness,
 * runtimes, model catalog) into the standalone kswarm web app.
 *
 * Role model:
 * - Human: create projects, approve, add tasks, close
 * - PO Agent: plan, dispatch, confirm
 * - Worker Agent: execute, submit artifacts
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = '/api';
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_DELAY = 60000;
const PARTICIPANT_POLL_INTERVAL = 8000;

export function useKSwarm() {
  const [connected, setConnected] = useState(false);
  const [brokerConnected, setBrokerConnected] = useState(false);
  const [projects, setProjects] = useState([]);
  const [agents, setAgents] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [logs, setLogs] = useState([]);
  const [lastTaskEvent, setLastTaskEvent] = useState(null);

  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  const connectedRef = useRef(false);
  const pollTimer = useRef(null);

  // ─── WebSocket ──────────────────────────────────────────────────

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        connectedRef.current = true;
        reconnectAttempts.current = 0;
        fetchProjects();
        fetchAgents();
        fetchParticipants();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleWsMessage(msg);
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        connectedRef.current = false;
        wsRef.current = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      scheduleReconnect();
    }
  }, []);

  function scheduleReconnect() {
    if (reconnectTimer.current) return;
    const delay = Math.min(RECONNECT_DELAY * Math.pow(2, reconnectAttempts.current), MAX_RECONNECT_DELAY);
    reconnectAttempts.current++;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      connect();
    }, delay);
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'init':
        setProjects(msg.projects || []);
        setAgents(msg.agents || []);
        setBrokerConnected(msg.brokerConnected);
        setLogs(msg.logs || []);
        break;
      case 'broker_status':
        setBrokerConnected(msg.connected);
        break;
      case 'project_created':
        setProjects(prev => [...prev, msg.project]);
        break;
      case 'project_approved':
        setProjects(prev => prev.map(p => p.id === msg.projectId ? { ...p, status: 'active' } : p));
        break;
      case 'project_closed':
        setProjects(prev => prev.map(p => p.id === msg.projectId ? { ...p, status: 'closed' } : p));
        break;
      case 'tasks_created':
      case 'tasks_dispatched':
      case 'task_update':
      case 'task_done':
      case 'task_failed':
      case 'task_retry':
      case 'project_deliverable':
        fetchProjects();
        setLastTaskEvent({ type: msg.type, projectId: msg.projectId, taskId: msg.taskId, ts: Date.now() });
        break;
      case 'task_intent_error':
        setLogs(prev => [...prev, {
          ts: new Date().toISOString(),
          level: 'warn',
          msg: `Task intent error: ${msg.kind || 'unknown'}`,
          data: {
            projectId: msg.projectId,
            taskId: msg.taskId,
            worker: msg.worker,
            error: msg.error,
            matches: msg.matches || [],
          },
        }].slice(-200));
        setLastTaskEvent({ type: msg.type, projectId: msg.projectId, taskId: msg.taskId, ts: Date.now() });
        break;
      case 'agents_offline':
        setAgents(prev => prev.map(a =>
          msg.agentIds?.includes(a.id) ? { ...a, status: 'offline' } : a
        ));
        break;
      // Agent events
      case 'agent_created':
        setAgents(prev => [...prev, msg.agent]);
        break;
      case 'agent_updated':
        setAgents(prev => prev.map(a => a.id === msg.agent.id ? msg.agent : a));
        break;
      case 'agent_archived':
        setAgents(prev => prev.filter(a => a.id !== msg.agentId));
        break;
      case 'agent_restored':
        setAgents(prev => [...prev, msg.agent]);
        break;
      case 'agent_started':
        setAgents(prev => prev.map(a => a.id === msg.agentId ? { ...a, status: 'idle', runtimeId: msg.runtimeId } : a));
        break;
      case 'agent_stopped':
        setAgents(prev => prev.map(a => a.id === msg.agentId ? { ...a, status: 'offline', runtimeId: null } : a));
        break;
      case 'log':
        setLogs(prev => [...prev, msg].slice(-200));
        break;
    }
  }

  useEffect(() => {
    connect();
    pollTimer.current = setInterval(() => {
      if (connectedRef.current) fetchParticipants();
    }, PARTICIPANT_POLL_INTERVAL);

    return () => {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    };
  }, [connect]);

  // ─── HTTP helpers ───────────────────────────────────────────────

  async function httpGet(path) {
    try {
      const resp = await fetch(`${API_BASE}${path}`);
      if (!resp.ok) return null;
      return resp.json();
    } catch {
      return null;
    }
  }

  async function httpPost(path, body) {
    try {
      const resp = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!resp.ok) return null;
      return resp.json();
    } catch {
      return null;
    }
  }

  async function httpPut(path, body) {
    try {
      const resp = await fetch(`${API_BASE}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!resp.ok) return null;
      return resp.json();
    } catch {
      return null;
    }
  }

  async function httpDelete(path) {
    try {
      const resp = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
      return resp.ok;
    } catch {
      return false;
    }
  }

  // ─── Project Actions ──────────────────────────────────────────

  const fetchProjects = useCallback(async () => {
    const data = await httpGet('/projects');
    if (data?.projects) setProjects(data.projects);
    return data?.projects || [];
  }, []);

  const getProjectDetail = useCallback(async (projectId) => {
    return httpGet(`/projects/${projectId}`);
  }, []);

  const getProjectFullDetail = useCallback(async (projectId) => {
    return httpGet(`/projects/${projectId}`);
  }, []);

  const createProject = useCallback(async (input) => {
    const result = await httpPost('/projects', input);
    if (result) fetchProjects();
    return result;
  }, [fetchProjects]);

  const approveProject = useCallback(async (projectId) => {
    const result = await httpPost(`/projects/${projectId}/approve`, {});
    if (result?.ok) fetchProjects();
    return !!result?.ok;
  }, [fetchProjects]);

  const retryPlan = useCallback(async (projectId) => {
    return httpPost(`/projects/${projectId}/retry-plan`, {});
  }, []);

  const closeProject = useCallback(async (projectId, summary) => {
    const result = await httpPost(`/projects/${projectId}/close`, { summary: summary || '' });
    if (result?.ok) fetchProjects();
    return !!result?.ok;
  }, [fetchProjects]);

  const deliverProject = useCallback(async (projectId, fromAgent, deliverable) => {
    const result = await httpPost(`/projects/${projectId}/deliver`, {
      fromAgent,
      deliverable: deliverable || { summary: 'Project deliverable submitted' },
    });
    if (result?.ok) fetchProjects();
    return !!result?.ok;
  }, [fetchProjects]);

  const humanAddTasks = useCallback(async (projectId, tasks) => {
    const result = await httpPost(`/projects/${projectId}/tasks/human`, { tasks });
    return !!result?.ok;
  }, []);

  const createTasks = useCallback(async (projectId, tasks, fromAgent) => {
    const result = await httpPost(`/projects/${projectId}/tasks`, { tasks, fromAgent });
    return !!result?.ok;
  }, []);

  const dispatchTasks = useCallback(async (projectId, fromAgent) => {
    return httpPost(`/projects/${projectId}/dispatch`, { fromAgent });
  }, []);

  const markTaskDone = useCallback(async (projectId, taskId, fromAgent) => {
    const res = await httpPost(`/projects/${projectId}/tasks/${taskId}/done`, { fromAgent });
    return !!res?.ok;
  }, []);

  const cancelTask = useCallback(async (projectId, taskId) => {
    const res = await httpPost(`/projects/${projectId}/tasks/${taskId}/cancel`, {});
    return !!res?.ok;
  }, []);

  const taskFailed = useCallback(async (projectId, taskId, failureReason, errorMessage) => {
    return httpPost(`/projects/${projectId}/tasks/${taskId}/fail`, { failureReason, errorMessage });
  }, []);

  // ─── Agent Actions ────────────────────────────────────────────

  const fetchAgents = useCallback(async () => {
    const data = await httpGet('/agents');
    if (data?.agents) setAgents(data.agents);
    return data?.agents || [];
  }, []);

  const fetchParticipants = useCallback(async () => {
    const data = await httpGet('/participants');
    if (data?.participants) setParticipants(data.participants);
    return data?.participants || [];
  }, []);

  const createAgent = useCallback(async (input) => {
    const result = await httpPost('/agents', input);
    if (result) fetchAgents();
    return result;
  }, [fetchAgents]);

  const updateAgent = useCallback(async (agentId, patch) => {
    const result = await httpPut(`/agents/${agentId}`, patch);
    if (result) fetchAgents();
    return result;
  }, [fetchAgents]);

  const archiveAgent = useCallback(async (agentId) => {
    const ok = await httpDelete(`/agents/${agentId}`);
    if (ok) fetchAgents();
    return ok;
  }, [fetchAgents]);

  const startAgent = useCallback(async (agentId) => {
    const result = await httpPost(`/agents/${agentId}/start`, {});
    if (result?.ok) fetchAgents();
    return !!result?.ok;
  }, [fetchAgents]);

  const stopAgent = useCallback(async (agentId) => {
    const result = await httpPost(`/agents/${agentId}/stop`, {});
    if (result?.ok) fetchAgents();
    return !!result?.ok;
  }, [fetchAgents]);

  const probeAgent = useCallback(async (agentId) => {
    return httpGet(`/agents/${agentId}/probe`);
  }, []);

  // ─── Heartbeat / Liveness ─────────────────────────────────────

  const fetchLiveness = useCallback(async () => {
    const data = await httpGet('/agents/liveness');
    return data?.liveness || {};
  }, []);

  const pingHeartbeat = useCallback(async (agentId) => {
    const res = await httpPost('/agents/heartbeat', { agentId });
    return !!res?.ok;
  }, []);

  // ─── Runtime / Provider Discovery ─────────────────────────────

  const fetchRuntimes = useCallback(async () => {
    const data = await httpGet('/runtimes');
    return data?.runtimes || [];
  }, []);

  const fetchLlmProviders = useCallback(async () => {
    const data = await httpGet('/llm/providers');
    return data?.providers || [];
  }, []);

  // ─── Legacy ───────────────────────────────────────────────────

  const getHumanActions = useCallback(async (projectId) => {
    return httpGet(projectId ? `/human/actions?projectId=${projectId}` : '/human/actions');
  }, []);

  const fetchLogs = useCallback(async (limit = 200) => {
    const data = await httpGet(`/logs?limit=${limit}`);
    if (data?.logs) setLogs(data.logs);
    return data?.logs || [];
  }, []);

  // ─── Return ───────────────────────────────────────────────────

  return {
    // State
    connected,
    brokerConnected,
    projects,
    agents,
    participants,
    logs,
    lastTaskEvent,
    // Project
    fetchProjects,
    getProjectDetail,
    getProjectFullDetail,
    createProject,
    approveProject,
    retryPlan,
    closeProject,
    deliverProject,
    humanAddTasks,
    createTasks,
    dispatchTasks,
    markTaskDone,
    cancelTask,
    taskFailed,
    // Agent
    fetchAgents,
    fetchParticipants,
    createAgent,
    updateAgent,
    archiveAgent,
    startAgent,
    stopAgent,
    probeAgent,
    // Heartbeat / Liveness
    fetchLiveness,
    pingHeartbeat,
    // Runtime / Provider
    fetchRuntimes,
    fetchLlmProviders,
    // Legacy
    getHumanActions,
    fetchLogs,
  };
}

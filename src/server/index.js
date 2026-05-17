/**
 * KSwarm API Server
 *
 * 对外暴露 Hub 的能力为 REST API，同时提供 WebSocket 事件推送。
 * 端口: 4400（避免与 intent-broker 4318 冲突）
 *
 * 角色模型：
 * - Human（通过 Web UI）: 创建项目、审批、添加任务、关闭项目
 * - PO Agent: 规划任务、派发任务、确认完成
 * - Worker Agent: 执行任务、提交结果（含 artifact 文件）
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createHub } from '../core/hub.js';
import { createAgentStore } from '../core/agent-store.js';
import { createBrokerClient } from '../net/broker-client.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { listProviders } from '../llm/index.js';
import * as modelCatalog from '../llm/model-catalog.js';
import { createHeartbeatManager } from '../core/heartbeat-manager.js';
import { aggregateDelivery } from '../core/delivery.js';
import { createWatchdog } from '../core/watchdog.js';
import { parseTaskId } from '../core/task-identity.js';
import { planProjectRecovery } from '../core/recovery-planner.js';
import { readRunJournals } from '../core/recovery-store.js';
import { executeRecoveryAction } from '../core/recovery-executor.js';
import {
  initProjectWorkspace as initProjectWorkspaceRecord,
  setProjectWorkspace as setProjectWorkspaceRecord,
} from './project-workspace.js';

const PORT = Number(process.env.KSWARM_PORT || 4400);
const BROKER_URL = process.env.BROKER_URL || 'http://127.0.0.1:4318';

// Project workspace base — each project gets its own folder
const KSWARM_HOME = join(homedir(), '.kswarm');
const PROJECTS_DIR = join(KSWARM_HOME, 'projects');
mkdirSync(PROJECTS_DIR, { recursive: true });

// ─── Hub Instance ─────────────────────────────────────────────────
const hub = createHub({ eventLogDir: null, silent: false, dataDir: join(KSWARM_HOME, 'state.json') });

// ─── Agent Store ──────────────────────────────────────────────────
const agentStore = createAgentStore();
const heartbeatManager = createHeartbeatManager(hub);
heartbeatManager.start();
// On server start, all old worker processes are dead — reset to offline
const resetCount = agentStore.resetAllOffline();
if (resetCount > 0) console.log(`[KSwarm] Reset ${resetCount} stale agent(s) to offline`);

// ─── Project Workspace Management ─────────────────────────────────
// Each project gets: workFolder/artifacts/ for outputs
// User can set custom path, otherwise auto-created under ~/.kswarm/projects/<id>/
const projectWorkspaces = new Map(); // projectId → { path, artifacts, custom }

function initProjectWorkspace(projectId, customPath) {
  return initProjectWorkspaceRecord(projectWorkspaces, PROJECTS_DIR, projectId, customPath);
}

function getProjectWorkspace(projectId) {
  if (!projectWorkspaces.has(projectId)) {
    return initProjectWorkspace(projectId);
  }
  return projectWorkspaces.get(projectId);
}

function setProjectWorkspace(projectId, newPath) {
  return setProjectWorkspaceRecord(projectWorkspaces, projectId, newPath);
}

function listProjectArtifacts(projectId) {
  const ws = getProjectWorkspace(projectId);
  if (!existsSync(ws.artifacts)) return [];
  return readdirSync(ws.artifacts).map(f => {
    const ext = extname(f);
    return {
      filename: f,
      url: `/projects/${projectId}/artifacts/${f}`,
      previewable: getPreviewable(ext),
      mimeType: MIME_TYPES[ext] || 'application/octet-stream',
    };
  });
}

// ─── System Logs ──────────────────────────────────────────────────
const systemLogs = [];
const MAX_LOGS = 500;

function log(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, data };
  systemLogs.push(entry);
  if (systemLogs.length > MAX_LOGS) systemLogs.shift();
  broadcast({ type: 'log', ...entry });
  if (level === 'error') console.error(`[KSwarm] ${msg}`, data);
  else console.log(`[KSwarm] ${msg}`, JSON.stringify(data).slice(0, 200));
}

// ─── WebSocket Broadcast ──────────────────────────────────────────
const wsClients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// ─── Broker Connection ────────────────────────────────────────────
let brokerConnected = false;
let brokerClient = null;
let recoveryRunning = false;
let watchdogStarted = false;
let watchdog = null;

async function sendBrokerRequestTasks(projectId, taskIds = []) {
  if (!brokerClient || !brokerClient.isConnected() || taskIds.length === 0) return;

  const project = hub.getProject(projectId);
  const board = hub.getBoard(projectId);
  const ws = getProjectWorkspace(projectId);

  for (const taskId of taskIds) {
    const task = board?.getTask(taskId);
    if (!task?.assignedAgent) continue;
    try {
      await brokerClient.sendTo(task.assignedAgent, 'request_task', {
        taskId: task.id,
        threadId: `thread-${task.id}`,
        payload: {
          projectId,
          taskId: task.id,
          localTaskId: task.localTaskId,
          runId: task.activeRunId,
          attempt: task.attempt || 1,
          title: task.title,
          brief: task.brief,
          projectName: project?.name,
          projectGoal: project?.goal || '',
          projectRequirements: project?.requirements || '',
          workFolder: ws.path,
        },
      });
    } catch (err) {
      log('warn', `Failed to send request_task to ${task.assignedAgent}`, { projectId, taskId: task.id, error: err.message });
    }
  }
}

function connectBroker() {
  try {
    brokerClient = createBrokerClient({
      brokerUrl: BROKER_URL,
      participantId: 'kswarm-hub',
      kind: 'hub',
      alias: 'kswarm',
      roles: ['hub', 'coordinator'],
      capabilities: ['project_management', 'task_routing'],
      onIntent: handleBrokerIntent,
      onConnect: () => {
        brokerConnected = true;
        log('info', 'Connected to intent-broker', { url: BROKER_URL });
        broadcast({ type: 'broker_status', connected: true });
        runStartupRecovery().finally(startWatchdog);
      },
      onDisconnect: () => {
        brokerConnected = false;
        broadcast({ type: 'broker_status', connected: false });
      },
    });
    // Must register then connect
    brokerClient.register()
      .then(() => brokerClient.connect())
      .catch(err => {
        log('warn', `Broker registration/connect failed: ${err.message}`);
        setTimeout(connectBroker, 5000);
      });
  } catch (err) {
    log('warn', `Broker connection failed: ${err.message}`);
    setTimeout(connectBroker, 5000);
  }
}

async function getOnlineAgentIds() {
  try {
    const res = await fetch(`${BROKER_URL}/participants`);
    if (!res.ok) return new Set();
    const data = await res.json();
    const participants = data.participants || data || [];
    return new Set(
      participants
        .filter(p => p.kind === 'agent' && p.inboxMode === 'realtime')
        .map(p => p.participantId)
    );
  } catch {
    return new Set();
  }
}

async function sendRecoveryReviewSubmission({ projectId, taskId, fromWorker, result }) {
  const project = hub.getProject(projectId);
  if (!brokerClient || !brokerClient.isConnected() || !project?.poAgent) return;
  await brokerClient.sendTo(project.poAgent, 'review_submission', {
    taskId,
    payload: { projectId, taskId, fromWorker, result },
  });
}

async function runStartupRecovery() {
  if (recoveryRunning) return;
  recoveryRunning = true;
  try {
    const onlineAgents = await getOnlineAgentIds();
    for (const project of hub.listProjects()) {
      if (project.status !== 'active') continue;
      const board = hub.getBoard(project.id);
      if (!board) continue;
      const ws = getProjectWorkspace(project.id);
      const journals = readRunJournals(ws.path);
      const recoveryPlan = planProjectRecovery({
        project,
        tasks: board.getAllTasks(),
        journals,
        onlineAgents,
      });
      if (recoveryPlan.actions.length === 0) continue;

      log('info', `Startup recovery started for project ${project.id}`, { actions: recoveryPlan.actions.length });
      broadcast({ type: 'project_recovery_started', projectId: project.id, actions: recoveryPlan.actions.length });

      let recovered = 0;
      let failed = 0;
      let needsDispatch = false;
      for (const action of recoveryPlan.actions) {
        try {
          const result = await executeRecoveryAction(action, {
            hub,
            sendReviewSubmission: sendRecoveryReviewSubmission,
            sendRequestTask: (projectId, taskId) => sendBrokerRequestTasks(projectId, [taskId]),
          });
          if (result?.ok) {
            recovered++;
            if (action.type === 'reset_pending') needsDispatch = true;
            broadcast({ type: 'task_recovered', projectId: action.projectId, taskId: action.taskId, action: action.type });
          } else {
            failed++;
            broadcast({ type: 'task_recovery_failed', projectId: action.projectId, taskId: action.taskId, action: action.type, error: result?.error || 'unknown_error' });
          }
        } catch (err) {
          failed++;
          log('warn', `Startup recovery action failed`, { projectId: action.projectId, taskId: action.taskId, action: action.type, error: err.message });
          broadcast({ type: 'task_recovery_failed', projectId: action.projectId, taskId: action.taskId, action: action.type, error: err.message });
        }
      }

      if (needsDispatch) {
        const dispatchResult = hub.handleRequestDispatch(project.id, project.poAgent);
        if (dispatchResult.ok && dispatchResult.dispatched.length > 0) {
          log('info', `Startup recovery redispatched tasks`, { projectId: project.id, dispatched: dispatchResult.dispatched });
          broadcast({ type: 'tasks_dispatched', projectId: project.id, dispatched: dispatchResult.dispatched });
          await sendBrokerRequestTasks(project.id, dispatchResult.dispatched);
        }
      }

      broadcast({ type: 'project_recovery_completed', projectId: project.id, summary: { recovered, failed } });
      log('info', `Startup recovery completed for project ${project.id}`, { recovered, failed });
    }
  } finally {
    recoveryRunning = false;
  }
}

function handleBrokerIntent(intent) {
  const { kind, taskId, fromParticipantId, payload } = intent;

  switch (kind) {
    case 'accept_task': {
      const resolved = resolveIncomingTask(taskId, payload);
      if (!resolved.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, resolved);
      const result = hub.handleAcceptTask(resolved.projectId, resolved.taskId, fromParticipantId, payload?.runId);
      if (!result.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, { ...result, projectId: resolved.projectId });
      log('info', `Worker accepted task: ${resolved.taskId}`, { worker: fromParticipantId, projectId: resolved.projectId });
      broadcast({ type: 'task_update', projectId: resolved.projectId, taskId: resolved.taskId, status: 'accepted', agent: fromParticipantId });
      break;
    }
    case 'report_progress': {
      const resolved = resolveIncomingTask(taskId, payload);
      if (!resolved.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, resolved);
      const result = hub.handleProgress(resolved.projectId, resolved.taskId, payload?.stage, fromParticipantId, payload?.runId);
      if (!result.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, { ...result, projectId: resolved.projectId });
      log('info', `Progress on task: ${resolved.taskId}`, { stage: payload?.stage, worker: fromParticipantId, projectId: resolved.projectId });
      broadcast({ type: 'task_update', projectId: resolved.projectId, taskId: resolved.taskId, status: 'in_progress', stage: payload?.stage, agent: fromParticipantId });
      break;
    }
    case 'task_failed': {
      const resolved = resolveIncomingTask(taskId, payload);
      if (!resolved.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, resolved);
      const result = hub.handleWorkerFailure(
        resolved.projectId,
        resolved.taskId,
        fromParticipantId,
        payload?.runId,
        payload?.failureReason,
        payload?.errorMessage
      );
      if (!result.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, { ...result, projectId: resolved.projectId });
      log('info', `Worker reported task failure: ${resolved.taskId}`, {
        worker: fromParticipantId,
        projectId: resolved.projectId,
        failureReason: result.failureReason,
        retried: result.retried,
      });
      broadcast({ type: 'task_failed', projectId: resolved.projectId, taskId: resolved.taskId, agent: fromParticipantId, ...result });
      if (result.retried && result.retryTaskId) {
        sendBrokerRequestTasks(resolved.projectId, [result.retryTaskId]).catch(() => {});
      }
      break;
    }
    case 'submit_result': {
      const resolved = resolveIncomingTask(taskId, payload);
      if (!resolved.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, resolved);
      const result = hub.handleSubmitResult(resolved.projectId, resolved.taskId, payload, fromParticipantId, payload?.runId);
      if (!result.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, { ...result, projectId: resolved.projectId });
      log('info', `Task submitted: ${resolved.taskId}`, { worker: fromParticipantId, projectId: resolved.projectId });
      broadcast({ type: 'task_update', projectId: resolved.projectId, taskId: resolved.taskId, status: 'submitted', agent: fromParticipantId });

      // Notify PO to review this submission
      const project = hub.getProject(resolved.projectId);
      if (brokerClient && brokerClient.isConnected() && project?.poAgent && !result.alreadySubmitted) {
        brokerClient.sendTo(project.poAgent, 'review_submission', {
          taskId: resolved.taskId,
          payload: { projectId: resolved.projectId, taskId: resolved.taskId, fromWorker: fromParticipantId, result: payload },
        }).catch(() => {});
      }
      break;
    }
  }
}

function resolveIncomingTask(taskId, payload = {}) {
  const payloadProjectId = payload?.projectId;
  const parsed = parseTaskId(taskId);

  if (payloadProjectId) {
    if (parsed.global && parsed.projectId !== payloadProjectId) {
      return { ok: false, error: 'project_task_mismatch', projectId: payloadProjectId, taskId };
    }
    const board = hub.getBoard(payloadProjectId);
    if (!board) return { ok: false, error: 'project_not_found', projectId: payloadProjectId, taskId };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found', projectId: payloadProjectId, taskId };
    return { ok: true, projectId: payloadProjectId, taskId: task.id };
  }

  if (parsed.global) {
    const board = hub.getBoard(parsed.projectId);
    if (!board) return { ok: false, error: 'project_not_found', projectId: parsed.projectId, taskId };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found', projectId: parsed.projectId, taskId };
    return { ok: true, projectId: parsed.projectId, taskId: task.id };
  }

  const matches = [];
  for (const project of hub.listProjects()) {
    const board = hub.getBoard(project.id);
    const task = board?.getTask(taskId);
    if (task) matches.push({ projectId: project.id, taskId: task.id });
  }
  if (matches.length === 1) return { ok: true, ...matches[0], legacy: true };
  if (matches.length > 1) return { ok: false, error: 'ambiguous_task_id', taskId, matches };
  return { ok: false, error: 'task_not_found', taskId };
}

function emitTaskIntentError(kind, taskId, worker, result) {
  log('warn', `Task intent error: ${kind}`, { taskId, worker, error: result.error, projectId: result.projectId, matches: result.matches });
  broadcast({
    type: 'task_intent_error',
    kind,
    taskId,
    worker,
    projectId: result.projectId || null,
    error: result.error || 'unknown_error',
    matches: result.matches || [],
  });
}

// ─── Auto-start agent helper ──────────────────────────────────────
// If agent is in the store and offline, spawn its worker process automatically
/** Check if an agent is actually connected to broker (not just status in store) */
async function isAgentOnBroker(agentId) {
  try {
    const res = await fetch(`${BROKER_URL}/participants`);
    if (!res.ok) return false;
    const data = await res.json();
    const participants = data.participants || data || [];
    return participants.some(p => p.participantId === agentId);
  } catch {
    return false;
  }
}

async function autoStartAgent(agentId) {
  const agent = agentStore.get(agentId);
  if (!agent) {
    log('debug', `autoStartAgent: ${agentId} not in agent store, skipping`);
    return false;
  }
  if (agent.archivedAt) {
    log('debug', `autoStartAgent: ${agentId} is archived, skipping`);
    return false;
  }

  // If agent claims to be online, verify with broker
  if (agent.status !== 'offline') {
    const actuallyOnline = await isAgentOnBroker(agentId);
    if (actuallyOnline) {
      log('debug', `autoStartAgent: ${agentId} verified online on broker`);
      return true;
    }
    // Stale status — force offline so we re-spawn
    log('warn', `autoStartAgent: ${agentId} status was '${agent.status}' but not on broker, resetting`);
    agentStore.setOffline(agentId);
  }

  try {
    const { spawn } = await import('node:child_process');
    const scriptPath = join(import.meta.dirname, '../../scripts/auto-worker.js');

    // Build env: merge process.env + agent's LLM config + customEnv
    const childEnv = { ...process.env, ...agent.customEnv };
    if (agent.provider) {
      if (agent.provider === 'openai') {
        if (agent.apiKey) childEnv.OPENAI_API_KEY = agent.apiKey;
        if (agent.baseUrl) childEnv.OPENAI_BASE_URL = agent.baseUrl;
        if (agent.model) childEnv.OPENAI_MODEL = agent.model;
      } else if (agent.provider === 'anthropic') {
        if (agent.apiKey) childEnv.ANTHROPIC_API_KEY = agent.apiKey;
        if (agent.model) childEnv.ANTHROPIC_MODEL = agent.model;
      } else if (agent.provider === 'ollama') {
        if (agent.baseUrl) childEnv.OLLAMA_BASE_URL = agent.baseUrl;
        if (agent.model) childEnv.OLLAMA_MODEL = agent.model;
      }
    }
    childEnv.KSWARM_AGENT_ID = agentId;

    const args = [scriptPath, agentId, agent.name, ...(agent.customArgs || [])];
    const child = spawn('node', args, {
      cwd: join(import.meta.dirname, '../..'),
      env: childEnv,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();

    const runtimeId = `pid-${child.pid}`;
    agentStore.setOnline(agentId, runtimeId);

    log('info', `Auto-started agent: ${agent.name} (${agentId})`, { pid: child.pid, runtimeId });
    broadcast({ type: 'agent_started', agentId, runtimeId, pid: child.pid });
    return true;
  } catch (err) {
    log('error', `Failed to auto-start agent ${agentId}: ${err.message}`);
    return false;
  }
}

/**
 * Force-restart an agent: kill old process, then spawn fresh.
 * Ensures the agent loads the latest code from disk.
 */
async function forceRestartAgent(agentId) {
  const agent = agentStore.get(agentId);
  if (!agent) return false;

  // Kill old process if runtimeId looks like pid-XXXX
  if (agent.runtimeId) {
    const pidMatch = agent.runtimeId.match(/^pid-(\d+)$/);
    if (pidMatch) {
      const oldPid = parseInt(pidMatch[1], 10);
      try { process.kill(oldPid, 'SIGTERM'); } catch (_) { /* already dead */ }
    }
  }

  // Mark offline so autoStartAgent will re-spawn
  agentStore.setOffline(agentId);
  await new Promise(r => setTimeout(r, 500));

  return autoStartAgent(agentId);
}

// ─── Artifact helpers ─────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function getPreviewable(ext) {
  return ['.html', '.md', '.json', '.txt', '.svg', '.png', '.jpg'].includes(ext);
}

// ─── Plan rendering helper ───────────────────────────────────────
function renderPlanMarkdown(plan) {
  const lines = [`# Project Plan (v${plan.version})`, ''];
  if (plan.analysis) {
    lines.push('## Analysis', '', plan.analysis, '');
  }
  if (plan.successCriteria?.length) {
    lines.push('## Success Criteria', '');
    for (const c of plan.successCriteria) lines.push(`- ${c}`);
    lines.push('');
  }
  for (const phase of (plan.phases || [])) {
    lines.push(`## ${phase.name}`, '');
    for (const item of (phase.items || [])) {
      const status = item.status || 'planned';
      lines.push(`### ${item.title} [${status}]`);
      if (item.brief) lines.push('', item.brief);
      if (item.rationale) lines.push('', `**Rationale:** ${item.rationale}`);
      if (item.acceptanceCriteria) lines.push('', `**Acceptance:** ${item.acceptanceCriteria}`);
      if (item.assignedAgent) lines.push('', `**Assigned:** ${item.assignedAgent}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ─── HTTP API ─────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // ── Health ──
    if (path === '/health' && req.method === 'GET') {
      return json(res, { ok: true, brokerConnected, projects: hub.listProjects().length });
    }

    // ── Projects list ──
    if (path === '/projects' && req.method === 'GET') {
      const projects = hub.listProjects().map(p => {
        const board = hub.getBoard(p.id);
        const tasks = board ? board.getAllTasks() : [];
        const done = tasks.filter(t => t.status === 'done').length;
        return { ...p, taskCount: tasks.length, doneCount: done, updatedAt: p.updatedAt || p.createdAt || 0 };
      }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return json(res, { projects });
    }

    // ── Create project (Human action) ──
    if (path === '/projects' && req.method === 'POST') {
      const body = await parseBody(req);
      const { name, goal, requirements, poAgent, members, workFolder, enableSummary } = body;
      if (!name || !poAgent) return json(res, { error: 'name and poAgent required' }, 400);
      const id = `proj-${Date.now()}`;
      const project = hub.createProject({ id, name, goal: goal || '', requirements: requirements || '', poAgent, members: members || [], enableSummary });
      
      // Initialize workspace
      const ws = initProjectWorkspace(id, workFolder);
      project.workFolder = ws.path;
      
      log('info', `Project created: ${name}`, { id, po: poAgent, workspace: ws.path });
      broadcast({ type: 'project_created', project });

      // Auto-start PO agent and member agents if they are in agent store and offline
      const agentsToStart = [poAgent, ...(members || [])];
      for (const agentId of agentsToStart) {
        await autoStartAgent(agentId);
      }

      // Send assign_po immediately so PO can start generating the Plan
      if (brokerClient && brokerClient.isConnected()) {
        setTimeout(() => {
          brokerClient.sendTo(poAgent, 'assign_po', {
            taskId: id,
            threadId: `thread-${id}`,
            payload: {
              projectId: id,
              projectName: name,
              goal: goal || '',
              requirements: requirements || '',
              members: members || [],
            },
          }).catch(err => log('warn', 'Failed to send assign_po on create', { error: err.message }));
        }, 1000);
      }

      return json(res, { ok: true, project }, 201);
    }

    // ── Project detail ──
    const projectMatch = path.match(/^\/projects\/([^/]+)$/);
    if (projectMatch && req.method === 'GET') {
      const project = hub.getProject(projectMatch[1]);
      if (!project) return json(res, { error: 'not_found' }, 404);
      const board = hub.getBoard(project.id);
      const tasks = board ? board.getAllTasks() : [];
      const activities = hub.getEventLog().getEvents().filter(e => e.projectId === project.id);
      const humanActions = hub.getHumanActions(project.id);
      const ws = getProjectWorkspace(project.id);
      const artifacts = listProjectArtifacts(project.id);
      const planProgress = board ? board.getPlanProgress() : null;
      const dispatchPlan = hub.getDispatchPlan(project.id);
      const projectHealth = hub.getProjectHealth(project.id);
      return json(res, {
        project: { ...project, workFolder: ws.path },
        tasks,
        activities,
        humanActions,
        workspace: { path: ws.path, custom: ws.custom, artifacts },
        plan: project.plan || null,
        planProgress,
        dispatchPlan,
        projectHealth,
      });
    }

    // ── Delete project (Human only) ──
    if (projectMatch && req.method === 'DELETE') {
      const result = hub.deleteProject(projectMatch[1]);
      if (result.ok) {
        log('info', `Human deleted project: ${projectMatch[1]}`);
        broadcast({ type: 'project_closed', projectId: projectMatch[1] });
      }
      return json(res, result);
    }

    // ── Project approve (Human action) ──
    const approveMatch = path.match(/^\/projects\/([^/]+)\/approve$/);
    if (approveMatch && req.method === 'POST') {
      const result = hub.handleApprove(approveMatch[1]);
      if (result.ok) {
        if (result.alreadyActive) {
          log('info', `Project already active, skipping re-approval: ${approveMatch[1]}`);
        } else {
          log('info', `Project approved by Human: ${approveMatch[1]}`);
          broadcast({ type: 'project_approved', projectId: approveMatch[1] });

          // Ensure PO and member agents are running (no-op if already online)
          const project = hub.getProject(approveMatch[1]);
          if (project?.poAgent) {
            await autoStartAgent(project.poAgent);
            for (const memberId of (project.members || [])) {
              await autoStartAgent(memberId);
            }
          }

          // Notify PO that plan is approved — start execution
          if (brokerClient && brokerClient.isConnected() && project?.poAgent) {
            await new Promise(r => setTimeout(r, 500));
            brokerClient.sendTo(project.poAgent, 'respond_approval', {
              taskId: approveMatch[1],
              threadId: `thread-${approveMatch[1]}`,
              payload: {
                projectId: approveMatch[1],
                decision: 'approved',
              },
            }).catch(err => log('warn', 'Failed to notify PO of approval', { error: err.message }));
          }
        }
      }
      return json(res, result);
    }

    // ── Plan: submit (PO action) ──

    // ── Retry plan: re-trigger PO to create plan ──
    const retryPlanMatch = path.match(/^\/projects\/([^/]+)\/retry-plan$/);
    if (retryPlanMatch && req.method === 'POST') {
      const projectId = retryPlanMatch[1];
      const project = hub.getProject(projectId);
      if (!project) return json(res, { error: 'project_not_found' }, 404);

      // Auto-start PO and member agents
      if (project?.poAgent) {
        await autoStartAgent(project.poAgent);
        for (const memberId of (project.members || [])) {
          await autoStartAgent(memberId);
        }
      }

      // Reset plan state
      project.plan = null;
      project.planArtifact = null;
      if (project.status === 'planning') project.status = 'created';

      // Send assign_po intent via brokerClient
      if (brokerClient && brokerClient.isConnected() && project.poAgent) {
        brokerClient.sendTo(project.poAgent, 'assign_po', {
          projectId,
          payload: { name: project.name, goal: project.goal },
        }).catch(err => log('warn', 'Failed to send assign_po intent', { error: err.message }));
      }

      log('info', `Plan retry triggered for project: ${projectId}`, { po: project.poAgent });
      broadcast({ type: 'plan_retry', projectId, po: project.poAgent });
      return json(res, { ok: true, retried: true });
    }
    const planSubmitMatch = path.match(/^\/projects\/([^/]+)\/plan$/);
    if (planSubmitMatch && req.method === 'POST') {
      const projectId = planSubmitMatch[1];
      const body = await parseBody(req);
      const { plan, fromAgent } = body;
      if (!plan || !fromAgent) return json(res, { error: 'plan and fromAgent required' }, 400);

      const result = hub.handleSubmitPlan(projectId, plan, fromAgent);
      if (result.ok) {
        log('info', `PO submitted plan for project: ${projectId}`, { version: result.plan.version, phases: (result.plan.phases || []).length });
        broadcast({ type: 'plan_submitted', projectId, plan: result.plan });

        // Write plan as artifact
        const ws = getProjectWorkspace(projectId);
        const planMd = renderPlanMarkdown(result.plan);
        writeFileSync(join(ws.artifacts, `plan-v${result.plan.version}.md`), planMd);
      }
      return json(res, result);
    }

    // ── Plan: get current ──
    if (planSubmitMatch && req.method === 'GET') {
      const project = hub.getProject(planSubmitMatch[1]);
      if (!project) return json(res, { error: 'not_found' }, 404);
      if (!project.plan) return json(res, { error: 'no_plan', message: 'No plan submitted yet' }, 404);
      return json(res, { plan: project.plan });
    }

    // ── Plan: revise (PO action) ──
    const planReviseMatch = path.match(/^\/projects\/([^/]+)\/plan\/revise$/);
    if (planReviseMatch && req.method === 'POST') {
      const projectId = planReviseMatch[1];
      const body = await parseBody(req);
      const { revision, fromAgent } = body;
      if (!revision || !fromAgent) return json(res, { error: 'revision and fromAgent required' }, 400);

      const result = hub.handleRevisePlan(projectId, revision, fromAgent);
      if (result.ok) {
        log('info', `PO revised plan for project: ${projectId}`, { version: result.version, changes: (revision.changes || []).length });
        broadcast({ type: 'plan_revised', projectId, version: result.version });

        // Write updated plan as artifact
        const project = hub.getProject(projectId);
        const ws = getProjectWorkspace(projectId);
        const planMd = renderPlanMarkdown(project.plan);
        writeFileSync(join(ws.artifacts, `plan-v${result.version}.md`), planMd);
      }
      return json(res, result);
    }

    // ── Plan: revision history ──
    const planHistoryMatch = path.match(/^\/projects\/([^/]+)\/plan\/history$/);
    if (planHistoryMatch && req.method === 'GET') {
      const project = hub.getProject(planHistoryMatch[1]);
      if (!project) return json(res, { error: 'not_found' }, 404);
      if (!project.plan) return json(res, { error: 'no_plan' }, 404);
      return json(res, { version: project.plan.version, revisions: project.plan.revisions || [] });
    }

    // ── Quality review (PO action) ──
    const reviewMatch = path.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/review$/);
    if (reviewMatch && req.method === 'POST') {
      const [, projectId, taskId] = reviewMatch;
      const body = await parseBody(req);
      const { review, fromAgent } = body;
      if (!review || !fromAgent) return json(res, { error: 'review and fromAgent required' }, 400);

      const result = hub.handleQualityReview(projectId, taskId, review, fromAgent);
      if (result.ok) {
        if (result.alreadyReviewed) {
          log('info', `Ignored duplicate review for task ${taskId}`, { projectId, passed: review.passed });
          return json(res, result);
        }

        log('info', `PO reviewed task ${taskId}: ${review.passed ? 'PASSED' : 'FAILED'}`, { projectId, feedback: review.feedback });
        broadcast({ type: 'task_reviewed', projectId, taskId, passed: review.passed, feedback: review.feedback });
        if (result.blocked) {
          broadcast({ type: 'task_blocked', projectId, taskId, failureClass: result.failureClass, nextActions: result.nextActions || [] });
        }

        // If passed, auto-dispatch next available tasks
        if (review.passed) {
          const dispatchResult = hub.handleRequestDispatch(projectId, fromAgent);
          if (dispatchResult.ok && dispatchResult.dispatched.length > 0) {
            log('info', `Auto-dispatched after review`, { projectId, dispatched: dispatchResult.dispatched });
            broadcast({ type: 'tasks_dispatched', projectId, dispatched: dispatchResult.dispatched });
            // Notify workers via broker
            if (brokerClient && brokerClient.isConnected()) {
              const board = hub.getBoard(projectId);
              for (const tid of dispatchResult.dispatched) {
                const task = board?.getTask(tid);
                if (task?.assignedAgent) {
                  brokerClient.sendTo(task.assignedAgent, 'request_task', {
                    taskId: task.id, threadId: `thread-${task.id}`,
                    payload: {
                      projectId,
                      taskId: task.id,
                      localTaskId: task.localTaskId,
                      runId: task.activeRunId,
                      attempt: task.attempt || 1,
                      title: task.title,
                      brief: task.brief,
                    },
                  }).catch(err => log('warn', `Failed to send request_task to ${task.assignedAgent}`, { error: err.message }));
                }
              }
            }
          }
        }

        // If rework, notify worker via broker
        if (result.rework && brokerClient && brokerClient.isConnected()) {
          const board = hub.getBoard(projectId);
          const task = board?.getTask(taskId);
          if (task?.assignedAgent) {
            brokerClient.sendTo(task.assignedAgent, 'rework', {
              taskId: task.id, threadId: `thread-${projectId}`,
              payload: { reason: review.feedback, projectId },
            }).catch(() => {});
          }
        }
      }
      return json(res, result);
    }

    // ── Recover an already-written artifact as a task submission ──
    const recoverMatch = path.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/recover-submission$/);
    if (recoverMatch && req.method === 'POST') {
      const [, projectId, taskId] = recoverMatch;
      const body = await parseBody(req);
      const fromAgent = body.fromAgent || 'human';
      const artifactNames = Array.isArray(body.artifacts) ? body.artifacts : [];
      if (artifactNames.length === 0) return json(res, { ok: false, error: 'artifacts_required' }, 400);

      const ws = getProjectWorkspace(projectId);
      const artifacts = [];
      for (const filename of artifactNames) {
        if (!filename || filename !== basename(filename) || filename.includes('..')) {
          return json(res, { ok: false, error: 'invalid_artifact_filename', filename }, 400);
        }
        const artifactPath = join(ws.artifacts, filename);
        if (!existsSync(artifactPath)) {
          return json(res, { ok: false, error: 'artifact_not_found', filename }, 404);
        }
        const content = readFileSync(artifactPath, 'utf-8');
        if (content.trim().length < 100) {
          return json(res, { ok: false, error: 'artifact_too_small', filename }, 400);
        }
        const ext = extname(filename);
        artifacts.push({
          filename,
          url: `/projects/${projectId}/artifacts/${filename}`,
          previewable: getPreviewable(ext),
          mimeType: MIME_TYPES[ext] || 'application/octet-stream',
        });
      }

      const resultPayload = {
        summary: body.summary || `Recovered submission for ${taskId}`,
        participantId: fromAgent,
        artifacts,
        recovered: true,
      };
      const result = hub.handleRecoverSubmission(projectId, taskId, resultPayload, fromAgent);
      if (result.ok) {
        log('info', `Recovered task submission: ${result.taskId}`, { projectId, fromAgent, artifacts: artifactNames });
        broadcast({ type: 'task_update', projectId, taskId: result.taskId, status: 'submitted', agent: fromAgent, recovered: true });

        const project = hub.getProject(projectId);
        if (brokerClient && brokerClient.isConnected() && project?.poAgent) {
          brokerClient.sendTo(project.poAgent, 'review_submission', {
            taskId: result.taskId,
            payload: { projectId, taskId: result.taskId, fromWorker: fromAgent, result: resultPayload },
          }).catch(() => {});
        }
      }
      return json(res, result);
    }

    // ── Synthesize project (PO action) ──
    const synthesizeMatch = path.match(/^\/projects\/([^/]+)\/synthesize$/);
    if (synthesizeMatch && req.method === 'POST') {
      const projectId = synthesizeMatch[1];
      const body = await parseBody(req);
      const { synthesis, fromAgent } = body;
      if (!synthesis || !fromAgent) return json(res, { error: 'synthesis and fromAgent required' }, 400);

      // Write synthesis artifact
      const ws = getProjectWorkspace(projectId);
      writeFileSync(join(ws.artifacts, 'synthesis.md'), synthesis);

      // Deliver the project
      const result = hub.handleDeliver(projectId, { synthesis: true }, fromAgent);
      if (result.ok) {
        log('info', `PO synthesized and delivered project: ${projectId}`);
        broadcast({ type: 'project_synthesized', projectId });

        // Parse and persist project summary
        const project = hub.getProject(projectId);
        if (project && project.enableSummary !== false) {
          try {
            const { extractSummarySection, extractSummaryScore } = await import('../core/summary-parser.js');
            project.summary = extractSummarySection(synthesis);
            project.summaryScore = extractSummaryScore(synthesis);
            hub.persistState();
          } catch (e) {
            log('warn', 'Failed to parse project summary', { projectId, error: String(e) });
          }
        }

        // Aggregate delivery package
        const delivery = aggregateDelivery(ws.path, {
          name: project?.name,
          goal: project?.goal,
          poAgent: fromAgent,
          deliveredAt: Date.now(),
        });
        if (delivery) {
          result.delivery = {
            manifestUrl: `/projects/${projectId}/delivery/delivery-manifest.json`,
            reportUrl: delivery.reportPath ? `/projects/${projectId}/delivery/delivery-report.md` : null,
            artifactCount: delivery.manifest.artifacts.length,
          };
        }
      }
      return json(res, result);
    }

    // ── Reassign a stuck task (PO action) ──
    const reassignMatch = path.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/reassign$/);
    if (reassignMatch && req.method === 'POST') {
      const [, projectId, taskId] = reassignMatch;
      const body = await parseBody(req);
      const { newAgent, reason, fromPO } = body;
      if (!newAgent) return json(res, { error: 'newAgent required' }, 400);

      const board = hub.getBoard(projectId);
      if (!board) return json(res, { error: 'project not found' }, 404);

      const task = board.getTask(taskId);
      if (!task) return json(res, { error: 'task not found' }, 404);

      // Transition to pending based on current status
      let result;
      if (task.status === 'in_progress') {
        result = board.transition(task.id, 'failed', { reason: reason || 'reassigned' });
        if (result.ok) result = board.transition(task.id, 'pending', {});
      } else if (['dispatched', 'accepted'].includes(task.status)) {
        result = board.transition(task.id, 'pending', {});
      } else if (task.status === 'pending') {
        result = { ok: true }; // already pending
      } else {
        return json(res, { error: `cannot reassign from status: ${task.status}` }, 400);
      }

      if (!result?.ok) return json(res, { error: result?.error || 'transition failed' }, 400);

      // Update assignment
      const updatedTask = board.getTask(task.id);
      if (updatedTask) updatedTask.assignedAgent = newAgent;

      log('info', `Task reassigned: ${task.id} → ${newAgent} (reason: ${reason})`, { projectId, fromPO });
      broadcast({ type: 'task_reassigned', projectId, taskId: task.id, newAgent, reason });

      // Auto-dispatch the reassigned task
      try {
        const dispatchRes = hub.handleRequestDispatch(projectId, fromPO || 'system');
        if (dispatchRes.ok) {
          broadcast({ type: 'tasks_dispatched', projectId, tasks: dispatchRes.dispatched });
          await sendBrokerRequestTasks(projectId, dispatchRes.dispatched);
        }
      } catch (_) {}

      return json(res, { ok: true, taskId: task.id, newAgent, previousStatus: task.status });
    }

    // ── Human adds tasks (any time, no PO restriction) ──
    const humanTasksMatch = path.match(/^\/projects\/([^/]+)\/tasks\/human$/);
    if (humanTasksMatch && req.method === 'POST') {
      const body = await parseBody(req);
      const { tasks: taskList } = body;
      if (!taskList) return json(res, { error: 'tasks required' }, 400);
      // Auto-generate id for tasks that don't have one
      for (const t of taskList) {
        if (!t.id) t.id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
      const result = hub.handleHumanAddTasks(humanTasksMatch[1], taskList);
      if (result.ok) {
        log('info', `Human added ${taskList.length} tasks to project ${humanTasksMatch[1]}`);
        broadcast({ type: 'tasks_created', projectId: humanTasksMatch[1], tasks: taskList, addedBy: 'human' });
      }
      return json(res, result);
    }

    // ── PO creates tasks ──
    const tasksMatch = path.match(/^\/projects\/([^/]+)\/tasks$/);
    if (tasksMatch && req.method === 'POST') {
      const body = await parseBody(req);
      const { tasks: taskList, fromAgent } = body;
      if (!taskList || !fromAgent) return json(res, { error: 'tasks and fromAgent required' }, 400);
      const result = hub.handleCreateTasks(tasksMatch[1], taskList, fromAgent);
      if (result.ok) {
        log('info', `PO created ${taskList.length} tasks`, { projectId: tasksMatch[1], po: fromAgent });
        broadcast({ type: 'tasks_created', projectId: tasksMatch[1], tasks: taskList, addedBy: fromAgent });
      }
      return json(res, result);
    }

    // ── Dispatch tasks (PO action) ──
    const dispatchMatch = path.match(/^\/projects\/([^/]+)\/dispatch$/);
    if (dispatchMatch && req.method === 'POST') {
      const body = await parseBody(req);
      const projectId = dispatchMatch[1];
      const result = hub.handleRequestDispatch(projectId, body.fromAgent);
      if (result.ok) {
        log('info', `Dispatched tasks for project ${projectId}`, { dispatched: result.dispatched });
        broadcast({ type: 'tasks_dispatched', projectId, dispatched: result.dispatched });

        if (brokerClient && brokerClient.isConnected()) {
          const project = hub.getProject(projectId);
          const board = hub.getBoard(projectId);
          const ws = getProjectWorkspace(projectId);
          for (const taskId of result.dispatched) {
            const task = board.getTask(taskId);
            if (task && task.assignedAgent) {
              brokerClient.sendTo(task.assignedAgent, 'request_task', {
                taskId: task.id, threadId: `thread-${task.id}`,
                payload: {
                  projectId,
                  taskId: task.id,
                  localTaskId: task.localTaskId,
                  runId: task.activeRunId,
                  attempt: task.attempt || 1,
                  title: task.title,
                  brief: task.brief,
                  projectName: project?.name,
                  projectGoal: project?.goal || '',
                  projectRequirements: project?.requirements || '',
                  workFolder: ws.path,
                },
              }).catch(err => log('warn', `Failed to send request_task to ${task.assignedAgent}`, { error: err.message }));
            }
          }
        }
      }
      return json(res, result);
    }

    // ── Mark task done (PO confirms) ──
    const doneMatch = path.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/done$/);
    if (doneMatch && req.method === 'POST') {
      const body = await parseBody(req);
      const result = hub.handleMarkDone(doneMatch[1], doneMatch[2], body.fromAgent);
      if (result.ok) {
        log('info', `PO confirmed task done: ${result.taskId || doneMatch[2]}`, { projectId: doneMatch[1] });
        broadcast({ type: 'task_done', projectId: doneMatch[1], taskId: result.taskId || doneMatch[2] });
      }
      return json(res, result);
    }

    // ── Rework task (PO action) ──
    const reworkMatch = path.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/rework$/);
    if (reworkMatch && req.method === 'POST') {
      const body = await parseBody(req);
      const result = hub.handleRework(reworkMatch[1], reworkMatch[2], body.reason || '', body.fromAgent);
      if (result.ok) {
        broadcast({ type: 'task_rework', projectId: reworkMatch[1], taskId: result.taskId || reworkMatch[2] });
      }
      return json(res, result);
    }

    // ── Cancel task (Human or PO) ──
    const cancelMatch = path.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const [, projectId, taskId] = cancelMatch;
      const board = hub.getBoard(projectId);
      if (!board) return json(res, { ok: false, error: 'project_not_found' });
      const task = board.getTask(taskId);
      if (!task) return json(res, { ok: false, error: 'task_not_found' });
      const result = board.transition(task.id, 'cancelled');
      if (result.ok) {
        log('info', `Task cancelled: ${task.id}`, { projectId });
        broadcast({ type: 'task_cancelled', projectId, taskId: task.id });
      }
      return json(res, result);
    }

    // ── Task failure (with auto-retry) ──
    const failMatch = path.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/fail$/);
    if (failMatch && req.method === 'POST') {
      const body = await parseBody(req);
      const [, projectId, taskId] = failMatch;
      const result = hub.handleTaskFail(projectId, taskId, body.failureReason, body.errorMessage);
      if (result.ok) {
        log('info', `Task failed: ${taskId}`, { projectId, failureReason: result.failureReason, retried: result.retried });
        broadcast({ type: 'task_failed', projectId, taskId, ...result });
        if (result.retried && result.retryTaskId) {
          await sendBrokerRequestTasks(projectId, [result.retryTaskId]);
        }
      }
      return json(res, result);
    }

    // ── PO delivers (submits deliverable, but does NOT close project) ──
    const deliverMatch = path.match(/^\/projects\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === 'POST') {
      const body = await parseBody(req);
      const projectId = deliverMatch[1];
      const result = hub.handleDeliver(projectId, body.deliverable || {}, body.fromAgent);
      if (result.ok) {
        log('info', `PO submitted deliverable for project: ${projectId}`);
        broadcast({ type: 'project_deliverable', projectId });

        // Aggregate artifacts into delivery package
        const ws = getProjectWorkspace(projectId);
        const project = hub.getProject(projectId);
        const delivery = aggregateDelivery(ws.path, {
          name: project?.name,
          goal: project?.goal,
          poAgent: body.fromAgent,
          deliveredAt: Date.now(),
        });
        if (delivery) {
          result.delivery = {
            manifestUrl: `/projects/${projectId}/delivery/delivery-manifest.json`,
            reportUrl: delivery.reportPath ? `/projects/${projectId}/delivery/delivery-report.md` : null,
            artifactCount: delivery.manifest.artifacts.length,
          };
        }
      }
      return json(res, result);
    }

    // ── Close project (Human only!) ──
    const closeMatch = path.match(/^\/projects\/([^/]+)\/close$/);
    if (closeMatch && req.method === 'POST') {
      const body = await parseBody(req);
      const result = hub.handleCloseProject(closeMatch[1], body.summary || '');
      if (result.ok) {
        log('info', `Human closed project: ${closeMatch[1]}`);
        broadcast({ type: 'project_closed', projectId: closeMatch[1] });
      }
      return json(res, result);
    }

    // ── Artifacts: upload (per-project) ──
    if (path === '/artifacts' && req.method === 'POST') {
      const body = await parseBody(req);
      const { filename, content, encoding, projectId } = body;
      if (!filename || !content) return json(res, { error: 'filename and content required' }, 400);

      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      
      // Store in project workspace if projectId provided, else in global
      let filePath;
      let artifactUrl;
      if (projectId) {
        const ws = getProjectWorkspace(projectId);
        filePath = join(ws.artifacts, safeName);
        artifactUrl = `/projects/${projectId}/artifacts/${safeName}`;
      } else {
        const globalDir = join(KSWARM_HOME, 'artifacts');
        mkdirSync(globalDir, { recursive: true });
        filePath = join(globalDir, safeName);
        artifactUrl = `/artifacts/${safeName}`;
      }
      
      const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : content;
      writeFileSync(filePath, buf);

      const ext = extname(safeName);
      log('info', `Artifact saved: ${safeName}`, { projectId: projectId || 'global', path: filePath });
      return json(res, {
        ok: true,
        artifact: {
          filename: safeName,
          url: artifactUrl,
          path: filePath,
          previewable: getPreviewable(ext),
          mimeType: MIME_TYPES[ext] || 'application/octet-stream',
        },
      }, 201);
    }

    // ── Artifacts: list for project ──
    const projArtifactsListMatch = path.match(/^\/projects\/([^/]+)\/artifacts$/);
    if (projArtifactsListMatch && req.method === 'GET') {
      const artifacts = listProjectArtifacts(projArtifactsListMatch[1]);
      return json(res, { artifacts });
    }

    // ── Artifacts: serve file (per-project) ──
    const projArtifactMatch = path.match(/^\/projects\/([^/]+)\/artifacts\/(.+)$/);
    if (projArtifactMatch && req.method === 'GET') {
      const ws = getProjectWorkspace(projArtifactMatch[1]);
      const filename = projArtifactMatch[2];
      const filePath = join(ws.artifacts, filename);
      if (!existsSync(filePath)) return json(res, { error: 'not_found' }, 404);

      const ext = extname(filename);
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const content = readFileSync(filePath);

      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': getPreviewable(ext) ? 'inline' : `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(content);
    }

    // ── Artifacts: serve global file (legacy) ──
    const artifactMatch = path.match(/^\/artifacts\/(.+)$/);
    if (artifactMatch && req.method === 'GET') {
      const globalDir = join(KSWARM_HOME, 'artifacts');
      const filename = artifactMatch[1];
      const filePath = join(globalDir, filename);
      if (!existsSync(filePath)) return json(res, { error: 'not_found' }, 404);

      const ext = extname(filename);
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const content = readFileSync(filePath);

      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': getPreviewable(ext) ? 'inline' : `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(content);
    }

    // ── Delivery: list/manifest ──
    const deliveryListMatch = path.match(/^\/projects\/([^/]+)\/delivery$/);
    if (deliveryListMatch && req.method === 'GET') {
      const ws = getProjectWorkspace(deliveryListMatch[1]);
      const deliveryDir = join(ws.path, 'delivery');
      if (!existsSync(deliveryDir)) return json(res, { error: 'no_delivery', message: 'Project has not been delivered yet' }, 404);
      const manifestPath = join(deliveryDir, 'delivery-manifest.json');
      if (!existsSync(manifestPath)) return json(res, { error: 'no_manifest' }, 404);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      return json(res, { ok: true, manifest });
    }

    // ── Delivery: serve file ──
    const deliveryFileMatch = path.match(/^\/projects\/([^/]+)\/delivery\/(.+)$/);
    if (deliveryFileMatch && req.method === 'GET') {
      const ws = getProjectWorkspace(deliveryFileMatch[1]);
      const filename = deliveryFileMatch[2];
      const filePath = join(ws.path, 'delivery', filename);
      if (!existsSync(filePath)) return json(res, { error: 'not_found' }, 404);

      const ext = extname(filename);
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const content = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': getPreviewable(ext) ? 'inline' : `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(content);
    }

    // ── Set project workspace (Human action) ──
    const wsMatch = path.match(/^\/projects\/([^/]+)\/workspace$/);
    if (wsMatch && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.path) return json(res, { error: 'path required' }, 400);
      const ws = setProjectWorkspace(wsMatch[1], body.path);
      log('info', `Project workspace set`, { projectId: wsMatch[1], path: ws.path });
      return json(res, { ok: true, workspace: ws });
    }
    if (wsMatch && req.method === 'GET') {
      const ws = getProjectWorkspace(wsMatch[1]);
      const artifacts = listProjectArtifacts(wsMatch[1]);
      return json(res, { workspace: { ...ws, artifacts } });
    }

    // ── Human identity / actions ──
    if (path === '/human/actions' && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      const actions = hub.getHumanActions(projectId || undefined);
      return json(res, { actions });
    }

    // ── Participants (from broker) ──
    if (path === '/participants' && req.method === 'GET') {
      try {
        const resp = await fetch(`${BROKER_URL}/participants`);
        const data = await resp.json();
        return json(res, data);
      } catch (err) {
        return json(res, { error: 'broker_unreachable', participants: [] }, 502);
      }
    }

    // ── Logs ──
    if (path === '/logs' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 100);
      return json(res, { logs: systemLogs.slice(-limit) });
    }

    // ── Spawn Worker (from Web UI) — legacy, kept for backward compat ──
    if (path === '/spawn-worker' && req.method === 'POST') {
      const body = await parseBody(req);
      const { workerId, alias: workerAlias } = body;
      if (!workerId) return json(res, { error: 'workerId required' }, 400);

      try {
        const { spawn } = await import('node:child_process');
        const scriptPath = join(import.meta.dirname, '../../scripts/auto-worker.js');
        const child = spawn('node', [scriptPath, workerId, workerAlias || 'Worker'], {
          cwd: join(import.meta.dirname, '../..'),
          stdio: 'ignore',
          detached: true,
        });
        child.unref();
        log('info', `Spawned auto-worker: ${workerId}`, { alias: workerAlias, pid: child.pid });
        return json(res, { ok: true, workerId, pid: child.pid }, 201);
      } catch (err) {
        log('error', `Failed to spawn worker: ${err.message}`);
        return json(res, { error: err.message }, 500);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ── Available CLI Runtimes (for frontend CreateAgentForm) ──
    if (path === '/runtimes' && req.method === 'GET') {
      const known = agentStore.getKnownCLIs();
      const detected = agentStore.detectCLIs();
      const detectedTypes = new Set(detected.map(d => d.type));
      const runtimes = known.map(cli => ({
        ...cli,
        detected: detectedTypes.has(cli.type),
        path: detected.find(d => d.type === cli.type)?.path || null,
      }));
      return json(res, { runtimes });
    }

    // ── Agent loads (current in-progress task count per agent) ──
    if (path === '/agents/loads' && req.method === 'GET') {
      const loads = {};
      for (const project of hub.listProjects()) {
        if (project.status === 'closed') continue;
        const board = hub.getBoard(project.id);
        if (!board) continue;
        for (const task of board.getAllTasks()) {
          if (['dispatched', 'accepted', 'in_progress'].includes(task.status) && task.assignedAgent) {
            loads[task.assignedAgent] = (loads[task.assignedAgent] || 0) + 1;
          }
        }
      }
      return json(res, { loads });
    }

    // ── Agent CRUD API (aligned with multica /api/agents) ─────────────
    // ═══════════════════════════════════════════════════════════════════

    // ── List agents ──
    if (path === '/agents' && req.method === 'GET') {
      const includeArchived = url.searchParams.get('include_archived') === 'true';
      const agents = agentStore.list({ includeArchived });
      // Redact secrets for listing
      return json(res, { agents: agents.map(a => agentStore.redact(a)) });
    }

    // ── Create agent ──
    if (path === '/agents' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = agentStore.create(body);
      if (result.error) return json(res, result, result.code || 400);
      log('info', `Agent created: ${result.agent.name} (${result.agent.id})`);
      broadcast({ type: 'agent_created', agent: agentStore.redact(result.agent) });
      return json(res, { ok: true, agent: result.agent }, 201);
    }

    // ── Agent heartbeat ping ──
    if (path === '/agents/heartbeat' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.agentId) {
        heartbeatManager.ping(body.agentId);
      }
      return json(res, { ok: true });
    }

    // ── Get liveness status for all agents ──
    if (path === '/agents/liveness' && req.method === 'GET') {
      const liveness = {};
      const activeAgents = agentStore.list({ includeArchived: false });
      for (const a of activeAgents) {
        const lastSeen = heartbeatManager.getLastSeen(a.id);
        liveness[a.id] = {
          lastSeen,
          online: lastSeen !== null && (Date.now() - lastSeen < 120_000),
          status: a.status || 'offline',
        };
      }
      return json(res, { liveness });
    }

    // ── Single agent routes ──
    const agentMatch = path.match(/^\/agents\/([^/]+)$/);
    if (agentMatch) {
      const agentId = agentMatch[1];

      if (req.method === 'GET') {
        const agent = agentStore.get(agentId);
        if (!agent) return json(res, { error: 'agent not found' }, 404);
        return json(res, { agent });
      }

      if (req.method === 'PUT') {
        const body = await parseBody(req);
        const result = agentStore.update(agentId, body);
        if (result.error) return json(res, result, result.code || 400);
        log('info', `Agent updated: ${result.agent.name} (${agentId})`);
        broadcast({ type: 'agent_updated', agent: agentStore.redact(result.agent) });
        return json(res, { ok: true, agent: result.agent });
      }

      if (req.method === 'DELETE') {
        const result = agentStore.archive(agentId);
        if (result.error) return json(res, result, result.code || 400);
        log('info', `Agent archived: ${agentId}`);
        broadcast({ type: 'agent_archived', agentId });
        return json(res, { ok: true });
      }
    }

    // ── Archive/Restore agent ──
    const agentArchiveMatch = path.match(/^\/agents\/([^/]+)\/archive$/);
    if (agentArchiveMatch && req.method === 'POST') {
      const result = agentStore.archive(agentArchiveMatch[1]);
      if (result.error) return json(res, result, result.code || 400);
      log('info', `Agent archived: ${agentArchiveMatch[1]}`);
      broadcast({ type: 'agent_archived', agentId: agentArchiveMatch[1] });
      return json(res, { ok: true });
    }

    const agentRestoreMatch = path.match(/^\/agents\/([^/]+)\/restore$/);
    if (agentRestoreMatch && req.method === 'POST') {
      const result = agentStore.restore(agentRestoreMatch[1]);
      if (result.error) return json(res, result, result.code || 400);
      log('info', `Agent restored: ${agentRestoreMatch[1]}`);
      broadcast({ type: 'agent_restored', agent: agentStore.redact(result.agent) });
      return json(res, { ok: true, agent: agentStore.redact(result.agent) });
    }

    // ── Start agent (spawn a worker process for this agent) ──
    const agentStartMatch = path.match(/^\/agents\/([^/]+)\/start$/);
    if (agentStartMatch && req.method === 'POST') {
      const agentId = agentStartMatch[1];
      const agent = agentStore.get(agentId);
      if (!agent) return json(res, { error: 'agent not found' }, 404);
      if (agent.archivedAt) return json(res, { error: 'agent is archived' }, 410);
      if (agent.status !== 'offline') return json(res, { error: 'agent already running', status: agent.status }, 409);

      try {
        const { spawn } = await import('node:child_process');
        const scriptPath = join(import.meta.dirname, '../../scripts/auto-worker.js');

        // Build env: merge process.env + agent's LLM config + customEnv
        const childEnv = { ...process.env, ...agent.customEnv };
        if (agent.provider) {
          if (agent.provider === 'openai') {
            if (agent.apiKey) childEnv.OPENAI_API_KEY = agent.apiKey;
            if (agent.baseUrl) childEnv.OPENAI_BASE_URL = agent.baseUrl;
            if (agent.model) childEnv.OPENAI_MODEL = agent.model;
          } else if (agent.provider === 'anthropic') {
            if (agent.apiKey) childEnv.ANTHROPIC_API_KEY = agent.apiKey;
            if (agent.model) childEnv.ANTHROPIC_MODEL = agent.model;
          } else if (agent.provider === 'ollama') {
            if (agent.baseUrl) childEnv.OLLAMA_BASE_URL = agent.baseUrl;
            if (agent.model) childEnv.OLLAMA_MODEL = agent.model;
          }
        }
        // Pass agent ID so worker can fetch full config
        childEnv.KSWARM_AGENT_ID = agentId;

        const args = [scriptPath, agentId, agent.name, ...(agent.customArgs || [])];
        const child = spawn('node', args, {
          cwd: join(import.meta.dirname, '../..'),
          env: childEnv,
          stdio: 'ignore',
          detached: true,
        });
        child.unref();

        const runtimeId = `pid-${child.pid}`;
        agentStore.setOnline(agentId, runtimeId);

        log('info', `Agent started: ${agent.name} (${agentId})`, { pid: child.pid, runtimeId });
        broadcast({ type: 'agent_started', agentId, runtimeId, pid: child.pid });
        return json(res, { ok: true, agentId, pid: child.pid, runtimeId }, 201);
      } catch (err) {
        log('error', `Failed to start agent: ${err.message}`);
        return json(res, { error: err.message }, 500);
      }
    }

    // ── Stop agent ──
    const agentStopMatch = path.match(/^\/agents\/([^/]+)\/stop$/);
    if (agentStopMatch && req.method === 'POST') {
      const agentId = agentStopMatch[1];
      const agent = agentStore.get(agentId);
      if (!agent) return json(res, { error: 'agent not found' }, 404);
      // Kill the actual process
      if (agent.runtimeId) {
        const pidMatch = agent.runtimeId.match(/^pid-(\d+)$/);
        if (pidMatch) {
          try { process.kill(parseInt(pidMatch[1], 10), 'SIGTERM'); } catch (_) {}
        }
      }
      agentStore.setOffline(agentId);
      log('info', `Agent stopped: ${agent.name} (${agentId})`);
      broadcast({ type: 'agent_stopped', agentId });
      return json(res, { ok: true });
    }

    // ── Restart agent (force kill + respawn with latest code) ──
    const agentRestartMatch = path.match(/^\/agents\/([^/]+)\/restart$/);
    if (agentRestartMatch && req.method === 'POST') {
      const agentId = agentRestartMatch[1];
      const agent = agentStore.get(agentId);
      if (!agent) return json(res, { error: 'agent not found' }, 404);
      const ok = await forceRestartAgent(agentId);
      if (ok) {
        const updated = agentStore.get(agentId);
        return json(res, { ok: true, agentId, runtimeId: updated.runtimeId });
      }
      return json(res, { error: 'restart failed' }, 500);
    }

    // ── Probe agent CLI health ──
    const agentProbeMatch = path.match(/^\/agents\/([^/]+)\/probe$/);
    if (agentProbeMatch && req.method === 'GET') {
      const agentId = agentProbeMatch[1];
      const agent = agentStore.get(agentId);
      if (!agent) return json(res, { error: 'agent not found' }, 404);

      const result = { agentId, runtimeType: agent.runtimeType || null, runtimePath: agent.runtimePath || null };

      if (!agent.runtimeType || agent.runtimeType === 'builtin') {
        result.probe = 'skip';
        result.message = 'No CLI runtime (builtin/API mode)';
        result.healthy = true;
        return json(res, result);
      }

      if (!agent.runtimePath) {
        result.probe = 'fail';
        result.message = 'runtimePath not set';
        result.healthy = false;
        return json(res, result);
      }

      // Run <cli> --version or --help with a short timeout
      try {
        const { execSync } = await import('node:child_process');
        const versionCmd = `"${agent.runtimePath}" --version`;
        const output = execSync(versionCmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        result.probe = 'ok';
        result.version = output.split('\n')[0].slice(0, 100);
        result.healthy = true;
      } catch (err) {
        // --version failed, try --help
        try {
          const { execSync } = await import('node:child_process');
          const helpCmd = `"${agent.runtimePath}" --help`;
          execSync(helpCmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
          result.probe = 'ok';
          result.version = '(--help ok)';
          result.healthy = true;
        } catch (err2) {
          result.probe = 'fail';
          result.message = err2.message?.slice(0, 200) || 'CLI not responding';
          result.healthy = false;
        }
      }
      return json(res, result);
    }

    // ── Get agent's resolved LLM config ──
    const agentLLMMatch = path.match(/^\/agents\/([^/]+)\/llm$/);
    if (agentLLMMatch && req.method === 'GET') {
      const config = agentStore.resolveLLMConfig(agentLLMMatch[1]);
      return json(res, { agentId: agentLLMMatch[1], llm: config ? { ...config, apiKey: config.apiKey ? '****' : null } : null });
    }

    // ── LLM: list supported providers ──
    if (path === '/llm/providers' && req.method === 'GET') {
      return json(res, { providers: listProviders() });
    }

    // ── LLM: list models for a provider ──
    if (path === '/llm/models' && req.method === 'GET') {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const provider = url.searchParams.get('provider');
      if (!provider) return json(res, { error: 'provider query param required' }, 400);
      const models = modelCatalog.getModels(provider);
      return json(res, { provider, models });
    }

    // ── LLM: get default model for a provider ──
    if (path === '/llm/default-model' && req.method === 'GET') {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const provider = url.searchParams.get('provider');
      if (!provider) return json(res, { error: 'provider query param required' }, 400);
      const model = modelCatalog.getDefaultModel(provider);
      return json(res, { provider, model });
    }

    // ── 404 ──
    return json(res, { error: 'not_found', path }, 404);

  } catch (err) {
    log('error', `API error: ${err.message}`, { path, method: req.method });
    return json(res, { error: err.message }, 500);
  }
}

// ─── Start ────────────────────────────────────────────────────────
const server = http.createServer(handleRequest);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({
    type: 'init',
    projects: hub.listProjects(),
    agents: agentStore.list().map(a => agentStore.redact(a)),
    brokerConnected,
    logs: systemLogs.slice(-50),
  }));
  ws.on('close', () => wsClients.delete(ws));
});

server.listen(PORT, () => {
  log('info', `KSwarm API server started on port ${PORT}`);
  connectBroker();

  // If broker is slow/unavailable, still run local recovery before watchdog.
  setTimeout(() => {
    runStartupRecovery().finally(startWatchdog);
  }, 2_000);
});

function startWatchdog() {
  if (watchdogStarted) return;
  watchdogStarted = true;
  watchdog = createWatchdog({
    listProjects: () => hub.listProjects(),
    getBoard: (id) => hub.getBoard(id),
    onTimeout: (projectId, task, action) => {
      log('warn', `Watchdog: task ${task.id} timed out in project ${projectId}`, action);
      broadcast({ type: 'task_timeout', projectId, taskId: task.id, action });
    },
    intervalMs: 60_000,
    timeoutMs: 600_000,
    maxRetries: 2,
  });
  watchdog.start();
}

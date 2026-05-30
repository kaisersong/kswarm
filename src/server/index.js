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
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { basename, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { listProviders } from '../llm/index.js';
import * as modelCatalog from '../llm/model-catalog.js';
import { createHeartbeatManager } from '../core/heartbeat-manager.js';
import { aggregateDelivery, buildUserFacingDeliveryFiles, selectUserFacingDeliveryTask } from '../core/delivery.js';
import { ensureProjectSummarySection, extractSummaryScore, extractSummarySection, extractTaskScores } from '../core/summary-parser.js';
import { createWatchdog } from '../core/watchdog.js';
import { parseTaskId } from '../core/task-identity.js';
import { planProjectRecovery } from '../core/recovery-planner.js';
import { buildArtifactManifest, readRunJournals } from '../core/recovery-store.js';
import { executeRecoveryAction } from '../core/recovery-executor.js';
import {
  buildPlanRetryAssignPoIntent,
  normalizeProjectForPlanRetry,
  resolvePlanRetryPoAgent,
} from '../core/plan-retry-recovery.js';
import { probeAgentRuntime } from '../core/runtime-probe.js';
import { planStalledRunActions } from '../core/run-watchdog.js';
import { recordRuntimeFailure } from '../core/runtime-health.js';
import {
  deriveProjectPreparation,
  normalizeReadinessProbeResult,
  selectDefaultSeedWorkerReplacement,
} from '../core/agent-readiness.js';
import {
  XIAOK_PO_AGENT_ID,
  XIAOK_WORKER_AGENT_ID,
  createRuntimeInstancePool,
} from '../core/runtime-instance-pool.js';
import { appendQualityPlanningGuidance } from '../core/quality-rules.js';
import { createQualityOverlayStore } from '../core/quality-overlays.js';
import { handleQualityApiRequest } from './quality-api.js';
import {
  getProjectWorkspace as getProjectWorkspaceRecord,
  initProjectWorkspace as initProjectWorkspaceRecord,
  setProjectWorkspace as setProjectWorkspaceRecord,
} from './project-workspace.js';
import { sendTaskToBrokerParticipant } from './broker-task-delivery.js';
import {
  createAutoWorkerSpawnConfig,
  spawnAutoWorkerProcess,
} from './auto-worker-process.js';
import { createArtifactRecord, enrichArtifactRecordFromFile, listArtifactRecords } from './artifact-record.js';
import { canSpawnAutoWorkerForTask } from '../core/runtime-execution-boundary.js';
import { createBrokerTaskRequest } from './broker-task-request.js';
import { normalizeProjectAgentSelection, reconcileProjectAgentSelectionWithEffectiveAgents } from '../core/agent-selection.js';
import { getEffectiveAgentConcurrency } from '../core/effective-agent-concurrency.js';
import { applyBrokerPresenceToAgentProfiles } from '../core/broker-presence.js';

const PORT = Number(process.env.KSWARM_PORT || 4400);
const BROKER_URL = process.env.BROKER_URL || 'http://127.0.0.1:4318';
const SERVICE_FEATURES = [
  'dynamic_workflows',
  'workflow_proposals',
  'workflow_progress_batch',
  'workflow_task_strategy',
  'po_generated_workflow_proposals',
  'workflow_budget_cache_recovery',
];
const runtimeInstancePool = createRuntimeInstancePool();

// Project workspace base — each project gets its own folder
const KSWARM_HOME = join(homedir(), '.kswarm');
const PROJECTS_DIR = join(KSWARM_HOME, 'projects');
mkdirSync(PROJECTS_DIR, { recursive: true });
const qualityOverlayStore = createQualityOverlayStore(join(KSWARM_HOME, 'quality-overlays.json'));

// ─── Hub Instance ─────────────────────────────────────────────────
let agentStore = null;
let brokerOnlineAgentIds = null;
let brokerOnlineAgentIdsUpdatedAt = 0;
let brokerOnlineParticipants = [];
const readinessProbeCache = new Map();
const readinessProbeWaiters = new Map();
const pendingProbeByAgentId = new Map();
const READINESS_PROBE_TIMEOUT_MS = 10_000;
const READINESS_PROBE_TTL_MS = 5 * 60_000;

function listAgentProfilesForRouting() {
  const agents = agentStore?.list({ includeArchived: false }) || [];
  return applyBrokerPresenceToAgentProfiles(agents, brokerOnlineAgentIds);
}

const hub = createHub({
  eventLogDir: join(KSWARM_HOME, 'events'),
  silent: false,
  dataDir: join(KSWARM_HOME, 'state.json'),
  getAgentProfiles: () => listAgentProfilesForRouting(),
  getQualityOverlays: () => qualityOverlayStore.listOverlays(),
  runtimeInstanceAllocator: {
    getAgentConcurrency: () => getEffectiveAgentConcurrency({
      baseConcurrency: runtimeInstancePool.getAgentConcurrency(),
      agents: agentStore?.list({ includeArchived: false }) || [],
    }),
    reserveWorkerInstance: reservation => reserveWorkerRuntimeInstance(reservation),
    markInstanceWorking: (instanceId, meta) => runtimeInstancePool.markInstanceWorking(instanceId, meta),
    markInstanceIdle: instanceId => runtimeInstancePool.markInstanceIdle(instanceId),
    markInstanceFailed: (instanceId, reason) => runtimeInstancePool.markInstanceFailed(instanceId, reason),
  },
});

// ─── Agent Store ──────────────────────────────────────────────────
agentStore = createAgentStore();
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
  const project = hub.getProject(projectId);
  return getProjectWorkspaceRecord(projectWorkspaces, PROJECTS_DIR, projectId, project?.workFolder);
}

function setProjectWorkspace(projectId, newPath) {
  const ws = setProjectWorkspaceRecord(projectWorkspaces, projectId, newPath);
  const project = hub.getProject(projectId);
  if (project) {
    project.workFolder = ws.path;
    hub.persistState();
  }
  return ws;
}

function normalizePersistedProjectPoAgents() {
  const agents = agentStore?.list({ includeArchived: false }) || [];
  let changed = 0;
  for (const project of hub.listProjects()) {
    if (!project || ['closed', 'delivered'].includes(project.status)) continue;
    const resolution = resolvePlanRetryPoAgent(project, agents);
    if (resolution.changed && resolution.poAgent) {
      const previousPoAgent = project.poAgent;
      project.poAgent = resolution.poAgent;
      changed++;
      log('info', 'Project PO normalized to executable runtime', {
        projectId: project.id,
        previousPoAgent,
        poAgent: project.poAgent,
        reason: resolution.reason,
      });
    }
    if (reconcileProjectAgentSelectionWithEffectiveAgents(project)) changed++;
  }
  if (changed > 0) hub.persistState();
}

function listProjectArtifacts(projectId) {
  const ws = getProjectWorkspace(projectId);
  return listArtifactRecords({
    artifactsDir: ws.artifacts,
    projectId,
    getPreviewable,
    mimeTypes: MIME_TYPES,
  });
}

function enrichProjectTaskArtifacts(projectId, tasks) {
  const ws = getProjectWorkspace(projectId);
  return tasks.map(task => {
    const result = task?.result;
    const artifacts = result && typeof result === 'object' && Array.isArray(result.artifacts)
      ? result.artifacts
      : null;
    if (!artifacts) return task;
    return {
      ...task,
      result: {
        ...result,
        artifacts: artifacts.map(artifact => enrichArtifactRecordFromFile({
          artifact,
          artifactsDir: ws.artifacts,
          getPreviewable,
          mimeTypes: MIME_TYPES,
        })),
      },
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

normalizePersistedProjectPoAgents();

// ─── Broker Connection ────────────────────────────────────────────
let brokerConnected = false;
let brokerClient = null;
let recoveryRunning = false;
let watchdogStarted = false;
let watchdog = null;
let stalledRunWatchdogTimer = null;

async function sendBrokerRequestTasks(projectId, taskIds = []) {
  if (!brokerClient || !brokerClient.isConnected() || taskIds.length === 0) return;

  const project = hub.getProject(projectId);
  const board = hub.getBoard(projectId);
  const ws = getProjectWorkspace(projectId);
  const retryTaskIds = [];

  for (const taskId of taskIds) {
    const task = board?.getTask(taskId);
    if (!task?.assignedAgent) continue;
    const targetAgent = task.assignedRuntimeInstance || task.assignedAgent;
    try {
      const taskRequest = createBrokerTaskRequest({
        handoffRoot: join(KSWARM_HOME, 'handoff-packages', projectId),
        project,
        workspace: ws,
        task,
        targetAgent,
      });
      if (!taskRequest.ok) {
        log('warn', `Failed to create task handoff for ${targetAgent}`, {
          projectId,
          taskId: task.id,
          agent: task.assignedAgent,
          runtimeInstance: task.assignedRuntimeInstance || null,
          error: taskRequest.error,
        });
        const failed = hub.handleWorkerFailure(
          projectId,
          task.id,
          targetAgent,
          task.activeRunId,
          'handoff_create_failed',
          taskRequest.error || 'handoff_create_failed',
        );
        if (failed?.retryDispatched && failed.retryTaskId) retryTaskIds.push(failed.retryTaskId);
        continue;
      }
      const delivery = await sendTaskToBrokerParticipant({
        brokerClient,
        targetId: targetAgent,
        kind: 'request_task',
        isOnline: isAgentOnBroker,
        waitTimeoutMs: 8_000,
        waitIntervalMs: 200,
        request: taskRequest.request,
      });
      if (!delivery.ok) {
        log('warn', `Failed to deliver request_task to ${targetAgent}`, {
          projectId,
          taskId: task.id,
          agent: task.assignedAgent,
          runtimeInstance: task.assignedRuntimeInstance || null,
          error: delivery.error,
          delivery: delivery.delivery || null,
        });
        if (!task.assignedRuntimeInstance && task.assignedAgent) {
          agentStore?.setOffline(task.assignedAgent);
        }
        const failed = hub.handleWorkerFailure(
          projectId,
          task.id,
          targetAgent,
          task.activeRunId,
          'runtime_offline',
          delivery.error || 'delivery_failed',
        );
        if (failed?.retryDispatched && failed.retryTaskId) retryTaskIds.push(failed.retryTaskId);
      }
    } catch (err) {
      log('warn', `Failed to send request_task to ${targetAgent}`, { projectId, taskId: task.id, agent: task.assignedAgent, runtimeInstance: task.assignedRuntimeInstance || null, error: err.message });
      if (!task.assignedRuntimeInstance && task.assignedAgent) {
        agentStore?.setOffline(task.assignedAgent);
      }
      const failed = hub.handleWorkerFailure(
        projectId,
        task.id,
        targetAgent,
        task.activeRunId,
        'runtime_offline',
        err.message,
      );
      if (failed?.retryDispatched && failed.retryTaskId) retryTaskIds.push(failed.retryTaskId);
    }
  }

  if (retryTaskIds.length > 0) {
    await sendBrokerRequestTasks(projectId, retryTaskIds);
  }
}

async function sendWorkflowNodeHandoffs(projectId, dispatches = []) {
  if (!Array.isArray(dispatches) || dispatches.length === 0) return [];

  const project = hub.getProject(projectId);
  const ws = getProjectWorkspace(projectId);
  const results = [];

  for (const dispatch of dispatches) {
    const target = dispatch.targetParticipantId;
    if (!target || !brokerClient || !brokerClient.isConnected()) {
      const blocked = hub.handleWorkflowRuntimeUnavailable({
        workflowRunId: dispatch.workflowRunId,
        nodeId: dispatch.nodeId,
        attempt: dispatch.attempt,
        handoffId: dispatch.handoffId,
        reason: target ? 'broker_unavailable' : 'runtime_unavailable',
      });
      results.push(blocked);
      broadcast({ type: 'workflow_run_updated', projectId, workflowRun: blocked.workflowRun });
      continue;
    }

    try {
      const delivery = await brokerClient.sendTo(target, 'workflow_node_handoff', {
        taskId: dispatch.workflowRunId,
        payload: {
          ...dispatch,
          project: project ? {
            id: project.id,
            name: project.name,
            goal: project.goal || '',
            status: project.status,
            workFolder: ws.path,
          } : { id: projectId, workFolder: ws.path },
        },
      });
      results.push({ ok: true, delivery, dispatch });
      broadcast({ type: 'workflow_node_dispatched', projectId, dispatch });
    } catch (err) {
      const blocked = hub.handleWorkflowRuntimeUnavailable({
        workflowRunId: dispatch.workflowRunId,
        nodeId: dispatch.nodeId,
        attempt: dispatch.attempt,
        handoffId: dispatch.handoffId,
        reason: err?.message || 'workflow_handoff_failed',
      });
      results.push(blocked);
      broadcast({ type: 'workflow_run_updated', projectId, workflowRun: blocked.workflowRun });
    }
  }

  return results;
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

async function refreshBrokerOnlineAgentIds() {
  try {
    const res = await fetch(`${BROKER_URL}/participants`);
    if (!res.ok) {
      brokerOnlineAgentIds = null;
      brokerOnlineAgentIdsUpdatedAt = 0;
      brokerOnlineParticipants = [];
      return null;
    }
    const data = await res.json();
    const participants = data.participants || data || [];
    brokerOnlineParticipants = participants;
    brokerOnlineAgentIds = new Set(
      participants
        .filter(p => p.kind === 'agent' && p.inboxMode === 'realtime')
        .map(p => p.participantId)
    );
    brokerOnlineAgentIdsUpdatedAt = Date.now();
    return brokerOnlineAgentIds;
  } catch {
    brokerOnlineAgentIds = null;
    brokerOnlineAgentIdsUpdatedAt = 0;
    brokerOnlineParticipants = [];
    return null;
  }
}

async function getOnlineAgentIds() {
  return await refreshBrokerOnlineAgentIds() || new Set();
}

function selectedAgentIdsForPreparation(project) {
  const ids = [];
  const po = project?.agentSelection?.poAgent?.agentId || project?.poAgent;
  if (po) ids.push({ agentId: po, role: 'project_owner' });
  const members = Array.isArray(project?.agentSelection?.members) && project.agentSelection.members.length > 0
    ? project.agentSelection.members.map(member => member?.agentId || member?.id || member)
    : project?.members || [];
  for (const memberId of members) {
    if (memberId) ids.push({ agentId: memberId, role: 'worker' });
  }
  return ids;
}

function isDesktopRuntimeAgent(agent) {
  return Boolean(agent && (agent.runtimeSource === 'desktop-agent-runtime' || agent.id === XIAOK_PO_AGENT_ID || agent.id === XIAOK_WORKER_AGENT_ID));
}

function getCachedReadinessProbe(agentId, now = Date.now()) {
  const cached = readinessProbeCache.get(agentId);
  if (!cached) return null;
  if (cached.expiresAt && now > cached.expiresAt) {
    readinessProbeCache.delete(agentId);
    return null;
  }
  return cached;
}

async function requestReadinessProbe({ projectId, agentId, role, forceProbe = false } = {}) {
  const now = Date.now();
  const cached = !forceProbe ? getCachedReadinessProbe(agentId, now) : null;
  if (cached) return cached;

  const pending = pendingProbeByAgentId.get(agentId);
  if (pending && !forceProbe && now - pending.startedAt < READINESS_PROBE_TIMEOUT_MS) {
    return pending.promise;
  }

  if (!brokerClient || !brokerClient.isConnected()) {
    const result = normalizeReadinessProbeResult({
      agentId,
      ok: false,
      reason: 'broker_unavailable',
    }, now);
    readinessProbeCache.set(agentId, result);
    return result;
  }

  const probeId = `probe-${projectId || 'project'}-${agentId}-${now}`;
  const promise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      readinessProbeWaiters.delete(probeId);
      pendingProbeByAgentId.delete(agentId);
      const result = normalizeReadinessProbeResult({
        agentId,
        probeId,
        ok: false,
        reason: 'readiness_probe_timeout',
      }, Date.now());
      readinessProbeCache.set(agentId, result);
      resolve(result);
    }, READINESS_PROBE_TIMEOUT_MS);

    readinessProbeWaiters.set(probeId, {
      agentId,
      resolve: result => {
        clearTimeout(timeout);
        readinessProbeWaiters.delete(probeId);
        pendingProbeByAgentId.delete(agentId);
        resolve(result);
      },
    });

    brokerClient.sendTo(agentId, 'readiness_probe', {
      taskId: probeId,
      threadId: `thread-${projectId || probeId}`,
      payload: { probeId, projectId, agentId, role },
    }).catch(error => {
      clearTimeout(timeout);
      readinessProbeWaiters.delete(probeId);
      pendingProbeByAgentId.delete(agentId);
      const result = normalizeReadinessProbeResult({
        agentId,
        probeId,
        ok: false,
        reason: error?.message || 'readiness_probe_send_failed',
      }, Date.now());
      readinessProbeCache.set(agentId, result);
      resolve(result);
    });
  });

  pendingProbeByAgentId.set(agentId, { probeId, startedAt: now, promise });
  return promise;
}

function handleReadinessProbeResult(intent) {
  const payload = intent?.payload || {};
  const now = Date.now();
  const normalized = normalizeReadinessProbeResult({
    ...payload,
    agentId: payload.agentId || intent.fromParticipantId,
    participantId: payload.participantId || intent.fromParticipantId,
    expiresAt: now + READINESS_PROBE_TTL_MS,
  }, now);
  if (normalized.agentId) readinessProbeCache.set(normalized.agentId, normalized);
  const waiter = normalized.probeId ? readinessProbeWaiters.get(normalized.probeId) : null;
  if (waiter && (!waiter.agentId || waiter.agentId === normalized.agentId)) {
    waiter.resolve(normalized);
  }
}

function runtimeCapacityByAgentId() {
  const summary = runtimeInstancePool.summarizeByAgent();
  const concurrency = runtimeInstancePool.getAgentConcurrency();
  const result = {};
  for (const [agentId, item] of Object.entries(summary)) {
    const total = Number(item.total || 0);
    const failed = Number(item.failed || 0);
    const offline = Number(item.offline || 0);
    const idle = Number(item.idle || 0);
    const starting = Number(item.starting || 0);
    const working = Number(item.working || 0);
    const limit = Number(concurrency[agentId] || 0);
    if (total > 0 && failed + offline >= total) {
      result[agentId] = { capacity: 'failed', canCreateRuntimeInstance: limit > total };
    } else if (idle > 0 || starting > 0 || (limit && total < limit)) {
      result[agentId] = { capacity: 'available', canCreateRuntimeInstance: limit ? total < limit : null };
    } else if (working > 0 && limit && working >= limit) {
      result[agentId] = { capacity: 'busy', canCreateRuntimeInstance: false };
    } else {
      result[agentId] = { capacity: 'unknown', canCreateRuntimeInstance: null };
    }
  }
  return result;
}

async function prepareProjectForPlanning(project, { forceProbe = false } = {}) {
  if (!project) return null;
  reconcileProjectAgentSelectionWithEffectiveAgents(project);
  await refreshBrokerOnlineAgentIds();
  const selected = selectedAgentIdsForPreparation(project);
  const agents = listAgentProfilesForRouting();

  for (const selectedAgent of selected) {
    const agent = agents.find(candidate => candidate.id === selectedAgent.agentId) || agentStore?.get(selectedAgent.agentId);
    if (!isDesktopRuntimeAgent(agent)) continue;
    if (!(brokerOnlineAgentIds instanceof Set) || !brokerOnlineAgentIds.has(selectedAgent.agentId)) continue;
    await requestReadinessProbe({
      projectId: project.id,
      agentId: selectedAgent.agentId,
      role: selectedAgent.role,
      forceProbe,
    });
  }

  const probeResults = {};
  for (const { agentId } of selected) {
    const cached = getCachedReadinessProbe(agentId, Date.now());
    if (cached) probeResults[agentId] = cached;
  }

  const capacityByAgentId = runtimeCapacityByAgentId();
  project.preparation = deriveProjectPreparation({
    project,
    agents,
    participants: brokerOnlineParticipants,
    probeResults,
    capacityByAgentId,
    now: Date.now(),
  });
  if (project.preparation?.state === 'blocked') {
    const workerAgent = agents.find(candidate => candidate.id === XIAOK_WORKER_AGENT_ID) || agentStore?.get(XIAOK_WORKER_AGENT_ID);
    if (
      isDesktopRuntimeAgent(workerAgent) &&
      brokerOnlineAgentIds instanceof Set &&
      brokerOnlineAgentIds.has(XIAOK_WORKER_AGENT_ID)
    ) {
      await requestReadinessProbe({
        projectId: project.id,
        agentId: XIAOK_WORKER_AGENT_ID,
        role: 'worker',
        forceProbe,
      });
      const cachedWorkerProbe = getCachedReadinessProbe(XIAOK_WORKER_AGENT_ID, Date.now());
      if (cachedWorkerProbe) probeResults[XIAOK_WORKER_AGENT_ID] = cachedWorkerProbe;
    }
    const replacement = selectDefaultSeedWorkerReplacement({
      project,
      preparation: project.preparation,
      agents,
      participants: brokerOnlineParticipants,
      probeResults,
      capacityByAgentId,
      now: Date.now(),
    });
    if (replacement?.toAgentId) {
      project.members = [replacement.toAgentId];
      project.agentSelection = project.agentSelection || {};
      project.agentSelection.members = [{ agentId: replacement.toAgentId, source: replacement.source || 'default_seed' }];
      project.agentSelection.replacements = Array.isArray(project.agentSelection.replacements)
        ? project.agentSelection.replacements
        : [];
      project.agentSelection.replacements.push({
        at: Date.now(),
        role: replacement.role,
        fromAgentIds: replacement.fromAgentIds,
        toAgentId: replacement.toAgentId,
        reason: replacement.reason,
      });
      project.preparation = deriveProjectPreparation({
        project,
        agents,
        participants: brokerOnlineParticipants,
        probeResults,
        capacityByAgentId,
        now: Date.now(),
      });
    }
  }
  project.updatedAt = Date.now();
  hub.persistState();
  return project.preparation;
}

async function ensureProjectAgentsStarted(project) {
  if (!project?.poAgent) return { poTarget: null };
  let poTarget = project.poAgent;
  if (isDefaultRuntimePo(project.poAgent)) {
    const ensuredPo = ensureProjectPoRuntime(project);
    if (ensuredPo.ok) poTarget = ensuredPo.instanceId;
    else log('warn', 'Failed to ensure project PO runtime', { projectId: project.id, poAgent: project.poAgent, error: ensuredPo.error });
  } else {
    await autoStartAgent(project.poAgent);
  }
  for (const agentId of project.members || []) {
    if (!isDefaultRuntimeWorker(agentId)) await autoStartAgent(agentId);
  }
  return { poTarget };
}

async function sendAssignPoForProject(project, { delayMs = 0 } = {}) {
  if (!project?.poAgent || !brokerClient || !brokerClient.isConnected()) return { sent: false, reason: 'broker_unavailable' };
  const { poTarget } = await ensureProjectAgentsStarted(project);
  if (!poTarget) return { sent: false, reason: 'po_target_missing' };
  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  await brokerClient.sendTo(poTarget, 'assign_po', {
    taskId: project.id,
    threadId: `thread-${project.id}`,
    payload: {
      projectId: project.id,
      projectName: project.name,
      goal: project.goal || '',
      requirements: project.requirements || '',
      planningGuidance: appendQualityPlanningGuidance(project.planningGuidance || '', project.qualityPlanningGuidance || ''),
      members: project.members || [],
    },
  });
  return { sent: true, poTarget };
}

async function sendRecoveryReviewSubmission({ projectId, taskId, fromWorker, result }) {
  const project = hub.getProject(projectId);
  if (!brokerClient || !brokerClient.isConnected() || !project?.poAgent) return;
  await brokerClient.sendTo(getProjectPoTarget(project), 'review_submission', {
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
    case 'readiness_probe_result': {
      handleReadinessProbeResult(intent);
      log('info', 'Readiness probe result received', {
        fromParticipantId,
        probeId: payload?.probeId,
        ok: payload?.ok,
        reason: payload?.reason || null,
      });
      break;
    }
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
      const result = hub.handleProgress(resolved.projectId, resolved.taskId, payload?.stage, fromParticipantId, payload?.runId, payload?.telemetry);
      if (!result.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, { ...result, projectId: resolved.projectId });
      log('info', `Progress on task: ${resolved.taskId}`, { stage: payload?.stage, worker: fromParticipantId, projectId: resolved.projectId });
      broadcast({ type: 'task_update', projectId: resolved.projectId, taskId: resolved.taskId, status: 'in_progress', stage: payload?.stage, agent: fromParticipantId });
      break;
    }
    case 'task_failed': {
      const resolved = resolveIncomingTask(taskId, payload);
      if (!resolved.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, resolved);
      recordAgentRuntimeFailure(fromParticipantId, payload?.failureReason, payload?.errorMessage);
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
      if (result.retryDispatched && result.retryTaskId) {
        sendBrokerRequestTasks(resolved.projectId, [result.retryTaskId]).catch(() => {});
      }
      break;
    }
    case 'submit_result': {
      const resolved = resolveIncomingTask(taskId, payload);
      if (!resolved.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, resolved);
      const result = hub.handleSubmitResult(resolved.projectId, resolved.taskId, payload, fromParticipantId, payload?.runId);
      if (!result.ok) {
        recordAgentRuntimeFailure(fromParticipantId, result.failureClass, result.errors?.join('; ') || result.error);
        return emitTaskIntentError(kind, taskId, fromParticipantId, { ...result, projectId: resolved.projectId });
      }
      log('info', `Task submitted: ${resolved.taskId}`, { worker: fromParticipantId, projectId: resolved.projectId });
      broadcast({ type: 'task_update', projectId: resolved.projectId, taskId: resolved.taskId, status: 'submitted', agent: fromParticipantId });

      // Notify PO to review this submission
      const project = hub.getProject(resolved.projectId);
      if (brokerClient && brokerClient.isConnected() && project?.poAgent && !result.alreadySubmitted) {
        brokerClient.sendTo(getProjectPoTarget(project), 'review_submission', {
          taskId: resolved.taskId,
          payload: { projectId: resolved.projectId, taskId: resolved.taskId, fromWorker: fromParticipantId, result: payload },
        }).catch(() => {});
      }
      break;
    }
    case 'workflow_node_progress': {
      const projectId = payload?.projectId;
      if (!projectId || !payload?.workflowRunId || !payload?.nodeId) {
        return emitTaskIntentError(kind, taskId, fromParticipantId, { error: 'workflow_progress_missing_identity', projectId });
      }
      log('info', `Workflow node progress: ${payload.nodeId}`, { projectId, workflowRunId: payload.workflowRunId, fromParticipantId, stage: payload.stage });
      broadcast({ type: 'workflow_node_progress', projectId, workflowRunId: payload.workflowRunId, nodeId: payload.nodeId, stage: payload.stage, agent: fromParticipantId });
      break;
    }
    case 'workflow_progress_batch': {
      const batch = {
        ...payload,
        fromParticipantId: payload?.fromParticipantId || fromParticipantId,
      };
      const projectId = batch.projectId;
      if (!projectId || !batch.workflowRunId) {
        return emitTaskIntentError(kind, taskId, fromParticipantId, { error: 'workflow_progress_missing_identity', projectId });
      }
      const result = hub.handleWorkflowProgressBatch(batch.workflowRunId, batch);
      if (!result.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, { ...result, projectId });
      log('info', `Workflow progress batch accepted`, {
        projectId,
        workflowRunId: batch.workflowRunId,
        fromParticipantId,
        sequence: batch.sequence,
        duplicate: Boolean(result.duplicate),
      });
      broadcast({ type: 'workflow_progress_batch', projectId, workflowRun: result.workflowRun, duplicate: Boolean(result.duplicate) });
      break;
    }
    case 'workflow_node_result': {
      const projectId = payload?.projectId;
      if (!projectId || !payload?.workflowRunId || !payload?.nodeId) {
        return emitTaskIntentError(kind, taskId, fromParticipantId, { error: 'workflow_result_missing_identity', projectId });
      }
      const common = {
        workflowRunId: payload.workflowRunId,
        nodeId: payload.nodeId,
        attempt: payload.attempt,
        handoffId: payload.handoffId,
        fromAgent: fromParticipantId,
        output: payload.output || payload.result || null,
      };
      const result = payload.reviewDecision
        ? hub.handleWorkflowNodeReview({ ...common, reviewDecision: payload.reviewDecision })
        : hub.handleWorkflowNodeResult(common);
      if (!result.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, { ...result, projectId });
      log('info', `Workflow node result accepted: ${payload.nodeId}`, { projectId, workflowRunId: payload.workflowRunId, fromParticipantId });
      broadcast({ type: 'workflow_run_updated', projectId, workflowRun: result.workflowRun });
      if (result.dispatches?.length > 0) {
        sendWorkflowNodeHandoffs(projectId, result.dispatches).catch(() => {});
      }
      break;
    }
    case 'workflow_node_failed': {
      const projectId = payload?.projectId;
      if (!projectId || !payload?.workflowRunId || !payload?.nodeId) {
        return emitTaskIntentError(kind, taskId, fromParticipantId, { error: 'workflow_failure_missing_identity', projectId });
      }
      const result = hub.handleWorkflowRuntimeUnavailable({
        workflowRunId: payload.workflowRunId,
        nodeId: payload.nodeId,
        attempt: payload.attempt,
        handoffId: payload.handoffId,
        reason: payload.failureReason || payload.errorMessage || 'workflow_node_failed',
      });
      if (!result.ok) return emitTaskIntentError(kind, taskId, fromParticipantId, { ...result, projectId });
      broadcast({ type: 'workflow_run_updated', projectId, workflowRun: result.workflowRun });
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

function buildAgentChildEnv(agent, agentId, runtime = {}) {
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
  if (runtime.logicalAgentId) childEnv.KSWARM_LOGICAL_AGENT_ID = runtime.logicalAgentId;
  if (runtime.projectId) childEnv.KSWARM_PROJECT_ID = runtime.projectId;
  return childEnv;
}

function autoWorkerSpawnConfig(agentId, alias, customArgs = [], env = process.env) {
  return createAutoWorkerSpawnConfig({
    scriptPath: join(import.meta.dirname, '../../scripts/auto-worker.js'),
    agentId,
    alias,
    customArgs,
    cwd: join(import.meta.dirname, '../..'),
    env,
  });
}

function isDefaultRuntimeWorker(agentId) {
  return agentId === XIAOK_WORKER_AGENT_ID;
}

function isDefaultRuntimePo(agentId) {
  return agentId === XIAOK_PO_AGENT_ID;
}

function shouldUseRuntimePool(agent) {
  return Boolean(agent && !agent.archivedAt && agent.runtimeType === 'xiaok');
}

function spawnRuntimeInstance(instance, logicalAgent) {
  if (!instance || !logicalAgent) return { ok: false, error: 'runtime_instance_missing' };
  const boundary = canSpawnAutoWorkerForTask({
    agent: logicalAgent,
    taskKind: 'user_task',
  });
  if (!boundary.ok) {
    runtimeInstancePool.markInstanceFailed(instance.instanceId, boundary.error);
    log('warn', `Refusing local auto-worker for ${instance.instanceId}: ${boundary.error}`, {
      logicalAgentId: logicalAgent.id,
      runtimeSource: logicalAgent.runtimeSource || null,
    });
    return { ok: false, error: boundary.error, instanceId: instance.instanceId };
  }
  if (instance.pid && instance.status !== 'failed' && instance.status !== 'offline') {
    return { ok: true, instanceId: instance.instanceId, pid: instance.pid, alreadyRunning: true };
  }

  const childEnv = buildAgentChildEnv(logicalAgent, instance.instanceId, {
    logicalAgentId: logicalAgent.id,
    projectId: instance.role === 'project_owner' ? instance.projectId : undefined,
  });
  const spawned = spawnAutoWorkerProcess(
    autoWorkerSpawnConfig(instance.instanceId, logicalAgent.name, logicalAgent.customArgs || [], childEnv),
    {
      onError: err => {
        runtimeInstancePool.markInstanceFailed(instance.instanceId, err.message);
        log('error', `Runtime instance process error for ${instance.instanceId}: ${err.message}`);
      },
    },
  );
  if (!spawned.ok) {
    runtimeInstancePool.markInstanceFailed(instance.instanceId, spawned.error);
    log('error', `Failed to spawn runtime instance ${instance.instanceId}: ${spawned.error}`);
    return spawned;
  }
  if (spawned.child && typeof spawned.child.once === 'function') {
    spawned.child.once('exit', (code, signal) => {
      runtimeInstancePool.markInstanceOffline(instance.instanceId);
      broadcast({ type: 'runtime_instance_stopped', instanceId: instance.instanceId, code, signal });
      log('warn', `Runtime instance exited: ${instance.instanceId}`, { code, signal });
    });
  }

  const runtimeId = `pid-${spawned.pid}`;
  runtimeInstancePool.markInstanceOnline(instance.instanceId, {
    pid: spawned.pid,
    runtimeId,
    status: instance.role === 'worker' ? 'idle' : 'idle',
  });
  log('info', `Started runtime instance: ${instance.instanceId}`, {
    logicalAgentId: instance.logicalAgentId,
    role: instance.role,
    projectId: instance.projectId,
    pid: spawned.pid,
    runtimeId,
  });
  broadcast({
    type: 'runtime_instance_started',
    instanceId: instance.instanceId,
    logicalAgentId: instance.logicalAgentId,
    role: instance.role,
    projectId: instance.projectId,
    runtimeId,
    pid: spawned.pid,
  });
  return { ok: true, instanceId: instance.instanceId, pid: spawned.pid, runtimeId };
}

function ensureProjectPoRuntime(project) {
  if (!project?.poAgent || !isDefaultRuntimePo(project.poAgent)) {
    return { ok: false, error: 'not_pooled_agent' };
  }
  const agent = agentStore?.get(project.poAgent);
  if (!shouldUseRuntimePool(agent)) {
    return { ok: false, error: agent ? 'not_pooled_agent' : 'agent_not_found' };
  }
  const boundary = canSpawnAutoWorkerForTask({ agent, taskKind: 'user_task' });
  if (!boundary.ok && boundary.error === 'desktop_runtime_required') {
    return { ok: false, error: 'not_pooled_agent' };
  }

  const ensured = runtimeInstancePool.ensureProjectPoInstance(project.poAgent, project.id);
  if (!ensured.ok) return ensured;
  const spawned = spawnRuntimeInstance(ensured.instance, agent);
  if (!spawned.ok) return { ok: false, error: spawned.error || 'spawn_failed', instanceId: ensured.instanceId };
  return { ok: true, instanceId: ensured.instanceId, created: ensured.created };
}

function getProjectPoTarget(project) {
  const ensured = ensureProjectPoRuntime(project);
  return ensured.ok ? ensured.instanceId : project?.poAgent;
}

function reserveWorkerRuntimeInstance({ task } = {}) {
  if (!task?.assignedAgent || !isDefaultRuntimeWorker(task.assignedAgent)) {
    return { ok: false, error: 'not_pooled_agent' };
  }
  const agent = agentStore?.get(task.assignedAgent);
  if (!shouldUseRuntimePool(agent)) {
    return { ok: false, error: agent ? 'not_pooled_agent' : 'agent_not_found' };
  }
  const boundary = canSpawnAutoWorkerForTask({ agent, taskKind: 'user_task' });
  if (!boundary.ok && boundary.error === 'desktop_runtime_required') {
    return { ok: false, error: 'not_pooled_agent' };
  }

  const ensured = runtimeInstancePool.ensureWorkerInstance(task.assignedAgent);
  if (!ensured.ok) return ensured;
  const spawned = spawnRuntimeInstance(ensured.instance, agent);
  if (!spawned.ok) return { ok: false, error: spawned.error || 'spawn_failed', instanceId: ensured.instanceId };
  runtimeInstancePool.markInstanceWorking(ensured.instanceId, { taskId: task.id });
  return { ok: true, instanceId: ensured.instanceId, created: ensured.created };
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
  const boundary = canSpawnAutoWorkerForTask({
    agent,
    taskKind: 'user_task',
  });
  if (!boundary.ok) {
    log('warn', `autoStartAgent refused local auto-worker for ${agentId}: ${boundary.error}`, {
      runtimeSource: agent.runtimeSource || null,
    });
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
    const childEnv = buildAgentChildEnv(agent, agentId);
    const spawned = spawnAutoWorkerProcess(autoWorkerSpawnConfig(agentId, agent.name, agent.customArgs || [], childEnv), {
      onError: err => {
        agentStore.setOffline(agentId);
        log('error', `Auto-worker process error for ${agentId}: ${err.message}`);
      },
    });
    if (!spawned.ok) {
      agentStore.setOffline(agentId);
      log('error', `Failed to auto-start agent ${agentId}: ${spawned.error}`);
      return false;
    }

    const runtimeId = `pid-${spawned.pid}`;
    agentStore.setOnline(agentId, runtimeId);

    log('info', `Auto-started agent: ${agent.name} (${agentId})`, { pid: spawned.pid, runtimeId });
    broadcast({ type: 'agent_started', agentId, runtimeId, pid: spawned.pid });
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
      return json(res, { ok: true, brokerConnected, projects: hub.listProjects().length, features: SERVICE_FEATURES });
    }

    if (path.startsWith('/quality/')) {
      const body = req.method === 'POST' ? await parseBody(req) : null;
      const result = handleQualityApiRequest({
        method: req.method,
        path,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
        hub,
        overlayStore: qualityOverlayStore,
      });
      if (result.handled) return json(res, result.body, result.status);
    }

    // ── Projects list ──
    if (path === '/projects' && req.method === 'GET') {
      const projects = hub.listProjects().map(p => {
        const board = hub.getBoard(p.id);
        const tasks = board ? board.getAllTasks() : [];
        const done = tasks.filter(t => t.status === 'done').length;
        const stopped = tasks.filter(t => ['failed', 'blocked', 'cancelled'].includes(t.status)).length;
        return {
          ...p,
          taskCount: tasks.length,
          doneCount: done,
          stoppedCount: stopped,
          updatedAt: p.updatedAt || p.createdAt || 0,
          projectIntervention: hub.getProjectIntervention(p.id),
          latestWorkflowRun: hub.listProjectWorkflowRuns(p.id)[0] || null,
        };
      }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return json(res, { projects });
    }

    // ── Create project (Human action) ──
    if (path === '/projects' && req.method === 'POST') {
      const body = await parseBody(req);
      const { name, goal, requirements, planningGuidance, poAgent, members, workFolder, enableSummary, agentSelection, executionMode } = body;
      if (!name || !poAgent) return json(res, { error: 'name and poAgent required' }, 400);
      const resolvedPoAgent = poAgent;
      const resolvedMembers = Array.isArray(members) ? members.filter(memberId => memberId !== resolvedPoAgent) : [];
      const normalizedAgentSelection = normalizeProjectAgentSelection({
        poAgent: resolvedPoAgent,
        members: resolvedMembers,
        agentSelection,
        defaultSource: 'default_seed',
      });
      const id = `proj-${Date.now()}`;
      const project = hub.createProject({ id, name, goal: goal || '', requirements: requirements || '', planningGuidance: planningGuidance || '', poAgent: resolvedPoAgent, members: resolvedMembers, enableSummary, agentSelection: normalizedAgentSelection, executionMode });
      
      // Initialize workspace
      const ws = initProjectWorkspace(id, workFolder);
      project.workFolder = ws.path;

      await ensureProjectAgentsStarted(project);
      const preparation = await prepareProjectForPlanning(project);
      let planningStart = { sent: false, reason: 'preparation_blocked' };
      if (preparation?.state === 'ready') {
        planningStart = await sendAssignPoForProject(project, { delayMs: 0 })
          .catch(err => ({ sent: false, reason: err.message || 'assign_po_failed' }));
      }

      log('info', `Project created: ${name}`, {
        id,
        po: resolvedPoAgent,
        requestedPo: poAgent,
        poReassigned: false,
        workspace: ws.path,
        preparationState: project.preparation?.state || null,
        planningStart,
      });
      broadcast({ type: 'project_created', project });

      return json(res, { ok: true, project }, 201);
    }

    const executionModeMatch = path.match(/^\/projects\/([^/]+)\/execution-mode$/);
    if (executionModeMatch && req.method === 'PATCH') {
      const projectId = executionModeMatch[1];
      const body = await parseBody(req);
      const result = hub.updateProjectExecutionMode(projectId, body?.executionMode, {
        updatedBy: body?.updatedBy || 'human',
      });
      if (result.ok) {
        broadcast({ type: 'project_execution_mode_updated', projectId, project: result.project });
      }
      return json(res, result, result.ok ? 200 : result.error === 'project_not_found' ? 404 : 400);
    }

    // ── Project detail ──
    const projectMatch = path.match(/^\/projects\/([^/]+)$/);
    if (projectMatch && req.method === 'GET') {
      const project = hub.getProject(projectMatch[1]);
      if (!project) return json(res, { error: 'not_found' }, 404);
      const board = hub.getBoard(project.id);
      const tasks = board ? enrichProjectTaskArtifacts(project.id, board.getAllTasks()) : [];
      const activities = hub.getEventLog().getEvents().filter(e => e.projectId === project.id);
      const humanActions = hub.getHumanActions(project.id);
      const ws = getProjectWorkspace(project.id);
      const artifacts = listProjectArtifacts(project.id);
      const planProgress = board ? board.getPlanProgress() : null;
      const dispatchPlan = hub.getDispatchPlan(project.id);
      const projectHealth = hub.getProjectHealth(project.id);
      const projectIntervention = hub.getProjectIntervention(project.id);
      const workflowRuns = hub.listProjectWorkflowRuns(project.id);
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
        projectIntervention,
        workflowRuns,
      });
    }

    // ── Project workflow runs ──
    const projectWorkflowsMatch = path.match(/^\/projects\/([^/]+)\/workflows$/);
    if (projectWorkflowsMatch && req.method === 'GET') {
      const project = hub.getProject(projectWorkflowsMatch[1]);
      if (!project) return json(res, { error: 'not_found' }, 404);
      return json(res, { workflowRuns: hub.listProjectWorkflowRuns(project.id) });
    }

    const projectWorkflowRunMatch = path.match(/^\/projects\/([^/]+)\/workflows\/([^/]+)$/);
    if (projectWorkflowRunMatch && req.method === 'GET') {
      const project = hub.getProject(projectWorkflowRunMatch[1]);
      if (!project) return json(res, { error: 'not_found' }, 404);
      const workflowRun = hub.getWorkflowRun(projectWorkflowRunMatch[2]);
      if (!workflowRun || workflowRun.projectId !== project.id) return json(res, { error: 'not_found' }, 404);
      return json(res, { workflowRun });
    }

    const workflowProposalMatch = path.match(/^\/projects\/([^/]+)\/workflows\/([^/]+)\/proposal$/);
    if (workflowProposalMatch && req.method === 'POST') {
      const [, projectId, workflowId] = workflowProposalMatch;
      const body = await parseBody(req);
      const result = hub.createWorkflowProposal(projectId, workflowId, {
        requestedBy: body?.requestedBy || 'human',
        policy: body?.policy || null,
        taskId: body?.taskId || null,
      });
      return json(res, result, result.ok ? 201 : 400);
    }

    const workflowRunStartMatch = path.match(/^\/projects\/([^/]+)\/workflows\/([^/]+)\/runs$/);
    if (workflowRunStartMatch && req.method === 'POST') {
      const [, projectId, workflowId] = workflowRunStartMatch;
      const body = await parseBody(req);
      const result = hub.startWorkflowRunFromProposal(body?.proposalId, {
        approvedBy: body?.approvedBy || body?.requestedBy || 'human',
        projectId,
        workflowId,
        taskId: body?.taskId || null,
        policy: body?.policy || null,
      });
      if (result.ok) {
        broadcast({ type: 'workflow_run_started', projectId, workflowRun: result.workflowRun });
        await sendWorkflowNodeHandoffs(projectId, result.dispatches);
        const workflowRun = hub.getWorkflowRun(result.workflowRun.id) || result.workflowRun;
        return json(res, { ...result, workflowRun }, 201);
      }
      return json(res, result, result.error === 'workflow_proposal_not_found' ? 404 : 400);
    }

    const workflowRunProgressMatch = path.match(/^\/projects\/([^/]+)\/workflows\/([^/]+)\/progress$/);
    if (workflowRunProgressMatch && req.method === 'POST') {
      const [, projectId, workflowRunId] = workflowRunProgressMatch;
      const body = await parseBody(req);
      const batch = body?.batch || body;
      const existingRun = hub.getWorkflowRun(workflowRunId);
      if (!existingRun) return json(res, { ok: false, error: 'workflow_run_not_found' }, 404);
      if (existingRun.projectId !== projectId) return json(res, { ok: false, error: 'workflow_progress_project_mismatch' }, 400);
      const result = hub.handleWorkflowProgressBatch(workflowRunId, batch);
      if (result.ok) {
        broadcast({ type: 'workflow_progress_batch', projectId, workflowRun: result.workflowRun, duplicate: Boolean(result.duplicate) });
        return json(res, result, result.duplicate ? 200 : 202);
      }
      return json(res, result, result.error === 'workflow_run_not_found' ? 404 : 400);
    }

    const workflowRunCancelMatch = path.match(/^\/projects\/([^/]+)\/workflows\/([^/]+)\/cancel$/);
    if (workflowRunCancelMatch && req.method === 'POST') {
      const [, projectId, workflowRunId] = workflowRunCancelMatch;
      const body = await parseBody(req);
      const result = hub.cancelWorkflowRun(workflowRunId, {
        reason: body?.reason || 'human_cancelled',
      });
      if (result.ok) broadcast({ type: 'workflow_run_updated', projectId, workflowRun: result.workflowRun });
      return json(res, result, result.ok ? 200 : 404);
    }

    const diagnoseWorkflowMatch = path.match(/^\/projects\/([^/]+)\/workflows\/project-diagnose$/);
    if (diagnoseWorkflowMatch && req.method === 'POST') {
      const projectId = diagnoseWorkflowMatch[1];
      const body = await parseBody(req);
      const result = hub.startProjectDiagnoseWorkflow(projectId, {
        requestedBy: body?.requestedBy || 'human',
      });
      if (result.ok) {
        log('info', `Project diagnose workflow completed`, {
          projectId,
          workflowRunId: result.workflowRun.id,
          recommendedAction: result.workflowRun.diagnosis?.recommendedActions?.[0]?.id || null,
        });
        broadcast({ type: 'workflow_run_completed', projectId, workflowRun: result.workflowRun });
      }
      return json(res, result, result.ok ? 201 : 404);
    }

    const agentSmokeWorkflowMatch = path.match(/^\/projects\/([^/]+)\/workflows\/agent-review-smoke$/);
    if (agentSmokeWorkflowMatch && req.method === 'POST') {
      const projectId = agentSmokeWorkflowMatch[1];
      const body = await parseBody(req);
      const result = hub.startAgentReviewSmokeWorkflow(projectId, {
        requestedBy: body?.requestedBy || 'human',
      });
      if (result.ok) {
        log('info', `Agent review smoke workflow started`, {
          projectId,
          workflowRunId: result.workflowRun.id,
          dispatches: result.dispatches?.length || 0,
        });
        broadcast({ type: 'workflow_run_started', projectId, workflowRun: result.workflowRun });
        await sendWorkflowNodeHandoffs(projectId, result.dispatches);
        const workflowRun = hub.getWorkflowRun(result.workflowRun.id) || result.workflowRun;
        return json(res, { ...result, workflowRun }, 201);
      }
      return json(res, result, 404);
    }

    // ── Project preparation gate ──
    const prepareMatch = path.match(/^\/projects\/([^/]+)\/prepare$/);
    if (prepareMatch && req.method === 'POST') {
      const body = await parseBody(req);
      const project = hub.getProject(prepareMatch[1]);
      if (!project) return json(res, { ok: false, error: 'project_not_found' }, 404);
      const preparation = await prepareProjectForPlanning(project, { forceProbe: Boolean(body?.forceProbe) });
      let startedPlanning = false;
      let planningStart = null;
      if (preparation?.state === 'ready' && project.status === 'created' && !project.plan) {
        planningStart = await sendAssignPoForProject(project).catch(err => ({ sent: false, reason: err.message || 'assign_po_failed' }));
        startedPlanning = Boolean(planningStart?.sent);
      }
      broadcast({ type: 'project_prepared', projectId: project.id, preparation, startedPlanning });
      return json(res, { ok: true, preparation, startedPlanning, planningStart });
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

    // ── Project continue (Human action) ──
    const continueMatch = path.match(/^\/projects\/([^/]+)\/continue$/);
    if (continueMatch && req.method === 'POST') {
      const projectId = continueMatch[1];
      const body = await parseBody(req);
      await refreshBrokerOnlineAgentIds();
      const result = hub.handleContinueProject(projectId, body || {});
      if (result.ok) {
        log('info', `Project continue requested`, {
          projectId,
          strategy: result.strategy,
          dispatched: result.dispatched || [],
        });
        broadcast({ type: 'project_continue', projectId, result });
        if ((result.recovered || result.reviewNotificationNeeded) && result.taskId) {
          const project = hub.getProject(projectId);
          const task = hub.getBoard(projectId)?.getTask(result.taskId);
          const fromWorker = result.fromWorker || task?.recoveredBy || task?.assignedAgent || 'continue_project';
          if (brokerClient && brokerClient.isConnected() && project?.poAgent) {
            try {
              await brokerClient.sendTo(getProjectPoTarget(project), 'review_submission', {
                taskId: result.taskId,
                payload: { projectId, taskId: result.taskId, fromWorker, result: result.result },
              });
              result.reviewNotification = 'sent';
            } catch (err) {
              result.reviewNotification = 'failed';
              result.reviewNotificationError = String(err?.message || err);
              log('warn', `Failed to send review_submission on project continue`, {
                projectId,
                taskId: result.taskId,
                poAgent: project?.poAgent,
                error: result.reviewNotificationError,
              });
            }
          } else {
            result.reviewNotification = 'not_available';
          }
        }
        if ((result.dispatched || []).length > 0) {
          await sendBrokerRequestTasks(projectId, result.dispatched || []);
        }
      }
      return json(res, result, result.status || (result.ok ? 200 : 400));
    }

    // ── Resolve project intervention with a repaired artifact ──
    const resolveInterventionMatch = path.match(/^\/projects\/([^/]+)\/intervention\/resolve$/);
    if (resolveInterventionMatch && req.method === 'POST') {
      const projectId = resolveInterventionMatch[1];
      const body = await parseBody(req);
      const ws = getProjectWorkspace(projectId);
      const project = hub.getProject(projectId);
      const canNotifyReview = Boolean(brokerClient && brokerClient.isConnected() && project?.poAgent);
      const result = hub.handleResolveProjectIntervention(projectId, body || {}, {
        writeArtifact: artifact => {
          if (artifact?.path || artifact?.relativePath || artifact?.artifactPath) {
            const [manifest] = buildArtifactManifest(ws.path, [artifact.path || artifact.relativePath || artifact.artifactPath], {
              projectId,
              taskId: body?.expectedPrimaryTaskId,
              role: artifact.role || 'primary',
              producedBy: { agentId: body?.fromAgent || 'human', source: 'xiaok_intervention' },
            });
            return { ok: true, ...manifest };
          }
          return { ok: false, error: 'inline_content_forbidden', status: 400 };
        },
        sendReviewSubmission: canNotifyReview ? ({ taskId, payload }) => {
          const poTarget = getProjectPoTarget(project);
          brokerClient.sendTo(poTarget, 'review_submission', { taskId, payload }).catch(err => {
            log('warn', `Failed to send review_submission to ${poTarget}`, { projectId, taskId, poAgent: project.poAgent, error: err.message });
          });
        } : null,
      });
      if (result.ok) {
        log('info', `Project intervention resolved`, {
          projectId,
          taskId: result.taskId,
          resolution: result.resolution,
          reviewNotification: result.reviewNotification,
        });
        broadcast({
          type: 'task_update',
          projectId,
          taskId: result.taskId,
          status: 'submitted',
          recovered: true,
          reviewNotification: result.reviewNotification,
        });
      }
      return json(res, result, result.status || (result.ok ? 200 : 400));
    }

    // ── Project approve (Human action) ──
    const approveMatch = path.match(/^\/projects\/([^/]+)\/approve$/);
    if (approveMatch && req.method === 'POST') {
      const projectForApproval = hub.getProject(approveMatch[1]);
      if (!projectForApproval) return json(res, { ok: false, error: 'project_not_found' }, 404);
      if (projectForApproval.status !== 'active') {
        const preparation = await prepareProjectForPlanning(projectForApproval);
        if (preparation?.state !== 'ready') {
          return json(res, {
            ok: false,
            error: 'project_preparation_required',
            preparation,
          }, 409);
        }
      }
      const result = hub.handleApprove(approveMatch[1]);
      if (result.ok) {
        if (result.alreadyActive) {
          log('info', `Project already active, skipping re-approval: ${approveMatch[1]}`);
        } else {
          log('info', `Project approved by Human: ${approveMatch[1]}`);
          broadcast({ type: 'project_approved', projectId: approveMatch[1] });

          // Ensure PO and member agents are running (no-op if already online)
          const project = hub.getProject(approveMatch[1]);
          let poTarget = project?.poAgent;
          if (project?.poAgent) {
            if (isDefaultRuntimePo(project.poAgent)) {
              const ensuredPo = ensureProjectPoRuntime(project);
              if (ensuredPo.ok) poTarget = ensuredPo.instanceId;
              else log('warn', 'Failed to ensure project PO runtime on approval', { projectId: project.id, poAgent: project.poAgent, error: ensuredPo.error });
            } else {
              await autoStartAgent(project.poAgent);
            }
            for (const memberId of (project.members || [])) {
              if (!isDefaultRuntimeWorker(memberId)) await autoStartAgent(memberId);
            }
          }

          // Notify PO that plan is approved — start execution
          if (brokerClient && brokerClient.isConnected() && poTarget) {
            await new Promise(r => setTimeout(r, 500));
            brokerClient.sendTo(poTarget, 'respond_approval', {
              taskId: approveMatch[1],
              threadId: `thread-${approveMatch[1]}`,
              payload: {
                projectId: approveMatch[1],
                decision: 'approved',
              },
            }).catch(err => log('warn', 'Failed to notify PO of approval', { target: poTarget, error: err.message }));
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
      const board = hub.getBoard(projectId);
      const normalized = normalizeProjectForPlanRetry(project, board?.getAllTasks() || []);
      if (!normalized.ok) return json(res, { ok: false, error: normalized.error }, 409);
      let poResolution = resolvePlanRetryPoAgent(project, agentStore.list({ includeArchived: false }));
      const originalPoAgent = poResolution.previousPoAgent;
      if (poResolution.changed && poResolution.poAgent) {
        project.poAgent = poResolution.poAgent;
      }
      project.agentSelection = normalizeProjectAgentSelection({
        poAgent: project.poAgent,
        members: project.members || [],
        agentSelection: project.agentSelection || null,
      });
      if (poResolution.changed && project.agentSelection?.poAgent) {
        project.agentSelection.poAgent = { agentId: project.poAgent, source: 'system_migration' };
      }

      // Auto-start PO and member agents
      let poStarted = false;
      let poTarget = project?.poAgent;
      if (project?.poAgent) {
        if (isDefaultRuntimePo(project.poAgent)) {
          const ensuredPo = ensureProjectPoRuntime(project);
          poStarted = ensuredPo.ok;
          if (ensuredPo.ok) poTarget = ensuredPo.instanceId;
        } else {
          poStarted = await autoStartAgent(project.poAgent);
        }
        if (!poStarted) {
          const failedPoAgent = project.poAgent;
          const fallbackResolution = resolvePlanRetryPoAgent(
            { ...project, poAgent: null },
            agentStore.list({ includeArchived: false }),
          );
          if (fallbackResolution.poAgent && fallbackResolution.poAgent !== failedPoAgent) {
            project.poAgent = fallbackResolution.poAgent;
            poResolution = {
              ...fallbackResolution,
              previousPoAgent: originalPoAgent,
              changed: true,
              reason: 'current_po_start_failed',
              failedPoAgent,
            };
            if (isDefaultRuntimePo(project.poAgent)) {
              const ensuredPo = ensureProjectPoRuntime(project);
              poStarted = ensuredPo.ok;
              if (ensuredPo.ok) poTarget = ensuredPo.instanceId;
            } else {
              poStarted = await autoStartAgent(project.poAgent);
              poTarget = project.poAgent;
            }
          }
        }
        for (const memberId of (project.members || [])) {
          if (!isDefaultRuntimeWorker(memberId)) await autoStartAgent(memberId);
        }
      }

      hub.persistState();

      const preparation = await prepareProjectForPlanning(project);
      if (preparation?.state !== 'ready') {
        return json(res, {
          ok: false,
          error: 'project_preparation_required',
          preparation,
          po: project.poAgent,
          poAgent: project.poAgent,
          previousPoAgent: originalPoAgent,
          poReassigned: Boolean(poResolution.changed),
          poResolutionReason: poResolution.reason,
          previousStatus: normalized.previousStatus,
          status: project.status,
        }, 409);
      }

      // Send assign_po intent via brokerClient
      if (brokerClient && brokerClient.isConnected() && poTarget) {
        brokerClient.sendTo(poTarget, 'assign_po', buildPlanRetryAssignPoIntent(project))
          .catch(err => log('warn', 'Failed to send assign_po intent', { target: poTarget, error: err.message }));
      }

      const retryInfo = {
        po: project.poAgent,
        poAgent: project.poAgent,
        previousPoAgent: originalPoAgent,
        poReassigned: Boolean(poResolution.changed),
        poResolutionReason: poResolution.reason,
        poStarted,
        previousStatus: normalized.previousStatus,
        status: project.status,
      };
      log('info', `Plan retry triggered for project: ${projectId}`, retryInfo);
      broadcast({ type: 'plan_retry', projectId, ...retryInfo });
      return json(res, { ok: true, retried: true, ...normalized, ...retryInfo });
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

        const effectivePassed = result.effectivePassed ?? (!(result.rework || result.blocked) && Boolean(review.passed));
        const effectiveFeedback = result.feedback || review.feedback;
        log('info', `PO reviewed task ${taskId}: ${effectivePassed ? 'PASSED' : 'FAILED'}`, {
          projectId,
          rawPassed: review.passed,
          effectivePassed,
          feedback: effectiveFeedback,
          action: result.blocked ? 'block' : result.rework ? 'rework' : 'accept',
        });
        broadcast({
          type: 'task_reviewed',
          projectId,
          taskId,
          passed: effectivePassed,
          rawPassed: review.passed,
          feedback: effectiveFeedback,
        });
        if (result.blocked) {
          broadcast({ type: 'task_blocked', projectId, taskId, failureClass: result.failureClass, nextActions: result.nextActions || [] });
        }

        // If passed, auto-dispatch next available tasks
        if (effectivePassed) {
          await refreshBrokerOnlineAgentIds();
          const dispatchResult = hub.handleRequestDispatch(projectId, fromAgent);
          if (dispatchResult.ok && (dispatchResult.dispatched.length > 0 || dispatchResult.workflowNodeDispatches?.length > 0)) {
            log('info', `Auto-dispatched after review`, { projectId, dispatched: dispatchResult.dispatched, workflowDispatched: dispatchResult.workflowDispatched || [] });
            broadcast({ type: 'tasks_dispatched', projectId, dispatched: dispatchResult.dispatched, workflowDispatched: dispatchResult.workflowDispatched || [] });
            await sendBrokerRequestTasks(projectId, dispatchResult.dispatched);
            await sendWorkflowNodeHandoffs(projectId, dispatchResult.workflowNodeDispatches || []);
          }
        }

        // If rework created a fresh run, notify through the normal request_task path.
        if (result.rework && result.dispatch?.ok && (result.dispatched || []).length > 0) {
          broadcast({ type: 'tasks_dispatched', projectId, tasks: result.dispatched });
          await sendBrokerRequestTasks(projectId, result.dispatched || []);
          await sendWorkflowNodeHandoffs(projectId, result.dispatch.workflowNodeDispatches || []);
        } else if (result.rework && brokerClient && brokerClient.isConnected()) {
          const board = hub.getBoard(projectId);
          const task = board?.getTask(taskId);
          if (task?.assignedAgent) {
            const targetAgent = task.assignedRuntimeInstance || task.assignedAgent;
            brokerClient.sendTo(targetAgent, 'rework', {
              taskId: task.id, threadId: `thread-${projectId}`,
              payload: { reason: effectiveFeedback, projectId },
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
          brokerClient.sendTo(getProjectPoTarget(project), 'review_submission', {
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
      let { synthesis, fromAgent } = body;
      if (!synthesis || !fromAgent) return json(res, { error: 'synthesis and fromAgent required' }, 400);

      // Write synthesis artifact
      const ws = getProjectWorkspace(projectId);
      const projectBeforeDelivery = hub.getProject(projectId);
      const boardBeforeDelivery = hub.getBoard(projectId);
      const tasksBeforeDelivery = boardBeforeDelivery ? boardBeforeDelivery.getAllTasks() : [];
      if (projectBeforeDelivery?.enableSummary !== false) {
        const finalTaskBeforeDelivery = selectUserFacingDeliveryTask(tasksBeforeDelivery);
        const finalFilesBeforeDelivery = [
          ...(Array.isArray(finalTaskBeforeDelivery?.result?.artifacts) ? finalTaskBeforeDelivery.result.artifacts : []),
          ...(Array.isArray(finalTaskBeforeDelivery?.result?.artifactManifest) ? finalTaskBeforeDelivery.result.artifactManifest : []),
        ];
        synthesis = ensureProjectSummarySection(synthesis, {
          lang: /[\u4e00-\u9fff]/.test(`${projectBeforeDelivery?.goal || ''}${projectBeforeDelivery?.name || ''}`) ? 'zh' : 'en',
          tasks: tasksBeforeDelivery,
          finalFiles: finalFilesBeforeDelivery,
        });
      }
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
            project.summary = extractSummarySection(synthesis);
            project.summaryScore = extractSummaryScore(synthesis);
            project.taskScores = extractTaskScores(synthesis);
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
          // Update project.deliverable with final task's artifacts only (user-facing result)
          if (project) {
            const board = hub.getBoard(projectId);
            const tasks = board ? board.getAllTasks() : [];
            const finalTask = selectUserFacingDeliveryTask(tasks);
            // Filter delivery artifacts to only those from the final task
            const finalTaskId = finalTask?.id || finalTask?.localTaskId;
            const finalFiles = finalTaskId
              ? delivery.manifest.artifacts.filter(a => a.taskId === finalTaskId)
              : delivery.manifest.artifacts.slice(-1); // fallback: last artifact
            project.deliverable = {
              synthesis: true,
              files: buildUserFacingDeliveryFiles({
                projectId,
                projectName: project.name,
                goal: project.goal,
                artifacts: finalFiles.length > 0 ? finalFiles : delivery.manifest.artifacts.slice(-1),
                finalTask,
                deliveryDir: join(ws.path, 'delivery'),
              }),
            };
            hub.persistState();
          }
          result.delivery = {
            manifestUrl: `/projects/${projectId}/delivery/delivery-manifest.json`,
            reportUrl: delivery.reportPath ? `/projects/${projectId}/delivery/delivery-report.md` : null,
            artifactCount: delivery.manifest.artifacts.length,
          };
        } else if (project) {
          // Fallback: collect artifacts from the final task (last completed, most dependencies)
          const board = hub.getBoard(projectId);
          const tasks = board ? board.getAllTasks() : [];
          const finalTask = selectUserFacingDeliveryTask(tasks);
          if (finalTask) {
            const files = (finalTask.result?.artifacts || []).map(a => ({
              name: a.filename || a.path || a.title || 'unknown',
              filename: a.filename || a.path || a.title || 'unknown',
              type: a.mimeType || a.type || undefined,
              mimeType: a.mimeType || a.type || undefined,
              size: a.size,
              taskId: finalTask.id,
              url: a.url || (a.filename ? `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(a.filename)}` : undefined),
              path: a.path || (a.filename ? `artifacts/${a.filename}` : undefined),
            }));
            if (files.length > 0) {
              project.deliverable = { synthesis: true, files };
              hub.persistState();
            }
          }
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

      const result = hub.handleReassignTask(projectId, task.id, { newAgent, reason, fromPO });
      if (!result?.ok) return json(res, { error: result?.error || 'transition failed' }, 400);

      log('info', `Task reassigned: ${task.id} → ${newAgent} (reason: ${reason})`, { projectId, fromPO });
      broadcast({ type: 'task_reassigned', projectId, taskId: task.id, newAgent, reason });

      if (result.dispatch?.ok) {
        broadcast({ type: 'tasks_dispatched', projectId, tasks: result.dispatched });
        await sendBrokerRequestTasks(projectId, result.dispatched || []);
      }

      return json(res, result);
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
      await refreshBrokerOnlineAgentIds();
      const result = hub.handleRequestDispatch(projectId, body.fromAgent);
      if (result.ok) {
        log('info', `Dispatched tasks for project ${projectId}`, { dispatched: result.dispatched, workflowDispatched: result.workflowDispatched || [] });
        broadcast({ type: 'tasks_dispatched', projectId, dispatched: result.dispatched, workflowDispatched: result.workflowDispatched || [] });

        await sendBrokerRequestTasks(projectId, result.dispatched || []);
        await sendWorkflowNodeHandoffs(projectId, result.workflowNodeDispatches || []);
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
        if (result.retryDispatched && result.retryTaskId) {
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
      const artifact = createArtifactRecord({
        filename: safeName,
        url: artifactUrl,
        path: filePath,
        previewable: getPreviewable(ext),
        mimeType: MIME_TYPES[ext] || 'application/octet-stream',
      });
      return json(res, {
        ok: true,
        artifact,
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
      let filename;
      try {
        filename = decodeURIComponent(deliveryFileMatch[2]);
      } catch {
        return json(res, { error: 'invalid_filename' }, 400);
      }
      if (!filename || filename.includes('\0') || filename.includes('/') || filename.includes('\\')) {
        return json(res, { error: 'invalid_filename' }, 400);
      }
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
        const spawned = spawnAutoWorkerProcess(autoWorkerSpawnConfig(workerId, workerAlias || 'Worker'), {
          onError: err => log('error', `Auto-worker process error for ${workerId}: ${err.message}`),
        });
        if (!spawned.ok) {
          log('error', `Failed to spawn worker ${workerId}: ${spawned.error}`);
          return json(res, { error: spawned.error }, 500);
        }
        log('info', `Spawned auto-worker: ${workerId}`, { alias: workerAlias, pid: spawned.pid });
        return json(res, { ok: true, workerId, pid: spawned.pid }, 201);
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

    // ── Runtime instances (internal Xiaok pooled workers/POs) ──
    if (path === '/agents/runtime-instances' && req.method === 'GET') {
      return json(res, {
        instances: runtimeInstancePool.listInstances(),
        summary: runtimeInstancePool.summarizeByAgent(),
      });
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
      const boundary = canSpawnAutoWorkerForTask({ agent, taskKind: 'user_task' });
      if (!boundary.ok) return json(res, { error: boundary.error }, 409);

      try {
        const childEnv = buildAgentChildEnv(agent, agentId);
        const spawned = spawnAutoWorkerProcess(autoWorkerSpawnConfig(agentId, agent.name, agent.customArgs || [], childEnv), {
          onError: err => {
            agentStore.setOffline(agentId);
            log('error', `Auto-worker process error for ${agentId}: ${err.message}`);
          },
        });
        if (!spawned.ok) {
          agentStore.setOffline(agentId);
          log('error', `Failed to start agent ${agentId}: ${spawned.error}`);
          return json(res, { error: spawned.error }, 500);
        }

        const runtimeId = `pid-${spawned.pid}`;
        agentStore.setOnline(agentId, runtimeId);

        log('info', `Agent started: ${agent.name} (${agentId})`, { pid: spawned.pid, runtimeId });
        broadcast({ type: 'agent_started', agentId, runtimeId, pid: spawned.pid });
        return json(res, { ok: true, agentId, pid: spawned.pid, runtimeId }, 201);
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

      const result = await probeAgentRuntime(agent, {
        enableGenerationProbe: process.env.KSWARM_ENABLE_GENERATION_PROBE === 'true',
      });
      if (result.runtimeHealth) agentStore.updateRuntimeHealth(agentId, result.runtimeHealth);
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
  if (!stalledRunWatchdogTimer) {
    stalledRunWatchdogTimer = setInterval(runStalledRunWatchdog, 60_000);
  }
}

function runStalledRunWatchdog() {
  for (const project of hub.listProjects()) {
    if (project.status === 'closed' || project.status === 'delivered') continue;
    const board = hub.getBoard(project.id);
    if (!board) continue;
    const actions = planStalledRunActions({
      projectId: project.id,
      tasks: board.getAllTasks(),
    });
    for (const action of actions) {
      if (action.type === 'stalled_warning') {
        log('warn', `Stalled run warning: ${action.taskId}`, action);
        broadcast({ type: 'run_stalled_warning', ...action });
        continue;
      }
      if (action.type === 'mark_runtime_stalled') {
        const healthAgentId = action.logicalAgentId || action.agentId;
        const agent = healthAgentId ? agentStore.get(healthAgentId) : null;
        if (agent) {
          agentStore.updateRuntimeHealth(healthAgentId, recordRuntimeFailure(agent.runtimeHealth, {
            failureClass: 'runtime_stalled',
            error: action.reason,
          }));
        }
        const result = hub.handleWorkerFailure(
          action.projectId,
          action.taskId,
          action.agentId,
          action.runId,
          'runtime_stalled',
          action.reason
        );
        log(result.ok ? 'warn' : 'error', `Marked run stalled: ${action.taskId}`, { ...action, result });
        broadcast({ type: 'run_stalled', ...action, result });
        continue;
      }
      if (action.type === 'request_cancel_run') {
        if (brokerClient && brokerClient.isConnected() && action.agentId) {
          brokerClient.sendTo(action.agentId, 'cancel_run', {
            taskId: action.taskId,
            payload: action,
          }).catch(err => log('warn', `Failed to request cancel_run from ${action.agentId}`, { ...action, error: err.message }));
        }
      }
    }
  }
}

const AGENT_RUNTIME_FAILURE_CLASSES = new Set([
  'agent_error',
  'runtime_offline',
  'runtime_missing',
  'runtime_recovery',
  'runtime_stalled',
  'runtime_generation_unavailable',
  'model_empty_output',
]);

function recordAgentRuntimeFailure(agentId, failureClass, errorMessage) {
  if (!agentId || !AGENT_RUNTIME_FAILURE_CLASSES.has(failureClass)) return;
  const instance = runtimeInstancePool.getInstance(agentId);
  const healthAgentId = instance?.logicalAgentId || agentId;
  const agent = agentStore.get(healthAgentId);
  if (!agent) return;
  agentStore.updateRuntimeHealth(healthAgentId, recordRuntimeFailure(agent.runtimeHealth, {
    failureClass,
    error: errorMessage || failureClass,
  }));
}

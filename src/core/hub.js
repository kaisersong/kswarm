/**
 * Hub — KSwarm 的核心引擎
 *
 * 角色模型（修正版）：
 * - Human: 项目所有者。创建项目、审批计划、随时添加任务、关闭项目
 * - PO Agent: 项目负责人。规划任务、分配 worker、确认任务完成、汇报
 * - Worker Agent: 执行者。接受任务、报告进度、提交结果（含 artifacts）
 *
 * 关键规则：
 * - 项目关闭只能由 Human 决定（PO 只能确认所有任务 done）
 * - Human 可以在任何阶段添加新任务
 * - 即使所有任务 done，项目仍是 active 直到 Human 关闭
 */

import { createTaskBoard, restoreTaskBoard } from './task-board.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createEventLog } from './event-log.js';
import { createPersistence, PersistenceCommitError } from './persistence.js';
import { resolveMutationScope, FULL_SCOPE } from './state-scope.js';
import { randomUUID } from 'node:crypto';
import * as retryStrategy from './retry-strategy.js';
import { expandCompositeTasks } from './composite-task-expander.js';
import { validateNodePermissions } from './workflow-node-permissions.js';
import { getActiveTasksAcrossBoards, isReworkReadyForDispatch, planDispatch } from './dispatch-policy.js';
import { superviseTaskFailure } from './failure-supervisor.js';
import { deriveProjectHealth } from './project-health.js';
import { deriveProjectIntervention } from './project-intervention.js';
import { handleContinueProjectCore } from './project-continue.js';
import { resolveProjectIntervention } from './project-intervention-resolution.js';
import { extractReviewEvidence, validateTaskResultAgainstContract } from './execution-contract.js';
import { isContractFamily } from './contract-kind-registry.js';
import { acceptTaskGateEvidence, readContainedArtifact } from './gate-evidence-acceptor.js';
import { evaluatePreApprovalPrerequisites } from './gate-evaluator.js';
import { hydrateGateFacts } from './hydrate-gate-facts.js';
import { freezeFinalCandidateArtifact } from './frozen-final-candidate.js';
import { registerCanonicalArtifacts } from './canonical-artifact-registry.js';
import { normalizeTasksForProject } from './task-identity.js';
import { normalizeTaskGraphPolicies, applyTaskGraphPolicyWrites } from './task-graph-policies.js';
import { deriveRiskFloor, resolveEffectiveRiskProfile } from './risk-floor.js';
import { inferTaskRequirements } from './task-requirements.js';
import { validateDeliverableContract } from './deliverable-contract.js';
import { normalizeProjectForPlanRetry } from './plan-retry-recovery.js';
import { createTaskHandoffPackage } from './handoff-package.js';
import { deriveProjectPreparation } from './agent-readiness.js';
import { planAgentReplacement } from './agent-replacement.js';
import { applyWorkflowEvent, createWorkflowRun, refreshWorkflowRunState } from './workflow-run.js';
import {
  deriveExecutionGraph,
  deriveProjectLifecycle,
  evaluateFinalDeliverableApprovalFacts,
} from './project-read-model.js';
import { sanitizeRequestContext } from './mutation-transport.js';
import {
  buildReviewConditionFromFinding,
  resolveReviewCondition,
  submitConditionEvidence,
} from './review-condition.js';
import {
  AGENT_REVIEW_SMOKE_WORKFLOW_ID,
  PO_GENERATED_PROJECT_WORKFLOW_ID,
  PO_GENERATED_TASK_WORKFLOW_ID,
  PROJECT_WORKFLOW_DELIVERABLE_NODE_ID,
  PROJECT_DIAGNOSE_WORKFLOW_ID,
  TASK_WORKFLOW_DELIVERABLE_NODE_ID,
  createAgentReviewSmokeWorkflowRun,
  createAgentReviewSmokeWorkflowSpec,
  createPoGeneratedProjectWorkflowRun,
  createPoGeneratedProjectWorkflowSpec,
  createPoGeneratedTaskWorkflowRun,
  createPoGeneratedTaskWorkflowSpec,
  createProjectDiagnoseWorkflowRun,
  createProjectDiagnoseWorkflowSpec,
} from './workflow-builtins.js';
import {
  hashWorkflowScript as hashWorkflowScriptSource,
  normalizeWorkflowScript as normalizeWorkflowScriptSource,
} from './workflow-script-source.js';
import {
  sanitizeWorkflowGateDecision,
  sanitizeWorkflowNodeOutput,
  validateWorkflowSpec,
  validateWorkflowGateDecision,
} from './workflow-spec.js';
import { applyWorkflowProgressBatch } from './workflow-progress.js';
import {
  buildTaskExecutionMetadata,
  isValidProjectExecutionMode,
  normalizeProjectExecutionMode,
  selectTaskExecutionStrategy,
} from './execution-mode.js';
import { decideProjectStartPolicy } from './project-start-policy.js';
import {
  appendQualityPlanningGuidance,
  buildQualityPromptExcerpt,
  compileEffectiveQualityRuleSet,
} from './quality-rules.js';
import { reconcileProjectAgentSelectionWithEffectiveAgents } from './agent-selection.js';

const TASK_LEVEL_WORKER_FAILURE_CLASSES = new Set(['model_empty_output', 'quality_evidence_missing', 'source_provider_unavailable']);
const WORKFLOW_AGENT_CAPABILITIES = ['project_diagnosis', 'review_gate', 'writing', 'report_generation'];

export function createHub({ bridge, eventLogDir, silent = false, dataDir, persistence: injectedPersistence = null, getAgentProfiles = null, getQualityOverlays = null, runtimeInstanceAllocator = null, brokerClient = null } = {}) {
  const projects = new Map();
  const boards = new Map();
  const workflowRuns = new Map();
  const workflowProposals = new Map();
  const finalDeliverables = new Map();
  const reviewGateDecisions = new Map();
  const reviewConditions = new Map();
  const eventLog = createEventLog({ logDir: eventLogDir, silent });
  const persistence = injectedPersistence || (dataDir ? createPersistence(dataDir) : null);

  // Human action log — tracks all human decisions. Append-only + durable per-row.
  const humanActions = [];
  let humanActionSeq = 0;
  let persistedHumanActionCount = 0;

  // Restore state from disk. Unrecoverable load/corruption throws (never starts empty).
  if (persistence) {
    const saved = persistence.load();
    if (saved && saved.projects) {
      for (const p of saved.projects) {
        const project = normalizeRecoveredProject(p);
        projects.set(project.id, project);
      }
      for (const { projectId, tasks } of (saved.boards || [])) {
        boards.set(projectId, restoreTaskBoard(tasks, projectId));
      }
      for (const run of (saved.workflowRuns || [])) {
        if (run?.id) workflowRuns.set(run.id, run);
      }
      for (const proposal of (saved.workflowProposals || [])) {
        if (proposal?.id) workflowProposals.set(proposal.id, proposal);
      }
      for (const deliverable of (saved.finalDeliverables || [])) {
        if (deliverable?.deliverableId) finalDeliverables.set(deliverable.deliverableId, deliverable);
      }
      for (const decision of (saved.reviewGateDecisions || [])) {
        if (decision?.gateId) reviewGateDecisions.set(decision.gateId, decision);
      }
      for (const condition of (saved.reviewConditions || [])) {
        if (condition?.conditionId) reviewConditions.set(condition.conditionId, condition);
      }
      for (const action of (saved.humanActions || [])) {
        if (!action || typeof action !== 'object') continue;
        humanActions.push(action);
        if (typeof action.seq === 'number' && action.seq >= humanActionSeq) humanActionSeq = action.seq + 1;
      }
      persistedHumanActionCount = humanActions.length;
      if (!silent) console.log(`[hub] Restored ${saved.projects.length} projects from disk`);
    }
  }

  function buildFullState() {
    return {
      projects: [...projects.values()],
      boards: [...boards.entries()].map(([projectId, board]) => ({
        projectId,
        tasks: board.getAllTasks(),
      })),
      workflowRuns: [...workflowRuns.values()],
      workflowProposals: [...workflowProposals.values()],
      finalDeliverables: [...finalDeliverables.values()],
      reviewGateDecisions: [...reviewGateDecisions.values()],
      reviewConditions: [...reviewConditions.values()],
      humanActions,
    };
  }

  // Scoped persistence accessor: materialize only the entities affected by a
  // mutation's scope. Never builds the full ~9MB state for a single-project
  // mutation. The `full` closure is used only by the legacy JSON backend.
  function buildScopedPersistencePayload(scope = FULL_SCOPE) {
    const inScope = (projectId) => scope.type === 'full' || projectId === scope.projectId;
    const entities = [];
    for (const p of projects.values()) {
      if (inScope(p.id)) entities.push({ collection: 'project', key: p.id, projectId: p.id, value: p });
    }
    for (const [projectId, board] of boards.entries()) {
      if (inScope(projectId)) entities.push({ collection: 'board', key: projectId, projectId, value: { projectId, tasks: board.getAllTasks() } });
    }
    for (const r of workflowRuns.values()) {
      if (inScope(r.projectId)) entities.push({ collection: 'workflowRun', key: r.id, projectId: r.projectId ?? null, value: r });
    }
    for (const pr of workflowProposals.values()) {
      if (inScope(pr.projectId)) entities.push({ collection: 'workflowProposal', key: pr.id, projectId: pr.projectId ?? null, value: pr });
    }
    for (const d of finalDeliverables.values()) {
      if (inScope(d.projectId)) entities.push({ collection: 'finalDeliverable', key: d.deliverableId, projectId: d.projectId ?? null, value: d });
    }
    for (const g of reviewGateDecisions.values()) {
      if (inScope(g.projectId)) entities.push({ collection: 'reviewGateDecision', key: g.gateId, projectId: g.projectId ?? null, value: g });
    }
    for (const c of reviewConditions.values()) {
      if (inScope(c.projectId)) entities.push({ collection: 'reviewCondition', key: c.conditionId, projectId: c.projectId ?? null, value: c });
    }
    const newHumanActions = humanActions.slice(persistedHumanActionCount).map(a => ({
      collection: 'humanAction', key: a.id, projectId: a.projectId ?? null, value: a,
    }));
    return { entities, humanActions: newHumanActions, scope, full: buildFullState };
  }

  function persistState(scope = FULL_SCOPE) {
    if (!persistence) return;
    persistence.save(buildScopedPersistencePayload, scope);
    // Advance the append pointer only after a successful durable commit.
    persistedHumanActionCount = humanActions.length;
  }

  function getPersistenceHealth() {
    if (!persistence || typeof persistence.getHealth !== 'function') {
      return { status: 'disabled', backend: 'none', revision: 0 };
    }
    return persistence.getHealth();
  }

  function closePersistence() {
    if (persistence && typeof persistence.close === 'function') persistence.close();
  }

  if (persistence) {
    const reconciliation = reconcileRecoveredScriptWorkflowProjectDeliveries();
    if (reconciliation.delivered.length > 0 || reconciliation.blocked.length > 0) {
      persistState();
    }
  }

  function recordHumanAction(action, data) {
    const entry = { id: randomUUID(), seq: humanActionSeq++, ts: new Date().toISOString(), action, ...data };
    humanActions.push(entry);
    return entry;
  }

  function prepareTasksForBoard(project, taskList) {
    return expandCompositeTasks(taskList, {
      projectId: project.id,
      members: project.members || [],
      poAgent: project.poAgent,
    });
  }

  function buildDispatchPlan(projectId) {
    const board = boards.get(projectId);
    if (!board) return null;
    const project = projects.get(projectId);
    const tasks = board.getAllTasks();
    const consumedArtifactIdsByTaskId = {};
    for (const task of tasks) {
      const declarations = task?.consumedArtifactIdsByDependencyTaskId;
      if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) continue;
      consumedArtifactIdsByTaskId[task.id] = declarations;
    }
    const currentGateFactsByTaskId = {};
    for (const dependencyTask of tasks) {
      const serviceFacts = project?.currentGateFacts?.[dependencyTask.id];
      const currentRunId = dependencyTask?.lastRunLease?.runId || dependencyTask?.recoveredRunId || null;
      if (!currentRunId || !serviceFacts || serviceFacts.sourceRunId !== currentRunId) continue;
      currentGateFactsByTaskId[dependencyTask.id] = {
        sourceRunId: serviceFacts.sourceRunId,
        canonicalArtifacts: serviceFacts.canonicalArtifacts,
        evaluationSourceArtifact: serviceFacts.evaluationSourceArtifact,
      };
    }
    return planDispatch({
      projectId,
      tasks,
      allActiveTasks: getActiveTasksAcrossLiveProjects(),
      agentProfiles: getProjectAgentProfiles(project),
      agentConcurrency: typeof runtimeInstanceAllocator?.getAgentConcurrency === 'function'
        ? runtimeInstanceAllocator.getAgentConcurrency()
        : {},
      dependencyPolicies: project?.dependencyPolicies || {},
      gateEvaluationsByTaskId: project?.gateEvaluations || {},
      consumedArtifactIdsByTaskId,
      currentGateFactsByTaskId,
      // design §13 Rollout invariant: 只有项目显式声明 executionGateSchemaVersion === 2
      // 才启用 v2 fail-closed 依赖判定；未声明或为 1 的项目走 legacy `completed` 语义，
      // 不因为本次改动而改变既有行为。
      schemaV2: project?.executionGateSchemaVersion === 2,
    });
  }

  function getProjectAgentProfiles(project) {
    const profiles = listAgentProfiles(typeof getAgentProfiles === 'function' ? getAgentProfiles() : null);
    if (!project) return profiles;
    const allowed = new Set([
      project.poAgent,
      ...(Array.isArray(project.members) ? project.members : []),
    ].map(normalizeAgentId).filter(Boolean));
    if (allowed.size === 0) return profiles;
    return profiles.filter(agent => allowed.has(normalizeAgentId(agent?.id)));
  }

  function listAgentProfiles(agentProfiles) {
    if (agentProfiles instanceof Map) return [...agentProfiles.values()];
    if (Array.isArray(agentProfiles)) return agentProfiles;
    if (agentProfiles && typeof agentProfiles === 'object') return Object.values(agentProfiles);
    return [];
  }

  function normalizeAgentId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  }

  function getActiveTasksAcrossLiveProjects() {
    const liveBoards = new Map();
    for (const [projectId, board] of boards.entries()) {
      if (isLiveProject(projects.get(projectId))) liveBoards.set(projectId, board);
    }
    return getActiveTasksAcrossBoards(liveBoards);
  }

  function isLiveProject(project) {
    return Boolean(project && project.status !== 'closed' && project.status !== 'delivered');
  }

  function updatePlanItemCompleted(project, task) {
    if (!project?.plan) return;
    for (const phase of project.plan.phases || []) {
      const item = (phase.items || []).find(i => i.id === task.planItemId || i.title === task.title);
      if (item) { item.status = 'completed'; break; }
    }
  }

  function maybeCompleteCompositeParent(projectId, childTask) {
    if (!childTask?.parentTaskId) return null;
    const board = boards.get(projectId);
    const parent = board?.getTask(childTask.parentTaskId);
    if (!parent?.isCompositeParent || parent.status === 'done') return null;
    const children = (parent.childTaskIds || []).map(id => board.getTask(id)).filter(Boolean);
    if (children.length !== parent.childTaskIds.length || children.some(child => child.status !== 'done')) return null;
    const finalChild = [...children].reverse().find(child => child.compositeRole === 'final') || childTask;
    const result = board.completeCompositeParent(parent.id, finalChild.result || childTask.result || null);
    if (result.ok) {
      const project = projects.get(projectId);
      updatePlanItemCompleted(project, parent);
      eventLog.emit('task.done', {
        projectId,
        taskId: parent.id,
        taskTitle: parent.title,
        confirmedBy: 'composite_children',
      });
    }
    return result;
  }

  function maybeCompleteRetryParent(projectId, retryTask) {
    if (!retryTask?.parentTaskId) return null;
    const board = boards.get(projectId);
    const parent = board?.getTask(retryTask.parentTaskId);
    if (!parent || parent.isCompositeParent || parent.status === 'done') return null;
    if (retryTask.status !== 'done') return null;
    const result = board.completeRetryParent(parent.id, retryTask.result || null, {
      completedBy: 'retry_child',
      completedByTaskId: retryTask.id,
      recoveredBy: retryTask.completedBy || 'retry_child',
      recoveryReason: 'retry_child_completed',
    });
    if (result.ok && !result.alreadyDone) {
      const project = projects.get(projectId);
      updatePlanItemCompleted(project, parent);
      eventLog.emit('task.done', {
        projectId,
        taskId: parent.id,
        taskTitle: parent.title,
        confirmedBy: 'retry_child',
        retryTaskId: retryTask.id,
      });
    }
    return result;
  }

  // ─── Project lifecycle ─────────────────────────────────────────────

  function roomContractError(code, extra = {}) {
    const error = new Error(code);
    error.code = code;
    for (const [key, value] of Object.entries(extra)) {
      error[key] = value;
    }
    return error;
  }

  // Room project event outbox (design §8.4, §11.2): every room-visible event
  // gets a durable projectionEventId `proj:<projectId>#<seq>`; the sequence
  // lives on the project so persistence keeps it monotonic across restarts.
  function nextRoomProjectionEventId(project) {
    project.roomEventSeq = (project.roomEventSeq ?? 0) + 1;
    return `proj:${project.id}#${project.roomEventSeq}`;
  }

  function appendRoomEventOutboxItem(project, { eventType, summary = null, sourceRefs = {} }) {
    if (!project.primaryRoomId) return null;
    if (!Array.isArray(project.roomEventOutbox)) project.roomEventOutbox = [];
    const item = {
      projectionEventId: nextRoomProjectionEventId(project),
      projectId: project.id,
      roomId: project.primaryRoomId,
      eventType,
      summary,
      sourceRefs,
      status: 'pending',
      createdAt: Date.now(),
    };
    project.roomEventOutbox.push(item);
    return item;
  }

  function roomArtifactFilename(artifact) {
    const raw = typeof artifact === 'string'
      ? artifact
      : artifact?.filename || artifact?.name || artifact?.relativePath || artifact?.path || artifact?.url || '';
    const normalized = String(raw || '').replace(/\\/g, '/').split(/[?#]/, 1)[0].replace(/\/+$/, '');
    const filename = basename(normalized).trim();
    return filename && filename !== '.' ? filename : null;
  }

  function appendTaskArtifactRoomEvents(project, taskId, result = {}) {
    if (!project?.primaryRoomId || !taskId || !result || typeof result !== 'object') return [];
    const artifacts = [
      ...(Array.isArray(result.artifacts) ? result.artifacts : []),
      ...(Array.isArray(result.artifactManifest) ? result.artifactManifest : []),
    ];
    if (artifacts.length === 0) return [];

    const existingArtifactIds = new Set((project.roomEventOutbox || [])
      .filter((item) => item.eventType === 'artifact.registered')
      .map((item) => item.sourceRefs?.artifactId)
      .filter(Boolean));
    const submissionFilenames = new Set();
    const appended = [];
    for (const artifact of artifacts) {
      const filename = roomArtifactFilename(artifact);
      if (!filename || submissionFilenames.has(filename)) continue;
      submissionFilenames.add(filename);
      const suppliedArtifactId = typeof artifact === 'object' && artifact
        ? artifact.artifactId || artifact.id
        : null;
      const artifactId = String(suppliedArtifactId || `${taskId}:${filename}`);
      if (existingArtifactIds.has(artifactId)) continue;
      existingArtifactIds.add(artifactId);
      const kind = typeof artifact === 'object' && artifact
        ? artifact.kind || artifact.type || undefined
        : undefined;
      const mimeType = typeof artifact === 'object' && artifact
        ? artifact.mimeType || undefined
        : undefined;
      const item = appendRoomEventOutboxItem(project, {
        eventType: 'artifact.registered',
        summary: `产物 ${filename} 已生成`,
        sourceRefs: {
          projectId: project.id,
          taskId,
          artifactId,
          artifact: {
            projectId: project.id,
            filename,
            ...(kind ? { kind } : {}),
            ...(mimeType ? { mimeType } : {}),
          },
        },
      });
      if (item) appended.push(item);
    }
    return appended;
  }

  async function validateRoomFirstCreate(input, mutationCtx) {
    const primaryRoomId = typeof input.primaryRoomId === 'string' && input.primaryRoomId.trim()
      ? input.primaryRoomId.trim()
      : null;

    // agent-source create is rejected from every entry (design §9.2)
    if (mutationCtx?.requestSource === 'agent') {
      throw roomContractError('room_actor_forbidden');
    }

    const isTrustedCaller = mutationCtx?.requestSource === 'user'
      || mutationCtx?.requestSource === 'system';

    if (!primaryRoomId) {
      if (isTrustedCaller && mutationCtx.requestSource === 'user') {
        // Room-first path: trusted user creates MUST carry a primary room
        throw roomContractError('room_primary_room_required');
      }
      // legacy compatibility window: no mutation context, null-room project
      return { primaryRoomId: null };
    }

    if (!brokerClient || typeof brokerClient.getRoomSnapshot !== 'function') {
      throw roomContractError('kswarm_unavailable', { detail: 'room membership provider missing' });
    }

    const snapshot = await brokerClient.getRoomSnapshot(primaryRoomId);
    if (!snapshot || snapshot.ok === false) {
      throw roomContractError(snapshot?.code ?? 'room_not_found');
    }
    if (snapshot.room?.status !== 'active') {
      throw roomContractError('room_archived', { status: snapshot.room?.status });
    }

    const sourceMessageIds = Array.isArray(input.sourceMessageIds) ? input.sourceMessageIds : [];
    const roomMessageIds = new Set((snapshot.messages ?? []).map((message) => message?.messageId).filter(Boolean));
    for (const messageId of sourceMessageIds) {
      if (!roomMessageIds.has(messageId)) {
        throw roomContractError('room_message_not_found', { messageId });
      }
    }

    const activeRoomAgents = new Set(
      (snapshot.members ?? [])
        .filter((member) => member?.subject?.kind === 'agent' && member?.status === 'active')
        .map((member) => member.subject.logicalAgentId)
    );

    const poAgent = typeof input.poAgent === 'string' ? input.poAgent.trim() : '';
    const requiredAgents = [poAgent, ...(Array.isArray(input.members) ? input.members : [])]
      .map((agentId) => (typeof agentId === 'string' ? agentId.trim() : ''))
      .filter(Boolean);
    for (const agentId of requiredAgents) {
      if (!activeRoomAgents.has(agentId)) {
        throw roomContractError('room_membership_required', { agentId });
      }
    }

    // membership-use lease for the PO and every member (design §8.2 step 4)
    const operationId = `room-create:${input.clientRequestKey ?? input.id}`;
    for (const agentId of requiredAgents) {
      const leaseResult = await brokerClient.acquireRoomMembershipLease({
        roomId: primaryRoomId,
        logicalAgentId: agentId,
        operationId,
      });
      if (!leaseResult || leaseResult.ok === false) {
        throw roomContractError('room_membership_lease_required', {
          cause: leaseResult?.code ?? 'room_membership_lease_required',
          agentId,
        });
      }
    }

    return { primaryRoomId };
  }

  function createProject(input = {}, mutationCtx = undefined) {
    const {
      id, name, goal, requirements, planningGuidance, poAgent, members = [], enableSummary,
      agentSelection = null, preparationContext = null, executionMode = 'direct',
      autoAssignPo = true, clientRequestKey, requestedStartPolicy,
      primaryRoomId, sourceMessageIds, linkedBy,
    } = input;

    const hasRoomContext = typeof primaryRoomId === 'string' && primaryRoomId.trim() !== '';

    if (mutationCtx?.requestSource === 'agent') {
      throw roomContractError('room_actor_forbidden');
    }

    // Room-first create performs cross-service validation (snapshot + lease),
    // so it is asynchronous; the legacy window stays synchronous.
    if (hasRoomContext || mutationCtx?.requestSource === 'user') {
      // idempotent retry: the same clientRequestKey must return the SAME
      // project instead of creating a duplicate (design §11.2)
      const normalizedKey = normalizeProjectCreateClientRequestKey(input.clientRequestKey);
      if (normalizedKey) {
        const reusable = findReusableProjectForCreateRequest({ clientRequestKey: normalizedKey });
        if (reusable) return Promise.resolve(reusable);
      }
      return validateRoomFirstCreate(input, mutationCtx).then(({ primaryRoomId: resolvedRoomId }) =>
        createProjectValidated(input, mutationCtx, resolvedRoomId));
    }
    return createProjectValidated(input, mutationCtx, null);
  }

  function createProjectValidated(input, mutationCtx, resolvedRoomId) {
    const {
      id, name, goal, requirements, planningGuidance, poAgent, members = [], enableSummary,
      agentSelection = null, preparationContext = null, executionMode = 'direct',
      autoAssignPo = true, clientRequestKey, requestedStartPolicy,
      primaryRoomId, sourceMessageIds, linkedBy, executionGateSchemaVersion,
      requestedOutput = null,
    } = input;
    const createdAt = Date.now();
    const normalizedClientRequestKey = normalizeProjectCreateClientRequestKey(clientRequestKey);
    const effectiveName = normalizeProjectNameForDisplay(name);
    const normalizedPoAgent = normalizeAgentId(poAgent);
    const normalizedMembers = normalizeAgentIdList(members).filter(agentId => agentId !== normalizedPoAgent);
    const qualityRuleSet = compileEffectiveQualityRuleSet({
      goal: goal || '',
      requirements: requirements || '',
      overlays: typeof getQualityOverlays === 'function' ? getQualityOverlays() : [],
      now: createdAt,
    });
    const qualityPlanningGuidance = qualityRuleSet.rules.length > 0
      ? buildQualityPromptExcerpt(qualityRuleSet, { role: 'po', budgetChars: 1600 }).text
      : '';
    const effectivePlanningGuidance = appendQualityPlanningGuidance(planningGuidance || '', qualityPlanningGuidance);
    const project = {
      id,
      name: effectiveName,
      goal,
      requirements: requirements || '',
      planningGuidance: planningGuidance || '',
      qualityRuleSet,
      qualityPlanningGuidance,
      agentSelection: normalizeAgentSelection({ poAgent: normalizedPoAgent, members: normalizedMembers, agentSelection }),
      preparation: null,
      poAgent: normalizedPoAgent,
      members: normalizedMembers,
      executionMode: normalizeProjectExecutionMode(executionMode),
      executionModeUpdatedAt: createdAt,
      executionModeUpdatedBy: 'system_default',
      requestedStartPolicy: normalizeProjectStartPolicy(requestedStartPolicy),
      status: 'created',  // created → planning → active → closed
      createdAt,
      closedAt: null,
      closedBy: null,
      deliverable: null,
      plan: null,           // Plan-Do: structured plan set by PO
      planArtifact: null,   // URL to plan markdown artifact
      enableSummary: enableSummary !== false,  // default true, backwards-compatible
      summary: null,        // Project summary section text (set at synthesize)
      summaryScore: null,   // Project score 1-10 (parsed from synthesis)
      lifecycleVersion: 0,
      projectRevision: 1,
      teamPlan: null,
      primaryRoomId: resolvedRoomId,
      // Gate 收敛设计 v8（design §3.3, §8.2）：
      // dependencyPolicies 按 taskId 索引 DependencyPolicy（'completed' | 'completed_for_remediation' | 'verified_pass'）。
      // gateEvaluations 按 taskId 索引 GateEvaluationV1[]（service-owned，只能从磁盘证据派生，不接受 mutation API 写入）。
      // 两者默认空对象：旧项目/未显式声明策略的依赖边在 evaluateDependencySatisfaction 中走 schemaV2=false
      // 的 legacy `completed` 语义，向后兼容，不影响现有行为。
      dependencyPolicies: {},
      gateEvaluations: {},
      // design §8.1.1：canonical artifact registry + manifestRevision（本轮新增，
      // 见 canonical-artifact-registry.js）。所有项目从创建时就持有这两个字段，
      // 不依赖 caller 延迟初始化（approveFinalDeliverable 等 caller 之前需要
      // "if (!project.canonicalArtifacts) project.canonicalArtifacts = {}" 的
      // 防御性初始化，现在从源头保证字段始终存在）。
      canonicalArtifacts: {},
      manifestRevision: 0,
      // design §4.1：requestedOutput.kind/audience 是 deriveRiskFloor 判定
      // isPublicRelease 的结构化输入来源，优先于纯关键词匹配。用户/上游 caller
      // 显式声明的结构化输出目标；缺省为 null（deriveRiskFloor 对 null 安全降级
      // 为不命中 isPublicRelease，不影响现有未声明该字段的项目）。
      requestedOutput: requestedOutput && typeof requestedOutput === 'object' ? requestedOutput : null,
      // design §13 Rollout invariant：只有显式声明 executionGateSchemaVersion === 2
      // 的项目才启用 v2 fail-closed 依赖判定/gate evaluator snapshot 化批准流程；
      // 未声明或为 1 的项目走 legacy 语义，不因为本次改动而改变既有行为。
      // 此前这个字段从未在 createProject 中被正式接收和持久化——只有
      // buildDispatchPlan 读取它（读到永远是 undefined 的字段），是一个真实的
      // 创建入口缺口，本次一并补上。
      executionGateSchemaVersion: executionGateSchemaVersion === 2 ? 2 : undefined,
    };
    if (normalizedClientRequestKey) {
      project.clientRequestKey = normalizedClientRequestKey;
    }
    if (resolvedRoomId) {
      project.roomLink = {
        kind: 'primary',
        sourceMessageIds: Array.isArray(sourceMessageIds) ? sourceMessageIds : [],
        linkedBy: linkedBy ?? { kind: 'system', service: 'kswarm' },
        linkedAt: new Date(createdAt).toISOString(),
      };
    }
    projects.set(id, project);
    boards.set(id, createTaskBoard(id));

    eventLog.emit('project.created', { projectId: id, projectName: effectiveName, po: normalizedPoAgent });
    // room-first creates enqueue project.created into the durable outbox in
    // the same logical transaction as the project write (design §11.2)
    if (resolvedRoomId) {
      appendRoomEventOutboxItem(project, {
        eventType: 'project.created',
        summary: `项目 ${effectiveName} 已创建`,
        sourceRefs: { projectId: id },
      });
    }
    recordHumanAction('create_project', { projectId: id, projectName: effectiveName, poAgent: normalizedPoAgent });

    if (preparationContext) {
      project.preparation = deriveProjectPreparation({
        ...preparationContext,
        project,
      });
      eventLog.emit('project.preparation_checked', {
        projectId: id,
        state: project.preparation.state,
        blockers: project.preparation.blockers,
      });
    }

    if (autoAssignPo !== false && (!project.preparation || project.preparation.state === 'ready')) {
      sendAssignPo(project, effectivePlanningGuidance);
    }
    return project;
  }

  function getRoomEventOutbox({ projectId } = {}) {
    const project = projects.get(projectId);
    if (!project) return { items: [] };
    return { items: Array.isArray(project.roomEventOutbox) ? [...project.roomEventOutbox] : [] };
  }

  async function flushRoomEventOutbox() {
    if (!brokerClient || typeof brokerClient.publishRoomProjectEvent !== 'function') {
      return { ok: false, code: 'kswarm_unavailable' };
    }
    let published = 0;
    let suppressed = 0;
    for (const project of projects.values()) {
      if (!Array.isArray(project.roomEventOutbox) || !project.primaryRoomId) continue;
      for (const item of project.roomEventOutbox) {
        if (item.status !== 'pending') continue;
        const snapshot = await brokerClient.getRoomSnapshot(project.primaryRoomId);
        if (!snapshot || snapshot.ok === false || snapshot.room?.status !== 'active') {
          // terminal suppression: no retry loop, no project rollback (§7.4)
          item.status = 'suppressed_room_archived';
          item.suppressedAt = Date.now();
          suppressed += 1;
          continue;
        }
        const result = await brokerClient.publishRoomProjectEvent({
          projectionEventId: item.projectionEventId,
          roomId: item.roomId,
          projectId: item.projectId,
          eventType: item.eventType,
          summary: item.summary,
          sourceRefs: item.sourceRefs,
        });
        if (result && result.ok !== false) {
          item.status = 'published';
          item.publishedAt = Date.now();
          published += 1;
        }
        // publish failure keeps the item pending for the next flush
      }
    }
    return { ok: true, published, suppressed };
  }

  function submitTaskResult({ projectId, taskId, agentId, summary = null } = {}) {
    const project = projects.get(projectId);
    if (!project) {
      return { ok: false, error: 'project_not_found' };
    }
    const board = boards.get(projectId);
    if (board) {
      const task = board.getTask(taskId);
      // design §8.2（submitTaskResult / Room event path 项）：
      // 之前的实现把 transition 失败静默吞掉（try/catch 只有注释，无 early return），
      // 导致即使真实状态转换失败（例如非法的状态跳转），代码仍会继续往下发布
      // 'task.done' 事件和 Room outbox 通知，让用户看到一个从未真正发生的
      // "任务已完成"。现在只在任务存在且 transition 真正失败时拒绝整个调用；
      // 任务本身不存在（纯 Room-level 进度通知场景）时保留原有的宽容行为，
      // 不強行要求 board 上必须有对应 task。
      if (task) {
        const transitionResult = board.transition(taskId, 'done', { agentId, summary });
        if (!transitionResult.ok) {
          return { ok: false, error: transitionResult.error || 'task_transition_failed', taskId };
        }
      }
    }
    eventLog.emit('task.done', { projectId, taskId, agentId, summary });
    const item = appendRoomEventOutboxItem(project, {
      eventType: 'task.done',
      summary: summary ?? `任务 ${taskId} 已完成`,
      sourceRefs: { projectId, taskId },
    });
    return { ok: true, taskId, projectionEventId: item?.projectionEventId ?? null };
  }

  function listRoomMemberBlockers({ projectId, logicalAgentId } = {}) {
    const project = projects.get(projectId);
    if (!project) return { blockers: [] };
    const blockers = [];
    if (project.poAgent && project.poAgent === logicalAgentId) {
      blockers.push(`project_po:${projectId}`);
    }
    if (Array.isArray(project.members) && project.members.includes(logicalAgentId)) {
      blockers.push(`project_member:${projectId}`);
    }
    // task assignees and open review owners under this project
    const board = boards.get(projectId);
    if (board && typeof board.getTasks === 'function') {
      for (const task of board.getTasks()) {
        const assignees = task?.assignees ?? (task?.assignedAgent ? [task.assignedAgent] : []);
        if (assignees.includes(logicalAgentId) && !['done', 'cancelled'].includes(task.status)) {
          blockers.push(`task_assignee:${taskId}`);
        }
      }
    }
    return { blockers };
  }

  function findReusableProjectForCreateRequest({ clientRequestKey } = {}) {
    const normalizedClientRequestKey = normalizeProjectCreateClientRequestKey(clientRequestKey);
    if (normalizedClientRequestKey) {
      const exact = [...projects.values()]
        .find(project => normalizeProjectCreateClientRequestKey(project.clientRequestKey) === normalizedClientRequestKey);
      if (exact) return exact;
    }
    return null;
  }

  function normalizeProjectNameForDisplay(value) {
    if (typeof value !== 'string') return '未命名项目';
    return value.trim().replace(/\s+/g, ' ') || '未命名项目';
  }

  function normalizeProjectCreateClientRequestKey(value) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').slice(0, 240);
  }

  function normalizeProjectStartPolicy(value) {
    if (typeof value !== 'string') return 'auto_activate_after_plan';
    const normalized = value.trim();
    if (normalized === 'auto_dispatch_after_plan') return 'activate_and_dispatch_after_plan';
    if (
      normalized === 'plan_only' ||
      normalized === 'auto_activate_after_plan' ||
      normalized === 'activate_and_dispatch_after_plan'
    ) return normalized;
    return 'auto_activate_after_plan';
  }

  function normalizeAgentIdList(values = []) {
    const result = [];
    for (const value of Array.isArray(values) ? values : []) {
      const agentId = normalizeAgentId(value);
      if (agentId && !result.includes(agentId)) result.push(agentId);
    }
    return result;
  }

  function normalizeSelectionMember(member, index, members, fallbackSource) {
    const record = member && typeof member === 'object' && !Array.isArray(member) ? member : null;
    const agentId = record
      ? (normalizeAgentId(record.agentId) || normalizeAgentId(record.id) || normalizeAgentId(members[index]))
      : (normalizeAgentId(member) || normalizeAgentId(members[index]));
    if (!agentId) return null;
    return {
      agentId,
      source: record?.source || fallbackSource,
    };
  }

  function normalizeAgentSelection({ poAgent, members = [], agentSelection = null } = {}) {
    return {
      ...(agentSelection && typeof agentSelection === 'object' ? agentSelection : {}),
      poAgent: {
        agentId: normalizeAgentId(agentSelection?.poAgent?.agentId) || normalizeAgentId(poAgent),
        source: agentSelection?.poAgent?.source || 'system_migration',
      },
      members: Array.isArray(agentSelection?.members)
        ? agentSelection.members
          .map((member, index) => normalizeSelectionMember(member, index, members, 'system_migration'))
          .filter(Boolean)
        : normalizeAgentIdList(members).map(agentId => ({
            agentId,
            source: 'system_migration',
      })),
    };
  }

  function normalizeRecoveredProject(project) {
    const normalized = {
      ...project,
      executionMode: normalizeProjectExecutionMode(project?.executionMode),
      lifecycleVersion: Number(project?.lifecycleVersion || 0),
      projectRevision: Number.isInteger(project?.projectRevision) && project.projectRevision > 0 ? project.projectRevision : 1,
      teamPlan: project?.teamPlan || null,
    };
    reconcileProjectAgentSelectionWithEffectiveAgents(normalized);
    normalized.preparation = normalizeRecoveredProjectPreparation(normalized, normalized.preparation);
    return normalized;
  }

  function normalizeRecoveredProjectPreparation(project, preparation) {
    if (!preparation || typeof preparation !== 'object') return preparation || null;
    const selectedAgentIds = new Set([
      normalizeAgentId(project?.poAgent),
      ...normalizeAgentIdList(project?.members || []),
    ].filter(Boolean));
    const keepSelectedRecord = record => {
      const agentId = normalizeAgentId(record?.agentId || record?.participantId);
      return agentId && selectedAgentIds.has(agentId);
    };
    const checks = (Array.isArray(preparation.checks) ? preparation.checks : [])
      .filter(keepSelectedRecord);
    const blockers = (Array.isArray(preparation.blockers) ? preparation.blockers : [])
      .filter(keepSelectedRecord);
    if (checks.length === 0 && blockers.length === 0) return null;
    return {
      ...preparation,
      checks,
      blockers,
      state: blockers.length > 0 ? 'blocked' : 'ready',
    };
  }

  function updateProjectExecutionMode(projectId, executionMode, { updatedBy = 'human', now = Date.now() } = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (!isValidProjectExecutionMode(executionMode)) return { ok: false, error: 'invalid_execution_mode' };
    const normalized = normalizeProjectExecutionMode(executionMode);
    project.executionMode = normalized;
    project.executionModeUpdatedAt = now;
    project.executionModeUpdatedBy = updatedBy;
    project.updatedAt = now;
    eventLog.emit('project.execution_mode.updated', {
      projectId,
      executionMode: normalized,
      updatedBy,
    });
    recordHumanAction('update_project_execution_mode', { projectId, executionMode: normalized, updatedBy });
    return { ok: true, project };
  }

  function setProjectTeamPlan(projectId, teamPlan) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (teamPlan?.projectRevision !== project.projectRevision) return { ok: false, error: 'stale_plan' };
    project.teamPlan = { ...teamPlan, status: teamPlan.status || 'proposed' };
    project.updatedAt = Date.now();
    return { ok: true, project };
  }

  function attachTeamOperationMembers(projectId, { operationId, agentIds = [] } = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    const additions = normalizeAgentIdList(agentIds).filter(agentId => agentId !== project.poAgent);
    project.members = [...new Set([...(project.members || []), ...additions])];
    project.agentSelection = normalizeAgentSelection({
      poAgent: project.poAgent,
      members: project.members,
      agentSelection: project.agentSelection,
    });
    project.teamPlan = project.teamPlan ? {
      ...project.teamPlan,
      status: 'applied',
      appliedAt: Date.now(),
      operationId,
    } : null;
    bumpProjectRevision(project, 'team_members');
    return { ok: true, project };
  }

  function invalidateTeamPlansForAgent(agentId) {
    let changed = 0;
    for (const project of projects.values()) {
      const memberIds = new Set([project.poAgent, ...(project.members || [])]);
      const referencedByPlan = (project.teamPlan?.roles || []).some(role => role.preferredExistingAgentId === agentId);
      if (!memberIds.has(agentId) && !referencedByPlan) continue;
      if (project.teamPlan && project.teamPlan.status !== 'applied') project.teamPlan = { ...project.teamPlan, status: 'stale' };
      bumpProjectRevision(project, 'agent_team_input');
      changed += 1;
    }
    return changed;
  }

  function bumpProjectRevision(project, _reason) {
    project.projectRevision = Number.isInteger(project.projectRevision) ? project.projectRevision + 1 : 1;
    project.updatedAt = Date.now();
  }

  function selectionForTask(project, task) {
    const assignedAgent = normalizeAgentId(task?.assignedAgent);
    if (!project?.agentSelection || !assignedAgent) return { agentId: assignedAgent, source: 'system_migration' };
    if (normalizeAgentId(project.agentSelection.poAgent?.agentId) === assignedAgent) {
      return { agentId: assignedAgent, source: project.agentSelection.poAgent?.source || 'system_migration' };
    }
    const member = (Array.isArray(project.agentSelection.members) ? project.agentSelection.members : [])
      .find(item => normalizeAgentId(item?.agentId || item?.id || item) === assignedAgent);
    return {
      agentId: assignedAgent,
      source: member?.source || 'system_migration',
    };
  }

  function sendAssignPo(project, effectivePlanningGuidance) {
    if (bridge) {
      bridge.send({
        type: 'intent', kind: 'assign_po',
        projectId: project.id, toParticipantId: project.poAgent,
        payload: {
          name: project.name,
          goal: project.goal,
          requirements: project.requirements || '',
          planningGuidance: effectivePlanningGuidance ?? appendQualityPlanningGuidance(project.planningGuidance || '', project.qualityPlanningGuidance || ''),
        },
      });
    }

    eventLog.emit('po.assigned', { projectId: project.id, agent: project.poAgent });
  }

  // ─── Human actions ─────────────────────────────────────────────────

  /**
   * Human 审批计划 → project becomes active
   */
  function handleApprove(projectId) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };

    // Idempotency: already active → no-op success (don't re-trigger events)
    if (project.status === 'active') {
      return { ok: true, alreadyActive: true };
    }

    // Guard: plan or tasks must exist before approval
    const board = boards.get(projectId);
    if (!project.plan && board && board.getAllTasks().length === 0) {
      return { ok: false, error: 'no_plan_or_tasks' };
    }

    project.status = 'active';
    eventLog.emit('project.approved', { projectId });
    recordHumanAction('approve_plan', { projectId, projectName: project.name });

    if (bridge) {
      bridge.send({
        type: 'intent', kind: 'plan_approved',
        projectId, toParticipantId: project.poAgent,
        payload: {},
      });
    }
    return { ok: true };
  }

  function activateAndStartProject(projectId, request = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };
    const requestContext = sanitizeRequestContext(request.requestContext);
    if (!requestContext) return { ok: false, error: 'request_context_required' };

    const idempotencyKey = readWorkflowString(request.idempotencyKey || request.activationIdempotencyKey);
    if (!idempotencyKey) return { ok: false, error: 'idempotency_key_required' };
    project.autoStartTransactions = Array.isArray(project.autoStartTransactions) ? project.autoStartTransactions : [];
    const existing = project.autoStartTransactions.find(txn => txn.idempotencyKey === idempotencyKey);
    if (existing) {
      return {
        ok: existing.ok !== false,
        idempotent: true,
        ...existing.result,
      };
    }

    if (
      request.expectedProjectVersion !== undefined &&
      Number(request.expectedProjectVersion) !== Number(project.lifecycleVersion || 0)
    ) {
      return { ok: false, error: 'project_version_conflict', currentVersion: Number(project.lifecycleVersion || 0) };
    }

    const startPolicyDecision = decideProjectStartPolicy({
      requestedStartPolicy: normalizeProjectStartPolicy(request.startPolicy || request.requestedStartPolicy),
      requestContext,
      project,
      tasks: board.getAllTasks(),
      workflowRuns: listProjectWorkflowRuns(projectId),
      agentProfiles: getProjectAgentProfiles(project),
      callerRiskHints: request.callerRiskHints,
    });
    project.startPolicyDecision = startPolicyDecision;

    if (startPolicyDecision.downgraded) {
      eventLog.emit('project.auto_start.policy_downgraded', {
        projectId,
        requestedStartPolicy: startPolicyDecision.requestedStartPolicy,
        effectiveStartPolicy: startPolicyDecision.effectiveStartPolicy,
        downgradeReasons: startPolicyDecision.downgradeReasons,
        requestSource: requestContext.requestSource,
        actorId: requestContext.actorId,
      });
    }

    let phase = 'plan_validated';
    let activation = null;
    let dispatch = null;
    let ok = true;
    let error = null;
    const fromAgent = normalizeAgentId(request.fromAgent) || project.poAgent;

    if (startPolicyDecision.effectiveStartPolicy === 'plan_only') {
      eventLog.emit('project.auto_start.plan_only', { projectId, actorId: requestContext.actorId });
    } else {
      activation = handleApprove(projectId);
      if (!activation.ok) {
        ok = false;
        error = activation.error || 'activation_failed';
        phase = 'activation_failed';
        eventLog.emit('project.auto_start.activation_failed', { projectId, error, actorId: requestContext.actorId });
      } else if (startPolicyDecision.effectiveStartPolicy === 'auto_activate_after_plan') {
        phase = 'activated';
        eventLog.emit('project.auto_start.activated', { projectId, actorId: requestContext.actorId });
      } else {
        dispatch = handleRequestDispatch(projectId, fromAgent);
        if (!dispatch.ok) {
          ok = false;
          error = dispatch.error || 'dispatch_failed';
          phase = 'dispatch_failed';
          eventLog.emit('project.auto_start.dispatch_failed', { projectId, error, actorId: requestContext.actorId });
        } else {
          phase = 'dispatch_started';
          eventLog.emit('project.auto_start.dispatch_started', {
            projectId,
            actorId: requestContext.actorId,
            dispatched: dispatch.dispatched || [],
            workflowDispatched: dispatch.workflowDispatched || [],
          });
        }
      }
    }

    bumpProjectLifecycleVersion(project);
    const result = {
      phase,
      startPolicyDecision,
      activation,
      dispatch,
      projectLifecycle: getProjectLifecycle(projectId),
      ...(error ? { error } : {}),
    };
    project.autoStartTransactions.push({
      idempotencyKey,
      ok,
      result,
      createdAt: new Date().toISOString(),
    });
    return { ok, ...result };
  }

  /**
   * 重新触发 PO 制定计划 — 用于计划卡住或失败后重试
   */
  function handleRetryPlan(projectId) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (!bridge) return { ok: false, error: 'no_bridge' };
    const board = boards.get(projectId);
    const normalized = normalizeProjectForPlanRetry(project, board?.getAllTasks() || []);
    if (!normalized.ok) return normalized;

    bridge.send({
      type: 'intent', kind: 'assign_po',
      projectId: project.id, toParticipantId: project.poAgent,
      payload: {
        name: project.name,
        goal: project.goal,
        requirements: project.requirements || '',
        planningGuidance: appendQualityPlanningGuidance(project.planningGuidance || '', project.qualityPlanningGuidance || ''),
      },
    });

    eventLog.emit('plan.retry', { projectId, po: project.poAgent, previousStatus: normalized.previousStatus });
    return { ok: true, ...normalized };
  }

  /**
   * Human 添加任务（任何时候都可以）
   * 不需要是 PO，Human 就是老板
   */
  /**
   * design §7.2：schema v2 的唯一服务入口。requestContext 由 HTTP 层
   * resolveDesktopMutationContext(req) 解析出的可信身份传入，不取自 body。
   * requestContext 缺失时（向后兼容旧调用点/旧测试）保持原有的宽松行为；
   * 一旦传入 requestContext，则强制 requestSource==='user'，拒绝非用户来源。
   */
  function handleHumanAddTasks(projectId, taskList, requestContext = null) {
    if (requestContext && requestContext.requestSource !== 'user') {
      return { ok: false, error: 'human_add_tasks_requires_user' };
    }
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };

    const board = boards.get(projectId);
    const prepared = prepareTasksForBoard(project, taskList);
    if (!prepared.ok) return prepared;

    // design §3.3：handleHumanAddTasks 是另一条真实图写入口（Room→已有
    // Project），必须与 handleCreateTasks 共用同一个 normalizeTaskGraphPolicies
    // seam，不能让 Room 添加的任务成为唯一无法声明 verified_pass 依赖策略的
    // 入口。现状核实（2026-09-02）：此前这条入口完全没有接入策略归一化。
    const identityPreview = normalizeTasksForProject(projectId, prepared.tasks, board.getAllTasks());
    if (!identityPreview.ok) return identityPreview;
    const policyResult = normalizeTaskGraphPolicies({ originalTaskList: taskList, identityPreviewTasks: identityPreview.tasks });
    if (!policyResult.ok) return policyResult;

    const added = board.addTasksChecked(prepared.tasks);
    if (!added.ok) return added;
    const ids = added.taskIds;

    applyTaskGraphPolicyWrites(project, policyResult.policyWrites);

    // If project was 'created', move to planning
    if (project.status === 'created') {
      project.status = 'planning';
    }

    eventLog.emit('tasks.added_by_human', {
      projectId,
      count: ids.length,
      tasks: prepared.tasks.map(t => ({ id: t.id, title: t.title, assignedAgent: t.assignedAgent })),
    });
    recordHumanAction('add_tasks', {
      projectId, projectName: project.name,
      taskCount: taskList.length,
      tasks: taskList.map(t => t.title),
    });

    return { ok: true, taskIds: ids };
  }

  /**
   * Human 关闭项目（唯一能关闭的角色）
   */
  function handleCloseProject(projectId, summary) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.status === 'closed') return { ok: false, error: 'already_closed' };

    project.status = 'closed';
    project.closedAt = Date.now();
    project.closedBy = 'human';
    if (summary) project.closeSummary = summary;

    eventLog.emit('project.closed', { projectId, projectName: project.name, summary });
    recordHumanAction('close_project', { projectId, projectName: project.name, summary });

    return { ok: true };
  }

  /**
   * Human 彻底删除项目（从列表中移除）
   */
  function deleteProject(projectId) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };

    projects.delete(projectId);
    boards.delete(projectId);

    eventLog.emit('project.deleted', { projectId, projectName: project.name });
    recordHumanAction('delete_project', { projectId, projectName: project.name });

    return { ok: true };
  }

  // ─── PO actions ────────────────────────────────────────────────────

  /**
   * PO 提交分解好的任务列表
   */
  function handleCreateTasks(projectId, taskList, fromAgent) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const prepared = prepareTasksForBoard(project, taskList);
    if (!prepared.ok) return prepared;

    // design §3.3（动态依赖的唯一 policy owner）：PO 可在原始任务输入里对每条
    // 依赖边声明 dependencyPolicy（key 是提交时的原始 dependency ref，与
    // task.dependencies 输入同域）。用 normalizeTasksForProject（纯函数，不
    // 修改 board 状态）预先算出稳定 task ID 归一化结果做校验，通过后再真正
    // 调用 board.addTasksChecked——避免"格式校验失败但任务已经写入 board"
    // 这种不可回滚的部分副作用。
    // 现状核实（2026-09-02）：此前这条链路完全不存在——project.dependencyPolicies
    // 从未被写入内容，verified_pass 在真实 PO 提交流程中从未真正生效。
    const identityPreview = normalizeTasksForProject(projectId, prepared.tasks, board.getAllTasks());
    if (!identityPreview.ok) return identityPreview;

    const policyResult = normalizeTaskGraphPolicies({ originalTaskList: taskList, identityPreviewTasks: identityPreview.tasks });
    if (!policyResult.ok) return policyResult;

    const added = board.addTasksChecked(prepared.tasks);
    if (!added.ok) return added;
    const ids = added.taskIds;

    applyTaskGraphPolicyWrites(project, policyResult.policyWrites);

    if (project.status === 'created') project.status = 'planning';
    eventLog.emit('tasks.created', {
      projectId, count: ids.length, by: fromAgent,
      tasks: prepared.tasks.map(t => ({ id: t.id, title: t.title, assignedAgent: t.assignedAgent })),
    });

    return { ok: true, taskIds: ids, expandedComposites: prepared.composites || [] };
  }

  function handleAssignTask(projectId, taskId, targetAgent, fromAgent) {
    const project = projects.get(projectId);
    if (!project || project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };

    task.assignedAgent = targetAgent;
    eventLog.emit('task.assigned', { projectId, taskId, taskTitle: task.title, agent: targetAgent, by: fromAgent });

    return { ok: true };
  }

  function handleReassignTask(projectId, taskId, { newAgent, reason = 'reassigned', fromPO = null } = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (!newAgent) return { ok: false, error: 'new_agent_required' };

    const board = boards.get(projectId);
    const task = board?.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };

    const previousStatus = task.status;
    let result = { ok: true };
    if (task.status === 'in_progress') {
      result = board.transition(task.id, 'failed', { failureReason: reason || 'reassigned' });
      if (result.ok) result = board.transition(task.id, 'pending');
    } else if (['dispatched', 'accepted', 'failed', 'blocked'].includes(task.status)) {
      result = board.transition(task.id, 'pending');
    } else if (task.status !== 'pending') {
      return { ok: false, error: `cannot_reassign_from_status: ${task.status}` };
    }

    if (!result?.ok) return result;

    const updatedTask = board.getTask(task.id);
    updatedTask.assignedAgent = newAgent;
    updatedTask.recoveryStatus = 'redispatch_ready';
    updatedTask.recoveryReason = reason || 'manual_reassign';

    eventLog.emit('task.reassigned', {
      projectId,
      taskId: updatedTask.id,
      taskTitle: updatedTask.title,
      newAgent,
      previousStatus,
      reason,
      by: fromPO || project.poAgent || 'system',
    });

    const dispatch = project.status === 'active'
      ? handleRequestDispatch(projectId, project.poAgent)
      : { ok: false, dispatched: [], error: 'project_not_active' };

    return {
      ok: true,
      taskId: updatedTask.id,
      newAgent,
      previousStatus,
      dispatched: dispatch.ok ? dispatch.dispatched : [],
      dispatch,
    };
  }

  function handleRequestDispatch(projectId, fromAgent, options = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.status !== 'active') return { ok: false, error: 'project_not_active' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const dispatchPlan = buildDispatchPlan(projectId);
    const onlyTaskIds = new Set((options.onlyTaskIds || []).map(String));
    const plannedTasks = onlyTaskIds.size > 0
      ? dispatchPlan.dispatchedTasks.filter(task => onlyTaskIds.has(task.id))
      : dispatchPlan.dispatchedTasks;
    const dispatched = [];
    const workflowDispatched = [];
    const workflowNodeDispatches = [];
    const workflowRunsStarted = [];
    const skipped = [...(dispatchPlan.skipped || [])];

    const projectExecutionMode = normalizeProjectExecutionMode(project.executionMode);
    const explicitTaskWorkflowDispatch = onlyTaskIds.size > 0 && plannedTasks.some(task => {
      const currentTask = board.getTask(task.id) || task;
      const selection = selectTaskExecutionStrategy({ project, task: currentTask });
      return selection.strategy === 'workflow' && selection.modeSource === 'manual_override';
    });

    const taskGraphHasDispatchableWork = plannedTasks.length > 0;
    if (projectExecutionMode === 'workflow_preferred' && !explicitTaskWorkflowDispatch && !taskGraphHasDispatchableWork) {
      const activeProjectWorkflow = findActiveProjectExecutionWorkflow(project.id);
      if (activeProjectWorkflow) {
        return {
          ok: true,
          dispatched,
          workflowDispatched,
          workflowNodeDispatches,
          workflowRuns: workflowRunsStarted,
          skipped,
          blocked: dispatchPlan.blocked,
          projectGate: 'project_workflow_running',
          activeProjectWorkflowRun: activeProjectWorkflow,
        };
      }

      const workflowResult = startProjectWorkflowFromDispatch({
        project,
        board,
        requestedBy: fromAgent,
        now: Date.now(),
      });
      if (!workflowResult.ok) {
        skipped.push({
          reason: workflowResult.error || 'project_workflow_dispatch_failed',
        });
        return {
          ok: true,
          dispatched,
          workflowDispatched,
          workflowNodeDispatches,
          workflowRuns: workflowRunsStarted,
          skipped,
          blocked: dispatchPlan.blocked,
          projectGate: dispatchPlan.projectGate,
        };
      }

      workflowRunsStarted.push(workflowResult.workflowRun);
      workflowNodeDispatches.push(...(workflowResult.dispatches || []));
      return {
        ok: true,
        dispatched,
        workflowDispatched,
        workflowNodeDispatches,
        workflowRuns: workflowRunsStarted,
        skipped,
        blocked: dispatchPlan.blocked,
        projectGate: 'project_workflow_running',
      };
    }

    for (const task of plannedTasks) {
      const currentTask = board.getTask(task.id);
      if (isReworkReadyForDispatch(currentTask)) {
        const reset = board.transition(task.id, 'pending', {
          failureReason: currentTask.failureReason,
          failureClass: currentTask.lastFailureClass,
          qualityFailureCount: currentTask.qualityFailureCount,
        });
        if (!reset.ok) continue;
      }
      const latestTask = {
        ...(board.getTask(task.id) || task),
        selectedRoute: task.selectedRoute || null,
        preferredAssignedAgent: task.preferredAssignedAgent || null,
        assignedAgent: task.assignedAgent,
      };
      const executionSelection = selectTaskExecutionStrategy({ project, task: latestTask });
      if (executionSelection.strategy === 'workflow') {
        const workflowResult = startTaskWorkflowFromDispatch({
          project,
          board,
          task: latestTask,
          selection: executionSelection,
          requestedBy: fromAgent,
          now: Date.now() + workflowRunsStarted.length * 2,
        });
        if (!workflowResult.ok) {
          skipped.push({
            taskId: task.id,
            reason: workflowResult.error || 'workflow_dispatch_failed',
            agent: task.assignedAgent,
          });
          continue;
        }
        workflowDispatched.push(task.id);
        workflowRunsStarted.push(workflowResult.workflowRun);
        workflowNodeDispatches.push(...(workflowResult.dispatches || []));
        continue;
      }
      let assignedRuntimeInstance = task.assignedRuntimeInstance || null;
      if (typeof runtimeInstanceAllocator?.reserveWorkerInstance === 'function') {
        const reservation = runtimeInstanceAllocator.reserveWorkerInstance({ project, task });
        if (reservation?.ok) {
          assignedRuntimeInstance = reservation.instanceId || null;
        } else if (reservation?.error && reservation.error !== 'not_pooled_agent') {
          skipped.push({
            taskId: task.id,
            reason: reservation.error === 'capacity_full' ? 'xiaok_capacity_full' : reservation.error,
            agent: task.assignedAgent,
          });
          continue;
        }
      }
      const result = board.transition(task.id, 'dispatched', {
        assignedAgent: task.assignedAgent,
        assignedExecutor: null,
        assignedRuntimeInstance,
        selectedRoute: task.selectedRoute || null,
      });
      if (!result.ok) continue;
      const storedTask = board.getTask(task.id);
      if (storedTask) {
        storedTask.execution = buildTaskExecutionMetadata(executionSelection, {
          workflowRunId: null,
          selectedAt: Date.now(),
        });
      }

      if (bridge) {
        const targetParticipantId = assignedRuntimeInstance || task.assignedAgent;
        const handoff = createTaskHandoffPackage({
          projectRoot: project.workFolder || project.workspacePath || (dataDir ? join(dirname(dataDir), 'handoffs', projectId) : join(tmpdir(), 'kswarm-handoffs', projectId)),
          project,
          task,
          runId: result.runId,
          targetParticipantId,
        });
        if (!handoff.ok) {
          skipped.push({ taskId: task.id, reason: handoff.error, agent: task.assignedAgent });
          continue;
        }
        bridge.requestTask({
          taskId: task.id, title: task.title, brief: task.brief,
          projectId,
          localTaskId: task.localTaskId,
          runId: result.runId,
          attempt: task.attempt || 1,
          projectName: project.name, targetParticipantId,
          handoffPath: handoff.handoffPath,
        });
      }

      eventLog.emit('task.dispatched', {
        projectId, taskId: task.id, taskTitle: task.title, agent: task.assignedAgent, target: assignedRuntimeInstance || task.assignedAgent, runtimeInstance: assignedRuntimeInstance, executionStrategy: 'direct', executionReasonCode: executionSelection.reasonCode,
      });
      dispatched.push(task.id);
    }

    return {
      ok: true,
      dispatched,
      workflowDispatched,
      workflowNodeDispatches,
      workflowRuns: workflowRunsStarted,
      skipped,
      blocked: dispatchPlan.blocked,
      projectGate: dispatchPlan.projectGate,
    };
  }

  function startTaskWorkflowFromDispatch({ project, board, task, selection, requestedBy = 'xiaok-po', now = Date.now() } = {}) {
    if (!project || !board || !task?.id) return { ok: false, error: 'task_required' };
    const proposal = createWorkflowProposal(project.id, PO_GENERATED_TASK_WORKFLOW_ID, {
      requestedBy: requestedBy || project.poAgent || 'kswarm',
      taskId: task.id,
      now,
    });
    if (!proposal.ok) return proposal;

    const started = startWorkflowRunFromProposal(proposal.workflowProposal.id, {
      projectId: project.id,
      workflowId: PO_GENERATED_TASK_WORKFLOW_ID,
      taskId: task.id,
      approvedBy: requestedBy || project.poAgent || 'kswarm',
      now: now + 1,
    });
    if (!started.ok) return started;

    const transition = board.transition(task.id, 'dispatched', {
      assignedAgent: task.assignedAgent,
      assignedExecutor: null,
      selectedRoute: task.selectedRoute || null,
      preferredAssignedAgent: task.preferredAssignedAgent || null,
      runId: `workflow-${started.workflowRun.id}`,
      leaseTimeoutMs: 24 * 60 * 60 * 1000,
    });
    if (!transition.ok) {
      cancelWorkflowRun(started.workflowRun.id, { reason: 'task_transition_failed', now: now + 2 });
      return { ok: false, error: transition.error || 'task_transition_failed' };
    }

    const storedTask = board.getTask(task.id);
    if (storedTask) {
      storedTask.execution = buildTaskExecutionMetadata(selection, {
        workflowRunId: started.workflowRun.id,
        selectedAt: now + 1,
      });
      storedTask.assignedExecutor = 'workflow';
      storedTask.activeRunId = `workflow-${started.workflowRun.id}`;
      storedTask.runLease = null;
      storedTask.updatedAt = now + 1;
    }

    eventLog.emit('task.workflow_dispatched', {
      projectId: project.id,
      taskId: task.id,
      taskTitle: task.title,
      workflowRunId: started.workflowRun.id,
      workflowId: started.workflowRun.workflowId,
      executionStrategy: 'workflow',
      executionReasonCode: selection.reasonCode,
      modeSource: selection.modeSource,
    });

    return { ok: true, workflowRun: started.workflowRun, workflowProposal: started.workflowProposal, dispatches: started.dispatches || [] };
  }

  function startProjectWorkflowFromDispatch({ project, board, requestedBy = 'xiaok-po', now = Date.now() } = {}) {
    if (!project || !board) return { ok: false, error: 'project_required' };
    const proposal = createWorkflowProposal(project.id, PO_GENERATED_PROJECT_WORKFLOW_ID, {
      requestedBy: requestedBy || project.poAgent || 'kswarm',
      now,
    });
    if (!proposal.ok) return proposal;

    const started = startWorkflowRunFromProposal(proposal.workflowProposal.id, {
      projectId: project.id,
      workflowId: PO_GENERATED_PROJECT_WORKFLOW_ID,
      approvedBy: requestedBy || project.poAgent || 'kswarm',
      now: now + 1,
    });
    if (!started.ok) return started;

    eventLog.emit('project.workflow_dispatched', {
      projectId: project.id,
      workflowRunId: started.workflowRun.id,
      workflowId: started.workflowRun.workflowId,
      executionStrategy: 'workflow',
      executionReasonCode: 'project_workflow_preferred',
      modeSource: 'project_default',
    });

    return { ok: true, workflowRun: started.workflowRun, workflowProposal: started.workflowProposal, dispatches: started.dispatches || [] };
  }

  /**
   * PO 确认任务完成（审核通过）
   */
  function handleMarkDone(projectId, taskId, fromAgent) {
    const project = projects.get(projectId);
    if (!project || project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };

    // design §8.2（handleMarkDone 项）：PO 只能确认 execution done，不能替代
    // 独立 reviewer 解锁 gate-bearing task 的 verified edge。只对
    // review_iteration_v2（走 acceptTaskGateEvidence 产出 fresh GateEvaluation
    // 的新路径）做这个检查；v1 沿用现有的 prepareReviewConditions/
    // extractReviewEvidence 机制，设计文档未要求收紧 v1 的 handleMarkDone 行为，
    // 收紧范围必须精确匹配 kind 字符串，不能用 startsWith('review_iteration')
    // 误伤 v1（曾经引发一次真实回归：auto-inference 会给标题含"Review"的任务
    // 自动分配 review_iteration_v1，若用 startsWith 匹配会让所有此类既有任务
    // 的 handleMarkDone 行为被意外收紧）。
    if (task.evidenceContract?.kind === 'review_iteration_v2') {
      const evaluations = Array.isArray(project.gateEvaluations?.[task.id]) ? project.gateEvaluations[task.id] : [];
      const hasPassedEvaluation = evaluations.some(evaluation => evaluation?.verdict === 'passed');
      if (!hasPassedEvaluation) {
        return { ok: false, error: 'gate_bearing_task_requires_evaluation', taskId: task.id };
      }
    }

    const result = board.transition(task.id, 'done');
    if (result.ok) {
      updatePlanItemCompleted(project, task);
      eventLog.emit('task.done', {
        projectId, taskId: result.taskId, taskTitle: task?.title, confirmedBy: fromAgent,
      });
      maybeCompleteCompositeParent(projectId, task);
      maybeCompleteRetryParent(projectId, task);
    }
    return result;
  }

  function handleRework(projectId, taskId, reason, fromAgent) {
    const project = projects.get(projectId);
    if (!project || project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const task = board.getTask(taskId);
    const result = board.transition(taskId, 'in_progress');
    if (result.ok) {
      eventLog.emit('task.rework', { projectId, taskId: result.taskId, taskTitle: task?.title, reason, by: fromAgent });
      if (bridge && task.assignedAgent) {
        bridge.send({
          type: 'intent', kind: 'rework',
          taskId: result.taskId, toParticipantId: task.assignedAgent,
          payload: { reason, projectId },
        });
      }
    }
    return result;
  }

  /**
   * 任务失败处理 — 自动重试
   */
  function handleTaskFail(projectId, taskId, failureReason, errorMessage) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };

    const board = boards.get(projectId);
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };

    const { classifyFailure, shouldAutoRetry, createRetryTask } = retryStrategy;
    const reason = failureReason || classifyFailure(errorMessage);

    // Mark current task as failed
    const result = board.transition(task.id, 'failed', { failureReason: reason, failureClass: reason });
    if (!result.ok) return result;

    eventLog.emit('task.failed', {
      projectId, taskId: task.id, taskTitle: task.title, failureReason: reason,
      errorMessage: errorMessage || '',
    });

    const replacement = planAgentReplacement({
      task,
      failureClass: reason,
      agents: getProjectAgentProfiles(project),
      selection: selectionForTask(project, task),
      priorReplacements: task.replacementHistory || [],
      replacementBudget: project.agentSelection?.replacementBudget || {},
    });
    if (replacement.action === 'repair_output_contract') {
      return {
        ok: true,
        taskId: task.id,
        retried: false,
        replacement,
        failureReason: reason,
      };
    }
    if (replacement.action === 'replace' && replacement.toAgentId) {
      const reset = board.transition(task.id, 'pending', { failureReason: reason, failureClass: reason });
      if (!reset.ok) return reset;
      const replacedTask = board.getTask(task.id);
      replacedTask.assignedAgent = replacement.toAgentId;
      replacedTask.replacementHistory = Array.isArray(replacedTask.replacementHistory) ? replacedTask.replacementHistory : [];
      replacedTask.replacementHistory.push({
        at: Date.now(),
        fromAgentId: replacement.fromAgentId,
        toAgentId: replacement.toAgentId,
        failureClass: reason,
        source: selectionForTask(project, task).source || 'system_migration',
      });
      replacedTask.recoveryStatus = 'redispatch_ready';
      replacedTask.recoveryReason = 'agent_replaced_after_basic_invocation_failure';
      eventLog.emit('task.agent_replaced', {
        projectId,
        taskId: replacedTask.id,
        fromAgentId: replacement.fromAgentId,
        toAgentId: replacement.toAgentId,
        failureReason: reason,
      });
      const dispatch = project.status === 'active'
        ? handleRequestDispatch(projectId, project.poAgent, { onlyTaskIds: [replacedTask.id] })
        : { ok: false, dispatched: [], skipped: [], error: 'project_not_active' };
      return {
        ok: true,
        taskId: replacedTask.id,
        retried: false,
        replaced: true,
        replacement,
        fromAgentId: replacement.fromAgentId,
        toAgentId: replacement.toAgentId,
        replacementDispatched: dispatch.ok ? dispatch.dispatched.includes(replacedTask.id) : false,
        replacementDispatch: dispatch,
        failureReason: reason,
      };
    }
    if (replacement.action === 'needs_user_confirmation') {
      const blocked = board.blockTask(task.id, {
        blockKind: 'agent_replacement_confirmation_required',
        blockedReason: '显式选择的智能体不可用，需要确认是否更换执行者。',
        failureClass: reason,
        nextActions: [
          {
            id: 'replace_agent_confirm',
            label: '确认更换执行者',
            candidates: replacement.candidates,
          },
        ],
      });
      const blockedTask = board.getTask(task.id);
      blockedTask.replacementPlan = replacement;
      return {
        ok: blocked.ok,
        taskId: task.id,
        retried: false,
        replaced: false,
        replacement,
        blocked: true,
        failureReason: reason,
      };
    }

    // Decide: auto-retry or not
    const shouldRetry = shouldAutoRetry(task);
    if (!silent) console.log('[Retry] task:', JSON.stringify({ id: task.id, attempt: task.attempt, maxAttempts: task.maxAttempts, failureReason: task.failureReason, shouldRetry }));
    if (shouldRetry) {
      const retryTask = createRetryTask(task);
      const added = board.addTasksChecked([retryTask]);
      if (!added.ok) return added;
      const retryTaskId = added.taskIds[0];
      const storedRetryTask = board.getTask(retryTaskId);
      // design §8.2（retry / resume / startup recovery 项）："只能重新进入统一
      // dispatch/project gate evaluator"。此前这里只传 tasks: [storedRetryTask]，
      // 导致 evaluateDependencySatisfaction 的 dependencyTasks 反查（taskMap.get）
      // 找不到任何真实依赖任务对象（不在这个只有一个元素的数组里），永远判定
      // dependency_task_not_found——不管 verified_pass/schemaV2 逻辑对不对，
      // 任何有依赖关系的 retry task 都会被这个更基础的数据缺失挡住。也完全没有
      // 传 dependencyPolicies/gateEvaluationsByTaskId/consumedArtifactIdsByTaskId/
      // currentGateFactsByTaskId/schemaV2，即使传对了完整任务图，仍会退化为
      // legacy completed 语义，让 verified_pass 依赖边被错误放行。这是本轮核实
      // 发现的两处真实缺陷，一并修复：传入完整任务图 + 完整 gate 判定上下文。
      const allTasks = board.getAllTasks();
      const retryConsumedArtifactIdsByTaskId = {};
      for (const t of allTasks) {
        const declarations = t?.consumedArtifactIdsByDependencyTaskId;
        if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) continue;
        retryConsumedArtifactIdsByTaskId[t.id] = declarations;
      }
      const retryDispatchPlan = storedRetryTask ? planDispatch({
        projectId,
        tasks: allTasks,
        allActiveTasks: getActiveTasksAcrossLiveProjects(),
        agentProfiles: getProjectAgentProfiles(project),
        agentConcurrency: typeof runtimeInstanceAllocator?.getAgentConcurrency === 'function'
          ? runtimeInstanceAllocator.getAgentConcurrency()
          : {},
        dependencyPolicies: project?.dependencyPolicies || {},
        gateEvaluationsByTaskId: project?.gateEvaluations || {},
        consumedArtifactIdsByTaskId: retryConsumedArtifactIdsByTaskId,
        schemaV2: project?.executionGateSchemaVersion === 2,
      }) : { dispatchedTasks: [], skipped: [] };

      let retryDispatched = false;
      let retryDispatchError = null;
      const routedRetry = retryDispatchPlan.dispatchedTasks[0];
      let assignedRuntimeInstance = routedRetry?.assignedRuntimeInstance || null;
      if (routedRetry) {
        if (typeof runtimeInstanceAllocator?.reserveWorkerInstance === 'function') {
          const reservation = runtimeInstanceAllocator.reserveWorkerInstance({ project, task: routedRetry });
          if (reservation?.ok) {
            assignedRuntimeInstance = reservation.instanceId || null;
          } else if (reservation?.error && reservation.error !== 'not_pooled_agent') {
            retryDispatchPlan.skipped.push({
              taskId: routedRetry.id,
              reason: reservation.error === 'capacity_full' ? 'xiaok_capacity_full' : reservation.error,
              agent: routedRetry.assignedAgent,
            });
            retryDispatchError = reservation.error;
          }
        }
      }
      if (routedRetry && !retryDispatchError) {
        const dispatchedRetry = board.transition(routedRetry.id, 'dispatched', {
          assignedAgent: routedRetry.assignedAgent,
          assignedExecutor: null,
          assignedRuntimeInstance,
          preferredAssignedAgent: routedRetry.preferredAssignedAgent || null,
          selectedRoute: routedRetry.selectedRoute || null,
        });
        retryDispatched = dispatchedRetry.ok;
        retryDispatchError = dispatchedRetry.ok ? null : dispatchedRetry.error;
      }
      const finalRetryTask = board.getTask(retryTaskId);

      eventLog.emit('task.retry', {
        projectId,
        originalTaskId: task.id,
        retryTaskId,
        attempt: retryTask.attempt,
        failureReason: reason,
        assignedAgent: finalRetryTask?.assignedAgent || retryTask.assignedAgent,
        retryDispatched,
        skipped: retryDispatchPlan.skipped,
      });

      return {
        ok: true,
        taskId: task.id,
        retried: true,
        retryTaskId,
        retryDispatched,
        retryDispatchError,
        retryDispatchSkipped: retryDispatchPlan.skipped,
        attempt: retryTask.attempt,
        failureReason: reason,
      };
    }

    return { ok: true, taskId: task.id, retried: false, failureReason: reason };
  }

  function handleContinueProject(projectId, request = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    return handleContinueProjectCore({
      project,
      board,
      agents: getProjectAgentProfiles(project),
      request,
      dispatchProjectTasks: options => handleRequestDispatch(projectId, project.poAgent, options),
      recoverSubmission: (taskId, result, fromAgent, meta) => handleRecoverSubmission(projectId, taskId, result, fromAgent, meta),
      emitEvent: (type, data) => eventLog.emit(type, data),
    });
  }

  function handleResolveProjectIntervention(projectId, request = {}, runtime = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found', outcome: 'not_advanced', projectChanged: false, humanActionRequired: false };
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found', outcome: 'not_advanced', projectChanged: false, humanActionRequired: false };

    return resolveProjectIntervention({
      project,
      board,
      agents: getProjectAgentProfiles(project),
      request,
      writeArtifact: runtime.writeArtifact,
      recoverSubmission: (taskId, result, fromAgent, meta) => handleRecoverSubmission(projectId, taskId, result, fromAgent, meta),
      sendReviewSubmission: runtime.sendReviewSubmission || (bridge && project.poAgent ? (({ taskId, payload }) => {
        bridge.send({
          type: 'intent',
          kind: 'review_submission',
          taskId,
          toParticipantId: project.poAgent,
          payload,
        });
      }) : null),
      emitEvent: (type, data) => eventLog.emit(type, data),
    });
  }

  /**
   * PO 提交项目交付物（兼容 adapter，design §8.2 / §17.5）
   *
   * 历史行为（已关闭的旁路）：全部任务 done + 可选 validateDelivery 通过后，
   * 直接把 project.status 置为 'delivered'，无 FinalDeliverable 记录、无用户批准、
   * 无 condition-zero 校验、无 exact artifact hash 校验。
   *
   * 现行行为：只委托 registerFinalDeliverable 注册一个 candidate，返回
   * awaiting_user_approval；真正的 'delivered' 状态只能通过 approveFinalDeliverable
   * （唯一写入口，强制 requestSource='user'、idempotency key、CAS 版本校验、
   * rerunFinalDeliverableChecks 确定性重跑）产生。
   *
   * 保留原签名（projectId, deliverable, fromAgent, options）以兼容现有 caller
   * （server/index.js 的 POST /projects/:id/deliver、cli/verify.js 等），
   * 但不再直接修改 project.status。
   */
  function handleDeliver(projectId, deliverable, fromAgent, options = {}) {
    const project = projects.get(projectId);
    if (!project || project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    if (project.planRevisionRequired) {
      return {
        ok: false,
        error: 'plan_revision_required',
        blocker: project.planRevisionRequired,
      };
    }

    // Idempotent: a delivered project is not re-delivered by calling handleDeliver again.
    if (project.status === 'delivered') {
      return { ok: true, alreadyDelivered: true, deliveredAt: project.deliveredAt };
    }

    // Gate: all tasks must be done
    const board = boards.get(projectId);
    if (board && !board.isAllDone()) {
      return { ok: false, error: 'tasks_not_all_done' };
    }

    // Gate: delivery package must be valid before we even register a candidate.
    if (typeof options.validateDelivery === 'function') {
      const validation = options.validateDelivery();
      if (!validation || validation.ok === false) {
        return { ok: false, error: validation?.error || 'delivery_package_invalid' };
      }
    }

    // 不再直写 delivered。改为注册一个 FinalDeliverable candidate，
    // 交由用户通过 approveFinalDeliverable 显式批准后才能真正交付。
    const legacyPayloadFingerprint = createHash('sha256')
      .update(stableJson(deliverable || null))
      .digest('hex');
    const legacySubmission = {
      projectId,
      kind: options.kind === 'none' ? 'none' : (deliverable?.artifactRef ? 'file' : 'none'),
      artifactRef: deliverable?.artifactRef || null,
      clientClaimedHash: options.clientClaimedHash || null,
      expectedFormat: options.expectedFormat || null,
      workspacePath: options.workFolder || options.workspacePath || null,
      source: 'legacy_handle_deliver',
      submittedBy: fromAgent,
      taskId: readWorkflowString(options.taskId) || null,
      legacyPayloadFingerprint,
    };
    const submissionIdempotencyKey = readWorkflowString(options.submissionIdempotencyKey)
      || createHash('sha256').update(stableJson(legacySubmission)).digest('hex');

    const registerResult = registerFinalDeliverable(
      projectId,
      {
        kind: legacySubmission.kind,
        artifactRef: legacySubmission.artifactRef,
        expectedFormat: legacySubmission.expectedFormat,
        clientClaimedHash: legacySubmission.clientClaimedHash,
        workFolder: legacySubmission.workspacePath,
        taskId: legacySubmission.taskId,
        submissionIdempotencyKey,
        source: legacySubmission.source,
        submittedBy: legacySubmission.submittedBy,
        legacyPayloadFingerprint,
        unboundReason: deliverable?.artifactRef ? undefined : 'legacy_summary_only_deliverable',
      },
      { requestSource: 'agent', actorId: fromAgent },
    );

    if (!registerResult.ok) return registerResult;

    if (!registerResult.idempotent) {
      registerResult.finalDeliverable.legacyDeliverablePayload = deliverable;
    }

    eventLog.emit('project.delivery_candidate_registered', {
      projectId, projectName: project.name, by: fromAgent,
      deliverableId: registerResult.finalDeliverable.deliverableId,
    });

    return {
      ok: true,
      status: 'awaiting_user_approval',
      awaitingUserApproval: true,
      finalDeliverable: registerResult.finalDeliverable,
    };
  }

  function registerFinalDeliverable(projectId, payload = {}, requestContextInput = null, { now = Date.now() } = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    const requestContext = sanitizeRequestContext(requestContextInput);
    if (!requestContext) return { ok: false, error: 'request_context_required' };

    const claimedRequestSource = payload.claimedRequestSource || payload.requestSource || null;
    if (claimedRequestSource && claimedRequestSource !== requestContext.requestSource && requestContext.requestSource !== 'user') {
      eventLog.emit('request_source_claim_mismatch', {
        projectId,
        actual: requestContext.requestSource,
        claimed: claimedRequestSource,
        actorId: requestContext.actorId,
        mutation: 'register_final_deliverable',
      });
      return { ok: false, error: 'request_source_forgery_detected' };
    }
    if (requestContext.requestSource === 'scheduler') {
      return { ok: false, error: 'scheduler_cannot_register_final_deliverable' };
    }

    const submissionIdempotencyKey = readWorkflowString(payload.submissionIdempotencyKey || payload.idempotencyKey);
    if (!submissionIdempotencyKey) return { ok: false, error: 'idempotency_key_required' };

    const kind = payload.kind === 'none' ? 'none' : 'file';
    const expectedFormat = normalizeFinalDeliverableFormat(payload.expectedFormat);
    const artifactResult = kind === 'file'
      ? prepareFinalDeliverableArtifact({ project, artifactRef: payload.artifactRef, expectedFormat, clientClaimedHash: payload.clientClaimedHash, workspacePath: payload.workFolder || payload.workspacePath })
      : { ok: true, artifactRef: null, serviceComputedHash: null };
    if (!artifactResult.ok) return artifactResult;

    const source = normalizeFinalDeliverableSource(payload.source);
    const submittedBy = readWorkflowString(payload.submittedBy) || requestContext.actorId;
    const submissionFingerprint = createHash('sha256').update(stableJson({
      projectId,
      kind,
      artifactIdentity: artifactResult.artifactRef || null,
      serviceComputedHash: artifactResult.serviceComputedHash || null,
      expectedFormat,
      workspaceBinding: readWorkflowString(payload.workFolder || payload.workspacePath) || readWorkflowString(project?.workFolder) || readWorkflowString(project?.workspacePath) || null,
      source,
      submittedBy,
      taskId: readWorkflowString(payload.taskId) || null,
      workflowRunId: readWorkflowString(payload.workflowRunId) || null,
      workflowNodeId: readWorkflowString(payload.workflowNodeId) || null,
      legacyPayloadFingerprint: readWorkflowString(payload.legacyPayloadFingerprint) || null,
    })).digest('hex');
    const existing = listFinalDeliverables(projectId)
      .find(item => item.submissionIdempotencyKey === submissionIdempotencyKey);
    if (existing) {
      if (!existing.submissionFingerprint || existing.submissionFingerprint !== submissionFingerprint) {
        return { ok: false, error: 'idempotency_conflict' };
      }
      return { ok: true, finalDeliverable: existing, idempotent: true };
    }

    const createdAt = new Date(now).toISOString();
    const deliverableId = payload.deliverableId || `fd-${createHash('sha1').update(`${projectId}\0${submissionIdempotencyKey}`).digest('hex').slice(0, 16)}`;
    const finalDeliverable = {
      deliverableId,
      projectId,
      executionNodeId: payload.executionNodeId || null,
      ...(payload.taskId ? { taskId: payload.taskId } : {}),
      ...(payload.workflowRunId ? { workflowRunId: payload.workflowRunId } : {}),
      ...(payload.workflowNodeId ? { workflowNodeId: payload.workflowNodeId } : {}),
      ...(payload.unboundReason ? { unboundReason: payload.unboundReason } : {}),
      kind,
      expectedFormat,
      ...(artifactResult.artifactRef ? { artifactRef: artifactResult.artifactRef } : {}),
      ...(artifactResult.serviceComputedHash ? { serviceComputedHash: artifactResult.serviceComputedHash } : {}),
      ...(payload.clientClaimedHash ? { clientClaimedHash: payload.clientClaimedHash } : {}),
      source,
      submittedBy,
      requiresReview: payload.requiresReview !== false || requestContext.requestSource !== 'user',
      submissionIdempotencyKey,
      submissionFingerprint,
      status: 'candidate',
      submitted: {
        requestContext,
        submittedAt: createdAt,
      },
      createdAt,
      updatedAt: createdAt,
    };

    finalDeliverables.set(deliverableId, finalDeliverable);
    bumpProjectLifecycleVersion(project, now);
    eventLog.emit('final_deliverable.candidate_registered', {
      projectId,
      deliverableId,
      source: finalDeliverable.source,
      requestSource: requestContext.requestSource,
      submittedBy: finalDeliverable.submittedBy,
    });
    return { ok: true, finalDeliverable };
  }

  function approveFinalDeliverable(projectId, deliverableId, payload = {}, requestContextInput = null, { now = Date.now() } = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    const requestContext = sanitizeRequestContext(requestContextInput);
    if (!requestContext) return { ok: false, error: 'request_context_required' };
    if (requestContext.requestSource !== 'user') {
      return { ok: false, error: 'final_deliverable_approve_requires_user' };
    }

    const finalDeliverable = finalDeliverables.get(deliverableId);
    if (!finalDeliverable || finalDeliverable.projectId !== projectId) return { ok: false, error: 'final_deliverable_not_found' };
    const approvalIdempotencyKey = readWorkflowString(payload.approvalIdempotencyKey || payload.idempotencyKey);
    if (!approvalIdempotencyKey) return { ok: false, error: 'idempotency_key_required' };
    if (finalDeliverable.status === 'approved' && finalDeliverable.approval?.approvalIdempotencyKey === approvalIdempotencyKey) {
      const decision = selectReviewGateDecisionForDeliverable(projectId, deliverableId);
      return { ok: true, finalDeliverable, reviewGateDecision: decision, idempotent: true };
    }
    if (project.planRevisionRequired) {
      return {
        ok: false,
        error: 'plan_revision_required',
        blocker: project.planRevisionRequired,
      };
    }
    if (
      payload.expectedProjectVersion !== undefined &&
      Number(payload.expectedProjectVersion) !== Number(project.lifecycleVersion || 0)
    ) {
      return { ok: false, error: 'project_version_conflict', currentVersion: Number(project.lifecycleVersion || 0) };
    }
    const preflight = preflightFinalDeliverableApproval(finalDeliverable);
    if (!preflight.ok) return preflight;

    // design §8.3 步骤 1-2：schema v2 项目额外要求通过 evaluatePreApprovalPrerequisites
    // 产出的不可变 projectGateSnapshot，写入 reviewGateDecision.projectGateSnapshotRef。
    // v1/未声明 schema 的项目保持现状（preflightFinalDeliverableApproval 的过渡性
    // 重算模式），不受影响，避免破坏现有全部通过的回归测试。
    let projectGateSnapshot = null;
    if (project.executionGateSchemaVersion === 2) {
      if (!project.canonicalArtifacts || typeof project.canonicalArtifacts !== 'object') project.canonicalArtifacts = {};
      if (typeof project.manifestRevision !== 'number') project.manifestRevision = 0;

      const board = boards.get(projectId);
      // design §8.1.1：hydrateGateFacts 的 artifactsDir 必须是 workspace 根
      // 目录，而不是再拼接一层 'artifacts' 子目录——canonical artifact 记录里
      // 的 relativePath（见 registerSubmittedArtifactsAsCanonical/
      // canonical-artifact-registry.js）已经是相对于 workspace 根的路径
      // （例如 'artifacts/report.md'），如果这里再拼一层会导致
      // readContainedArtifact 去找不存在的 'artifacts/artifacts/report.md'，
      // 让任何真实文件 deliverable 都必然 containmentPassed=false。
      // 优先使用这次候选 deliverable 实际使用的 workspace（artifactRef.workspacePath），
      // 比泛泛的 project 级 workFolder 更准确；后者只作兼容 fallback。
      const workspacePath = readWorkflowString(finalDeliverable.artifactRef?.workspacePath)
        || readWorkflowString(project.workFolder)
        || readWorkflowString(project.workspacePath);
      const hydration = hydrateGateFacts({
        project,
        requiredArtifactIds: finalDeliverable.artifactRef?.artifactId ? [finalDeliverable.artifactRef.artifactId] : [],
        expectedLifecycleVersion: project.lifecycleVersion,
        artifactsDir: workspacePath || undefined,
      });
      if (!hydration.ok) return hydration;

      const snapshotResult = evaluatePreApprovalPrerequisites({
        project,
        tasks: board?.getAllTasks() || [],
        conditions: listReviewConditions(projectId),
        finalDeliverable,
        hydratedGateFacts: hydration.facts,
        projectBlockers: [],
      });
      if (!snapshotResult.ok) return snapshotResult;
      projectGateSnapshot = snapshotResult.snapshot;
    }

    const approvedAt = new Date(now).toISOString();
    const gateId = `gate-${createHash('sha1').update(`${projectId}\0${deliverableId}\0${approvalIdempotencyKey}`).digest('hex').slice(0, 16)}`;
    if (preflight.artifactRef) finalDeliverable.artifactRef = preflight.artifactRef;
    if (preflight.serviceComputedHash) finalDeliverable.serviceComputedHash = preflight.serviceComputedHash;

    // design §8.1.1/§10.5（frozen candidate）：schema v2 项目在批准生效前，把
    // 最终 artifact 的字节原子冻结到 project 工作区内 write-once、
    // content-addressed 的 frozen/ 目录，并让 finalDeliverable.artifactRef 从此
    // 指向这份不可变副本，不再绑定可变工作文件路径。工作文件之后被覆写不会
    // 改变已批准 bytes；serviceComputedHash 已经在上面通过 preflight 用工作
    // 文件计算过，frozen 副本的 reopen rehash 必须与它一致，否则视为写入
    // 异常，fail closed（不能把批准绑定到写入失败/内容不一致的 frozen 文件）。
    if (project.executionGateSchemaVersion === 2 && finalDeliverable.kind !== 'none' && finalDeliverable.artifactRef?.path) {
      const workspaceRootForFreeze = finalDeliverable.artifactRef.workspacePath
        || readWorkflowString(project.workFolder)
        || readWorkflowString(project.workspacePath);
      if (workspaceRootForFreeze) {
        const frozen = freezeFinalCandidateArtifact({
          workspaceRoot: workspaceRootForFreeze,
          sourcePath: finalDeliverable.artifactRef.path,
          projectId,
          deliverableId,
        });
        if (!frozen.ok) return { ok: false, error: 'frozen_candidate_write_failed', detail: frozen.error };
        if (finalDeliverable.serviceComputedHash && finalDeliverable.serviceComputedHash !== `sha256:${frozen.frozen.sha256}`) {
          return { ok: false, error: 'frozen_candidate_hash_mismatch' };
        }
        finalDeliverable.artifactRef = {
          ...finalDeliverable.artifactRef,
          path: frozen.frozen.absolutePath,
          relativePath: frozen.frozen.relativePath,
          size: frozen.frozen.size,
          frozen: true,
          frozenSha256: frozen.frozen.sha256,
        };
      }
    }

    for (const candidate of listFinalDeliverables(projectId)) {
      if (candidate.deliverableId === deliverableId) continue;
      if (['candidate', 'under_review'].includes(candidate.status)) {
        candidate.status = 'superseded';
        candidate.supersededBy = deliverableId;
        candidate.updatedAt = approvedAt;
      }
    }

    finalDeliverable.status = 'approved';
    finalDeliverable.approval = {
      requestContext,
      approvedAt,
      gateId,
      approvalIdempotencyKey,
    };
    finalDeliverable.updatedAt = approvedAt;
    const decisionRecord = {
      gateId,
      projectId,
      finalDeliverableId: deliverableId,
      decision: 'passed',
      autoCloseAllowed: true,
      decidedBy: {
        requestSource: requestContext.requestSource,
        actorId: requestContext.actorId,
      },
      evidenceRefs: finalDeliverable.artifactRef ? [finalDeliverable.artifactRef] : [],
      decidedAt: approvedAt,
      // design §8.3："decision 保存本次 project gate snapshot hash、final artifact
      // hash、condition/check/evaluation IDs"。v1/未声明 schema 的项目此字段不存在
      // （undefined），保持现状不回归；schema v2 项目携带不可变 projectGateSnapshot
      // 供 verifyCommittedReviewGateDecision 未来一致性校验。
      ...(projectGateSnapshot ? { projectGateSnapshotRef: projectGateSnapshot } : {}),
    };
    reviewGateDecisions.set(gateId, decisionRecord);

    bumpProjectLifecycleVersion(project, now);
    // design §8.2/§8.3（canAutoClose 项）：只对 schema v2 项目记录"批准+自动
    // 关闭事务彻底完成后"的 lifecycleVersion/manifestRevision，供
    // project-read-model.js:canAutoClose 做无 I/O 的漂移检测——批准事务完成
    // 之后 project 若再发生额外 mutation（新增任务、canonical artifact
    // 变化），这两个值会与当时的 project 当前值不再相等，使已存在的 passing
    // decision 不能继续用于自动关闭。必须在下面 canAutoClose 分支（可能触发
    // 第二次 lifecycleVersion 递增）执行完之后才读取最终值，否则会把"批准
    // 自动关闭"自身产生的版本递增误判为"批准之后的额外 mutation"。
    // v1/未声明 schema 项目不写这两个字段，保持现状。
    const lifecycle = getProjectLifecycle(projectId);
    if (lifecycle?.canAutoClose) {
      project.deliverable = buildLegacyDeliverableFromFinal(finalDeliverable);
      project.deliveredAt = now;
      project.status = 'delivered';
      bumpProjectLifecycleVersion(project, now + 1);
      eventLog.emit('project.delivered', {
        projectId,
        projectName: project.name,
        by: requestContext.actorId,
        finalDeliverableId: deliverableId,
      });
    }
    if (projectGateSnapshot) {
      decisionRecord.decidedAtProjectVersion = project.lifecycleVersion;
      decisionRecord.decidedAtManifestRevision = project.manifestRevision;
    }
    eventLog.emit('final_deliverable.approved', {
      projectId,
      deliverableId,
      gateId,
      approvedBy: requestContext.actorId,
    });
    return { ok: true, finalDeliverable, reviewGateDecision: reviewGateDecisions.get(gateId), projectLifecycle: getProjectLifecycle(projectId) };
  }

  // ─── Worker actions ────────────────────────────────────────────────

  function handleAcceptTask(projectId, taskId, workerAgent, runId) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const runCheck = board.validateRun(task.id, runId, workerAgent);
    if (!runCheck.ok) return runCheck;
    if (task.status === 'accepted') {
      return { ok: true, alreadyAccepted: true, taskId: task.id };
    }
    const result = board.transition(task.id, 'accepted', { assignedRuntimeInstance: task.assignedRuntimeInstance || null });
    if (result.ok) {
      if (task.assignedRuntimeInstance && typeof runtimeInstanceAllocator?.markInstanceWorking === 'function') {
        runtimeInstanceAllocator.markInstanceWorking(task.assignedRuntimeInstance, { taskId: task.id });
      }
      eventLog.emit('task.accepted', { projectId, taskId: task.id, taskTitle: task?.title, agent: task.assignedAgent, runtimeInstance: task.assignedRuntimeInstance || null });
      const project = projects.get(projectId);
      if (bridge && project) {
        bridge.send({
          type: 'intent', kind: 'task_accepted',
          taskId: task.id, toParticipantId: project.poAgent,
          payload: { agent: task.assignedAgent, runtimeInstance: task.assignedRuntimeInstance || null, projectId, runId },
        });
      }
    }
    return result;
  }

  function handleProgress(projectId, taskId, stage, workerAgent, runId, telemetry = null) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const runCheck = board.validateRun(task.id, runId, workerAgent);
    if (!runCheck.ok) return runCheck;
    let result = { ok: true, taskId: task.id };
    if (stage === 'started') {
      if (task.status === 'in_progress') {
        result = { ok: true, alreadyInProgress: true, taskId: task.id };
        if (telemetry) board.updateRunTelemetry(task.id, telemetry);
      } else {
        result = board.transition(task.id, 'in_progress', telemetry ? { runTelemetry: telemetry } : {});
      }
    } else if (telemetry) {
      result = board.updateRunTelemetry(task.id, telemetry);
    }
    if (!result.ok) return result;
    if (task.assignedRuntimeInstance && typeof runtimeInstanceAllocator?.markInstanceWorking === 'function') {
      runtimeInstanceAllocator.markInstanceWorking(task.assignedRuntimeInstance, { taskId: task.id });
    }
    eventLog.emit('task.progress', { projectId, taskId: task.id, taskTitle: task?.title, stage, agent: task.assignedAgent, runtimeInstance: task.assignedRuntimeInstance || null });

    const project = projects.get(projectId);
    if (bridge && project) {
      bridge.send({
        type: 'intent', kind: 'progress_update',
        taskId: task.id, toParticipantId: project.poAgent,
        payload: { stage, agent: task.assignedAgent, runtimeInstance: task.assignedRuntimeInstance || null, projectId, runId },
      });
    }
    return result;
  }

  function handleWorkerFailure(projectId, taskId, workerAgent, runId, failureReason, errorMessage) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const runCheck = board.validateRun(task.id, runId, workerAgent);
    if (!runCheck.ok) return runCheck;

    if (
      TASK_LEVEL_WORKER_FAILURE_CLASSES.has(failureReason) &&
      task.assignedRuntimeInstance &&
      typeof runtimeInstanceAllocator?.markInstanceIdle === 'function'
    ) {
      runtimeInstanceAllocator.markInstanceIdle(task.assignedRuntimeInstance);
    }

    const failed = handleTaskFail(projectId, task.id, failureReason, errorMessage);
    if (task.assignedRuntimeInstance && typeof runtimeInstanceAllocator?.markInstanceFailed === 'function') {
      if (!TASK_LEVEL_WORKER_FAILURE_CLASSES.has(failureReason)) {
        runtimeInstanceAllocator.markInstanceFailed(task.assignedRuntimeInstance, failureReason || errorMessage || 'task_failed');
      }
    }
    return failed;
  }

  function handleSubmitResult(projectId, taskId, result, workerAgent, runId) {
    result = stripReservedTaskResultFields(result, { projectId, taskId, source: 'handleSubmitResult' });
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (task.status === 'submitted') {
      const existing = JSON.stringify(task.result || {});
      const incoming = JSON.stringify(result || {});
      if (existing === incoming) return { ok: true, alreadySubmitted: true, taskId: task.id };
      return { ok: false, error: 'duplicate_submit_conflict' };
    }
    const runCheck = board.validateRun(task.id, runId, workerAgent);
    if (!runCheck.ok) return runCheck;

    const normalizedResult = normalizeSubmissionResultForContract(task, result);
    const deliverableValidation = validateSubmittedDeliverables(task, normalizedResult);
    if (!deliverableValidation.ok) {
      task.rejectedSubmissions = Array.isArray(task.rejectedSubmissions) ? task.rejectedSubmissions : [];
      task.rejectedSubmissions.push({
        at: Date.now(),
        fromAgent: task.assignedAgent || workerAgent,
        runtimeInstance: task.assignedRuntimeInstance || null,
        runId,
        failureClass: deliverableValidation.failureClass,
        errors: deliverableValidation.errors,
        missing: deliverableValidation.missing,
        result: normalizedResult,
      });
      const failed = board.transition(task.id, 'failed', {
        failureReason: deliverableValidation.failureClass,
        failureClass: deliverableValidation.failureClass,
      });
      if (task.assignedRuntimeInstance && typeof runtimeInstanceAllocator?.markInstanceIdle === 'function') {
        runtimeInstanceAllocator.markInstanceIdle(task.assignedRuntimeInstance);
      }
      eventLog.emit('task.submission_rejected', {
        projectId,
        taskId: task.id,
        taskTitle: task.title,
        agent: task.assignedAgent || workerAgent,
        runtimeInstance: task.assignedRuntimeInstance || null,
        failureClass: deliverableValidation.failureClass,
        errors: deliverableValidation.errors,
        missing: deliverableValidation.missing,
      });
      return {
        ok: false,
        error: 'deliverable_contract_failed',
        failureClass: deliverableValidation.failureClass,
        errors: deliverableValidation.errors,
        missing: deliverableValidation.missing,
        transition: failed,
      };
    }

    const transResult = board.transition(task.id, 'submitted', { result: normalizedResult, runId });
    if (!transResult.ok) return transResult;
    if (task.assignedRuntimeInstance && typeof runtimeInstanceAllocator?.markInstanceIdle === 'function') {
      runtimeInstanceAllocator.markInstanceIdle(task.assignedRuntimeInstance);
    }

    eventLog.emit('task.submitted', {
      projectId, taskId: task.id, taskTitle: task?.title, agent: task.assignedAgent || workerAgent, runtimeInstance: task.assignedRuntimeInstance || null,
      output: normalizedResult,  // includes artifacts list
    });

    const project = projects.get(projectId);
    if (project) registerSubmittedArtifactsAsCanonical({ project, task, result: normalizedResult, runId });
    if (project) appendTaskArtifactRoomEvents(project, task.id, normalizedResult);
    if (bridge && project) {
      bridge.send({
        type: 'intent', kind: 'result_submitted',
        taskId: task.id, toParticipantId: project.poAgent,
        payload: { result: normalizedResult, agent: task.assignedAgent || workerAgent, runtimeInstance: task.assignedRuntimeInstance || null, projectId, runId },
      });
    }
    return { ok: true };
  }

  function validateSubmittedDeliverables(task, result = {}) {
    const requirements = inferTaskRequirements(task);
    const hardOutputs = (requirements.requiredOutputs || []).filter(output => output.enforcement === 'hard');
    if (hardOutputs.length === 0) return { ok: true, errors: [], missing: [], failureClass: null };
    return validateDeliverableContract({
      requiredOutputs: hardOutputs,
      artifacts: [
        ...(Array.isArray(result.artifacts) ? result.artifacts : []),
        ...(Array.isArray(result.artifactManifest) ? result.artifactManifest : []),
      ],
      workspacePath: result.workspacePath || result.workFolder || '',
    });
  }

  // design §3.2 / §16：task.result 始终是未信任的 Agent submission。提交/恢复时若包含
  // service-owned 字段（gateEvaluation、projectGateSnapshot 等），必须拒绝或剥离并记录
  // audit；所有 gate consumer 永不读取 task.result.gateEvaluation。这些字段目前虽然没有
  // 被任何 gate consumer 消费（gateEvaluationsByTaskId 只读取 project.gateEvaluations），
  // 但仍需在提交/恢复入口显式剥离，防止未来新增的消费者被静默污染。
  const RESERVED_TASK_RESULT_FIELDS = Object.freeze([
    'gateEvaluation',
    'projectGateSnapshot',
    'reviewGateDecision',
  ]);

  function stripReservedTaskResultFields(result = {}, { projectId, taskId, source } = {}) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const present = RESERVED_TASK_RESULT_FIELDS.filter(field =>
      Object.prototype.hasOwnProperty.call(result, field),
    );
    if (present.length === 0) return result;
    const stripped = { ...result };
    for (const field of present) delete stripped[field];
    eventLog.emit('task.result_reserved_fields_stripped', {
      projectId: projectId || null,
      taskId: taskId || null,
      source: source || null,
      fields: present,
    });
    return stripped;
  }

  /**
   * design §3.5/§8.1.1（canonical artifact registry 接入）：任务提交/恢复时，
   * 对 schemaVersion===2 项目扫描 result.artifacts 中每个带 path 的条目，用
   * 与 gate-evidence-acceptor.js 相同的 containment+读取逻辑重新计算真实
   * 文件 sha256，注册进 project.canonicalArtifacts。
   *
   * 现状核实（2026-09-02）：此前这个接入点完全不存在——registerCanonicalArtifacts
   * 从未被 hub.js 调用过，意味着真实生产提交流程中 canonical artifact registry
   * 永远是空对象；hydrateGateFacts/evaluatePreApprovalPrerequisites 对任何真实
   * 文件 deliverable 都会因为查不到 canonical 记录而判定
   * final_artifact_not_hydrated/final_artifact_hash_mismatch，schema v2 项目
   * 的真实文件批准流程此前完全不可用。
   *
   * 只对 schemaVersion===2 项目做这次额外 I/O（v1 项目不受影响，不引入
   * 额外读盘开销）；单条 artifact 读取失败（文件不存在/越界/超限）不阻断整个
   * 提交，只是那一条不被注册（fail closed 体现在"没有 canonical 记录"，不是
   * "让提交本身失败"——提交本身的合法性已经在 validateSubmittedDeliverables
   * 校验过）。artifact 没有显式 path 字段（只有纯文字总结）时跳过。
   */
  function registerSubmittedArtifactsAsCanonical({ project, task, result, runId } = {}) {
    if (!project || project.executionGateSchemaVersion !== 2) return;
    if (!result || typeof result !== 'object') return;

    // design §3.5/§10.1：ArtifactEvidenceExtensionV1 持久化独立于下面的
    // canonical artifact 注册（它不需要 workspacePath/真实文件读取，只是
    // agent 提交时随附的结构化审计信息），必须在下面的 artifacts.length===0
    // 提前 return 之前处理，否则一个只提交了 evidenceExtensions、没有
    // artifacts 字段的任务永远走不到这段逻辑。
    const extensions = Array.isArray(result.evidenceExtensions) ? result.evidenceExtensions : [];
    if (extensions.length > 0) {
      if (!project.artifactEvidenceExtensions || typeof project.artifactEvidenceExtensions !== 'object') {
        project.artifactEvidenceExtensions = {};
      }
      for (const extension of extensions) {
        if (!extension || typeof extension !== 'object') continue;
        const extensionArtifactId = readWorkflowString(extension.artifactId);
        const extensionRunId = readWorkflowString(extension.runId);
        if (!extensionArtifactId || !extensionRunId) continue;
        project.artifactEvidenceExtensions[extensionArtifactId] = {
          schemaVersion: 'artifact-evidence-extension-v1',
          artifactId: extensionArtifactId,
          runId: extensionRunId,
          ...(readWorkflowString(extension.supersedesArtifactId) ? { supersedesArtifactId: readWorkflowString(extension.supersedesArtifactId) } : {}),
          ...(Array.isArray(extension.claimIds) ? { claimIds: extension.claimIds.filter(id => typeof id === 'string' && id) } : {}),
          ...(extension.fetch && typeof extension.fetch === 'object' ? {
            fetch: {
              fetchedAt: readWorkflowString(extension.fetch.fetchedAt) || null,
              contentLength: typeof extension.fetch.contentLength === 'number' ? extension.fetch.contentLength : null,
              bytesStored: typeof extension.fetch.bytesStored === 'number' ? extension.fetch.bytesStored : null,
              truncated: extension.fetch.truncated === true,
              fetchCompleted: extension.fetch.fetchCompleted === true,
            },
          } : {}),
        };
      }
    }

    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    if (artifacts.length === 0) return;

    const workspacePath = readWorkflowString(result.workspacePath) || readWorkflowString(result.workFolder)
      || readWorkflowString(project.workFolder) || readWorkflowString(project.workspacePath);
    if (!workspacePath) return;

    if (!project.canonicalArtifacts || typeof project.canonicalArtifacts !== 'object') project.canonicalArtifacts = {};
    if (typeof project.manifestRevision !== 'number') project.manifestRevision = 0;

    const records = [];
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== 'object') continue;
      const artifactId = readWorkflowString(artifact.artifactId);
      const rawPath = readWorkflowString(artifact.path) || readWorkflowString(artifact.relativePath);
      if (!artifactId || !rawPath) continue;

      let workspaceRealPath;
      try {
        workspaceRealPath = realpathSync(resolve(workspacePath));
      } catch {
        continue;
      }
      // design §3.5：路径包含判断必须基于同一基准做 realpath 解析——workspacePath
      // 在 macOS 上常见是 /var/... 这样的 symlink（真实路径是 /private/var/...）。
      // 如果只对 workspaceRealPath 做 realpath、却直接对 artifact.path 原样
      // resolve 再比较，两者字符串基准不一致会让 relative() 算出荒谬的
      // "../../../.." 结果，被越界检查误判为路径逃逸（真实同一份文件被错误
      // 拒绝注册）。这里对 absoluteCandidate 也解析一次真实路径后再比较。
      const absoluteCandidate = isAbsolute(rawPath) ? rawPath : join(workspacePath, rawPath);
      let absoluteRealPath;
      try {
        absoluteRealPath = realpathSync(resolve(absoluteCandidate));
      } catch {
        continue;
      }
      const relFromRoot = relative(workspaceRealPath, absoluteRealPath);
      if (!relFromRoot || relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) continue;

      const readResult = readContainedArtifact(workspaceRealPath, relFromRoot);
      if (!readResult.ok || readResult.statChangedDuringRead) continue;

      const serviceSha256 = createHash('sha256').update(readResult.content).digest('hex');
      records.push({
        artifactId,
        relativePath: relFromRoot.replace(/\\/g, '/'),
        sha256: serviceSha256,
        taskId: task?.id || null,
        runId: runId || null,
      });
    }

    if (records.length === 0) return;
    // 跨 task/run 冲突覆写（design §3.5 明确要求拒绝）不应该让这次提交本身
    // 失败——那是 gate 判定阶段该暴露的问题，不是提交阶段。这里只是尽力
    // 注册，忽略冲突（registerCanonicalArtifacts 会整批拒绝，保持已有记录
    // 不变，不产生部分写入）。
    registerCanonicalArtifacts(project, records);
  }

  function normalizeSubmissionResultForContract(task, result = {}) {
    if (!result || typeof result !== 'object') return result;
    const requirements = inferTaskRequirements(task);
    const hasHardOutputs = (requirements.requiredOutputs || []).some(output => output.enforcement === 'hard');
    if (!task.evidenceContract && !hasHardOutputs) return result;

    const contract = task.executionContract || {};
    if (contract.requireMeaningfulSummary === false) return result;

    const min = Number(contract.minSummaryChars ?? 50);
    const summary = getResultSummary(result);
    if (summary.length >= min && !isPlaceholderSubmissionSummary(summary)) return result;

    const artifactNames = getResultArtifactNames(result);
    if (artifactNames.length === 0) return result;

    const taskLabel = task.title || task.id || '当前任务';
    const artifactLabel = artifactNames.join('、');
    const normalizedSummary = `提交任务“${taskLabel}”的产物 ${artifactLabel}，作为主要可审核输出。请 PO 按验收标准、证据要求和文件正文继续审核，不以内联摘要替代完整交付物。`;
    return {
      ...result,
      summary: normalizedSummary,
    };
  }

  function getResultSummary(result = {}) {
    const value = result.summary ?? result.text ?? result.output ?? result.content ?? '';
    return typeof value === 'string' ? value.trim() : JSON.stringify(value || '').trim();
  }

  function getResultArtifactNames(result = {}) {
    return [
      ...(Array.isArray(result.artifacts) ? result.artifacts : []),
      ...(Array.isArray(result.artifactManifest) ? result.artifactManifest : []),
    ].map(artifact => {
      if (typeof artifact === 'string') return artifact;
      return artifact?.filename || artifact?.name || artifact?.relativePath || artifact?.path || artifact?.url || '';
    }).filter(Boolean);
  }

  function isPlaceholderSubmissionSummary(value = '') {
    return /^(done|ok|complete|completed|完成|已完成|已修复|模型没有返回内容。?)$/i.test(String(value || '').trim());
  }

  function handleRecoverSubmission(projectId, taskId, result, fromAgent, meta = {}) {
    result = stripReservedTaskResultFields(result, { projectId, taskId, source: 'handleRecoverSubmission' });
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const normalizedResult = normalizeSubmissionResultForContract(task, result);
    const recovered = board.recoverSubmission(task.id, normalizedResult, { recoveredBy: fromAgent, fromAgent, ...meta });
    if (!recovered.ok) return recovered;
    eventLog.emit('task.submitted', {
      projectId, taskId: task.id, taskTitle: task.title, agent: fromAgent,
      output: normalizedResult, recovered: true,
    });
    const project = projects.get(projectId);
    if (project) registerSubmittedArtifactsAsCanonical({ project, task, result: normalizedResult, runId: meta.runId || normalizedResult?.runId });
    if (project) appendTaskArtifactRoomEvents(project, task.id, normalizedResult);
    if (bridge && project) {
      bridge.send({
        type: 'intent', kind: 'result_submitted',
        taskId: task.id, toParticipantId: project.poAgent,
        payload: { result: normalizedResult, agent: fromAgent, projectId, runId: meta.runId || normalizedResult?.runId },
      });
    }
    return recovered;
  }

  function handleResetTaskForRecovery(projectId, taskId, reason = 'lease_expired') {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const result = board.resetStaleRun(task.id, reason);
    if (result.ok) {
      eventLog.emit('task.recovery_reset', {
        projectId,
        taskId: task.id,
        taskTitle: task.title,
        reason,
      });
    }
    return result;
  }

  function handleResumeTaskForRecovery(projectId, taskId, { leaseTimeoutMs = 600_000 } = {}) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const result = board.refreshLeaseForResume(task.id, { leaseTimeoutMs });
    if (result.ok) {
      eventLog.emit('task.recovery_resumed', {
        projectId,
        taskId: task.id,
        taskTitle: task.title,
      });
    }
    return result;
  }

  function handleSuspendActiveRuns(now = Date.now()) {
    let suspended = 0;
    for (const [projectId, board] of boards) {
      const project = projects.get(projectId);
      if (project && project.status !== 'active') continue;
      for (const task of board.getAllTasks()) {
        if (!['dispatched', 'accepted', 'in_progress'].includes(task.status)) continue;
        const result = board.markRunSuspended(task.id, now);
        if (result.ok) suspended++;
      }
    }
    persistState();
    return { ok: true, suspended };
  }

  function handleResumeSuspendedRuns({ sleptMs = 0, leaseTimeoutMs = 600_000 } = {}) {
    let resumed = 0;
    for (const board of boards.values()) {
      for (const task of board.getAllTasks()) {
        if (!task.suspendedAt) continue;
        const result = board.refreshLeaseForResume(task.id, { leaseTimeoutMs });
        if (result.ok) resumed++;
      }
    }
    persistState();
    return { ok: true, resumed, sleptMs };
  }

  // ─── Plan-Do methods ────────────────────────────────────────────────

  /**
   * PO 提交结构化 Plan
   */
  function handleSubmitPlan(projectId, plan, fromAgent) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    // Guard: reject if plan already exists (use revise instead)
    if (project.plan) {
      return { ok: false, error: 'plan_already_exists' };
    }

    project.plan = { ...plan, version: 1, createdAt: Date.now(), revisions: [] };
    project.status = 'planning';

    // design §4.1：项目建立时（PO 提交计划、正式进入执行范围的时刻）由确定性
    // 纯函数 deriveRiskFloor 给出保守下界，写入 project.riskProfile。此前这个
    // 字段从未存在——risk-floor.js 是零调用孤岛，本轮接入。plannerProposal 暂不
    // 支持（planner 目前没有显式声明风险档位的字段），userSelection 同理；
    // 当前 riskProfile 恒等于 deterministicFloor，后续若 planner/用户可以显式
    // 声明档位，再通过 resolveEffectiveRiskProfile 汇总（该函数已实现并测试，
    // 本次先接入 floor 计算本身，不引入尚不存在的 plannerProposal/userSelection
    // 输入源）。
    project.riskProfile = deriveRiskFloor({ plan: project.plan, executionContracts: [], requestedOutput: project.requestedOutput || {} });

    eventLog.emit('plan.submitted', { projectId, version: 1, phaseCount: (plan.phases || []).length });
    return { ok: true, plan: project.plan };
  }

  /**
   * PO 修订 Plan（新增/删除/修改 items）
   */
  function handleRevisePlan(projectId, revision, fromAgent) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };
    if (!project.plan) return { ok: false, error: 'no_plan' };
    if (
      project.planRevisionRequired &&
      revision.resolvesPlanRevisionFromTaskId !== project.planRevisionRequired.taskId
    ) {
      return {
        ok: false,
        error: 'plan_revision_resolution_mismatch',
        blocker: project.planRevisionRequired,
      };
    }

    const board = boards.get(projectId);
    const newVersion = project.plan.version + 1;
    let appliedChanges = 0;

    // Apply changes
    for (const change of (revision.changes || [])) {
      if (change.type === 'add' && change.item) {
        // Add new item to specified phase
        const phase = project.plan.phases.find(p => p.id === change.phaseId);
        if (phase) {
          phase.items.push(change.item);
          // Also create task on the board
          const prepared = prepareTasksForBoard(project, [{
            id: change.item.id,
            title: change.item.title,
            brief: change.item.brief,
            assignedAgent: change.item.assignedAgent || null,
            dependencies: change.item.dependencies || [],
            phaseId: change.phaseId,
            planItemId: change.item.id,
            acceptanceCriteria: change.item.acceptanceCriteria || '',
          }]);
          if (!prepared.ok) return prepared;
          const added = board.addTasksChecked(prepared.tasks);
          if (!added.ok) return added;
          appliedChanges++;
        }
      } else if (change.type === 'drop' && change.itemId) {
        // Drop item from plan + cancel task
        for (const phase of project.plan.phases) {
          const idx = phase.items.findIndex(i => i.id === change.itemId);
          if (idx >= 0) {
            phase.items[idx].status = 'dropped';
            appliedChanges++;
            break;
          }
        }
        const task = board.getTask(change.itemId);
        if (task) board.transition(task.id, 'cancelled');
      } else if (change.type === 'modify' && change.itemId) {
        // Modify item field
        for (const phase of project.plan.phases) {
          const item = phase.items.find(i => i.id === change.itemId);
          if (item && change.field) {
            item[change.field] = change.newValue;
            appliedChanges++;
            break;
          }
        }
      }
    }

    project.plan.version = newVersion;
    project.plan.revisions.push({ version: newVersion, ts: Date.now(), reason: revision.reason, changes: revision.changes });

    // design §4.1："用户可以撤销 planner 额外抬高的档位，但不能降到 deterministic
    // floor 以下"。修订后重新计算 floor，但通过 resolveEffectiveRiskProfile
    // 保证 riskProfile 不会低于修订前已经确定的档位（deterministicFloor 参数
    // 传入修订前的 riskProfile，而不是重新算出的新值——"floor 只能不降"的语义
    // 由已确定的 riskProfile 本身充当新的下界）。
    const revisedFloor = deriveRiskFloor({ plan: project.plan, executionContracts: [], requestedOutput: project.requestedOutput || {} });
    project.riskProfile = resolveEffectiveRiskProfile({
      deterministicFloor: project.riskProfile || 'low',
      plannerProposal: revisedFloor,
    });

    if (
      appliedChanges > 0 &&
      project.planRevisionRequired &&
      revision.resolvesPlanRevisionFromTaskId === project.planRevisionRequired.taskId
    ) {
      project.planRevisionRequired = null;
      bumpProjectLifecycleVersion(project);
    }

    eventLog.emit('plan.revised', { projectId, version: newVersion, reason: revision.reason });
    return { ok: true, plan: project.plan, version: newVersion, appliedChanges };
  }

  /**
   * PO 质量验收任务
   */
  function handleQualityReview(projectId, taskId, review, fromAgent) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };

    // Guard: skip if already reviewed and task is not re-submitted after rework
    if (task.reviewResult && task.status !== 'submitted') {
      return { ok: true, alreadyReviewed: true };
    }

    let effectiveReview = review;
    let preparedConditions = { ok: true, conditions: [] };
    if (review.passed && task.evidenceContract && task.result) {
      const validation = validateTaskResultAgainstContract(task, task.result);
      if (!validation.ok) {
        effectiveReview = {
          ...review,
          passed: false,
          feedback: [review.feedback, ...validation.errors].filter(Boolean).join('\n'),
          failureClass: validation.failureClass,
        };
      } else if (isContractFamily(task.evidenceContract.kind, 'review_iteration')) {
        const submissionIdentity = task.lastRunLease?.assignedRuntimeInstance
          || task.lastRunLease?.assignedAgent
          || task.recoveredBy
          || null;
        const reviewRunId = task.lastRunLease?.runId || task.recoveredRunId || null;
        // design §5.1.1：contract-kind-registry 的 validator 字段仍标记
        // review_iteration_v2 为 supported:false/validator:null（那是
        // execution-contract.js 完整 kind 分派尚未接入的声明），但 kind 字符串
        // 本身已经足够精确区分 v1/v2，不需要等 registry 的 supported 标记才能
        // 让 handleQualityReview 走正确的 v2 gate 解析路径。
        const isV2Review = task.evidenceContract.kind === 'review_iteration_v2';

        if (isV2Review) {
          // design §3.2/§8.2：v2 gate 解析必须走 acceptTaskGateEvidence 的
          // 六步流程（唯一 ID、canonical manifest、realpath containment、
          // service hash 重算比对、schema 校验、fail closed），不能再用
          // extractReviewEvidence 的 inline-merge/endsWith 模糊匹配旧逻辑——
          // 那条路径没有 hash 校验，会让篡改后的 review-evidence.json 被
          // 当作合法证据消费。
          const gateEvidenceArtifactId = task.result?.gateEvidenceArtifactId;
          const canonicalManifest = Array.isArray(task.result?.canonicalArtifactManifest)
            ? task.result.canonicalArtifactManifest
            : [];
          const gateResult = acceptTaskGateEvidence({
            projectId,
            taskId: task.id,
            runId: reviewRunId,
            artifactsDir: task.result?.workspacePath || task.result?.workFolder || '',
            gateEvidenceArtifactId,
            assignedAgent: task.assignedAgent,
            reviewerParticipantId: fromAgent,
            producerParticipantId: submissionIdentity,
            canonicalArtifactLookup: (id) => canonicalManifest.find(entry => entry?.artifactId === id) || null,
            // §9.1 权限语义："Agent 只可为自己被分派的 task 提交 evidence artifact"
            // 约束的是提交这份 gate evidence 的 agent（task.assignedAgent，即
            // submissionIdentity），不是触发本次解析动作的调用者（这里是 PO
            // 通过 handleQualityReview 审查已提交的证据，PO 走独立的
            // `project.poAgent !== fromAgent` 鉴权，不应复用 agent-ownership 检查）。
          }, { kind: 'agent', participantId: submissionIdentity || task.assignedAgent });

          if (!gateResult.ok) return gateResult;

          preparedConditions = { ok: true, conditions: gateResult.conditions };
          // design §3.2 权威关系表格："task.reviewResult.passed 唯一含义是 PO
          // 接受该任务的执行质量；service-owned gateEvaluations[].verdict
          // 唯一含义是该 review/check 对精确 subject artifact 版本的业务结论。
          // 两者独立，互不解锁对方"。此前的实现让 gateResult.evaluation.verdict
          // !== 'passed' 无条件覆盖 effectiveReview.passed=false，这会让
          // "核验任务本身执行完成、只是核验结论是 blocked"这个设计文档 §14.4
          // 明确要求的场景（独立 verifier 完成一次真实的 hash 核验工作，
          // 核验结论恰好是 mismatch）永远无法走到 done——PO 想要确认的是
          // "这次核验工作本身做得对不对"，不是"核验结论好不好"。真正阻止
          // gate 被绕过的是 evaluateDependencySatisfaction 只消费
          // project.gateEvaluations 里的 fresh passed verdict（与这里的
          // task.reviewResult.passed 完全独立），不需要靠这里的耦合来兜底
          // fail-closed；这里的耦合此前也没有任何测试真正锁定它（只有防篡改
          // 测试和 verdict=passed 的正常场景，从未测过合法 verdict=blocked
          // 场景应该发生什么），是一个未经验证的隐含假设，与设计文档冲突。
          // 仍然把 verdict 附加进 feedback，保留可审计性；只是不再据此翻转
          // PO 明确声明的 passed。
          if (gateResult.evaluation.verdict !== 'passed') {
            effectiveReview = {
              ...review,
              feedback: [review.feedback, `gate evaluation verdict=${gateResult.evaluation.verdict}`].filter(Boolean).join('\n'),
            };
          }
          if (!project.gateEvaluations || typeof project.gateEvaluations !== 'object') project.gateEvaluations = {};
          const existingEvaluations = Array.isArray(project.gateEvaluations[task.id]) ? project.gateEvaluations[task.id] : [];
          project.gateEvaluations[task.id] = [...existingEvaluations, gateResult.evaluation];
        } else {
          const reviewEvidence = extractReviewEvidence(
            task.result,
            task.result.workspacePath || task.result.workFolder || '',
          );
          preparedConditions = prepareReviewConditions({
            projectId,
            sourceTaskId: task.id,
            sourceReviewRunId: reviewRunId,
            originatingReviewerIdentity: submissionIdentity,
            findings: reviewEvidence.findings,
          });
          if (!preparedConditions.ok) return preparedConditions;
        }
      }
    }

    const reviewResult = {
      passed: effectiveReview.passed,
      feedback: effectiveReview.feedback || '',
      failureClass: effectiveReview.failureClass || null,
      planRevisionNeeded: effectiveReview.planRevisionNeeded === true,
      reviewedAt: Date.now(),
    };
    task.reviewResult = reviewResult;
    task.qualityReviewHistory = Array.isArray(task.qualityReviewHistory) ? task.qualityReviewHistory : [];
    task.qualityReviewHistory.push(reviewResult);
    if (reviewResult.planRevisionNeeded) {
      project.planRevisionRequired = {
        taskId: task.id,
        feedback: reviewResult.feedback,
        requestedAt: new Date(reviewResult.reviewedAt).toISOString(),
      };
      bumpProjectLifecycleVersion(project, reviewResult.reviewedAt);
    }

    // design §3.4：condition 的产生与 review 的 passed/failed 判定是两件独立的事。
    // 即使本次 review 因 verdict=blocked 最终判定失败（effectiveReview.passed=false），
    // 已经确定性导入的 blocking condition 仍必须被持久化——否则这条"存在未解决的
    // 阻断性问题"的记录本身就会丢失，后续既无法追踪也无法通过独立验证解决它，
    // approveFinalDeliverable 的 open blocking condition 检查也会因为查不到任何
    // condition 而错误放行。此前的实现只在 effectiveReview.passed 分支里调用
    // commitReviewConditions，这是一个真实 bug（RED 由
    // test/approve-final-deliverable-snapshot-integration.test.js 的阻断场景发现）。
    commitReviewConditions(preparedConditions.conditions);

    if (effectiveReview.passed) {
      // If already done (e.g. self-completed PO task), just update plan item
      if (task.status === 'done') {
        updatePlanItemCompleted(project, task);
        eventLog.emit('task.quality_reviewed', { projectId, taskId, passed: true, feedback: effectiveReview.feedback });
        return { ok: true, effectivePassed: true };
      }
      const result = board.transition(task.id, 'done');
      if (result.ok) {
        updatePlanItemCompleted(project, task);
        eventLog.emit('task.quality_reviewed', { projectId, taskId: task.id, passed: true, feedback: effectiveReview.feedback });
        maybeCompleteCompositeParent(projectId, task);
        maybeCompleteRetryParent(projectId, task);
      }
      return { ...result, effectivePassed: Boolean(result.ok) };
    }
    return handleQualityFailure(task, effectiveReview);

    function handleQualityFailure(failedTask, failedReview) {
      const decision = superviseTaskFailure(failedTask, {
        source: 'quality_review',
        failureClass: failedReview.failureClass || 'quality_content_failed',
        feedback: failedReview.feedback || '',
      });
      const effectiveDecision = decision;
      failedTask.qualityFailureCount = effectiveDecision.qualityFailureCount;
      failedTask.lastFailureClass = effectiveDecision.failureClass;

      eventLog.emit('task.quality_reviewed', {
        projectId,
        taskId: failedTask.id,
        passed: false,
        feedback: failedReview.feedback,
        failureClass: effectiveDecision.failureClass,
        action: effectiveDecision.action,
      });

      if (effectiveDecision.action === 'block') {
        const blocked = board.blockTask(failedTask.id, effectiveDecision);
        if (blocked.ok) {
          eventLog.emit('task.blocked', {
            projectId,
            taskId: failedTask.id,
            taskTitle: failedTask.title,
            blockKind: effectiveDecision.blockKind,
            failureClass: effectiveDecision.failureClass,
            reason: effectiveDecision.blockedReason,
            nextActions: effectiveDecision.nextActions,
          });
        }
        return {
          ok: blocked.ok,
          effectivePassed: false,
          blocked: true,
          failureClass: effectiveDecision.failureClass,
          nextActions: effectiveDecision.nextActions,
          feedback: failedReview.feedback,
        };
      }

      const result = board.transition(failedTask.id, 'pending', {
        failureReason: failedReview.feedback,
        failureClass: effectiveDecision.failureClass,
        qualityFailureCount: effectiveDecision.qualityFailureCount,
      });
      const dispatch = result.ok && project.status === 'active'
        ? handleRequestDispatch(projectId, project.poAgent)
        : { ok: false, dispatched: [], error: project.status === 'active' ? 'transition_failed' : 'project_not_active' };
      return {
        ok: result.ok,
        effectivePassed: false,
        rework: true,
        dispatched: dispatch.ok ? dispatch.dispatched : [],
        dispatch,
        feedback: failedReview.feedback,
        nextActions: effectiveDecision.nextActions,
      };
    }
  }

  // ─── Query ─────────────────────────────────────────────────────────

  function getProject(id) { return projects.get(id); }
  function getBoard(projectId) { return boards.get(projectId); }
  function getEventLog() { return eventLog; }
  function listProjects() { return [...projects.values()]; }
  function listFinalDeliverables(projectId = null) {
    return [...finalDeliverables.values()]
      .filter(item => (projectId ? item.projectId === projectId : true))
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  }
  function listReviewGateDecisions(projectId = null) {
    return [...reviewGateDecisions.values()]
      .filter(item => (projectId ? item.projectId === projectId : true))
      .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')));
  }
  function listReviewConditions(projectId) {
    return [...reviewConditions.values()]
      .filter(item => item.projectId === projectId)
      .sort((a, b) => String(a.conditionId).localeCompare(String(b.conditionId)));
  }
  function prepareReviewConditions({ projectId, sourceTaskId, sourceReviewRunId, originatingReviewerIdentity, findings }) {
    const conditions = [];
    try {
      for (const finding of Array.isArray(findings) ? findings : []) {
        if (finding?.blocking !== true) continue;
        conditions.push(buildReviewConditionFromFinding({
          projectId,
          sourceTaskId,
          sourceReviewRunId,
          originatingReviewerIdentity,
          finding,
        }));
      }
    } catch (error) {
      return { ok: false, error: error?.message || 'review_condition_invalid' };
    }
    for (const condition of conditions) {
      const existing = reviewConditions.get(condition.conditionId);
      if (existing && stableJson(existing) !== stableJson(condition)) {
        return { ok: false, error: 'idempotency_conflict' };
      }
    }
    return { ok: true, conditions };
  }
  function commitReviewConditions(conditions = []) {
    for (const condition of conditions) reviewConditions.set(condition.conditionId, condition);
  }
  function submitReviewConditionEvidence(projectId, conditionId, payload = {}, requestContextInput = null) {
    if (!projects.has(projectId)) return { ok: false, error: 'project_not_found' };
    const condition = reviewConditions.get(conditionId);
    if (!condition) return { ok: false, error: 'review_condition_not_found' };
    if (condition.projectId !== projectId) return { ok: false, error: 'review_condition_project_mismatch' };
    const requestContext = sanitizeRequestContext(requestContextInput);
    if (!requestContext) return { ok: false, error: 'request_context_required' };
    const result = submitConditionEvidence(condition, {
      ...payload,
      requestSource: requestContext.requestSource,
    });
    if (result.ok) reviewConditions.set(conditionId, result.condition);
    return result;
  }
  function resolveReviewConditionEntry(projectId, conditionId, payload = {}, requestContextInput = null) {
    if (!projects.has(projectId)) return { ok: false, error: 'project_not_found' };
    const condition = reviewConditions.get(conditionId);
    if (!condition) return { ok: false, error: 'review_condition_not_found' };
    if (condition.projectId !== projectId) return { ok: false, error: 'review_condition_project_mismatch' };
    const requestContext = sanitizeRequestContext(requestContextInput);
    if (!requestContext) return { ok: false, error: 'request_context_required' };
    const result = resolveReviewCondition(condition, {
      ...payload,
      requestSource: requestContext.requestSource,
    });
    if (result.ok && !result.alreadyResolved) reviewConditions.set(conditionId, result.condition);
    return result;
  }
  function getExecutionGraph(projectId) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return null;
    return deriveExecutionGraph({
      project,
      tasks: board.getAllTasks(),
      workflowRuns: listProjectWorkflowRuns(projectId),
      finalDeliverables: listFinalDeliverables(projectId),
    });
  }
  function getProjectLifecycle(projectId) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return null;
    return deriveProjectLifecycle({
      project,
      tasks: board.getAllTasks(),
      workflowRuns: listProjectWorkflowRuns(projectId),
      finalDeliverables: listFinalDeliverables(projectId),
      reviewGateDecisions: listReviewGateDecisions(projectId),
      reviewConditions: listReviewConditions(projectId),
    });
  }
  function getDispatchPlan(projectId) { return buildDispatchPlan(projectId); }
  function getProjectHealth(projectId) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return null;
    return deriveProjectHealth({
      project,
      tasks: board.getAllTasks(),
      dispatchPlan: buildDispatchPlan(projectId),
    });
  }

  /**
   * design §9.1/§9.3：getProjectGateSnapshot(projectId) 返回专用只读 DTO——
   * phase、counts、condition summaries、artifact ID/hash、user actions。
   * 显式 allowlist 字段，不透传 HydratedGateFactsV1、绝对/内部路径、raw
   * evidence body、service I/O error detail 或 actor secret。preload 层不需要
   * 再做二次过滤（这里已经是唯一、完整的白名单构造点），但 preload contract
   * 仍应做一次防御性 allowlist（见 desktop 侧实现），避免这里将来被误改成
   * 透传更多字段时才第一次被拦截。
   */
  function getProjectGateSnapshot(projectId) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };

    const lifecycle = deriveProjectLifecycle({
      project,
      tasks: board.getAllTasks(),
      workflowRuns: listProjectWorkflowRuns(projectId),
      finalDeliverables: listFinalDeliverables(projectId),
      reviewGateDecisions: listReviewGateDecisions(projectId),
      reviewConditions: listReviewConditions(projectId),
    });

    const conditionSummaries = listReviewConditions(projectId).map(condition => ({
      conditionId: condition.conditionId,
      severity: condition.severity,
      status: condition.status,
      blocking: condition.blocking === true,
    }));

    const artifacts = Object.values(project.canonicalArtifacts && typeof project.canonicalArtifacts === 'object' ? project.canonicalArtifacts : {})
      .map(artifact => ({ artifactId: artifact.artifactId, sha256: artifact.sha256 }));

    const candidateDeliverables = listFinalDeliverables(projectId).filter(d => d.status === 'candidate');
    const userActions = [];
    if (candidateDeliverables.length > 0 && conditionSummaries.every(c => !c.blocking || c.status === 'resolved')) {
      userActions.push({ action: 'approve_final_deliverable', deliverableId: candidateDeliverables[0].deliverableId });
    }
    if (project.planRevisionRequired) {
      userActions.push({ action: 'revise_plan' });
    }

    return {
      ok: true,
      snapshot: {
        projectId,
        phase: lifecycle?.state || null,
        counts: lifecycle?.counts || null,
        conditionSummaries,
        artifacts,
        userActions,
      },
    };
  }

  function getProjectIntervention(projectId) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return null;
    const dispatchPlan = buildDispatchPlan(projectId);
    const taskIntervention = deriveProjectIntervention({
      project,
      tasks: board.getAllTasks(),
      agents: getProjectAgentProfiles(project),
      dispatchPlan,
    });
    // Task-board intervention always takes priority. Only when there is no
    // actionable task intervention do we fall back to a resumable dynamic
    // (script_generated) workflow so the conversational "让小K帮忙" entry can
    // drive its recovery.
    if (taskIntervention && taskIntervention.required) return taskIntervention;
    const scriptIntervention = deriveScriptWorkflowIntervention(projectId);
    if (scriptIntervention) return scriptIntervention;
    return taskIntervention;
  }
  function createWorkflowProposal(projectId, workflowId, { requestedBy = 'human', policy = null, taskId = null, now = Date.now() } = {}) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };
    const sourceTask = resolveWorkflowSourceTask(board, taskId);
    if (!sourceTask.ok) return sourceTask;

    const workerAgent = (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';
    const reviewerAgent = project.poAgent || 'xiaok-po';
    let spec;
    let source = 'builtin';
    if (workflowId === PROJECT_DIAGNOSE_WORKFLOW_ID) {
      spec = createProjectDiagnoseWorkflowSpec({ project });
    } else if (workflowId === AGENT_REVIEW_SMOKE_WORKFLOW_ID) {
      spec = createAgentReviewSmokeWorkflowSpec({ project, task: sourceTask.task, workerAgent, reviewerAgent });
      source = 'builtin-smoke';
    } else if (workflowId === PO_GENERATED_PROJECT_WORKFLOW_ID) {
      spec = createPoGeneratedProjectWorkflowSpec({
        project,
        tasks: board.getAllTasks(),
        workerAgent,
        reviewerAgent,
      });
      source = 'po_generated_project';
    } else if (workflowId === PO_GENERATED_TASK_WORKFLOW_ID) {
      if (!sourceTask.task) return { ok: false, error: 'workflow_task_required' };
      spec = createPoGeneratedTaskWorkflowSpec({
        project,
        task: sourceTask.task,
        workerAgent: sourceTask.task.assignedAgent || workerAgent,
        reviewerAgent,
      });
      source = 'po_generated';
    } else {
      return { ok: false, error: 'workflow_template_not_found' };
    }
    const proposalSourceTask = workflowId === PO_GENERATED_PROJECT_WORKFLOW_ID ? null : sourceTask.task;

    const validation = validateWorkflowSpec(spec, {
      policy: policy || defaultWorkflowPolicyFor(spec),
      capabilities: WORKFLOW_AGENT_CAPABILITIES,
    });
    if (!validation.ok) return validation;
    const budgetGate = buildWorkflowBudgetGate(spec, policy || defaultWorkflowPolicyFor(spec));

    const workflowProposal = {
      id: `wfp-${projectId}-${workflowId}-${now}`,
      projectId,
      workflowId,
      strategy: 'workflow',
      source,
      scope: spec.scope,
      sourceTask: proposalSourceTask ? formatWorkflowSourceTask(proposalSourceTask) : null,
      title: spec.name,
      description: spec.description,
      goal: spec.description,
      status: 'pending',
      requestedBy,
      createdAt: now,
      updatedAt: now,
      specHash: hashWorkflowSpec(spec),
      spec,
      phases: spec.phases.map(phase => ({
        id: phase.id,
        title: phase.title,
        nodes: phase.nodes.map(node => ({ id: node.id, title: node.title, kind: node.kind, required: node.required, dependsOn: node.dependsOn || [] })),
      })),
      budgets: spec.budgets,
      budgetGate,
      permissions: spec.permissions,
      outputContract: spec.outputContract,
      acceptanceRubric: spec.acceptanceRubric,
      assumptions: spec.assumptions || [],
      approval: {
        required: true,
        status: 'pending',
        budget: spec.budgets,
        approvedBy: null,
        decidedAt: null,
      },
    };
    workflowProposals.set(workflowProposal.id, workflowProposal);
    eventLog.emit('workflow.proposal.created', {
      projectId,
      workflowProposalId: workflowProposal.id,
      workflowId,
      requestedBy,
    });
    return { ok: true, workflowProposal, dispatches: [] };
  }

  function cancelWorkflowProposal(workflowProposalId, { reason = 'human_cancelled', now = Date.now() } = {}) {
    const proposal = workflowProposals.get(workflowProposalId);
    if (!proposal) return { ok: false, error: 'workflow_proposal_not_found' };
    if (proposal.approval?.status !== 'pending') return { ok: false, error: 'workflow_proposal_not_pending' };
    const cancelled = {
      ...proposal,
      status: 'cancelled',
      updatedAt: now,
      approval: {
        ...proposal.approval,
        status: 'rejected',
        decidedAt: now,
        rejectionReason: reason,
      },
    };
    workflowProposals.set(cancelled.id, cancelled);
    eventLog.emit('workflow.proposal.cancelled', {
      projectId: cancelled.projectId,
      workflowProposalId,
      workflowId: cancelled.workflowId,
      reason,
    });
    return { ok: true, workflowProposal: cancelled };
  }

  function createScriptWorkflowProposal(projectId, preview, { requestedBy = 'human', now = Date.now(), scriptSource = null } = {}) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };

    const validation = validateScriptWorkflowPreview(projectId, preview);
    if (!validation.ok) return validation;
    const normalized = validation.preview;

    let persistedScriptSource = null;
    if (scriptSource != null) {
      const sourceValidation = validateScriptSource(scriptSource, normalized.scriptHash);
      if (!sourceValidation.ok) return sourceValidation;
      persistedScriptSource = sourceValidation.scriptSource;
    }

    const workflowProposal = {
      id: `wfp-${projectId}-${normalized.workflowId}-${now}`,
      projectId,
      workflowId: normalized.workflowId,
      strategy: 'workflow',
      source: 'script_generated',
      scope: normalized.scope,
      sourceTask: null,
      title: normalized.title,
      description: normalized.description,
      goal: normalized.description,
      status: 'pending',
      requestedBy,
      createdAt: now,
      updatedAt: now,
      scriptHash: normalized.scriptHash,
      scriptSource: persistedScriptSource,
      scriptPreview: normalized,
      scriptMeta: normalized.meta,
      scriptAnalysis: normalized.analysis,
      phases: normalized.phases.map(phase => ({
        id: phase.id,
        title: phase.title,
        detail: phase.detail || null,
        nodes: [],
      })),
      budgets: null,
      budgetGate: null,
      permissions: null,
      outputContract: null,
      acceptanceRubric: null,
      assumptions: [],
      approval: {
        required: true,
        status: 'pending',
        budget: null,
        approvedBy: null,
        decidedAt: null,
      },
    };
    workflowProposals.set(workflowProposal.id, workflowProposal);
    eventLog.emit('workflow.proposal.created', {
      projectId,
      workflowProposalId: workflowProposal.id,
      workflowId: normalized.workflowId,
      source: 'script_generated',
      requestedBy,
    });
    return { ok: true, workflowProposal, dispatches: [] };
  }

  function startWorkflowRunFromProposal(workflowProposalId, {
    approvedBy = 'human',
    now = Date.now(),
    projectId = null,
    workflowId = null,
    taskId = null,
    policy = null,
  } = {}) {
    const proposal = workflowProposals.get(workflowProposalId);
    if (!proposal) return { ok: false, error: 'workflow_proposal_not_found' };
    if (proposal.approval?.status !== 'pending') return { ok: false, error: 'workflow_proposal_not_pending' };
    if (projectId && proposal.projectId !== projectId) {
      return { ok: false, error: 'workflow_proposal_project_mismatch' };
    }
    if (workflowId && proposal.workflowId !== workflowId) {
      return { ok: false, error: 'workflow_proposal_workflow_mismatch' };
    }
    if (taskId && proposal.scope?.taskId && proposal.scope.taskId !== taskId) {
      return { ok: false, error: 'workflow_proposal_task_mismatch' };
    }
    const project = projects.get(proposal.projectId);
    const board = boards.get(proposal.projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };
    const sourceTask = resolveWorkflowSourceTask(board, proposal.scope?.taskId || taskId || null);
    if (!sourceTask.ok) return sourceTask;

    const hardBudget = validateWorkflowSpec(proposal.spec, {
      policy: policy || proposal.budgetGate?.hardLimits || defaultWorkflowPolicyFor(proposal.spec),
      capabilities: WORKFLOW_AGENT_CAPABILITIES,
    });
    if (!hardBudget.ok) return hardBudget;

    const approvedProposal = {
      ...proposal,
      status: 'approved',
      updatedAt: now,
      approval: {
        ...proposal.approval,
        status: 'approved',
        approvedBy,
        decidedAt: now,
      },
    };
    workflowProposals.set(approvedProposal.id, approvedProposal);

    if (proposal.workflowId === PROJECT_DIAGNOSE_WORKFLOW_ID) {
      const result = startProjectDiagnoseWorkflow(proposal.projectId, { requestedBy: approvedBy, now });
      if (!result.ok) return result;
      const workflowRun = applyProposalMetadataToRun(result.workflowRun, approvedProposal, { now });
      workflowRuns.set(workflowRun.id, workflowRun);
      return { ok: true, workflowRun, workflowProposal: approvedProposal, dispatches: [] };
    }

    if (proposal.workflowId === AGENT_REVIEW_SMOKE_WORKFLOW_ID) {
      const workerAgent = (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';
      let workflowRun = createAgentReviewSmokeWorkflowRun({
        project,
        tasks: board.getAllTasks(),
        task: sourceTask.task,
        workerAgent,
        reviewerAgent: project.poAgent || 'xiaok-po',
        requestedBy: approvedBy,
        now,
      });
      workflowRun = applyProposalMetadataToRun(workflowRun, approvedProposal, { now });
      const dispatched = dispatchWorkflowNode(workflowRun, 'worker-diagnose-project', {
        assignedAgent: workerAgent,
        now,
      });
      workflowRun = dispatched.workflowRun;
      workflowRuns.set(workflowRun.id, workflowRun);
      eventLog.emit('workflow.run.started', {
        projectId: proposal.projectId,
        workflowRunId: workflowRun.id,
        workflowId: workflowRun.workflowId,
        requestedBy: approvedBy,
        workflowProposalId,
      });
      emitWorkflowDispatchEvents(proposal.projectId, dispatched.dispatches);
      return { ok: true, workflowRun, workflowProposal: approvedProposal, dispatches: dispatched.dispatches };
    }

    if (proposal.workflowId === PO_GENERATED_PROJECT_WORKFLOW_ID) {
      const workerAgent = (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';
      let workflowRun = createPoGeneratedProjectWorkflowRun({
        project,
        tasks: board.getAllTasks(),
        workerAgent,
        reviewerAgent: project.poAgent || 'xiaok-po',
        requestedBy: approvedBy,
        now,
      });
      workflowRun = applyProposalMetadataToRun(workflowRun, approvedProposal, { now });
      const dispatched = dispatchWorkflowNode(workflowRun, PROJECT_WORKFLOW_DELIVERABLE_NODE_ID, {
        assignedAgent: workerAgent,
        now,
      });
      workflowRun = dispatched.workflowRun;
      workflowRuns.set(workflowRun.id, workflowRun);
      eventLog.emit('workflow.run.started', {
        projectId: proposal.projectId,
        workflowRunId: workflowRun.id,
        workflowId: workflowRun.workflowId,
        requestedBy: approvedBy,
        workflowProposalId,
      });
      emitWorkflowDispatchEvents(proposal.projectId, dispatched.dispatches);
      return { ok: true, workflowRun, workflowProposal: approvedProposal, dispatches: dispatched.dispatches };
    }

    if (proposal.workflowId === PO_GENERATED_TASK_WORKFLOW_ID) {
      if (!sourceTask.task) return { ok: false, error: 'workflow_task_required' };
      const workerAgent = sourceTask.task.assignedAgent || (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';
      let workflowRun = createPoGeneratedTaskWorkflowRun({
        project,
        task: sourceTask.task,
        tasks: board.getAllTasks(),
        workerAgent,
        reviewerAgent: project.poAgent || 'xiaok-po',
        requestedBy: approvedBy,
        now,
      });
      workflowRun = applyProposalMetadataToRun(workflowRun, approvedProposal, { now });
      const dispatched = dispatchWorkflowNode(workflowRun, TASK_WORKFLOW_DELIVERABLE_NODE_ID, {
        assignedAgent: workerAgent,
        now,
      });
      workflowRun = dispatched.workflowRun;
      workflowRuns.set(workflowRun.id, workflowRun);
      eventLog.emit('workflow.run.started', {
        projectId: proposal.projectId,
        taskId: sourceTask.task.id,
        workflowRunId: workflowRun.id,
        workflowId: workflowRun.workflowId,
        requestedBy: approvedBy,
        workflowProposalId,
      });
      emitWorkflowDispatchEvents(proposal.projectId, dispatched.dispatches);
      return { ok: true, workflowRun, workflowProposal: approvedProposal, dispatches: dispatched.dispatches };
    }

    return { ok: false, error: 'workflow_template_not_found' };
  }

  function startScriptWorkflowRunFromProposal(workflowProposalId, {
    approvedBy = 'human',
    now = Date.now(),
    projectId = null,
  } = {}) {
    const proposal = workflowProposals.get(workflowProposalId);
    if (!proposal) return { ok: false, error: 'workflow_proposal_not_found' };
    if (proposal.source !== 'script_generated') return { ok: false, error: 'workflow_proposal_not_script_generated' };
    if (proposal.approval?.status !== 'pending') return { ok: false, error: 'workflow_proposal_not_pending' };
    if (projectId && proposal.projectId !== projectId) return { ok: false, error: 'workflow_proposal_project_mismatch' };
    const project = projects.get(proposal.projectId);
    const board = boards.get(proposal.projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };

    const approvedProposal = {
      ...proposal,
      status: 'approved',
      updatedAt: now,
      approval: {
        ...proposal.approval,
        status: 'approved',
        approvedBy,
        decidedAt: now,
      },
    };
    workflowProposals.set(approvedProposal.id, approvedProposal);

    let workflowRun = createWorkflowRun({
      id: `wf-${proposal.projectId}-${proposal.workflowId}-${now}`,
      projectId: proposal.projectId,
      workflowId: proposal.workflowId,
      title: proposal.title,
      source: 'script_generated',
      requestedBy: approvedBy,
      scope: proposal.scope,
      approval: { required: false },
      phases: [
        { id: 'script-runtime', title: '动态工作流编排' },
        ...proposal.phases.map(phase => ({ id: phase.id, title: phase.title })),
      ],
      nodes: [{
        id: 'script-runtime',
        phaseId: 'script-runtime',
        title: '动态工作流编排',
        kind: 'script_runtime',
        assignedAgent: 'desktop-workflow-runtime',
        input: {
          workflowId: proposal.workflowId,
          scriptHash: proposal.scriptHash,
          preview: proposal.scriptPreview,
        },
      }],
      now,
    });
    workflowRun = {
      ...workflowRun,
      workflowProposalId: approvedProposal.id,
      scriptHash: approvedProposal.scriptHash,
      scriptSource: approvedProposal.scriptSource ?? null,
      scriptPreview: approvedProposal.scriptPreview,
      scriptMeta: approvedProposal.scriptMeta,
      scriptAnalysis: approvedProposal.scriptAnalysis,
    };
    const runtimeDispatch = dispatchWorkflowNode(workflowRun, 'script-runtime', {
      assignedAgent: 'desktop-workflow-runtime',
      now,
    });
    workflowRun = runtimeDispatch.workflowRun;
    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.run.started', {
      projectId: proposal.projectId,
      workflowRunId: workflowRun.id,
      workflowId: workflowRun.workflowId,
      workflowProposalId,
      source: 'script_generated',
      requestedBy: approvedBy,
    });
    return { ok: true, workflowRun, workflowProposal: approvedProposal, dispatches: [] };
  }

  function beginWorkflowScriptParallelGroup(workflowRunId, {
    phaseTitle,
    label,
    primitiveId = null,
    kind = 'parallel',
    totalCount = 0,
    limit = 1,
    failurePolicy = 'required_all',
    quorum = null,
    now = Date.now(),
  } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (workflowRun.source !== 'script_generated') return { ok: false, error: 'workflow_run_not_script_generated' };
    if (['completed', 'failed', 'cancelled'].includes(workflowRun.status)) return { ok: false, error: 'workflow_run_terminal' };
    if (!readWorkflowString(phaseTitle)) return { ok: false, error: 'workflow_script_phase_required' };

    const normalizedKind = ['parallel', 'pipeline'].includes(kind) ? kind : 'parallel';
    const normalizedFailurePolicy = ['required_all', 'collect_errors', 'fail_fast', 'quorum'].includes(failurePolicy)
      ? failurePolicy
      : 'required_all';
    const phaseState = ensureScriptWorkflowPhase(workflowRun, phaseTitle);
    const phase = phaseState.phase;
    const groupId = allocateScriptParallelGroupId(workflowRun);
    const parallelGroup = {
      id: groupId,
      workflowRunId,
      phaseId: phase.id,
      primitiveId: readWorkflowString(primitiveId) || groupId,
      kind: normalizedKind,
      label: readWorkflowString(label) || (normalizedKind === 'pipeline' ? '动态管线' : '并行分组'),
      status: 'running',
      limit: Math.max(1, Number(limit || 1)),
      totalCount: Math.max(0, Number(totalCount || 0)),
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      requiredFailedCount: 0,
      failurePolicy: normalizedFailurePolicy,
      quorum: Number.isFinite(Number(quorum)) ? Number(quorum) : null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const nextRun = {
      ...workflowRun,
      updatedAt: now,
      phases: phaseState.phases,
      parallelGroups: [...(workflowRun.parallelGroups || []), parallelGroup],
      scriptCheckpoints: [
        ...(workflowRun.scriptCheckpoints || []),
        createScriptCheckpoint(workflowRun, {
          primitiveType: normalizedKind,
          primitiveId: parallelGroup.primitiveId,
          phaseId: phase.id,
          parallelGroupId: groupId,
          status: 'waiting',
          input: {
            label: parallelGroup.label,
            totalCount: parallelGroup.totalCount,
            limit: parallelGroup.limit,
            failurePolicy: parallelGroup.failurePolicy,
          },
          now,
        }),
      ],
      scriptState: {
        ...(workflowRun.scriptState || {}),
        parallelGroupCount: Number(workflowRun.scriptState?.parallelGroupCount || 0) + 1,
        lastParallelGroupCreatedAt: now,
      },
    };
    const refreshed = refreshWorkflowRunState(nextRun);
    workflowRuns.set(refreshed.id, refreshed);
    eventLog.emit('workflow.script.parallel_group.created', {
      projectId: refreshed.projectId,
      workflowRunId,
      workflowId: refreshed.workflowId,
      parallelGroupId: groupId,
      phaseId: phase.id,
      kind: normalizedKind,
      failurePolicy: normalizedFailurePolicy,
    });
    return {
      ok: true,
      workflowRun: refreshed,
      parallelGroup: refreshed.parallelGroups.find(group => group.id === groupId) || parallelGroup,
    };
  }

  function dispatchWorkflowScriptAgentNode(workflowRunId, {
    phaseTitle,
    label,
    prompt,
    assignedAgent = null,
    options = null,
    permissions = null,
    parallelGroupId = null,
    fanoutItemKey = null,
    fanoutItemLabel = null,
    pipelineStageIndex = null,
    required = true,
    outputSchema = null,
    evidenceRequired = false,
    dependsOn = [],
    now = Date.now(),
  } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (workflowRun.source !== 'script_generated') return { ok: false, error: 'workflow_run_not_script_generated' };
    if (['completed', 'failed', 'cancelled'].includes(workflowRun.status)) return { ok: false, error: 'workflow_run_terminal' };
    if (!readWorkflowString(phaseTitle)) return { ok: false, error: 'workflow_script_phase_required' };
    if (!readWorkflowString(prompt)) return { ok: false, error: 'workflow_script_prompt_required' };
    const normalizedParallelGroupId = readWorkflowString(parallelGroupId);
    if (normalizedParallelGroupId && !(workflowRun.parallelGroups || []).some(group => group.id === normalizedParallelGroupId)) {
      return { ok: false, error: 'workflow_parallel_group_not_found', parallelGroupId: normalizedParallelGroupId };
    }
    const permissionResult = validateNodePermissions(permissions);
    if (!permissionResult.ok) return permissionResult;

    const project = projects.get(workflowRun.projectId);
    const workerAgent = assignedAgent || (Array.isArray(project?.members) && project.members[0]) || 'xiaok-worker';
    const phaseState = ensureScriptWorkflowPhase(workflowRun, phaseTitle);
    const phase = phaseState.phase;
    const nodeId = allocateScriptAgentNodeId(workflowRun);
    const title = readWorkflowString(label) || `动态任务 ${nodeId.replace(/^script-agent-/, '')}`;
    const resolvedDepsOn = Array.isArray(dependsOn) ? dependsOn : [];
    const allDepsCompleted = resolvedDepsOn.length > 0
      ? resolvedDepsOn.every(depId => {
          const dep = workflowRun.nodes.find(n => n.id === depId);
          return dep && dep.status === 'completed';
        })
      : true;
    const node = {
      id: nodeId,
      phaseId: phase.id,
      title,
      status: resolvedDepsOn.length === 0 || allDepsCompleted ? 'ready' : 'pending',
      kind: 'agent_task',
      dependsOn: resolvedDepsOn,
      assignedAgent: workerAgent,
      attempt: 0,
      input: {
        prompt: readWorkflowString(prompt),
        label: title,
        options: options && typeof options === 'object' && !Array.isArray(options) ? JSON.parse(JSON.stringify(options)) : null,
        permissions: permissionResult.permissions,
        script: {
          workflowId: workflowRun.workflowId,
          workflowRunId,
          scriptHash: workflowRun.scriptHash || null,
          phaseId: phase.id,
          phaseTitle: phase.title,
          nodeId,
        },
      },
      output: null,
      reviewDecision: null,
      runtime: null,
      cache: null,
      producerAgent: null,
      error: null,
      startedAt: null,
      completedAt: null,
      parallelGroupId: normalizedParallelGroupId || null,
      fanoutItemKey: readWorkflowString(fanoutItemKey),
      fanoutItemLabel: readWorkflowString(fanoutItemLabel),
      pipelineStageIndex: Number.isFinite(Number(pipelineStageIndex)) ? Number(pipelineStageIndex) : null,
      required: required !== false,
      outputSchema: outputSchema && typeof outputSchema === 'object' && !Array.isArray(outputSchema)
        ? JSON.parse(JSON.stringify(outputSchema))
        : null,
      evidenceRequired: evidenceRequired === true,
    };

    const withNode = {
      ...workflowRun,
      updatedAt: now,
      phases: phaseState.phases.map(item => item.id === phase.id
        ? { ...item, nodeIds: [...new Set([...(item.nodeIds || []), nodeId])] }
        : item),
      nodes: [...workflowRun.nodes, node],
      scriptCheckpoints: [
        ...(workflowRun.scriptCheckpoints || []),
        createScriptCheckpoint(workflowRun, {
          primitiveType: 'agent',
          primitiveId: nodeId,
          phaseId: phase.id,
          parallelGroupId: normalizedParallelGroupId || null,
          status: 'waiting',
          input: node.input,
          outputRefs: [nodeId],
          now,
        }),
      ],
      scriptState: {
        ...(workflowRun.scriptState || {}),
        dynamicNodeCount: Number(workflowRun.scriptState?.dynamicNodeCount || 0) + 1,
        lastNodeCreatedAt: now,
      },
    };
    // Only dispatch immediately if node is ready (no pending dependencies)
    if (node.status === 'ready') {
      const dispatched = dispatchWorkflowNode(withNode, nodeId, {
        assignedAgent: workerAgent,
        input: node.input,
        now,
      });
      workflowRuns.set(dispatched.workflowRun.id, dispatched.workflowRun);
      eventLog.emit('workflow.script.node.created', {
        projectId: dispatched.workflowRun.projectId,
        workflowRunId,
        workflowId: dispatched.workflowRun.workflowId,
        nodeId,
        phaseId: phase.id,
        phaseTitle: phase.title,
        assignedAgent: workerAgent,
      });
      emitWorkflowDispatchEvents(dispatched.workflowRun.projectId, dispatched.dispatches);
      return { ok: true, workflowRun: dispatched.workflowRun, nodeId, dispatches: dispatched.dispatches };
    }
    // Node is pending (has unmet dependsOn) — persist but don't dispatch yet
    workflowRuns.set(withNode.id, withNode);
    eventLog.emit('workflow.script.node.created', {
      projectId: withNode.projectId,
      workflowRunId,
      workflowId: withNode.workflowId,
      nodeId,
      phaseId: phase.id,
      phaseTitle: phase.title,
      assignedAgent: workerAgent,
    });
    return { ok: true, workflowRun: withNode, nodeId, dispatches: [] };
  }

  function retryWorkflowScriptAgentNode(workflowRunId, { nodeId, assignedAgent = null, now = Date.now() } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (workflowRun.source !== 'script_generated') return { ok: false, error: 'workflow_run_not_script_generated' };
    if (['completed', 'failed', 'cancelled'].includes(workflowRun.status)) return { ok: false, error: 'workflow_run_terminal' };
    const node = workflowRun.nodes.find(item => item.id === nodeId);
    if (!node) return { ok: false, error: 'workflow_node_not_found' };
    if (node.kind !== 'agent_task') return { ok: false, error: 'workflow_node_not_agent_task' };
    if (!['blocked', 'failed'].includes(node.status)) return { ok: false, error: 'workflow_node_not_retryable' };

    const resetRun = refreshWorkflowRunState({
      ...workflowRun,
      status: 'running',
      completedAt: null,
      updatedAt: now,
      nodes: workflowRun.nodes.map(item => item.id === nodeId
        ? {
            ...item,
            status: 'ready',
            error: null,
            output: null,
            reviewDecision: null,
            runtime: null,
            cache: null,
            producerAgent: null,
            completedAt: null,
          }
        : item),
    });
    const retryAgent = assignedAgent || node.assignedAgent || null;
    const dispatched = dispatchWorkflowNode(resetRun, nodeId, {
      assignedAgent: retryAgent,
      input: node.input,
      now,
    });
    workflowRuns.set(dispatched.workflowRun.id, dispatched.workflowRun);
    eventLog.emit('workflow.script.node.retry_dispatched', {
      projectId: dispatched.workflowRun.projectId,
      workflowRunId,
      workflowId: dispatched.workflowRun.workflowId,
      nodeId,
      assignedAgent: retryAgent,
      attempt: dispatched.dispatches[0]?.attempt || null,
    });
    emitWorkflowDispatchEvents(dispatched.workflowRun.projectId, dispatched.dispatches);
    return { ok: true, workflowRun: dispatched.workflowRun, nodeId, dispatches: dispatched.dispatches };
  }

  function completeScriptWorkflowRun(workflowRunId, { result = null, terminal = null, now = Date.now() } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (workflowRun.source !== 'script_generated') return { ok: false, error: 'workflow_run_not_script_generated' };
    if (['completed', 'failed', 'cancelled'].includes(workflowRun.status)) return { ok: false, error: 'workflow_run_terminal' };

    const incomplete = workflowRun.nodes.filter(node => node.kind === 'agent_task' && node.status !== 'completed');
    if (incomplete.length > 0) {
      return {
        ok: false,
        error: 'workflow_script_nodes_incomplete',
        incompleteNodes: incomplete.map(node => ({ id: node.id, status: node.status, title: node.title })),
      };
    }
    const runtimeNode = workflowRun.nodes.find(node => node.id === 'script-runtime');
    if (!runtimeNode) return { ok: false, error: 'workflow_script_runtime_node_missing' };

    const workflowResult = result && typeof result === 'object' && !Array.isArray(result)
      ? sanitizeWorkflowNodeOutput(result)
      : sanitizeWorkflowNodeOutput({ value: result });
    const completed = applyWorkflowEvent(workflowRun, {
      type: 'node_completed',
      nodeId: runtimeNode.id,
      output: {
        ...workflowResult,
        producedAt: now,
        producerAgent: 'desktop-workflow-runtime',
      },
      fromAgent: 'desktop-workflow-runtime',
    }, { now });
    let withResult = {
      ...completed,
      scriptResult: JSON.parse(JSON.stringify(result ?? null)),
      scriptState: {
        ...(completed.scriptState || {}),
        completedAt: now,
      },
    };
    const terminalDecision = normalizeWorkflowScriptTerminalDecision(terminal);
    if (terminalDecision && terminalDecision.status !== 'passed') {
      withResult = {
        ...withResult,
        status: 'blocked',
        completedAt: null,
        gateDecision: terminalDecision,
        summary: {
          ...(withResult.summary || {}),
          primaryMessage: terminalDecision.reason || 'Workflow blocked',
          blockingFailures: [
            ...((withResult.summary?.blockingFailures || [])),
            {
              nodeId: runtimeNode.id,
              title: runtimeNode.title,
              status: 'blocked',
              reason: terminalDecision.reason || terminalDecision.status,
            },
          ],
        },
      };
      workflowRuns.set(withResult.id, withResult);
      eventLog.emit('workflow.run.blocked', {
        projectId: withResult.projectId,
        workflowRunId,
        workflowId: withResult.workflowId,
        status: terminalDecision.status,
        source: 'script_generated',
      });
      return { ok: true, workflowRun: withResult, dispatches: [], projectDelivery: null };
    }
    withResult = {
      ...withResult,
      gateDecision: terminalDecision || withResult.gateDecision || {
        status: 'passed',
        reason: 'Dynamic workflow script completed',
        evidenceRefs: readWorkflowStringArray(workflowResult.evidenceRefs),
      },
    };
    const { projectDelivery: _staleProjectDelivery, ...workflowRunWithoutStaleDelivery } = withResult;
    withResult = refreshWorkflowRunState({
      ...workflowRunWithoutStaleDelivery,
      status: 'completed',
      completedAt: now,
    });
    const projectFinalization = maybeDeliverScriptWorkflowProjectResult(withResult, { now });
    withResult = projectFinalization.workflowRun;
    workflowRuns.set(withResult.id, withResult);
    eventLog.emit('workflow.run.completed', {
      projectId: withResult.projectId,
      workflowRunId,
      workflowId: withResult.workflowId,
      status: withResult.status,
      source: 'script_generated',
      projectDeliveryStatus: projectFinalization.delivery?.ok ? 'delivered' : (projectFinalization.delivery?.error || null),
    });
    return { ok: true, workflowRun: withResult, dispatches: [], projectDelivery: projectFinalization.delivery };
  }

  function startProjectDiagnoseWorkflow(projectId, { requestedBy = 'human', now = Date.now() } = {}) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };

    const dispatchPlan = buildDispatchPlan(projectId);
    const workflowRun = createProjectDiagnoseWorkflowRun({
      project,
      tasks: board.getAllTasks(),
      projectHealth: deriveProjectHealth({
        project,
        tasks: board.getAllTasks(),
        dispatchPlan,
      }),
      dispatchPlan,
      requestedBy,
      now,
    });
    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.run.completed', {
      projectId,
      workflowRunId: workflowRun.id,
      workflowId: workflowRun.workflowId,
      status: workflowRun.status,
      requestedBy,
      recommendedAction: workflowRun.diagnosis?.recommendedActions?.[0]?.id || null,
    });
    return { ok: true, workflowRun };
  }
  function startAgentReviewSmokeWorkflow(projectId, { requestedBy = 'human', now = Date.now() } = {}) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };

    const workerAgent = (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';
    const reviewerAgent = project.poAgent || 'xiaok-po';
    let workflowRun = createAgentReviewSmokeWorkflowRun({
      project,
      tasks: board.getAllTasks(),
      workerAgent,
      reviewerAgent,
      requestedBy,
      now,
    });

    const dispatched = dispatchWorkflowNode(workflowRun, 'worker-diagnose-project', {
      assignedAgent: workerAgent,
      now,
    });
    workflowRun = dispatched.workflowRun;
    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.run.started', {
      projectId,
      workflowRunId: workflowRun.id,
      workflowId: workflowRun.workflowId,
      requestedBy,
    });
    emitWorkflowDispatchEvents(projectId, dispatched.dispatches);
    return { ok: true, workflowRun, dispatches: dispatched.dispatches };
  }
  function handleWorkflowNodeResult({ workflowRunId, nodeId, attempt, handoffId, fromAgent, output, now = Date.now() } = {}) {
    const checked = validateWorkflowNodeHandoff({ workflowRunId, nodeId, attempt, handoffId });
    if (!checked.ok) return checked;
    const sanitizedOutput = sanitizeWorkflowNodeOutput(output && typeof output === 'object' ? output : { value: output });

    let workflowRun = applyWorkflowEvent(checked.workflowRun, {
      type: 'node_completed',
      nodeId,
      output: {
        ...sanitizedOutput,
        producerAgent: fromAgent || checked.node.assignedAgent || null,
        producedAt: now,
      },
      fromAgent,
    }, { now });

    const reviewer = workflowRun.nodes.find(node => node.id === 'reviewer-adversarial-check');
    let dispatches = [];
    if (reviewer?.status === 'ready') {
      const dependencyOutput = getFirstDependencyOutput(workflowRun, reviewer);
      const dispatched = dispatchWorkflowNode(workflowRun, reviewer.id, {
        assignedAgent: reviewer.assignedAgent || 'xiaok-po',
        input: {
          workerOutput: dependencyOutput,
        },
        now,
      });
      workflowRun = dispatched.workflowRun;
      dispatches = dispatched.dispatches;
    }

    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.node.output_received', {
      projectId: workflowRun.projectId,
      workflowRunId,
      nodeId,
      fromAgent: fromAgent || null,
    });
    emitWorkflowDispatchEvents(workflowRun.projectId, dispatches);
    return { ok: true, workflowRun, dispatches };
  }
  function handleWorkflowNodeReview({ workflowRunId, nodeId, attempt, handoffId, fromAgent, reviewDecision, output = null, now = Date.now() } = {}) {
    const checked = validateWorkflowNodeHandoff({ workflowRunId, nodeId, attempt, handoffId });
    if (!checked.ok) return checked;
    const reviewerIdentity = readWorkflowString(fromAgent);
    if (!reviewerIdentity || reviewerIdentity !== readWorkflowString(checked.node.assignedAgent)) {
      return { ok: false, error: 'workflow_reviewer_identity_mismatch' };
    }

    const decisionValidation = validateWorkflowReviewDecision(reviewDecision);
    if (!decisionValidation.ok) {
      let blocked = applyWorkflowEvent(checked.workflowRun, {
        type: 'node_blocked',
        nodeId,
        reason: 'malformed_review_decision',
      }, { now });
      blocked = {
        ...blocked,
        gateDecision: {
          status: 'blocked',
          reason: decisionValidation.error,
          evidenceRefs: [],
        },
      };
      blocked.summary = { ...blocked.summary, primaryMessage: 'Review gate blocked' };
      workflowRuns.set(blocked.id, blocked);
      eventLog.emit('workflow.node.reviewed', {
        projectId: blocked.projectId,
        workflowRunId,
        nodeId,
        fromAgent: fromAgent || null,
        decision: 'blocked',
        error: decisionValidation.error,
      });
      return { ok: true, workflowRun: blocked, dispatches: [] };
    }
    const sanitizedDecision = decisionValidation.decision;
    const sanitizedOutput = sanitizeWorkflowNodeOutput(output);
    const preparedConditions = prepareReviewConditions({
      projectId: checked.workflowRun.projectId,
      sourceTaskId: checked.workflowRun.scope?.taskId || nodeId,
      sourceReviewRunId: checked.workflowRun.id,
      originatingReviewerIdentity: reviewerIdentity,
      findings: sanitizedOutput?.reviewEvidence?.findings,
    });
    if (!preparedConditions.ok) return preparedConditions;

    let workflowRun = applyWorkflowEvent(checked.workflowRun, {
      type: 'node_reviewed',
      nodeId,
      reviewDecision: sanitizedDecision,
      output: sanitizedOutput,
      fromAgent,
    }, { now });
    workflowRun = applyWorkflowEvent(workflowRun, {
      type: 'gate_completed',
      nodeId: 'reduce-review-gate',
      decision: sanitizedDecision,
    }, { now });
    commitReviewConditions(preparedConditions.conditions);
    const taskFinalization = maybeSubmitTaskWorkflowDeliverable(workflowRun, { now });
    workflowRun = taskFinalization.workflowRun;
    const projectFinalization = maybeDeliverProjectWorkflowDeliverable(workflowRun, { now });
    workflowRun = projectFinalization.workflowRun;
    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.run.gate_completed', {
      projectId: workflowRun.projectId,
      workflowRunId,
      status: workflowRun.status,
      decision: sanitizedDecision.status,
      taskSubmissionStatus: taskFinalization.submission?.ok ? 'submitted' : (taskFinalization.submission?.error || null),
      projectDeliveryStatus: projectFinalization.delivery?.ok ? 'delivered' : (projectFinalization.delivery?.error || null),
    });
    return { ok: true, workflowRun, dispatches: [] };
  }
  function handleWorkflowRuntimeUnavailable({ workflowRunId, nodeId, attempt, handoffId, reason = 'runtime_unavailable', now = Date.now() } = {}) {
    const checked = validateWorkflowNodeHandoff({ workflowRunId, nodeId, attempt, handoffId, allowRunningOnly: false });
    if (!checked.ok) return checked;
    const workflowRun = applyWorkflowEvent(checked.workflowRun, {
      type: 'node_blocked',
      nodeId,
      reason,
    }, { now });
    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.node.blocked', {
      projectId: workflowRun.projectId,
      workflowRunId,
      nodeId,
      reason,
    });
    return { ok: true, workflowRun, dispatches: [] };
  }
  function cancelWorkflowRun(workflowRunId, { reason = 'human_cancelled', now = Date.now() } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    const cancelled = applyWorkflowEvent(workflowRun, { type: 'cancelled', reason }, { now });
    workflowRuns.set(cancelled.id, cancelled);
    const taskReset = maybeReleaseCancelledTaskWorkflow(cancelled, { reason, now });
    eventLog.emit('workflow.run.cancelled', {
      projectId: cancelled.projectId,
      workflowRunId,
      reason,
      taskResetStatus: taskReset?.ok ? 'pending' : (taskReset?.error || null),
    });
    return { ok: true, workflowRun: cancelled, taskReset };
  }

  function isScriptWorkflowRunResumable(workflowRun) {
    if (!workflowRun || workflowRun.source !== 'script_generated') return false;
    if (workflowRun.status === 'running') return true;
    if (workflowRun.status !== 'blocked') return false;
    return workflowRun.recovery?.nextAction === 'resume_workflow';
  }

  function listResumableScriptWorkflowRuns(projectId = null) {
    return [...workflowRuns.values()]
      .filter(run => isScriptWorkflowRunResumable(run))
      .filter(run => (projectId ? run.projectId === projectId : true))
      .filter(run => typeof run.scriptSource === 'string' && run.scriptSource.length > 0)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(run => ({
        projectId: run.projectId,
        workflowRunId: run.id,
        workflowId: run.workflowId,
        scriptHash: run.scriptHash || null,
        status: run.status,
        scriptSource: run.scriptSource,
        createdAt: run.createdAt || 0,
      }));
  }

  function deriveScriptWorkflowIntervention(projectId) {
    const resumable = listResumableScriptWorkflowRuns(projectId);
    const candidate = resumable[0];
    if (!candidate) return null;
    return {
      required: true,
      severity: 'action_required',
      kind: 'script_workflow',
      projectId,
      workflowRunId: candidate.workflowRunId,
      workflowId: candidate.workflowId,
      scriptHash: candidate.scriptHash,
      primaryAction: {
        id: 'resume_dynamic_workflow',
        strategy: 'resume_workflow',
        toolName: 'run_dynamic_workflow_script',
        params: { projectId, resumeWorkflowRunId: candidate.workflowRunId },
      },
    };
  }

  function recoverInterruptedTaskWorkflows({ reason = 'workflow_runtime_interrupted', now = Date.now() } = {}) {
    const recovered = [];
    const skipped = [];
    const resumableScriptRuns = [];
    for (const workflowRun of workflowRuns.values()) {
      if (!workflowRun) continue;
      // Dynamic (script_generated) runs have no task lease; never cancel them.
      // Collect resumable ones so the desktop runtime can rebuild their jobs.
      if (workflowRun.source === 'script_generated') {
        if (isScriptWorkflowRunResumable(workflowRun)) {
          resumableScriptRuns.push({
            projectId: workflowRun.projectId,
            workflowRunId: workflowRun.id,
            workflowId: workflowRun.workflowId,
            scriptHash: workflowRun.scriptHash || null,
            status: workflowRun.status,
            hasScriptSource: typeof workflowRun.scriptSource === 'string' && workflowRun.scriptSource.length > 0,
          });
        }
        continue;
      }
      if (workflowRun.workflowId !== PO_GENERATED_TASK_WORKFLOW_ID) continue;
      if (workflowRun.status !== 'running') continue;
      const cancelled = applyWorkflowEvent(workflowRun, { type: 'cancelled', reason }, { now });
      const taskReset = maybeReleaseCancelledTaskWorkflow(cancelled, { reason, now });
      workflowRuns.set(cancelled.id, cancelled);
      if (taskReset?.ok) {
        recovered.push({
          projectId: cancelled.projectId,
          workflowRunId: cancelled.id,
          taskId: cancelled.scope?.taskId || null,
          taskResetStatus: 'pending',
        });
        eventLog.emit('workflow.run.cancelled', {
          projectId: cancelled.projectId,
          workflowRunId: cancelled.id,
          reason,
          taskResetStatus: 'pending',
        });
      } else {
        skipped.push({
          projectId: cancelled.projectId,
          workflowRunId: cancelled.id,
          taskId: cancelled.scope?.taskId || null,
          reason: taskReset?.error || 'task_reset_not_needed',
        });
      }
    }
    return { ok: true, recovered, skipped, resumableScriptRuns };
  }

  function maybeReleaseCancelledTaskWorkflow(workflowRun, { reason = 'workflow_cancelled' } = {}) {
    if (!workflowRun || workflowRun.workflowId !== PO_GENERATED_TASK_WORKFLOW_ID) return null;
    const taskId = workflowRun.scope?.taskId;
    if (!taskId) return null;
    const board = boards.get(workflowRun.projectId);
    if (!board) return { ok: false, error: 'task_board_not_found' };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'source_task_not_found' };
    const expectedRunId = `workflow-${workflowRun.id}`;
    if (task.activeRunId !== expectedRunId) {
      return { ok: false, error: 'source_task_run_mismatch', activeRunId: task.activeRunId || null, expectedRunId };
    }
    if (!['dispatched', 'accepted', 'in_progress'].includes(task.status)) {
      return { ok: false, error: `source_task_not_active:${task.status}` };
    }
    return board.transition(task.id, 'pending', {
      failureReason: reason,
      assignedExecutor: null,
    });
  }

  function handleWorkflowProgressBatch(workflowRunId, batch, { now = Date.now() } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (!batch || typeof batch !== 'object') return { ok: false, error: 'workflow_progress_batch_required' };
    if (batch.workflowRunId !== workflowRunId) return { ok: false, error: 'workflow_progress_run_mismatch' };
    if (batch.projectId !== workflowRun.projectId) return { ok: false, error: 'workflow_progress_project_mismatch' };

    const applied = applyWorkflowProgressBatch({
      workflowRunId: workflowRun.id,
      nodes: workflowRun.nodes,
      progressState: workflowRun.progressState || null,
    }, batch);
    if (!applied.ok) return applied;
    if (applied.duplicate) return { ok: true, duplicate: true, workflowRun };

    const updated = {
      ...workflowRun,
      nodes: applied.snapshot.nodes,
      progressState: applied.snapshot.progressState,
      updatedAt: now,
    };
    workflowRuns.set(updated.id, updated);
    eventLog.emit('workflow.progress.batch', {
      projectId: updated.projectId,
      workflowRunId: updated.id,
      fromParticipantId: batch.fromParticipantId,
      sequence: batch.sequence,
      eventCount: Array.isArray(batch.events) ? batch.events.length : 0,
      lastMaterialProgress: updated.progressState?.lastMaterialProgress || null,
    });
    return { ok: true, workflowRun: updated };
  }

  function listProjectWorkflowRuns(projectId) {
    return [...workflowRuns.values()]
      .filter(run => run.projectId === projectId)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  function findActiveProjectExecutionWorkflow(projectId) {
    return [...workflowRuns.values()]
      .filter(run => (
        run.projectId === projectId &&
        run.workflowId === PO_GENERATED_PROJECT_WORKFLOW_ID &&
        ['awaiting_approval', 'running'].includes(run.status)
      ))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
  }
  function getWorkflowRun(workflowRunId) {
    return workflowRuns.get(workflowRunId) || null;
  }
  function dispatchWorkflowNode(workflowRun, nodeId, { assignedAgent, input = null, now = Date.now() } = {}) {
    const node = workflowRun.nodes.find(item => item.id === nodeId);
    if (!node || !['ready', 'pending'].includes(node.status)) return { workflowRun, dispatches: [] };
    const attempt = (node.attempt || 0) + 1;
    const handoffId = `wfhd-${workflowRun.id}-${nodeId}-${attempt}`;
    const nodeInput = enrichWorkflowNodeInput(workflowRun, input || node.input || null, { nodeId });
    const next = applyWorkflowEvent(workflowRun, {
      type: 'node_dispatched',
      nodeId,
      assignedAgent: assignedAgent || node.assignedAgent || null,
      attempt,
      handoffId,
      input: nodeInput,
    }, { now });
    const updatedNode = next.nodes.find(item => item.id === nodeId);
    return {
      workflowRun: next,
      dispatches: [{
        workflowRunId: next.id,
        workflowId: next.workflowId,
        projectId: next.projectId,
        nodeId,
        nodeTitle: updatedNode?.title || nodeId,
        nodeKind: updatedNode?.kind || node.kind,
        targetParticipantId: updatedNode?.assignedAgent || assignedAgent || null,
        attempt,
        handoffId,
        input: nodeInput,
      }],
    };
  }
  const INLINE_MAX_CHARS = 2000;
  const MAX_PER_NODE_COMPACT_CHARS = 4000;
  const MAX_TOTAL_UPSTREAM_CHARS = 10000;
  const COMPACT_EXCLUDE_KEYS = new Set(['summary', 'artifacts', 'artifactManifest', 'producerAgent', 'producedAt', 'upstreamOutputs']);
  const MIN_USEFUL_SUMMARY_LENGTH = 10;

  function compactNodeOutput(node) {
    try {
      const output = node?.output;
      if (!output || typeof output !== 'object' || Array.isArray(output)) return null;

      const compact = { nodeId: node.id, nodeTitle: node.title || node.id };

      if (typeof output.summary === 'string' && output.summary.trim().length >= MIN_USEFUL_SUMMARY_LENGTH) {
        compact.summary = output.summary;
      }

      const paths = [];
      if (Array.isArray(output.artifacts)) {
        for (const a of output.artifacts) {
          const p = a?.path || a?.relativePath;
          if (p) paths.push(p);
        }
      }
      if (Array.isArray(output.artifactManifest)) {
        for (const a of output.artifactManifest) {
          const p = a?.path || a?.relativePath;
          if (p) paths.push(p);
        }
      }
      const uniquePaths = [...new Set(paths)];
      if (uniquePaths.length > 0) compact.artifactPaths = uniquePaths;

      let inlineChars = 0;
      for (const [key, val] of Object.entries(output)) {
        if (COMPACT_EXCLUDE_KEYS.has(key)) continue;
        if (inlineChars >= MAX_PER_NODE_COMPACT_CHARS) break;
        try {
          const serialized = JSON.stringify(val);
          if (serialized === undefined) continue;
          if (serialized.length > INLINE_MAX_CHARS) continue;
          if (inlineChars + serialized.length > MAX_PER_NODE_COMPACT_CHARS) break;
          compact[key] = val;
          inlineChars += serialized.length;
        } catch (fieldErr) {
          if (!silent) console.warn(`[hub] compactNodeOutput: skipping field "${key}" on node ${node.id}:`, fieldErr?.message || fieldErr);
          continue;
        }
      }

      if (!compact.summary && !compact.artifactPaths && inlineChars === 0) return null;
      return compact;
    } catch (err) {
      if (!silent) console.warn(`[hub] compactNodeOutput failed for node ${node?.id}:`, err?.message || err);
      return null;
    }
  }

  function enrichWorkflowNodeInput(workflowRun, input = null, { nodeId = null } = {}) {
    const base = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : { value: input };

    let upstreamOutputs = null;
    try {
      if (nodeId) {
        const node = workflowRun.nodes.find(n => n.id === nodeId);
        const deps = node?.dependsOn;
        if (Array.isArray(deps) && deps.length > 0) {
          const sortedDeps = deps.length > 3 ? [...deps].sort() : deps;
          const collected = {};
          let totalChars = 0;
          for (const depId of sortedDeps) {
            const depNode = workflowRun.nodes.find(n => n.id === depId);
            if (!depNode || depNode.status !== 'completed' || !depNode.output) continue;
            const compact = compactNodeOutput(depNode);
            if (!compact) continue;
            try {
              const size = JSON.stringify(compact).length;
              if (totalChars + size > MAX_TOTAL_UPSTREAM_CHARS) {
                collected[depId] = {
                  nodeId: depNode.id,
                  nodeTitle: depNode.title || depNode.id,
                  summary: typeof depNode.output.summary === 'string' ? depNode.output.summary : null,
                  artifactPaths: compact.artifactPaths || null,
                  _truncated: true,
                };
              } else {
                collected[depId] = compact;
                totalChars += size;
              }
            } catch (compactErr) {
              if (!silent) console.warn(`[hub] enrichWorkflowNodeInput: compact size check failed for dep ${depId}:`, compactErr?.message || compactErr);
              collected[depId] = { nodeId: depNode.id, nodeTitle: depNode.title || depNode.id, _truncated: true };
            }
          }
          if (Object.keys(collected).length > 0) upstreamOutputs = collected;
        }
      }
    } catch (err) {
      if (!silent) console.warn('[hub] enrichWorkflowNodeInput: upstream collection failed, skipping:', err?.message || err);
      upstreamOutputs = null;
    }

    return {
      ...base,
      workflowRunId: workflowRun.id,
      workflowRun: {
        id: workflowRun.id,
        workflowId: workflowRun.workflowId,
        projectId: workflowRun.projectId,
        taskId: workflowRun.scope?.taskId || null,
      },
      sourceTask: base.sourceTask || workflowRun.sourceTask || null,
      ...(upstreamOutputs ? { upstreamOutputs } : {}),
    };
  }
  function validateWorkflowNodeHandoff({ workflowRunId, nodeId, attempt, handoffId, allowRunningOnly = true } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (['completed', 'failed', 'cancelled'].includes(workflowRun.status)) return { ok: false, error: 'workflow_run_terminal' };
    const node = workflowRun.nodes.find(item => item.id === nodeId);
    if (!node) return { ok: false, error: 'workflow_node_not_found' };
    if (allowRunningOnly && node.status !== 'running') return { ok: false, error: 'workflow_node_not_running' };
    if (Number(node.attempt || 0) !== Number(attempt || 0)) return { ok: false, error: 'workflow_attempt_mismatch' };
    if ((node.runtime?.handoffId || null) !== (handoffId || null)) return { ok: false, error: 'workflow_handoff_mismatch' };
    return { ok: true, workflowRun, node };
  }
  function validateWorkflowReviewDecision(decision) {
    const result = validateWorkflowGateDecision(decision);
    if (!result.ok) {
      const error = result.error.replace(/^gate_/, 'review_');
      return { ...result, error };
    }
    return { ok: true, decision: sanitizeWorkflowGateDecision(decision) };
  }
  function applyProposalMetadataToRun(workflowRun, proposal, { now = Date.now() } = {}) {
    return {
      ...workflowRun,
      workflowProposalId: proposal.id,
      specHash: proposal.specHash,
      spec: proposal.spec,
      scope: proposal.scope,
      sourceTask: proposal.sourceTask,
      budgets: proposal.budgets,
      budgetGate: proposal.budgetGate,
      permissions: proposal.permissions,
      outputContract: proposal.outputContract,
      acceptanceRubric: proposal.acceptanceRubric,
      assumptions: proposal.assumptions || [],
      approval: {
        required: true,
        status: 'approved',
        budget: proposal.budgets,
        approvedBy: proposal.approval?.approvedBy || null,
        decidedAt: proposal.approval?.decidedAt || now,
      },
      updatedAt: now,
    };
  }
  const MAX_SCRIPT_SOURCE_BYTES = 20_000;
  function validateScriptSource(scriptSource, expectedHash) {
    if (typeof scriptSource !== 'string' || !scriptSource.trim()) {
      return { ok: false, error: 'workflow_script_source_required' };
    }
    let normalized;
    try {
      normalized = normalizeWorkflowScriptSource(scriptSource);
    } catch (error) {
      return { ok: false, error: error?.code || 'workflow_script_source_invalid' };
    }
    const byteLength = Buffer.byteLength(normalized, 'utf8');
    if (byteLength > MAX_SCRIPT_SOURCE_BYTES) {
      return { ok: false, error: 'workflow_script_source_size_exceeded', limit: MAX_SCRIPT_SOURCE_BYTES, actual: byteLength };
    }
    const actualHash = hashWorkflowScriptSource(normalized);
    if (expectedHash && actualHash !== expectedHash) {
      return { ok: false, error: 'workflow_script_source_hash_mismatch', expected: expectedHash, actual: actualHash };
    }
    return { ok: true, scriptSource: normalized, scriptHash: actualHash };
  }
  function validateScriptWorkflowPreview(projectId, preview) {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return { ok: false, error: 'workflow_script_preview_required' };
    if (preview.ok !== true) return { ok: false, error: 'workflow_script_preview_invalid' };
    if (preview.source !== 'script_generated') return { ok: false, error: 'workflow_script_preview_source_invalid' };
    if (preview.strategy !== 'workflow') return { ok: false, error: 'workflow_script_preview_strategy_invalid' };
    if (preview.projectId !== projectId) return { ok: false, error: 'workflow_script_preview_project_mismatch' };
    if (preview.script || preview.body || preview.sourceCode) return { ok: false, error: 'workflow_script_source_not_allowed' };

    const workflowId = readWorkflowString(preview.workflowId);
    if (!workflowId) return { ok: false, error: 'workflow_id_required' };
    const title = readWorkflowString(preview.title || preview.description);
    if (!title) return { ok: false, error: 'title_required' };
    const description = readWorkflowString(preview.description || preview.title);
    if (!description) return { ok: false, error: 'description_required' };
    const scriptHash = readWorkflowString(preview.scriptHash);
    if (!scriptHash) return { ok: false, error: 'workflow_script_hash_required' };

    const phases = Array.isArray(preview.phases) ? preview.phases : [];
    if (phases.length === 0) return { ok: false, error: 'workflow_script_phases_required' };
    const normalizedPhases = [];
    const phaseIds = new Set();
    for (let index = 0; index < phases.length; index += 1) {
      const phase = phases[index];
      const id = readWorkflowString(phase?.id || `phase-${index + 1}`);
      const phaseTitle = readWorkflowString(phase?.title);
      if (!id) return { ok: false, error: 'workflow_script_phase_id_required' };
      if (phaseIds.has(id)) return { ok: false, error: 'workflow_script_duplicate_phase_id', phaseId: id };
      if (!phaseTitle) return { ok: false, error: 'workflow_script_phase_title_required' };
      phaseIds.add(id);
      normalizedPhases.push({
        id,
        title: phaseTitle,
        detail: readWorkflowString(phase?.detail) || null,
      });
    }

    return {
      ok: true,
      preview: {
        ok: true,
        workflowId,
        source: 'script_generated',
        strategy: 'workflow',
        status: preview.status || 'pending_confirmation',
        projectId,
        scope: preview.scope && typeof preview.scope === 'object' && !Array.isArray(preview.scope)
          ? JSON.parse(JSON.stringify(preview.scope))
          : { projectId },
        requestedBy: readWorkflowString(preview.requestedBy) || 'human',
        createdAt: Number(preview.createdAt || Date.now()),
        title,
        description,
        meta: preview.meta && typeof preview.meta === 'object' && !Array.isArray(preview.meta) ? JSON.parse(JSON.stringify(preview.meta)) : null,
        phases: normalizedPhases,
        scriptHash,
        analysis: preview.analysis && typeof preview.analysis === 'object' && !Array.isArray(preview.analysis)
          ? JSON.parse(JSON.stringify(preview.analysis))
          : null,
      },
    };
  }
  function ensureScriptWorkflowPhase(workflowRun, phaseTitle) {
    const normalizedTitle = readWorkflowString(phaseTitle);
    const existing = workflowRun.phases.find(phase => phase.title === normalizedTitle || phase.id === normalizedTitle);
    if (existing) return { phase: existing, phases: workflowRun.phases };
    const idBase = normalizedTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'phase';
    const existingIds = new Set(workflowRun.phases.map(phase => phase.id));
    let index = workflowRun.phases.length + 1;
    let id = `script-${idBase}`;
    while (existingIds.has(id)) {
      index += 1;
      id = `script-${idBase}-${index}`;
    }
    const phase = { id, title: normalizedTitle, status: 'pending', nodeIds: [] };
    return { phase, phases: [...workflowRun.phases, phase] };
  }
  function allocateScriptAgentNodeId(workflowRun) {
    const existing = new Set(workflowRun.nodes.map(node => node.id));
    let index = workflowRun.nodes.filter(node => String(node.id || '').startsWith('script-agent-')).length + 1;
    let nodeId = `script-agent-${index}`;
    while (existing.has(nodeId)) {
      index += 1;
      nodeId = `script-agent-${index}`;
    }
    return nodeId;
  }

  function allocateScriptParallelGroupId(workflowRun) {
    const existing = new Set((workflowRun.parallelGroups || []).map(group => group.id));
    let index = (workflowRun.parallelGroups || []).filter(group => String(group.id || '').startsWith('script-parallel-')).length + 1;
    let groupId = `script-parallel-${index}`;
    while (existing.has(groupId)) {
      index += 1;
      groupId = `script-parallel-${index}`;
    }
    return groupId;
  }

  function allocateScriptCheckpointId(workflowRun) {
    const existing = new Set((workflowRun.scriptCheckpoints || []).map(checkpoint => checkpoint.id));
    let index = (workflowRun.scriptCheckpoints || []).filter(checkpoint => String(checkpoint.id || '').startsWith('script-checkpoint-')).length + 1;
    let checkpointId = `script-checkpoint-${index}`;
    while (existing.has(checkpointId)) {
      index += 1;
      checkpointId = `script-checkpoint-${index}`;
    }
    return checkpointId;
  }

  function createScriptCheckpoint(workflowRun, {
    primitiveType,
    primitiveId,
    phaseId = null,
    parallelGroupId = null,
    status = 'waiting',
    input = null,
    outputRefs = [],
    now = Date.now(),
  } = {}) {
    return {
      id: allocateScriptCheckpointId(workflowRun),
      workflowRunId: workflowRun.id,
      scriptHash: workflowRun.scriptHash || null,
      primitiveType,
      primitiveId: readWorkflowString(primitiveId) || primitiveType,
      phaseId,
      parallelGroupId,
      status,
      inputHash: createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex'),
      outputRefs: Array.isArray(outputRefs) ? outputRefs.map(String).filter(Boolean) : [],
      createdAt: now,
      updatedAt: now,
    };
  }
  function defaultWorkflowPolicyFor(spec) {
    return {
      maxNodes: Math.max(1, flattenSpecNodeCount(spec)),
      maxParallelism: Math.max(1, Number(spec.budgets?.maxParallelism || 1)),
      maxAgents: Math.max(0, Number(spec.budgets?.maxAgents || 0)),
      maxMinutes: Math.max(1, Number(spec.budgets?.maxMinutes || 1)),
      maxTokens: Math.max(0, Number(spec.budgets?.maxTokens || 0)),
    };
  }
  function flattenSpecNodeCount(spec) {
    return (spec.phases || []).reduce((count, phase) => count + (Array.isArray(phase.nodes) ? phase.nodes.length : 0), 0);
  }
  function hashWorkflowSpec(spec) {
    return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  }
  function buildWorkflowBudgetGate(spec, policy) {
    return {
      status: 'passed',
      hardLimits: {
        maxNodes: Number(policy?.maxNodes || flattenSpecNodeCount(spec)),
        maxParallelism: Number(policy?.maxParallelism || spec.budgets?.maxParallelism || 1),
        maxAgents: Number(policy?.maxAgents || spec.budgets?.maxAgents || 0),
        maxMinutes: Number(policy?.maxMinutes || spec.budgets?.maxMinutes || 0),
        maxTokens: Number(policy?.maxTokens || spec.budgets?.maxTokens || 0),
      },
      estimate: {
        riskLevel: inferWorkflowBudgetRisk(spec),
        reason: '估算只用于风险提示；KSwarm 在启动和 dispatch 前执行 hard limits。',
      },
    };
  }
  function inferWorkflowBudgetRisk(spec) {
    const agents = Number(spec.budgets?.maxAgents || 0);
    const tokens = Number(spec.budgets?.maxTokens || 0);
    if (agents >= 8 || tokens >= 50_000) return 'high';
    if (agents >= 2 || tokens >= 10_000) return 'medium';
    return 'low';
  }
  function resolveWorkflowSourceTask(board, taskId) {
    if (!taskId) return { ok: true, task: null };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found', taskId };
    return { ok: true, task };
  }
  function formatWorkflowSourceTask(task = {}) {
    const sourceTask = {
      id: task.id,
      title: task.title || '',
      status: task.status || '',
      assignedAgent: task.assignedAgent || null,
    };
    assignWorkflowField(sourceTask, 'failureReason', readWorkflowString(task.failureReason));
    assignWorkflowField(sourceTask, 'lastFailureClass', readWorkflowString(task.lastFailureClass));
    if (Number(task.qualityFailureCount || 0) > 0) sourceTask.qualityFailureCount = Number(task.qualityFailureCount);
    assignWorkflowField(sourceTask, 'repairInstruction', buildWorkflowRepairInstruction(task));
    if (task.reviewResult?.passed === false) {
      sourceTask.reviewResult = {
        passed: false,
        feedback: task.reviewResult.feedback || '',
        failureClass: task.reviewResult.failureClass || null,
        reviewedAt: task.reviewResult.reviewedAt || null,
      };
    }
    return sourceTask;
  }
  function buildWorkflowRepairInstruction(task = {}) {
    const explicit = readWorkflowString(task.repairInstruction);
    if (explicit) return explicit;
    const failureReason = readWorkflowString(task.failureReason);
    if (failureReason) return failureReason;
    return task.reviewResult?.passed === false ? readWorkflowString(task.reviewResult.feedback) : '';
  }
  function assignWorkflowField(target, key, value) {
    if (value === null || value === undefined || value === '') return;
    target[key] = value;
  }

  function normalizeWorkflowScriptTerminalDecision(terminal) {
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return null;
    const status = readWorkflowString(terminal.status);
    if (!status || status === 'finished' || status === 'passed') return { status: 'passed', reason: readWorkflowString(terminal.reason), evidenceRefs: readWorkflowStringArray(terminal.evidenceRefs) };
    const gateStatus = status === 'blocked' || status === 'needs_replanning' || status === 'needs_rubric_clarification'
      ? status
      : 'blocked';
    return {
      status: gateStatus,
      reason: readWorkflowString(terminal.reason) || gateStatus,
      evidenceRefs: readWorkflowStringArray(terminal.evidenceRefs),
    };
  }

  function getFirstDependencyOutput(workflowRun, node) {
    const dependencyId = Array.isArray(node.dependsOn) ? node.dependsOn[0] : null;
    if (!dependencyId) return null;
    return workflowRun.nodes.find(item => item.id === dependencyId)?.output || null;
  }
  function maybeSubmitTaskWorkflowDeliverable(workflowRun, { now = Date.now() } = {}) {
    if (
      workflowRun.workflowId !== PO_GENERATED_TASK_WORKFLOW_ID ||
      workflowRun.status !== 'completed' ||
      workflowRun.gateDecision?.status !== 'passed' ||
      !workflowRun.scope?.taskId
    ) {
      return { workflowRun, submission: null };
    }

    const board = boards.get(workflowRun.projectId);
    const task = board?.getTask(workflowRun.scope.taskId);
    if (!board || !task) {
      return {
        workflowRun: markWorkflowTaskSubmissionBlocked(workflowRun, 'task_not_found', { now }),
        submission: { ok: false, error: 'task_not_found' },
      };
    }
    if (task.status === 'submitted' || task.status === 'done') {
      return {
        workflowRun: {
          ...workflowRun,
          taskSubmission: {
            status: 'already_submitted',
            taskId: task.id,
            submittedAt: task.updatedAt || now,
            runId: `workflow-${workflowRun.id}`,
          },
        },
        submission: { ok: true, alreadySubmitted: true },
      };
    }

    const producerNode = workflowRun.nodes.find(item => item.id === TASK_WORKFLOW_DELIVERABLE_NODE_ID)
      || workflowRun.nodes.find(item => item.kind === 'agent_task' && item.status === 'completed');
    if (!producerNode?.output) {
      return {
        workflowRun: markWorkflowTaskSubmissionBlocked(workflowRun, 'worker_deliverable_missing', { now }),
        submission: { ok: false, error: 'worker_deliverable_missing' },
      };
    }

    const workerAgent = task.assignedAgent || producerNode.producerAgent || producerNode.assignedAgent || null;
    const runId = `workflow-${workflowRun.id}`;
    const result = buildWorkflowTaskSubmissionResult({ workflowRun, task, producerNode });
    const readyForSubmission = ensureWorkflowTaskSubmissionState(workflowRun.projectId, task, workerAgent, runId);
    if (!readyForSubmission.ok) {
      return {
        workflowRun: markWorkflowTaskSubmissionBlocked(workflowRun, readyForSubmission.error || 'task_submission_state_failed', { now }),
        submission: readyForSubmission,
      };
    }
    const submission = handleSubmitResult(workflowRun.projectId, task.id, result, workerAgent, runId);
    if (!submission.ok) {
      eventLog.emit('task.workflow_submission_failed', {
        projectId: workflowRun.projectId,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        error: submission.error || 'task_submission_failed',
        failureClass: submission.failureClass || null,
      });
      return {
        workflowRun: markWorkflowTaskSubmissionBlocked(workflowRun, submission.error || 'task_submission_failed', { now }),
        submission,
      };
    }

    return {
      workflowRun: {
        ...workflowRun,
        taskSubmission: {
          status: 'submitted',
          taskId: task.id,
          submittedAt: now,
          runId,
        },
      },
      submission,
    };
  }
  function maybeDeliverProjectWorkflowDeliverable(workflowRun, { now = Date.now() } = {}) {
    if (
      workflowRun.workflowId !== PO_GENERATED_PROJECT_WORKFLOW_ID ||
      workflowRun.status !== 'completed' ||
      workflowRun.gateDecision?.status !== 'passed'
    ) {
      return { workflowRun, delivery: null };
    }

    const project = projects.get(workflowRun.projectId);
    const board = boards.get(workflowRun.projectId);
    if (!project || !board) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, 'project_not_found', { now }),
        delivery: { ok: false, error: 'project_not_found' },
      };
    }

    const producerNode = workflowRun.nodes.find(item => item.id === PROJECT_WORKFLOW_DELIVERABLE_NODE_ID)
      || workflowRun.nodes.find(item => item.kind === 'agent_task' && item.status === 'completed');
    if (!producerNode?.output) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, 'worker_deliverable_missing', { now }),
        delivery: { ok: false, error: 'worker_deliverable_missing' },
      };
    }

    const deliverable = buildWorkflowProjectDeliverable({ workflowRun, producerNode });
    if (deliverable.artifacts.length === 0) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, 'worker_deliverable_missing', { now }),
        delivery: { ok: false, error: 'worker_deliverable_missing' },
      };
    }

    const artifactValidation = validateWorkflowProjectArtifacts({ project, board, deliverable });
    if (!artifactValidation.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, artifactValidation.error || 'worker_artifact_invalid', { now, details: artifactValidation }),
        delivery: artifactValidation,
      };
    }

    if (!board.isAllDone()) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, 'tasks_not_all_done', { now }),
        delivery: { ok: false, error: 'tasks_not_all_done' },
      };
    }

    const taskCompletion = markProjectTasksDoneByWorkflow({ project, board, workflowRun, deliverable, producerNode, now });
    if (!taskCompletion.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, taskCompletion.error || 'task_completion_failed', { now }),
        delivery: taskCompletion,
      };
    }

    const delivery = registerWorkflowFinalDeliverableCandidate({
      project,
      workflowRun,
      producerNode,
      deliverable,
      source: 'project_workflow',
      runtimeSource: 'agent_runtime',
      now,
    });
    if (!delivery.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, delivery.error || 'project_delivery_failed', { now }),
        delivery,
      };
    }

    return {
      workflowRun: {
        ...workflowRun,
        projectDelivery: {
          status: 'candidate',
          submittedAt: new Date(now).toISOString(),
          projectId: workflowRun.projectId,
          workflowRunId: workflowRun.id,
          finalDeliverableId: delivery.finalDeliverable.deliverableId,
          taskCount: taskCompletion.completedTaskIds.length,
        },
      },
      delivery,
    };
  }

  function maybeDeliverScriptWorkflowProjectResult(workflowRun, { now = Date.now() } = {}) {
    if (
      workflowRun.source !== 'script_generated' ||
      workflowRun.status !== 'completed' ||
      workflowRun.scope?.taskId
    ) {
      return { workflowRun, delivery: null };
    }

    const project = projects.get(workflowRun.projectId);
    const board = boards.get(workflowRun.projectId);
    if (!project || !board || project.status === 'closed') return { workflowRun, delivery: null };

    if (
      project.status === 'delivered' &&
      project.deliverable?.provenance?.workflowRunId === workflowRun.id
    ) {
      return {
        workflowRun: {
          ...workflowRun,
          projectDelivery: workflowRun.projectDelivery || {
            status: 'delivered',
            deliveredAt: project.deliveredAt || now,
            projectId: workflowRun.projectId,
            workflowRunId: workflowRun.id,
            taskCount: board.getAllTasks().filter(task => task.status === 'done').length,
          },
        },
        delivery: { ok: true, alreadyDelivered: true },
      };
    }

    const producerNode = selectScriptWorkflowProjectDeliverableProducer(workflowRun);
    if (!producerNode?.output) return { workflowRun, delivery: null };

    const deliverable = buildWorkflowProjectDeliverable({
      workflowRun,
      producerNode,
      runtimeSource: 'kswarm-script-workflow',
    });
    if (deliverable.artifacts.length === 0) return { workflowRun, delivery: null };

    const artifactValidation = validateWorkflowProjectArtifacts({ project, board, deliverable });
    if (!artifactValidation.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, artifactValidation.error || 'worker_artifact_invalid', { now, details: artifactValidation }),
        delivery: artifactValidation,
      };
    }

    const taskCompletion = markProjectTasksDoneByWorkflow({
      project,
      board,
      workflowRun,
      deliverable,
      producerNode,
      now,
      runtimeSource: 'kswarm-script-workflow',
      completedBy: 'script_workflow',
      reviewFeedback: '动态 workflow 已完成并生成项目交付物。',
      executionReasonCode: 'script_workflow_completed',
    });
    if (!taskCompletion.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, taskCompletion.error || 'task_completion_failed', { now }),
        delivery: taskCompletion,
      };
    }

    const delivery = registerWorkflowFinalDeliverableCandidate({
      project,
      workflowRun,
      producerNode,
      deliverable,
      source: 'script_workflow',
      runtimeSource: 'desktop-workflow-runtime',
      now,
    });
    if (!delivery.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, delivery.error || 'project_delivery_failed', { now }),
        delivery,
      };
    }

    return {
      workflowRun: {
        ...workflowRun,
        projectDelivery: {
          status: 'candidate',
          submittedAt: new Date(now).toISOString(),
          projectId: workflowRun.projectId,
          workflowRunId: workflowRun.id,
          finalDeliverableId: delivery.finalDeliverable.deliverableId,
          taskCount: taskCompletion.completedTaskIds.length,
        },
      },
      delivery,
    };
  }

  function reconcileRecoveredScriptWorkflowProjectDeliveries({ now = Date.now() } = {}) {
    const delivered = [];
    const blocked = [];
    for (const workflowRun of workflowRuns.values()) {
      const result = maybeDeliverScriptWorkflowProjectResult(workflowRun, { now });
      if (result.workflowRun !== workflowRun) {
        workflowRuns.set(result.workflowRun.id, result.workflowRun);
      }
      if (result.delivery?.ok) {
        delivered.push({ projectId: workflowRun.projectId, workflowRunId: workflowRun.id });
      } else if (result.delivery?.error) {
        blocked.push({ projectId: workflowRun.projectId, workflowRunId: workflowRun.id, error: result.delivery.error });
      }
    }
    return { ok: true, delivered, blocked };
  }

  function selectScriptWorkflowProjectDeliverableProducer(workflowRun) {
    const runtimeNode = workflowRun.nodes.find(item => item.id === 'script-runtime' && item.output);
    if (runtimeNode && collectWorkflowOutputArtifacts(runtimeNode.output).length > 0) return runtimeNode;
    return [...workflowRun.nodes]
      .reverse()
      .find(item => item.kind === 'agent_task' && item.status === 'completed' && item.output && collectWorkflowOutputArtifacts(item.output).length > 0)
      || runtimeNode
      || [...workflowRun.nodes].reverse().find(item => item.kind === 'agent_task' && item.status === 'completed' && item.output);
  }

  function buildWorkflowProjectDeliverable({ workflowRun, producerNode, runtimeSource = 'kswarm-project-workflow' }) {
    const output = producerNode.output && typeof producerNode.output === 'object' ? producerNode.output : {};
    const summary = readWorkflowString(output.summary)
      || readWorkflowString(output.text)
      || '项目级工作流已生成最终交付物。';
    const workFolder = readWorkflowString(output.workFolder) || readWorkflowString(output.workspacePath);
    const artifactManifest = Array.isArray(output.artifactManifest) ? output.artifactManifest : [];
    const artifacts = collectWorkflowOutputArtifacts(output);
    const evidenceRefs = mergeWorkflowArtifactEvidenceRefs(output.evidenceRefs, artifacts);
    return {
      summary,
      artifacts,
      ...(artifactManifest.length > 0 ? { artifactManifest } : {}),
      ...(workFolder ? { workFolder, workspacePath: workFolder } : {}),
      evidenceRefs,
      provenance: {
        runtimeSource,
        workflowRunId: workflowRun.id,
        workflowId: workflowRun.workflowId,
        producerNodeId: producerNode.id,
        producingAgent: producerNode.producerAgent || producerNode.assignedAgent || null,
      },
    };
  }

  function collectWorkflowOutputArtifacts(output = {}) {
    const collected = [];
    const seen = new Set();
    function addArtifact(artifact) {
      const normalized = normalizeWorkflowArtifactRecord(artifact);
      const path = readWorkflowArtifactPath(normalized);
      if (!path || seen.has(path)) return;
      if (isSystemPlanArtifactPath(path)) return;
      seen.add(path);
      collected.push(normalized);
    }

    for (const artifact of Array.isArray(output.artifacts) ? output.artifacts : []) addArtifact(artifact);
    for (const artifact of Array.isArray(output.artifactManifest) ? output.artifactManifest : []) addArtifact(artifact);
    for (const ref of readWorkflowStringArray(output.evidenceRefs)) {
      const artifactPath = extractWorkflowArtifactPathFromText(ref);
      if (artifactPath) addArtifact({ path: artifactPath });
    }
    return collected;
  }

  function normalizeWorkflowArtifactRecord(artifact) {
    if (typeof artifact === 'string') {
      return {
        path: artifact,
        label: basename(artifact.replace(/^artifact:/, '')),
        kind: inferWorkflowArtifactKind(artifact),
      };
    }
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return {};
    const path = readWorkflowArtifactPath(artifact);
    return {
      ...JSON.parse(JSON.stringify(artifact)),
      ...(path && !artifact.path ? { path } : {}),
      label: artifact.label || artifact.title || artifact.filename || artifact.name || (path ? basename(path) : undefined),
      kind: artifact.kind || inferWorkflowArtifactKind(path),
    };
  }

  function extractWorkflowArtifactPathFromText(value) {
    const text = readWorkflowString(value);
    if (!text) return '';
    const normalized = text.replace(/^artifact:/, '');
    const relativeMatch = normalized.match(/(?:^|[\s"'（(])(?:artifact:)?((?:\.\/)?artifacts\/[^\s,，;；:：)）\]】]+)/);
    if (relativeMatch?.[1]) return relativeMatch[1].replace(/^\.\//, '');
    const absoluteMatch = normalized.match(/((?:\/[^\s,，;；:：)）\]】]+)+\/artifacts\/[^\s,，;；:：)）\]】]+)/);
    return absoluteMatch?.[1] || '';
  }

  function isSystemPlanArtifactPath(path) {
    const name = basename(String(path || '').replace(/^artifact:/, ''));
    return /^plan-v\d+\.md$/i.test(name);
  }

  function inferWorkflowArtifactKind(path) {
    const lower = String(path || '').toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.json')) return 'json';
    return 'file';
  }
  function validateWorkflowProjectArtifacts({ project, board, deliverable } = {}) {
    const artifacts = Array.isArray(deliverable?.artifacts) ? deliverable.artifacts : [];
    if (artifacts.length === 0) return { ok: false, error: 'worker_deliverable_missing' };

    const workspacePath = readWorkflowString(deliverable?.workFolder)
      || readWorkflowString(deliverable?.workspacePath)
      || readWorkflowString(project?.workFolder)
      || readWorkflowString(project?.workspacePath);
    const workspaceRealPath = safeWorkflowRealPath(workspacePath);
    if (!workspaceRealPath) return { ok: false, error: 'worker_artifact_invalid' };

    const workspaceArtifacts = [];
    for (const artifact of artifacts) {
      const checked = validateWorkflowProjectArtifactPath(artifact, { workspaceRealPath });
      if (checked.ok) {
        workspaceArtifacts.push(artifact);
      }
    }
    if (workspaceArtifacts.length === 0) return { ok: false, error: 'worker_artifact_invalid' };
    const outputValidation = validateWorkflowProjectRequiredOutputs({ board, deliverable, workspacePath: workspaceRealPath });
    if (!outputValidation.ok) return outputValidation;
    return { ok: true };
  }
  function validateWorkflowProjectRequiredOutputs({ board, deliverable, workspacePath = '' } = {}) {
    const requiredOutputs = collectWorkflowTerminalRequiredOutputs(board);
    if (requiredOutputs.length === 0) return { ok: true };
    const result = validateDeliverableContract({
      requiredOutputs,
      artifacts: [
        ...(Array.isArray(deliverable?.artifacts) ? deliverable.artifacts : []),
        ...(Array.isArray(deliverable?.artifactManifest) ? deliverable.artifactManifest : []),
      ],
      workspacePath,
    });
    if (result.ok) return { ok: true };
    return {
      ok: false,
      error: 'worker_required_output_missing',
      failureClass: result.failureClass,
      errors: result.errors,
      missing: result.missing,
    };
  }
  function collectWorkflowTerminalRequiredOutputs(board) {
    if (!board || typeof board.getAllTasks !== 'function') return [];
    const tasks = board.getAllTasks().filter(task => task.status !== 'cancelled');
    if (tasks.length === 0) return [];
    const referenced = new Set();
    for (const task of tasks) {
      for (const depRef of Array.isArray(task.dependencies) ? task.dependencies : []) {
        const value = String(depRef || '').trim();
        if (value) referenced.add(value);
      }
    }
    const terminalTasks = tasks.filter(task => !isWorkflowTaskReferencedByDependency(task, referenced));
    const outputs = [];
    for (const task of terminalTasks.length > 0 ? terminalTasks : tasks) {
      const requirements = inferTaskRequirements(task);
      for (const output of requirements.requiredOutputs || []) {
        if (output.enforcement === 'hard') outputs.push(output);
      }
    }
    return outputs;
  }
  function isWorkflowTaskReferencedByDependency(task, referenced) {
    const candidates = [
      task.id,
      task.localTaskId,
      task.planItemId,
      task.title,
    ].map(value => String(value || '').trim()).filter(Boolean);
    return candidates.some(value => referenced.has(value));
  }
  function validateWorkflowProjectArtifactPath(artifact, { workspaceRealPath = null } = {}) {
    if (!workspaceRealPath) return { ok: false, error: 'worker_artifact_invalid' };
    const artifactPath = readWorkflowArtifactPath(artifact);
    if (!artifactPath || artifactPath.includes('\0')) return { ok: false, error: 'worker_artifact_invalid' };
    const normalized = artifactPath.replace(/^artifact:/, '').replace(/\\/g, '/');
    let candidate;
    if (isAbsolute(normalized)) {
      candidate = resolve(normalized);
    } else {
      candidate = resolve(workspaceRealPath, normalized);
    }

    const realPath = safeWorkflowRealPath(candidate);
    if (!realPath) return { ok: false, error: 'worker_artifact_invalid' };
    if (!isWorkflowPathInside(workspaceRealPath, realPath)) return { ok: false, error: 'worker_artifact_invalid' };
    if (!isReadableWorkflowArtifact(realPath)) return { ok: false, error: 'worker_artifact_invalid' };
    return { ok: true, path: realPath };
  }
  function readWorkflowArtifactPath(artifact) {
    if (typeof artifact === 'string') return artifact.trim();
    if (!artifact || typeof artifact !== 'object') return '';
    return readWorkflowString(artifact.path)
      || readWorkflowString(artifact.relativePath)
      || readWorkflowString(artifact.artifactPath)
      || readWorkflowString(artifact.filename)
      || readWorkflowString(artifact.name);
  }
  function mergeWorkflowArtifactEvidenceRefs(rawEvidenceRefs, artifacts = []) {
    const refs = new Set(readWorkflowStringArray(rawEvidenceRefs));
    for (const artifact of artifacts) {
      const artifactPath = readWorkflowArtifactPath(artifact);
      if (artifactPath) refs.add(`artifact:${artifactPath}`);
    }
    return [...refs];
  }
  function safeWorkflowRealPath(value) {
    if (!value || typeof value !== 'string') return null;
    try {
      return realpathSync(value);
    } catch {
      return null;
    }
  }
  function isWorkflowPathInside(root, target) {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }
  function isReadableWorkflowArtifact(path) {
    if (!path || !existsSync(path)) return false;
    try {
      return readFileSync(path).length > 0;
    } catch {
      return false;
    }
  }
  function markProjectTasksDoneByWorkflow({
    project,
    board,
    workflowRun,
    deliverable,
    producerNode,
    now = Date.now(),
    runtimeSource = 'kswarm-project-workflow',
    completedBy = 'project_workflow',
    reviewFeedback = '项目级 workflow gate 已通过。',
    executionReasonCode = 'project_workflow_preferred',
  } = {}) {
    // design §8.2（markProjectTasksDoneByWorkflow 项）：
    // 废止"全部置 done + 伪造 reviewResult.passed=true"。只按真实 node result
    // 完成对应 task；已经处于 done 状态的任务保留其既有 reviewResult（包括可能是
    // blocked 的高风险 review 结论），不得被本函数覆盖为 passed:true。
    //
    // 这个函数的调用点（maybeDeliverProjectWorkflowDeliverable /
    // maybeDeliverScriptWorkflowProjectResult）在调用前已经用 board.isAllDone()
    // 校验过 board 上没有未完成任务，所以这里理论上不应该再有非 done 任务；
    // 但仍保留"只对非 done 任务做收尾"的分支作为防御性实现，同时明确记录
    // gate-bearing（即声明了 review-like evidenceContract 的）非 done 任务不能被
    // 本函数无条件置 done——一旦出现这种任务，视为前置校验失守，直接拒绝本次调用，
    // 不再静默 bulk-done。
    const gateBearingIncomplete = board.getAllTasks().filter(task =>
      task.status !== 'done' &&
      task.status !== 'cancelled' &&
      task.evidenceContract?.kind &&
      String(task.evidenceContract.kind).startsWith('review_iteration'),
    );
    if (gateBearingIncomplete.length > 0) {
      return {
        ok: false,
        error: 'gate_bearing_task_incomplete',
        taskIds: gateBearingIncomplete.map(task => task.id),
      };
    }

    const completedTaskIds = [];
    for (const task of board.getAllTasks()) {
      if (task.status === 'cancelled') continue;

      // design §8.2（markProjectTasksDoneByWorkflow 项）：
      // provenance/审计标记（这次交付被哪个 workflow run 覆盖）对所有任务都应该写，
      // 用于事后追溯；但已经存在的、真实的 reviewResult 业务结论（包括可能是
      // blocked 的高风险 review 结论）绝不能被本函数覆盖为 passed:true。
      const hasExistingReviewResult = task.reviewResult && typeof task.reviewResult.passed === 'boolean';
      const oldStatus = task.status;
      const wasAlreadyDone = oldStatus === 'done';

      task.status = 'done';
      task.result = {
        summary: wasAlreadyDone && task.result?.summary
          ? task.result.summary
          : `项目级工作流已覆盖完成任务：${task.title || task.id}`,
        projectDeliverableSummary: deliverable.summary,
        artifacts: deliverable.artifacts,
        evidenceRefs: deliverable.evidenceRefs,
        provenance: {
          runtimeSource,
          workflowRunId: workflowRun.id,
          workflowId: workflowRun.workflowId,
          producerNodeId: producerNode.id,
          producingAgent: producerNode.producerAgent || producerNode.assignedAgent || task.assignedAgent || null,
        },
      };
      task.completedBy = completedBy;
      task.completedByWorkflowRunId = workflowRun.id;
      task.completedAt = now;
      task.updatedAt = now;
      task.activeRunId = null;
      task.runLease = null;
      task.runTelemetry = null;
      task.assignedExecutor = null;
      task.failureReason = null;
      task.lastFailureClass = null;
      task.blockedAt = null;
      task.blockedReason = null;
      task.blockKind = null;
      task.nextActions = [];
      task.recoveryStatus = null;
      task.recoveryReason = null;
      if (!hasExistingReviewResult) {
        // 只有从未产生过独立 review 结论的任务，才附加一个 workflow-level 的
        // 说明性标记；这不是"评审通过"，passed 显式为 null，防止
        // evaluateDependencySatisfaction 或任何未来 gate consumer 把它误读为
        // 已通过独立评审。
        task.reviewResult = {
          passed: null,
          feedback: reviewFeedback,
          reviewedAt: now,
          workflowLevelCompletion: true,
        };
      }
      // 已存在真实 reviewResult（无论 true/false）的任务，保留原值不覆盖。
      task.execution = {
        strategy: 'workflow',
        modeSource: 'project_default',
        reasonCode: executionReasonCode,
        workflowRunId: workflowRun.id,
        selectedAt: workflowRun.startedAt || workflowRun.createdAt || now,
      };
      updatePlanItemCompleted(project, task);
      completedTaskIds.push(task.id);
      if (oldStatus !== 'done') {
        eventLog.emit('task.done', {
          projectId: workflowRun.projectId,
          taskId: task.id,
          taskTitle: task.title,
          confirmedBy: completedBy,
          workflowRunId: workflowRun.id,
        });
      }
    }
    return { ok: true, completedTaskIds };
  }
  function markWorkflowProjectDeliveryBlocked(workflowRun, reason, { now = Date.now(), details = null } = {}) {
    const deliveryDetails = details && typeof details === 'object'
      ? {
          ...(details.error ? { error: details.error } : {}),
          ...(details.failureClass ? { failureClass: details.failureClass } : {}),
          ...(Array.isArray(details.errors) ? { errors: details.errors } : {}),
          ...(Array.isArray(details.missing) ? { missing: details.missing } : {}),
        }
      : {};
    return {
      ...workflowRun,
      status: 'blocked',
      completedAt: now,
      gateDecision: {
        status: 'blocked',
        reason: `project_delivery_failed:${reason}`,
        evidenceRefs: workflowRun.gateDecision?.evidenceRefs || [],
      },
      projectDelivery: {
        status: 'failed',
        projectId: workflowRun.projectId,
        failedAt: now,
        reason,
        ...deliveryDetails,
      },
      summary: {
        ...(workflowRun.summary || {}),
        primaryMessage: 'Project workflow delivery blocked',
      },
    };
  }
  function buildWorkflowTaskSubmissionResult({ workflowRun, task, producerNode }) {
    const output = producerNode.output && typeof producerNode.output === 'object' ? producerNode.output : {};
    const summary = readWorkflowString(output.summary)
      || readWorkflowString(output.text)
      || `工作流完成任务：${task.title || task.id}`;
    const workFolder = readWorkflowString(output.workFolder) || readWorkflowString(output.workspacePath);
    const artifactManifest = Array.isArray(output.artifactManifest) ? output.artifactManifest : [];
    return {
      summary,
      artifacts: Array.isArray(output.artifacts) ? output.artifacts : [],
      ...(artifactManifest.length > 0 ? { artifactManifest } : {}),
      ...(workFolder ? { workFolder, workspacePath: workFolder } : {}),
      evidenceRefs: readWorkflowStringArray(output.evidenceRefs),
      provenance: {
        runtimeSource: 'kswarm-workflow',
        workflowRunId: workflowRun.id,
        workflowId: workflowRun.workflowId,
        producerNodeId: producerNode.id,
        producingAgent: producerNode.producerAgent || producerNode.assignedAgent || task.assignedAgent || null,
      },
    };
  }
  function ensureWorkflowTaskSubmissionState(projectId, task, workerAgent, runId) {
    let current = boards.get(projectId)?.getTask(task.id);
    if (!current) return { ok: false, error: 'task_not_found' };
    if (current.status === 'submitted' || current.status === 'done') return { ok: true };
    if (current.status === 'dispatched') {
      const accepted = handleAcceptTask(projectId, current.id, workerAgent, runId);
      if (!accepted.ok && !accepted.alreadyAccepted) return accepted;
      current = boards.get(projectId)?.getTask(task.id);
    }
    if (current?.status === 'accepted') {
      const progressed = handleProgress(projectId, current.id, 'started', workerAgent, runId);
      if (!progressed.ok && !progressed.alreadyInProgress) return progressed;
      current = boards.get(projectId)?.getTask(task.id);
    }
    if (current?.status !== 'in_progress' && current?.status !== 'submitted') {
      return { ok: false, error: `cannot_submit_workflow_task_from_status:${current?.status || 'missing'}` };
    }
    return { ok: true };
  }
  function markWorkflowTaskSubmissionBlocked(workflowRun, reason, { now = Date.now() } = {}) {
    return {
      ...workflowRun,
      status: 'blocked',
      completedAt: now,
      gateDecision: {
        status: 'blocked',
        reason: `task_submission_failed:${reason}`,
        evidenceRefs: workflowRun.gateDecision?.evidenceRefs || [],
      },
      taskSubmission: {
        status: 'failed',
        taskId: workflowRun.scope?.taskId || null,
        failedAt: now,
        reason,
      },
      summary: {
        ...(workflowRun.summary || {}),
        primaryMessage: 'Task workflow submission blocked',
      },
    };
  }

  function prepareFinalDeliverableArtifact({ project, artifactRef, expectedFormat, clientClaimedHash, workspacePath = null } = {}) {
    const artifactPath = readWorkflowArtifactPath(artifactRef);
    if (!artifactPath) return { ok: false, error: 'artifact_missing' };
    if (artifactPath.includes('\0')) return { ok: false, error: 'artifact_path_escape' };

    const effectiveWorkspacePath = readWorkflowString(workspacePath) || readWorkflowString(project?.workFolder) || readWorkflowString(project?.workspacePath);
    const workspaceRealPath = safeWorkflowRealPath(effectiveWorkspacePath);
    if (!workspaceRealPath) return { ok: false, error: 'artifact_path_escape' };

    const normalized = artifactPath.replace(/^artifact:/, '').replace(/\\/g, '/');
    const candidate = isAbsolute(normalized) ? resolve(normalized) : resolve(workspaceRealPath, normalized);
    const realPath = safeWorkflowRealPath(candidate);
    if (!realPath || !isWorkflowPathInside(workspaceRealPath, realPath)) return { ok: false, error: 'artifact_path_escape' };
    let stats;
    try {
      stats = statSync(realPath);
    } catch {
      return { ok: false, error: 'artifact_missing' };
    }
    if (!stats.isFile()) return { ok: false, error: 'artifact_not_file' };

    let bytes;
    try {
      bytes = readFileSync(realPath);
    } catch {
      return { ok: false, error: 'artifact_read_failed' };
    }
    const formatCheck = validateFinalDeliverableFormat({ expectedFormat, path: realPath, bytes });
    if (!formatCheck.ok) return formatCheck;

    const serviceComputedHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (clientClaimedHash && clientClaimedHash !== serviceComputedHash) {
      return { ok: false, error: 'artifact_hash_mismatch', serviceComputedHash, clientClaimedHash };
    }
    return {
      ok: true,
      artifactRef: normalizeFinalArtifactRef(artifactRef, realPath, workspaceRealPath, stats),
      serviceComputedHash,
    };
  }

  function registerWorkflowFinalDeliverableCandidate({ project, workflowRun, producerNode, deliverable, source, runtimeSource, now = Date.now() } = {}) {
    const artifact = Array.isArray(deliverable?.artifacts) ? deliverable.artifacts[0] : null;
    const expectedFormat = inferWorkflowFinalExpectedFormat(artifact);
    return registerFinalDeliverable(workflowRun.projectId, {
      executionNodeId: producerNode?.id || null,
      workflowRunId: workflowRun.id,
      workflowNodeId: producerNode?.id || null,
      kind: artifact ? 'file' : 'none',
      expectedFormat,
      ...(artifact ? { artifactRef: artifact } : {}),
      ...(deliverable.workFolder ? { workFolder: deliverable.workFolder } : {}),
      ...(deliverable.workspacePath ? { workspacePath: deliverable.workspacePath } : {}),
      source,
      submittedBy: producerNode?.producerAgent || producerNode?.assignedAgent || runtimeSource || 'workflow',
      requiresReview: true,
      submissionIdempotencyKey: `workflow-final:${workflowRun.id}:${producerNode?.id || 'runtime'}:${source}`,
    }, {
      requestSource: 'agent',
      actorId: producerNode?.producerAgent || producerNode?.assignedAgent || runtimeSource || 'workflow',
      actorKind: 'agent_runtime',
      transport: 'agent_tool',
      runtimeTaskId: workflowRun.id,
    }, { now });
  }

  function inferWorkflowFinalExpectedFormat(artifact) {
    const kind = String(artifact?.kind || artifact?.type || artifact?.path || artifact?.filename || '').toLowerCase();
    if (kind.includes('html')) return 'html';
    if (kind.includes('pdf')) return 'pdf';
    if (kind.includes('pptx')) return 'pptx';
    if (kind.includes('json')) return 'json';
    if (kind.includes('csv')) return 'csv';
    if (kind.includes('md') || kind.includes('markdown')) return 'markdown';
    return 'markdown';
  }

  function validateFinalDeliverableFormat({ expectedFormat, path, bytes }) {
    if (!bytes || bytes.length === 0) return { ok: false, error: 'artifact_empty' };
    const lower = String(path || '').toLowerCase();
    if (expectedFormat === 'markdown') {
      const text = bytes.toString('utf8').trim();
      if (!text || /^(todo|tbd)$/i.test(text)) return { ok: false, error: 'artifact_markdown_placeholder' };
      return { ok: true };
    }
    if (expectedFormat === 'html') {
      const text = bytes.toString('utf8').trim();
      if (!/<[a-z][\s\S]*>/i.test(text)) return { ok: false, error: 'artifact_html_invalid' };
      return { ok: true };
    }
    if (expectedFormat === 'json') {
      try {
        JSON.parse(bytes.toString('utf8'));
        return { ok: true };
      } catch {
        return { ok: false, error: 'artifact_json_invalid' };
      }
    }
    if (expectedFormat === 'csv') {
      if (!bytes.toString('utf8').split(/\r?\n/).some(line => line.trim())) return { ok: false, error: 'artifact_csv_invalid' };
      return { ok: true };
    }
    if (expectedFormat === 'pdf' && !lower.endsWith('.pdf')) return { ok: false, error: 'artifact_pdf_invalid' };
    if (expectedFormat === 'pptx' && !lower.endsWith('.pptx')) return { ok: false, error: 'artifact_pptx_invalid' };
    return { ok: true };
  }

  function normalizeFinalArtifactRef(artifactRef, realPath, workspaceRealPath, stats) {
    const relativePath = relative(workspaceRealPath, realPath).replace(/\\/g, '/');
    return {
      ...(artifactRef && typeof artifactRef === 'object' && !Array.isArray(artifactRef) ? JSON.parse(JSON.stringify(artifactRef)) : {}),
      path: realPath,
      relativePath,
      workspacePath: workspaceRealPath,
      size: stats.size,
    };
  }

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  function normalizeFinalDeliverableFormat(value) {
    const lower = String(value || '').toLowerCase();
    if (['markdown', 'html', 'pptx', 'pdf', 'json', 'csv', 'none'].includes(lower)) return lower;
    if (lower === 'md') return 'markdown';
    return 'markdown';
  }

  function normalizeFinalDeliverableSource(value) {
    const source = String(value || '');
    if (['task_board', 'script_workflow', 'project_workflow', 'manual_repair', 'timed_monitor'].includes(source)) return source;
    return 'manual_repair';
  }

  function preflightFinalDeliverableApproval(finalDeliverable) {
    const deterministic = rerunFinalDeliverableChecks(finalDeliverable);
    if (!deterministic.ok) return deterministic;
    const board = boards.get(finalDeliverable.projectId);
    const reviewFacts = evaluateFinalDeliverableApprovalFacts({
      projectId: finalDeliverable.projectId,
      finalDeliverable,
      tasks: board?.getAllTasks() || [],
      workflowRuns: listProjectWorkflowRuns(finalDeliverable.projectId),
      reviewConditions: listReviewConditions(finalDeliverable.projectId),
    });
    if (!reviewFacts.ok) return reviewFacts;
    return deterministic;
  }

  function rerunFinalDeliverableChecks(finalDeliverable) {
    if (!finalDeliverable) return { ok: false, error: 'final_deliverable_not_found' };
    if (finalDeliverable.kind === 'none') return { ok: true };
    const project = projects.get(finalDeliverable.projectId);
    return prepareFinalDeliverableArtifact({
      project,
      artifactRef: finalDeliverable.artifactRef,
      expectedFormat: finalDeliverable.expectedFormat,
      clientClaimedHash: finalDeliverable.clientClaimedHash,
      workspacePath: finalDeliverable.artifactRef?.workFolder || finalDeliverable.artifactRef?.workspacePath,
    });
  }

  function selectReviewGateDecisionForDeliverable(projectId, deliverableId) {
    return [...reviewGateDecisions.values()]
      .filter(item => item.projectId === projectId && item.finalDeliverableId === deliverableId)
      .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')))[0] || null;
  }

  function buildLegacyDeliverableFromFinal(finalDeliverable) {
    return {
      summary: `Final deliverable approved: ${finalDeliverable.expectedFormat}`,
      artifacts: finalDeliverable.artifactRef ? [finalDeliverable.artifactRef] : [],
      evidenceRefs: finalDeliverable.artifactRef ? [`artifact:${finalDeliverable.artifactRef.path}`] : [],
      provenance: {
        runtimeSource: finalDeliverable.source,
        workflowRunId: finalDeliverable.workflowRunId || null,
        workflowId: null,
        producerNodeId: finalDeliverable.workflowNodeId || finalDeliverable.executionNodeId || null,
        producingAgent: finalDeliverable.submittedBy || null,
        finalDeliverableId: finalDeliverable.deliverableId,
      },
    };
  }

  function bumpProjectLifecycleVersion(project, now = Date.now()) {
    if (!project) return;
    project.lifecycleVersion = Number(project.lifecycleVersion || 0) + 1;
    project.updatedAt = now;
  }

  function readWorkflowString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }
  function readWorkflowStringArray(value) {
    return Array.isArray(value) ? value.map(item => readWorkflowString(item)).filter(Boolean) : [];
  }
  function emitWorkflowDispatchEvents(projectId, dispatches = []) {
    for (const dispatch of dispatches) {
      eventLog.emit('workflow.node.dispatched', {
        projectId,
        workflowRunId: dispatch.workflowRunId,
        workflowId: dispatch.workflowId,
        nodeId: dispatch.nodeId,
        targetParticipantId: dispatch.targetParticipantId,
        attempt: dispatch.attempt,
        handoffId: dispatch.handoffId,
      });
    }
  }
  function getHumanActions(projectId) {
    if (projectId) return humanActions.filter(a => a.projectId === projectId);
    return [...humanActions];
  }

  // Wrap mutation methods to auto-persist state
  const mutations = {
    createProject,
    setProjectTeamPlan,
    attachTeamOperationMembers,
    invalidateTeamPlansForAgent,
    updateProjectExecutionMode,
    handleApprove,
    activateAndStartProject,
    handleRetryPlan,
    handleHumanAddTasks,
    handleCloseProject,
    deleteProject,
    handleCreateTasks,
    handleAssignTask,
    handleReassignTask,
    handleRequestDispatch,
    handleMarkDone,
    handleRework,
    handleDeliver,
    registerFinalDeliverable,
    approveFinalDeliverable,
    submitReviewConditionEvidence,
    resolveReviewConditionEntry,
    handleSubmitPlan,
    handleRevisePlan,
    handleQualityReview,
    handleAcceptTask,
    handleProgress,
    handleWorkerFailure,
    handleSubmitResult,
    handleRecoverSubmission,
    handleResetTaskForRecovery,
    handleResumeTaskForRecovery,
    handleSuspendActiveRuns,
    handleResumeSuspendedRuns,
    handleTaskFail,
    handleContinueProject,
    handleResolveProjectIntervention,
    createWorkflowProposal,
    cancelWorkflowProposal,
    createScriptWorkflowProposal,
    startWorkflowRunFromProposal,
    startScriptWorkflowRunFromProposal,
    beginWorkflowScriptParallelGroup,
    dispatchWorkflowScriptAgentNode,
    retryWorkflowScriptAgentNode,
    completeScriptWorkflowRun,
    startProjectDiagnoseWorkflow,
    startAgentReviewSmokeWorkflow,
    handleWorkflowNodeResult,
    handleWorkflowNodeReview,
    handleWorkflowRuntimeUnavailable,
    handleWorkflowProgressBatch,
    cancelWorkflowRun,
    recoverInterruptedTaskWorkflows,
  };

  const persistenceLookups = {
    getProposalProjectId: (id) => workflowProposals.get(id)?.projectId ?? null,
    getRunProjectId: (id) => workflowRuns.get(id)?.projectId ?? null,
  };

  function assertPersistenceHealthy() {
    if (!persistence || typeof persistence.getHealth !== 'function') return;
    const health = persistence.getHealth();
    if (health && health.status === 'failed') {
      throw new PersistenceCommitError('[hub] persistence is in a failed state; mutation rejected');
    }
  }

  const persisted = {};
  const teamInputMutations = new Set([
    'updateProjectExecutionMode',
    'handleHumanAddTasks',
    'handleCreateTasks',
    'handleAssignTask',
    'handleReassignTask',
    'handleSubmitPlan',
    'handleRevisePlan',
  ]);
  for (const [name, fn] of Object.entries(mutations)) {
    persisted[name] = (...args) => {
      // Gate: after a durable-commit failure, reject subsequent mutations before
      // they run business logic (their in-memory/broker effects would be uncertain).
      assertPersistenceHealthy();
      const result = fn(...args);
      if (teamInputMutations.has(name)) {
        const projectId = typeof args[0] === 'string' ? args[0] : args[0]?.id;
        const project = projects.get(projectId);
        if (project) {
          if (project.teamPlan && project.teamPlan.status !== 'applied') project.teamPlan = { ...project.teamPlan, status: 'stale' };
          bumpProjectRevision(project, name);
        }
      }
      const scope = resolveMutationScope(name, args, persistenceLookups);
      persistState(scope);
      return result;
    };
  }

  return {
    ...persisted,
    getProject,
    getBoard,
    getEventLog,
    listProjects,
    findReusableProjectForCreateRequest,
    getRoomEventOutbox,
    flushRoomEventOutbox,
    submitTaskResult,
    listRoomMemberBlockers,
    getDispatchPlan,
    getExecutionGraph,
    getProjectLifecycle,
    listFinalDeliverables,
    listReviewGateDecisions,
    listReviewConditions,
    getProjectHealth,
    getProjectGateSnapshot,
    getProjectIntervention,
    listResumableScriptWorkflowRuns,
    deriveScriptWorkflowIntervention,
    createWorkflowProposal: persisted.createWorkflowProposal,
    cancelWorkflowProposal: persisted.cancelWorkflowProposal,
    createScriptWorkflowProposal: persisted.createScriptWorkflowProposal,
    startWorkflowRunFromProposal: persisted.startWorkflowRunFromProposal,
    startScriptWorkflowRunFromProposal: persisted.startScriptWorkflowRunFromProposal,
    beginWorkflowScriptParallelGroup: persisted.beginWorkflowScriptParallelGroup,
    dispatchWorkflowScriptAgentNode: persisted.dispatchWorkflowScriptAgentNode,
    retryWorkflowScriptAgentNode: persisted.retryWorkflowScriptAgentNode,
    completeScriptWorkflowRun: persisted.completeScriptWorkflowRun,
    startProjectDiagnoseWorkflow: persisted.startProjectDiagnoseWorkflow,
    startAgentReviewSmokeWorkflow: persisted.startAgentReviewSmokeWorkflow,
    handleWorkflowNodeResult: persisted.handleWorkflowNodeResult,
    handleWorkflowNodeReview: persisted.handleWorkflowNodeReview,
    handleWorkflowRuntimeUnavailable: persisted.handleWorkflowRuntimeUnavailable,
    handleWorkflowProgressBatch: persisted.handleWorkflowProgressBatch,
    cancelWorkflowRun: persisted.cancelWorkflowRun,
    recoverInterruptedTaskWorkflows: persisted.recoverInterruptedTaskWorkflows,
    listProjectWorkflowRuns,
    getWorkflowRun,
    getHumanActions,
    setProjectTeamPlan: persisted.setProjectTeamPlan,
    attachTeamOperationMembers: persisted.attachTeamOperationMembers,
    invalidateTeamPlansForAgent: persisted.invalidateTeamPlansForAgent,
    persistState,
    getPersistenceHealth,
    closePersistence,
  };
}

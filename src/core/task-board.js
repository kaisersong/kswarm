/**
 * TaskBoard — Pure state machine for tasks
 *
 * KSwarm Hub 的核心数据结构。
 * 只管状态，不做决策。
 *
 * Board 不知道：
 * - 为什么某个任务要分给某个 agent（PO 决定的）
 * - 任务内容对不对（PO 判断的）
 * - 下一步该做什么（PO 驱动的）
 *
 * Board 只知道：
 * - 当前有哪些任务
 * - 每个任务的状态
 * - 每个任务的依赖是否满足
 * - 状态流转是否合法
 */

import {captureObservationRow,captureObservationRows} from './observation-data.js';
import {captureExecutionData} from './task-execution-content.js';
const boardApply=Reflect.apply,boardWeakGet=WeakMap.prototype.get,boardWeakSet=WeakMap.prototype.set;
const boardMapGet=Map.prototype.get,boardMapHas=Map.prototype.has,boardMapValues=Map.prototype.values,boardMapNext=Object.getPrototypeOf(new Map().values()).next;
const boardDefine=Object.defineProperty,boardIsArray=Array.isArray,boardFinite=Number.isFinite,boardNow=Date.now,boardOwn=Object.hasOwn,boardDescriptors=Object.getOwnPropertyDescriptors,boardKeys=Reflect.ownKeys,boardDescriptor=Object.getOwnPropertyDescriptor;
const boardAppend=(array,value)=>boardDefine(array,array.length,{__proto__:null,value,writable:true,configurable:true,enumerable:true});
const boardValue=(value,key)=>{if(!value||typeof value!=='object')return undefined;const row=boardDescriptor(value,key);return row&&boardOwn(row,'value')?row.value:undefined;};
function originalTaskValues(tasks){const out=[],iterator=boardApply(boardMapValues,tasks,[]);for(let next=boardApply(boardMapNext,iterator,[]);!next.done;next=boardApply(boardMapNext,iterator,[]))boardAppend(out,next.value);return out;}

const originalBoardReaders=new WeakMap();
/** Detached data from the original private task Map, never a public method lookup. */
export function readTaskBoardSnapshot(board){const read=boardApply(boardWeakGet,originalBoardReaders,[board]);if(!read)throw Error('TASK_BOARD_SOURCE_UNAVAILABLE');return read.snapshot();}

/** Fixed original state-machine call for the Hub's authenticated timeout owner.
 * This low-level function exposes no raw task and is not a model tool. */
export function transitionOriginalTaskBoard(board,taskId,status){const owner=boardApply(boardWeakGet,originalBoardReaders,[board]);if(!owner)throw Error('TASK_BOARD_SOURCE_UNAVAILABLE');const result=owner.transition(taskId,status);return result.ok?{ok:true,from:result.from,to:result.to}:{ok:false,error:result.error};}
export function captureOriginalTaskBoardTask(board,taskId){const owner=boardApply(boardWeakGet,originalBoardReaders,[board]);if(!owner)throw Error('TASK_BOARD_SOURCE_UNAVAILABLE');return owner.captureTask(taskId);}
export function resumeOriginalTaskBoard(board,taskId,options){const owner=boardApply(boardWeakGet,originalBoardReaders,[board]);if(!owner)throw Error('TASK_BOARD_SOURCE_UNAVAILABLE');return owner.resume(taskId,options);}

/** Readonly original private readiness data, never an admission capability. */
export function readOriginalTaskBoardFirstAdmitReadiness(board,taskId,gateContext){const owner=boardApply(boardWeakGet,originalBoardReaders,[board]);if(!owner)throw Error('TASK_BOARD_SOURCE_UNAVAILABLE');return owner.readFirstAdmitReadiness(taskId,gateContext);}


import {
  buildTaskAliases,
  isExecutableTaskInput,
  makeRunId,
  normalizeLocalTaskId,
  normalizeExistingTask,
  normalizeTasksForProject,
  resolveTaskRef,
} from './task-identity.js';
import { evaluateDependencySatisfaction } from './gate-evaluator.js';

const VALID_TRANSITIONS = {
  pending: ['dispatched', 'failed', 'blocked', 'cancelled'],
  dispatched: ['accepted', 'pending', 'failed', 'blocked', 'cancelled'],  // pending = 超时退回
  accepted: ['in_progress', 'pending', 'failed', 'blocked', 'cancelled'],  // pending = agent 放弃
  in_progress: ['submitted', 'pending', 'failed', 'blocked', 'cancelled'],  // pending = rework redispatch
  submitted: ['done', 'in_progress', 'pending', 'blocked', 'cancelled'],    // pending = PO 要求返工并重新派发
  done: ['in_progress'],  // PO quality review can reopen for rework
  failed: ['pending', 'blocked'],  // 可重新派发或人工阻塞
  blocked: ['pending', 'cancelled'],
  cancelled: [],  // terminal
};

export function createTaskBoard(projectId = 'legacy-project') {
  const tasks = new Map();  // taskId → task
  let aliases = new Map();

  function rebuildAliases() {
    aliases = buildTaskAliases(projectId, [...tasks.values()]);
  }

  function resolveTaskId(taskId) {
    if (boardApply(boardMapHas,tasks,[taskId])) return taskId;
    const alias = boardApply(boardMapGet,aliases,[taskId]);
    if (alias) return alias;
    const resolved = resolveTaskRef(projectId, taskId, originalTaskValues(tasks));
    return resolved?.taskId || null;
  }

  /**
   * PO 提交任务列表（批量创建）
   */
  function addTasks(taskList) {
    const result = addTasksChecked(taskList);
    return result.ok ? result.taskIds : [];
  }

  function addTasksChecked(taskList) {
    const normalized = normalizeTasksForProject(projectId, taskList, [...tasks.values()]);
    if (!normalized.ok) return normalized;

    for (const task of normalized.tasks) {
      // Skip if task already exists (prevents duplicate submissions resetting state)
      if (tasks.has(task.id)) continue;
      tasks.set(task.id, {
        ...task,
        status: 'pending',
        assignedAgent: task.assignedAgent || null,
        assignedExecutor: null,
        result: null,
        attempt: task.attempt || 1,
        maxAttempts: task.maxAttempts || 2,
        failureReason: task.failureReason || null,
        failureHistory: Array.isArray(task.failureHistory) ? task.failureHistory : [],
        runtimeFailureCount: task.runtimeFailureCount || 0,
        qualityFailureCount: task.qualityFailureCount || 0,
        qualityReviewHistory: Array.isArray(task.qualityReviewHistory) ? task.qualityReviewHistory : [],
        rejectedSubmissions: Array.isArray(task.rejectedSubmissions) ? task.rejectedSubmissions : [],
        lastFailureClass: task.lastFailureClass || null,
        blockedAt: task.blockedAt || null,
        blockedReason: task.blockedReason || null,
        blockKind: task.blockKind || null,
        nextActions: Array.isArray(task.nextActions) ? task.nextActions : [],
        isCompositeParent: task.isCompositeParent === true,
        childTaskIds: Array.isArray(task.childTaskIds) ? [...task.childTaskIds] : [],
        parentTaskId: task.parentTaskId || null,
        activeRunId: task.activeRunId || null,
        runLease: task.runLease || null,
        runTelemetry: task.runTelemetry || null,
        selectedRoute: task.selectedRoute || null,
        preferredAssignedAgent: task.preferredAssignedAgent || null,
        lastRunLease: task.lastRunLease || null,
        recoveryStatus: task.recoveryStatus || null,
        recoveryReason: task.recoveryReason || null,
        startedAt: task.startedAt || null,
        completedAt: task.completedAt || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    rebuildAliases();
    return { ok: true, taskIds: normalized.tasks.map(t => t.id) };
  }

  /**
   * 状态流转（带合法性检查）
   */
  function transition(taskId, newStatus, meta = {}) {
    const resolvedTaskId = resolveTaskId(taskId);
    const task = resolvedTaskId ? tasks.get(resolvedTaskId) : null;
    if (!task) return { ok: false, error: 'task_not_found' };

    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return { ok: false, error: `invalid_transition: ${task.status} → ${newStatus}` };
    }

    const oldStatus = task.status;
    const now = Date.now();
    task.status = newStatus;
    task.updatedAt = now;

    if (meta.assignedAgent) task.assignedAgent = meta.assignedAgent;
    if (Object.prototype.hasOwnProperty.call(meta, 'assignedExecutor')) task.assignedExecutor = null;
    if (Object.prototype.hasOwnProperty.call(meta, 'assignedRuntimeInstance')) task.assignedRuntimeInstance = meta.assignedRuntimeInstance || null;
    if (Object.prototype.hasOwnProperty.call(meta, 'result')) task.result = meta.result;
    if (meta.failureReason) task.failureReason = meta.failureReason;
    if (meta.failureClass) task.lastFailureClass = meta.failureClass;
    if (meta.selectedRoute) task.selectedRoute = meta.selectedRoute;
    if (meta.preferredAssignedAgent) task.preferredAssignedAgent = meta.preferredAssignedAgent;
    if (meta.runTelemetry) {
      task.runTelemetry = {
        ...(task.runTelemetry || {}),
        ...meta.runTelemetry,
        updatedAt: now,
      };
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'qualityFailureCount')) task.qualityFailureCount = meta.qualityFailureCount;
    if (Object.prototype.hasOwnProperty.call(meta, 'runtimeFailureCount')) task.runtimeFailureCount = meta.runtimeFailureCount;
    if (newStatus === 'dispatched') {
      task.startedAt = null;
      task.activeRunId = meta.runId || makeRunId(task.id, task.attempt || 1);
      if (meta.assignedAgent) task.assignedAgent = meta.assignedAgent;
      task.runLease = {
        runId: task.activeRunId,
        projectId,
        taskId: task.id,
        assignedAgent: task.assignedAgent || null,
        assignedRuntimeInstance: task.assignedRuntimeInstance || null,
        assignedExecutor: null,
        attempt: task.attempt || 1,
        status: 'dispatched',
        createdAt: now,
        lastHeartbeatAt: now,
        leaseTimeoutMs: meta.leaseTimeoutMs || 600_000,
        leaseExpiresAt: meta.leaseExpiresAt || (now + (meta.leaseTimeoutMs || 600_000)),
        artifactManifest: [],
        submissionAcked: false,
      };
      task.runTelemetry = meta.runTelemetry || null;
      task.recoveryStatus = null;
      task.recoveryReason = null;
    }
    if (newStatus === 'accepted' && task.runLease) {
      task.runLease.status = 'accepted';
      task.runLease.assignedAgent = task.assignedAgent || meta.assignedAgent || task.runLease.assignedAgent || null;
      task.runLease.assignedRuntimeInstance = task.assignedRuntimeInstance || meta.assignedRuntimeInstance || task.runLease.assignedRuntimeInstance || null;
      task.runLease.assignedExecutor = null;
      task.runLease.lastHeartbeatAt = now;
      task.runLease.leaseTimeoutMs = meta.leaseTimeoutMs || task.runLease.leaseTimeoutMs || 600_000;
      task.runLease.leaseExpiresAt = meta.leaseExpiresAt || (now + task.runLease.leaseTimeoutMs);
    }
    if (newStatus === 'in_progress') {
      task.startedAt = now;
      if (task.runLease) {
        task.runLease.status = 'in_progress';
        task.runLease.startedAt = now;
        task.runLease.lastHeartbeatAt = now;
        task.runLease.leaseTimeoutMs = meta.leaseTimeoutMs || task.runLease.leaseTimeoutMs || 600_000;
        task.runLease.leaseExpiresAt = meta.leaseExpiresAt || (now + task.runLease.leaseTimeoutMs);
      }
    }
    if (newStatus === 'pending') {
      if (task.runLease) {
        task.lastRunLease = { ...task.runLease, status: 'expired', expiredAt: now };
      }
      task.runLease = null;
      task.runTelemetry = null;
      task.selectedRoute = null;
      task.assignedExecutor = null;
      task.assignedRuntimeInstance = null;
      task.activeRunId = null;
      task.startedAt = null;
      task.reviewResult = null;
      task.blockedAt = null;
      task.blockedReason = null;
      task.blockKind = null;
      task.nextActions = [];
    }
    if (newStatus === 'submitted') {
      task.reviewResult = null;
    }
    if (newStatus === 'done') {
      clearActiveFailureState(task);
    }
    if (['submitted', 'done', 'failed', 'blocked', 'cancelled'].includes(newStatus)) {
      if (task.runLease) {
        task.lastRunLease = {
          ...task.runLease,
          status: newStatus,
          lastHeartbeatAt: now,
          submissionAcked: newStatus === 'submitted' ? true : task.runLease.submissionAcked,
        };
      }
      task.runLease = null;
      if (newStatus !== 'submitted') task.runTelemetry = null;
      task.activeRunId = null;
    }
    if (newStatus === 'done') task.completedAt = now;
    if (newStatus === 'failed') task.failedAt = now;
    if (newStatus === 'blocked') {
      task.blockedAt = now;
      task.blockedReason = meta.blockedReason || meta.failureReason || task.blockedReason || '任务已阻塞';
      task.blockKind = meta.blockKind || task.blockKind || 'task_blocked';
      task.nextActions = Array.isArray(meta.nextActions) ? [...meta.nextActions] : (task.nextActions || []);
    }

    return { ok: true, taskId: task.id, from: oldStatus, to: newStatus, runId: task.activeRunId || meta.runId || null };
  }

  function blockTask(taskId, blockInfo = {}) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (task.status === 'blocked') {
      task.blockedReason = blockInfo.blockedReason || blockInfo.reason || task.blockedReason;
      task.blockKind = blockInfo.blockKind || task.blockKind;
      task.nextActions = Array.isArray(blockInfo.nextActions) ? [...blockInfo.nextActions] : (task.nextActions || []);
      task.lastFailureClass = blockInfo.failureClass || task.lastFailureClass;
      task.updatedAt = Date.now();
      return { ok: true, taskId: task.id, alreadyBlocked: true };
    }
    return transition(task.id, 'blocked', {
      blockedReason: blockInfo.blockedReason || blockInfo.reason,
      blockKind: blockInfo.blockKind,
      nextActions: blockInfo.nextActions,
      failureClass: blockInfo.failureClass,
      failureReason: blockInfo.blockedReason || blockInfo.reason,
      qualityFailureCount: blockInfo.qualityFailureCount,
      runtimeFailureCount: blockInfo.runtimeFailureCount,
    });
  }

  function completeCompositeParent(parentTaskId, result = null, meta = {}) {
    const parent = getTask(parentTaskId);
    if (!parent) return { ok: false, error: 'task_not_found' };
    if (!parent.isCompositeParent) return { ok: false, error: 'not_composite_parent' };
    const children = (parent.childTaskIds || []).map(id => getTask(id)).filter(Boolean);
    if (children.length !== (parent.childTaskIds || []).length) return { ok: false, error: 'child_task_missing' };
    const incomplete = children.filter(child => child.status !== 'done');
    if (incomplete.length > 0) {
      return { ok: false, error: 'children_not_done', incompleteTaskIds: incomplete.map(child => child.id) };
    }
    const now = Date.now();
    const oldStatus = parent.status;
    parent.status = 'done';
    parent.result = deriveParentExecutionResult(result);
    clearActiveFailureState(parent);
    parent.completedAt = now;
    parent.updatedAt = now;
    parent.completedBy = meta.completedBy || 'composite_children';
    return { ok: true, taskId: parent.id, from: oldStatus, to: 'done' };
  }

  function completeRetryParent(parentTaskId, result = null, meta = {}) {
    const parent = getTask(parentTaskId);
    if (!parent) return { ok: false, error: 'task_not_found' };
    if (parent.isCompositeParent) return { ok: false, error: 'composite_parent_not_retry_parent' };
    if (parent.status === 'done') return { ok: true, taskId: parent.id, alreadyDone: true };

    const now = Date.now();
    const oldStatus = parent.status;
    parent.status = 'done';
    parent.result = deriveParentExecutionResult(result);
    clearActiveFailureState(parent);
    parent.completedAt = now;
    parent.updatedAt = now;
    parent.completedBy = meta.completedBy || 'retry_child';
    parent.completedByTaskId = meta.completedByTaskId || null;
    parent.recoveredFromStatus = oldStatus;
    parent.recoveredAt = now;
    parent.recoveredBy = meta.recoveredBy || 'retry_child';
    parent.recoveryStatus = 'completed_by_retry';
    parent.recoveryReason = meta.recoveryReason || 'retry_child_completed';
    parent.activeRunId = null;
    parent.runLease = null;
    parent.runTelemetry = null;
    return { ok: true, taskId: parent.id, from: oldStatus, to: 'done' };
  }

  function validateRun(taskId, runId, workerAgent) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const assignedActor = task.assignedRuntimeInstance || task.assignedAgent;
    if (workerAgent && assignedActor && assignedActor !== workerAgent) {
      return {
        ok: false,
        error: 'wrong_assigned_agent',
        assignedAgent: task.assignedAgent,
        assignedRuntimeInstance: task.assignedRuntimeInstance || null,
        assignedExecutor: task.assignedExecutor || null,
      };
    }
    if (task.activeRunId && runId && task.activeRunId !== runId) {
      return { ok: false, error: 'stale_task_run', activeRunId: task.activeRunId, runId };
    }
    if (task.activeRunId && !runId) {
      return { ok: false, error: 'missing_run_id', activeRunId: task.activeRunId };
    }
    if (!task.activeRunId && runId && task.lastRunLease?.runId && task.lastRunLease.runId !== runId) {
      return { ok: false, error: 'stale_task_run', lastRunId: task.lastRunLease.runId, runId };
    }
    return { ok: true, task };
  }

  function recoverSubmission(taskId, result, meta = {}) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const pendingFailedArtifactRecovery = task.status === 'pending'
      && meta.allowPendingFailedArtifactRecovery === true
      && !task.activeRunId
      && !task.runLease
      && Number.isFinite(Number(task.failedAt))
      && Number(task.failedAt) > 0
      && Boolean(String(task.failureReason || task.lastFailureClass || '').trim());
    if (!['cancelled', 'failed', 'blocked', 'in_progress', 'accepted', 'dispatched'].includes(task.status) && !pendingFailedArtifactRecovery) {
      return { ok: false, error: `cannot_recover_from_status: ${task.status}` };
    }
    const oldStatus = task.status;
    task.status = 'submitted';
    task.result = result;
    task.reviewResult = null;
    task.updatedAt = Date.now();
    if (task.runLease) {
      task.lastRunLease = { ...task.runLease, status: 'recovered', recoveredAt: task.updatedAt };
    }
    task.runLease = null;
    task.activeRunId = null;
    task.recoveredFromStatus = oldStatus;
    task.recoveredAt = task.updatedAt;
    task.recoveredBy = meta.recoveredBy || meta.fromAgent || 'human';
    task.recoveredRunId = meta.runId || result?.runId || null;
    task.recoveryStatus = 'recovered';
    task.recoveryReason = meta.recoveryReason || 'recover_submission';
    return { ok: true, taskId: task.id, from: oldStatus, to: 'submitted' };
  }

  function resetStaleRun(taskId, reason = 'lease_expired') {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (!['dispatched', 'accepted', 'in_progress'].includes(task.status)) {
      return { ok: false, error: `cannot_reset_from_status: ${task.status}` };
    }
    const now = Date.now();
    const oldStatus = task.status;
    if (task.runLease) {
      task.lastRunLease = { ...task.runLease, status: 'expired', expiredAt: now, recoveryReason: reason };
    }
    task.status = 'pending';
    task.activeRunId = null;
    task.runLease = null;
    task.startedAt = null;
    task.updatedAt = now;
    task.recoveryStatus = 'redispatch_ready';
    task.recoveryReason = reason;
    return { ok: true, taskId: task.id, from: oldStatus, to: 'pending', reason };
  }

  function markRecoveryStatus(taskId, status, reason = null) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    task.recoveryStatus = status;
    task.recoveryReason = reason;
    task.updatedAt = Date.now();
    return { ok: true, taskId: task.id, recoveryStatus: status, recoveryReason: reason };
  }

  function updateRunTelemetry(taskId, telemetry = {}) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (!task.runLease) return { ok: false, error: 'no_active_run' };
    const now = Date.now();
    task.runTelemetry = {
      ...(task.runTelemetry || {}),
      ...telemetry,
      updatedAt: now,
    };
    const heartbeatAt = telemetry.lastHeartbeatAt || now;
    task.runLease.lastHeartbeatAt = heartbeatAt;
    const toleranceMs = task.runLease.leaseTimeoutMs || 600_000;
    task.runLease.leaseExpiresAt = heartbeatAt + toleranceMs;
    task.updatedAt = now;
    return { ok: true, taskId: task.id };
  }

  function markRunSuspended(taskId, now = Date.now()) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (!['dispatched', 'accepted', 'in_progress'].includes(task.status)) {
      return { ok: false, error: 'not_active' };
    }
    task.suspendedAt = now;
    task.updatedAt = now;
    return { ok: true, taskId: task.id };
  }

  function refreshLeaseForResume(taskId, { leaseTimeoutMs = 600_000 } = {}) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const now = Date.now();
    if (task.runLease) {
      const toleranceMs = task.runLease.leaseTimeoutMs || leaseTimeoutMs;
      task.runLease.lastHeartbeatAt = now;
      task.runLease.leaseExpiresAt = now + toleranceMs;
    }
    if (task.suspendedAt) delete task.suspendedAt;
    task.updatedAt = now;
    return { ok: true, taskId: task.id };
  }

  /**
   * 依赖检查：哪些 pending 任务的所有前置已 done
   *
   * design §8.2：唯一依赖判定入口委托 gate-evaluator.js:evaluateDependencySatisfaction，
   * 不再自行维护 `dep.status === 'done'` 的私有判断。TaskBoard 实例本身不持有
   * project 对象，schemaV2/dependencyPolicies/gateEvaluationsByTaskId 等项目级上下文
   * 由调用者（如 hub.js）显式传入；不传参数时保持 legacy `completed` 兼容行为，
   * 不破坏现有调用方隐式假设。
   *
   * @param {Object} [gateContext]
   * @param {Record<string, import('./gate-evaluator.js').DependencyPolicy>} [gateContext.dependencyPolicies]
   * @param {Record<string, import('./gate-evaluator.js').GateEvaluationV1[]>} [gateContext.gateEvaluationsByTaskId]
   * @param {Record<string, string[]>} [gateContext.consumedArtifactIdsByDependencyTaskId]
   * @param {Record<string, any>} [gateContext.currentGateFactsByTaskId]
   * @param {boolean} [gateContext.schemaV2=false]
   */
  function pendingTaskDependencyReason(task){
    if(boardValue(task,'status')!=='pending')return'task_not_pending';
    if(boardValue(task,'isCompositeParent'))return'composite_parent';
    const unresolved=boardValue(task,'unresolvedDependencies');if(unresolved&&unresolved.length!==0)return'unresolved_dependencies';
    return null;
  }
  function evaluatePendingTaskDependencyReadiness(task,dependencyTasks,gateContext={}){
    const reason=pendingTaskDependencyReason(task);if(reason)return{ok:false,reason};
    const {dependencyPolicies={},gateEvaluationsByTaskId={},consumedArtifactIdsByDependencyTaskId={},currentGateFactsByTaskId={},schemaV2=false}=gateContext;
    return evaluateDependencySatisfaction({task,dependencyTasks,dependencyPolicies,gateEvaluationsByTaskId,consumedArtifactIdsByDependencyTaskId,currentGateFactsByTaskId,schemaV2});
  }
  function getDispatchable(gateContext = {}) {
    const {dependencyPolicies={},gateEvaluationsByTaskId={},consumedArtifactIdsByDependencyTaskId={},currentGateFactsByTaskId={},schemaV2=false}=gateContext;
    const context={dependencyPolicies,gateEvaluationsByTaskId,consumedArtifactIdsByDependencyTaskId,currentGateFactsByTaskId,schemaV2};
    const all=originalTaskValues(tasks),ready=[];
    for(let i=0;i<all.length;i++){
      const task=all[i];if(pendingTaskDependencyReason(task))continue;const dependencies=boardIsArray(task.dependencies)?task.dependencies:[],dependencyTasks=[];
      for(let n=0;n<dependencies.length;n++){const id=resolveTaskId(dependencies[n]),dep=id?boardApply(boardMapGet,tasks,[id]):null;if(dep)boardAppend(dependencyTasks,dep);}
      if(evaluatePendingTaskDependencyReadiness(task,dependencyTasks,context).ok)boardAppend(ready,task);
    }
    return ready;
  }
  function readFirstAdmitReadiness(taskId,rawContext){
    const denied=reason=>captureExecutionData({ok:false,reason});
    if(typeof taskId!=='string'||!taskId)return denied('canonical_task_required');
    let gateContext;
    try{gateContext=captureExecutionData(rawContext);}catch{return denied('gate_context_unavailable');}
    const required=['dependencyPolicies','gateEvaluationsByTaskId','consumedArtifactIdsByDependencyTaskId','currentGateFactsByTaskId','schemaV2'];
    if(!gateContext||typeof gateContext!=='object'||boardIsArray(gateContext))return denied('gate_context_unavailable');
    const fields=boardDescriptors(gateContext);if(boardKeys(fields).length!==required.length)return denied('gate_context_unavailable');
    for(let i=0;i<required.length;i++)if(!boardOwn(fields,required[i]))return denied('gate_context_unavailable');
    if(typeof gateContext.schemaV2!=='boolean')return denied('gate_schema_unavailable');
    for(let i=0;i<4;i++){const value=gateContext[required[i]];if(!value||typeof value!=='object'||boardIsArray(value))return denied('gate_context_unavailable');}
    const raw=boardApply(boardMapGet,tasks,[taskId]);if(!raw)return denied('canonical_task_required');
    let task;
    try{task=captureExecutionData(raw);}catch{return denied('task_content_unavailable');}
    if(task.id!==taskId||task.status!=='pending')return denied('task_not_pending');
    if(task.isCompositeParent)return denied('composite_parent');
    const unresolved=boardValue(task,'unresolvedDependencies');if(unresolved!==undefined&&(!boardIsArray(unresolved)||unresolved.length))return denied('unresolved_dependencies');
    const dependencies=boardValue(task,'dependencies');if(dependencies!==undefined&&!boardIsArray(dependencies))return denied('dependencies_unavailable');
    const activeRunId=boardValue(task,'activeRunId'),runLease=boardValue(task,'runLease');if(activeRunId!==undefined&&activeRunId!==null||runLease!==undefined&&runLease!==null)return denied('execution_reconciliation_required');
    const now=boardNow();if(!boardFinite(now)||now<0)return denied('clock_unavailable');
    const retryNotBefore=boardValue(task,'retryNotBefore');if(retryNotBefore!==undefined&&retryNotBefore!==null&&(!boardFinite(retryNotBefore)||retryNotBefore<0||retryNotBefore>now))return denied('retry_backoff');
    const ids=dependencies||[],dependencyTasks=[];
    for(let i=0;i<ids.length;i++){
      if(typeof ids[i]!=='string'||!ids[i])return denied('dependencies_unavailable');
      const dep=boardApply(boardMapGet,tasks,[ids[i]]);
      if(dep){try{boardAppend(dependencyTasks,captureExecutionData(dep));}catch{return denied('dependency_content_unavailable');}}
    }
    const result=evaluatePendingTaskDependencyReadiness(task,dependencyTasks,gateContext);
    return captureExecutionData({ok:result.ok,taskId,checkedAt:now,...(result.ok?{}:{reason:result.reason||'dependency_blocked',blockedDependencies:result.blockedDependencies||[]})});
  }

  /**
   * 项目是否全部完成
   */
  function isAllDone() {
    if (tasks.size === 0) return false;
    return [...tasks.values()].every(t => isTaskDoneForProjectCompletion(t));
  }

  function isTaskDoneForProjectCompletion(task) {
    if (task.status === 'done' || task.status === 'cancelled') return true;
    const parentRef = task.parentTaskId || task.retryOfTaskId;
    if (!parentRef) return false;
    const parentId = resolveTaskId(parentRef) || parentRef;
    const parent = tasks.get(parentId);
    return Boolean(
      parent &&
      (parent.status === 'done' || parent.status === 'cancelled') &&
      (task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled')
    );
  }

  function getTask(id) {
    const taskId = resolveTaskId(id);
    return taskId ? tasks.get(taskId) : undefined;
  }
  function getAllTasks() { return [...tasks.values()]; }

  /**
   * 阶段感知派发：只返回指定阶段中可派发的任务
   *
   * design §8.2：与 getDispatchable 共享同一套 gate 判定上下文透传规则，
   * 不能只修 getDispatchable 而漏掉这条兄弟路径。
   */
  function getDispatchableInPhase(phaseId, gateContext = {}) {
    const all=getDispatchable(gateContext),selected=[];for(let i=0;i<all.length;i++)if(all[i].phaseId===phaseId)boardAppend(selected,all[i]);return selected;
  }

  /**
   * 获取某阶段的完成状态
   */
  function getPhaseStatus(phaseId,sourceTasks=[...tasks.values()]) { return taskBoardPhaseStatus(phaseId,sourceTasks); }

  /**
   * 获取整体 plan 进度（按阶段聚合）
   */
  function getPlanProgress() { return taskBoardPlanProgress([...tasks.values()]); }


  function getStats() {
    const all = [...tasks.values()];
    return {
      total: all.length,
      pending: all.filter(t => t.status === 'pending').length,
      dispatched: all.filter(t => t.status === 'dispatched').length,
      inProgress: all.filter(t => ['accepted', 'in_progress'].includes(t.status)).length,
      submitted: all.filter(t => t.status === 'submitted').length,
      done: all.filter(t => t.status === 'done').length,
      failed: all.filter(t => t.status === 'failed').length,
      blocked: all.filter(t => t.status === 'blocked').length,
    };
  }

  /**
   * Restore tasks from persisted state (no status reset)
   */
  function loadTasks(taskArray) {
    tasks.clear();
    for (const task of taskArray) {
      const normalized = normalizeExistingTask(projectId, task);
      if (!isExecutableTaskInput(normalized)) continue;
      clearStaleReview(normalized);
      if (normalized.status === 'done') clearActiveFailureState(normalized);
      tasks.set(normalized.id, normalized);
    }
    rebuildAliases();
    for (const task of tasks.values()) {
      const refs = Array.isArray(task.dependencyRefs) ? task.dependencyRefs : (task.dependencies || []);
      const deps = [];
      const unresolved = [];
      for (const ref of refs) {
        const phaseDeps = resolvePhaseDependencyIds(ref, task);
        if (phaseDeps.length > 0) {
          for (const depId of phaseDeps) {
            if (!deps.includes(depId)) deps.push(depId);
          }
          continue;
        }
        const depId = resolveTaskId(ref);
        if (depId) deps.push(depId);
        else unresolved.push(ref);
      }
      task.dependencies = deps;
      task.unresolvedDependencies = unresolved;
    }
  }

  function resolvePhaseDependencyIds(ref, currentTask) {
    const raw = String(ref || '').trim();
    if (!raw) return [];
    const normalizedRef = normalizeLocalTaskId(raw);
    return [...tasks.values()]
      .filter(task => task.id !== currentTask.id)
      .filter(task => !task.parentTaskId)
      .filter(task => {
        if (!task.phaseId) return false;
        return task.phaseId === raw || normalizeLocalTaskId(task.phaseId) === normalizedRef;
      })
      .map(task => task.id);
  }

  function clearStaleReview(task) {
    if (task.status !== 'submitted') return;
    if (task.reviewResult?.passed !== false) return;
    const submittedAt = Number(task.updatedAt || task.recoveredAt || 0);
    const reviewedAt = Number(task.reviewResult.reviewedAt || 0);
    if (!submittedAt) return;
    if (!reviewedAt || reviewedAt < submittedAt) {
      task.reviewResult = null;
    }
  }

  /**
   * design §8.2（completeCompositeParent/completeRetryParent 项）：
   * parent 不能整体复制 child/retry 的 result（会连带复制 reserved service-owned
   * 字段，例如 gateEvaluation、projectGateSnapshot、reviewGateDecision，以及可能
   * 被误读为"已通过独立评审"的 reviewResult）。只允许一个显式 allowlist：
   * summary 与 canonical artifact 引用（artifacts / artifactManifest / evidenceRefs）。
   * blocked/missing gate evaluation 不会因为 parent 完成而被伪造为满足 verified_pass。
   */
  function deriveParentExecutionResult(childResult = null) {
    if (!childResult || typeof childResult !== 'object' || Array.isArray(childResult)) return null;
    const derived = {};
    if (typeof childResult.summary === 'string') derived.summary = childResult.summary;
    if (Array.isArray(childResult.artifacts)) derived.artifacts = childResult.artifacts;
    if (Array.isArray(childResult.artifactManifest)) derived.artifactManifest = childResult.artifactManifest;
    if (Array.isArray(childResult.evidenceRefs)) derived.evidenceRefs = childResult.evidenceRefs;
    if (childResult.provenance && typeof childResult.provenance === 'object') derived.provenance = childResult.provenance;
    return derived;
  }

  function clearActiveFailureState(task) {
    task.failureReason = null;
    task.failedAt = null;
    task.lastFailureClass = null;
    task.blockedAt = null;
    task.blockedReason = null;
    task.blockKind = null;
    task.nextActions = [];
  }

  const api={
    addTasks,
    addTasksChecked,
    transition,
    blockTask,
    completeCompositeParent,
    completeRetryParent,
    validateRun,
    recoverSubmission,
    resetStaleRun,
    markRecoveryStatus,
    updateRunTelemetry,
    markRunSuspended,
    refreshLeaseForResume,
    resolveTaskId,
    getDispatchable,
    getDispatchableInPhase,
    getPhaseStatus,
    getPlanProgress,
    isAllDone,
    getTask,
    getAllTasks,
    getStats,
    loadTasks,
  };
  boardApply(boardWeakSet,originalBoardReaders,[api,{snapshot:()=>captureObservationRows(originalTaskValues(tasks)),transition,resume:refreshLeaseForResume,readFirstAdmitReadiness,captureTask(taskId){
    let task=tasks.get(taskId);
    if(!task){captureObservationRows([...tasks.values()]);task=getTask(taskId);}if(!task)return null;
    const snapshot=captureObservationRow(task),assertCurrent=()=>{if(tasks.get(snapshot.id)!==task)throw Error('RECOVERY_TASK_STALE');};assertCurrent();
    return Object.freeze({task:snapshot,assertCurrent,read(){assertCurrent();return captureObservationRow(task);}});
  }}]);return api;
}

/**
 * Restore a task board from serialized task array
 */
export function restoreTaskBoard(taskArray, projectId = 'legacy-project') {
  const board = createTaskBoard(projectId);
  board.loadTasks(taskArray);
  return board;
}

function taskBoardPhaseStatus(phaseId,sourceTasks){
 const phaseTasks=sourceTasks.filter(task=>task.phaseId===phaseId);
 return{total:phaseTasks.length,pending:phaseTasks.filter(task=>task.status==='pending').length,done:phaseTasks.filter(task=>task.status==='done').length,inProgress:phaseTasks.filter(task=>!['pending','done','cancelled','failed'].includes(task.status)).length,failed:phaseTasks.filter(task=>task.status==='failed').length};
}

function isRetryAttempt(task = {}) {
    if (!task.parentTaskId && !task.retryOfTaskId) return false;
    if (Number(task.attempt || 1) > 1) return true;
    return /-retry-\d+$/.test(String(task.id || ''));
  }

export function taskBoardPlanProgress(all) {
    const planTasks = all.filter(task => !isRetryAttempt(task));
    const phaseIds = [...new Set(planTasks.map(t => t.phaseId).filter(Boolean))];
    const executionAttempts = {
      total: all.length,
      failed: all.filter(t => t.status === 'failed').length,
      pending: all.filter(t => t.status === 'pending').length,
      done: all.filter(t => t.status === 'done').length,
      inProgress: all.filter(t => ['dispatched', 'accepted', 'in_progress', 'submitted'].includes(t.status)).length,
    };
    return {
      phases: phaseIds.map(id => ({ phaseId: id, ...taskBoardPhaseStatus(id, planTasks) })),
      total: planTasks.length,
      pending: planTasks.filter(t => t.status === 'pending').length,
      done: planTasks.filter(t => t.status === 'done').length,
      failed: planTasks.filter(t => t.status === 'failed').length,
      inProgress: planTasks.filter(t => ['dispatched', 'accepted', 'in_progress', 'submitted'].includes(t.status)).length,
      executionAttempts,
    };
  }


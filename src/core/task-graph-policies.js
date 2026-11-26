import {readOrdinaryTaskDependencyPolicies,InitialPlanSemanticSchemaError} from './initial-plan-semantic-schema.js';
/**
 * KSwarm — normalizeTaskGraphPolicies（design §3.3：动态依赖的唯一 policy owner）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.3 —— "动态依赖的唯一 policy owner 冻结为新增纯函数
 *   normalizeTaskGraphPolicies(projectId, tasks, schemaVersion)，而非 planner
 *   文案或不存在的 task-board.setTasks：planner 输出 dependencyPolicyRefs，
 *   key 与原始 dependency ref 同域；所有真实图写入口——新计划/PO
 *   prepareTasksForBoard、task-board.addTasks/addTasksChecked 经
 *   task-identity.js:normalizeTasksForProject，以及恢复
 *   task-board.loadTasks + resolvePhaseDependencyIds——在入 board/恢复后统一
 *   调用该 normalizer；normalizer 把 title/phase/ref → stable task ID 的解析
 *   结果与 policy 同步展开到每个 resolved ID。handleCreateTasks、
 *   handleHumanAddTasks、Room create-task 和 workflow 生成任务都必须走此
 *   seam；v2 unresolved ref、缺 policy、悬空 policy key 均 blocked，不静默
 *   默认。"
 *
 * 现状核实（2026-09-02）：这个纯函数此前完全不存在——PO/Room 声明的
 * dependencyPolicy 归一化逻辑此前直接内联写在 hub.js:handleCreateTasks 内部，
 * handleHumanAddTasks（Room→已有 Project 的另一条图写入口）完全没有接入，
 * 意味着通过 Room 添加的任务永远无法声明 verified_pass 依赖策略。本模块把
 * 归一化逻辑提炼为独立纯函数，供两个入口复用，保持行为完全一致。
 *
 * 本模块只做归一化 + 校验，不做磁盘/state 写入（那是 caller 的职责）。
 */

const DEPENDENCY_POLICY_VALUES = Object.freeze(['completed', 'completed_for_remediation', 'verified_pass']);

/**
 * @param {Object} params
 * @param {Array} params.originalTaskList 提交时的原始任务输入（可能带
 *   dependencyPolicy: Record<originalRef, DependencyPolicy>）
 * @param {Array} params.identityPreviewTasks task-identity.js:normalizeTasksForProject
 *   的归一化结果（每项带 dependencyRefs/dependencies/unresolvedDependencies/
 *   localTaskId/id）
 * @returns {{ ok: boolean, policyWrites?: Array<[string, string]>, error?: string, ref?: string, policyValue?: string, taskId?: string }}
 */
export function normalizeTaskGraphPolicies({ originalTaskList = [], identityPreviewTasks = [] } = {}) {
  const policyWrites = [];
  for (const originalTask of Array.isArray(originalTaskList) ? originalTaskList : []) {
    const declaredPolicy = originalTask && typeof originalTask === 'object' ? originalTask.dependencyPolicy : null;
    if (!declaredPolicy || typeof declaredPolicy !== 'object' || Array.isArray(declaredPolicy)) continue;

    const previewTask = identityPreviewTasks.find(t => t.localTaskId === originalTask.id || t.id === originalTask.id);
    if (!previewTask) continue;

    const refs = Array.isArray(previewTask.dependencyRefs) ? previewTask.dependencyRefs : [];
    const resolvedIds = Array.isArray(previewTask.dependencies) ? previewTask.dependencies : [];
    const unresolvedRefs = new Set(Array.isArray(previewTask.unresolvedDependencies) ? previewTask.unresolvedDependencies : []);
    // 位置对应仅在 refs 与 resolvedIds 长度一致时可靠（没有 phase 展开/别名
    // 一对多的场景）；这是当前实现的已知范围边界，不在本轮尝试解决更复杂的
    // ref→ID 多对多映射。
    const positionalMap = refs.length === resolvedIds.length
      ? new Map(refs.map((ref, index) => [ref, resolvedIds[index]]))
      : null;

    for (const [ref, policyValue] of Object.entries(declaredPolicy)) {
      if (!DEPENDENCY_POLICY_VALUES.includes(policyValue)) {
        return { ok: false, error: 'invalid_dependency_policy', ref, policyValue };
      }
      if (unresolvedRefs.has(ref)) {
        return { ok: false, error: 'dangling_dependency_policy_ref', ref, taskId: originalTask.id };
      }
      const resolvedId = positionalMap?.get(ref);
      if (!resolvedId) {
        return { ok: false, error: 'dangling_dependency_policy_ref', ref, taskId: originalTask.id };
      }
      policyWrites.push([resolvedId, policyValue]);
    }
  }
  return { ok: true, policyWrites };
}

/**
 * 把 normalizeTaskGraphPolicies 的 policyWrites 结果原子应用到
 * project.dependencyPolicies。caller 必须在调用前已经确认整个图写入本身
 * 成功（例如 board.addTasksChecked 已经 ok），这里只做纯粹的 map 写入。
 */
export function applyTaskGraphPolicyWrites(project, policyWrites = []) {
  if (!project || typeof project !== 'object') return;
  if (!project.dependencyPolicies || typeof project.dependencyPolicies !== 'object') project.dependencyPolicies = {};
  for (const [resolvedId, policyValue] of policyWrites) {
    project.dependencyPolicies[resolvedId] = policyValue;
  }
}

export { DEPENDENCY_POLICY_VALUES };

/** Additional v2 check over the ORIGINAL expander/identity/policy outputs.
 * This is data validation only, never a frame, writer or execution grant.
 * Legacy graph normalization deliberately keeps its existing semantics. */
export function validateAdditiveTaskGraphPolicies(input){return validateTaskGraphUnion(input);}
/** Fixed original plan candidates may refer to their own original expanded IDs.
 * This data check is not a caller capability or a choice of authorization mode. */
export function validateTaskPlanUnionPolicies(input){
 if(!Array.isArray(input.expandedTaskInputs))return{ok:false,error:'ADDITIVE_GRAPH_UNVERIFIED'};
 return validateTaskGraphUnion(input,new Set(input.expandedTaskInputs.map(task=>task.id)));
}
function validateTaskGraphUnion({projectId,existingTasks,originalTaskList,identityPreviewTasks,dependencyPolicies,policyWrites},plannedRefs=new Set()) {
  const deny=error=>({ok:false,error});
  if(!Array.isArray(existingTasks)||!Array.isArray(originalTaskList)||!Array.isArray(identityPreviewTasks)||!Array.isArray(policyWrites))return deny('ADDITIVE_GRAPH_UNVERIFIED');
  if(existingTasks.length+identityPreviewTasks.length>200)return deny('ADDITIVE_TASK_LIMIT_EXCEEDED');
  const oldIds=new Set(existingTasks.map(task=>task.id));
  const newIds=new Set(identityPreviewTasks.map(task=>task.id));
  if(oldIds.size!==existingTasks.length||newIds.size!==identityPreviewTasks.length
    ||existingTasks.some(task=>task.projectId!==projectId)||identityPreviewTasks.some(task=>task.projectId!==projectId||oldIds.has(task.id)))return deny('ADDITIVE_GRAPH_UNVERIFIED');
  // Only generated composite internals may introduce local dependency refs.
  // Caller input must name an existing stable ID before alias normalization.
  if(originalTaskList.some(task=>(task.dependencies??[]).some(ref=>!oldIds.has(ref)&&!plannedRefs.has(ref))))return deny('ADDITIVE_DEPENDENCY_ID_REQUIRED');
  const allIds=new Set([...oldIds,...newIds]);
  if(identityPreviewTasks.some(task=>task.unresolvedDependencies?.length||task.dependencies.some(id=>!allIds.has(id))))return deny('ADDITIVE_GRAPH_UNVERIFIED');
  let oldPolicies;
  try{oldPolicies=readOrdinaryTaskDependencyPolicies(dependencyPolicies);}catch(error){if(!(error instanceof InitialPlanSemanticSchemaError))throw error;return deny('ADDITIVE_POLICY_BASE_UNVERIFIED');}
  if(Object.keys(oldPolicies).some(id=>!oldIds.has(id)))return deny('ADDITIVE_POLICY_BASE_UNVERIFIED');
  const targets=new Set(identityPreviewTasks.flatMap(task=>task.dependencies));
  const proposed=new Map();
  for(const [id,value] of policyWrites){
    if(!targets.has(id)||!DEPENDENCY_POLICY_VALUES.includes(value))return deny('ADDITIVE_GRAPH_UNVERIFIED');
    if(Object.hasOwn(oldPolicies,id)&&oldPolicies[id]!==value||proposed.has(id)&&proposed.get(id)!==value)return {ok:false,error:'ADDITIVE_DEPENDENCY_POLICY_CONFLICT',taskId:id};
    proposed.set(id,value);
  }
  return {ok:true,policyDelta:[...proposed].filter(([id])=>!Object.hasOwn(oldPolicies,id))};
}

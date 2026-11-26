import {test} from 'node:test';
import assert from 'node:assert/strict';
import {expandCompositeTasks} from '../src/core/composite-task-expander.js';
import {normalizeTasksForProject} from '../src/core/task-identity.js';
import * as policies from '../src/core/task-graph-policies.js';
const existing=[{id:'p__dependency',localTaskId:'dependency',projectId:'p',title:'Existing dependency',dependencies:[]}];
function validate(taskList,{old=existing,map={p__dependency:'verified_pass'}}={}){
 assert.equal(typeof policies.validateAdditiveTaskGraphPolicies,'function');
 const expanded=expandCompositeTasks(taskList,{projectId:'p',poAgent:'po',members:['writer','reviewer']});assert.equal(expanded.ok,true);
 const preview=normalizeTasksForProject('p',expanded.tasks,old);assert.equal(preview.ok,true);
 const normalized=policies.normalizeTaskGraphPolicies({originalTaskList:taskList,identityPreviewTasks:preview.tasks});assert.equal(normalized.ok,true);
 return policies.validateAdditiveTaskGraphPolicies({projectId:'p',existingTasks:old,originalTaskList:taskList,identityPreviewTasks:preview.tasks,dependencyPolicies:map,policyWrites:normalized.policyWrites});
}
test('the original normalized policy cannot overwrite a dependency shared by old tasks',()=>{
 const task={id:'new',title:'New task',dependencies:['p__dependency'],dependencyPolicy:{p__dependency:'completed'}};
 assert.deepEqual(validate([task]),{ok:false,error:'ADDITIVE_DEPENDENCY_POLICY_CONFLICT',taskId:'p__dependency'});
});
test('same-value existing policy and a new target policy remain additive',()=>{
 const same={id:'new',title:'New task',dependencies:['p__dependency'],dependencyPolicy:{p__dependency:'verified_pass'}};
 assert.deepEqual(validate([same]),{ok:true,policyDelta:[]});
 assert.deepEqual(validate([same],{map:{}}),{ok:true,policyDelta:[['p__dependency','verified_pass']]});
});
test('two additions cannot disagree about the same global dependency policy',()=>{
 const tasks=[{id:'first',title:'First',dependencies:['p__dependency'],dependencyPolicy:{p__dependency:'completed'}},{id:'second',title:'Second',dependencies:['p__dependency'],dependencyPolicy:{p__dependency:'verified_pass'}}];
 assert.deepEqual(validate(tasks,{map:{}}),{ok:false,error:'ADDITIVE_DEPENDENCY_POLICY_CONFLICT',taskId:'p__dependency'});
});
test('caller dependencies must be exact existing stable IDs before original alias resolution',()=>{
 for(const dependency of ['dependency','foreign__dependency','missing']){
  const result=validate([{id:'new',title:'New',dependencies:[dependency]}]);
  assert.equal(result.ok,false);assert.equal(result.error,'ADDITIVE_DEPENDENCY_ID_REQUIRED');
 }
});
test('actual original composite expansion internal edges are allowed and counted',()=>{
 assert.equal(validate([{id:'report',title:'Report',assignedAgent:'writer',composite:true,dependencies:['p__dependency']}]).ok,true);
 const old=Array.from({length:197},(_,i)=>({id:'p__old-'+i,localTaskId:'old-'+i,projectId:'p',title:'Old',dependencies:[]}));
 assert.equal(validate([{id:'report',title:'Report',assignedAgent:'writer',composite:true}],{old,map:{}}).error,'ADDITIVE_TASK_LIMIT_EXCEEDED');
});
test('the complete old policy map remains validated even when no new task declares a policy',()=>{
 assert.equal(validate([{id:'new',title:'New'}],{map:{p__dependency:'unknown'}}).error,'ADDITIVE_POLICY_BASE_UNVERIFIED');
 assert.equal(validate([{id:'new',title:'New'}],{map:{foreign__task:'completed'}}).error,'ADDITIVE_POLICY_BASE_UNVERIFIED');
});

for(const kind of ['null','date','getter','proxy'])test(`unknown old policy map ${kind} rejects without invoking hooks`,()=>{
 let hooks=0;const getter={};Object.defineProperty(getter,'p__dependency',{enumerable:true,get(){hooks++;return 'verified_pass';}});
 const proxy=new Proxy({p__dependency:'verified_pass'},{ownKeys(){hooks++;return ['p__dependency'];}});
 const map={null:null,date:new Date(),getter,proxy}[kind];const result=validate([{id:'new',title:'New'}],{map});
 assert.equal(result.ok,false);assert.equal(result.error,'ADDITIVE_POLICY_BASE_UNVERIFIED');assert.equal(hooks,0);
});
test('a fixed plan union uses actual original expanded local references while preserving global old policies',()=>{
 assert.equal(typeof policies.validateTaskPlanUnionPolicies,'function');
 const inputs=[{id:'plan-a',title:'First planned task',dependencies:['p__dependency']},{id:'plan-b',title:'Second planned task',dependencies:['plan-a'],dependencyPolicy:{'plan-a':'verified_pass'}}];
 const expanded=expandCompositeTasks(inputs,{projectId:'p',poAgent:'po',members:['writer','reviewer']});assert.equal(expanded.ok,true);
 const preview=normalizeTasksForProject('p',expanded.tasks,existing);assert.equal(preview.ok,true);
 const normalized=policies.normalizeTaskGraphPolicies({originalTaskList:inputs,identityPreviewTasks:preview.tasks});assert.equal(normalized.ok,true);
 assert.deepEqual(policies.validateTaskPlanUnionPolicies({projectId:'p',existingTasks:existing,originalTaskList:inputs,expandedTaskInputs:expanded.tasks,identityPreviewTasks:preview.tasks,dependencyPolicies:{p__dependency:'verified_pass'},policyWrites:normalized.policyWrites}),{ok:true,policyDelta:[['p__plan-a','verified_pass']]});
 const conflict=[{id:'plan-a',title:'Conflict',dependencies:['p__dependency'],dependencyPolicy:{p__dependency:'completed'}}],expandedConflict=expandCompositeTasks(conflict,{projectId:'p',poAgent:'po',members:[]}),previewConflict=normalizeTasksForProject('p',expandedConflict.tasks,existing),normalizedConflict=policies.normalizeTaskGraphPolicies({originalTaskList:conflict,identityPreviewTasks:previewConflict.tasks});
 assert.equal(policies.validateTaskPlanUnionPolicies({projectId:'p',existingTasks:existing,originalTaskList:conflict,expandedTaskInputs:expandedConflict.tasks,identityPreviewTasks:previewConflict.tasks,dependencyPolicies:{p__dependency:'verified_pass'},policyWrites:normalizedConflict.policyWrites}).error,'ADDITIVE_DEPENDENCY_POLICY_CONFLICT');
});

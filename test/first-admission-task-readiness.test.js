import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as boards from '../src/core/task-board.js';
import {taskDependencyGateView,firstAdmitTaskDependencyContext} from '../src/core/task-dependency-gate-context.js';
const context=()=>({dependencyPolicies:{},gateEvaluationsByTaskId:{},consumedArtifactIdsByDependencyTaskId:{},currentGateFactsByTaskId:{},schemaV2:true});
function fixture(){const board=boards.createTaskBoard('first-admission');assert.equal(board.addTasksChecked([{id:'one',title:'Original task',assignedAgent:'worker'}]).ok,true);return{board,task:board.getTask('one')};}
function read(board,id,gate=context()){assert.equal(typeof boards.readOriginalTaskBoardFirstAdmitReadiness,'function');return boards.readOriginalTaskBoardFirstAdmitReadiness(board,id,gate);}
test('first-admit readiness is original private task data and never public method output',()=>{
 const {board,task}=fixture(),copy={...board};let getters=0;Object.defineProperty(board,'getDispatchable',{get(){getters++;throw Error('forbidden public dispatch lookup');}});Object.defineProperty(board,'getAllTasks',{get(){getters++;throw Error('forbidden public snapshot lookup');}});
 const r=read(board,task.id);assert.equal(r.ok,true);assert.equal(r.taskId,task.id);assert.equal(getters,0);assert.equal(Object.isFrozen(r),true);
 assert.throws(()=>read(copy,task.id));assert.throws(()=>read(new Proxy(board,{}),task.id));assert.equal(getters,0);
});
test('first-admit readiness rejects nonpending, composite, unresolved, run, lease and backoff residue',()=>{
 for(const [field,value] of [['status','cancelled'],['status','blocked'],['status','in_progress'],['status','done'],['isCompositeParent',true],['unresolvedDependencies',['missing']],['activeRunId','old-run'],['activeRunId',false],['runLease',{}],['runLease',0],['retryNotBefore',Date.now()+60_000],['retryNotBefore','not-a-time']]){
  const {board,task}=fixture();task[field]=value;assert.equal(read(board,task.id).ok,false,field+' '+String(value));
 }
 const {board,task}=fixture();assert.equal(read(board,task.id,{}).ok,false);assert.equal(read(board,task.id,{...context(),schemaV2:undefined}).ok,false);
});
test('first-admit readiness retains the original completed dependency gate',()=>{
 const board=boards.createTaskBoard('first-admission');assert.equal(board.addTasksChecked([{id:'up',title:'Dependency',assignedAgent:'worker'},{id:'down',title:'Consumer',assignedAgent:'worker',dependencies:['up']}]).ok,true);const up=board.getTask('up'),down=board.getTask('down');
 const gate={...context(),dependencyPolicies:{[up.id]:'completed'}};assert.equal(read(board,down.id,gate).ok,false);up.status='done';assert.equal(read(board,down.id,gate).ok,true);assert.equal(read(board,down.id).ok,false);
});
test('first-admit private membership and task reads ignore late WeakMap and Map get hooks',()=>{
 const {board,task}=fixture(),weak=WeakMap.prototype.get,map=Map.prototype.get;let hooks=0,result;
 try{WeakMap.prototype.get=function(){hooks++;return undefined;};Map.prototype.get=function(){hooks++;return undefined;};result=read(board,task.id);}finally{WeakMap.prototype.get=weak;Map.prototype.get=map;}
 assert.equal(result.ok,true);assert.equal(hooks,0);
});
test('legacy dispatch skips ineligible tasks before reading their dependency payload',()=>{
 for(const [field,value] of [['status','cancelled'],['isCompositeParent',true],['unresolvedDependencies',['unknown']]]){
  const {board,task}=fixture();task[field]=value;let reads=0;Object.defineProperty(task,'dependencies',{get(){reads++;throw Error('ineligible dependency getter');}});assert.deepEqual(board.getDispatchable(),[]);assert.equal(reads,0);
 }
});
test('legacy dispatch captures its configured gate context once per original call',()=>{
 const {board}=fixture();board.addTasksChecked([{id:'two',title:'Second original task',assignedAgent:'worker'}]);let reads=0;
 const gate=Object.defineProperty({},'schemaV2',{get(){reads++;return true;}});assert.equal(board.getDispatchable(gate).length,2);assert.equal(reads,1);
 const empty=boards.createTaskBoard('empty');reads=0;assert.deepEqual(empty.getDispatchable(gate),[]);assert.equal(reads,1);
});
function verifiedFixture(){
 const board=boards.createTaskBoard('verified-admission');
 assert.equal(board.addTasksChecked([{id:'review',title:'Review',assignedAgent:'worker'},{id:'consumer',title:'Consume',assignedAgent:'worker',dependencies:['review']}]).ok,true);
 const dependency=board.getTask('review'),task=board.getTask('consumer');dependency.status='done';
 const evaluation={schemaVersion:'gate-evaluation-v1',sourceArtifactId:'evaluation',sourceArtifactSha256:'evaluation-hash',sourceRunId:'current-run',subjectArtifacts:[{artifactId:'result',sha256:'result-hash'}],verdict:'passed',reasonCode:'verified',findingIds:[],conditionIds:[],evaluator:{participantId:'reviewer',role:'independent_reviewer',independence:'independent'},createdAt:'2026-09-01T00:00:00.000Z'};
 const gate={...context(),dependencyPolicies:{[dependency.id]:'verified_pass'},gateEvaluationsByTaskId:{[dependency.id]:[evaluation]},consumedArtifactIdsByDependencyTaskId:{[dependency.id]:['result']},currentGateFactsByTaskId:{[dependency.id]:{sourceRunId:'current-run',evaluationSourceArtifact:{artifactId:'evaluation',sha256:'evaluation-hash'},canonicalArtifacts:[{taskId:dependency.id,artifactId:'result',sha256:'result-hash'}]}}};
 return{board,task,dependency,evaluation,gate};
}
test('first-admit verified-pass uses actual current evaluation and consumed artifact coverage',()=>{
 const {board,task,gate}=verifiedFixture();assert.equal(read(board,task.id,gate).ok,true);
 const changes=[
  f=>delete f.gate.dependencyPolicies[f.dependency.id],
  f=>delete f.gate.consumedArtifactIdsByDependencyTaskId[f.dependency.id],
  f=>f.gate.consumedArtifactIdsByDependencyTaskId[f.dependency.id]=['unreviewed'],
  f=>delete f.gate.currentGateFactsByTaskId[f.dependency.id],
  f=>f.evaluation.sourceRunId='old-run',
  f=>f.evaluation.sourceArtifactSha256='old-hash',
  f=>f.evaluation.subjectArtifacts[0].sha256='old-result',
  f=>f.evaluation.evaluator.independence='degraded',
  f=>f.gate.gateEvaluationsByTaskId[f.dependency.id]=[],
 ];
 for(const change of changes){const f=verifiedFixture();change(f);const result=read(f.board,f.task.id,f.gate);assert.equal(result.ok,false);assert.equal(result.blockedDependencies.length,1);assert.equal(Object.isFrozen(result.blockedDependencies[0]),true);}
});
test('first-admit backoff uses its original clock and malformed data cannot bypass it',()=>{
 const {board,task}=fixture();task.retryNotBefore=Date.now()+60_000;
 const original=Date.now;let hooks=0,result;
 try{Date.now=()=>{hooks++;return Number.MAX_SAFE_INTEGER;};result=read(board,task.id);}finally{Date.now=original;}
 assert.equal(result.ok,false);assert.equal(result.reason,'retry_backoff');assert.equal(hooks,0);
 task.retryNotBefore=Date.now()-1;assert.equal(read(board,task.id).ok,true);
 for(const malformed of [NaN,Infinity,-1,false,'0']){task.retryNotBefore=malformed;assert.equal(read(board,task.id).ok,false);}
});
test('first-admit closed inputs reject accessors, missing canonical dependencies and malformed contexts',()=>{
 const {board,task,gate}=verifiedFixture();let getters=0;
 const unsafe=Object.defineProperty({...gate},'schemaV2',{enumerable:true,get(){getters++;return true;}});
 assert.equal(read(board,task.id,unsafe).ok,false);assert.equal(getters,0);
 assert.equal(read(board,'consumer',gate).ok,false);
 task.dependencies=['missing-canonical-id'];assert.equal(read(board,task.id,gate).ok,false);
 for(const key of ['dependencyPolicies','gateEvaluationsByTaskId','consumedArtifactIdsByDependencyTaskId','currentGateFactsByTaskId'])assert.equal(read(board,task.id,{...gate,[key]:[]}).ok,false);
});
test('the shared original gate view binds run freshness and selects consumption for this downstream task',()=>{
 const {board,task,dependency,gate}=verifiedFixture();dependency.lastRunLease={runId:'current-run'};
 task.consumedArtifactIdsByDependencyTaskId=gate.consumedArtifactIdsByDependencyTaskId;
 assert.equal(board.addTasksChecked([{id:'other',title:'Other consumer',assignedAgent:'worker',dependencies:['review']}]).ok,true);
 const other=board.getTask('other');other.consumedArtifactIdsByDependencyTaskId={[dependency.id]:['unreviewed']};
 const project={executionGateSchemaVersion:2,dependencyPolicies:gate.dependencyPolicies,gateEvaluations:gate.gateEvaluationsByTaskId,currentGateFacts:gate.currentGateFactsByTaskId};
 const selected=()=>firstAdmitTaskDependencyContext(project,boards.readTaskBoardSnapshot(board),task.id);
 assert.equal(read(board,task.id,selected().context).ok,true);
 assert.equal(read(board,other.id,firstAdmitTaskDependencyContext(project,boards.readTaskBoardSnapshot(board),other.id).context).ok,false);
 dependency.lastRunLease.runId='new-run';assert.equal(read(board,task.id,selected().context).ok,false);
 delete dependency.lastRunLease;dependency.recoveredRunId='current-run';assert.equal(read(board,task.id,selected().context).ok,true);
 delete dependency.recoveredRunId;assert.equal(read(board,task.id,selected().context).ok,false);
});
test('unknown gate schemas are unsupported only for first admission while the legacy dispatch projection stays compatible',()=>{
 const {board,task}=fixture(),tasks=boards.readTaskBoardSnapshot(board);
 for(const version of [undefined,1,2])assert.equal(firstAdmitTaskDependencyContext({executionGateSchemaVersion:version},tasks,task.id).ok,true);
 for(const version of [0,3,null,'2',false]){const project={executionGateSchemaVersion:version};assert.equal(firstAdmitTaskDependencyContext(project,tasks,task.id).error,'DURABLE_DISPATCH_GATE_SCHEMA_UNSUPPORTED');assert.equal(taskDependencyGateView(project,tasks).schemaV2,false);}
});
test('shared gate projection never supplies missing facts or schemas through inherited getters',()=>{
 const {board,task}=fixture(),tasks=boards.readTaskBoardSnapshot(board);let reads=0,result;
 const keys=['executionGateSchemaVersion','currentGateFacts','lastRunLease','recoveredRunId','consumedArtifactIdsByDependencyTaskId'];
 try{
  for(const key of keys)Object.defineProperty(Object.prototype,key,{configurable:true,get(){reads++;throw Error('inherited gate fact');}});
  result=firstAdmitTaskDependencyContext({},tasks,task.id);
 }finally{for(const key of keys)delete Object.prototype[key];}
 assert.equal(result.ok,true);assert.equal(result.context.schemaV2,false);assert.equal(reads,0);
});
test('private readiness does not invoke an inherited optional composite flag getter',()=>{
 const {board,task}=fixture();let reads=0,result,error;
 try{Object.defineProperty(Object.prototype,'isCompositeParent',{configurable:true,get(){reads++;throw Error('optional composite getter');}});try{result=read(board,task.id);}catch(cause){error=cause;}}finally{delete Object.prototype.isCompositeParent;}
 assert.equal(reads,0);assert.equal(error,undefined);assert.equal(result.ok,true);
});

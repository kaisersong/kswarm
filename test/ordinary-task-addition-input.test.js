import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../src/core/initial-plan-semantic-schema.js';
function read(value){assert.equal(typeof schema.readOrdinaryTaskAdditionInput,'function','strict task addition must share the original task-input parser');return schema.readOrdinaryTaskAdditionInput(value);}
test('task addition parses original input fields without inventing a plan or allowing caller task identities',()=>{
 const tasks=[{title:'Review',brief:'Review original artifact',dependencies:['p__source'],dependencyPolicy:{p__source:'verified_pass'},requiredCapabilities:['writing'],composite:true,reviewAgent:'reviewer'}];
 assert.deepEqual(read(tasks),tasks);
 for(const key of ['id','projectId','localTaskId','displayTaskId','legacyTaskId','planItemId','status','activeRunId','runLease','assignedExecutor','result','createdAt','executionStarted','qualified','candidateWorkspace','toJSON'])assert.throws(()=>read([{title:'Task',[key]:key==='toJSON'?()=>({title:'forged'}):'forged'}]),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('strict original task input rejects hooks, proxies and sparse arrays without running user code',()=>{
 let hooks=0;const task={title:'Task'};Object.defineProperty(task,'brief',{enumerable:true,get(){hooks++;return 'injected';}});
 const proxy=new Proxy({title:'Task'},{ownKeys(){hooks++;return ['title'];}});
 const json={title:'Task',toJSON(){hooks++;return {title:'forged'};}};
 const sparse=[];sparse[1]={title:'Task'};
 for(const value of [[task],[proxy],[json],sparse])assert.throws(()=>read(value),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
 assert.equal(hooks,0);
});
test('task addition is bounded at 200 raw inputs and rejects invalid original field types',()=>{
 assert.equal(read(Array.from({length:200},()=>({title:'Task'}))).length,200);
 assert.throws(()=>read(Array.from({length:201},()=>({title:'Task'}))),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
 for(const item of [{title:1},{title:'Task',maxAttempts:0},{title:'Task',dependencies:'p__source'},{title:'Task',dependencyPolicy:{p__source:'caller-policy'}},{title:'Task',brief:'a'.repeat(8388609)}])assert.throws(()=>read([item]),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('the v1 candidate task parser keeps its original fields and normalized output',()=>{
 const candidate={plan:{name:'Original',phases:[{id:'phase',items:[{id:'task',title:'Task',status:'pending'}]}]},tasks:[{id:'task',title:'Task',planItemId:'task',phaseId:'phase',assignedAgent:null,dependencies:[]}]};
 assert.deepEqual(schema.readInitialPlanCandidateInput(candidate),candidate);
});
test('new data-reader missing roots remain typed schema denials after encoded budget checks',()=>{
 for(const read of [schema.readOrdinaryTaskAdditionInput,schema.readOrdinaryTaskDependencyPolicies,schema.readTaskAdditionTransitionInput,schema.readTaskAdditionSemanticProof,schema.readTaskAdditionReverseInput,schema.readTaskAdditionProofChainInput,schema.readCanonicalTaskAdditionSemantic])assert.throws(()=>read(undefined),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('the internal metadata envelope is closed, source-bound data and never a caller-selected contract',()=>{
 assert.equal(typeof schema.readOrdinaryTaskMetadataEnvelope,'function');
 const base={action:'add_task',expectedProjectRevision:1,sourceMessageId:'main-user-message:'+'a'.repeat(64),body:'Original user input'};
 assert.deepEqual(schema.readOrdinaryTaskMetadataEnvelope({...base,tasks:[{title:'Task',dependencies:['p__old']}]}),{...base,tasks:[{title:'Task',dependencies:['p__old']}]});
 assert.deepEqual(schema.readOrdinaryTaskMetadataEnvelope({...base,title:'Room task',brief:''}),{...base,title:'Room task',brief:''});
 for(const extra of [{contract:'ordinary_initial_plan_additive_v2'},{qualified:true},{tasks:[{id:'caller-id',title:'Task'}]},{title:'Ambiguous',tasks:[{title:'Task'}]},{taskReceipt:{}},{beforeEffects:()=>{}},{requestSource:'user'}])assert.throws(()=>schema.readOrdinaryTaskMetadataEnvelope({...base,...extra}),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('the new owner-record kind registry cannot inherit Object prototype functions',()=>{
 for(const kind of ['toString','valueOf','__proto__','future_record'])assert.throws(()=>schema.readTaskAdditionOwnerRecord({kind}),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('the v2 original claim data is closed and contains no caller trigger or permission flag',()=>{
 assert.equal(typeof schema.readTaskInitialClaimInput,'function');
 const input={protocol:'ordinary_initial_plan_additive_v2',fromAgent:'po',enqueueKey:'initial-plan:'+'a'.repeat(64),planRunId:'main-run',planGeneration:1,expectedPlanInputRevision:0,expectedProjectControlDigest:'b'.repeat(64),startPolicy:'plan_only'};
 assert.deepEqual(schema.readTaskInitialClaimInput(input),input);
 for(const extra of [{trigger:'explicit_user_start'},{qualified:true},{taskIds:[]},{prepared:{}},{body:'must not be permanent claim data'}])assert.throws(()=>schema.readTaskInitialClaimInput({...input,...extra}),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});

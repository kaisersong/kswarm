import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHub} from '../src/core/hub.js';
import {readInitialPlanSemanticSnapshot} from '../src/core/initial-plan-semantic-schema.js';
const relatedNames=['workflowRuns','workflowProposals','finalDeliverables','reviewGateDecisions','reviewConditions'];
function fixture(){
 let saved;const hub=createHub({silent:true,persistence:{load:()=>null,save(build,scope){saved=structuredClone(build(scope).full());}}});
 hub.createProject({id:'p',name:'真实项目',goal:'本周公开信息调研，至少3条来源，给管理层汇报',poAgent:'po',members:['writer','reviewer'],requestedStartPolicy:'plan_only',autoAssignPo:false});
 const snapshot=()=>readInitialPlanSemanticSnapshot({project:hub.getProject('p'),tasks:hub.getBoard('p').getAllTasks(),related:Object.fromEntries(relatedNames.map(name=>[name,saved[name].filter(row=>row.projectId==='p')]))});
 return {hub,snapshot,get saved(){return saved;}};
}
test('actual factory quality compiler and original graph outputs parse, optional undefined survives JSON reopen',()=>{
 const f=fixture();const before=f.snapshot();assert.match(before.digest,/^[a-f0-9]{64}$/);
 const p=f.hub.getProject('p');const restored=JSON.parse(JSON.stringify(p));
 assert.equal(readInitialPlanSemanticSnapshot({project:restored,tasks:[],related:Object.fromEntries(relatedNames.map(name=>[name,[]]))}).digest,before.digest);
 for(const task of [{id:'write',title:'完成文稿',brief:'写报告'},{id:'research',title:'搜索近期官网来源',brief:'给出来源证据'},{id:'review',title:'独立评审报告',brief:'输出评审报告'}])assert.equal(f.hub.handleHumanAddTasks('p',[task],{requestSource:'user'}).ok,true);
 assert.equal(f.snapshot().semantic.tasks.length,3);
});
test('unknown top/nested keys including undefined fail before hash; data-map values remain in digest',()=>{
 for(const mutate of [p=>{p.unknownSecurity=undefined;},p=>{p.agentSelection.poAgent.extra=undefined;},p=>{p.qualityRuleSet.requestSignals.newControl=true;},p=>{p.qualityRuleSet.rules[0].promptExcerpt.extra='new role';}]){
  const f=fixture();mutate(f.hub.getProject('p'));assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);
 }
 const f=fixture(),before=f.snapshot();f.hub.getProject('p').qualityRuleSet.rules[0].metadata.userData='not ignored';assert.notEqual(f.snapshot().digest,before.digest);
});
test('accessor, Proxy, symbol, sparse array and nonfinite data reject without executing getter',()=>{
 let calls=0;
 for(const mutate of [p=>Object.defineProperty(p,'goal',{enumerable:true,get(){calls++;return 'g';}}),p=>{p.members=new Proxy([],{get(){calls++;throw Error('trap');}});},p=>{p[Symbol('control')]=true;},p=>{p.members=new Array(2);},p=>{p.createdAt=NaN;}]){
  const f=fixture();mutate(f.hub.getProject('p'));assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);
 }
 assert.equal(calls,0);
});
test('every existing task input and null physical state is in semantic proof',()=>{
 const f=fixture();assert.equal(f.hub.handleHumanAddTasks('p',[{id:'write',title:'文稿',brief:'body'}],{requestSource:'user'}).ok,true);
 const before=f.snapshot(),task=f.hub.getBoard('p').getAllTasks()[0];task.brief='mutated without revision';assert.notEqual(f.snapshot().digest,before.digest);
 task.runLease={id:'unproven-lease'};assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('actual composite expander output passes closed task shape',()=>{
 const f=fixture();const result=f.hub.handleHumanAddTasks('p',[{id:'report',title:'报告',brief:'输出HTML',assignedAgent:'writer',reviewAgent:'reviewer',composite:true}],{requestSource:'user'});
 assert.equal(result.ok,true);assert.equal(f.snapshot().semantic.tasks.length,4);
});
test('actual Room creation and original publication ACK preserve semantic payload while payload changes do not',async()=>{
 let saved;const hub=createHub({silent:true,persistence:{load:()=>null,save(build,scope){saved=structuredClone(build(scope).full());}},brokerClient:{
  async getRoomSnapshot(){return {ok:true,room:{status:'active'},messages:[{messageId:'m'}],members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){return {ok:true};},async publishRoomProjectEvent(){return {ok:true};}}});
 await hub.createProject({id:'roomp',name:'Room',goal:'goal',poAgent:'po',members:[],primaryRoomId:'r',sourceMessageIds:['m'],linkedBy:{kind:'user',userId:'user.local'},autoAssignPo:false,requestedStartPolicy:'plan_only'},{requestSource:'user'});
 const read=()=>readInitialPlanSemanticSnapshot({project:hub.getProject('roomp'),tasks:hub.getBoard('roomp').getAllTasks(),related:Object.fromEntries(relatedNames.map(name=>[name,saved[name]]))});
 const before=read();await hub.flushRoomEventOutbox();const after=read();assert.equal(after.digest,before.digest);assert.notDeepEqual(after.projection,before.projection);
 hub.getProject('roomp').roomEventOutbox[0].summary='swapped payload';assert.notEqual(read().digest,before.digest);
});
test('actual activity projection is checked; changed business fact cannot hide inside it',()=>{
 const f=fixture(),before=f.snapshot();f.hub.persistState();assert.equal(f.snapshot().digest,before.digest);
 f.hub.getProject('p').activitySnapshot.newPermission=true;assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('explicitly unknown delivery metadata stays opaque display data without changing original business proof',()=>{
 const f=fixture(),before=f.snapshot().digest,project=f.hub.getProject('p');project.activityDeliveryUnavailable=true;project.activityDeliveryHead={schemaVersion:99,unknownShape:{retainedBody:'Original future display bytes'}};
 assert.equal(f.snapshot().digest,before);project.activityDeliveryHead=null;assert.equal(f.snapshot().digest,before);
 project.activityDeliveryUnavailable=false;assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('the unknown delivery branch retains original descriptor-safe JSON and business-field validation',()=>{
 const f=fixture(),project=f.hub.getProject('p');project.activityDeliveryUnavailable=true;let calls=0;project.activityDeliveryHead={};Object.defineProperty(project.activityDeliveryHead,'payload',{enumerable:true,get(){calls++;return 'Never invoke';}});assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);assert.equal(calls,0);
 project.activityDeliveryHead={schemaVersion:99};project.unknownBusinessPermission=true;assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('related entity absence is explicit and nonempty control collections are unsupported',()=>{
 const f=fixture();for(const name of relatedNames){const related=Object.fromEntries(relatedNames.map(n=>[n,[]]));related[name]=[{id:'unmapped-control',projectId:'p'}];assert.throws(()=>readInitialPlanSemanticSnapshot({project:f.hub.getProject('p'),tasks:[],related}),/INITIAL_PLAN_SEMANTIC_SCHEMA/);}
 assert.throws(()=>readInitialPlanSemanticSnapshot({project:f.hub.getProject('p'),tasks:[],related:{}}),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('nonenumerable business keys cannot qualify bytes that original JSON persistence would omit',()=>{
 const f=fixture();Object.defineProperty(f.hub.getProject('p'),'goal',{value:'hidden',enumerable:false});assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('raw bounded preflight rejects cycles and excessive data before building semantic output',()=>{
 for(const make of [()=>{const x={};x.self=x;return x;},()=>({huge:'x'.repeat(8388609)})]){
  const f=fixture();f.hub.getProject('p').qualityRuleSet.rules[0].metadata=make();assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);
 }
});
test('all actual owner project execution modes parse exactly, invented workflow value does not',()=>{
 for(const mode of ['direct','auto','workflow_preferred']){
  let project;const hub=createHub({silent:true,persistence:{load:()=>null,save(build,scope){project=build(scope).full().projects[0];}}});
  hub.createProject({id:'p',name:'p',goal:'g',poAgent:'po',members:[],autoAssignPo:false,executionMode:mode});
  assert.equal(project.executionMode,mode);assert.equal(readInitialPlanSemanticSnapshot({project,tasks:[],related:Object.fromEntries(relatedNames.map(name=>[name,[]]))}).semantic.project.executionMode,mode);
 }
 const f=fixture();f.hub.getProject('p').executionMode='workflow';assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('unknown or missing activity watermark cannot become a verified unchanged projection',()=>{
 for(const mutate of [p=>{delete p.committedActivitySeq;},p=>{delete p.activityEventSeq;p.activityEventOutbox=[];p.activityGapRanges=[];},p=>{p.committedActivitySeq=p.activityEventSeq+1;},p=>{p.activityDataEpoch='invalid';}]){
  const f=fixture();mutate(f.hub.getProject('p'));assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);
 }
});
test('original activity event must retain its actual epoch association',()=>{
 const f=fixture();delete f.hub.getProject('p').activityEventOutbox[0].sourceDataEpoch;assert.throws(f.snapshot,/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});

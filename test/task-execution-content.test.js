import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTaskHandoffPackage} from '../src/core/handoff-package.js';
import {captureExecutionData,taskHandoffContent,taskBusinessContentDigest} from '../src/core/task-execution-content.js';
import {protocolDigest} from '../src/core/project-protocol.js';
const project={id:'p',name:'P',goal:'actual goal',requirements:'actual requirements'};
const task={id:'p__a',title:'Task',brief:'Original brief',requiredOutputs:['html',{type:'markdown'},'html']};
test('complete execution data ignores replaced array transforms without dropping source fields',()=>{
 const original=Array.prototype.filter;let called=0,result;
 Array.prototype.filter=function(callback,thisArg){if(this.includes('members')){called++;return Reflect.apply(original,this,[key=>key!=='members']);}return Reflect.apply(original,this,[callback,thisArg]);};
 try{result=captureExecutionData({members:['worker'],id:'p'});}finally{Array.prototype.filter=original;}
 assert.deepEqual(result,{id:'p',members:['worker']});assert.equal(called,0);
});
test('snapshot and protocol digests preserve original golden JSON and scalar output normalization',()=>{
 const values=[{b:undefined,a:1,z:[undefined,NaN,-0,null]},JSON.parse('{"__proto__":{"safe":true},"z":"中文\\n","a":{"b":2,"a":1}}'),new Date('2026-11-05T00:00:00.000Z')];
 assert.deepEqual(values.map(protocolDigest),['71fe8ec82fe39b3cc3f01e49597e520b88829951ca378a53ad037d6dce23c206','409581e40cb6c7ce62d33ec6fd87ee48947231a46b64dcb4926bdfd35b16c2ec','b929375bb627077afacab60d2b72d635b52ab344160a2bfdc4812769f0e120be']);
 assert.equal(JSON.stringify(captureExecutionData({z:undefined,a:[undefined,null,'x'],nested:JSON.parse('{"__proto__":"own","a":1}')})),'{"a":[null,null,"x"],"nested":{"__proto__":"own","a":1}}');
 const outputs=[' html ','html',{type:'markdown'},{format:'json'},{kind:2},{mimeType:true},{type:{a:1}},{type:[1,null,['x','y']]},null,false];assert.deepEqual(taskHandoffContent({id:'p'},{id:'t',requiredOutputs:outputs}).task.requiredOutputs,['html','markdown','json','2','true','[object Object]','1,,x,y']);
});
test('business output normalization does not invoke a replaced data-array iterator',()=>{
 const original=Array.prototype[Symbol.iterator];let invoked=0,result;
 Array.prototype[Symbol.iterator]=function(){if(this.includes('html')){invoked++;return Reflect.apply(original,[],[]);}return Reflect.apply(original,this,[]);};
 try{result=taskHandoffContent({id:'p'},{id:'t',requiredOutputs:['html','markdown']}).task.requiredOutputs;}finally{Array.prototype[Symbol.iterator]=original;}
 assert.deepEqual(result,['html','markdown']);assert.equal(invoked,0);
});
test('canonical protocol ordering does not call a replaced key-array map or sort',()=>{
 const map=Array.prototype.map,sort=Array.prototype.sort,filter=Array.prototype.filter;let mapCalls=0,sortCalls=0,result;
 const expected=protocolDigest({id:'p',members:['worker']});
 Array.prototype.map=function(callback,thisArg){if(this.includes('members')){mapCalls++;return Reflect.apply(map,Reflect.apply(filter,this,[key=>key!=='members']),[callback,thisArg]);}return Reflect.apply(map,this,[callback,thisArg]);};
 Array.prototype.sort=function(...args){sortCalls++;return this;};
 try{result=protocolDigest({members:['worker'],id:'p'});}finally{Array.prototype.map=map;Array.prototype.sort=sort;}
 assert.equal(result,expected);assert.equal(mapCalls,0);assert.equal(sortCalls,0);
});
test('actual handoff and business snapshot share exact consumed project/task content',t=>{
 const root=mkdtempSync(join(tmpdir(),'handoff-content-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const result=createTaskHandoffPackage({projectRoot:root,project,task,runId:'run-1',targetParticipantId:'worker'});assert.equal(result.ok,true);assert.deepEqual({project:result.handoff.project,task:result.handoff.task},taskHandoffContent(project,task));assert.deepEqual(result.handoff.task.requiredOutputs,['html','markdown']);
});
test('unconsumed old project/task transport bodies cannot exhaust the actual handoff content budget',t=>{
 const root=mkdtempSync(join(tmpdir(),'handoff-content-old-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const large='x'.repeat(8388609),p={...project,oldDiagnosticBody:large},input={...task,runTelemetry:{stdout:large}};assert.equal(createTaskHandoffPackage({projectRoot:root,project:p,task:input,runId:'run-1'}).ok,true);assert.equal(taskBusinessContentDigest(p,input),taskBusinessContentDigest(project,task));
});
test('run/attempt/transport claims do not change the business digest but real consumed content and business route do',()=>{
 const digest=taskBusinessContentDigest(project,task);assert.equal(taskBusinessContentDigest({...project,updatedAt:123},{...task,attempt:10,activeRunId:'another',workspaceContext:{claimId:'new'},updatedAt:456}),digest);
 for(const changed of [{...task,brief:'Different'},{...task,desiredRoute:{agent:'other'}},{...task,candidateRef:{id:'candidate'}}])assert.notEqual(taskBusinessContentDigest(project,changed),digest);assert.notEqual(taskBusinessContentDigest({...project,requirements:'changed'},task),digest);
});
test('selected getters/proxies/cycles are denied without invoking caller hooks or creating handoff directories',t=>{
 const root=mkdtempSync(join(tmpdir(),'handoff-content-hooks-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let invoked=0;const getter={...task};Object.defineProperty(getter,'brief',{enumerable:true,get(){invoked++;return'forged';}});const cyclic={};cyclic.self=cyclic;
 for(const input of [getter,new Proxy(task,{get(){invoked++;return'forged';}}),{...task,executionContract:cyclic}])assert.throws(()=>taskBusinessContentDigest(project,input),/DEFAULT_DISPATCH_CONTENT_UNAVAILABLE/);assert.equal(invoked,0);assert.throws(()=>createTaskHandoffPackage({projectRoot:root,project,task:getter,runId:'bad-run'}),/DEFAULT_DISPATCH_CONTENT_UNAVAILABLE/);assert.equal(existsSync(join(root,'handoffs')),false);
});
for(const prototype of [Object.prototype,Array.prototype])test('inherited serialization hook cannot rewrite the actual captured handoff or digest ('+(prototype===Object.prototype?'object':'array')+')',()=>{
 let calls=0,error;Object.defineProperty(prototype,'toJSON',{configurable:true,value(){calls++;return{};}});try{taskBusinessContentDigest(project,task);}catch(caught){error=caught;}finally{delete prototype.toJSON;}assert.match(error?.message??'',/DEFAULT_DISPATCH_CONTENT_UNAVAILABLE/);assert.equal(calls,0);
});

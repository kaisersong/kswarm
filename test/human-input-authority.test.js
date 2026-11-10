import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHub} from '../src/core/hub.js';
const task={title:'Follow-up',description:'Do this'};
function fixture(){
 const hub=createHub({silent:true});hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',autoAssignPo:false});return hub;
}
for(const context of [null,undefined,{requestSource:'agent'},{requestSource:'scheduler'},{}]){
 test('human input rejects absent or non-user context '+JSON.stringify(context),()=>{
  const hub=fixture();const before=structuredClone(hub.getProject('p'));
  assert.deepEqual(hub.handleHumanAddTasks('p',[task],context),{ok:false,error:'human_add_tasks_requires_user'});
  assert.equal(hub.getBoard('p').getAllTasks().length,0);assert.deepEqual(hub.getProject('p'),before);
 });
}
for(const status of ['delivered','closed']){
 test('human input cannot implicitly reopen '+status+' project',()=>{
  const hub=fixture();hub.getProject('p').status=status;const before=structuredClone(hub.getProject('p'));
  assert.deepEqual(hub.handleHumanAddTasks('p',[task],{requestSource:'user'}),{ok:false,error:'PROJECT_TERMINAL_REQUIRES_REOPEN'});
  assert.equal(hub.getBoard('p').getAllTasks().length,0);assert.deepEqual(hub.getProject('p'),before);
 });
}
test('authorized user can still append executable work to a live project',()=>{
 const hub=fixture();const result=hub.handleHumanAddTasks('p',[task],{requestSource:'user'});
 assert.equal(result.ok,true);assert.equal(hub.getBoard('p').getAllTasks().length,1);
});

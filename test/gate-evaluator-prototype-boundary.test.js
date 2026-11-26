import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateDependencySatisfaction} from '../src/core/gate-evaluator.js';
// The same original evaluator will be reused by the first-admit private
// kernel. These are data-policy tests, never Native admission/launch grants.
for(const hook of ['push','iterator'])test('the original dependency gate cannot lose blocked dependencies after a late Array '+hook+' hook',()=>{
 const input={task:{id:'consumer',dependencies:['dependency']},dependencyTasks:[{id:'dependency',status:'pending'}],schemaV2:false};
 assert.equal(evaluateDependencySatisfaction(input).ok,false);let result;
 if(hook==='push'){
  const prior=Array.prototype.push;
  try{Array.prototype.push=function(){return this.length;};result=evaluateDependencySatisfaction(input);}finally{Array.prototype.push=prior;}
 }else{
  const prior=Array.prototype[Symbol.iterator];
  try{Array.prototype[Symbol.iterator]=function(){return{next(){return{done:true};}};};result=evaluateDependencySatisfaction(input);}finally{Array.prototype[Symbol.iterator]=prior;}
 }
 assert.equal(result.ok,false);assert.deepEqual(result.blockedDependencies,[{dependencyTaskId:'dependency',reason:'dependency_not_completed'}]);
});
test('the original v2 gate does not borrow a missing policy from an inherited getter',()=>{
 const prior=Object.getOwnPropertyDescriptor(Object.prototype,'dependency');let reads=0,result;
 try{Object.defineProperty(Object.prototype,'dependency',{configurable:true,get(){reads++;return'completed';}});result=evaluateDependencySatisfaction({task:{id:'consumer',dependencies:['dependency']},dependencyTasks:[{id:'dependency',status:'done'}],schemaV2:true});}finally{if(prior)Object.defineProperty(Object.prototype,'dependency',prior);else delete Object.prototype.dependency;}
 assert.equal(reads,0);assert.equal(result.ok,false);assert.deepEqual(result.blockedDependencies,[{dependencyTaskId:'dependency',reason:'dependency_policy_missing'}]);
});

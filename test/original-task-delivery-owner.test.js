import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/recovery-execution-admission/fixture.js';
import {bindHubServerScheduler} from '../src/core/hub.js';
import {createServerTaskDeliveryOwner} from '../src/server/task-delivery-owner.js';
import {createOriginalTaskDeliveryOwner,readOriginalTaskDeliveryOwnerBirth,originalTaskDeliveryOwnerMatchesBinding} from '../src/core/original-task-delivery-owner.js';
function setup(t){const f=fixture(t),scheduler=bindHubServerScheduler(f.hub),context=Object.freeze({requestSource:'scheduler'});return{...f,scheduler,context,owner(binding){return createServerTaskDeliveryOwner({hub:f.hub,scheduler,context,originalConstructionBinding:binding,getBrokerClient:()=>null});}};}
test('the actual original Server factory has one real owner birth and preserves legacy unavailable delivery',async t=>{
 const f=setup(t),binding=f.scheduler.takeTaskDeliveryOwnerConstructionBinding(f.context),owner=f.owner(binding),birth=readOriginalTaskDeliveryOwnerBirth(owner);
 assert.equal(originalTaskDeliveryOwnerMatchesBinding(owner,binding),true);assert.equal(Object.hasOwn(birth,'constructionBinding'),false);assert.equal(Object.isFrozen(owner),true);assert.equal(Object.getPrototypeOf(owner),null);assert.equal(Object.isFrozen(birth.identity),true);
 assert.equal(f.scheduler.bindTaskDeliveryOwner(owner,f.context),undefined);assert.deepEqual(await owner.send('p',[f.task.id],f.context),{ok:false,error:'broker_unavailable'});
});
test('copies, proxies and a send-shaped object have no original owner birth before any getter',t=>{
 const f=setup(t),binding=f.scheduler.takeTaskDeliveryOwnerConstructionBinding(f.context),owner=f.owner(binding);let getters=0;
 const shaped=Object.defineProperty({},'send',{get(){getters++;throw Error('forbidden');}});
 for(const value of [shaped,{...owner},new Proxy(owner,{get(){getters++;throw Error('forbidden');}}),readOriginalTaskDeliveryOwnerBirth(owner).identity]){assert.equal(readOriginalTaskDeliveryOwnerBirth(value),undefined);assert.throws(()=>f.scheduler.bindTaskDeliveryOwner(value,f.context),/ORIGINAL_TASK_DELIVERY_OWNER_REQUIRED/);}
 assert.equal(getters,0);f.scheduler.bindTaskDeliveryOwner(owner,f.context);
});
test('a genuine birth with another binding and another owner cannot claim the original scheduler',t=>{
 const f=setup(t),binding=f.scheduler.takeTaskDeliveryOwnerConstructionBinding(f.context),owner=f.owner(binding),other=createOriginalTaskDeliveryOwner({constructionBinding:Object.freeze(Object.create(null)),legacySend:async()=>({ok:true})});
 assert.ok(readOriginalTaskDeliveryOwnerBirth(other));assert.throws(()=>f.scheduler.bindTaskDeliveryOwner(other,f.context),/ORIGINAL_TASK_DELIVERY_BINDING_REQUIRED/);
 assert.throws(()=>f.scheduler.bindTaskDeliveryOwner(owner,{...f.context}),/ORIGINAL_TASK_DELIVERY_BINDING_REQUIRED/);f.scheduler.bindTaskDeliveryOwner(owner,f.context);
 assert.throws(()=>f.scheduler.bindTaskDeliveryOwner(f.owner(binding),f.context),/ORIGINAL_TASK_DELIVERY_OWNER_BOUND/);assert.throws(()=>f.scheduler.takeTaskDeliveryOwnerConstructionBinding(f.context),/ORIGINAL_TASK_DELIVERY_BINDING_TAKEN/);
});
test('the preparation facet constructor closes exact own fields and rejects asynchronous or opaque callbacks before bodies',()=>{
 let getters=0,bodies=0;const binding=Object.freeze({}),legacySend=async()=>({ok:true}),asyncSend=(async function(){bodies++;}).bind(null);
 const accessor=Object.defineProperty({constructionBinding:binding,legacySend},'preparationSend',{enumerable:true,get(){getters++;throw Error('forbidden');}});
 for(const value of [accessor,{constructionBinding:binding,legacySend,extra:true},{constructionBinding:binding,legacySend,preparationSend:asyncSend},{constructionBinding:binding,legacySend,preparationSend:new Proxy(()=>{bodies++;},{apply(){bodies++;}})}])assert.throws(()=>createOriginalTaskDeliveryOwner(value),/CONSTRUCTION_REQUIRED/);
 assert.equal(getters,0);assert.equal(bodies,0);const legacy=createOriginalTaskDeliveryOwner({constructionBinding:binding,legacySend});assert.equal(Object.hasOwn(legacy,'startDefaultDispatchPreparation'),false);
});

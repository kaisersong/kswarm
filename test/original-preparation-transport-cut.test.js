import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import * as transport from '../src/core/original-preparation-transport.js';
import {createOriginalBrokerClient} from '../src/core/original-broker-client.js';
function fixture({fetchSdk,onConsume,onCurrent,purpose='prepare'}={}){
 assert.equal(typeof transport.createOriginalPreparationBrokerClient,'function');assert.equal(typeof transport.assertOriginalPreparationTransportCurrent,'function');
 let client,used=false;const proof=Object.freeze(Object.create(null)),posts=[];
 const source={resolve(candidate,actual){if(candidate!==proof||used)throw Error('original_transport_proof_required');assert.equal(actual,client);return{data:{purpose,messageId:'message',targetParticipantId:'host',taskId:'task',threadId:'thread',payload:{protocol:'ordinary_default_dispatch_runtime_v1',childKey:'controlled-child'}},assertCurrent(){onCurrent?.({client,proof,source});},consume(){if(used)throw Error('original_transport_proof_required');onConsume?.({client,proof,source});used=true;}};}};
 client=transport.createOriginalPreparationBrokerClient({preparationSource:source,fetchSdk:fetchSdk??(async(url,input)=>{posts.push({url,input});return new Response('{"ok":true}');}),httpBase:'http://controlled.invalid',participantId:'original-b',methods:{getParticipantId:()=> 'original-b'}});
 return{client,proof,source,posts,assertCut(){return transport.assertOriginalPreparationTransportCurrent(client,source,proof);}};
}
test('only the original lexical SDK-born client has a preparation call cut',async()=>{
 const f=fixture();assert.throws(()=>f.assertCut());let getters=0;
 const fake=Object.defineProperty({},'readCut',{get(){getters++;throw Error('forbidden');}});
 const constructionOnly=createOriginalBrokerClient({preparationSource:f.source,methods:{sendDefaultDispatchPreparation:async()=>({ok:true}),sealDefaultDispatchPreparations(){},drainDefaultDispatchPreparations:async()=>{}}});
 for(const client of [fake,{...f.client},constructionOnly])assert.throws(()=>transport.assertOriginalPreparationTransportCurrent(client,f.source,f.proof));
 assert.throws(()=>transport.assertOriginalPreparationTransportCurrent(f.client,{},f.proof));assert.equal(getters,0);assert.equal(f.posts.length,0);
 const sent=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');f.assertCut();await sent;f.assertCut();await f.client.drainDefaultDispatchPreparations();assert.throws(()=>f.assertCut());
});
test('the SDK-owning constructor closes raw fields before getters and never accepts a caller read-cut verifier',()=>{
 let getters=0,calls=0;const valid={preparationSource:null,fetchSdk(){calls++;},httpBase:'http://controlled.invalid',participantId:'b',methods:{}};
 const getter=Object.defineProperty({...valid},'methods',{enumerable:true,get(){getters++;throw Error('forbidden');}}),proxy=new Proxy(valid,{ownKeys(){getters++;throw Error('forbidden');},getOwnPropertyDescriptor(){getters++;throw Error('forbidden');}});
 for(const raw of [getter,proxy,{...valid,assertCut(){calls++;}}])assert.throws(()=>transport.createOriginalPreparationBrokerClient(raw));assert.equal(getters,0);assert.equal(calls,0);
});
test('consume and synchronous fetch reentry cannot claim a returned classified SDK raw',async()=>{
 let consumeDenied=0,fetchDenied=0,f;
 f=fixture({onConsume(){assert.throws(()=>f.assertCut());consumeDenied++;},fetchSdk(){assert.throws(()=>f.assertCut());fetchDenied++;return Promise.resolve(new Response('{"ok":true}'));}});
 const sent=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');f.assertCut();await sent;assert.equal(consumeDenied,1);assert.equal(fetchDenied,1);await f.client.drainDefaultDispatchPreparations();
});
test('the SDK cut does not wait for response body EOF and sealing still revokes it',async()=>{
 let release;const held=new Promise(yes=>{release=yes;});
 const f=fixture({fetchSdk:async()=>new Response(new ReadableStream({start(controller){held.then(()=>{controller.enqueue(new TextEncoder().encode('{"ok":true}'));controller.close();});}}))});
 const sent=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');await delay(5);f.assertCut();let drained=false;const closing=f.client.drainDefaultDispatchPreparations().then(()=>{drained=true;});
 try{assert.throws(()=>f.assertCut());await delay(10);assert.equal(drained,false);}finally{release();await sent;await closing;}
});
test('a returned unobservable SDK raw cannot qualify, invoke its getter, or drain healthy',async()=>{
 let getters=0;const raw=Object.defineProperty({},'then',{get(){getters++;throw Error('forbidden');}}),f=fixture({fetchSdk:()=>raw});
 await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),/SDK_UNCONFIRMED/);assert.throws(()=>f.assertCut());assert.equal(getters,0);await assert.rejects(f.client.drainDefaultDispatchPreparations(),/UNCONFIRMED/);
});
test('synchronous SDK failure preserves its cause and never produces a cut',async()=>{
 const original=Error('actual fetch throw'),f=fixture({fetchSdk(){throw original;}});
 await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),error=>error===original);assert.throws(()=>f.assertCut());await assert.rejects(f.client.drainDefaultDispatchPreparations(),error=>error.cause===original);
});
test('a later actual HTTP failure revokes only this call cut',async()=>{
 const f=fixture({fetchSdk:async()=>new Response('{"ok":false}',{status:403})});const sent=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');f.assertCut();await assert.rejects(sent,/HTTP_FAILED/);assert.throws(()=>f.assertCut());await f.client.drainDefaultDispatchPreparations();
});
test('a known negative HTTP status revokes the cut while its original body is still held',async()=>{
 let release;const held=new Promise(yes=>{release=yes;});
 const f=fixture({fetchSdk:async()=>new Response(new ReadableStream({start(controller){held.then(()=>{controller.enqueue(new TextEncoder().encode('{"ok":false}'));controller.close();});}}),{status:403})});
 const sent=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');
 try{await delay(5);assert.throws(()=>f.assertCut());}finally{release();await assert.rejects(sent,/HTTP_FAILED/);await f.client.drainDefaultDispatchPreparations();}
});
test('observe consumption cannot qualify prepare and a duplicate attempt cannot erase the first call fact',async()=>{
 const observer=fixture({purpose:'observe'});await observer.client.sendDefaultDispatchPreparation(observer.proof,'scheduler');assert.throws(()=>observer.assertCut());await observer.client.drainDefaultDispatchPreparations();
 const f=fixture();await f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');f.assertCut();await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),/original_transport_proof_required|DEFAULT_DISPATCH_TRANSPORT_PROOF_REQUIRED/);f.assertCut();assert.equal(f.posts.length,1);await f.client.drainDefaultDispatchPreparations();
});
test('a source reentry cannot let a second attempt steal the actual first SDK call',async()=>{
 let nested,reenter=true,currentCalls=0;
 const f=fixture({onCurrent({client,proof}){currentCalls++;if(reenter){reenter=false;nested=client.sendDefaultDispatchPreparation(proof,'scheduler');nested.catch(()=>{});}}});
 const first=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),results=await Promise.allSettled([first,nested]);
 try{assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(currentCalls,1);assert.equal(f.posts.length,1);f.assertCut();}finally{await f.client.drainDefaultDispatchPreparations();}
});

test('the original lane ignores later global Response replacement and keeps its constructor-born body consumer',async()=>{
 const {spawnSync}=await import('node:child_process');const target=new URL('../src/core/original-preparation-transport.js',import.meta.url).href;
 const script=`
 const transport=await import(${JSON.stringify(target)});
 const OriginalResponse=globalThis.Response,originalJson=OriginalResponse.prototype.json;
 let globalReads=0,bodyHooks=0,client,used=false;
 const response=new OriginalResponse('{"ok":true}'),proof=Object.freeze(Object.create(null));
 const source={resolve(value,actual){if(value!==proof||actual!==client||used)throw Error('original proof required');return{data:{purpose:'observe',messageId:'message',targetParticipantId:'host',taskId:'task',threadId:'thread',payload:{protocol:'ordinary_default_dispatch_runtime_v1'}},assertCurrent(){},consume(){used=true;}};}};
 Object.defineProperty(globalThis,'Response',{configurable:true,get(){globalReads++;throw Error('late global SDK');}});
 client=transport.createOriginalPreparationBrokerClient({preparationSource:source,fetchSdk:()=>Promise.resolve(response),httpBase:'http://controlled.invalid',participantId:'original-b',methods:{}});
 try{OriginalResponse.prototype.json=function(){bodyHooks++;throw Error('late body SDK');};const result=await client.sendDefaultDispatchPreparation(proof,'scheduler');if(!result.ok||globalReads||bodyHooks)throw Error('captured SDK replaced');await client.drainDefaultDispatchPreparations();}
 finally{OriginalResponse.prototype.json=originalJson;}
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});assert.equal(child.signal,null);assert.equal(child.status,0,child.stderr);assert.equal(child.error,undefined);
});

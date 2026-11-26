import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import * as transport from '../src/core/original-preparation-transport.js';
function fixture({fetchSdk,onResolve}={}){
 let client,used=false;const proof=Object.freeze(Object.create(null));
 const data={purpose:'prepare',messageId:'message',targetParticipantId:'host',taskId:'task',threadId:'thread',payload:{protocol:'ordinary_default_dispatch_runtime_v1'}};
 const source={resolve(candidate,actual){if(candidate!==proof||used||actual!==client)throw Error('original_proof_required');return onResolve?.(data)??{data,assertCurrent(){},consume(){used=true;}};}};
 client=transport.createOriginalPreparationBrokerClient({preparationSource:source,fetchSdk:fetchSdk??(async()=>new Response('{"ok":true}')),httpBase:'http://controlled.invalid',participantId:'b',methods:{}});
 return{client,source,proof,completion(raw,token=proof){assert.equal(typeof transport.readOriginalPreparationTransportCompletion,'function');return transport.readOriginalPreparationTransportCompletion(client,source,token,raw);}};
}
test('the original SDK completion bridge is a standard promise and waits its real held body',async()=>{
 let release;const held=new Promise(yes=>{release=yes;});const f=fixture({fetchSdk:async()=>new Response(new ReadableStream({start(controller){held.then(()=>{controller.enqueue(new TextEncoder().encode('{"ok":true}'));controller.close();});}}))});
 const raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),completion=f.completion(raw);let done=false;completion.then(()=>{done=true;});
 try{assert.equal(Object.getPrototypeOf(completion),Promise.prototype);assert.equal(Object.hasOwn(completion,'then'),false);assert.equal(Object.hasOwn(completion,'constructor'),false);await delay(10);assert.equal(done,false);transport.assertOriginalPreparationTransportCurrent(f.client,f.source,f.proof);}finally{release();await raw;await completion;await f.client.drainDefaultDispatchPreparations();}
});
test('completion membership refuses wrong client source proof or raw before getters',async()=>{
 const f=fixture(),g=fixture(),raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');raw.catch(()=>{});let getters=0;
 const fake=Object.defineProperty({},'then',{get(){getters++;throw Error('forbidden');}});
 try{assert.throws(()=>f.completion(raw,{}));assert.throws(()=>f.completion(fake));assert.throws(()=>transport.readOriginalPreparationTransportCompletion(g.client,f.source,f.proof,raw));assert.throws(()=>transport.readOriginalPreparationTransportCompletion(f.client,{},f.proof,raw));assert.equal(getters,0);}finally{await raw;await f.client.drainDefaultDispatchPreparations();await g.client.drainDefaultDispatchPreparations();}
});
test('a true preflight rejection has an owned completion without an SDK call',async()=>{
 let calls=0;const f=fixture({fetchSdk(){calls++;throw Error('must not invoke');}}),raw=f.client.sendDefaultDispatchPreparation(f.proof,'agent');raw.catch(()=>{});
 await assert.rejects(f.completion(raw),/SCHEDULER_REQUIRED/);assert.equal(calls,0);await f.client.drainDefaultDispatchPreparations();
});
test('known source sibling tails are joined before a negative completion',async()=>{
 let release;const held=new Promise(yes=>{release=yes;});const f=fixture({onResolve(data){return Object.assign(Object.create({foreign:true}),{data,assertCurrent(){},consume(){},extra:held});}});
 const raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');raw.catch(()=>{});const completion=f.completion(raw);let done=false;completion.then(()=>{done=true;},()=>{done=true;});
 try{await delay(10);assert.equal(done,false);}finally{release();await held;await assert.rejects(completion,/UNCONFIRMED/);await assert.rejects(f.client.drainDefaultDispatchPreparations(),/UNCONFIRMED/);}
});
test('an unobservable SDK return keeps completion pending after logical rejection',async()=>{
 let getters=0;const unknown=Object.defineProperty({},'then',{get(){getters++;throw Error('forbidden');}}),f=fixture({fetchSdk:()=>unknown}),raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');raw.catch(()=>{});
 const completion=f.completion(raw);let done=false;completion.then(()=>{done=true;},()=>{done=true;});await assert.rejects(raw,/SDK_UNCONFIRMED/);await delay(10);assert.equal(done,false);assert.equal(getters,0);await assert.rejects(f.client.drainDefaultDispatchPreparations(),/UNCONFIRMED/);
});
test('an entered SDK that throws without returning an observer cannot certify completion',async()=>{
 const original=Error('entered SDK throw'),f=fixture({fetchSdk(){throw original;}}),raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');raw.catch(()=>{});const completion=f.completion(raw);let done=false;completion.then(()=>{done=true;},()=>{done=true;});
 await assert.rejects(raw,error=>error===original);await delay(10);assert.equal(done,false);await assert.rejects(f.client.drainDefaultDispatchPreparations(),error=>error.cause===original);
});
test('a known HTTP failure settles its own completion after EOF and preserves duplicate attempt identity',async()=>{
 const f=fixture({fetchSdk:async()=>new Response('{"ok":false}',{status:403})}),raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');raw.catch(()=>{});await assert.rejects(f.completion(raw),/HTTP_FAILED/);
 const duplicate=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');duplicate.catch(()=>{});await assert.rejects(f.completion(duplicate),/PROOF_REQUIRED/);await assert.rejects(f.completion(raw),/HTTP_FAILED/);await f.client.drainDefaultDispatchPreparations();
});
test('a known unsafe promise cannot hide a newly returned unobservable Response body',async()=>{
 let controller;const response=new Response(new ReadableStream({start(value){controller=value;}}));
 const f=fixture({onResolve(data){return Object.assign(Object.create({foreign:true}),{data,assertCurrent(){},consume(){},extra:Promise.resolve(response)});}}),raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');raw.catch(()=>{});
 const completion=f.completion(raw);let done=false;completion.then(()=>{done=true;},()=>{done=true;});
 try{await delay(10);assert.equal(done,false);}finally{controller.close();await assert.rejects(f.client.drainDefaultDispatchPreparations(),/UNCONFIRMED/);}
});
test('a known rejected SDK with an undefined reason remains a rejection rather than successful completion',async()=>{
 const f=fixture({fetchSdk:()=>Promise.reject(undefined)}),raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');raw.catch(()=>{});const result=await Promise.allSettled([f.completion(raw)]);assert.equal(result[0].status,'rejected');assert.equal(result[0].reason,undefined);await f.client.drainDefaultDispatchPreparations();
});
test('newly returned data and native error sidecars retain their own known promise tails',async()=>{
 for(const rejected of [false,true]){
  let release;const held=new Promise(yes=>{release=yes;});const value=rejected?Error('diagnostic',{cause:held}):{nested:held};
  const extra=rejected?Promise.reject(value):Promise.resolve(value);
  const f=fixture({onResolve(data){return Object.assign(Object.create({foreign:true}),{data,assertCurrent(){},consume(){},extra});}}),raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');raw.catch(()=>{});
  const completion=f.completion(raw);let done=false;completion.then(()=>{done=true;},()=>{done=true;});
  try{await delay(10);assert.equal(done,false);}finally{release();await assert.rejects(completion,/UNCONFIRMED/);await assert.rejects(f.client.drainDefaultDispatchPreparations(),/UNCONFIRMED/);}
 }
});
test('a native error with an opaque cause accessor cannot certify completion or execute the getter',async()=>{
 let getters=0,release;const held=new Promise(yes=>{release=yes;}),error=Object.defineProperty(Error('diagnostic'),'cause',{get(){getters++;return held;}});
 const f=fixture({onResolve(data){return Object.assign(Object.create({foreign:true}),{data,assertCurrent(){},consume(){},extra:Promise.reject(error)});}}),raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');raw.catch(()=>{});
 const completion=f.completion(raw);let done=false;completion.then(()=>{done=true;},()=>{done=true;});
 try{await delay(10);assert.equal(done,false);assert.equal(getters,0);}finally{release();await held;await assert.rejects(f.client.drainDefaultDispatchPreparations(),/UNCONFIRMED/);}
});
test('a completed attempt bridge does not wait for an unrelated later held attempt',async()=>{
 const first=Object.freeze({}),second=Object.freeze({}),used=new WeakSet();let client,calls=0,release;
 const held=new Promise(yes=>{release=yes;}),source={resolve(proof,actual){assert.equal(actual,client);assert.ok(proof===first||proof===second);assert.equal(used.has(proof),false);return{data:{purpose:'prepare',messageId:proof===first?'one':'two',targetParticipantId:'host',taskId:'task',threadId:'thread',payload:{protocol:'ordinary_default_dispatch_runtime_v1'}},assertCurrent(){},consume(){used.add(proof);}};}};
 client=transport.createOriginalPreparationBrokerClient({preparationSource:source,fetchSdk:()=>++calls===1?Promise.resolve(new Response('{}')):held,httpBase:'http://controlled.invalid',participantId:'b',methods:{}});
 const one=client.sendDefaultDispatchPreparation(first,'scheduler');await one;
 const two=client.sendDefaultDispatchPreparation(second,'scheduler');let done=false;
 const completion=transport.readOriginalPreparationTransportCompletion(client,source,first,one);completion.then(()=>{done=true;},()=>{done=true;});
 try{await delay(10);assert.equal(done,true);assert.equal(calls,2);}finally{release(new Response('{}'));await two;await completion;await client.drainDefaultDispatchPreparations();}
});
test('an incompletely scanned settlement remains opaque rather than dropping a deep promise',async()=>{
 let release;const held=new Promise(yes=>{release=yes;});let value={held};for(let i=0;i<140;i++)value={child:value};
 const f=fixture({onResolve(data){return Object.assign(Object.create({foreign:true}),{data,assertCurrent(){},consume(){},extra:Promise.resolve(value)});}}),raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');raw.catch(()=>{});
 const completion=f.completion(raw);let done=false;completion.then(()=>{done=true;},()=>{done=true;});
 try{await delay(10);assert.equal(done,false);}finally{release();await held;await assert.rejects(f.client.drainDefaultDispatchPreparations(),/UNCONFIRMED/);}
});
test('an actual SDK rejection retains its error cause promise until settlement',async()=>{
 let release;const held=new Promise(yes=>{release=yes;}),error=Error('original SDK',{cause:held}),f=fixture({fetchSdk:()=>Promise.reject(error)}),raw=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');raw.catch(()=>{});
 const completion=f.completion(raw);let done=false;completion.then(()=>{done=true;},()=>{done=true;});
 try{await delay(10);assert.equal(done,false);}finally{release();await assert.rejects(completion,value=>value===error||value.cause===error);await assert.rejects(f.client.drainDefaultDispatchPreparations(),/UNCONFIRMED/);}
});

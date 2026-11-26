import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createBrokerClient} from '../src/net/broker-client.js';
// Controlled constructor source only; not an original B/Native/Host grant.
function fixture({fetchImpl,onCurrent,onConsume,onResolve}={}){
 const frames=new WeakMap(),proof=Object.freeze(Object.create(null)),posts=[];let client,used=0,live=true;
 const data={purpose:'prepare',messageId:'controlled-prepare-hint-1',targetParticipantId:'host',taskId:'p__a',threadId:'thread-p__a',payload:{protocol:'ordinary_default_dispatch_runtime_v1',projectId:'p',childKey:'controlled-child'}};frames.set(proof,data);
 const source={resolve(frame,actualClient){assert.equal(actualClient,client);if(onResolve)return onResolve();const stored=frames.get(frame);if(!stored||used)throw Error('original_transport_proof_required');return{data:stored,assertCurrent(){onCurrent?.(client);if(!live)throw Error('original_transport_withdrawn');},consume(){onConsume?.(client);if(!live)throw Error('original_transport_withdrawn');if(used)throw Error('original_transport_consumed');used++;}};}};
 client=createBrokerClient({participantId:'kswarm-hub',silent:true,preparationSource:source,fetchImpl:fetchImpl??(async(url,input)=>{posts.push({url,input});return new Response(JSON.stringify({ok:true,deliveredCount:1,onlineRecipients:['host'],offlineRecipients:[]}));})});
 return{client,proof,data,frames,source,posts,get used(){return used;},withdraw(){live=false;}};
}
test('the original client refuses missing source and non-scheduler preparation before any HTTP SDK',async()=>{
 let calls=0;const client=createBrokerClient({participantId:'kswarm-hub',fetchImpl:async()=>{calls++;return new Response('{}');}});assert.equal(typeof client.sendDefaultDispatchPreparation,'function');
 await assert.rejects(client.sendDefaultDispatchPreparation({},'scheduler'),/DEFAULT_DISPATCH_TRANSPORT_SOURCE_REQUIRED/);
 const f=fixture();for(const role of ['user','agent'])await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,role),/DEFAULT_DISPATCH_TRANSPORT_SCHEDULER_REQUIRED/);assert.equal(calls,0);assert.equal(f.posts.length,0);
});
test('a fixed opaque preparation proof emits only the closed preparation hint once',async()=>{
 const f=fixture();assert.equal(typeof f.client.sendDefaultDispatchPreparation,'function');const result=await f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');assert.equal(result.deliveredCount,1);assert.equal(f.used,1);assert.equal(f.posts.length,1);
 const body=JSON.parse(f.posts[0].input.body);assert.equal(body.kind,'default_dispatch_prepare_v1');assert.equal(body.opaque,true);assert.equal(body.fromParticipantId,'kswarm-hub');assert.deepEqual(body.to,{mode:'participant',participants:['host']});assert.equal(body.payload.childKey,'controlled-child');
 await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),/original_transport_proof_required|DEFAULT_DISPATCH_TRANSPORT_PROOF_REQUIRED/);assert.equal(f.posts.length,1);await f.client.drainDefaultDispatchPreparations();
});
test('copied and getter-bearing unknown proofs cannot be inspected or sent',async()=>{
 const f=fixture();assert.equal(typeof f.client.sendDefaultDispatchPreparation,'function');let getters=0;
 for(const proof of [{...f.proof},Object.defineProperty({},'childKey',{get(){getters++;throw Error('forbidden');}})])await assert.rejects(f.client.sendDefaultDispatchPreparation(proof,'scheduler'),/original_transport_proof_required|DEFAULT_DISPATCH_TRANSPORT_PROOF_REQUIRED/);
 assert.equal(getters,0);assert.equal(f.posts.length,0);
});
test('a reentrant seal in the final current or consume gate prevents the actual fetch',async()=>{
 for(const phase of ['current','consume']){const f=fixture({[phase==='current'?'onCurrent':'onConsume']:(client)=>client.sealDefaultDispatchPreparations()});assert.equal(typeof f.client.sendDefaultDispatchPreparation,'function');await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),/DEFAULT_DISPATCH_TRANSPORT_SEALED/);assert.equal(f.posts.length,0);}
});
for(const phase of ['fetch','body'])test('the original client keeps the '+phase+' SDK raw until its real settlement',async()=>{
 let entered=false,release;const held=new Promise(yes=>{release=yes;});const f=fixture({fetchImpl:async()=>{if(phase==='fetch'){entered=true;await held;return new Response('{"ok":true}');}return new Response(new ReadableStream({start(controller){entered=true;held.then(()=>{controller.enqueue(new TextEncoder().encode('{"ok":true}'));controller.close();});}}));}});assert.equal(typeof f.client.sendDefaultDispatchPreparation,'function');
 let done=false;const sent=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');for(let n=0;n<100&&!entered;n++)await delay(2);assert.equal(entered,true);const close=f.client.drainDefaultDispatchPreparations().then(()=>{done=true;},()=>{done=true;});
 try{await delay(15);assert.equal(done,false);}finally{release();await sent;await close;}
});
test('the fixed source binds the lexical client even when the method is borrowed',async()=>{
 const f=fixture();const borrowed=f.client.sendDefaultDispatchPreparation;
 assert.equal((await borrowed.call({sendDefaultDispatchPreparation:borrowed},f.proof,'scheduler')).deliveredCount,1);assert.equal(f.posts.length,1);
 const other=fixture();await assert.rejects(other.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),/original_transport_proof_required|DEFAULT_DISPATCH_TRANSPORT_PROOF_REQUIRED/);assert.equal(other.posts.length,0);
});
test('a source resolver getter and bound async resolver run no body or getter',async()=>{
 let reads=0,calls=0;for(const preparationSource of [Object.defineProperty({},'resolve',{get(){reads++;throw Error('forbidden');}}),{resolve:(async()=>{calls++;}).bind(null)}]){
 const client=createBrokerClient({participantId:'hub',preparationSource,fetchImpl:async()=>{calls++;return new Response('{}');}});
 await assert.rejects(client.sendDefaultDispatchPreparation({},'scheduler'),/SOURCE_REQUIRED/);await client.drainDefaultDispatchPreparations();}
 assert.equal(reads,0);assert.equal(calls,0);
});
test('an unsafe source sibling retains its real promise across a reentrant drain',async()=>{
 let release,closing,done=false;const held=new Promise(yes=>{release=yes;});let f;
 f=fixture({onResolve(){closing=f.client.drainDefaultDispatchPreparations();closing.then(()=>{done=true;},()=>{done=true;});return {data:f.data,assertCurrent(){},consume(){},unexpected:held};}});
 await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),/TRANSPORT_DATA_INVALID/);
 try{await delay(15);assert.equal(done,false);assert.equal(f.posts.length,0);}finally{release();}
 await assert.rejects(closing,/TRANSPORT_UNCONFIRMED/);assert.equal(done,true);
});
test('a rejected foreign-prototype source envelope still owns every known promise sibling',async()=>{
 let release,done=false;const held=new Promise(yes=>{release=yes;});let f;
 f=fixture({onResolve(){return Object.assign(Object.create({foreign:true}),{data:f.data,assertCurrent(){},consume(){},extra:held});}});
 await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),/SOURCE_UNCONFIRMED/);
 const closing=f.client.drainDefaultDispatchPreparations();closing.then(()=>{done=true;},()=>{done=true;});
 try{await delay(15);assert.equal(done,false);}finally{release();await assert.rejects(closing,/TRANSPORT_UNCONFIRMED/);}
});
for(const phase of ['current','consume'])test('a '+phase+' callback returning a raw promise cannot be called complete',async()=>{
 let release,done=false;const held=new Promise(yes=>{release=yes;});let f;
 f=fixture({onResolve(){return{data:f.data,assertCurrent(){if(phase==='current')return held;},consume(){if(phase==='consume')return held;}};}});
 await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),/SOURCE_UNCONFIRMED/);const closing=f.client.drainDefaultDispatchPreparations();closing.then(()=>{done=true;},()=>{done=true;});
 try{await delay(15);assert.equal(done,false);assert.equal(f.posts.length,0);}finally{release();}
 await assert.rejects(closing,/TRANSPORT_UNCONFIRMED/);
});
test('an unknown fetch thenable is never invoked or reported drained',async()=>{
 let thenReads=0;const raw=Object.defineProperty({},'then',{get(){thenReads++;throw Error('forbidden');}});
 const f=fixture({fetchImpl:()=>raw});
 await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),/SDK_UNCONFIRMED/);
 await assert.rejects(f.client.drainDefaultDispatchPreparations(),/TRANSPORT_UNCONFIRMED/);assert.equal(thenReads,0);
});
test('a non-Response cannot execute its method getter and keeps the original brand failure',async()=>{
 let reads=0,original;const response=Object.defineProperty({ok:true},'json',{get(){reads++;throw Error('forbidden');}});
 const f=fixture({fetchImpl:()=>Promise.resolve(response)});await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),error=>{original=error;return error instanceof TypeError;});assert.equal(reads,0);
 await assert.rejects(f.client.drainDefaultDispatchPreparations(),error=>error.message==='DEFAULT_DISPATCH_TRANSPORT_UNCONFIRMED'&&error.cause===original);
});
test('a known body rejection settles the SDK and retains its original error without inventing an unknown tail',async()=>{
 const original=Error('actual body failed'),response=new Response(new ReadableStream({start(controller){controller.error(original);}}));const f=fixture({fetchImpl:()=>Promise.resolve(response)});
 await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),error=>error===original);await f.client.drainDefaultDispatchPreparations();
});
test('a late Array.toJSON hook cannot redirect the fixed preparation audience',async()=>{
 const old=Object.getOwnPropertyDescriptor(Array.prototype,'toJSON'),response=new Response('{"ok":true}');let invoked=0,f;f=fixture({onResolve(){Object.defineProperty(Array.prototype,'toJSON',{configurable:true,value(){invoked++;return ['attacker'];}});return{data:f.data,assertCurrent(){},consume(){}};},fetchImpl:async(url,input)=>{f.posts.push({url,input});return response;}});
 try{await f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');const body=JSON.parse(f.posts[0].input.body);assert.deepEqual(body.to.participants,['host']);assert.equal(invoked,0);}finally{if(old)Object.defineProperty(Array.prototype,'toJSON',old);else delete Array.prototype.toJSON;}
 await f.client.drainDefaultDispatchPreparations();
});
test('a native Response cannot substitute an early json ACK for its still-live body',async()=>{
 let controller,overrides=0,sentDone=false,closeDone=false;
 const response=new Response(new ReadableStream({start(value){controller=value;value.enqueue(new TextEncoder().encode('{"ok":true'));}}));
 Object.defineProperty(response,'json',{value(){overrides++;return Promise.resolve({ok:true});}});
 const f=fixture({fetchImpl:async()=>response});const sent=f.client.sendDefaultDispatchPreparation(f.proof,'scheduler');sent.then(()=>{sentDone=true;},()=>{sentDone=true;});
 await delay(10);const closing=f.client.drainDefaultDispatchPreparations();closing.then(()=>{closeDone=true;},()=>{closeDone=true;});
 try{await delay(15);assert.equal(sentDone,false);assert.equal(closeDone,false);assert.equal(overrides,0);}finally{controller.enqueue(new TextEncoder().encode('}'));controller.close();await sent;await closing;}
});
test('a synchronous fetch SDK throw is not evidence of a drained physical request',async()=>{
 const original=Error('fetch threw after entering SDK');const f=fixture({fetchImpl(){throw original;}});
 await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'),error=>error===original);assert.equal(f.used,1);
 await assert.rejects(f.client.drainDefaultDispatchPreparations(),error=>error.message==='DEFAULT_DISPATCH_TRANSPORT_UNCONFIRMED'&&error.cause===original);
});
for(const kind of ['foreign','promise','array-sidecar','array-index','array-long'])test('a rejected '+kind+' nested source value still retains its known raw sibling',async()=>{
 let release,done=false,f;const held=new Promise(yes=>{release=yes;}),extra=kind==='array-sidecar'?Object.assign([],{sidecar:held}):kind==='array-index'?Object.assign([],{['01']:held}):kind==='array-long'?Object.assign(new Array(1_000_001),{sidecar:held}):Object.assign(kind==='promise'?Promise.resolve():Object.create({foreign:true}),{held});
 f=fixture({onResolve(){return{data:f.data,assertCurrent(){},consume(){},extra};}});await assert.rejects(f.client.sendDefaultDispatchPreparation(f.proof,'scheduler'));
 const close=f.client.drainDefaultDispatchPreparations();close.then(()=>{done=true;},()=>{done=true;});try{await delay(15);assert.equal(done,false);}finally{release();await assert.rejects(close,/TRANSPORT_UNCONFIRMED/);}
});

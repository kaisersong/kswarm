import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {sha256Hex} from '../src/core/state-scope.js';
import {createHub} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
async function fixture(t,{source=true,sqliteFactory,sourceFactory,forceUnconfirmedCleanup=false}={}){
 const root=mkdtempSync(join(tmpdir(),'default-dispatch-operation-')),filePath=join(root,'state.sqlite'),authority=createProjectInputAuthority(scope),hubs=[],stores=[],effects=[],actor={requestSource:'user',actorId:'desktop-user:'+scope.profileId};let hub,backend,frames;
 const calls={resolve:0,current:0};
 const open=()=>{frames=new WeakMap();const fixedFrames=frames,actionSource={resolve(frame){calls.resolve++;const entry=fixedFrames.get(frame);if(!entry)throw Error('controlled_business_frame_foreign');return entry.reply??{data:entry.fact,assertCurrent:entry.guard};}};backend=createSqlitePersistence({filePath,...(sqliteFactory?{sqliteFactory}:{})});stores.push(backend);hub=createHub({silent:true,persistence:backend,dataDir:{backend:'sqlite',filePath},projectStorageRoot:join(root,'projects'),defaultDispatchActionSource:source?(sourceFactory?sourceFactory(actionSource):actionSource):undefined,bridge:{requestTask(input){effects.push(input);return{ok:true};}},brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true};}}});hubs.push(hub);};open();
 t.after(()=>{let unconfirmed=0;for(const item of hubs)try{item.closePersistence();}catch(error){if(!forceUnconfirmedCleanup)throw error;unconfirmed++;}if(forceUnconfirmedCleanup){for(const store of stores)store.close();console.log(JSON.stringify({test:'fixture-only-unconfirmed-native-cleanup',unconfirmedProductClose:unconfirmed,forcedNativeCloseCalls:stores.length,notProductionClose:true}));}rmSync(root,{recursive:true,force:true});});
 const control={requestSource:'user',projectInputAuthority:authority.reader()};assert.equal(hub.prepareDurableDispatchWriter(control).ok,true);await hub.createProject({id:'p',name:'P',goal:'Actual business goal',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},control);assert.equal(hub.handleHumanAddTasks('p',[{id:'a',title:'A',brief:'Original execution payload',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);
 const plan=()=>{const result=hub.readDefaultDispatchPlan('p',authority.reader());assert.equal(result.ok,true,JSON.stringify(result));return result.plan;};
 return{root,filePath,scope,actor,authority,calls,effects,get hub(){return hub;},get backend(){return backend;},plan,assertApi(){assert.equal(typeof hub.captureDefaultDispatchOperation,'function');assert.equal(typeof hub.readDefaultDispatchOperation,'function');},async admit(){const {defaultDispatchActionRecord}=await import('../src/core/default-dispatch-action-data.js'),head=plan(),fact=defaultDispatchActionRecord({scope,projectId:'p',planRevision:head.revision,dispatchGeneration:head.dispatchGeneration,bindingDigest:head.bindingDigest,taskSetDigest:head.taskSetDigest});const frame=Object.freeze(Object.create(null)),entry={fact,active:true,guard(){calls.current++;if(!entry.active)throw Error('controlled_action_withdrawn');}};frames.set(frame,entry);return{frame,entry,head};},capture(frame,context=actor){return hub.captureDefaultDispatchOperation('p',frame,context);},read(head){return hub.readDefaultDispatchOperation('p',{planRevision:head.revision,dispatchGeneration:head.dispatchGeneration},authority.reader());},raw(fn){const db=new DatabaseSync(filePath,{readOnly:true});try{return fn(db);}finally{db.close();}},rows(){return this.raw(db=>db.prepare("SELECT entity_key,state_json,revision FROM state_entities WHERE collection IN ('protocolReceipt','protocolHead') ORDER BY entity_key").all());},reopen(){hub.closePersistence();open();}};
}
test('capture is default-denied without the original admitted business source and fake frames execute zero getters',async t=>{
 const f=await fixture(t,{source:false});f.assertApi();const revision=f.backend.revision;assert.equal(f.capture({}).error,'DURABLE_DISPATCH_SOURCE_UNAVAILABLE');assert.equal(f.backend.revision,revision);
 const g=await fixture(t);g.assertApi();let getters=0;const fake=Object.defineProperty({},'scope',{get(){getters++;throw Error('forbidden fake getter');}}),before=g.backend.revision;assert.equal(g.capture(fake).ok,false);assert.equal(getters,0);assert.equal(g.calls.current,0);assert.equal(g.backend.revision,before);assert.deepEqual(g.effects,[]);
});
test('actual original Hub captures one durable parent/child/intent graph and metadata survives reopen without a fresh action',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit(),result=f.capture(action.frame);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.operation.children.length,1);assert.equal(result.operation.children[0].state,'intent_pending');assert.equal(result.operation.children[0].childKey,f.plan().tasks[0].childKey);assert.match(result.operation.parentId,/^default-dispatch-parent:/);
 const first=f.rows(),revision=f.backend.revision;assert.deepEqual(f.capture(action.frame).operation,result.operation);assert.equal(f.backend.revision,revision);assert.deepEqual(f.rows(),first);assert.deepEqual(f.read(action.head).operation,result.operation);f.reopen();assert.deepEqual(f.read(action.head).operation,result.operation);assert.equal(f.capture(action.frame).ok,false);assert.deepEqual(f.effects,[]);
});
test('different admitted window frames for the same canonical user fact reuse one parent without re-writing child facts',async t=>{
 const f=await fixture(t);f.assertApi();const a=await f.admit(),b=await f.admit();assert.notEqual(a.frame,b.frame);assert.deepEqual(a.entry.fact,b.entry.fact);const first=f.capture(a.frame),before=f.rows(),revision=f.backend.revision;assert.equal(first.ok,true);assert.deepEqual(f.capture(b.frame).operation,first.operation);assert.equal(f.backend.revision,revision);assert.deepEqual(f.rows(),before);assert.deepEqual(f.effects,[]);
});
test('adding a task creates only its new child and a new parent while every original child/intent/status/outbox byte stays unchanged',async t=>{
 const f=await fixture(t);f.assertApi();const a=await f.admit(),first=f.capture(a.frame);assert.equal(first.ok,true);const oldKey=first.operation.children[0].childKey,oldRows=f.rows().filter(row=>row.entity_key.startsWith(oldKey));assert.ok(oldRows.length>=4);assert.equal(f.hub.handleHumanAddTasks('p',[{id:'b',title:'B',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);const b=await f.admit(),next=f.capture(b.frame);assert.equal(next.ok,true,JSON.stringify(next));assert.notEqual(next.operation.parentId,first.operation.parentId);assert.equal(next.operation.children.length,2);assert.deepEqual(f.rows().filter(row=>row.entity_key.startsWith(oldKey)),oldRows);assert.deepEqual(f.read(a.head).operation,first.operation);f.reopen();assert.deepEqual(f.read(b.head).operation,next.operation);assert.deepEqual(f.effects,[]);
});
test('an original plan-only revision reuses the same immutable business child and historical reads remain independent of current content',async t=>{
 const f=await fixture(t);f.assertApi();const a=await f.admit(),first=f.capture(a.frame);assert.equal(first.ok,true);const oldKey=first.operation.children[0].childKey,oldRows=f.rows().filter(row=>row.entity_key.startsWith(oldKey));assert.equal(f.hub.handleSubmitPlan('p',{analysis:'Actual plan',phases:[]},'po').ok,true);const b=await f.admit(),next=f.capture(b.frame);assert.equal(next.ok,true);assert.notEqual(next.operation.parentId,first.operation.parentId);assert.deepEqual(next.operation.children,first.operation.children);assert.deepEqual(f.rows().filter(row=>row.entity_key.startsWith(oldKey)),oldRows);
 const task=f.hub.getBoard('p').getTask(oldKey===f.plan().tasks[0].childKey?f.plan().tasks[0].taskId:'bad');task.brief='Changed actual same-generation payload';f.hub.persistState({type:'project',projectId:'p'});const revision=f.backend.revision;assert.equal(f.capture(b.frame).ok,false);assert.equal(f.backend.revision,revision);assert.deepEqual(f.read(a.head).operation,first.operation);assert.deepEqual(f.read(b.head).operation,next.operation);assert.deepEqual(f.effects,[]);
});
test('agent, scheduler, copied fact and desktop control data cannot use the original user business frame',async t=>{
 const f=await fixture(t);f.assertApi();const a=await f.admit(),revision=f.backend.revision;
 for(const context of [{requestSource:'agent',actorId:f.actor.actorId},{requestSource:'scheduler',actorId:f.actor.actorId},{requestSource:'user',actorId:'another-user'}])assert.equal(f.capture(a.frame,context).ok,false);
 assert.equal(f.capture({...a.entry.fact}).ok,false);assert.equal(f.capture(f.authority.reader()).ok,false);assert.equal(f.backend.revision,revision);assert.deepEqual(f.effects,[]);
});
for(const subject of ['binding','birth'])test('historical operation refuses a missing physical original '+subject+' lineage receipt without adopting its heap copy',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit();assert.equal(f.capture(action.frame).ok,true);const original=f.rows().map(row=>JSON.parse(row.state_json)).find(row=>row.kind===(subject==='birth'?'ordinary_default_dispatch_birth':'project_protocol_binding'));assert.ok(original);const profile=f.backend.getWriterProfile().floor,db=new DatabaseSync(f.filePath);
 try{db.function('kswarm_durable_dispatch_writer_v1',()=>profile.writerProfileDigest);db.prepare("DELETE FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").run(original.id);}finally{db.close();}
 const revision=f.backend.revision;assert.equal(f.read(action.head).ok,false);assert.equal(f.backend.revision,revision);assert.deepEqual(f.effects,[]);
});
for(const form of ['proxy','inherited-then'])test('source '+form+' raw stays unconfirmed at the original close gate without invoking getters',async t=>{
 let getters=0,release;const promise=new Promise(yes=>{release=yes;}),raw=form==='proxy'?new Proxy(promise,{get(){getters++;throw Error('forbidden proxy getter');}}):Object.create(Object.defineProperty({},'then',{get(){getters++;throw Error('forbidden inherited then');}}));
 const f=await fixture(t,{sourceFactory(){return{resolve(){return raw;}};},forceUnconfirmedCleanup:true});f.assertApi();try{const value=f.capture({});assert.equal(value.ok,false);assert.equal(getters,0);assert.throws(()=>f.hub.closePersistence(),/BUSY|UNKNOWN|UNCONFIRMED/);assert.equal(getters,0);}finally{release();await promise;}
});
test('the original staging record cannot be leaked or emptied by a late WeakMap lookup hook',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit(),get=WeakMap.prototype.get;let leaked=0;
 action.entry.guard=function(){WeakMap.prototype.get=function(key){const value=Reflect.apply(get,this,[key]);if(value&&Array.isArray(value.additions)){leaked++;value.additions=[];}return value;};};
 let capture,observed;try{capture=f.capture(action.frame);observed=f.read(action.head);}finally{WeakMap.prototype.get=get;}
 assert.equal(capture.ok,true,JSON.stringify(capture));assert.equal(observed.ok,true,JSON.stringify(observed));assert.equal(leaked,0);assert.deepEqual(f.effects,[]);
});
test('a late Set.add hook cannot erase original admission reservations and close the Native owner inside current',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit(),add=Set.prototype.add,clear=Set.prototype.clear;let guards=0,attempted=false,allowed=false;
 action.entry.guard=function(){if(++guards===1){Set.prototype.add=function(value){const result=Reflect.apply(add,this,[value]);if(value&&typeof value==='object'&&value.done)Reflect.apply(clear,this,[]);return result;};}else{attempted=true;try{f.hub.closePersistence();allowed=true;}catch{}}};
 let capture;try{try{capture=f.capture(action.frame);}catch(error){capture={error:String(error)};}}finally{Set.prototype.add=add;}
 assert.equal(attempted,true);assert.equal(allowed,false,JSON.stringify(capture));assert.equal(capture.ok,true,JSON.stringify(capture));assert.deepEqual(f.effects,[]);
});
test('the actual source cannot make child capture invoke a project room getter',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit(),project=f.hub.getProject('p'),descriptor=Object.getOwnPropertyDescriptor(project,'primaryRoomId'),revision=f.backend.revision;let getters=0;
 action.entry.guard=function(){Object.defineProperty(project,'primaryRoomId',{configurable:true,enumerable:true,get(){getters++;throw Error('forbidden project room getter');}});};
 try{try{f.capture(action.frame);}catch{}assert.equal(getters,0);assert.equal(f.backend.revision,revision);assert.deepEqual(f.effects,[]);}finally{Object.defineProperty(project,'primaryRoomId',descriptor);}
});
test('the original native write set cannot silently omit a preclosed authenticated graph',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit(),map=Array.prototype.map,filter=Array.prototype.filter,some=Array.prototype.some;let intercepted=false,capture,failure;
 action.entry.guard=function(){Array.prototype.map=function(fn,receiver){const output=Reflect.apply(map,this,[fn,receiver]);if(Reflect.apply(some,this,[row=>row?.collection==='protocolReceipt'&&row.value?.kind==='ordinary_default_dispatch_parent'])){intercepted=true;return Reflect.apply(filter,output,[row=>{const value=row?.value??(row?.stateJson?JSON.parse(row.stateJson):undefined);return!value?.kind?.startsWith('ordinary_default_dispatch_')||!value?.contract?.startsWith('ordinary_default_dispatch_operations_');}]);}return output;};};
 try{try{capture=f.capture(action.frame);}catch(error){failure=error;}}finally{Array.prototype.map=map;}
 assert.equal(intercepted,true);if(capture?.ok){assert.equal(f.read(action.head).ok,true,JSON.stringify(capture));}else{assert.ok(failure||capture?.ok===false);assert.equal(f.rows().filter(row=>JSON.parse(row.state_json).contract==='ordinary_default_dispatch_operations_v1').length,0);f.reopen();const next=await f.admit();assert.equal(f.capture(next.frame).ok,true);}assert.deepEqual(f.effects,[]);
});
test('a later source callback cannot change the real project room behind an already frozen intent payload',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit(),revision=f.backend.revision;let checks=0;action.entry.guard=function(){if(++checks===2)f.hub.getProject('p').primaryRoomId='another-room';};const captured=f.capture(action.frame);assert.equal(captured.ok,false,JSON.stringify(captured));assert.equal(f.backend.revision,revision);assert.ok(checks>=2);assert.deepEqual(f.effects,[]);
});
test('a known original source raw blocks close until it actually settles and never restores admission',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit();let release,finished=false,insideCloseAllowed=false;const raw=new Promise(yes=>{release=yes;}).then(()=>{finished=true;});
 action.entry.guard=function(){try{f.hub.closePersistence();insideCloseAllowed=true;}catch{}return raw;};const before=f.backend.revision;assert.equal(f.capture(action.frame).error,'DURABLE_DISPATCH_SOURCE_UNCONFIRMED');assert.equal(insideCloseAllowed,false);assert.equal(f.backend.revision,before);assert.throws(()=>f.hub.closePersistence(),/BUSY/);release();await raw;await new Promise(yes=>setImmediate(yes));assert.equal(finished,true);const calls=f.calls.resolve;assert.equal(f.capture(action.frame).error,'DURABLE_DISPATCH_SOURCE_UNCONFIRMED');assert.equal(f.calls.resolve,calls);assert.deepEqual(f.effects,[]);
});
for(const where of ['resolver','current'])test('actual bound async '+where+' is denied before its body runs',async t=>{
 let bodies=0;const options=where==='resolver'?{sourceFactory(){return{resolve:(async function(){bodies++;return{};}).bind(null)};}}:{forceUnconfirmedCleanup:true};const f=await fixture(t,options);f.assertApi();const action=await f.admit();if(where==='current')action.entry.guard=(async function(){bodies++;}).bind(null);const revision=f.backend.revision;assert.equal(f.capture(action.frame).ok,false);assert.equal(bodies,0);assert.equal(f.backend.revision,revision);assert.deepEqual(f.effects,[]);if(where==='current')assert.throws(()=>f.hub.closePersistence(),/DEFAULT_DISPATCH_MIGRATION_BUSY/);
});
for(const phase of ['before','after'])test('the actual '+phase+' COMMIT graph fault preserves original physical truth and recovery identity',async t=>{
 let armed=false;const original=Error('graph '+phase+' actual COMMIT'),f=await fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT'&&phase==='before'){armed=false;throw original;}const result=exec(sql);if(armed&&sql==='COMMIT'&&phase==='after'){armed=false;throw original;}return result;};return db;}});f.assertApi();const action=await f.admit();armed=true;let failure;try{f.capture(action.frame);}catch(error){failure=error;}assert.ok(failure);assert.match(String(failure),new RegExp('graph '+phase+' actual COMMIT'));assert.equal(f.backend.getHealth().status,'failed');const rows=f.rows().filter(row=>JSON.parse(row.state_json).contract==='ordinary_default_dispatch_operations_v1');assert.equal(rows.length,phase==='after'?6:0);f.reopen();const recovered=f.read(action.head);assert.equal(recovered.ok,phase==='after');const next=await f.admit(),before=f.rows(),result=f.capture(next.frame);assert.equal(result.ok,true,JSON.stringify(result));if(phase==='after'){assert.deepEqual(result.operation,recovered.operation);assert.deepEqual(f.rows(),before);}assert.equal(f.rows().filter(row=>JSON.parse(row.state_json).contract==='ordinary_default_dispatch_operations_v1').length,6);assert.deepEqual(f.effects,[]);
});
test('a nested capture cannot delete the original transaction reservation or create a second graph',async t=>{
 const f=await fixture(t);f.assertApi();const first=await f.admit(),second=await f.admit();let nested=0;first.entry.guard=function(){nested++;assert.equal(f.capture(second.frame).error,'DURABLE_DISPATCH_OPERATION_BUSY');};const captured=f.capture(first.frame);assert.equal(captured.ok,true,JSON.stringify(captured));assert.ok(nested>=2);assert.deepEqual(f.read(first.head).operation,captured.operation);assert.equal(f.rows().filter(row=>JSON.parse(row.state_json).kind==='ordinary_default_dispatch_parent').length,1);assert.deepEqual(f.effects,[]);
});
for(const form of ['proxy','inherited-then'])for(const location of ['data','scope'])test('an unsafe '+form+' source raw nested at '+location+' is retained by the same close gate',async t=>{
 let getters=0,release;const promise=new Promise(yes=>{release=yes;}),raw=form==='proxy'?new Proxy(promise,{get(){getters++;throw Error('forbidden nested proxy getter');}}):Object.create(Object.defineProperty({},'then',{get(){getters++;throw Error('forbidden nested then getter');}}));
 const f=await fixture(t,{forceUnconfirmedCleanup:true,sourceFactory(original){return{resolve(frame){const reply=original.resolve(frame);return{data:location==='data'?raw:{...reply.data,scope:raw},assertCurrent:reply.assertCurrent};}};}});f.assertApi();const action=await f.admit();try{try{f.capture(action.frame);}catch{}assert.equal(getters,0);assert.throws(()=>f.hub.closePersistence(),/BUSY|UNKNOWN|UNCONFIRMED/);assert.equal(getters,0);}finally{release();await promise;}
});
test('all independent known source data futures stay owned until each actual raw settles',async t=>{
 let first,second;const one=new Promise(yes=>{first=yes;}),two=new Promise(yes=>{second=yes;});const f=await fixture(t,{sourceFactory(original){return{resolve(frame){const reply=original.resolve(frame);return{data:{...reply.data,scope:one,taskSetDigest:two},assertCurrent:reply.assertCurrent};}};}});f.assertApi();const action=await f.admit();try{try{f.capture(action.frame);}catch{}assert.throws(()=>f.hub.closePersistence(),/BUSY/);first();await one;await new Promise(yes=>setImmediate(yes));assert.throws(()=>f.hub.closePersistence(),/BUSY/);}finally{first();second();await Promise.all([one,two]);await new Promise(yes=>setImmediate(yes));}assert.equal(f.capture(action.frame).error,'DURABLE_DISPATCH_SOURCE_UNCONFIRMED');
});
test('a forged original Native index checksum cannot skip real graph inserts after write-set validation',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit(),map=Array.prototype.map,get=Map.prototype.get,set=Map.prototype.set,checksums=new Map();let claims=0,capture,failure;
 action.entry.guard=function(){Array.prototype.map=function(fn,receiver){const output=Reflect.apply(map,this,[fn,receiver]);for(let i=0;i<output.length;i++){const row=output[i];if(row?.stateJson){const value=JSON.parse(row.stateJson);if(value.contract==='ordinary_default_dispatch_operations_v1')Reflect.apply(set,checksums,[row.key,sha256Hex(row.stateJson)]);}}return output;};Map.prototype.get=function(key){const checksum=Reflect.apply(get,checksums,[key]);if(checksum){claims++;return{checksum};}return Reflect.apply(get,this,[key]);};};
 try{try{capture=f.capture(action.frame);}catch(error){failure=error;}}finally{Array.prototype.map=map;Map.prototype.get=get;}
 if(capture?.ok){assert.equal(f.read(action.head).ok,true,JSON.stringify({capture,claims}));}else{assert.ok(failure||capture?.ok===false);assert.equal(f.rows().filter(row=>JSON.parse(row.state_json).contract==='ordinary_default_dispatch_operations_v1').length,0);}assert.deepEqual(f.effects,[]);
});
test('an encoder cannot delete the physical task board while committing the complete dispatch graph',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit(),map=Array.prototype.map,filter=Array.prototype.filter,some=Array.prototype.some;let intercepted=false,capture,failure;
 action.entry.guard=function(){Array.prototype.map=function(fn,receiver){const output=Reflect.apply(map,this,[fn,receiver]);if(Reflect.apply(some,this,[row=>row?.collection==='board'&&Object.hasOwn(row,'value')])){intercepted=true;return Reflect.apply(filter,output,[row=>row?.collection!=='board']);}return output;};};
 try{try{capture=f.capture(action.frame);}catch(error){failure=error;}}finally{Array.prototype.map=map;}
 assert.equal(intercepted,true);if(capture?.ok){assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_entities WHERE collection='board' AND entity_key='p'").get().n),1,JSON.stringify(capture));}else{assert.ok(failure||capture?.ok===false);assert.equal(f.rows().filter(row=>JSON.parse(row.state_json).contract==='ordinary_default_dispatch_operations_v1').length,0);}assert.deepEqual(f.effects,[]);
});
test('unavailable presentation state cannot permit board deletion while a new dispatch graph commits',async t=>{
 const f=await fixture(t);f.assertApi();const profile=f.backend.getWriterProfile().floor,db=new DatabaseSync(f.filePath);try{db.function('kswarm_durable_dispatch_writer_v1',()=>profile.writerProfileDigest);const value=JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get().state_json);value.activityDeliveryHead=null;value.activityDeliveryUnavailable=true;const text=JSON.stringify(value);db.prepare("UPDATE state_entities SET state_json=?,checksum=? WHERE collection='project' AND entity_key='p'").run(text,sha256Hex(text));}finally{db.close();}f.reopen();assert.equal(f.hub.getProject('p').activityDeliveryUnavailable,true);assert.equal(f.hub.getProject('p').activityDeliveryHead,null);
 const action=await f.admit(),map=Array.prototype.map,filter=Array.prototype.filter,some=Array.prototype.some;let intercepted=false,capture,failure;action.entry.guard=function(){Array.prototype.map=function(fn,receiver){const output=Reflect.apply(map,this,[fn,receiver]);if(Reflect.apply(some,this,[row=>row?.collection==='board'&&Object.hasOwn(row,'value')])){intercepted=true;return Reflect.apply(filter,output,[row=>row?.collection!=='board']);}return output;};};try{try{capture=f.capture(action.frame);}catch(error){failure=error;}}finally{Array.prototype.map=map;}
 console.log(JSON.stringify({test:'unavailable-board-probe',intercepted,capture,failure:String(failure),physicalBoard:f.raw(db=>db.prepare("SELECT count(*) n FROM state_entities WHERE collection='board' AND entity_key='p'").get().n)}));
 assert.equal(intercepted,true);if(capture?.ok)assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_entities WHERE collection='board' AND entity_key='p'").get().n),1,JSON.stringify(capture));else{assert.ok(failure||capture?.ok===false);assert.equal(f.rows().filter(row=>JSON.parse(row.state_json).contract==='ordinary_default_dispatch_operations_v1').length,0);}assert.deepEqual(f.effects,[]);
});
test('a late actual-row iterator cannot skip the real board SQL write and trigger omission deletion',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit(),original=Array.prototype[Symbol.iterator],map=Array.prototype.map,some=Array.prototype.some;let armed=false,skipped=0,capture,failure;
 action.entry.guard=function(){Array.prototype.map=function(fn,receiver){const output=Reflect.apply(map,this,[fn,receiver]);if(Reflect.apply(some,this,[row=>row?.value?.kind==='ordinary_default_dispatch_parent']))armed=true;return output;};Array.prototype[Symbol.iterator]=function(){const iterator=Reflect.apply(original,this,[]);return{next(){for(;;){const row=iterator.next();if(row.done)return row;if(armed&&row.value?.collection==='board'&&typeof row.value.stateJson==='string'){skipped++;continue;}return row;}},[Symbol.iterator](){return this;}};};};
 try{try{capture=f.capture(action.frame);}catch(error){failure=error;}}finally{Array.prototype[Symbol.iterator]=original;Array.prototype.map=map;}
 console.log(JSON.stringify({test:'actual-board-iterator-probe',skipped,capture,failure:String(failure),physicalBoard:f.raw(db=>db.prepare("SELECT count(*) n FROM state_entities WHERE collection='board' AND entity_key='p'").get().n)}));
 assert.ok(skipped>0);if(capture?.ok){assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_entities WHERE collection='board' AND entity_key='p'").get().n),1,JSON.stringify(capture));}else{assert.ok(failure||capture?.ok===false);assert.equal(f.rows().filter(row=>JSON.parse(row.state_json).contract==='ordinary_default_dispatch_operations_v1').length,0);}assert.deepEqual(f.effects,[]);
});
test('a rejected extra envelope field cannot release an already started original source future',async t=>{
 let release;const raw=new Promise(yes=>{release=yes;});const f=await fixture(t,{sourceFactory(original){return{resolve(frame){const reply=original.resolve(frame);return{...reply,extra:raw};}};}});f.assertApi();const action=await f.admit();try{try{f.capture(action.frame);}catch{}assert.throws(()=>f.hub.closePersistence(),/BUSY/);}finally{release();await raw;await new Promise(yes=>setImmediate(yes));}
});
test('scanner enumeration cannot be redirected to hide an actual nested source Promise',async t=>{
 let release;const raw=new Promise(yes=>{release=yes;}),ownKeys=Reflect.ownKeys;let hidden=0;const f=await fixture(t,{sourceFactory(original){return{resolve(frame){const reply=original.resolve(frame);Reflect.ownKeys=function(value){const field=Object.getOwnPropertyDescriptor(value,'scope');if(field?.value?.value===raw){hidden++;return[];}return ownKeys(value);};return{...reply,data:{...reply.data,scope:raw}};}};}});f.assertApi();const action=await f.admit();try{try{f.capture(action.frame);}catch{}assert.throws(()=>f.hub.closePersistence(),/BUSY/);}finally{Reflect.ownKeys=ownKeys;release();await raw;await new Promise(yes=>setImmediate(yes));}assert.equal(hidden,0);
});
test('the scanner never reads an inherited then getter from its own descriptor table',async t=>{
 const descriptor=Object.getOwnPropertyDescriptor(Object.prototype,'then');let getters=0;const f=await fixture(t,{sourceFactory(original){return{resolve(frame){Object.defineProperty(Object.prototype,'then',{configurable:true,get(){getters++;throw Error('forbidden descriptor table then getter');}});return original.resolve(frame);}};}});f.assertApi();const action=await f.admit();try{try{f.capture(action.frame);}catch{}}finally{if(descriptor)Object.defineProperty(Object.prototype,'then',descriptor);else delete Object.prototype.then;}assert.equal(getters,0);
});
for(const field of ['candidateRef','candidateRefs','desiredRoute'])test('optional '+field+' descriptor and shared business hash never read an inherited getter',async t=>{
 const f=await fixture(t);f.assertApi();const action=await f.admit(),task=f.hub.getBoard('p').getTask(f.plan().tasks[0].taskId);assert.equal(Object.hasOwn(task,field),false);const previous=Object.getOwnPropertyDescriptor(Object.prototype,field);let getters=0;action.entry.guard=function(){Object.defineProperty(Object.prototype,field,{configurable:true,get(){getters++;return undefined;}});};let captured;try{captured=f.capture(action.frame);}finally{if(previous)Object.defineProperty(Object.prototype,field,previous);else delete Object.prototype[field];}assert.equal(captured.ok,true,JSON.stringify(captured));assert.equal(getters,0);
});
function completeReadSnapshot(f){return f.raw(db=>({entities:db.prepare('SELECT * FROM state_entities ORDER BY collection,entity_key').all(),history:db.prepare('SELECT rowid,* FROM state_entity_history ORDER BY rowid').all(),meta:db.prepare('SELECT * FROM state_meta ORDER BY meta_key').all()}));}
test('the original authenticated child reader returns actual immutable B payload without a write or launch grant',async t=>{
 const f=await fixture(t),action=await f.admit(),captured=f.capture(action.frame),lookup=captured.operation.children[0];assert.equal(typeof f.hub.readDefaultDispatchChild,'function');
 const before=completeReadSnapshot(f),revision=f.backend.revision,selector={childKey:lookup.childKey,payloadHash:lookup.payloadHash},r=f.hub.readDefaultDispatchChild('p',selector,f.authority.reader());assert.equal(r.ok,true,JSON.stringify(r));
 assert.deepEqual(r.child,JSON.parse(f.rows().find(row=>row.entity_key===lookup.childKey).state_json));assert.equal(r.child.payload.execution.task.brief,'Original execution payload');assert.equal(f.backend.revision,revision);assert.deepEqual(completeReadSnapshot(f),before);assert.deepEqual(f.effects,[]);assert.equal(f.hub.checkProjectExecutionStart('p').ok,false);
 assert.throws(()=>{r.child.payload.execution.task.brief='caller mutation';},TypeError);assert.equal(f.hub.readDefaultDispatchChild('p',selector,f.authority.reader()).child.payload.execution.task.brief,'Original execution payload');assert.deepEqual(completeReadSnapshot(f),before);
});
test('the original child reader keeps historical payload independent of a new parent and reopen',async t=>{
 const f=await fixture(t),action=await f.admit(),child=f.capture(action.frame).operation.children[0],lookup={childKey:child.childKey,payloadHash:child.payloadHash};assert.equal(typeof f.hub.readDefaultDispatchChild,'function');const first=f.hub.readDefaultDispatchChild('p',lookup,f.authority.reader());assert.equal(first.ok,true);
 assert.equal(f.hub.handleHumanAddTasks('p',[{id:'b',title:'Later task',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);const next=await f.admit();assert.equal(f.capture(next.frame).ok,true);assert.equal(f.hub.handleCloseProject('p','Original authenticated terminal user action',{requestSource:'user',projectInputAuthority:f.authority.reader()}).ok,true);const before=completeReadSnapshot(f);assert.deepEqual(f.hub.readDefaultDispatchChild('p',lookup,f.authority.reader()),first);f.reopen();assert.deepEqual(f.hub.readDefaultDispatchChild('p',lookup,f.authority.reader()),first);assert.deepEqual(completeReadSnapshot(f),before);assert.deepEqual(f.effects,[]);
});
test('unknown copied and wrong-scope child readers are rejected before lookup getters',async t=>{
 const f=await fixture(t),action=await f.admit();f.capture(action.frame);assert.equal(typeof f.hub.readDefaultDispatchChild,'function');let getters=0;const lookup=Object.defineProperty({},'childKey',{enumerable:true,get(){getters++;throw Error('forbidden');}}),other=createProjectInputAuthority({...scope,workspaceId:'c'.repeat(64)}),before=completeReadSnapshot(f);
 for(const reader of [undefined,{},Object.assign({},f.authority.reader()),{requestSource:'agent'},other.reader()])assert.equal(f.hub.readDefaultDispatchChild('p',lookup,reader).ok,false);assert.equal(getters,0);assert.deepEqual(completeReadSnapshot(f),before);
});
test('child lookups close exact own primitive fields and reject unknown hashes before returning data',async t=>{
 const f=await fixture(t),action=await f.admit(),child=f.capture(action.frame).operation.children[0];assert.equal(typeof f.hub.readDefaultDispatchChild,'function');let getters=0;
 const bad=Object.defineProperty({payloadHash:child.payloadHash},'childKey',{enumerable:true,get(){getters++;throw Error('forbidden');}}),before=completeReadSnapshot(f),revision=f.backend.revision;
 for(const lookup of [bad,{childKey:child.childKey,payloadHash:'f'.repeat(64)},{childKey:'default-dispatch-child:'+'f'.repeat(64),payloadHash:child.payloadHash},{childKey:child.childKey,payloadHash:child.payloadHash,extra:true},{childKey:child.childKey,payloadHash:child.payloadHash,extra:undefined},{childKey:{},payloadHash:child.payloadHash},{payloadHash:child.payloadHash}])assert.equal(f.hub.readDefaultDispatchChild('p',lookup,f.authority.reader()).ok,false);
 assert.equal(getters,0);assert.equal(f.backend.revision,revision);assert.deepEqual(completeReadSnapshot(f),before);
});
test('the original child reader refuses a physically missing child instead of adopting its heap copy',async t=>{
 const f=await fixture(t),action=await f.admit(),child=f.capture(action.frame).operation.children[0];assert.equal(typeof f.hub.readDefaultDispatchChild,'function');const db=new DatabaseSync(f.filePath),floor=f.backend.getWriterProfile().floor;
 try{db.function('kswarm_durable_dispatch_writer_v1',()=>floor.writerProfileDigest);db.prepare("DELETE FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").run(child.childKey);}finally{db.close();}
 const before=completeReadSnapshot(f);assert.equal(f.hub.readDefaultDispatchChild('p',{childKey:child.childKey,payloadHash:child.payloadHash},f.authority.reader()).ok,false);assert.deepEqual(completeReadSnapshot(f),before);assert.deepEqual(f.effects,[]);
});
test('the original child reader refuses an object project identity before its serialization callback',async t=>{
 const f=await fixture(t),action=await f.admit(),child=f.capture(action.frame).operation.children[0],lookup={childKey:child.childKey,payloadHash:child.payloadHash};let getters=0,body=0;
 const project=Object.defineProperty({},'toJSON',{get(){getters++;return()=>{body++;return'p';};}}),before=completeReadSnapshot(f);
 assert.equal(f.hub.readDefaultDispatchChild(project,lookup,f.authority.reader()).ok,false);assert.equal(getters,0);assert.equal(body,0);assert.deepEqual(completeReadSnapshot(f),before);
});
test('the original child reader cannot publish uncommitted rows through the actual revision UPSERT SDK',async t=>{
 let armed=false,observed,operationRead,action,seam=0,f;
 f=await fixture(t,{sqliteFactory(path){
  const db=new DatabaseSync(path),prepare=db.prepare.bind(db);
  db.prepare=sql=>{
   const statement=prepare(sql);
   if(sql.includes('INSERT INTO state_meta')){
    const run=statement.run.bind(statement);statement.run=(...args)=>{
     if(armed&&args[0]==='revision'){
      armed=false;seam++;
      const child=prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt'").all().map(row=>JSON.parse(row.state_json)).find(row=>row.kind==='ordinary_default_dispatch_child');assert.ok(child,'actual new child SQL must already be visible to this connection');
      observed=f.hub.readDefaultDispatchChild('p',{childKey:child.id,payloadHash:child.payloadHash},f.authority.reader());
      operationRead=f.read(action.head);
     }
     return run(...args);
    };
   }
   return statement;
  };
  return db;
 }});
 action=await f.admit();armed=true;const captured=f.capture(action.frame);assert.equal(captured.ok,true,JSON.stringify(captured));assert.equal(seam,1);
 console.log(JSON.stringify({test:'actual-sqlite-revision-upsert-child-read',seam,readOk:observed?.ok,error:observed?.error}));
 assert.equal(observed.ok,false);assert.equal(observed.error,'DURABLE_DISPATCH_OPERATION_BUSY');assert.equal(Object.getPrototypeOf(observed),null);const child=captured.operation.children[0];assert.equal(f.hub.readDefaultDispatchChild('p',{childKey:child.childKey,payloadHash:child.payloadHash},f.authority.reader()).ok,true);assert.deepEqual(f.effects,[]);
 console.log(JSON.stringify({test:'actual-sqlite-revision-upsert-operation-read',seam,readOk:operationRead?.ok,error:operationRead?.error}));
 assert.equal(operationRead.ok,false);assert.equal(operationRead.error,'DURABLE_DISPATCH_OPERATION_BUSY');assert.equal(Object.getPrototypeOf(operationRead),null);assert.equal(f.read(action.head).ok,true);
});
test('a rolled-back original Native save never publishes its staged child through the read seam',async t=>{
 const original=Error('actual revision UPSERT fault after child SQL'),state={armed:false,seam:0,lookup:undefined,read:undefined};let f;
 f=await fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),prepare=db.prepare.bind(db);db.prepare=sql=>{
  const statement=prepare(sql);if(sql.includes('INSERT INTO state_meta')){const run=statement.run.bind(statement);statement.run=(...args)=>{
   if(state.armed&&args[0]==='revision'){state.armed=false;state.seam++;const child=prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt'").all().map(row=>JSON.parse(row.state_json)).find(row=>row.kind==='ordinary_default_dispatch_child');assert.ok(child);state.lookup={childKey:child.id,payloadHash:child.payloadHash};state.read=f.hub.readDefaultDispatchChild('p',state.lookup,f.authority.reader());throw original;}
   return run(...args);
  };}return statement;
 };return db;}});
 const action=await f.admit(),before=f.rows();state.armed=true;assert.throws(()=>f.capture(action.frame),error=>error.name==='PersistenceCommitError'&&error.cause===original);assert.equal(state.seam,1);assert.equal(state.read.ok,false);assert.equal(state.read.error,'DURABLE_DISPATCH_OPERATION_BUSY');assert.deepEqual(f.rows(),before);f.reopen();assert.equal(f.hub.readDefaultDispatchChild('p',state.lookup,f.authority.reader()).ok,false);assert.deepEqual(f.rows(),before);assert.deepEqual(f.effects,[]);
});
test('original birth and plan readers cannot publish a task addition before Native COMMIT',async t=>{
 let armed=false,seam=0,births,plan,f;
 f=await fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),prepare=db.prepare.bind(db);db.prepare=sql=>{
  const statement=prepare(sql);if(sql.includes('INSERT INTO state_meta')){const run=statement.run.bind(statement);statement.run=(...args)=>{
   if(armed&&args[0]==='revision'){armed=false;seam++;births=f.hub.readDefaultDispatchBirths('p',f.authority.reader());plan=f.hub.readDefaultDispatchPlan('p',f.authority.reader());}
   return run(...args);
  };}return statement;
 };return db;}});
 const before=f.plan();armed=true;
 assert.equal(f.hub.handleHumanAddTasks('p',[{id:'b',title:'New staged task',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);assert.equal(seam,1);
 console.log(JSON.stringify({test:'actual-sqlite-addition-birth-plan-read',seam,births,plan}));
 assert.equal(births.ok,false);assert.equal(births.error,'DURABLE_DISPATCH_OPERATION_BUSY');assert.equal(plan.ok,false);assert.equal(plan.error,'DURABLE_DISPATCH_OPERATION_BUSY');
 assert.equal(f.hub.readDefaultDispatchBirths('p',f.authority.reader()).ok,true);assert.equal(f.plan().tasks.length,before.tasks.length+1);assert.deepEqual(f.effects,[]);
});

for(const point of ['resolve','current'])test('original '+point+' thrown Source error owns its standard Promise sidecar until physical settle',async t=>{
 let release,armed=false;const held=new Promise(yes=>{release=yes;}),failure=Error('original '+point+' SDK throw');Object.defineProperty(failure,'heldSdk',{value:held});
 const f=await fixture(t,{forceUnconfirmedCleanup:true,sourceFactory(original){return{resolve(frame){if(armed&&point==='resolve')throw failure;const reply=original.resolve(frame);return{data:reply.data,assertCurrent(){if(armed&&point==='current')throw failure;return reply.assertCurrent();}};}};}}),entry=await f.admit();armed=true;assert.equal(f.capture(entry.frame).ok,false);let closeError;try{f.hub.closePersistence();}catch(error){closeError=error;}finally{release();await new Promise(yes=>setImmediate(yes));}console.log(JSON.stringify({test:'original-source-error-sidecar',point,closeRejected:Boolean(closeError)}));assert.match(String(closeError),/BUSY/);
});

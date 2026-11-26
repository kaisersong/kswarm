import {originalResponseSdk} from './original-response-sdk-startup.js';
import {types} from 'node:util';
import {IntrinsicSet,IntrinsicWeakMap} from './intrinsic-collections.js';
import {captureDispatchBusinessData} from './dispatch-business-data.js';
import {createOriginalBrokerClient} from './original-broker-client.js';
// Actual SDK invocation and its passive read cut share one private birthplace.
// This is transport custody only, never B/Native/Host execution authority.
const sdkBirths=new IntrinsicWeakMap();
export function createOriginalPreparationBrokerClient(raw){
 const fields=hintFields(raw,['preparationSource','fetchSdk','httpBase','participantId','methods']);
 const source=fields.preparationSource.value,methods=fields.methods.value;
 if(typeof fields.httpBase.value!=='string')throw Error('ORIGINAL_PREPARATION_CLIENT_REQUIRED');
 if(!methods||typeof methods!=='object'||hintProxy(methods))throw Error('ORIGINAL_PREPARATION_CLIENT_REQUIRED');
 const rows=hintDescriptors(methods),names=hintKeys(rows),projected=hintCreate(null);
 for(let i=0;i<names.length;i++){
  const name=names[i],row=rows[name];
  if(name==='sendDefaultDispatchPreparation'||name==='sealDefaultDispatchPreparations'||name==='drainDefaultDispatchPreparations'||!hintOwn(row,'value'))throw Error('ORIGINAL_PREPARATION_CLIENT_REQUIRED');
  hintDefine(projected,name,{__proto__:null,value:row.value,enumerable:true});
 }
 let client;
 const lane=createPreparationHintLane(source,()=>client,fields.fetchSdk.value,fields.httpBase.value,fields.participantId.value);
 hintDefine(projected,'sendDefaultDispatchPreparation',{__proto__:null,value:lane.send,enumerable:true});
 hintDefine(projected,'sealDefaultDispatchPreparations',{__proto__:null,value:lane.seal,enumerable:true});
 hintDefine(projected,'drainDefaultDispatchPreparations',{__proto__:null,value:lane.drain,enumerable:true});
 client=createOriginalBrokerClient({preparationSource:source,methods:projected});
 sdkBirths.set(client,{__proto__:null,source,assertCut:lane.assertCut,completion:lane.completion});return client;
}
/** Pure original SDK read cut. It does not call source/Native/Host or wait for
 * body EOF. The B owner must independently requalify its source and admission. */
export function assertOriginalPreparationTransportCurrent(client,source,proof){
 const born=client&&typeof client==='object'?sdkBirths.get(client):undefined;
 if(!born||born.source!==source)throw Error('ORIGINAL_PREPARATION_SDK_CLIENT_REQUIRED');
 born.assertCut(proof);
}
export function originalPreparationClientMatchesSource(client,source){
 const born=client&&typeof client==='object'?sdkBirths.get(client):undefined;return born!==undefined&&born.source===source;
}
/** Observer bridge for an original caller which reserved its Root and retained
 * sendRaw BEFORE this call. No public then/constructor lookup or SDK grant. */
export function readOriginalPreparationTransportCompletion(client,source,proof,sendRaw){
 const born=client&&typeof client==='object'?sdkBirths.get(client):undefined;
 if(!born||born.source!==source)throw Error('ORIGINAL_PREPARATION_SDK_CLIENT_REQUIRED');
 return born.completion(proof,sendRaw);
}

const HintPromise=Promise,hintThen=Promise.prototype.then,hintPrototype=Promise.prototype;
const hintApply=Reflect.apply,hintGet=Reflect.get,hintDescriptor=Object.getOwnPropertyDescriptor;
const hintDescriptors=Object.getOwnPropertyDescriptors,hintKeys=Reflect.ownKeys,hintOwn=Object.hasOwn,hintProto=Object.getPrototypeOf;
const hintCreate=Object.create,hintDefine=Object.defineProperty,hintFreeze=Object.freeze,hintJson=JSON.stringify,hintSetPrototype=Object.setPrototypeOf;
const HintPrivateConstructor=hintFreeze({__proto__:null,[Symbol.species]:HintPromise});
// Use the original fetch Response body consumer, never an instance-provided
// json callback that can return an ACK while its actual stream is still live.
const hintResponseOk=originalResponseSdk.ok,hintResponseJson=originalResponseSdk.json;
function hintPrivate(promise){hintDefine(promise,'constructor',{__proto__:null,value:HintPrivateConstructor});hintDefine(promise,'then',{__proto__:null,value:hintThen});return promise;}
function hintRejected(error){return hintPrivate(new HintPromise((yes,no)=>no(error)));}
const hintProxy=types.isProxy,hintPromise=types.isPromise,hintAsync=types.isAsyncFunction;
const hintNativeError=types.isNativeError,hintArray=Array.isArray,hintObjectPrototype=Object.prototype,hintArrayPrototype=Array.prototype;
const hintErrorStack=hintDescriptor(Error(),'stack');
const hintAsyncPrototype=hintProto(async()=>{}),hintSpecies=hintDescriptor(HintPromise,Symbol.species);
const hintExec=Function.prototype.call.bind(RegExp.prototype.exec);
function hintStandard(raw){
 if(!hintPromise(raw)||hintProxy(raw)||hintProto(raw)!==hintPrototype||hintDescriptor(raw,'then')||hintDescriptor(raw,'constructor'))return false;
 const ctor=hintDescriptor(hintPrototype,'constructor'),species=hintDescriptor(HintPromise,Symbol.species);
 return !!ctor&&hintOwn(ctor,'value')&&ctor.value===HintPromise&&!!species&&!!hintSpecies&&!hintOwn(species,'value')&&species.get===hintSpecies.get&&species.set===hintSpecies.set;
}
function hintSync(fn){return typeof fn==='function'&&!hintProxy(fn)&&!hintAsync(fn)&&hintProto(fn)!==hintAsyncPrototype;}
function hintFields(raw,names){
 if(!raw||typeof raw!=='object'||hintProxy(raw))throw Error('DEFAULT_DISPATCH_TRANSPORT_DATA_INVALID');
 const rows=hintDescriptors(raw);if(hintKeys(rows).length!==names.length)throw Error('DEFAULT_DISPATCH_TRANSPORT_DATA_INVALID');
 for(let i=0;i<names.length;i++){const row=hintOwn(rows,names[i])?rows[names[i]]:undefined;if(!row||!hintOwn(row,'value')||!row.enumerable)throw Error('DEFAULT_DISPATCH_TRANSPORT_DATA_INVALID');}return rows;
}
function freezeHintData(value){if(value&&typeof value==='object'){const rows=hintDescriptors(value),names=hintKeys(rows);for(let i=0;i<names.length;i++)if(hintOwn(rows[names[i]],'value'))freezeHintData(rows[names[i]].value);hintFreeze(value);}return value;}
function createPreparationHintLane(source,actualClient,fetchSdk,httpBase,participantId){
 const owned=new IntrinsicSet(),unsafe=new IntrinsicSet(),observing=new IntrinsicSet(),calls=new IntrinsicWeakMap(),returns=new IntrinsicWeakMap(),unobservable=new IntrinsicSet(),completionWaiters=new IntrinsicSet();
 let active=0,sealed=false,unconfirmed=false,firstUnsafeFailure,drainPromise,drainYes,drainNo;
 function finishCompletions(){
  for(const row of completionWaiters){
   const call=row.call;
   if(!row.logicalDone||row.observerUnknown||call&&(call.owned.size||call.observing.size||call.unobservable.size))continue;
   completionWaiters.delete(row);
   if(call?.unconfirmed)row.no(Error('DEFAULT_DISPATCH_TRANSPORT_UNCONFIRMED',{cause:row.failed?row.failure:call.firstUnsafeFailure?.error}));
   else if(row.failed)row.no(row.failure);else row.yes();
  }
 }
 const finish=()=>{finishCompletions();if(!drainPromise||active||observing.size)return;if(unconfirmed||owned.size)drainNo(Error('DEFAULT_DISPATCH_TRANSPORT_UNCONFIRMED',{cause:firstUnsafeFailure?.error}));else drainYes();};
 function cannotObserve(raw){
  if(hintProxy(raw)||typeof raw==='function')return true;
  if(hintPromise(raw))return !hintStandard(raw);
  let cursor=raw;
  for(let depth=0;cursor&&depth<32;depth++){if(hintProxy(cursor)||hintDescriptor(cursor,'then'))return true;cursor=hintProto(cursor);}
  return cursor!==null;
 }
 function retain(raw,call,reason){
  unconfirmed=true;if(call)call.unconfirmed=true;
  if(reason==='incomplete'){unobservable.add(raw);call?.unobservable.add(raw);}
  if(raw===null||typeof raw!=='object'&&typeof raw!=='function'||(call?call.retained.has(raw):unsafe.has(raw)))return;unsafe.add(raw);call?.retained.add(raw);
  if(cannotObserve(raw)){unobservable.add(raw);call?.unobservable.add(raw);}
  if(!hintPromise(raw)||hintProxy(raw))return;observing.add(raw);call?.observing.add(raw);
  if(!hintStandard(raw))return;
  hintApply(hintThen,raw,[value=>{retainSettledValue(value,call);observing.delete(raw);call?.observing.delete(raw);finish();},error=>{firstUnsafeFailure??={error};if(call)call.firstUnsafeFailure??={error};retainSettledValue(error,call);observing.delete(raw);call?.observing.delete(raw);finish();}]);
 }
 function retainSettledValue(raw,call){
  // Settlement is another SDK return boundary. Scan data descriptors before
  // releasing its observer; an opaque newly returned resource has no EOF proof.
  try{captureDispatchBusinessData(raw,(value,reason)=>{
   if(!hintNativeError(value)||reason==='incomplete')retain(value,call,reason);if(hintProxy(value)||hintPromise(value))return;
   const proto=hintProto(value),nativeError=hintNativeError(value),rows=hintDescriptors(value),names=hintKeys(rows);
   const unknown=()=>{unconfirmed=true;if(call)call.unconfirmed=true;unobservable.add(value);call?.unobservable.add(value);};
   if(!nativeError&&proto!==null&&proto!==hintObjectPrototype&&!(hintArray(value)&&proto===hintArrayPrototype))unknown();
   for(let i=0;i<names.length;i++){
    const key=names[i],row=rows[key];if(hintOwn(row,'value'))continue;
    // Recent V8 versions use their original lazy stack accessor on ordinary
    // Errors. Other accessors remain opaque, including a custom cause/stack.
    if(!(nativeError&&key==='stack'&&hintErrorStack&&!hintOwn(hintErrorStack,'value')&&row.get===hintErrorStack.get&&row.set===hintErrorStack.set&&!row.enumerable))unknown();
   }
  });}catch{}
 }
 function local(){if(sealed)throw Error('DEFAULT_DISPATCH_TRANSPORT_SEALED');if(unconfirmed)throw Error('DEFAULT_DISPATCH_TRANSPORT_UNCONFIRMED');}
 const data=(raw,call)=>captureDispatchBusinessData(raw,(value,reason)=>retain(value,call,reason));
 function sdk(raw,settled=()=>{},call,returnedSdk=false){
  owned.add(raw);call?.owned.add(raw);
  if(!hintStandard(raw)){if(call)call.failed=true;retain(raw,call);return hintRejected(Error('DEFAULT_DISPATCH_TRANSPORT_SDK_UNCONFIRMED'));}
  const result=new HintPromise((yes,no)=>{hintApply(hintThen,raw,[value=>{owned.delete(raw);call?.owned.delete(raw);settled();finishCompletions();yes({__proto__:null,value});},error=>{if(call)call.failed=true;retainSettledValue(error,call);owned.delete(raw);call?.owned.delete(raw);settled();finishCompletions();no(error);}]);if(call&&returnedSdk)call.returnClassified=true;});
  return hintPrivate(result);
 }
 let resolve;
 if(source&&typeof source==='object'&&!hintProxy(source)){const row=hintDescriptor(source,'resolve');if(row&&hintOwn(row,'value')&&hintSync(row.value))resolve=row.value;}
 function envelope(raw,call){
  if(!raw||(typeof raw!=='object'&&typeof raw!=='function')||hintProxy(raw)){retain(raw,call);throw Error('DEFAULT_DISPATCH_TRANSPORT_SOURCE_UNCONFIRMED');}
  const rows=hintDescriptors(raw),names=hintKeys(rows);
  for(let i=0;i<names.length;i++){const key=names[i],row=rows[key];if(!hintOwn(row,'value')||key==='then'){retain(raw,call);continue;}if((key==='assertCurrent'||key==='consume')&&hintSync(row.value))continue;try{data(row.value,call);}catch{}}
  // Invalid outer shape cannot erase already-returned SDK siblings. Proxy
  // roots are opaque; every other root is safely scanned before rejection.
  if(typeof raw!=='object'||hintPromise(raw)||(hintProto(raw)!==Object.prototype&&hintProto(raw)!==null)){retain(raw,call);throw Error('DEFAULT_DISPATCH_TRANSPORT_SOURCE_UNCONFIRMED');}
  return hintFields(raw,['data','assertCurrent','consume']);
 }
 function voidCall(fn,receiver,call){
  if(!hintSync(fn)){retain(fn,call);throw Error('DEFAULT_DISPATCH_TRANSPORT_SYNCHRONOUS_REQUIRED');}
  const raw=hintApply(fn,receiver,[]);if(raw!==undefined){retain(raw,call);throw Error('DEFAULT_DISPATCH_TRANSPORT_SOURCE_UNCONFIRMED');}
 }
 function send(proof,requestSource){
  try{local();if(requestSource!=='scheduler')throw Error('DEFAULT_DISPATCH_TRANSPORT_SCHEDULER_REQUIRED');if(!resolve)throw Error('DEFAULT_DISPATCH_TRANSPORT_SOURCE_REQUIRED');}
  catch(error){return returned(hintRejected(error),proof,true);}
  if(proof!==null&&(typeof proof==='object'||typeof proof==='function')&&calls.has(proof))return returned(hintRejected(Error('DEFAULT_DISPATCH_TRANSPORT_PROOF_REQUIRED')),proof,true);
  active++; // Before any source SDK, including synchronous reentrant drain.
  const call={__proto__:null,invoked:false,returnClassified:false,failed:false,purpose:null,owned:new IntrinsicSet(),observing:new IntrinsicSet(),unobservable:new IntrinsicSet(),retained:new IntrinsicSet(),unconfirmed:false,firstUnsafeFailure:undefined};
  if(proof!==null&&(typeof proof==='object'||typeof proof==='function'))calls.set(proof,call);
  const run=(async()=>{
   try{
   const reply=hintApply(resolve,source,[proof,actualClient()]),rows=envelope(reply,call),request=data(rows.data.value,call);local();
   hintFields(request,['purpose','messageId','targetParticipantId','taskId','threadId','payload']);
   const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&hintExec(/[\x00-\x1f\x7f]/,value)===null;
   if((request.purpose!=='prepare'&&request.purpose!=='observe')||!id(request.messageId)||!id(request.targetParticipantId)||!id(request.taskId)||!id(request.threadId)||!id(participantId)||!request.payload||typeof request.payload!=='object'||request.payload.protocol!=='ordinary_default_dispatch_runtime_v1')throw Error('DEFAULT_DISPATCH_TRANSPORT_DATA_INVALID');
   call.purpose=request.purpose;
   const audience=[request.targetParticipantId];hintSetPrototype(audience,null);
   const body={__proto__:null,intentId:request.messageId,kind:request.purpose==='prepare'?'default_dispatch_prepare_v1':'default_dispatch_read_preparation_v1',opaque:true,fromParticipantId:participantId,taskId:request.taskId,threadId:request.threadId,to:{__proto__:null,mode:'participant',participants:audience},payload:request.payload};
   const input={__proto__:null,method:'POST',headers:{__proto__:null,'content-type':'application/json'},body:hintJson(body)},url=httpBase+'/intents';
   if(typeof fetchSdk!=='function'||hintProxy(fetchSdk))throw Error('DEFAULT_DISPATCH_TRANSPORT_SDK_UNCONFIRMED');
   voidCall(rows.assertCurrent.value,reply,call);local();voidCall(rows.consume.value,reply,call);local();
   // No projection, lookup or SDK after the final pure local gate.
   let fetchRaw;call.invoked=true;try{fetchRaw=hintApply(fetchSdk,undefined,[url,input]);}catch(error){unconfirmed=true;call.unconfirmed=true;unobservable.add(call);call.unobservable.add(call);firstUnsafeFailure??={error};call.firstUnsafeFailure??={error};throw error;}
   const response=(await sdk(fetchRaw,undefined,call,true)).value;
   owned.add(response);call.owned.add(response);
   if(!response||typeof response!=='object'||hintProxy(response)){retain(response,call);throw Error('DEFAULT_DISPATCH_TRANSPORT_RESPONSE_UNCONFIRMED');}
   try{
    const ok=hintApply(hintResponseOk,response,[]);if(!ok)call.failed=true;
    const result=freezeHintData(data((await sdk(hintApply(hintResponseJson,response,[]),()=>{owned.delete(response);call.owned.delete(response);},call)).value,call));
    if(!ok)throw Error('DEFAULT_DISPATCH_TRANSPORT_HTTP_FAILED',{cause:result});return result;
   }catch(error){if(call.owned.has(response)){unconfirmed=true;call.unconfirmed=true;firstUnsafeFailure??={error};call.firstUnsafeFailure??={error};}throw error;}
   }catch(error){call.failed=true;throw error;}
  })();
  hintPrivate(run);
  const out=new HintPromise((yes,no)=>{hintApply(hintThen,run,[value=>{active--;finish();yes(value);},error=>{active--;finish();no(error);}]);});
  return returned(hintPrivate(out),proof,false,call);
 }
 function returned(raw,proof,early,call){
  const row={__proto__:null,raw,proof,early,call,logicalDone:false,failed:false,failure:undefined,observerUnknown:false,bridge:undefined,yes:undefined,no:undefined};returns.set(raw,row);
  try{hintApply(hintThen,raw,[()=>{row.logicalDone=true;finishCompletions();},error=>{row.failed=true;row.failure=error;if(call)retainSettledValue(error,call);row.logicalDone=true;finishCompletions();}]);}
  catch(error){row.observerUnknown=true;unobservable.add(raw);firstUnsafeFailure??={error};}
  return raw;
 }
 function completion(proof,raw){
  const row=raw&&typeof raw==='object'?returns.get(raw):undefined;
  if(!row||row.proof!==proof)throw Error('DEFAULT_DISPATCH_TRANSPORT_RETURN_REQUIRED');
  if(row.bridge)return row.bridge;
  // Standard Native Promise, intentionally no HintPrivate constructor/then.
  row.bridge=new HintPromise((yes,no)=>{row.yes=yes;row.no=no;});completionWaiters.add(row);finishCompletions();return row.bridge;
 }
 function seal(){sealed=true;}
 function drain(){if(drainPromise)return drainPromise;seal();drainPromise=new HintPromise((yes,no)=>{drainYes=yes;drainNo=no;});hintPrivate(drainPromise);hintApply(hintThen,drainPromise,[()=>{},()=>{}]);finish();return drainPromise;}
 function assertCut(proof){
  local();const call=proof!==null&&(typeof proof==='object'||typeof proof==='function')?calls.get(proof):undefined;
  if(!call||call.purpose!=='prepare'||!call.invoked||!call.returnClassified||call.failed)throw Error('DEFAULT_DISPATCH_TRANSPORT_CALL_UNQUALIFIED');
 }
 return hintFreeze({send,seal,drain,assertCut,completion});
}

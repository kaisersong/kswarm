import {createHook,executionAsyncId} from 'node:async_hooks';
import {types} from 'node:util';
import {IntrinsicMap,IntrinsicSet,IntrinsicWeakMap} from './intrinsic-collections.js';
const P=Promise,then=P.prototype.then,apply=Reflect.apply,descriptor=Object.getOwnPropertyDescriptor,descriptors=Object.getOwnPropertyDescriptors,keys=Reflect.ownKeys,own=Object.hasOwn,prototype=Object.getPrototypeOf,define=Object.defineProperty;
const promisePrototype=P.prototype,species=descriptor(P,Symbol.species),isPromise=types.isPromise,isProxy=types.isProxy;
const rows=new IntrinsicMap(),ids=new IntrinsicSet(),byRaw=new IntrinsicWeakMap();
const nativeErrorStack=descriptor(Error(),'stack'),isNativeError=types.isNativeError,modulePrototype=WebAssembly.Module.prototype,instancePrototype=WebAssembly.Instance.prototype;let capturing=true,attaching=false,flushing=false,callbackDepth=0,unknown=false,closed=false,count=0,captureFailed=false,captureFailure;
const retained=[];const retain=value=>define(retained,String(retained.length),{__proto__:null,value,enumerable:true});
let resolveReady,rejectReady;const ready=new P((yes,no)=>{resolveReady=yes;rejectReady=no;});
// This is our private completion, never an SDK raw. Native await must not read
// an inherited constructor after a later response SDK changes the environment.
define(ready,'constructor',{__proto__:null,value:P});
let hook,disable,responseOk,responseJson;
function unconfirmed(value){unknown=true;retain(value);}
function standard(raw){
 if(!isPromise(raw)||isProxy(raw)||prototype(raw)!==promisePrototype)return false;
 const fields=descriptors(raw),ctor=descriptor(promisePrototype,'constructor'),current=descriptor(P,Symbol.species);
 if(own(fields,'then')||own(fields,'constructor')&&(!own(fields.constructor,'value')||fields.constructor.value!==P)||!ctor||!own(ctor,'value')||ctor.value!==P||!species||!current||own(current,'value')||current.get!==species.get||current.set!==species.set)return false;
 return true;
}
function reserveRaw(raw,id=Object.create(null)){
 const prior=byRaw.get(raw);if(prior)return prior;
 const row={__proto__:null,id,raw,observed:false,auxiliary:false};byRaw.set(raw,row);rows.set(id,row);retain(raw);return row;
}
function inventoryFields(value){
 if(!isNativeError(value))return descriptors(value);
 // V8's lazy stack descriptor may format other fields. Inventory every
 // non-stack field first and never ask for stack after an unknown accessor.
 const fields=Object.create(null),names=keys(value);let accessor=false;
 for(let i=0;i<names.length;i++){const key=names[i];if(key==='stack')continue;const field=descriptor(value,key);if(!field){unconfirmed(value);continue;}define(fields,key,{__proto__:null,value:field,enumerable:true});if(!own(field,'value'))accessor=true;}
 if(accessor)unconfirmed(value);else{const stack=descriptor(value,'stack');if(stack)define(fields,'stack',{__proto__:null,value:stack,enumerable:true});}
 return fields;
}
function inventory(value,seen=new IntrinsicSet(),depth=0){
 if(value===null||typeof value!=='object'&&typeof value!=='function'||seen.has(value))return;
 seen.add(value);if(depth>128||seen.size>65536||isProxy(value)){unconfirmed(value);return;}
 if(isPromise(value))reserveRaw(value);
 else if(typeof value==='function'){unconfirmed(value);return;}
 else {const proto=prototype(value);if(proto!==Object.prototype&&proto!==null&&proto!==Array.prototype&&!isNativeError(value)&&proto!==modulePrototype&&proto!==instancePrototype){unconfirmed(value);return;}}
 const fields=inventoryFields(value),names=keys(fields);
 for(let i=0;i<names.length;i++){
  const key=names[i],field=fields[key];
  if(!own(field,'value')){
   if(isNativeError(value)&&key==='stack'&&nativeErrorStack&&!own(nativeErrorStack,'value')&&field.get===nativeErrorStack.get&&field.set===nativeErrorStack.set)continue;
   unconfirmed(value);continue;
  }
  if(isPromise(value)&&key==='constructor'&&field.value===P)continue;
  inventory(field.value,seen,depth+1);
 }
}
function inventoryNamespace(value){
 const seen=new IntrinsicSet(),work=[];const push=value=>{if(work.length>=65536){unconfirmed(value);return;}define(work,String(work.length),{__proto__:null,value,enumerable:true});};push(value);
 try{
  for(let cursor=0;cursor<work.length;cursor++){
   const current=work[cursor];if(current===null||typeof current!=='object'&&typeof current!=='function'||seen.has(current))continue;
   seen.add(current);if(seen.size>65536){unconfirmed(current);return;}if(isProxy(current)){unconfirmed(current);continue;}
   if(isPromise(current)){inventory(current);continue;}
   const fields=descriptors(current),names=keys(fields);
   for(let i=0;i<names.length;i++){
    const key=names[i],field=fields[key];
    // SDK API accessors are metadata; never invoke them. Their own visible
    // sidecar graph is still held, with an explicit bounded worklist.
    if(!own(field,'value')){if(field.get)push(field.get);if(field.set)push(field.set);continue;}
    if(typeof field.value==='function'||typeof current==='function'&&key==='prototype')push(field.value);
    else inventory(field.value);
   }
  }
 }catch(error){unconfirmed(error);}
}
function knownCut(){
 if(capturing||attaching||flushing||callbackDepth||rows.size||unknown||closed)return;
 try{
  const raw=apply(disable,hook,[]);if(raw!==hook){unconfirmed(raw);return;}
  // off itself is an SDK call: a synchronous reentry cannot certify the old
  // frontier after it created a new producer or returned an unclassified raw.
  if(rows.size||callbackDepth||capturing||attaching||unknown){unconfirmed(hook);return;}
  closed=true;if(captureFailed)rejectReady(captureFailure);else resolveReady();
 }catch(error){unconfirmed(error);}
}
function flush(){
 if(flushing||attaching||capturing||closed)return;flushing=true;
 try{
  for(;;){
  const batch=[];for(const row of rows.values())if(!row.observed)define(batch,String(batch.length),{__proto__:null,value:row,enumerable:true});
  if(!batch.length)break;
  for(let i=0;i<batch.length;i++){
   const row=batch[i];if(row.observed||row.auxiliary)continue;row.observed=true;
   if(!standard(row.raw)){unconfirmed(row.raw);continue;}
   inventory(row.raw);attaching=true;
   try{
    const done=()=>{rows.delete(row.id);};
    // init only reserves. Here the original SDK call / callback has returned,
    // so the actual Native Promise is fully constructed before observation.
    const child=apply(then,row.raw,[value=>{try{inventory(value);}catch(error){unconfirmed(error);}finally{done();}},error=>{if(!captureFailed){captureFailed=true;captureFailure=error;}retain(error);try{inventory(error);}catch(cause){unconfirmed(cause);}finally{done();}}]);
    let matched=false;for(const candidate of rows.values())if(candidate.raw===child){candidate.auxiliary=true;rows.delete(candidate.id);matched=true;break;}
    if(!matched)unconfirmed(child);
   }catch(error){unconfirmed(error);}finally{attaching=false;}
  }
  }
 }catch(error){unconfirmed(error);}finally{flushing=false;}
 knownCut();
}
hook=createHook({
 init(id,type,trigger,resource){
  try{
   if(closed||!capturing&&!attaching&&!ids.has(trigger)&&!ids.has(executionAsyncId()))return;
   ids.add(id);retain(resource);
   if(++count>65536||type!=='PROMISE'){unconfirmed(resource);return;}
   reserveRaw(resource,id);
  }catch(error){unconfirmed(error);}
 },
 before(id){try{if(ids.has(id))callbackDepth++;}catch(error){unconfirmed(error);}},
 after(id){try{if(ids.has(id)){if(callbackDepth<1){unconfirmed(id);return;}callbackDepth--;flush();}}catch(error){unconfirmed(error);}},
});
try{
 const proto=prototype(hook),enable=descriptor(proto,'enable');disable=descriptor(proto,'disable')?.value;
 if(!enable||!own(enable,'value')||typeof enable.value!=='function'||typeof disable!=='function')throw Error('ORIGINAL_RESPONSE_SDK_HOOK_UNAVAILABLE');
 const enabled=apply(enable.value,hook,[]);if(enabled!==hook){unconfirmed(enabled);throw Error('ORIGINAL_RESPONSE_SDK_HOOK_UNAVAILABLE');}
 // Even getOwnPropertyDescriptor on Node's exotic global can start Undici.
 // All actual compile -> instantiate Promise resources are owned from here.
 const ResponseSdk=globalThis.Response;retain(ResponseSdk);
 if(typeof ResponseSdk!=='function'||isProxy(ResponseSdk))throw Error('ORIGINAL_RESPONSE_SDK_UNAVAILABLE');
 const protoRow=descriptor(ResponseSdk,'prototype');
 if(!protoRow||!own(protoRow,'value')||isProxy(protoRow.value))throw Error('ORIGINAL_RESPONSE_SDK_UNAVAILABLE');
 const ok=descriptor(protoRow.value,'ok'),json=descriptor(protoRow.value,'json');
 if(!ok||typeof ok.get!=='function'||!json||!own(json,'value')||typeof json.value!=='function')throw Error('ORIGINAL_RESPONSE_SDK_UNAVAILABLE');
 inventoryNamespace(ResponseSdk);inventoryNamespace(protoRow.value);
 responseOk=ok.get;responseJson=json.value;
}catch(error){captureFailed=true;captureFailure=error;retain(error);}
finally{capturing=false;flush();}
// No caller can get an original Net/Endpoint export before this original SDK
// initialization frontier is known. This does not grant Host/N/native profile.
await ready;
export const originalResponseSdk=Object.freeze({__proto__:null,ok:responseOk,json:responseJson});

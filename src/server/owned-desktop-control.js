import {isOwnedDefaultDispatchBusiness} from './owned-default-dispatch-business.js';
import {dispatchBusinessProtocolTag} from './default-dispatch-business-data.js';
import {isPersistenceCommitError} from '../core/persistence.js';
import {randomBytes} from 'node:crypto';
import {types} from 'node:util';
import {captureExecutionData} from '../core/task-execution-content.js';
import {createProjectInputAuthority} from '../core/project-input-authority.js';
const V1='kswarm_owned_desktop_control_v1',V2='kswarm_owned_desktop_control_v2';
const NativePromise=Promise,NativeSet=Set,NativeMap=Map,NativeArray=Array,apply=Reflect.apply,then=Promise.prototype.then;
const own=Object.hasOwn,keysOf=Object.keys,descriptor=Object.getOwnPropertyDescriptor,descriptors=Object.getOwnPropertyDescriptors,prototype=Object.getPrototypeOf,define=Object.defineProperty,freeze=Object.freeze,create=Object.create,setPrototype=Object.setPrototypeOf;
const json=JSON.stringify,byteLength=Buffer.byteLength,isArray=Array.isArray,isProxy=types.isProxy,isPromise=types.isPromise,isAsync=types.isAsyncFunction,isSafeInteger=Number.isSafeInteger;
const add=Set.prototype.add,remove=Set.prototype.delete,values=Set.prototype.values,next=prototype(new Set().values()).next;
const hasMap=Map.prototype.has,setMap=Map.prototype.set,charCode=String.prototype.charCodeAt,slice=String.prototype.slice;
const promisePrototype=NativePromise.prototype,species=Symbol.species,initialSpecies=descriptor(NativePromise,species),asyncPrototype=prototype(async()=>{});
function set(){const rows=new NativeSet();return freeze({add(value){apply(add,rows,[value]);},delete(value){apply(remove,rows,[value]);},snapshot(){const result=[],iterator=apply(values,rows,[]);for(;;){const row=apply(next,iterator,[]);if(row.done)return result;put(result,result.length,row.value);}}});}
function put(object,key,value){define(object,key,{__proto__:null,value,enumerable:true,configurable:true,writable:true});}
const fail=()=>{throw Error('OWNED_CONTROL_PROTOCOL_INVALID');};
function hex(value){if(typeof value!=='string'||value.length!==64)return false;for(let i=0;i<64;i++){const n=apply(charCode,value,[i]);if(!(n>=48&&n<=57||n>=97&&n<=102))return false;}return true;}
function keys(value,expected){if(!value||typeof value!=='object'||isArray(value)||keysOf(value).length!==expected.length)return false;for(let i=0;i<expected.length;i++)if(!own(value,expected[i]))return false;return true;}
const validScope=value=>keys(value,['profileId','workspaceId'])&&hex(value.profileId)&&hex(value.workspaceId);
const sameScope=(a,b)=>a.profileId===b.profileId&&a.workspaceId===b.workspaceId;
function wireCopy(raw){if(!raw||typeof raw!=='object')return raw;const array=isArray(raw),out=array?new NativeArray(raw.length):create(null),names=keysOf(raw);if(array)setPrototype(out,null);for(let i=0;i<names.length;i++){const key=names[i];put(out,key,wireCopy(raw[key]));}return out;}
function data(value){const result=wireCopy(captureExecutionData(value));if(byteLength(json(result),'utf8')>65536)fail();return result;}
function standardPromise(value){
 if(!isPromise(value)||isProxy(value)||prototype(value)!==promisePrototype)return false;
 const direct=descriptor(value,'constructor'),inherited=descriptor(promisePrototype,'constructor'),current=descriptor(NativePromise,species);
 return !!inherited&&own(inherited,'value')&&inherited.value===NativePromise&&(!direct||own(direct,'value')&&direct.value===NativePromise)&&!!current&&!!initialSpecies&&!own(current,'value')&&!own(initialSpecies,'value')&&current.get===initialSpecies.get&&current.set===initialSpecies.set&&current.enumerable===initialSpecies.enumerable&&current.configurable===initialSpecies.configurable;
}
function errorData(error,depth=0){
 if(depth>4||!error||typeof error!=='object'||isProxy(error))return{name:'Error',message:'remote operation failed',code:'OWNED_CONTROL_REMOTE_ERROR',durableCommitted:false};
 const fields=descriptors(error),value=key=>fields[key]&&own(fields[key],'value')?fields[key].value:undefined;
 const text=(key,fallback)=>typeof value(key)==='string'?apply(slice,value(key),[0,2048]):fallback;
 return{name:text('name','Error'),message:text('message','remote operation failed'),code:text('code','OWNED_CONTROL_REMOTE_ERROR'),durableCommitted:value('durableCommitted')===true,...(depth<4&&value('cause')?{cause:errorData(value('cause'),depth+1)}:{})};
}
function processDataMethod(name){let cursor=process;for(let depth=0;cursor&&depth<16;depth++){if(isProxy(cursor))return undefined;const row=descriptor(cursor,name);if(row)return own(row,'value')?row.value:undefined;cursor=prototype(cursor);}return undefined;}
/** Only the original parent IPC descriptor is an authority. A version/capability
 * is wire availability, never an HTTP credential, actor, PID or Native grant. */
export function installOwnedDesktopControl({hub,scope,onPersistenceCommitFailure,dispatchBusiness=null}){
 const send=processDataMethod('send'),subscribe=processDataMethod('on');
 if(typeof subscribe!=='function'||isProxy(subscribe)||isAsync(subscribe)||prototype(subscribe)===asyncPrototype)return freeze({seal(){}});
 if(!process.channel||!process.connected||typeof send!=='function'||isProxy(send)||isAsync(send)||prototype(send)===asyncPrototype||!validScope(scope))return freeze({seal(){}});
 const domain=data(scope),authority=createProjectInputAuthority(domain),control=authority.reader(),instance=randomBytes(32).toString('hex');
 const commitFailure=onPersistenceCommitFailure,active=set(),sends=set(),unknownRaws=set(),failedQueued=set(),causes=new NativeMap();
 let selected=null,nonce=null,sequence=0,busy=false,replySending=false,queued=null,businessSealed=false,terminalMode=null,prefix=null;
 const remember=(kind,error)=>{if(!apply(hasMap,causes,[kind]))apply(setMap,causes,[kind,error]);};
 function cancelQueued(error){if(!queued)return;const row=queued;queued=null;row.failure=error;row.notExecuted=true;failedQueued.add(row);active.delete(row);row.complete(false);}
 function terminal(kind,error){remember(kind,error);terminalMode??=kind;businessSealed=true;cancelQueued(error);}
 const seal=()=>terminal('lifecycle',Error('OWNED_CONTROL_CLOSED'));
 function publish(frame,terminalNotification=false){
  let copied;try{copied=data(frame);}catch(error){terminal('encode',error);return new NativePromise(resolve=>resolve(false));}
  let complete;const work=new NativePromise(resolve=>{complete=resolve;});
  const row={frame:copied,work,callbackDone:false,returned:false,rawDone:true,notInvoked:true,ok:true,done:false,terminalNotification};sends.add(row);
  function finish(){if(row.done||!row.returned||!row.rawDone||!row.notInvoked&&!row.callbackDone)return;row.done=true;sends.delete(row);complete(row.ok);}
  try{
   if(!process.connected)throw Error('OWNED_CONTROL_CLOSED');row.notInvoked=false;
   const result=apply(send,process,[copied,error=>{row.callbackDone=true;if(error){row.ok=false;terminal('send',error);}finish();}]);
   if(result!==true&&result!==false){
    row.ok=false;terminal('send_return',Error('OWNED_CONTROL_SEND_RETURN_UNKNOWN'));
    if(result&&typeof result==='object'||typeof result==='function'){
     row.raw=result;row.rawDone=false;
     if(standardPromise(result)){
      try{void apply(then,result,[()=>{row.rawDone=true;finish();},error=>{remember('send_raw',error);row.rawDone=true;finish();}]);}
      catch(error){unknownRaws.add(result);remember('send_observation',error);}
     }else unknownRaws.add(result);
    }
   }
   row.returned=true;finish();
  }catch(error){row.ok=false;row.returned=true;terminal('send',error);finish();}
  return work;
 }
 function fault(error){terminal('protocol',error);publish({protocol:selected??V1,type:'fault',error:{code:'OWNED_CONTROL_PROTOCOL_INVALID'}});}
 function reserve(frame){let complete;const completion=new NativePromise(resolve=>{complete=resolve;});const row={frame,completion,complete,notExecuted:false};active.add(row);return row;}
 function observable(value){if(standardPromise(value))return true;unknownRaws.add(value);terminal('observation',Error('OWNED_CONTROL_TAIL_UNKNOWN'));return false;}
 function execute(row){
  if(terminalMode){row.failure=Error('OWNED_CONTROL_CLOSED');row.notExecuted=true;failedQueued.add(row);active.delete(row);row.complete(false);return;}
  if(selected===V1)sequence=row.frame.id;busy=true;replySending=false;
  const frame=row.frame,context=freeze({requestSource:'user',projectInputAuthority:control});
  const work=(async()=>{
   let ok=true;
   try{
    let result;if(frame.op==='prepare_initial_plan_writer')result=hub.prepareFreshInitialPlanAcceptanceWriter(context);else if(frame.op==='inspect_writer')result=hub.inspectDefaultDispatchWriter(context);else{const migration=hub.migrateDefaultDispatchWriter(context);if(!observable(migration)){row.unknown=true;return;}result=await migration;}
    replySending=true;const sending=publish({protocol:selected,type:'response',nonce,instance,scope:domain,id:frame.id,op:frame.op,result});if(!observable(sending)){row.unknown=true;return;}ok=await sending;
   }catch(error){
    remember('operation',error);
    // Close the execution gate BEFORE invoking any error serializer/SDK hook.
    const nativeFailure=isPersistenceCommitError(error);if(nativeFailure)terminal('native',error);else if(selected===V2)terminal('operation',error);
    replySending=true;const sending=publish({protocol:selected,type:'response',nonce,instance,scope:domain,id:frame.id,op:frame.op,error:errorData(error)});
    if(nativeFailure&&typeof commitFailure==='function')try{apply(commitFailure,undefined,[error]);}catch(failure){remember('fail_stop',failure);}
    if(!observable(sending)){row.unknown=true;return;}ok=await sending;
   }finally{
    if(row.unknown)return;
    busy=false;replySending=false;active.delete(row);row.complete(ok&&!terminalMode);
    if(queued){const next=queued;queued=null;if(terminalMode||selected===V1&&businessSealed){next.notExecuted=true;next.failure=Error('OWNED_CONTROL_CLOSED');failedQueued.add(next);active.delete(next);next.complete(false);}else execute(next);}
   }
  })();row.work=work;
  try{if(!standardPromise(work))throw Error('OWNED_CONTROL_WORK_TAIL_UNKNOWN');void apply(then,work,[()=>{},error=>terminal('tail',error)]);}catch(error){unknownRaws.add(work);terminal('tail_observation',error);}
 }
 async function waitPrefix(reservation){
  // Root completions include publishes not yet created when the cut was taken.
  for(let i=0;i<reservation.roots.length;i++){const raw=reservation.roots[i].completion;if(!observable(raw)||!await raw)return;}
  for(let i=0;i<reservation.sends.length;i++){const raw=reservation.sends[i].work;if(!observable(raw)||!await raw)return;}
  if(terminalMode||prefix!==reservation||!process.connected)return;
  reservation.notifying=true;
  // This terminal notification is OUTSIDE the prefix it proves. Its own tail
  // stays in the original KS owner's sends set; no ACK-of-ACK is required.
  reservation.notification=publish({protocol:V2,type:'prefix_drained',nonce,scope:domain,instance,throughId:reservation.throughId,sealNonce:reservation.sealNonce},true);
  if(!observable(reservation.notification))return;await reservation.notification;
 }
 function onMessage(raw,handle){
  try{
   if(handle!==undefined&&handle!==null){unknownRaws.add(handle);fail();}
   if(isOwnedDefaultDispatchBusiness(dispatchBusiness)&&dispatchBusinessProtocolTag(raw)==='kswarm_dispatch_business_v1')return;
   const frame=data(raw);
   if(!validScope(frame.scope)||!sameScope(frame.scope,domain)||!hex(frame.nonce))fail();
   if(frame.type==='hello'){
    if(businessSealed||nonce!==null||selected!==null||!keys(frame,['protocol','type','nonce','scope'])||frame.protocol!==V1&&frame.protocol!==V2)fail();
    selected=frame.protocol;nonce=frame.nonce;
    publish({protocol:selected,type:'hello_ack',nonce,scope:domain,instance,...(selected===V2?{capabilities:['prefix_seal_v1']}:{})});return;
   }
   if(selected===null||frame.protocol!==selected||frame.nonce!==nonce||frame.instance!==instance)fail();
   if(frame.type==='seal_prefix'){
    if(selected!==V2||!keys(frame,['protocol','type','nonce','scope','instance','throughId','sealNonce'])||!isSafeInteger(frame.throughId)||frame.throughId<0||frame.throughId!==sequence||!hex(frame.sealNonce)||prefix)fail();
    businessSealed=true;
    const reservation={throughId:frame.throughId,sealNonce:frame.sealNonce,roots:active.snapshot(),sends:sends.snapshot(),notifying:false};prefix=reservation;
    const work=waitPrefix(reservation);reservation.work=work;
    try{if(!standardPromise(work))throw Error('OWNED_CONTROL_PREFIX_TAIL_UNKNOWN');void apply(then,work,[()=>{},error=>terminal('prefix',error)]);}catch(error){unknownRaws.add(work);terminal('prefix_observation',error);}return;
   }
   if(businessSealed)return;
   if(!keys(frame,['protocol','type','nonce','scope','instance','id','op'])||frame.type!=='request'||!isSafeInteger(frame.id)||frame.id!==sequence+1)fail();
   if(frame.op!=='prepare_initial_plan_writer'&&frame.op!=='inspect_writer'&&(selected!==V1||frame.op!=='migrate_default_dispatch_writer'))fail();
   if(busy&&(!replySending||queued!==null))fail();
   const row=reserve(frame);if(selected===V2)sequence=frame.id;
   if(busy){queued=row;return;}execute(row);
  }catch(error){fault(error);}
 }
 apply(subscribe,process,['message',onMessage]);apply(subscribe,process,['disconnect',seal]);
 return freeze({seal});
}

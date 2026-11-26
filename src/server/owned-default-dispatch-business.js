import {captureDefaultDispatchActionRecord} from '../core/default-dispatch-action-data.js';
import {randomBytes} from 'node:crypto';
import {types} from 'node:util';
import {IntrinsicMap,IntrinsicSet,IntrinsicWeakMap} from '../core/intrinsic-collections.js';
import {bindHubDefaultDispatchBusiness,bindHubDefaultDispatchPreparation,bindHubDshBusiness} from '../core/hub.js';
import {protocolDigest} from '../core/project-protocol.js';
import {runtimePreparationTarget} from '../core/default-dispatch-runtime-data.js';
import {createProjectInputAuthority} from '../core/project-input-authority.js';
import {isPersistenceCommitError} from '../core/persistence.js';
import {captureDispatchBusinessData,dispatchBusinessProtocolTag} from './default-dispatch-business-data.js';
const protocol='kswarm_dispatch_business_v1',configV1='kswarm_owned_desktop_control_v1',configV2='kswarm_owned_desktop_control_v2';
const NativePromise=Promise,nativeThen=Promise.prototype.then,apply=Reflect.apply,descriptor=Object.getOwnPropertyDescriptor,descriptors=Object.getOwnPropertyDescriptors,prototype=Object.getPrototypeOf;
const freeze=Object.freeze,create=Object.create,define=Object.defineProperty,own=Object.hasOwn,keys=Object.keys;
const isProxy=types.isProxy,isPromise=types.isPromise,isAsync=types.isAsyncFunction,safeInteger=Number.isSafeInteger,isArray=Array.isArray;
const dshJson=JSON.stringify,dshParse=JSON.parse;
const exec=Function.prototype.call.bind(RegExp.prototype.exec),trim=Function.prototype.call.bind(String.prototype.trim);
const promisePrototype=NativePromise.prototype,species=Symbol.species,originalSpecies=descriptor(NativePromise,species),asyncPrototype=prototype(async()=>{});
function processDataMethod(name){let cursor=process;for(let depth=0;cursor&&depth<16;depth++){if(isProxy(cursor))return undefined;const row=descriptor(cursor,name);if(row)return own(row,'value')?row.value:undefined;cursor=prototype(cursor);}return undefined;}
const on=processDataMethod('on'),off=processDataMethod('off'),controllers=new IntrinsicWeakMap();
const synchronous=fn=>typeof fn==='function'&&!isProxy(fn)&&!isAsync(fn)&&prototype(fn)!==asyncPrototype;
const put=(array,value)=>define(array,String(array.length),{__proto__:null,value,writable:true,configurable:true,enumerable:true});
const snapshot=rows=>{const out=[];for(const value of rows)put(out,value);return out;};
const invalid=()=>Error('DISPATCH_BUSINESS_PROTOCOL_INVALID');
const preparationRefusals=new IntrinsicWeakMap();
function refusePreparation(code){const error=Error(code);preparationRefusals.set(error,code);throw error;}
const dshOperation=op=>op==='prepare_dsh_owner'||op==='read_dsh_domain'||op==='apply_dsh_control'||op==='apply_dsh_command'||op==='prepare_dsh_slot'||op==='read_dsh_basis'||op==='read_dsh_work'||op==='read_dsh_slot'||op==='stage_dsh_draft'||op==='commit_dsh_draft'||op==='read_dsh_draft';
const preparationOperation=op=>op==='read_preparation_basis'||op==='prepare_intent'||op==='admit_send'||op==='read_prepare_call'||op==='ack_prepared'||op==='register_host'||op==='finish_host_no_effect';
const exact=(value,names)=>{if(!value||typeof value!=='object'||isArray(value)||keys(value).length!==names.length)return false;for(let i=0;i<names.length;i++)if(!own(value,names[i]))return false;return true;};
const hex=value=>typeof value==='string'&&exec(/^[a-f0-9]{64}$/,value)!==null;
const validScope=value=>exact(value,['profileId','workspaceId'])&&hex(value.profileId)&&hex(value.workspaceId);
const sameScope=(a,b)=>a.profileId===b.profileId&&a.workspaceId===b.workspaceId;
function standard(value){
 if(!isPromise(value)||isProxy(value)||prototype(value)!==promisePrototype||descriptor(value,'then'))return false;
 const direct=descriptor(value,'constructor'),inherited=descriptor(promisePrototype,'constructor'),current=descriptor(NativePromise,species);
 return !!inherited&&own(inherited,'value')&&inherited.value===NativePromise&&(!direct||own(direct,'value')&&direct.value===NativePromise)&&!!current&&!!originalSpecies&&!own(current,'value')&&!own(originalSpecies,'value')&&current.get===originalSpecies.get&&current.set===originalSpecies.set;
}
function errorData(error,committed=false,depth=0){
 if(!error||typeof error!=='object'||isProxy(error)||depth>4)return{name:'Error',message:'business operation failed',code:'DISPATCH_BUSINESS_REMOTE_ERROR',durableCommitted:committed};
 const rows=descriptors(error),get=name=>own(rows,name)&&own(rows[name],'value')?rows[name].value:undefined;
 const text=(name,fallback)=>typeof get(name)==='string'?get(name).slice(0,2048):fallback;
 return{name:text('name','Error'),message:text('message','business operation failed'),code:text('code','DISPATCH_BUSINESS_REMOTE_ERROR'),durableCommitted:committed||get('durableCommitted')===true,...(depth<4&&get('cause')?{cause:errorData(get('cause'),false,depth+1)}:{})};
}
/** Routing recognition only; the private controller is never a business user
 * proof. A tag or a copied controller cannot opt a config receiver into it. */
export function isOwnedDefaultDispatchBusiness(controller){return controllers.has(controller);}
/** Original Server composition. Only the inherited parent descriptor admits
 * requests; source frames cannot be minted through a public data/admit API. */
export function createOwnedDefaultDispatchBusiness({scope}){
 const domain=captureDispatchBusinessData(scope);if(!validScope(domain))throw invalid();
 const frames=new IntrinsicWeakMap(),preparationFrames=new IntrinsicWeakMap(),dshFrames=new IntrinsicWeakMap(),dshBudgets=new IntrinsicWeakMap();let installed=false,state,preparationState;
 const source=freeze({resolve(frame){if(!state||!state.available)throw Error('DURABLE_DISPATCH_BUSINESS_FRAME_REQUIRED');const entry=frames.get(frame);if(!entry)throw Error('DURABLE_DISPATCH_BUSINESS_FRAME_REQUIRED');entry.assertCurrent();return{data:entry.fact,assertCurrent:entry.assertCurrent};}});
 const preparationSource=freeze({resolve(frame,purpose){const entry=preparationFrames.get(frame);if(!entry||entry.purpose!==purpose||!(purpose==='finish_host_no_effect'?preparationState?.settlementAvailable:preparationState?.available))throw Error('DURABLE_DISPATCH_PREPARATION_FRAME_REQUIRED');entry.assertCurrent();return{data:entry.data,assertCurrent:entry.assertCurrent};}});
 const dshSource=freeze({resolve(frame,purpose){const entry=dshFrames.get(frame);if(!entry||entry.purpose!==purpose)throw Error('DSH_BUSINESS_PRIVATE_FRAME_REQUIRED');entry.assertCurrent();return{data:entry.data,budgetProof:entry.budgetProof,assertCurrent:entry.assertCurrent};}});
 const dshBudgetSource=freeze({resolve(proof){const entry=dshBudgets.get(proof);if(!entry)throw Error('DSH_BUSINESS_PRIVATE_BUDGET_REQUIRED');entry.assertCurrent();return{data:entry.data,assertCurrent:entry.assertCurrent};}});
 function install(hub,{onPersistenceCommitFailure}={}){
  const ports=bindHubDefaultDispatchBusiness(hub,source);
  let dshPorts;try{dshPorts=bindHubDshBusiness(hub,dshSource,dshBudgetSource);}catch(error){if(error?.message!=='DSH_BUSINESS_HUB_OWNER_REQUIRED')throw error;}
  if(installed)throw Error('DISPATCH_BUSINESS_ALREADY_INSTALLED');installed=true;
  const sendRow=descriptor(process,'send'),send=sendRow&&own(sendRow,'value')?sendRow.value:undefined;
  if(!process.channel||!process.connected||!synchronous(send)||!synchronous(on)||!synchronous(off)){
   const unavailable=freeze({available:false,seal(){},drain(){return new NativePromise(yes=>yes());}});state=unavailable;return unavailable;
  }
  const reader=createProjectInputAuthority(domain).reader(),actor=freeze({requestSource:'user',actorId:'desktop-user:'+domain.profileId});
  const active=new IntrinsicSet(),sends=new IntrinsicSet(),tails=new IntrinsicSet(),unknown=new IntrinsicSet(),errors=[],cleanups=[];
  let closeStarted=false,faultSent=false,hasFirstError=false;let nonce,sequence=0,instance='',sealed=false,terminal=false,firstError,executing=false,installing=true,disposed=false,prefix,closing;
  let preparationPorts,preparationInstallAttempted=false,preparationTerminated=false;
  const lifetimes=new IntrinsicMap(),workBindings=new IntrinsicMap();
  preparationState={__proto__:null,available:false,settlementAvailable:false};
  const bytes=randomBytes(32),alphabet='0123456789abcdef';for(let i=0;i<bytes.length;i++)instance+=alphabet[bytes[i]>>>4]+alphabet[bytes[i]&15];
  function remember(error){if(!hasFirstError){hasFirstError=true;firstError=error;}for(let i=0;i<errors.length;i++)if(errors[i]===error)return;put(errors,error);}
  function fault(error){remember(error);sealed=true;terminal=true;}
  function retain(raw){
   if(!standard(raw)){unknown.add(raw);return;}
   let complete;const row={raw,completion:new NativePromise(yes=>{complete=yes;})};tails.add(row);
   try{apply(nativeThen,raw,[()=>{tails.delete(row);complete();},error=>{remember(error);tails.delete(row);complete();}]);}catch(error){unknown.add(raw);remember(error);tails.delete(row);}
  }
  const data=raw=>captureDispatchBusinessData(raw,raw=>{retain(raw);fault(Error('DISPATCH_BUSINESS_RAW_UNCONFIRMED'));});
  function observe(raw,yes,no){
   if(!standard(raw)){unknown.add(raw);fault(Error('DISPATCH_BUSINESS_OBSERVER_UNCONFIRMED'));return false;}
   try{apply(nativeThen,raw,[yes,no]);return true;}catch(error){unknown.add(raw);fault(error);return false;}
  }
  function qualified(raw){if(standard(raw))return true;unknown.add(raw);fault(Error('DISPATCH_BUSINESS_OBSERVER_UNCONFIRMED'));return false;}
  function checked(raw){if(!qualified(raw))throw Error('DISPATCH_BUSINESS_CLOSE_UNCONFIRMED',{cause:firstError});return raw;}
  function reserve(frame){let complete;const row={frame,completion:new NativePromise(yes=>{complete=yes;}),complete(){active.delete(row);complete();},executing:false,durableCommitted:false};active.add(row);return row;}
  function publish(frame,lifetime){
   let complete;const row={frame,lifetime,returned:false,callback:false,rawDone:true,notInvoked:true,done:false,ok:true,completion:new NativePromise(yes=>{complete=yes;})};sends.add(row);
   function finish(){if(row.done||!row.returned||!row.rawDone||!row.notInvoked&&!row.callback)return;row.done=true;sends.delete(row);complete(row.ok);}
   try{
    row.frame=data(frame);if(!process.connected)throw Error('DISPATCH_BUSINESS_DISCONNECTED');row.notInvoked=false;
    const raw=apply(send,process,[row.frame,error=>{row.callback=true;if(error){row.ok=false;fault(error);}finish();}]);
    if(raw!==true&&raw!==false){row.raw=raw;row.rawDone=false;row.ok=false;fault(Error('DISPATCH_BUSINESS_SEND_RETURN_UNCONFIRMED'));
     if(standard(raw)){if(!observe(raw,()=>{row.rawDone=true;finish();},error=>{remember(error);row.rawDone=true;finish();}))unknown.add(raw);}else unknown.add(raw);
    }
    row.returned=true;finish();
   }catch(error){row.ok=false;row.returned=true;fault(error);finish();}
   return row.completion;
  }
  function common(){return{protocol,nonce,instance,scope:domain};}
  function matching(frame){if(!nonce||frame.protocol!==protocol||frame.nonce!==nonce||frame.instance!==instance||!validScope(frame.scope)||!sameScope(frame.scope,domain))throw invalid();}
  function retireLifetime(life){
   if(!life.retirementWanted||life.activeOpRefs||life.attemptRefs||life.unknown||life.hostRef&&!life.hostRef.finished)return;
   life.retired=true;for(const frame of life.frames)preparationFrames.delete(frame);life.frames.clear();if(lifetimes.get(life.workId)===life)lifetimes.delete(life.workId);
  }
  function stopPreparation(terminalSource=false){
   for(const life of lifetimes.values()){life.retirementWanted=true;if(terminalSource)life.terminal=true;retireLifetime(life);}
   if(terminalSource){preparationTerminated=true;preparationState.available=false;preparationPorts?.seal();}
  }
  function installPreparation(actualHub,owner,actor,client){
   if(preparationInstallAttempted)throw Error('DEFAULT_DISPATCH_PREPARATION_ALREADY_INSTALLED');preparationInstallAttempted=true;
   const setup=reserve({type:'preparation_setup'});
   try{
    if(actualHub!==hub||sealed||terminal||closeStarted||preparationTerminated||!process.connected)throw Error('DEFAULT_DISPATCH_PREPARATION_UNAVAILABLE');
    preparationPorts=bindHubDefaultDispatchPreparation(actualHub,preparationSource,owner,actor,client);preparationPorts.assertCurrent();preparationState.available=true;preparationState.settlementAvailable=true;
   }catch(error){preparationState.available=false;throw error;}finally{setup.complete();}
  }
  function preparationFrame(life,purpose,input){
   const frame=freeze(create(null)),entry={__proto__:null,purpose,data:data(input),assertCurrent(){
    if(preparationFrames.get(frame)!==entry||!preparationState.available||terminal||!process.connected||life.terminal||life.retired||lifetimes.get(life.workId)!==life||life.instance!==instance||life.nonce!==nonce)throw Error('DURABLE_DISPATCH_PREPARATION_FRAME_REVOKED');
    preparationPorts.assertCurrent();
   }};preparationFrames.set(frame,entry);life.frames.add(frame);return frame;
  }
  function assertSettlement(life){
   if(!preparationState.settlementAvailable||terminal||!process.connected||life.unknown||life.retired||lifetimes.get(life.workId)!==life||life.instance!==instance||life.nonce!==nonce||!life.hostRef||life.hostRef.unknown||life.hostRef.sourceIncarnation!==life.sourceIncarnation)refusePreparation('DURABLE_DISPATCH_HOST_SETTLEMENT_REQUIRED');
   preparationPorts.assertSettlementCurrent();
  }
  function settlementFrame(life,input){
   const frame=freeze(create(null)),entry={__proto__:null,purpose:'finish_host_no_effect',data:data(input),assertCurrent(){if(preparationFrames.get(frame)!==entry)throw Error('DURABLE_DISPATCH_HOST_SETTLEMENT_REQUIRED');assertSettlement(life);}};
   preparationFrames.set(frame,entry);life.frames.add(frame);return frame;
  }
  function unresolvedHost(){for(const life of lifetimes.values())if(life.hostRef&&!life.hostRef.finished)return true;return false;}
  async function priorHostCut(row,life){
   const roots=[],sendRows=[];for(const prior of active)if(prior!==row&&prior.lifetime===life)put(roots,prior);for(const prior of sends)if(prior.lifetime===life)put(sendRows,prior);
   if(!await checked(join(roots))||!await checked(join(sendRows)))throw Error('DURABLE_DISPATCH_HOST_PRIOR_UNCONFIRMED');
   assertSettlement(life);if(unknown.size)throw Error('DURABLE_DISPATCH_HOST_PRIOR_UNCONFIRMED');
  }
  function lifetimeFor(frame){
   let life=lifetimes.get(frame.workId);
   if(life){if(life.projectId!==frame.projectId||life.sourceIncarnation!==frame.sourceIncarnation||life.retired||life.terminal&&frame.op!=='finish_host_no_effect')refusePreparation('DEFAULT_DISPATCH_PREPARATION_WORK_REQUIRED');return life;}
   if(frame.op!=='read_preparation_basis')refusePreparation('DEFAULT_DISPATCH_PREPARATION_WORK_REQUIRED');
   if(!exact(frame.input,['childKey','payloadHash'])||typeof frame.input.childKey!=='string'||!hex(frame.input.payloadHash))refusePreparation('DEFAULT_DISPATCH_PREPARATION_INPUT_INVALID');
   const binding=frame.sourceIncarnation+':'+frame.projectId.length+':'+frame.projectId+':'+frame.input.childKey,prior=workBindings.get(binding);
   if(prior&&prior!==frame.workId)refusePreparation('DEFAULT_DISPATCH_PREPARATION_WORK_ALREADY_BOUND');
   if(lifetimes.size>=64)refusePreparation('DEFAULT_DISPATCH_PREPARATION_WORK_CAPACITY');
   life={__proto__:null,workId:frame.workId,sourceIncarnation:frame.sourceIncarnation,projectId:frame.projectId,childKey:frame.input.childKey,payloadHash:frame.input.payloadHash,binding,instance,nonce,child:undefined,target:undefined,intentDigest:undefined,admissionId:undefined,activeOpRefs:0,attemptRefs:0,retirementWanted:false,retired:false,terminal:false,unknown:false,hostRef:undefined,settling:false,frames:new IntrinsicSet()};lifetimes.set(frame.workId,life);return life;
  }
  function bindPreparationResult(life,value){
   if(!value?.ok)return;const p=value.preparation;
   if(!p||p.childKey!==life.childKey||p.payloadHash!==life.payloadHash||p.projectId!==life.projectId)throw Error('DEFAULT_DISPATCH_PREPARATION_RESULT_UNCONFIRMED');
   if(life.intentDigest&&life.intentDigest!==p.intentDigest||life.admissionId&&life.admissionId!==p.admissionId)throw Error('DEFAULT_DISPATCH_PREPARATION_RESULT_UNCONFIRMED');
   life.intentDigest=p.intentDigest;if(p.admissionId){life.admissionId=p.admissionId;if(p.operation==='admit')life.admittedSourceIncarnation=life.sourceIncarnation;}
  }
  function startPreparationAttempt(row,life,sourceFrame){
   const attempt=reserve({type:'preparation_net_attempt',id:row.frame.id});attempt.lifetime=life;life.attemptRefs++;
   const finish=()=>{life.attemptRefs--;attempt.complete();retireLifetime(life);};
   try{
    const record=preparationPorts.startSend(life.projectId,sourceFrame);attempt.record=record;
    const view=preparationPorts.readSend(record);attempt.raw=view.raw;
    const completion=preparationPorts.readSendCompletion(record);attempt.bridge=completion;
    if(!observe(completion,()=>finish(),error=>{
     life.terminal=true;remember(error);fault(error);
     if(!faultSent){faultSent=true;const sending=publish({protocol,type:'fault',error:errorData(error)});attempt.publisher=sending;if(!observe(sending,finish,cause=>{remember(cause);finish();}))life.unknown=true;}
     else finish();
    })){life.unknown=true;return{ok:false,error:'DEFAULT_DISPATCH_PREPARATION_COMPLETION_UNCONFIRMED'};}
    bindPreparationResult(life,view.result);return{...view.result,sendStatus:view.sendStatus};
   }catch(error){
    if(attempt.raw!==undefined||attempt.record){life.unknown=true;fault(error);}else finish();throw error;
   }
  }
  async function preparationStep(row){
   const frame=row.frame;
   if(!(frame.op==='finish_host_no_effect'?preparationState.settlementAvailable:preparationState.available))refusePreparation('DEFAULT_DISPATCH_PREPARATION_UNAVAILABLE');
   if(frame.op!=='finish_host_no_effect')preparationPorts.assertCurrent();
   const life=lifetimeFor(frame);row.lifetime=life;life.activeOpRefs++;
   if(frame.op==='finish_host_no_effect'){
    assertSettlement(life);const ref=life.hostRef,input=frame.input;
    if(!exact(input,['scope','projectId','registrationDigest','hostLeaseKey','sourceIncarnation','reason'])||!validScope(input.scope)||!sameScope(input.scope,domain)||input.projectId!==life.projectId||input.registrationDigest!==ref.digest||input.hostLeaseKey!==ref.input.hostLeaseKey||input.sourceIncarnation!==life.sourceIncarnation||input.reason!=='cancelled'&&input.reason!=='revoked'&&input.reason!=='final_gate_denied')refusePreparation('DURABLE_DISPATCH_HOST_SETTLEMENT_REQUIRED');
    if(life.settling)refusePreparation('DURABLE_DISPATCH_HOST_SETTLEMENT_BUSY');life.settling=true;
    try{
     await priorHostCut(row,life);assertSettlement(life);
     const value=preparationPorts.finishHostNoEffect(life.projectId,settlementFrame(life,input));
     if(value.ok){row.durableCommitted=true;const returned=data(value);if(returned.hostEffect?.noEffectFinish?.registrationDigest!==ref.digest||protocolDigest(returned.hostEffect.registration)!==ref.digest)throw Error('DURABLE_DISPATCH_HOST_SETTLEMENT_UNCONFIRMED');ref.finished=true;return returned;}return value;
    }catch(error){if(!preparationRefusals.has(error)){life.unknown=true;ref.unknown=true;ref.failure=error;ref.hasFailure=true;remember(error);}throw error;}finally{life.settling=false;}
   }
   if(life.hostRef?.finished&&frame.op!=='read_preparation_basis')refusePreparation('DURABLE_DISPATCH_HOST_ALREADY_FINISHED');
   if(frame.op==='read_preparation_basis'){
    if(!exact(frame.input,['childKey','payloadHash'])||frame.input.childKey!==life.childKey||frame.input.payloadHash!==life.payloadHash)refusePreparation('DEFAULT_DISPATCH_PREPARATION_INPUT_INVALID');
    const sourceFrame=preparationFrame(life,'read_basis',{scope:domain,projectId:life.projectId,childKey:life.childKey,payloadHash:life.payloadHash}),value=preparationPorts.readBasis(life.projectId,sourceFrame);
    if(value.ok){life.child=value.child;workBindings.set(life.binding,life.workId);if(value.intent){life.target=data(runtimePreparationTarget(value.intent));life.intentDigest=protocolDigest(value.intent);life.admissionId=value.admission?.admissionId;life.admittedSourceIncarnation=value.admission?.sourceIncarnation;}}
    else if(!life.child){life.retirementWanted=true;}
    return value;
   }
   if(!life.child)refusePreparation('DEFAULT_DISPATCH_PREPARATION_WORK_REQUIRED');
   if(frame.op==='prepare_intent'){
    const input=frame.input;if(!input||input.projectId!==life.projectId||input.childKey!==life.childKey||input.payloadHash!==life.payloadHash||!validScope(input.scope)||!sameScope(input.scope,domain))refusePreparation('DEFAULT_DISPATCH_PREPARATION_INPUT_INVALID');
    if(life.target&&protocolDigest(life.target)!==protocolDigest(input))refusePreparation('DEFAULT_DISPATCH_PREPARATION_INPUT_INVALID');
    const value=preparationPorts.prepareIntent(life.projectId,preparationFrame(life,'prepare',input));bindPreparationResult(life,value);if(value.ok)life.target=data(input);return value;
   }
   if(!life.intentDigest||!life.target)refusePreparation('DEFAULT_DISPATCH_PREPARATION_INTENT_REQUIRED');
   if(frame.op==='admit_send'){
    if(!exact(frame.input,['preparationIntentDigest','sourceIncarnation'])||frame.input.preparationIntentDigest!==life.intentDigest||frame.input.sourceIncarnation!==life.sourceIncarnation)refusePreparation('DEFAULT_DISPATCH_PREPARATION_INPUT_INVALID');
    return startPreparationAttempt(row,life,preparationFrame(life,'admit',frame.input));
   }
   if(!life.admissionId)refusePreparation('DEFAULT_DISPATCH_PREPARATION_ADMISSION_REQUIRED');
   if(frame.op==='register_host'){
    const input=frame.input;
    if(!exact(input,['scope','projectId','childKey','payloadHash','admissionId','preparationIntentDigest','sourceIncarnation','hostLeaseKey'])||!validScope(input.scope)||!sameScope(input.scope,domain)||input.projectId!==life.projectId||input.childKey!==life.childKey||input.payloadHash!==life.payloadHash||input.admissionId!==life.admissionId||input.preparationIntentDigest!==life.intentDigest||input.sourceIncarnation!==life.sourceIncarnation||life.admittedSourceIncarnation!==life.sourceIncarnation||!hex(input.hostLeaseKey))refusePreparation('DURABLE_DISPATCH_HOST_REGISTRATION_REQUIRED');
    if(life.hostRef&&(life.hostRef.unknown||protocolDigest(life.hostRef.input)!==protocolDigest(input)))refusePreparation('DURABLE_DISPATCH_HOST_REGISTRATION_REQUIRED');
    const ref=life.hostRef??{__proto__:null,input:data(input),sourceIncarnation:life.sourceIncarnation,unknown:false,finished:false,registration:undefined,digest:undefined};life.hostRef=ref;
    try{
     const value=preparationPorts.registerHost(life.projectId,preparationFrame(life,'register_host',input));
     if(!value.ok){if(!ref.registration)life.hostRef=undefined;return value;}
     row.durableCommitted=true;const returned=data(value),registration=returned.hostEffect?.registration;
     if(!registration||registration.childKey!==life.childKey||registration.payloadHash!==life.payloadHash||registration.admissionId!==life.admissionId||registration.sourceIncarnation!==life.sourceIncarnation||registration.hostLeaseKey!==input.hostLeaseKey)throw Error('DURABLE_DISPATCH_HOST_REGISTRATION_UNCONFIRMED');
     ref.registration=registration;ref.digest=protocolDigest(registration);return returned;
    }catch(error){ref.unknown=true;life.unknown=true;ref.failure=error;ref.hasFailure=true;remember(error);throw error;}
   }
   if(frame.op==='read_prepare_call'){
    if(!exact(frame.input,['admissionId','preparationIntentDigest'])||frame.input.admissionId!==life.admissionId||frame.input.preparationIntentDigest!==life.intentDigest||life.admittedSourceIncarnation!==life.sourceIncarnation)refusePreparation('DEFAULT_DISPATCH_PREPARATION_INPUT_INVALID');
    return preparationPorts.readCall(life.projectId,preparationFrame(life,'read_call',{scope:domain,projectId:life.projectId,admissionId:life.admissionId,preparationIntentDigest:life.intentDigest,sourceIncarnation:life.sourceIncarnation}));
   }
   if(!exact(frame.input,['preparationIntentDigest','fact'])||frame.input.preparationIntentDigest!==life.intentDigest)refusePreparation('DEFAULT_DISPATCH_PREPARATION_INPUT_INVALID');
   const value=preparationPorts.acknowledge(life.projectId,preparationFrame(life,'acknowledge',frame.input));bindPreparationResult(life,value);if(value.ok)life.retirementWanted=true;return value;
  }
  function dshStep(row) {
    if (!dshPorts)
      return { ok: false, error: "DSH_BUSINESS_UNAVAILABLE", notInvoked: true };
    const frame = row.frame;
    if (frame.op === "prepare_dsh_owner")
      return dshPorts.prepareOwner({
        requestSource: "user",
        projectInputAuthority: reader,
      });
    const input = frame.input;
    if (!exact(input, ["data", "budget"]))
      return { ok: false, error: "DSH_BUSINESS_INPUT_INVALID", notInvoked: true };
    const reading =
      frame.op === "read_dsh_domain" ||
      frame.op === "read_dsh_basis" ||
      frame.op === "read_dsh_work" ||
      frame.op === "read_dsh_slot" || frame.op === "read_dsh_draft";
    if ((reading || frame.op === "apply_dsh_control") && input.budget !== null)
      return {
        ok: false,
        error: "DSH_BUSINESS_BUDGET_PURPOSE_INVALID",
        notInvoked: true,
      };
    if (
      !input.data ||
      !validScope(input.data.scope) ||
      !sameScope(input.data.scope, domain)
    )
      return {
        ok: false,
        error: "DSH_BUSINESS_SCOPE_MISMATCH",
        notInvoked: true,
      };
    const narrow =
      frame.op === "apply_dsh_command" &&
      (input.data.action === "request_stop" ||
        input.data.action === "invalidate_input");
    if (narrow && input.budget !== null)
      return {
        ok: false,
        error: "DSH_BUSINESS_BUDGET_PURPOSE_INVALID",
        notInvoked: true,
      };
    const workControl =
      frame.op === "apply_dsh_control" && own(input.data, "ownerWorkId");
    const purpose = frame.op === "stage_dsh_draft"?"draft_stage":frame.op === "commit_dsh_draft"?"draft_commit":reading
      ? "read"
      : workControl
        ? "work_control"
        : frame.op === "apply_dsh_control"
          ? "control"
          : frame.op === "prepare_dsh_slot"
            ? "slot"
            : narrow
              ? "narrow"
              : "effect";
    const sourceFrame = freeze(create(null)),
      budgetProof = input.budget === null ? null : freeze(create(null));
    const assertCurrent = () => {
      if (
        !row.executing ||
        terminal ||
        !process.connected ||
        !active.has(row) ||
        (prefix && frame.id > prefix.throughId)
      )
        throw Error("DSH_BUSINESS_FRAME_REVOKED");
    };
    // Re-materialize only already closed JSON: the original B codec uses
    // ordinary Array identity, whereas the wire copier deliberately detaches it.
    const commandData = apply(dshParse, undefined, [
      apply(dshJson, undefined, [input.data]),
    ]);
    const budgetData = budgetProof
      ? apply(dshParse, undefined, [apply(dshJson, undefined, [input.budget])])
      : null;
    if (budgetProof)
      dshBudgets.set(budgetProof, { data: budgetData, assertCurrent });
    dshFrames.set(sourceFrame, {
      purpose,
      data: commandData,
      budgetProof,
      assertCurrent,
    });
    try {
      const context = { requestSource: "scheduler" };
      const result =
        frame.op === "stage_dsh_draft"?dshPorts.stageDraft(sourceFrame,context):frame.op === "commit_dsh_draft"?dshPorts.commitDraft(sourceFrame,context):frame.op === "read_dsh_draft"?dshPorts.readDraft(sourceFrame):frame.op === "read_dsh_domain"
          ? dshPorts.readDomain(sourceFrame)
          : frame.op === "read_dsh_basis"
            ? dshPorts.readBasis(sourceFrame)
            : frame.op === "read_dsh_work"
              ? dshPorts.readWork(sourceFrame)
              : frame.op === "read_dsh_slot"
                ? dshPorts.readSlot(sourceFrame)
                : frame.op === "apply_dsh_control"
                  ? workControl
                    ? dshPorts.applyWorkMode(sourceFrame, context)
                    : dshPorts.applyControl(sourceFrame, context)
                  : frame.op === "prepare_dsh_slot"
                    ? dshPorts.prepareSlot(sourceFrame, context)
                    : narrow
                      ? dshPorts.applyNarrowing(sourceFrame, context)
                      : dshPorts.applyCommand(sourceFrame, context);
      if (!reading && result?.ok) row.durableCommitted = true;
      return result;
    } finally {
      dshFrames.delete(sourceFrame);
      if (budgetProof) dshBudgets.delete(budgetProof);
    }
  }
  function execute(row,notInvoked=false){
   const frame=row.frame;const work=(async()=>{
    let result,error,sourceFrame;
    try{
     if(notInvoked)result={ok:false,error:sealed?'DISPATCH_BUSINESS_CLOSED':'DISPATCH_BUSINESS_BUSY',notInvoked:true};
     else{
      executing=true;row.executing=true;
      if(frame.family==='dsh')result=dshStep(row);
      else if(frame.family==='preparation')result=await preparationStep(row);
      else if(frame.op==='read_plan')result=ports.readPlan(frame.projectId,reader);
      else if(frame.op==='read_operation')result=ports.readOperation(frame.projectId,frame.input,reader);
      else if(frame.op==='capture_default_dispatch'){
       let fact;try{fact=captureDefaultDispatchActionRecord(frame.input);}catch{result={ok:false,error:'DURABLE_DISPATCH_ACTION_DATA_INVALID',notInvoked:true};}
       if(fact&&(!sameScope(fact.scope,domain)||fact.projectId!==frame.projectId||fact.actorId!==actor.actorId))result={ok:false,error:'DISPATCH_BUSINESS_ACTION_AUDIENCE_MISMATCH',notInvoked:true};
       else if(fact){
        sourceFrame=freeze(create(null));const admitted=row;
        frames.set(sourceFrame,{fact,assertCurrent(){if(!admitted.executing||terminal||!process.connected||!active.has(admitted)||prefix&&admitted.frame.id>prefix.throughId)throw Error('DURABLE_DISPATCH_BUSINESS_FRAME_REVOKED');}});
        result=ports.capture(frame.projectId,sourceFrame,actor);row.durableCommitted=result?.ok===true;
       }
      }else throw invalid();
     }
    }catch(cause){const refused=preparationRefusals.get(cause);if(refused)result={ok:false,error:refused};else{error=cause;if(isPersistenceCommitError(cause))fault(cause);}}
    finally{if(sourceFrame)frames.delete(sourceFrame);if(row.lifetime){row.lifetime.activeOpRefs--;retireLifetime(row.lifetime);}if(!notInvoked){row.executing=false;executing=false;}}
    const response={...common(),type:'response',id:frame.id,op:frame.op,projectId:frame.projectId,...(frame.family==='dsh'?{family:'dsh'}:frame.family==='preparation'?{family:'preparation',workId:frame.workId,sourceIncarnation:frame.sourceIncarnation}:{}),...(error?{error:errorData(error,row.durableCommitted)}:{result})};
    // Register the original error SendRecord BEFORE original EXIT75 policy.
    const sending=publish(response,row.lifetime);row.sending=sending;
    if(error&&isPersistenceCommitError(error)&&typeof onPersistenceCommitFailure==='function')try{
     if(isProxy(onPersistenceCommitFailure)||isAsync(onPersistenceCommitFailure)||prototype(onPersistenceCommitFailure)===asyncPrototype)throw Error('DISPATCH_BUSINESS_FAILSTOP_SYNCHRONOUS_REQUIRED');
     const raw=apply(onPersistenceCommitFailure,undefined,[error]);if(raw!==undefined){retain(raw);fault(Error('DISPATCH_BUSINESS_FAILSTOP_RETURN_UNCONFIRMED'));}
    }catch(cause){fault(cause);}
    if(!qualified(sending)){row.unknown=true;return;}await sending;
   })();row.work=work;if(!observe(work,()=>row.complete(),error=>{fault(error);row.complete();}))unknown.add(work);
  }
  async function join(rows){for(let i=0;i<rows.length;i++){if(!standard(rows[i].completion)){unknown.add(rows[i].completion);fault(Error('DISPATCH_BUSINESS_TAIL_UNCONFIRMED'));return false;}await rows[i].completion;}return true;}
  function startPrefix(frame){
   if(prefix||frame.throughId!==sequence||!safeInteger(frame.throughId)||frame.throughId<0||!hex(frame.sealNonce))throw invalid();sealed=true;stopPreparation();
   const cut={throughId:frame.throughId,sealNonce:frame.sealNonce,roots:snapshot(active),sends:snapshot(sends)};prefix=cut;
   const raw=(async()=>{const roots=join(cut.roots);if(!qualified(roots)||!await roots)return;const sendingRoots=join(cut.sends);if(!qualified(sendingRoots)||!await sendingRoots)return;const tailRoots=join(snapshot(tails));if(!qualified(tailRoots)||!await tailRoots||unknown.size||terminal||prefix!==cut||!process.connected)return;
    if(unresolvedHost()){remember(Error('DURABLE_DISPATCH_HOST_UNRESOLVED'));return;}
    const sending=publish({...common(),type:'prefix_drained',throughId:cut.throughId,sealNonce:cut.sealNonce});cut.notification=sending;if(!qualified(sending))return;await sending;
   })();cut.work=raw;observe(raw,()=>{},error=>fault(error));
  }
  function onMessage(raw,handle){
   if(handle!==undefined&&handle!==null){retain(handle);fault(Error('DISPATCH_BUSINESS_TRANSFER_HANDLE_UNCONFIRMED'));return;}
   const tag=dispatchBusinessProtocolTag(raw);if(tag===configV1||tag===configV2)return;
   try{
    if(closeStarted){data(raw);fault(Error('DISPATCH_BUSINESS_CLOSING'));return;}
    if(installing)throw Error('DISPATCH_BUSINESS_STARTUP_REENTRY');const frame=data(raw);
    if(frame.protocol!==protocol||!validScope(frame.scope)||!sameScope(frame.scope,domain)||!hex(frame.nonce))throw invalid();
    if(frame.type==='hello'){
     if(sealed||nonce||!exact(frame,['protocol','type','scope','nonce']))throw invalid();nonce=frame.nonce;publish({...common(),type:'hello_ack'});return;
    }
    matching(frame);
    if(frame.type==='seal_prefix'){
     if(!exact(frame,['protocol','type','scope','nonce','instance','throughId','sealNonce']))throw invalid();startPrefix(frame);return;
    }
    // The accepted producer frontier is closed. A later request is a protocol
    // fault, never a new negative-response publisher outside that prefix.
    if(prefix)throw invalid();
    const preparation=frame.family==='preparation',dsh=frame.family==='dsh';
    if(!exact(frame,preparation?['protocol','type','scope','nonce','instance','id','op','projectId','input','family','workId','sourceIncarnation']:dsh?['protocol','type','scope','nonce','instance','id','op','projectId','input','family']:['protocol','type','scope','nonce','instance','id','op','projectId','input'])||frame.type!=='request'||!safeInteger(frame.id)||frame.id!==sequence+1||typeof frame.projectId!=='string'||!frame.projectId||frame.projectId.length>256||trim(frame.projectId)!==frame.projectId||exec(/[\x00-\x1f\x7f]/,frame.projectId)!==null||(dsh?(!dshOperation(frame.op)||frame.projectId!=='@dsh-domain'||frame.op==='prepare_dsh_owner'&&frame.input!==null):preparation?!preparationOperation(frame.op)||!hex(frame.workId)||!hex(frame.sourceIncarnation):(frame.op!=='read_plan'&&frame.op!=='capture_default_dispatch'&&frame.op!=='read_operation')||frame.op==='read_plan'&&frame.input!==null))throw invalid();
    sequence=frame.id;const row=reserve(frame);execute(row,(sealed&&!(preparation&&frame.op==='finish_host_no_effect'))||executing);
   }catch(error){fault(error);if(!closeStarted&&!faultSent){faultSent=true;publish({protocol,type:'fault',error:errorData(error)});}}
  }
  const disconnected=()=>fault(Error('DISPATCH_BUSINESS_DISCONNECTED')),processError=error=>fault(error);
  function cleanup(){if(disposed||installing)return;disposed=true;for(let i=0;i<cleanups.length;i++)try{const raw=cleanups[i]();if(raw!==process){retain(raw);fault(Error('DISPATCH_BUSINESS_CLEANUP_UNCONFIRMED'));}}catch(error){fault(error);}}
  function seal(){sealed=true;stopPreparation();}
  function drain(){
   if(closing)return closing;closeStarted=true;seal();const roots=snapshot(active),initialSends=snapshot(sends),cut=prefix;
   closing=(async()=>{await checked(join(roots));await checked(join(initialSends));if(cut?.work)await checked(cut.work);await checked(join(snapshot(tails)));cleanup();await checked(join(snapshot(tails)));if(unresolvedHost())throw Error('DURABLE_DISPATCH_HOST_UNRESOLVED',{cause:firstError});if(unknown.size)throw Error('DISPATCH_BUSINESS_CLOSE_UNCONFIRMED',{cause:firstError});if(errors.length)throw firstError;})();return closing;
  }
  // Source/controller stay owned even when the first registration fails.
  const controller=freeze({available:true,seal,drain,installPreparation,sealPreparation(){stopPreparation(true);}});controllers.set(controller,{source,hub});state=controller;
  const setup=reserve({type:'listener_setup'});
  try{
   const registrations=[['message',onMessage],['disconnect',disconnected],['error',processError]];
   for(let i=0;i<registrations.length;i++){
    const [name,handler]=registrations[i];put(cleanups,()=>apply(off,process,[name,handler]));
    const raw=apply(on,process,[name,handler]);if(raw!==process){retain(raw);throw Error('DISPATCH_BUSINESS_REGISTRATION_UNCONFIRMED');}if(sealed||terminal)throw firstError??Error('DISPATCH_BUSINESS_CLOSED');
   }
  }catch(error){fault(error);}finally{installing=false;if(terminal)cleanup();setup.complete();}
  return controller;
 }
 return freeze({source,preparationSource,dshSource,dshBudgetSource,install});
}

import {IntrinsicMap as Map,IntrinsicSet as Set,IntrinsicWeakMap as WeakMap} from './intrinsic-collections.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {types} from 'node:util';
import {retainSourceErrorTails} from './source-error-tails.js';
const fail=code=>{throw Error(code);};
const promiseBrand=types.isPromise,proxyBrand=types.isProxy,prototype=Object.getPrototypeOf,descriptor=Object.getOwnPropertyDescriptor,hasOwn=Object.hasOwn;
const NativePromise=Promise,nativePromisePrototype=Promise.prototype,nativeSpecies=Symbol.species,speciesDescriptor=descriptor(Promise,Symbol.species),observeNativePromise=Function.prototype.call.bind(Promise.prototype.then);
const deferred=()=>{let resolve;const promise=new NativePromise(done=>{resolve=done;});return{promise,resolve};};
function standardGuardPromise(value){
 if(!promiseBrand(value)||proxyBrand(value)||prototype(value)!==nativePromisePrototype||descriptor(value,'constructor')||descriptor(value,'then'))return false;
 const constructor=descriptor(nativePromisePrototype,'constructor'),species=descriptor(NativePromise,nativeSpecies);
 return constructor?.value===NativePromise&&species?.get===speciesDescriptor?.get&&species?.set===speciesDescriptor?.set&&!hasOwn(species??{},'value');
} 
/** Private child of one original Hub. No durable state, poller or execution slot. */
export function createHubMigrationBoundary(options){
 const context=new AsyncLocalStorage(),roots=new Set(),tails=new Set(),frames=new WeakMap(),unknown=new Set(),causes=new Map(),unknownGuardRaws=new Set(),guardTails=new Set(),guardInventory=new WeakMap();
 const authorize=options.authorize.bind(options),origin=options.assertOrigin.bind(options),eligible=options.assertEligible.bind(options),capture=options.capture.bind(options),inspect=options.inspect.bind(options),transition=options.transition.bind(options),current=options.assertCurrent.bind(options),healthy=options.healthy.bind(options);
 let phase='open',migration=null,executionAttempt=false;
 function remember(reason,error){if(!causes.has(reason))causes.set(reason,error);}
 function denied(){if(migration&&context.getStore()===migration.token)migration.poison??=Error('DEFAULT_DISPATCH_MIGRATION_REENTRY');fail('DEFAULT_DISPATCH_MIGRATION_ACTIVE');}
 function assertPublic(){if(phase!=='open')denied();}
 function finish(root){if(!roots.delete(root))return;root.done.resolve();}
 function retain(value){
  if(!types.isPromise(value)){unknown.add('non_original_async_tail');return;}
  const tail={value,done:deferred()};tails.add(tail);
  void Promise.prototype.then.call(value,()=>{tails.delete(tail);tail.done.resolve();},error=>{remember('raw_tail',error);tails.delete(tail);tail.done.resolve();});
 }
 function retainGuardTail(value,cause,forceUnknown=false){
  if(value===null||typeof value!=='object'&&typeof value!=='function'){unknown.add('delivery_guard_tail');remember('delivery_guard',cause);unknownGuardRaws.add(value);return;}
  const prior=guardInventory.get(value);
  if(prior){if(forceUnknown){prior.unconfirmed=true;unknownGuardRaws.add(value);}scanGuardOwn(value,cause,prior);return;}
  const inventory={scanning:false,unconfirmed:forceUnknown};guardInventory.set(value,inventory);
  unknown.add('delivery_guard_tail');remember('delivery_guard',cause);unknownGuardRaws.add(value);
  scanGuardOwn(value,cause,inventory);
  if(!standardGuardPromise(value)){remember('delivery_guard_observation',Error('DELIVERY_GUARD_TAIL_UNKNOWN'));return;}
  const tail={value,done:deferred()};tails.add(tail);guardTails.add(tail);
  const complete=outcome=>{try{retainSourceErrorTails(outcome,(child,_error,kind)=>retainGuardTail(child,cause,kind==='unknown'));}catch(error){remember('delivery_guard_observation',error);unknownGuardRaws.add(value);}finally{guardTails.delete(tail);tails.delete(tail);tail.done.resolve();}};
  try{observeNativePromise(value,outcome=>complete(outcome),error=>{remember('delivery_guard_raw_failure',error);complete(error);});if(!inventory.unconfirmed)unknownGuardRaws.delete(value);}
  catch(error){guardTails.delete(tail);tails.delete(tail);remember('delivery_guard_observation',error);}
 }
 function scanGuardOwn(value,cause,inventory){
  if(inventory.scanning)return;inventory.scanning=true;
  try{retainSourceErrorTails(value,(child,_error,kind)=>{if(child!==value||kind==='unknown')retainGuardTail(child,cause,kind==='unknown');});}
  catch(error){inventory.unconfirmed=true;remember('delivery_guard_observation',error);unknownGuardRaws.add(value);}
  finally{inventory.scanning=false;}
 }
 function assertSync(value){if(value===undefined)return;unknown.add('asynchronous_migration_guard');if(types.isPromise(value))retain(value);fail('DEFAULT_DISPATCH_MIGRATION_GUARD_UNAVAILABLE');}
 function isHealthy(){return healthy()===true;}
 function assertEntry(entry){
  if(migration!==entry||phase!=='committing'||entry.poison||executionAttempt||unknown.size||tails.size||[...roots].some(root=>root!==entry.token))throw entry.poison??Error('DEFAULT_DISPATCH_MIGRATION_SOURCE_UNAVAILABLE');
 }
 function assertSource(entry,audience,actor){
  const health=isHealthy();assertEntry(entry);if(!health)fail('DEFAULT_DISPATCH_MIGRATION_SOURCE_UNAVAILABLE');
  if(actor.requestSource!=='user'||actor.projectInputAuthority!==entry.actor.projectInputAuthority)fail('DEFAULT_DISPATCH_MIGRATION_AUTHORITY_REQUIRED');
  assertSync(current(entry.actor,entry.observation,audience));assertEntry(entry);
 }

 return Object.freeze({
  source:Object.freeze({resolve(frame){const entry=frames.get(frame);if(!entry||entry!==migration)fail('DEFAULT_DISPATCH_MIGRATION_SOURCE_FOREIGN');return{observation:entry.observation,assertCurrent:(audience,actor)=>assertSource(entry,audience,actor)};}}),
  runPublic(name,action,safe=false){
   assertPublic();if(!safe)unknown.add(name);
   const root={kind:'business',name,done:deferred()};roots.add(root);
   return context.run(root,()=>{try{
    const result=action();
    if(types.isPromise(result))return Promise.prototype.then.call(result,value=>{finish(root);return value;},error=>{remember(name,error);finish(root);throw error;});
    finish(root);return result;
   }catch(error){remember(name,error);finish(root);throw error;}});
  },
  assertInternal(){if(phase==='open')return;const root=context.getStore();if(root?.kind==='business'&&roots.has(root))return;denied();},
  assertCanClose(){if(migration||roots.size||tails.size||unknownGuardRaws.size)fail('DEFAULT_DISPATCH_MIGRATION_BUSY');},
  retainDetached(value){unknown.add('generic_callback_tail');retain(value);},
  runAdmissionGuard(action){
   const tail={done:deferred()};tails.add(tail);guardTails.add(tail);
   try{return action();}finally{guardTails.delete(tail);tails.delete(tail);tail.done.resolve();}
  },
  retainGuardTail,
  assertGuardTailsCanClose(){if(guardTails.size||unknownGuardRaws.size)fail('DEFAULT_DISPATCH_MIGRATION_BUSY');},
  inspectGuardTails(){return{pending:guardTails.size,unknown:unknownGuardRaws.size,firstFailure:causes.get('delivery_guard_raw_failure')??causes.get('delivery_guard_observation'),firstGuard:causes.get('delivery_guard')};},
  markUnknown(reason,error){unknown.add(reason);if(error)remember('unknown:'+reason,error);},
  markExecutionAttempt(){executionAttempt=true;},
  inspectState(){return{phase,activeRoots:roots.size,rawTails:tails.size,provenanceUnknown:unknown.size>0,executionAttempt};},
  async migrate(input){
   let actor;try{actor=authorize(input);}catch{return{ok:false,error:'DEFAULT_DISPATCH_MIGRATION_AUTHORITY_REQUIRED'};}
   if(context.getStore()&&roots.has(context.getStore())){if(migration&&context.getStore()===migration.token)migration.poison??=Error('DEFAULT_DISPATCH_MIGRATION_REENTRY');return{ok:false,error:'DEFAULT_DISPATCH_MIGRATION_REENTRY'};}
   if(migration){if(actor.profileId!==migration.actor.profileId||actor.workspaceId!==migration.actor.workspaceId)return{ok:false,error:'DEFAULT_DISPATCH_MIGRATION_ACTIVE'};return migration.promise;}
   if(phase!=='open'||executionAttempt||unknown.size||!isHealthy())return{ok:false,error:'DEFAULT_DISPATCH_MIGRATION_RECONCILIATION_REQUIRED'};
   try{assertSync(origin(actor));}catch(error){remember('migration_origin',error);return{ok:false,error:error.message};}
   phase='closing';const token={kind:'migration',done:deferred()},entry={token,actor,poison:null,promise:null,observation:null};migration=entry;roots.add(token);
   const work=context.run(token,async()=>{
    await Promise.resolve();let nativeStarted=false;
    try{
     while([...roots].some(root=>root!==token)||tails.size)await Promise.all([...roots].filter(root=>root!==token).map(root=>root.done.promise).concat([...tails].map(tail=>tail.done.promise)));
     if(entry.poison||executionAttempt||unknown.size||!isHealthy())throw entry.poison??Error('DEFAULT_DISPATCH_MIGRATION_RECONCILIATION_REQUIRED');
     assertSync(eligible(actor));entry.observation=capture();entry.metadata=inspect(entry.observation);phase='committing';
     const frame=Object.freeze(Object.create(null));frames.set(frame,entry);nativeStarted=true;
     const receipt=transition(frame,actor);if(types.isPromise(receipt)){retain(receipt);unknown.add('asynchronous_native_transition');fail('DEFAULT_DISPATCH_MIGRATION_NATIVE_UNAVAILABLE');}phase='open';return{ok:true,transition:receipt};
    }catch(error){remember('migration_attempt',error);phase=nativeStarted||!isHealthy()?'failed':'open';if(nativeStarted)throw error;return{ok:false,error:error.message};}
    finally{finish(token);if(migration===entry)migration=null;}
   });entry.promise=work;return work;
  },
 });
}

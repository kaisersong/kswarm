import {DatabaseSync} from 'node:sqlite';
import {types} from 'node:util';
import {resolve} from 'node:path';
import {retainSourceErrorTails} from './source-error-tails.js';
import {readOriginalSqliteAuthority} from './original-sqlite-authority.js';
import {readOriginalSqliteSourceRuntime} from './original-sqlite-source-runtime.js';
import {IntrinsicMap,IntrinsicWeakMap,IntrinsicSet} from './intrinsic-collections.js';
const NativeDatabase=DatabaseSync,nativeClose=DatabaseSync.prototype.close;
const apply=Reflect.apply,descriptor=Object.getOwnPropertyDescriptor,own=Object.hasOwn,keys=Reflect.ownKeys;
const rows=new IntrinsicWeakMap(),held=new IntrinsicMap(),pendingErrors=new WeakSet();
const define=Object.defineProperty;function append(array,value){define(array,String(array.length),{__proto__:null,value,writable:true,enumerable:true,configurable:true});}
let sdkAccessors,sdkFailure;
function fail(code,cause){throw new Error(code,{cause});}
function hold(row){let group=held.get(row.path);if(!group){group=new IntrinsicSet();held.set(row.path,group);}group.add(row);}
function unhold(row){const group=held.get(row.path);if(group){group.delete(row);if(!group.size)held.delete(row.path);}}
function first(row,raw){row.failure??={raw};append(row.raws,raw);hold(row);}
function inventory(row,raw){
 append(row.raws,raw);
 if(row.stock){try{row.stock.inventory(raw);try{row.stock.assertPhysicalKnown();}catch{hold(row);}}catch(secondary){first(row,secondary);row.unknown=true;}return;}
 // Legacy standalone absence remains unqualified. Keep all original failure
 // graph roots; it cannot supply a positive physical/enrollment receipt.
 try{retainSourceErrorTails(raw,value=>{append(row.raws,value);row.unknown=true;});}catch(secondary){first(row,secondary);row.unknown=true;}
}
function assertKnown(row){
 if(row.custom||!row.stock||!row.closed||row.unknown)fail('KSWARM_SQLITE_SOURCE_PHYSICAL_UNCONFIRMED',row.failure?.raw);
 try{row.stock.assertPhysicalKnown();}catch(raw){const error=new Error('KSWARM_SQLITE_SOURCE_PHYSICAL_UNCONFIRMED',{cause:raw});pendingErrors.add(error);throw error;}
}
export function isOriginalSqliteSourcePending(raw){return pendingErrors.has(raw);}
/** This local cell proves only the fixed connection lifetime. No native family,
 * scope, source completeness, old-FD or business authorization is minted here. */
export function createOriginalSqliteSourceLifetime(path,legacyFactory){
 if(sdkFailure)fail('KSWARM_SQLITE_SOURCE_SDK_HELD',sdkFailure.failure?.raw);
 const authority=readOriginalSqliteAuthority();if(authority&&legacyFactory!==undefined)fail('KSWARM_ORIGINAL_AUTHORITY_FACTORY_DENIED');const canonical=path===''||path===':memory:'?path:resolve(path),prior=held.get(canonical);
 if(prior)for(const old of prior){if(old.custom&&!authority&&(old.closed||(!old.failure&&!old.unknown)))continue;try{assertKnown(old);unhold(old);}catch{fail('KSWARM_SQLITE_SOURCE_HELD',old.failure?.raw);}}
 const token=Object.freeze(Object.create(null)),runtime=readOriginalSqliteSourceRuntime(),row={authority,path:canonical,runtime,stock:runtime?.createRoomTurnCustody(),database:undefined,closed:false,closing:false,unknown:false,raws:[],failure:undefined};rows.set(token,row);
 if(authority&&!row.stock)fail('KSWARM_ORIGINAL_AUTHORITY_RUNTIME_REQUIRED');
 if(row.stock&&!authority)try{row.stock.syncVoid(runtime.assertOrdinarySourceWriterRoute,undefined,[]);}catch(raw){first(row,raw);inventory(row,raw);throw raw;}
 return token;
}
function member(token){const row=rows.get(token);if(!row)fail('KSWARM_SQLITE_SOURCE_REQUIRED');return row;}
export function assertOriginalSqliteSourceUsable(token){const row=member(token);if(row.closing||row.unknown||row.failure)fail('KSWARM_SQLITE_SOURCE_UNCONFIRMED',row.failure?.raw);if(row.stock&&!row.authority){
 if(row.custom){const raw=row.runtime.assertOrdinarySourceWriterRoute();inventory(row,raw);if(raw!==undefined)fail('KSWARM_SQLITE_SOURCE_ROUTE_RETURN');}
 else row.stock.syncVoid(row.runtime.assertOrdinarySourceWriterRoute,undefined,[]);
}}
export function observeOriginalSqliteSource(token){const row=member(token);assertOriginalSqliteSourceUsable(token);if(row.stock&&!row.custom&&!row.authority)row.stock.syncVoid(row.runtime.observeOrdinarySQLiteWriter,undefined,[row.path,'kswarm-state-sqlite-v1']);}
/** Captured Node getters are identified by exact SDK function and descriptor,
 * never invoked or approved by their property spelling alone. The tiny Native
 * baseline is closed before any file connection is constructed. */
function captureSdkAccessors(row){
 if(sdkAccessors)return;
 let baseline;
 try{
  baseline=new NativeDatabase(':memory:');const next=new IntrinsicMap();
  for(const name of ['isOpen','isTransaction','limits']){const d=descriptor(baseline,name);if(d&&!own(d,'value')&&typeof d.get==='function'&&d.set===undefined&&d.configurable===false)next.set(name,d);}
  const outcome=apply(nativeClose,baseline,[]);inventory(row,outcome);if(outcome!==undefined)fail('KSWARM_SQLITE_SOURCE_SDK_CLOSE_RETURN');sdkAccessors=next;resourceOwn(row,baseline);
 }catch(raw){row.unknown=true;sdkFailure??=row;first(row,raw);inventory(row,raw);if(baseline)append(row.raws,baseline);throw raw;}
}
function resourceOwn(row,raw){
 if(!raw||typeof raw!=='object'||types.isProxy(raw)){row.unknown=true;inventory(row,raw);return;}
 const names=keys(raw);
 for(const name of names){const d=descriptor(raw,name),known=row.authority&&name==='isTransaction'?{get:row.authority.namespace.transactionStateGetter,set:undefined,enumerable:false,configurable:false}:sdkAccessors?.get(name);
  if(!d){row.unknown=true;continue;}
  if(own(d,'value')){inventory(row,d.value);continue;}
  if(!known||d.get!==known.get||d.set!==known.set||d.enumerable!==known.enumerable||d.configurable!==known.configurable)row.unknown=true;
 }
}
export function openOriginalSqliteSource(token,path,factory){
 const row=member(token);if(row.database||row.closing||row.failure)fail('KSWARM_SQLITE_SOURCE_REENTRY');
 // A legacy injected factory is retained as an ordinary testing/embedding API;
 // it can never attest that it opened only one original Native connection.
 row.custom=factory!==undefined;
 try{if(row.authority&&factory!==undefined)fail('KSWARM_ORIGINAL_AUTHORITY_FACTORY_DENIED');if(!row.authority)captureSdkAccessors(row);row.entered=true;row.database=row.authority?new row.authority.namespace.Database():factory===undefined?new NativeDatabase(path):apply(factory,undefined,[path]);resourceOwn(row,row.database);return row.database;}
 catch(raw){row.unknown=true;first(row,raw);inventory(row,raw);throw raw;}
}
export function retainOriginalSqliteSourceFailure(token,raw){const row=member(token);first(row,raw);inventory(row,raw);}
export function retainUnknownOriginalSqliteSourceFailure(token,raw){const row=member(token);row.unknown=true;first(row,raw);inventory(row,raw);}
export function inventoryOriginalSqliteSourceOutcome(token,raw){inventory(member(token),raw);}
/** Only the original store calls this for its own logical pre-open rejection.
 * It does not convert an entered constructor/SDK failure into not-started. */
export function rejectOriginalSqliteSourceBeforeOpen(token,raw){const row=member(token);if(row.database||row.entered||row.closing)fail('KSWARM_SQLITE_SOURCE_REJECTION_PHASE');first(row,raw);inventory(row,raw);row.closed=true;try{assertKnown(row);unhold(row);}catch{/* Actual pending/unknown remains held for the fixed negative close. */}}
export function closeOriginalSqliteSource(token){
 const row=member(token);
 if(!row.closed){
  if(row.closing)throw row.failure?row.failure.raw:new Error('KSWARM_SQLITE_SOURCE_CLOSE_REENTRY');row.closing=true;
  if(!row.database){if(row.failure||row.unknown)fail('KSWARM_SQLITE_SOURCE_CLOSE_UNCONFIRMED',row.failure?.raw);row.closed=true;}
  else try{resourceOwn(row,row.database);const raw=apply(row.authority?row.authority.namespace.databaseMethods.close:nativeClose,row.database,[]);inventory(row,raw);if(raw!==undefined){row.unknown=true;fail('KSWARM_SQLITE_SOURCE_CLOSE_RETURN');}row.closed=true;}
  catch(raw){row.unknown=true;first(row,raw);inventory(row,raw);throw raw;}
 }
 if(!row.custom&&row.stock){assertKnown(row);if(row.authority&&!row.namespaceClosed){try{const raw=row.authority.namespace.closeOwned();inventory(row,raw);if(raw!==undefined)fail('KSWARM_ORIGINAL_AUTHORITY_CLOSE_RETURN');const finish=row.authority.finish();inventory(row,finish);if(finish!==undefined)fail('KSWARM_ORIGINAL_AUTHORITY_CLOSE_RETURN');row.namespaceClosed=true;}catch(raw){row.unknown=true;first(row,raw);inventory(row,raw);throw raw;}}unhold(row);}
}
export function readOriginalSqliteSourceLifetime(token){
 const row=member(token);return Object.freeze({path:row.path,assertTerminated(){assertKnown(row);},async waitKnown(){if(row.stock)await row.stock.waitPhysicalKnown();assertKnown(row);}});
}
function errorData(raw,key){if(!raw||typeof raw!=='object'||types.isProxy(raw))return undefined;const d=descriptor(raw,key);return d&&own(d,'value')?d.value:undefined;}
export function originalSqliteSourceErrorMessage(raw){const value=errorData(raw,'message');return typeof value==='string'?value:'unclassified SQLite source failure';}
export function originalSqliteSourceErrorCode(raw){const value=errorData(raw,'code');return typeof value==='string'?value:undefined;}
export function originalSqliteSourceErrorName(raw){const value=errorData(raw,'name');return typeof value==='string'?value:undefined;}
export function originalSqliteSourceDurableCommitted(raw){return errorData(raw,'durableCommitted')===true;}

export function isOriginalSqliteSourceProtected(token){return member(token).authority!==null;}
export function bindOriginalSqliteSourceNamespace(token){const row=member(token);if(!row.authority)return;assertOriginalSqliteSourceUsable(token);row.stock.syncVoid(row.authority.bindNamespace,row.authority,[]);}

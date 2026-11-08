import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {ALL_COLLECTIONS,DELETABLE_COLLECTIONS} from './state-scope.js';
import {ACCEPTANCE_WRITER_PROFILE,isAcceptanceRecord,acceptanceRecordMatchesFloor,semanticWriterByProfile,semanticWriterForFloor} from './initial-plan-acceptance-contract.js';
const backends=new WeakMap(),frames=new WeakMap();
const error=()=>{throw Error('INITIAL_PLAN_WRITE_FRAME_REQUIRED');};
const key=row=>JSON.stringify([row.collection,row.key]);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function dataRecord(value){
 if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.getOwnPropertySymbols(value).length)throw Error('persistence_write_set_invalid');
 const rows=Object.getOwnPropertyDescriptors(value);if(Object.values(rows).some(row=>!Object.hasOwn(row,'value')))throw Error('persistence_write_set_invalid');return rows;
}
function dataArray(value){
 if(!Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||Object.getOwnPropertySymbols(value).length)throw Error('persistence_write_set_invalid');
 const rows=Object.getOwnPropertyDescriptors(value);
 if(Object.keys(rows).length!==value.length+1||Object.entries(rows).some(([key,row])=>!Object.hasOwn(row,'value')||key!=='length'&&!/^(0|[1-9][0-9]*)$/.test(key)))throw Error('persistence_write_set_invalid');
 return Array.from({length:value.length},(_,i)=>{if(!rows[i])throw Error('persistence_write_set_invalid');return rows[i].value;});
}
function profileData(value){
 if(value===undefined||typeof value==='string')return value;
 const fields=dataRecord(value),scope=dataRecord(fields.scope?.value);
 if(Object.keys(fields).length!==3||!semanticWriterByProfile(fields.profile?.value)||typeof fields.storeId?.value!=='string'
  ||Object.keys(scope).length!==2||!['profileId','workspaceId'].every(key=>typeof scope[key]?.value==='string'&&/^[a-f0-9]{64}$/.test(scope[key].value)))throw Error('persistence_writer_profile_invalid');
 return Object.freeze({profile:fields.profile.value,storeId:fields.storeId.value,scope:Object.freeze({profileId:scope.profileId.value,workspaceId:scope.workspaceId.value})});
}
function freezeData(value){
 if(value&&typeof value==='object'){for(const child of Object.values(value))freezeData(child);Object.freeze(value);}return value;
}
// Profile 2 signs plain JSON data only. Validate the entire write set before
// serializing any row: a legacy row's hook must not mutate a later owned row
// after its semantic acceptance was checked by the original owner.
function assertDataOnly(value,ancestors=new Set(),budget={nodes:0},depth=0){
 if(++budget.nodes>1000000||depth>128)throw Error('persistence_write_set_data_only_budget');
 if(value===null||value===undefined||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(typeof value!=='object'||ancestors.has(value))throw Error('persistence_write_set_data_only');
 const array=Array.isArray(value),rows=array?(dataArray(value),Object.getOwnPropertyDescriptors(value)):dataRecord(value);
 if(Object.entries(rows).some(([name,row])=>!row.enumerable&&!(array&&name==='length')))throw Error('persistence_write_set_data_only');
 if(Object.getOwnPropertyDescriptor(Object.prototype,'toJSON')||array&&Object.getOwnPropertyDescriptor(Array.prototype,'toJSON'))throw Error('persistence_write_set_serialization_hook');
 ancestors.add(value);for(const [name,row] of Object.entries(rows))if(!(array&&name==='length'))assertDataOnly(row.value,ancestors,budget,depth+1);ancestors.delete(value);
}
/** Materialize each SQL value ONCE, including its identity columns. The exact
 * bytes below are the bytes the original native store must write. */
export function materializePersistenceWriteSet(payload,scope,dataOnly=false){
 if(types.isPromise(payload)){void Promise.prototype.then.call(payload,()=>{},()=>{});throw Error('persistence_write_set_async');}
 const props=dataRecord(payload);
 if(!Array.isArray(props.entities?.value)||props.humanActions&& !Array.isArray(props.humanActions.value))throw Error('persistence_write_set_invalid');
 const rawScope=dataRecord(props.scope?.value??scope),type=rawScope.type?.value,projectId=rawScope.projectId?.value;
 if(type!=='full'&&(type!=='project'||typeof projectId!=='string'||!projectId)||Object.keys(rawScope).length!==(type==='full'?1:2))throw Error('persistence_write_scope_invalid');
 const effective=type==='full'?{type}:{type,projectId};
 const entityRows=dataArray(props.entities.value),actionRows=dataArray(props.humanActions?.value??[]);
 if(dataOnly){const budget={nodes:0};for(const row of [...entityRows,...actionRows]){const fields=dataRecord(row);assertDataOnly(fields.value?.value,new Set(),budget);}}
 const convert=row=>{
  const fields=dataRecord(row),collection=fields.collection?.value,id=fields.key?.value,projectId=fields.projectId?.value??null;
  if(!ALL_COLLECTIONS.includes(collection)||typeof id!=='string'||!id||projectId!==null&&typeof projectId!=='string'||!fields.value)throw Error('persistence_write_entity_invalid');
  const stateJson=JSON.stringify(fields.value.value);if(typeof stateJson!=='string')throw Error('persistence_write_entity_invalid');
  return Object.freeze({collection,key:id,projectId,stateJson});
 };
 const entities=entityRows.map(convert).filter(row=>row.collection!=='humanAction'),humanActions=actionRows.map(convert);
 if(humanActions.some(row=>row.collection!=='humanAction'))throw Error('persistence_write_entity_invalid');
 const identities=new Set();for(const row of [...entities,...humanActions]){if(identities.has(key(row)))throw Error('persistence_duplicate_write_entity');identities.add(key(row));}
 const result={scope:Object.freeze(effective),entities:Object.freeze(entities),humanActions:Object.freeze(humanActions),requiredWriterProfile:profileData(props.requiredWriterProfile?.value)};
 return Object.freeze({...result,digest:sha(result)});
}

/** Registered by the ORIGINAL backend only. The Hub receives one private
 * controller handle; no DTO/frame fields are a permission to call this API. */
export function registerInitialPlanWriteBackend(api,access){
 const state={access,owner:null};backends.set(api,state);
 return Object.freeze({
  materialize:(payload,scope)=>materializePersistenceWriteSet(payload,scope,Boolean(semanticWriterForFloor(access.profile()?.floor))),
  consume(payload,actual){
   const frame=frames.get(payload);
   if(frame){
    if(frame.backend!==state||frame.used||frame.expectedRevision!==access.expectedRevision()||frame.actual.digest!==actual.digest)error();
    frame.used=true;
   }
   const rows=access.readRows(),old=new Map(rows.map(row=>[key(row),row])),next=[...actual.entities,...actual.humanActions];
   const owned=new Set(),birth=[];
   for(const row of [...rows,...next]){
    const value=JSON.parse(row.stateJson);if(!['protocolReceipt','protocolHead'].includes(row.collection)||!isAcceptanceRecord(value))continue;
    if(typeof row.projectId==='string')owned.add(row.projectId);if(typeof value.projectId==='string')owned.add(value.projectId);
    if(!old.has(key(row))&&next.includes(row))birth.push(key(row));
   }
   if(owned.size){
    const floor=access.profile()?.floor;if(!semanticWriterForFloor(floor))error();
    for(const row of [...rows,...next]){
     const value=JSON.parse(row.stateJson);if(!['protocolReceipt','protocolHead'].includes(row.collection)||!isAcceptanceRecord(value))continue;
     if(!acceptanceRecordMatchesFloor(value,floor))error();
     if(value.scope?.profileId!==floor.scope.profileId||value.scope?.workspaceId!==floor.scope.workspaceId)error();
    }
   }
   if(semanticWriterByProfile(actual.requiredWriterProfile?.profile)&&!frame?.profilePreparation)error();
   if(birth.some(id=>!frame?.birthIds.has(id)))error();
   const affected=row=>{
    const value=JSON.parse(row.stateJson),ids=[row.projectId,value.projectId,row.collection==='project'?row.key:undefined,row.collection==='project'?value.id:undefined];
    return ids.some(id=>owned.has(id));
   };
   let change=false;
   for(const row of next){const previous=old.get(key(row));if((affected(row)||previous&&affected(previous))&&(!previous||previous.projectId!==row.projectId||previous.stateJson!==row.stateJson))change=true;}
   const seen=new Set(next.map(key));
   for(const row of rows)if(DELETABLE_COLLECTIONS.includes(row.collection)&&(actual.scope.type==='full'||row.projectId===actual.scope.projectId)&&!seen.has(key(row))&&affected(row))change=true;
   if(change&&!frame)error();
   return actual;
  },
 });
}
export function bindInitialPlanWriteBackend(api){
 const state=backends.get(api);if(!state)return null;if(state.owner)throw Error('initial_plan_original_owner_already_bound');
 const owner=Object.freeze(Object.create(null));state.owner=owner;
 return Object.freeze({
  profile:()=>state.access.profile(),
  rows:()=>state.access.readRows().map(row=>({...row,value:JSON.parse(row.stateJson)})),
  freeze(payload,{birthIds=[],profilePreparation}={}){
   const expectedRevision=state.access.expectedRevision();if(expectedRevision===null)throw Error('initial_plan_frame_outside_original_save');
   const actual=materializePersistenceWriteSet(payload,payload.scope,Boolean(profilePreparation)||Boolean(semanticWriterForFloor(state.access.profile()?.floor)));
   // The plain values are detached; never freeze the original Hub heap.
   const out={...payload,scope:actual.scope,entities:freezeData(actual.entities.map(row=>({collection:row.collection,key:row.key,projectId:row.projectId,value:JSON.parse(row.stateJson)}))),
    humanActions:freezeData(actual.humanActions.map(row=>({collection:row.collection,key:row.key,projectId:row.projectId,value:JSON.parse(row.stateJson)})))};
   frames.set(out,{backend:state,owner,expectedRevision,actual,birthIds:new Set(birthIds),profilePreparation,used:false});
   return Object.freeze(out);
  },
  prepare(scope,profile=ACCEPTANCE_WRITER_PROFILE){if(!semanticWriterByProfile(profile)?.writable)throw Error('writer_profile_unsupported');return Object.freeze({profile,scope:{...scope},storeId:randomUUID()});},
 });
}
/** The cache is not a caller-supplied optimization flag: it is the same exact
 * original frame holder and backend, consumed once at the original SQL boundary. */
export function frozenInitialPlanWriteSet(api,payload){
 const frame=frames.get(payload);return frame?.backend===backends.get(api)?frame.actual:undefined;
}

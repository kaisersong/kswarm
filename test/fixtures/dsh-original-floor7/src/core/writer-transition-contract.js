import {createHash} from 'node:crypto';
import {DEFAULT_DISPATCH_WRITER_PROFILE,DEFAULT_DISPATCH_WRITER_DIGEST} from './initial-plan-acceptance-contract.js';
export const WRITER_TRANSITION_KEY='writer_transition_v1';
export const WRITER_TRANSITION_FUNCTION='kswarm_default_dispatch_transition_writer_v1';
export const WRITER_TRANSITION_PROFILE='default_dispatch_transition_writer_v1';
export const writerTransitionHash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const WRITER_TRANSITION_DIGEST=writerTransitionHash(['default-dispatch-transition-writer-v1','original-private-backend','base-floor-bytes-unchanged','immutable-one-hop','exact-eighteen-native-gates','full-raw-snapshot','independent-current-user-and-quiescence','runtime-closed']);
const writer=Object.freeze({profile:WRITER_TRANSITION_PROFILE,functionName:WRITER_TRANSITION_FUNCTION,digest:WRITER_TRANSITION_DIGEST});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const scope=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===2&&['profileId','workspaceId'].every(key=>typeof value[key]==='string'&&/^[a-f0-9]{64}$/.test(value[key]));
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function writerTransitionTarget(base,domain){
 if(![1,2].includes(base?.schemaVersion)||!scope(domain)||base.schemaVersion===2&&!same(base.scope,domain))throw Error('WRITER_TRANSITION_PROFILE_UNSUPPORTED');
 return{schemaVersion:4,profile:DEFAULT_DISPATCH_WRITER_PROFILE,storeId:base.storeId,writerProfileDigest:DEFAULT_DISPATCH_WRITER_DIGEST,scope:{profileId:domain.profileId,workspaceId:domain.workspaceId}};
}
export function createWriterTransition({baseFloor,baseRaw,scope,snapshotDigest,baseRevision,actorId}){
 const toFloor=writerTransitionTarget(baseFloor,scope),fromFloorRawDigest=writerTransitionHash(baseRaw);
 const migrationId='writer-transition:'+writerTransitionHash(['writer-transition-v1',baseFloor.storeId,fromFloorRawDigest,toFloor,snapshotDigest,baseRevision]);
 return{schemaVersion:1,kind:'writer_floor_transition',migrationId,storeId:baseFloor.storeId,fromFloorRawDigest,fromFloor:baseFloor,toFloor,transitionWriter:{...writer},baseRevision,committedRevision:baseRevision+1,snapshotDigest,actorId};
}
export function readWriterTransition(raw,baseFloor,baseRaw,revision){
 const fail=()=>{throw Error('writer_transition_integrity_failed');};let record;
 try{record=JSON.parse(raw);}catch{fail();}
 const keys=['schemaVersion','kind','migrationId','storeId','fromFloorRawDigest','fromFloor','toFloor','transitionWriter','baseRevision','committedRevision','snapshotDigest','actorId'];
 if(!record||typeof record!=='object'||Array.isArray(record)||JSON.stringify(record)!==raw||Object.keys(record).length!==keys.length||Object.keys(record).some(key=>!keys.includes(key))||record.schemaVersion!==1||record.kind!=='writer_floor_transition'||!same(record.fromFloor,baseFloor)||record.storeId!==baseFloor.storeId||!hex(record.snapshotDigest)||!hex(record.fromFloorRawDigest)||!Number.isSafeInteger(record.baseRevision)||record.baseRevision<0||!Number.isSafeInteger(record.committedRevision)||record.committedRevision!==record.baseRevision+1||revision<record.committedRevision||!same(record.transitionWriter,writer)||!scope(record.toFloor?.scope)||record.actorId!=='desktop-user:'+record.toFloor.scope.profileId)fail();
 let expected;try{expected=createWriterTransition({baseFloor,baseRaw,scope:record.toFloor.scope,snapshotDigest:record.snapshotDigest,baseRevision:record.baseRevision,actorId:record.actorId});}catch{fail();}
 if(!same(record,expected))fail();return record;
}
export function writerTransitionTriggers(){
 const result=new Map();for(const table of ['state_entities','state_entity_history','state_meta'])for(const action of ['INSERT','UPDATE','DELETE']){
  const name=`kswarm_writer_floor_transition_${table}_${action.toLowerCase()}`;
  const immutable=table!=='state_meta'?'':action==='INSERT'?`SELECT CASE WHEN NEW.meta_key='${WRITER_TRANSITION_KEY}' AND EXISTS(SELECT 1 FROM state_meta WHERE meta_key='${WRITER_TRANSITION_KEY}') THEN RAISE(ABORT,'writer_transition_immutable') END;`:`SELECT CASE WHEN ${action==='UPDATE'?`NEW.meta_key='${WRITER_TRANSITION_KEY}' OR `:''}OLD.meta_key='${WRITER_TRANSITION_KEY}' THEN RAISE(ABORT,'writer_transition_immutable') END;`;
  result.set(name,`CREATE TRIGGER ${name} BEFORE ${action} ON ${table} BEGIN SELECT CASE WHEN ${WRITER_TRANSITION_FUNCTION}() IS NOT '${WRITER_TRANSITION_DIGEST}' THEN RAISE(ABORT,'writer_transition_profile_required') END;${immutable} END`);
 }return result;
}

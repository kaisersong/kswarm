import {createHash,randomUUID} from 'node:crypto';
import {DEFAULT_DISPATCH_WRITER_PROFILE,semanticWriterProfiles,semanticWriterByProfile,semanticWriterForFloor} from './initial-plan-acceptance-contract.js';

// This is a storage compatibility gate, NOT the additive semantic-writer
// contract. A future semantic writer must use a different floor/digest/function;
// this intermediate build must never qualify itself for that future contract.
const PROFILE='sqlite_writer_gate_v1';
const FLOOR_KEY='writer_floor_v1';
const FUNCTION='kswarm_writer_profile_v1';
const DIGEST=createHash('sha256').update(JSON.stringify({
  schemaVersion:1,profile:PROFILE,scope:'sqlite-connection-write-gate-only',
  tables:['state_entities','state_entity_history','state_meta'],
  floor:'immutable-singleton',comparison:'IS NOT',additiveSemanticWriter:false,
})).digest('hex');
function triggers(profile){
const semantic=semanticWriterByProfile(profile);
const digest=profile===PROFILE?DIGEST:semantic?.digest;
const fn=profile===PROFILE?FUNCTION:semantic?.functionName;
if(!digest||!fn)throw Error('writer_profile_unsupported');
const result=new Map();
for(const table of ['state_entities','state_entity_history','state_meta']){
  for(const action of ['INSERT','UPDATE','DELETE']){
    const name=`kswarm_writer_floor_${table}_${action.toLowerCase()}`;
    const immutable=table!=='state_meta'?'':action==='INSERT'
      ? `SELECT CASE WHEN NEW.meta_key='${FLOOR_KEY}' AND EXISTS(SELECT 1 FROM state_meta WHERE meta_key='${FLOOR_KEY}') THEN RAISE(ABORT,'writer_floor_immutable') END;`
      : `SELECT CASE WHEN ${action==='UPDATE'?`NEW.meta_key='${FLOOR_KEY}' OR `:''}OLD.meta_key='${FLOOR_KEY}' THEN RAISE(ABORT,'writer_floor_immutable') END;`;
    result.set(name,`CREATE TRIGGER ${name} BEFORE ${action} ON ${table} BEGIN SELECT CASE WHEN ${fn}() IS NOT '${digest}' THEN RAISE(ABORT,'writer_floor_profile_required') END;${immutable} END`);
  }
}
return result;
}
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const validScope=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===2&&['profileId','workspaceId'].every(key=>typeof value[key]==='string'&&/^[a-f0-9]{64}$/.test(value[key]));
const fail=()=>{throw Error('writer_floor_integrity_failed');};

/** No file/process/global configuration and no business authority. The caller
 * installs this on its ORIGINAL SQLite connection before any load/recovery. */
export function createSqliteWriterFloor(db){
  db.function(FUNCTION,{deterministic:true},()=>DIGEST);
  for(const profile of semanticWriterProfiles().filter(item=>item.writable))db.function(profile.functionName,{deterministic:true},()=>profile.digest);
  function read(){
    const triggersRows=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'kswarm_writer_floor_*'").all();
    const hasMeta=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='state_meta'").get();
    const raw=hasMeta?db.prepare('SELECT meta_value FROM state_meta WHERE meta_key=?').get(FLOOR_KEY)?.meta_value:undefined;
    if(raw===undefined){if(triggersRows.length)fail();return null;}
    if(typeof raw!=='string'||raw.length>4096)fail();
    let floor;try{floor=JSON.parse(raw);}catch{fail();}
    const semantic=semanticWriterForFloor(floor),profile=semantic?.profile??PROFILE;
    const fields=semantic?['schemaVersion','profile','storeId','writerProfileDigest','scope']:['schemaVersion','profile','storeId','writerProfileDigest'];
    const expected=triggers(profile);
    if(!floor||Array.isArray(floor)||JSON.stringify(floor)!==raw||Object.keys(floor).length!==fields.length
      ||!Object.keys(floor).every(key=>fields.includes(key))||floor.schemaVersion!==(semantic?.schemaVersion??1)||floor.profile!==profile
      ||floor.writerProfileDigest!==(semantic?.digest??DIGEST)||!uuid(floor.storeId)||semantic&&!validScope(floor.scope)
      ||triggersRows.length!==expected.size||triggersRows.some(row=>expected.get(row.name)!==row.sql))fail();
    return floor;
  }
  return Object.freeze({
    read,
    assertWritable(){const floor=read();if(floor&&floor.profile!==PROFILE&&!semanticWriterForFloor(floor)?.writable)throw Error('writer_profile_unsupported');return floor;},
    // Must run within the original owner's BEGIN IMMEDIATE, together with its
    // write set. Never opens another transaction or lazily repairs a floor.
    require(requested){
      const semantic=requested&&typeof requested==='object'?semanticWriterByProfile(requested.profile):undefined;
      if(requested!==undefined&&requested!==PROFILE&&!semantic)throw Error('writer_profile_unsupported');
      if(semantic&&!semantic.writable)throw Error('writer_profile_unsupported');
      if(semantic&&(!uuid(requested.storeId)||!validScope(requested.scope)))throw Error('writer_profile_unsupported');
      const current=read();
      if(current&&current.profile!==PROFILE&&!semanticWriterForFloor(current)?.writable)throw Error('writer_profile_unsupported');
      if(current){
        if(requested!==undefined&&(current.profile!==(semantic?.profile??PROFILE)
          ||semantic&&(current.storeId!==requested.storeId||JSON.stringify(current.scope)!==JSON.stringify(requested.scope))))throw Error('writer_profile_upgrade_unsupported');
        return current;
      }
      if(requested===undefined)return null;
      if(semantic?.profile===DEFAULT_DISPATCH_WRITER_PROFILE&&(db.prepare('SELECT 1 FROM state_entities LIMIT 1').get()||db.prepare('SELECT 1 FROM state_entity_history LIMIT 1').get()))throw Error('DEFAULT_DISPATCH_MIGRATION_REQUIRED');
      const profile=semantic?.profile??PROFILE;
      const floor=semantic?{schemaVersion:semantic.schemaVersion,profile,storeId:requested.storeId,writerProfileDigest:semantic.digest,scope:{...requested.scope}}
        :{schemaVersion:1,profile,storeId:randomUUID(),writerProfileDigest:DIGEST};
      db.prepare('INSERT INTO state_meta(meta_key,meta_value) VALUES (?,?)').run(FLOOR_KEY,JSON.stringify(floor));
      for(const sql of triggers(profile).values())db.exec(sql);
      return read();
    },
    describe:()=>({schemaVersion:1,supportedProfile:PROFILE,writerProfileDigest:DIGEST,floor:read()}),
  });
}

import {ALL_COLLECTIONS,sha256Hex} from './state-scope.js';
import {isAcceptanceRecord,acceptanceRecordMatchesFloor} from './initial-plan-acceptance-contract.js';
import {readProjectProtocolBinding} from './project-protocol.js';
import {writerTransitionHash} from './writer-transition-contract.js';
const fail=()=>{throw Error('WRITER_TRANSITION_SNAPSHOT_UNVERIFIED');};
export function assertTransitionSerialization(){if(Object.getOwnPropertyDescriptor(Object.prototype,'toJSON')||Object.getOwnPropertyDescriptor(Array.prototype,'toJSON'))fail();}
/** Only called inside an operation on the original native connection. Hash raw
 * columns, without normalizing, repairing, or rewriting any business/history row. */
export function readWriterTransitionSnapshot(db,writerFloor){
 assertTransitionSerialization();const details=writerFloor.details();if(details.transition||![1,2].includes(details.baseFloor?.schemaVersion))throw Error('WRITER_TRANSITION_PROFILE_UNSUPPORTED');
 const meta=db.prepare('SELECT meta_key,meta_value FROM state_meta ORDER BY meta_key').all(),revisionRaw=meta.find(row=>row.meta_key==='revision')?.meta_value,revision=Number(revisionRaw);
 if(typeof revisionRaw!=='string'||!Number.isSafeInteger(revision)||revision<0||String(revision)!==revisionRaw)fail();
 const entities=db.prepare('SELECT collection,entity_key,project_id,state_json,checksum,revision,updated_at FROM state_entities ORDER BY collection,entity_key').all();
 const history=db.prepare('SELECT rowid,collection,entity_key,project_id,state_json,checksum,revision,updated_at FROM state_entity_history ORDER BY rowid').all();
 const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'kswarm_writer_floor_*' ORDER BY name").all();
 const parsed=[];for(const row of [...entities,...history]){
  if(!ALL_COLLECTIONS.includes(row.collection)||typeof row.entity_key!=='string'||!row.entity_key||typeof row.state_json!=='string'||sha256Hex(row.state_json)!==row.checksum||!Number.isSafeInteger(row.revision)||row.revision<0||row.revision>revision||typeof row.updated_at!=='string'||row.project_id!==null&&typeof row.project_id!=='string')fail();
  let value;try{value=JSON.parse(row.state_json);}catch{fail();}if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value)!==row.state_json)fail();
  const identities={project:'id',board:'projectId',workflowRun:'id',workflowProposal:'id',finalDeliverable:'deliverableId',reviewGateDecision:'gateId',reviewCondition:'conditionId',humanAction:'id',protocolReceipt:'id',protocolHead:'id'};
  if(value[identities[row.collection]]!==row.entity_key||row.collection==='project'&&row.project_id!==value.id||row.collection!=='project'&&(value.projectId??null)!==row.project_id)fail();
  if(['protocolReceipt','protocolHead'].includes(row.collection)&&isAcceptanceRecord(value)&&(!acceptanceRecordMatchesFloor(value,details.baseFloor)||JSON.stringify(value.scope)!==JSON.stringify(details.baseFloor.scope)))fail();
  if(entities.includes(row))parsed.push({...row,value});
 }
 const projects=parsed.filter(row=>row.collection==='project'),boards=parsed.filter(row=>row.collection==='board'),receipts=new Map(parsed.filter(row=>row.collection==='protocolReceipt').map(row=>[row.entity_key,row.value]));
 if(details.baseFloor.schemaVersion===1&&(entities.length||history.length))throw Error('WRITER_TRANSITION_PROFILE_UNSUPPORTED');
 for(const project of projects){const binding=readProjectProtocolBinding(project.entity_key,receipts),domain=details.baseFloor.scope;if(binding.classification!=='ordinary'||JSON.stringify(binding.binding.scope)!==JSON.stringify(domain)||!boards.some(row=>row.entity_key===project.entity_key)||project.project_id!==project.entity_key)fail();}
 if(boards.some(row=>!projects.some(project=>project.entity_key===row.entity_key)))fail();
 return Object.freeze({baseFloor:Object.freeze(details.baseFloor),baseRaw:details.baseRaw,revision,digest:writerTransitionHash({meta,entities,history,triggers}),projectIds:Object.freeze(projects.map(row=>row.entity_key)),businessRows:entities.length,historyRows:history.length});
}

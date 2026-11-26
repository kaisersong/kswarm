import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ADDITIVE_INITIAL_PLAN='ordinary_initial_plan_additive_v1';
export const ACCEPTANCE_WRITER_PROFILE='ordinary_initial_plan_acceptance_writer_v1';
// B persistence/acceptance compatibility only, never a Main/N/M/P grant. This
// distinct function/digest cannot be implemented by the earlier gate-only build.
export const ACCEPTANCE_WRITER_DIGEST=digest(['b-initial-plan-acceptance-writer-v1',
 'native-sqlite-write-fence','original-controller-frame','single-materialization',
 'plain-data-whole-write-set','unknown-policy-read-failstop',
 'global-cas','non-reentrant','load-no-recovery','no-legacy-birth']);
export const ACCEPTANCE_HANDLER_DIGEST=digest(['ordinary-initial-plan-additive-handler-v1',
 'born-claim-head','semantic-schema-v1','default-invalidation','private-projection',
 'fixed-command','zero-delta-first-slice']);
export const ADDITIVE_INITIAL_PLAN_DESCRIPTOR=Object.freeze({protocol:ADDITIVE_INITIAL_PLAN,
 acceptanceSchemaVersion:1,semanticSchemaVersion:1,handlerDigest:ACCEPTANCE_HANDLER_DIGEST,writerFloorDigest:ACCEPTANCE_WRITER_DIGEST});
// A distinct, closed storage/semantic profile for the new original-owner
// task protocol. Exported identity is not an activation or execution grant.
export const TASK_ADDITIVE_INITIAL_PLAN='ordinary_initial_plan_additive_v2';
export const TASK_WRITER_PROFILE='ordinary_task_addition_writer_v2';
export const TASK_WRITER_DIGEST=digest(['ordinary-task-addition-writer-v2',
 'native-sqlite-write-fence','original-controller-frame','single-materialization',
 'plain-data-whole-write-set','global-cas','non-reentrant','load-no-recovery',
 'headless-protection','immutable-task-receipt','reverse-additive-proof']);
export const TASK_HANDLER_DIGEST=digest(['ordinary-initial-plan-additive-handler-v2',
 'born-pristine-task-baseline','semantic-schema-v2','reverse-additive-proof',
 'fixed-command-union','candidate-required','composite-single-owner-revision']);
export const TASK_ADDITIVE_DESCRIPTOR=Object.freeze({protocol:TASK_ADDITIVE_INITIAL_PLAN,
 acceptanceSchemaVersion:2,semanticSchemaVersion:2,handlerDigest:TASK_HANDLER_DIGEST,writerFloorDigest:TASK_WRITER_DIGEST});
const SEMANTIC_WRITERS=Object.freeze([
 Object.freeze({schemaVersion:2,writable:true,profile:ACCEPTANCE_WRITER_PROFILE,digest:ACCEPTANCE_WRITER_DIGEST,functionName:'kswarm_initial_plan_acceptance_writer_v1',descriptor:ADDITIVE_INITIAL_PLAN_DESCRIPTOR}),
 Object.freeze({schemaVersion:3,writable:false,profile:TASK_WRITER_PROFILE,digest:TASK_WRITER_DIGEST,functionName:'kswarm_task_addition_writer_v2',descriptor:TASK_ADDITIVE_DESCRIPTOR}),
]);
export const semanticWriterProfiles=()=>SEMANTIC_WRITERS;
export const semanticWriterByProfile=profile=>SEMANTIC_WRITERS.find(item=>item.profile===profile);
export const semanticWriterForFloor=floor=>SEMANTIC_WRITERS.find(item=>item.schemaVersion===floor?.schemaVersion&&item.profile===floor.profile&&item.digest===floor.writerProfileDigest);
// Recognition is deliberately broader than support. A reserved future or
// malformed-version record must retain its protected ownership even before a
// claim/head exists; recognizing it never qualifies a reader, writer or runner.
const reservedContract=value=>typeof value==='string'&&(value.startsWith('ordinary_initial_plan_additive_')||value.startsWith('ordinary_task_addition_'));
export function isAcceptanceRecord(value){
 return reservedContract(value?.contract)||reservedContract(value?.initialPlanning?.contract?.protocol)
  ||['project_protocol_binding','project_create_receipt'].includes(value?.kind)&&Object.hasOwn(value.initialPlanning??{},'contract')
  ||value?.kind==='project_create_receipt'&&Object.hasOwn(value.snapshot??{},'initialPlanWriterStoreId')
  ||['initial_plan_reservation','initial_plan_commit_receipt'].includes(value?.kind)&&value.schemaVersion!==1
  ||typeof value?.kind==='string'&&(value.kind.startsWith('initial_plan_acceptance_')||value.kind.startsWith('ordinary_task_addition_')||value.kind.startsWith('initial_plan_additive_delta'));
}

// Recognition reserves ownership; support is separately closed and versioned.
// In particular, an incomplete v2 implementation cannot use a v1 owner's frame.
export function acceptanceRecordMatchesFloor(value,floor){
 const writer=semanticWriterForFloor(floor);if(!writer?.writable)return false;
 const descriptor=writer.descriptor;
 if(['project_protocol_binding','project_create_receipt'].includes(value?.kind)){
  const contract=value.initialPlanning?.contract;
  return value.schemaVersion===1&&contract&&Object.keys(contract).length===Object.keys(descriptor).length
   &&Object.keys(descriptor).every(key=>contract[key]===descriptor[key]);
 }
 if(value?.contract!==descriptor.protocol)return false;
 const versions=writer.schemaVersion===2?{initial_plan_reservation:2,initial_plan_commit_receipt:2,initial_plan_acceptance_head:1,initial_plan_acceptance_invalidation:1}:{};
 return Object.hasOwn(versions,value.kind)&&value.schemaVersion===versions[value.kind];
}

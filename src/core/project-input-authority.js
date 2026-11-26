import {ADDITIVE_INITIAL_PLAN,ADDITIVE_INITIAL_PLAN_DESCRIPTOR,TASK_ADDITIVE_INITIAL_PLAN,TASK_ADDITIVE_DESCRIPTOR} from './initial-plan-acceptance-contract.js';
import {validateRoomUserSource} from './room-user-source-contract.js';
// Composition-root authority for the authenticated Desktop channel. These
// objects never cross JSON/IPC and are not exposed to model tools. The server
// issues them only after authenticating Main; Main verifies its source journal.
const authorities = new WeakMap();
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;

export function createProjectInputAuthority(scope) {
  if (!hash(scope?.profileId) || !hash(scope?.workspaceId)) throw Error('project_input_scope_invalid');
  const domain = Object.freeze({profileId: scope.profileId, workspaceId: scope.workspaceId});
  const issue = (kind, source, creation) => {
    const token = Object.freeze(Object.create(null));
    authorities.set(token, Object.freeze({requestSource: 'user', kind, ...domain, ...(source ? {source} : {}),...(creation?{creation}:{})}));
    return token;
  };
  return Object.freeze({
    reader: () => issue('desktop_control'),
    planner: () => issue('initial_planner'),
    creator(canonicalCreateOperationId,contract='ordinary_initial_plan_v1') {
      if(!['ordinary_initial_plan_v1',ADDITIVE_INITIAL_PLAN,TASK_ADDITIVE_INITIAL_PLAN].includes(contract))throw Error('initial_plan_contract_unsupported');
      if(!id(canonicalCreateOperationId))throw Error('project_create_operation_invalid');
      const descriptor=contract===ADDITIVE_INITIAL_PLAN?ADDITIVE_INITIAL_PLAN_DESCRIPTOR:contract===TASK_ADDITIVE_INITIAL_PLAN?TASK_ADDITIVE_DESCRIPTOR:null;
      return issue('main_bootstrap_create',undefined,Object.freeze({producer:'desktop_main_v1',canonicalCreateOperationId,planGeneration:1,...(descriptor?{contract:descriptor}:{})}));
    },
    user(source) {
      if(source?.schemaVersion===3)return issue('user_input',validateRoomUserSource(source,domain));
      if (!source || source.profileId !== domain.profileId || source.workspaceId !== domain.workspaceId
        || !id(source.threadId) || !/^main-user-message:[a-f0-9]{64}$/.test(source.canonicalMessageId)
        || !/^main-user-task:[a-f0-9]{64}$/.test(source.canonicalUserTaskId) || !hash(source.promptSha256)
        || !['auto', 'default'].includes(source.permissionMode)) throw Error('project_input_source_invalid');
      const fields = ['schemaVersion','profileId','workspaceId','threadId','canonicalMessageId','canonicalUserTaskId','promptSha256','permissionMode'];
      if(source.schemaVersion===1){
        if(!id(source.sourceGoalId)||!id(source.sourceGoalTurnId)||!Number.isSafeInteger(source.sourceGoalEpoch)||source.sourceGoalEpoch<0)throw Error('project_input_source_invalid');
        fields.push('sourceGoalId','sourceGoalTurnId','sourceGoalEpoch');
      }else if(source.schemaVersion===2&&source.sourceFamily==='main_user_submission'){
        const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
        if(typeof source.submissionId!=='string'||!new RegExp('^main-submission:'+uuid+':'+uuid+'$').test(source.submissionId)
          ||!id(source.sourceTaskId)||!id(source.sourceSessionId))throw Error('project_input_source_invalid');
        fields.push('sourceFamily','submissionId','sourceTaskId','sourceSessionId');
      }else throw Error('project_input_source_invalid');
      if(Object.keys(source).some(key=>!fields.includes(key)))throw Error('project_input_source_invalid');
      return issue('user_input', Object.freeze(Object.fromEntries(fields.map(key => [key, source[key]]))));
    },
  });
}

export function resolveProjectInputAuthority(token) {
  return token && typeof token === 'object' ? authorities.get(token) : undefined;
}

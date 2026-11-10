import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createHub} from '../src/core/hub.js';
import {createProjectInputAuthority,resolveProjectInputAuthority} from '../src/core/project-input-authority.js';
import {protocolDigest} from '../src/core/project-protocol.js';
import {roomSourceFor as sourceFor} from './fixtures/room-user-source-data.js';
const sha=value=>createHash('sha256').update(value).digest('hex'),scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},authority=createProjectInputAuthority(scope);
async function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'room-b-source-')),options={silent:true,dataDir:{backend:'sqlite',filePath:join(directory,'state.sqlite')},brokerClient:{async getRoomSnapshot(){return {ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){return {ok:true};}}};
 let hub=createHub(options);await hub.createProject({id:'p',name:'P',goal:'Goal',poAgent:'po',primaryRoomId:'room',autoAssignPo:false},{requestSource:'user',projectInputAuthority:authority.creator('main-create')});
 t.after(()=>{hub.closePersistence();rmSync(directory,{recursive:true,force:true});});
 return {get hub(){return hub;},bindingDigest:protocolDigest(hub.getProjectProtocolBinding('p').binding),reopen(){hub.closePersistence();hub=createHub(options);return hub;}};
}
test('Room source is a distinct closed family and never borrows Goal/Host/thread identity',()=>{
 const {source}=sourceFor('d'.repeat(64)),token=authority.user(source),trusted=resolveProjectInputAuthority(token);
 assert.equal(trusted.kind,'user_input');assert.equal(trusted.source.sourceFamily,'main_room_conversion_v1');
 for(const key of ['threadId','sourceGoalId','sourceGoalTurnId','sourceGoalEpoch','sourceTaskId','sourceSessionId'])assert.equal(Object.hasOwn(trusted.source,key),false);
 for(const extra of [{threadId:'fake-thread'},{sourceGoalId:'fake-goal'},{sourceTaskId:'fake-task'},{sourceSessionId:'fake-session'},{schemaVersion:2},{permissionMode:'plan'},{permissionMode:'auto'},{actorId:'desktop-user:other'},{brokerUserId:'other'},{canonicalMessageId:'main-user-message:'+'e'.repeat(64)},{captureId:source.captureId.replace('4111','5111')},{originKey:'f'.repeat(64)}])assert.throws(()=>authority.user({...source,...extra}),/project_input_source_invalid/);
});
test('valid Room metadata reaches only the existing explicit capability rejection and has stable separate operation history',async t=>{
 const f=await fixture(t),{source,input}=sourceFor(f.bindingDigest),token=authority.user(source);
 const first=f.hub.applyOrdinaryProjectInput('p',input,token);assert.equal(first.error,'CANDIDATE_WORKSPACE_UNAVAILABLE');assert.equal(first.operation.sourceFamily,'main_room_conversion_v1');assert.equal(Object.hasOwn(first.operation,'sourceThreadId'),false);assert.equal(first.operation.originRefs.roomMessageId,'message');
 assert.equal(f.hub.getBoard('p').getAllTasks().length,0);assert.equal(f.hub.getProject('p').projectRevision,1);
 const replay=f.reopen().applyOrdinaryProjectInput('p',input,authority.user(source));assert.deepEqual(replay,first);
 assert.deepEqual(f.hub.readOrdinaryProjectOperation('p',first.operation.operationId,authority.user(source)),first);
 assert.equal(f.hub.readOrdinaryProjectOperation('p',first.operation.operationId,authority.user({...source,projectId:'other'})).error,'PROJECT_INPUT_AUTHORITY_REQUIRED');
 const old=authority.user({schemaVersion:1,...scope,threadId:'thread',canonicalMessageId:source.canonicalMessageId,canonicalUserTaskId:source.canonicalUserTaskId,promptSha256:source.promptSha256,permissionMode:'default',sourceGoalId:'g',sourceGoalEpoch:1,sourceGoalTurnId:'turn'});
 assert.equal(f.hub.readOrdinaryProjectOperation('p',first.operation.operationId,old).error,'PROJECT_INPUT_AUTHORITY_REQUIRED');
});
test('target, action, exact wire, source body and binding are validated before either new writes or old-receipt replay',async t=>{
 const f=await fixture(t),{source,input}=sourceFor(f.bindingDigest);
 const before=f.hub.getPersistenceHealth().revision;assert.equal(Number.isSafeInteger(before),true);
 for(const [changedSource,changedInput] of [
  [{projectId:'other'},{}],[{projectBindingDigest:'e'.repeat(64)},{}],[{inputDigest:'e'.repeat(64)},{}],[{userIntentHash:'e'.repeat(64)},{}],[{envelopeHash:'e'.repeat(64)},{}],
  [{},{title:'changed'}],[{},{body:'replaced'}],[{},{planRunId:'forged'}],[{},{logicalArtifactId:'artifact'}],[{},{action:'add_plan_input'}],
 ])assert.equal(f.hub.applyOrdinaryProjectInput('p',{...input,...changedInput},authority.user({...source,...changedSource})).error,'USER_INPUT_SOURCE_MISMATCH');
 assert.equal(f.hub.getPersistenceHealth().revision,before);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
 const saved=f.hub.applyOrdinaryProjectInput('p',input,authority.user(source)),revision=f.hub.getPersistenceHealth().revision;
 assert.equal(f.hub.applyOrdinaryProjectInput('p',input,authority.user({...source,userIntentHash:'f'.repeat(64)})).error,'USER_INPUT_SOURCE_MISMATCH');assert.equal(f.hub.getPersistenceHealth().revision,revision);
 assert.deepEqual(f.hub.readOrdinaryProjectOperation('p',saved.operation.operationId,authority.reader()),saved);
});
test('an explicit brief, including an empty one, never silently falls back to original Room text',async t=>{
 const f=await fixture(t);
 const bad=sourceFor(f.bindingDigest,{action:'add_task',expectedProjectRevision:1,brief:'',body:'Original Room text'});
 assert.equal(f.hub.applyOrdinaryProjectInput('p',bad.input,authority.user(bad.source)).error,'USER_INPUT_SOURCE_MISMATCH');
 const good=sourceFor(f.bindingDigest,{action:'add_task',expectedProjectRevision:1,brief:'User explicit new brief',body:'User explicit new brief'});
 assert.equal(f.hub.applyOrdinaryProjectInput('p',good.input,authority.user(good.source)).error,'CANDIDATE_WORKSPACE_UNAVAILABLE');
});

test('a changed live primary Room refuses a fresh mutation while historical operation reads remain metadata-only',async t=>{
 const f=await fixture(t),{source,input}=sourceFor(f.bindingDigest);f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').primaryRoomId='other-room';});
 const result=f.hub.applyOrdinaryProjectInput('p',input,authority.user(source));assert.equal(result.error,'PROJECT_SCOPE_MISMATCH');assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
 assert.equal(f.hub.readOrdinaryProjectOperation('p',result.operation.operationId,authority.user(source)).error,'PROJECT_SCOPE_MISMATCH');
});
test('the public sibling rechecks current Room on replay while authenticated historical metadata stays readable',async t=>{
 const f=await fixture(t),{source,input}=sourceFor(f.bindingDigest),token=authority.user(source),saved=f.hub.applyOrdinaryProjectInput('p',input,token);assert.equal(saved.error,'CANDIDATE_WORKSPACE_UNAVAILABLE');
 f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').primaryRoomId='other-room';});const revision=f.hub.getPersistenceHealth().revision;
 assert.deepEqual(f.hub.applyOrdinaryProjectInput('p',input,token),{ok:false,error:'PROJECT_SCOPE_MISMATCH'});assert.equal(f.hub.getPersistenceHealth().revision,revision);
 assert.deepEqual(f.hub.readOrdinaryProjectOperation('p',saved.operation.operationId,token),{ok:false,error:'PROJECT_SCOPE_MISMATCH'});
 assert.deepEqual(f.hub.readOrdinaryProjectOperation('p',saved.operation.operationId,authority.reader()),saved);
});

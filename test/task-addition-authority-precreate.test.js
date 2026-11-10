import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHub} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {createProjectInputAuthority,resolveProjectInputAuthority} from '../src/core/project-input-authority.js';
const contract='ordinary_initial_plan_additive_v2',scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
for(const oldFloor of [false,true])test(`a v2 creation authority is recognized but cannot reach Room under qualified old floor=${oldFloor}`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'v2-precreate-')),filePath=join(root,'state.sqlite'),persistence=createSqlitePersistence({filePath}),authority=createProjectInputAuthority(scope);let roomCalls=0;
 const hub=createHub({silent:true,persistence,brokerClient:{async getRoomSnapshot(){roomCalls++;return {ok:true,room:{status:'active'},members:[]};},async acquireRoomMembershipLease(){roomCalls++;return {ok:true};}}});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 if(oldFloor)assert.equal(hub.prepareInitialPlanAcceptanceWriter({requestSource:'user',projectInputAuthority:authority.reader()}).ok,true);
 const revision=persistence.revision;
 const token=authority.creator('main-create-v2',contract),metadata=resolveProjectInputAuthority(token);
 assert.equal(metadata.creation.contract.protocol,contract);assert.equal(Object.keys(token).length,0);
 await assert.rejects(async()=>hub.createProject({id:'p',name:'P',goal:'G',primaryRoomId:'r',poAgent:'po',members:[],autoAssignPo:false},{requestSource:'user',projectInputAuthority:token}),/INITIAL_PLAN_PROFILE_UNQUALIFIED/);
 assert.equal(roomCalls,0);assert.equal(hub.getProject('p'),undefined);assert.equal(persistence.revision,revision);
});
test('the authority still rejects a future or misspelled contract rather than inventing its descriptor',()=>{
 const authority=createProjectInputAuthority(scope);
 for(const contract of ['ordinary_initial_plan_additive_v3','ordinary_initial_plan_additive_v2 '])assert.throws(()=>authority.creator('main-op',contract),/initial_plan_contract_unsupported/);
});

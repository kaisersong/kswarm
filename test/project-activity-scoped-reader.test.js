import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHub} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
async function fixture(t,wrapped=false){
 const root=mkdtempSync(join(tmpdir(),'scoped-project-activity-')),backend=createSqlitePersistence({filePath:join(root,'state.sqlite')}),authority=createProjectInputAuthority(scope);
 let duringFactory,failSave;const effects=[];
 const persistence={...backend,save(factory,actualScope){if(failSave)throw failSave;return backend.save(committedScope=>{const payload=factory(committedScope);duringFactory?.();return payload;},actualScope);}};
 const hub=createHub({silent:true,persistence:wrapped?persistence:backend,bridge:{send(value){effects.push(value);}},runtimeInstanceAllocator:{reserveWorkerInstance(value){effects.push(value);throw Error('No execution reservation permitted');}},brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){return{ok:true};}}});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 await hub.createProject({id:'p',name:'P',goal:'Scoped metadata',poAgent:'po',primaryRoomId:'room',autoAssignPo:false},{requestSource:'user',projectInputAuthority:authority.creator('create-p')});effects.length=0;
 return{hub,backend,authority,effects,setFactory:callback=>{duringFactory=callback;},fail:error=>{failSave=error;}};
}
const requireReader=hub=>{assert.equal(typeof hub.readScopedProjectActivity,'function','original Hub scoped metadata reader missing');return hub.readScopedProjectActivity.bind(hub);};
test('the original opaque reader returns the committed page with exact double-domain scope and no original effects',async t=>{
 const f=await fixture(t),read=requireReader(f.hub),before=f.backend.getHealth().revision,page=f.hub.getProjectActivity('p'),project=structuredClone(f.hub.getProject('p'));
 const result=read('p',{after:0,limit:200},f.authority.reader());assert.equal(result.ok,true);assert.equal(result.protocol,'scoped_project_activity_v1');assert.equal(result.projectId,'p');assert.deepEqual(result.scope,scope);assert.match(result.bindingDigest,/^[a-f0-9]{64}$/);assert.deepEqual(result.page,page);
 result.page.snapshot.name='caller copy';assert.deepEqual(f.hub.getProjectActivity('p'),page);assert.deepEqual(f.hub.getProject('p'),project);assert.equal(f.backend.getHealth().revision,before);assert.deepEqual(f.effects,[]);
});
test('JSON/copied reader, planner, creator and foreign profile/workspace cannot qualify the same physical project',async t=>{
 const f=await fixture(t),read=requireReader(f.hub),foreign=[{...scope,profileId:'c'.repeat(64)},{...scope,workspaceId:'d'.repeat(64)}];
 for(const token of [undefined,{},structuredClone(f.authority.reader()),f.authority.planner(),f.authority.creator('another-create')])assert.equal(read('p',{},token).ok,false);
 for(const domain of foreign)assert.equal(read('p',{},createProjectInputAuthority(domain).reader()).error,'PROJECT_SCOPE_MISMATCH');
 assert.deepEqual(f.effects,[]);
});
test('a mutable forged scope cannot upgrade an original unscoped project, whose old event feed stays available',async t=>{
 const f=await fixture(t),read=requireReader(f.hub);f.hub.createProject({id:'legacy',name:'Legacy',goal:'Keep ordinary',poAgent:'po',autoAssignPo:false});
 f.hub.getProject('legacy').scope=scope;assert.equal(read('legacy',{},f.authority.reader()).error,'PROJECT_SCOPE_UNVERIFIED');assert.equal(f.hub.getProjectActivity('legacy').ok,true);
});
test('the original non-input persistence factory cannot combine staged binding with an old committed page',async t=>{
 const f=await fixture(t,true),read=requireReader(f.hub);let inside;
 f.setFactory(()=>{inside=read('p',{},f.authority.reader());});f.hub.persistState({type:'project',projectId:'p'});f.setFactory(undefined);
 assert.deepEqual(inside,{ok:false,error:'PROJECT_ACTIVITY_READ_BUSY'});assert.equal(read('p',{},f.authority.reader()).ok,true);assert.deepEqual(f.effects,[]);
});
test('the scoped display reader does not borrow candidate-required execution admission',async t=>{
 const f=await fixture(t),read=requireReader(f.hub);assert.equal(f.hub.prepareOrdinaryTaskInputWriter({requestSource:'user',projectInputAuthority:f.authority.reader()}).ok,true);
 await f.hub.createProject({id:'candidate',name:'Candidate',goal:'Display only',poAgent:'po',primaryRoomId:'room',autoAssignPo:false},{requestSource:'user',projectInputAuthority:f.authority.creator('candidate-create','ordinary_initial_plan_additive_v2')});
 assert.equal(f.hub.checkProjectExecutionStart('candidate').ok,false);const before=f.backend.getHealth().revision;
 assert.equal(read('candidate',{},f.authority.reader()).ok,true);assert.equal(f.backend.getHealth().revision,before);assert.deepEqual(f.effects,[]);
});
test('actual source cursor/limit validation is retained instead of a second page implementation',async t=>{
 const f=await fixture(t),read=requireReader(f.hub);
 for(const options of [{after:-1},{limit:201}]){let message;try{f.hub.getProjectActivity('p',options);}catch(error){message=error.message;}assert.ok(message);assert.throws(()=>read('p',options,f.authority.reader()),error=>error.message===message);}
});
test('scoped metadata input capture refuses accessors and proxies before executing any caller code',async t=>{
 const f=await fixture(t),read=requireReader(f.hub);let getters=0;
 const options={};Object.defineProperty(options,'after',{enumerable:true,get(){getters++;f.hub.closePersistence();return 0;}});
 assert.throws(()=>read('p',options,f.authority.reader()),/invalid_activity_options/);
 assert.throws(()=>read('p',new Proxy({after:0},{ownKeys(){getters++;return[];}}),f.authority.reader()),/invalid_activity_options/);assert.equal(getters,0);
 assert.throws(()=>read({toJSON(){getters++;return'p';}},{},f.authority.reader()),/invalid_activity_project/);assert.equal(getters,0);assert.equal(read('p',{},f.authority.reader()).ok,true);
});
test('closed and failed original SQLite owners do not issue a scoped positive read',async t=>{
 const f=await fixture(t,true),read=requireReader(f.hub),failure=Error('original save failed');f.fail(failure);assert.throws(()=>f.hub.persistState({type:'project',projectId:'p'}),error=>error===failure);
 assert.equal(read('p',{},f.authority.reader()).ok,false);f.hub.closePersistence();assert.equal(read('p',{},f.authority.reader()).ok,false);
});
test('an original non-SQLite owner cannot qualify scoped project metadata',()=>{
 const hub=createHub({silent:true});try{const read=requireReader(hub);hub.createProject({id:'p',name:'P',goal:'ordinary',poAgent:'po',autoAssignPo:false});assert.equal(read('p',{},createProjectInputAuthority(scope).reader()).error,'PROTECTED_PROTOCOL_STORAGE_REQUIRED');assert.equal(hub.getProjectActivity('p').ok,false);}finally{hub.closePersistence();}
});

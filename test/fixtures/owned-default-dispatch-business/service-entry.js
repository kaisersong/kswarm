// Controlled original-service fixture. No test protocol enters the production
// message stream; readiness is an stdout observation, never business authority.
import {createHub} from '../../../src/core/hub.js';
import {createProjectInputAuthority} from '../../../src/core/project-input-authority.js';
import {createOwnedDefaultDispatchBusiness} from '../../../src/server/owned-default-dispatch-business.js';
import {installOwnedDesktopControl} from '../../../src/server/owned-desktop-control.js';
import {defaultDispatchActionRecord} from '../../../src/core/default-dispatch-action-data.js';
import {writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const root=process.env.DISPATCH_BUSINESS_TEST_ROOT,scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
const reopened=existsSync(join(root,'state.sqlite'));
const runtime6=process.env.DISPATCH_BUSINESS_TEST_RUNTIME6==='1';
const business=createOwnedDefaultDispatchBusiness({scope}),authority=createProjectInputAuthority(scope),control={requestSource:'user',projectInputAuthority:authority.reader()};
const hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath:join(root,'state.sqlite')},defaultDispatchActionSource:business.source,brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true,leaseId:'fixture-lease'};},async releaseRoomMembershipLease(){return{ok:true};}}});
if(!reopened){
 if(!(runtime6?hub.prepareDurableDispatchRuntimeWriter(control):hub.prepareDurableDispatchWriter(control)).ok)throw Error('fixture_prepare_failed');
 await hub.createProject({id:'p',name:'P',goal:'Original service controlled fixture',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},control);
 if(runtime6&&!hub.handleSubmitPlan('p',{analysis:'Controlled empty preparation plan',phases:[]},'po').ok)throw Error('fixture_plan_failed');
 if(!hub.handleHumanAddTasks('p',[{id:'a',title:'A',brief:'Original task',assignedAgent:'worker'}],{requestSource:'user'}).ok)throw Error('fixture_task_failed');
}
const endpoint=business.install(hub),configuration=installOwnedDesktopControl({hub,scope,dispatchBusiness:endpoint}),head=hub.readDefaultDispatchPlan('p',authority.reader()).plan;
writeFileSync(join(root,'ready.json'),JSON.stringify({pid:process.pid,action:defaultDispatchActionRecord({scope,projectId:'p',planRevision:head.revision,dispatchGeneration:head.dispatchGeneration,bindingDigest:head.bindingDigest,taskSetDigest:head.taskSetDigest})}),{flag:'w',mode:0o600});
let closing=false;async function close(){if(closing)return;closing=true;configuration.seal();endpoint.seal();try{await endpoint.drain();hub.closePersistence();process.exit(0);}catch(error){console.error(error);process.exit(1);}}
process.on('SIGTERM',close);process.on('disconnect',close);
console.log('OWNED_BUSINESS_SERVICE_READY');

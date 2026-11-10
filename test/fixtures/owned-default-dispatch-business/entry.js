import {defaultDispatchActionRecord} from '../../../src/core/default-dispatch-action-data.js';
import {join} from 'node:path';
import {createHub} from '../../../src/core/hub.js';
import {createSqlitePersistence} from '../../../src/core/sqlite-persistence.js';
import {createProjectInputAuthority} from '../../../src/core/project-input-authority.js';
import {createOwnedDefaultDispatchBusiness} from '../../../src/server/owned-default-dispatch-business.js';
import {installOwnedDesktopControl} from '../../../src/server/owned-desktop-control.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},filePath=join(process.env.DISPATCH_BUSINESS_TEST_ROOT,'state.sqlite');
const business=createOwnedDefaultDispatchBusiness({scope:{...scope,workspaceId:process.env.DISPATCH_BUSINESS_DOMAIN_WORKSPACE||scope.workspaceId}}),authority=createProjectInputAuthority(scope),control={requestSource:'user',projectInputAuthority:authority.reader()},effects=[];
const persistence=createSqlitePersistence({filePath}),hub=createHub({silent:true,persistence,dataDir:{backend:'sqlite',filePath},defaultDispatchActionSource:business.source,brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true,leaseId:'fixture-lease'};},async releaseRoomMembershipLease(){return{ok:true};}},bridge:{requestTask(input){effects.push(input);return{ok:true};}}});
if(!process.env.DISPATCH_BUSINESS_REOPEN){
 if(!hub.prepareDurableDispatchWriter(control).ok)throw Error('fixture_writer_prepare_failed');
 await hub.createProject({id:'p',name:'P',goal:'Controlled parent IPC fixture',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},control);
 if(!hub.handleHumanAddTasks('p',[{id:'a',title:'A',brief:'Original payload',assignedAgent:'worker'}],{requestSource:'user'}).ok)throw Error('fixture_human_task_failed');
}
globalThis.businessAfterKnownCommit=()=>persistence.close();
let held;const send=process.send.bind(process);
if(process.env.DISPATCH_BUSINESS_HOLD_CALLBACK==='1')process.send=(message,callback)=>send(message,error=>{if(!held&&message.protocol==='kswarm_dispatch_business_v1'&&message.type==='response'){held=()=>callback(error);}else callback(error);});
const endpoint=business.install(hub),configuration=installOwnedDesktopControl({hub,scope,dispatchBusiness:endpoint});
process.stdin.setEncoding('utf8');let inputBuffer='';process.stdin.on('data',text=>{inputBuffer+=text;for(;;){const end=inputBuffer.indexOf('\n');if(end<0)break;const command=inputBuffer.slice(0,end);inputBuffer=inputBuffer.slice(end+1);if(command==='release-sdk')globalThis.releaseStartupSdk?.();if(command==='restore')globalThis.restoreBusinessSdk?.();if(command==='facts')console.log(JSON.stringify({fixture:'sdk-facts',sdk:globalThis.businessSdkFacts,available:endpoint.available,messageListeners:process.listenerCount('message')}));if(command==='release')globalThis.releaseBusinessSdk?.();if(command==='drain')void endpoint.drain().then(()=>console.log(JSON.stringify({fixture:'drain-result',status:'success',sdk:globalThis.businessSdkFacts})),error=>console.log(JSON.stringify({fixture:'drain-result',status:'error',error:String(error),sdk:globalThis.businessSdkFacts})));if(command==='release'&&held){const complete=held;held=()=>{};complete();}if(command==='close')void close();}});
const head=hub.readDefaultDispatchPlan('p',authority.reader()).plan;const localFact=defaultDispatchActionRecord({scope,projectId:'p',planRevision:head.revision,dispatchGeneration:head.dispatchGeneration,bindingDigest:head.bindingDigest,taskSetDigest:head.taskSetDigest});
process.send({protocol:'fixture_ready',effects:effects.length,localFact,available:endpoint.available},()=>{});
let closing=false;async function close(){if(closing)return;closing=true;configuration.seal();endpoint.seal();try{await endpoint.drain();}catch(error){console.log(JSON.stringify({fixture:'business-drain',error:String(error),notProductClose:true}));}hub.closePersistence();console.log(JSON.stringify({fixture:'business-close',effects:effects.length}));process.exit(0);}
process.on('disconnect',close);process.on('SIGTERM',close);

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createHub } from '../src/core/hub.js';
import { workspaceDigest } from '../src/core/room-workspace.js';

test('workspace mapping query authorizes current project members without reading user directories',()=>{
  const hub=createHub({silent:true});
  hub.createProject({id:'p',name:'p',goal:'g',poAgent:'po',members:['worker']});
  assert.equal(hub.getWorkspaceMapping('p',null,'stranger').error,'project_membership_required');
  assert.equal(hub.getWorkspaceMapping('p',null,'worker').project.id,'p');
});

test('real hub stores handoff outside user workFolder, including SQLite dataDir shape', () => {
  const root = mkdtempSync(join(tmpdir(), 'kswarm-room-handoff-'));
  const userRoot = join(root, '用户 目录'); mkdirSync(userRoot);
  const sent = [];
  const hub = createHub({ silent:true, dataDir:{backend:'sqlite',filePath:join(root,'state.sqlite'),silent:true},projectStorageRoot:join(root,'managed'), bridge:{send(){},requestTask(v){sent.push(v);}} });
  const project = hub.createProject({id:'p',name:'p',goal:'g',poAgent:'po',members:['worker']});
  project.workFolder=userRoot;
  hub.handleCreateTasks('p',[{id:'a',title:'Write',brief:'write',assignedAgent:'worker'}],'po');
  hub.handleApprove('p');
  assert.equal(hub.handleRequestDispatch('p','po').ok,true);
  assert.equal(sent.length,1);
  assert.equal(existsSync(join(userRoot,'handoffs')),false);
  assert.equal(sent[0].handoffPath.startsWith(join(root,'managed','p')),true);
  assert.equal(JSON.parse(readFileSync(sent[0].handoffPath,'utf8')).project.workFolder,userRoot);
  hub.closePersistence();
});

test('mapping requires trusted user, authenticated ticket, CAS and durable idempotency; never creates artifacts', async () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'kswarm-mapping-')));
  const workFolder=join(root,'自定义'); mkdirSync(workFolder);
  const payload={projectId:'p',roomId:'r',workspaceId:'w',originHostId:'h',bindingId:'b',generation:1,expectedProjectRevision:1,workFolder,artifactsDir:workFolder};
  const canonical=JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a],[b])=>a.localeCompare(b))));
  const payloadDigest=createHash('sha256').update('xiaok.room-workspace.v1/mapping\n'+canonical).digest('hex');
  const ticket={ticketId:'t',operationId:'op',projectId:'p',roomId:'r',workspaceId:'w',originHostId:'h',bindingId:'b',generation:1,expectedProjectRevision:1,payloadDigest,userPrincipal:'owner',roomSequence:7};
  let accept=true; const calls=[];
  const brokerClient={verifyWorkspaceMappingTicket:async input=>{calls.push(input);return accept?{ok:true,ticket}:{ok:false,error:'ticket_invalid'};},workspaceMappingApplied:async()=>({ok:true})};
  const opts={silent:true,dataDir:join(root,'state.json'),brokerClient};
  let hub=createHub(opts); const p=hub.createProject({id:'p',name:'p',goal:'g'});p.primaryRoomId='r';hub.persistState();
  const request={ticketId:'t',operationId:'op',payload,payloadDigest};
  assert.equal((await hub.applyWorkspaceMapping('p',request,{requestSource:'agent'})).ok,false);
  accept=false; assert.equal((await hub.applyWorkspaceMapping('p',request,{requestSource:'user'})).ok,false);
  accept=true;
  const applied=await hub.applyWorkspaceMapping('p',request,{requestSource:'user'});
  assert.equal(applied.ok,true,JSON.stringify(applied)); assert.equal(applied.mapping.mappingRevision,1);
  assert.equal(hub.getProject('p').artifactsDir,workFolder);
  assert.equal(existsSync(join(workFolder,'artifacts')),false);
  assert.equal(calls.at(-1).ticketId,'t');
  hub.closePersistence();hub=createHub(opts);
  const repeated=await hub.applyWorkspaceMapping('p',request,{requestSource:'user'});
  assert.equal(repeated.ok,true);assert.equal(repeated.reused,true);
  assert.equal(hub.getProject('p').projectRevision,2);
  assert.equal((await hub.applyWorkspaceMapping('p',{...request,payload:{...payload,artifactsDir:root}},{requestSource:'user'})).ok,false);
  assert.equal(hub.handleRequestDispatch('p','po').error,'workspace_claim_required');
  assert.equal(hub.handleResumeTaskForRecovery('p','a').error,'workspace_claim_required');
  assert.equal(hub.handleSubmitResult('p','a',{},'worker','x').error,'workspace_claim_required');
  hub.closePersistence();
});

test('workspace dispatch authenticates a live bound claim and freezes it in the real handoff',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'kswarm-claim-')));
  const sent=[];let valid=true;
  const claim={protocolVersion:1,claimId:'c',runId:'run-c',roomId:'r',projectId:'p',contextScope:{kind:'project',projectId:'p'},workspaceId:'w',originHostId:'h',bindingId:'b',generation:1,mappingRevision:1,executionState:'running',authorizationState:'valid',executorInstanceId:'worker'};
  const config={phase:'active',activeBindingId:'b',workspaceId:'w',originHostId:'h',generation:1};
  const hub=createHub({silent:true,projectStorageRoot:join(root,'managed'),bridge:{send(){},requestTask(v){sent.push(v);}},brokerClient:{verifyWorkspaceClaim:async()=>valid?{ok:true,claim,config}:{ok:false,error:'claim_revoked'},verifyWorkspaceCommitTicket:async input=>({ok:true,ticket:{ticketId:input.ticketId,payloadDigest:input.payloadDigest,subject:{kind:'agentClaim',claimId:'c'},contextScope:claim.contextScope}})}});
  const p=hub.createProject({id:'p',name:'p',goal:'g',poAgent:'po',members:['worker']});
  hub.handleCreateTasks('p',[{id:'a',title:'a',assignedAgent:'worker'}],'po');hub.handleApprove('p');
  p.requiredProtocol='room_workspace_v1';p.primaryRoomId='r';p.workspaceMapping={projectId:'p',roomId:'r',workspaceId:'w',originHostId:'h',bindingId:'b',generation:1,mappingRevision:1,state:'active',workFolder:root,artifactsDir:root};p.workFolder=root;p.artifactsDir=root;
  valid=false;assert.equal((await hub.dispatchWorkspaceTask('p',{taskId:'a',claimId:'c'})).ok,false);assert.equal(sent.length,0);
  valid=true;const result=await hub.dispatchWorkspaceTask('p',{taskId:'a',claimId:'c'});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(sent.length,1);
  assert.equal(sent[0].runId,'run-c');
  assert.equal(sent[0].requiredProtocol,'room_workspace_v1');assert.equal(sent[0].workspaceContext.claimId,'c');
  const handoff=JSON.parse(readFileSync(sent[0].handoffPath,'utf8'));
  assert.equal(handoff.workspaceContext.claimId,'c');assert.equal(handoff.project.artifactsDir,root);
  assert.equal(handoff.contextPolicy.resultManifest,join(root,'managed','p','handoffs','run-c','result.json'));
  assert.equal((await hub.submitWorkspaceTaskResult('p',{taskId:'a',claimId:'c',result:{}})).error,'workspace_commit_ticket_required');
  hub.handleAcceptTask('p','a','worker','run-c');hub.handleProgress('p','a','started','worker','run-c');
  valid=false; // Already signed ticket remains historical authorization after revocation.
  const output={summary:'This is a sufficiently detailed result describing the finished work and the completed verification.'};
  const payloadDigest=workspaceDigest('project-result',{projectId:'p',taskId:'p__a',claimId:'c',runId:'run-c',result:output});
  const submission={taskId:'a',claimId:'c',ticketId:'ticket-c',submissionId:'s',payloadDigest,result:output};
  assert.equal((await hub.submitWorkspaceTaskResult('p',submission)).ok,true);
  assert.equal((await hub.submitWorkspaceTaskResult('p',submission)).reused,true);
});

test('startup rejects unsupported persisted workspace protocol and reports v1 baseline',()=>{
  const root=mkdtempSync(join(tmpdir(),'kswarm-baseline-')),file=join(root,'state.json');
  const hub=createHub({silent:true});
  assert.deepEqual(hub.getWorkspaceProtocolBaseline().protocols.room_workspace_v1,{contextVersion:1,resultVersion:1,releaseVersion:1});
  writeFileSync(file,JSON.stringify({projects:[{id:'p',name:'p',requiredProtocol:'room_workspace_v999'}]}));
  assert.throws(()=>createHub({silent:true,dataDir:file}),/workspace_protocol_unsupported/);
});

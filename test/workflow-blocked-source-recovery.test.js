import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createHub} from '../src/core/hub.js';import {buildArtifactManifest} from '../src/core/artifact-manifest.js';import {deriveProjectIntervention} from '../src/core/project-intervention.js';
function fixture({persistent=false}={}){
 const root=mkdtempSync(join(tmpdir(),'fictional-blocked-workflow-'));mkdirSync(join(root,'artifacts'));
 const options={silent:true,...(persistent?{dataDir:{backend:'sqlite',filePath:join(root,'state.sqlite'),legacyJsonPath:join(root,'state.json'),silent:true}}:{})};
 const hub=createHub(options),project=hub.createProject({id:'fictional-source',name:'Fictional report',goal:'Verify existing evidence',poAgent:'xiaok-po',members:['xiaok-worker'],workFolder:root});
 assert.equal(hub.handleHumanAddTasks(project.id,[{id:'item-1',title:'Fictional document',assignedAgent:'xiaok-worker',requiredOutputs:['markdown']},{id:'item-2',title:'Fictional next step',assignedAgent:'xiaok-worker',dependencies:['item-1']}],{requestSource:'user'}).ok,true);
 assert.equal(hub.handleApprove(project.id).ok,true);const board=hub.getBoard(project.id),[task,downstream]=board.getAllTasks();task.executionStrategyOverride='workflow';
 const handoff=hub.handleRequestDispatch(project.id,'xiaok-po').workflowNodeDispatches[0];assert.ok(handoff);const run=hub.getWorkflowRun(handoff.workflowRunId),artifact=join(root,'artifacts','fictional-report.md');writeFileSync(artifact,'# Fictional report\nVerified evidence and bounded conclusions.\n');
 return {root,options,hub,project,board,task,downstream,handoff,run,artifact,close(){hub.closePersistence();rmSync(root,{recursive:true,force:true});}};
}
function produce(f){const h=f.handoff,r=f.hub.handleWorkflowNodeResult({workflowRunId:h.workflowRunId,nodeId:h.nodeId,attempt:h.attempt,handoffId:h.handoffId,fromAgent:h.targetParticipantId,output:{summary:'Fictional evidence has been verified and the complete report is ready for independent review.',artifacts:[{path:f.artifact,kind:'markdown'}],workFolder:f.root,evidenceRefs:['artifact:'+f.artifact]}});assert.equal(r.ok,true);assert.ok(r.dispatches[0]);return r.dispatches[0];}
function unavailable(f,h=f.handoff){return f.hub.handleWorkflowRuntimeUnavailable({workflowRunId:h.workflowRunId,nodeId:h.nodeId,attempt:h.attempt,handoffId:h.handoffId,reason:'WORKFLOW_RUN_DEADLINE_EXCEEDED'});}
function assertBlocked(f){assert.equal(f.task.status,'blocked');assert.equal(f.task.activeRunId,null);assert.equal(f.task.runLease,null);assert.equal(f.task.blockKind,'workflow_blocked');assert.equal(f.downstream.status,'pending');assert.equal(f.task.result,null);assert.equal(deriveProjectIntervention({project:f.project,tasks:f.board.getAllTasks()}).required,true);}
for(const mode of ['worker-unavailable','review-unavailable','malformed-review','blocked-review'])test(`real Hub synchronizes ${mode} without accepting unreviewed output`,()=>{
 const f=fixture();try{let r;if(mode==='worker-unavailable')r=unavailable(f);else{const review=produce(f);r=mode==='review-unavailable'?unavailable(f,review):f.hub.handleWorkflowNodeReview({workflowRunId:review.workflowRunId,nodeId:review.nodeId,attempt:review.attempt,handoffId:review.handoffId,fromAgent:review.targetParticipantId,reviewDecision:mode==='malformed-review'?{status:'unknown'}:{status:'blocked',reason:'Fictional evidence needs independent verification',evidenceRefs:[]}});}
 assert.equal(r.ok,true);assert.equal(r.workflowRun.status,'blocked');assertBlocked(f);
 if(mode!=='worker-unavailable'){const worker=r.workflowRun.nodes.find(n=>n.id===f.handoff.nodeId);assert.equal(worker.status,'completed');assert.equal(worker.output.artifacts[0].path,f.artifact);}assert.notEqual(r.workflowRun.gateDecision?.status,'passed');
 }finally{f.close();}
});
test('duplicate unavailable receipts preserve the source recovery timestamp',()=>{const f=fixture();try{const review=produce(f);assert.equal(unavailable(f,review).ok,true);assertBlocked(f);const before=structuredClone(f.task);assert.equal(unavailable(f,review).ok,true);assert.deepEqual(f.task,before);}finally{f.close();}});
for(const mutation of ['new-owner','scope-project','alias','task-project','project-workflow','script-workflow','submitted','done'])test(`blocked workflow cannot mutate ${mutation}`,()=>{
 const f=fixture();try{const review=produce(f),run=f.hub.getWorkflowRun(f.run.id);
 if(mutation==='new-owner')f.task.activeRunId='workflow-newer-owner';if(mutation==='scope-project')run.scope.projectId='other';if(mutation==='alias')run.scope.taskId=f.task.localTaskId;if(mutation==='task-project')f.task.projectId='other';if(mutation==='project-workflow'){run.workflowId='po-generated-project-workflow';run.source='po_generated_project';}if(mutation==='script-workflow'){run.workflowId='script-generated';run.source='script_generated';}
 if(mutation==='submitted'||mutation==='done'){for(const state of ['accepted','in_progress','submitted'])assert.equal(f.board.transition(f.task.id,state,{result:{summary:'Already submitted'}}).ok,true);if(mutation==='done')assert.equal(f.board.transition(f.task.id,'done').ok,true);}
 const before=structuredClone(f.task);assert.equal(unavailable(f,review).ok,true);assert.deepEqual(f.task,before);
 }finally{f.close();}
});
test('SQLite restart reconciles an old blocked owner and persists the board atomically',()=>{
 const f=fixture({persistent:true});let reopened,again;try{const active=structuredClone(f.task),review=produce(f);assert.equal(unavailable(f,review).ok,true);
 // Reconstruct only the legacy board shape from its actual issued lease. Run/approval/output remain real.
 Object.assign(f.task,active);f.hub.persistState();f.hub.closePersistence();reopened=createHub(f.options);assert.equal(reopened.getBoard(f.project.id).getTask(f.task.id).status,'dispatched');
 assert.equal(reopened.recoverInterruptedTaskWorkflows().ok,true);const task=reopened.getBoard(f.project.id).getTask(f.task.id);assert.equal(task.status,'blocked');assert.equal(task.activeRunId,null);const before=structuredClone(task);reopened.recoverInterruptedTaskWorkflows();assert.deepEqual(task,before);reopened.closePersistence();again=createHub(f.options);assert.deepEqual(again.getBoard(f.project.id).getTask(f.task.id),JSON.parse(JSON.stringify(before)));
 }finally{reopened?.closePersistence();again?.closePersistence();f.close();}
});
test('normal repaired artifact enters submitted and PO review, never done',()=>{
 const f=fixture();try{const review=produce(f);unavailable(f,review);assertBlocked(f);const notices=[];
 const body={idempotencyKey:'fictional-repair',resolution:'repair_and_submit',expectedPrimaryTaskId:f.task.id,expectedTaskUpdatedAt:f.task.updatedAt,fromAgent:'human',artifacts:[{path:'artifacts/fictional-report.md',mimeType:'text/markdown'}]};
 const stale=f.hub.handleResolveProjectIntervention(f.project.id,{...body,idempotencyKey:'stale-repair',expectedTaskUpdatedAt:f.task.updatedAt-1},{writeArtifact:()=>assert.fail('stale request must not read file')});assert.equal(stale.ok,false);
 const result=f.hub.handleResolveProjectIntervention(f.project.id,body,{writeArtifact:a=>({ok:true,...buildArtifactManifest(f.root,[a.path],{projectId:f.project.id,taskId:f.task.id})[0]}),sendReviewSubmission:input=>notices.push(input)});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.task.status,'submitted');assert.equal(f.downstream.status,'pending');assert.equal(notices.length,1);assert.equal(notices[0].taskId,f.task.id);assert.equal(f.hub.getWorkflowRun(f.run.id).status,'blocked');
 }finally{f.close();}
});

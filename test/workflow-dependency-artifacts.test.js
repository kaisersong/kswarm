import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createHub} from '../src/core/hub.js';
function fixture(){const root=mkdtempSync(join(tmpdir(),'fictional-dependency-artifacts-')),hub=createHub({silent:true}),project=hub.createProject({id:'proj-fictional-artifacts',name:'Fictional report',goal:'Integrate prior research',poAgent:'xiaok-po',members:['xiaok-worker']});
  assert.equal(hub.handleHumanAddTasks(project.id,[{title:'Fictional research',assignedAgent:'xiaok-worker',requiredOutputs:['markdown']},{title:'Fictional architecture',assignedAgent:'xiaok-worker',requiredOutputs:['markdown']},{title:'Unrelated completed task',assignedAgent:'xiaok-worker'}]).ok,true);assert.equal(hub.handleApprove(project.id).ok,true);
  const board=hub.getBoard(project.id),[source,target,unrelated]=board.getAllTasks();
  const initial=join(root,'nested-research.md'),updated=join(root,'revised-research.md');for(const f of [initial,updated])writeFileSync(f,'# Fictional evidence\nVerified observations.');
  function complete(task,result){for(const state of ['dispatched','accepted','in_progress'])assert.equal(board.transition(task.id,state).ok,true);assert.equal(board.transition(task.id,'submitted',{result}).ok,true);assert.equal(board.transition(task.id,'done').ok,true);}
  complete(source,{summary:'A useful fictional research summary.',artifacts:[{path:initial,kind:'markdown'}],workFolder:root,PRIVATE_BODY_CANARY:'must not inline'});
  complete(unrelated,{summary:'UNRELATED_PRIVATE_CANARY',artifacts:[{path:join(root,'unrelated.md')}]});
  target.dependencies=[source.id];target.executionStrategyOverride='workflow';return {hub,project,board,source,target,initial,updated,root};}
for(const mode of ['automatic','approved-proposal'])test(`${mode} task handoff includes current approved dependency artifact paths`,()=>{
  const f=fixture();try{let handoff;
    if(mode==='automatic')handoff=f.hub.handleRequestDispatch(f.project.id,'xiaok-po').workflowNodeDispatches[0];
    else{const proposal=f.hub.createWorkflowProposal(f.project.id,'po-generated-task-workflow',{taskId:f.target.id});assert.equal(proposal.ok,true);f.source.result.artifacts=[{path:f.updated,kind:'markdown'}];handoff=f.hub.startWorkflowRunFromProposal(proposal.workflowProposal.id,{projectId:f.project.id,taskId:f.target.id,workflowId:'po-generated-task-workflow',approvedBy:'human'}).dispatches[0];}
    assert.ok(handoff);assert.deepEqual(Object.keys(handoff.input.dependencyOutputs),[f.source.id]);
    assert.deepEqual(handoff.input.dependencyOutputs[f.source.id].artifactPaths,[mode==='automatic'?f.initial:f.updated]);
    assert.equal(handoff.input.dependencyOutputs[f.source.id].workFolder,f.root);assert.equal(handoff.input.dependencyOutputs[f.source.id].summary,f.source.result.summary);
    assert(!JSON.stringify(handoff.input.dependencyOutputs).includes('PRIVATE_BODY_CANARY'));assert(!JSON.stringify(handoff.input.dependencyOutputs).includes('UNRELATED_PRIVATE_CANARY'));
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('project workflow handoff includes completed task evidence and excludes pending tasks',()=>{
  const f=fixture();try{const proposal=f.hub.createWorkflowProposal(f.project.id,'po-generated-project-workflow',{});assert.equal(proposal.ok,true);const started=f.hub.startWorkflowRunFromProposal(proposal.workflowProposal.id,{projectId:f.project.id,workflowId:'po-generated-project-workflow',approvedBy:'human'});assert.equal(started.ok,true);
    const outputs=started.dispatches[0].input.dependencyOutputs;assert.ok(outputs[f.source.id]);assert.equal(outputs[f.target.id],undefined);assert.deepEqual(outputs[f.source.id].artifactPaths,[f.initial]);assert(!JSON.stringify(outputs).includes('PRIVATE_BODY_CANARY'));
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHub} from '../src/core/hub.js';
import * as schema from '../src/core/initial-plan-semantic-schema.js';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'task-semantic-v2-')),filePath=join(root,'state.sqlite');
 const hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath}});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 hub.createProject({id:'p',name:'Original project',goal:'Read original state',poAgent:'po',members:['writer','reviewer'],autoAssignPo:false,requestedStartPolicy:'plan_only'});
 const input=()=>({project:hub.getProject('p'),tasks:hub.getBoard('p').getAllTasks(),related:{workflowRuns:[],workflowProposals:[],finalDeliverables:[],reviewGateDecisions:[],reviewConditions:[]}});
 return{hub,input};
}
function read(input){assert.equal(typeof schema.readTaskAdditionSemanticSnapshot,'function');return schema.readTaskAdditionSemanticSnapshot(input);}
test('schema2 shares the actual original SQLite project/task parser with a distinct closed digest domain',t=>{
 const f=fixture(t),first=schema.readInitialPlanSemanticSnapshot(f.input()),second=read(f.input());
 assert.equal(first.schemaVersion,1);assert.equal(second.schemaVersion,2);assert.deepEqual(first.semantic,second.semantic);assert.notEqual(first.digest,second.digest);
 assert.equal(f.hub.handleHumanAddTasks('p',[{id:'write',title:'Write',brief:'Original task body',assignedAgent:'writer',composite:true}],{requestSource:'user'}).ok,true);
 assert.equal(read(f.input()).semantic.tasks.length,4);
 assert.equal(read(JSON.parse(JSON.stringify(f.input()))).digest,read(f.input()).digest);
});
test('schema2 does not widen the closed original control/projection and validates real activity before stripping it',t=>{
 const f=fixture(t),original=read(f.input());
 f.hub.getProject('p').newAuthority=true;assert.throws(()=>read(f.input()),/INITIAL_PLAN_SEMANTIC_SCHEMA/);delete f.hub.getProject('p').newAuthority;
 f.hub.getProject('p').activitySnapshot.projectRevision++;assert.throws(()=>read(f.input()),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
 assert.equal(original.semantic.project.activitySnapshot,undefined);
});

test('reverse schema2 accepts only canonical semantic data and cannot synthesize or silently ignore raw projections',t=>{
 const f=fixture(t),snapshot=read(f.input());assert.equal(typeof schema.readCanonicalTaskAdditionSemantic,'function');
 const canonical=schema.readCanonicalTaskAdditionSemantic(snapshot.semantic);assert.equal(canonical.digest,snapshot.digest);
 assert.throws(()=>schema.readCanonicalTaskAdditionSemantic(f.input()),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
 const tainted=structuredClone(snapshot.semantic);tainted.project.activityEventSeq=1;assert.throws(()=>schema.readCanonicalTaskAdditionSemantic(tainted),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
 assert.throws(()=>read(snapshot.semantic),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});

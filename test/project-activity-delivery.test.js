import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createHub} from '../src/core/hub.js';
import {protocolDigest} from '../src/core/project-protocol.js';

function rewriteStoredProject(f, mutate) {
 f.hub.closePersistence();
 const db=new DatabaseSync(f.dataDir.filePath);
 try {
  const project=JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get().state_json);
  mutate(project);const json=JSON.stringify(project);
  db.prepare("UPDATE state_entities SET state_json=?, checksum=? WHERE collection='project' AND entity_key='p'").run(json,createHash('sha256').update(json).digest('hex'));
 } finally {db.close();}
}
function retargetHead(head,projectId,epoch=head.sourceDataEpoch) {
 head.projectId=projectId;head.sourceDataEpoch=epoch;
 head.factId='project-delivery:'+protocolDigest([projectId,epoch,head.incarnation,head.deliveryRevision]);
 const {recordDigest,...record}=head;head.recordDigest=protocolDigest(record);
}

function fixture(t,backend='sqlite'){
 const root=mkdtempSync(join(tmpdir(),'original-delivery-activity-'));mkdirSync(join(root,'artifacts'));const path=join(root,'artifacts','report.md');writeFileSync(path,'# Actual candidate\n\nOriginal local result.');
 const dataDir={backend,filePath:join(root,backend==='sqlite'?'state.sqlite':'state.json')},hub=createHub({silent:true,dataDir});t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 hub.createProject({id:'p',name:'Original project',goal:'Review the actual result',poAgent:'po',members:['worker'],autoAssignPo:false});
 const created=hub.handleCreateTasks('p',[{id:'item-1',title:'Produce document',brief:'Use the original document.',assignedAgent:'worker',dependencies:[]}],'po');hub.handleApprove('p');
 const board=hub.getBoard('p'),task=board.getTask(created.taskIds[0]);board.transition(task.id,'dispatched',{assignedAgent:'worker',runId:'r1'});board.transition(task.id,'accepted',{assignedAgent:'worker'});board.transition(task.id,'in_progress');
 assert.equal(hub.handleSubmitResult('p',task.id,{summary:'Done',workFolder:root,artifacts:[{artifactId:'report',path}]},'worker','r1').ok,true);assert.equal(hub.handleQualityReview('p',task.id,{passed:true,feedback:'Reviewed'},'po').ok,true);
 const result=hub.handleDeliver('p',{summary:'Candidate for explicit review',artifactRef:{path,artifactId:'report'}},'po',{taskId:task.id,workFolder:root,expectedFormat:'markdown'});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(hub.getProjectLifecycle('p').primaryAction.strategy,'review_final_deliverable');
 return{root,dataDir,path,hub,task,board,candidate:result.finalDeliverable};
}
test('the original candidate owner publishes a committed review-ready delivery head without declaring the project completed',t=>{
 const f=fixture(t),page=f.hub.getProjectActivity('p');assert.equal(page.delivery?.status,'current');assert.equal(page.delivery.head.core.stage,'ready_for_acceptance');assert.equal(page.delivery.head.projectId,'p');assert.equal(page.delivery.head.sourceDataEpoch,page.sourceDataEpoch);assert.equal(page.delivery.head.kind,'project_delivery_attention');assert.equal(page.delivery.head.deliveryRevision>0,true);assert.equal(page.delivery.head.core.evidenceRefs.includes(f.candidate.deliverableId),true);assert.equal(page.events.some(event=>event.kind==='completed'),false);assert.equal(f.hub.getProject('p').status,'active');
});
test('delivery ABA advances its own identity and commit hint while the original event cursor remains unchanged',t=>{
 const f=fixture(t),a=f.hub.getProjectActivity('p'),notices=[];f.hub.subscribeProjectActivity(event=>notices.push(event));const project=f.hub.getProject('p');
 f.hub.mutateProjectState('p',()=>{project.planRevisionRequired={taskId:f.task.id,feedback:'Explicit plan correction'};});const b=f.hub.getProjectActivity('p',{after:a.headSeq});
 assert.equal(b.headSeq,a.headSeq);assert.equal(b.events.length,0);assert.equal(b.delivery.status,'current');assert.equal(b.delivery.head.core.stage,'none');assert.equal(b.delivery.head.deliveryRevision,a.delivery.head.deliveryRevision+1);
 f.hub.mutateProjectState('p',()=>{delete project.planRevisionRequired;});const again=f.hub.getProjectActivity('p',{after:a.headSeq});assert.equal(again.headSeq,a.headSeq);assert.equal(again.delivery.head.core.stage,'ready_for_acceptance');assert.equal(again.delivery.head.deliveryRevision,b.delivery.head.deliveryRevision+1);assert.notEqual(again.delivery.head.factId,a.delivery.head.factId);assert.equal(again.delivery.head.incarnation,a.delivery.head.incarnation);assert.equal(notices.length,2);assert.equal(notices[1].deliveryReference.deliveryRevision,again.delivery.head.deliveryRevision);
});
test('time and summary noise do not create a new delivery version; real candidate evidence does',t=>{
 const f=fixture(t),before=f.hub.getProjectActivity('p').delivery;f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').updatedAt=Date.now()+1000;f.board.getTask(f.task.id).result.summary='A different display summary';});assert.deepEqual(f.hub.getProjectActivity('p').delivery,before);
 const next=f.hub.registerFinalDeliverable('p',{submissionIdempotencyKey:'second-candidate',kind:'file',artifactRef:{path:f.path,artifactId:'report'},workFolder:f.root,expectedFormat:'markdown'},{requestSource:'user',actorId:'original-user'});assert.equal(next.ok,true,JSON.stringify(next));assert.equal(f.hub.getProjectActivity('p').delivery.head.deliveryRevision,before.head.deliveryRevision+1);
});
test('a real SQLite SAVE-BEGIN lock failure exposes neither a new delivery head nor a successful hint',t=>{
 const f=fixture(t),before=f.hub.getProjectActivity('p'),notices=[];f.hub.subscribeProjectActivity(event=>notices.push(event));const lock=new DatabaseSync(f.dataDir.filePath);lock.exec('BEGIN IMMEDIATE');
 try{assert.throws(()=>f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').planRevisionRequired={taskId:f.task.id,feedback:'Will fail before SQLite BEGIN'};}));assert.deepEqual(f.hub.getProjectActivity('p'),before);assert.equal(notices.length,0);}finally{lock.exec('ROLLBACK');lock.close();}
});
test('the original persisted delivery identity survives a real SQLite owner reopen',t=>{
 const f=fixture(t),before=f.hub.getProjectActivity('p');f.hub.closePersistence();const reopened=createHub({silent:true,dataDir:f.dataDir});try{assert.deepEqual(reopened.getProjectActivity('p').delivery,before.delivery);assert.equal(reopened.getProjectActivity('p').delivery.status,'current');}finally{reopened.closePersistence();}
});
test('a compatibility save can preserve business changes only with unavailable delivery, and an admitted recovery never revives the old identity',t=>{
 const f=fixture(t),before=f.hub.getProjectActivity('p'),head=f.hub.getProject('p').activityDeliveryHead,notices=[];f.hub.subscribeProjectActivity(event=>notices.push(event));
 f.hub.getProject('p').planRevisionRequired={taskId:f.task.id,feedback:'Original unwrapped owner persistence'};f.hub.persistState({type:'project',projectId:'p'});
 assert.deepEqual(f.hub.getProject('p').activityDeliveryHead,head);assert.equal(f.hub.getProjectActivity('p').delivery.status,'unavailable');assert.equal(notices.length,1);assert.equal(notices[0].deliveryUnavailable,true);assert.equal(Object.hasOwn(notices[0],'deliveryReference'),false);assert.equal(notices[0].headSeq,before.headSeq);
 delete f.hub.getProject('p').planRevisionRequired;f.hub.persistState({type:'project',projectId:'p'});assert.equal(f.hub.getProjectActivity('p').delivery.status,'unavailable');
 f.hub.mutateProjectState('p',()=>{});const after=f.hub.getProjectActivity('p');assert.equal(after.delivery.status,'current');assert.equal(after.delivery.head.core.stage,'ready_for_acceptance');assert.equal(after.delivery.head.deliveryRevision,head.deliveryRevision+1);assert.notEqual(after.delivery.head.factId,head.factId);assert.equal(after.headSeq,before.headSeq);assert.equal(notices.length,2);
});
test('an unavailable witness cannot be revived by an unwrapped ABA which deletes or falsifies its marker',t=>{
 const f=fixture(t),head=f.hub.getProjectActivity('p').delivery?.head;
 f.hub.getProject('p').planRevisionRequired={taskId:f.task.id,feedback:'Invalidate'};f.hub.persistState({type:'project',projectId:'p'});
 for(const marker of [undefined,false,0,'']){
  const project=f.hub.getProject('p');delete project.planRevisionRequired;if(marker===undefined)delete project.activityDeliveryUnavailable;else project.activityDeliveryUnavailable=marker;
  f.hub.persistState({type:'project',projectId:'p'});assert.equal(f.hub.getProjectActivity('p').delivery.status,'unavailable');assert.equal(f.hub.getProject('p').activityDeliveryUnavailable,true);assert.equal(f.hub.getProject('p').activityDeliveryHead.factId,head.factId);
 }
});
test('a self-consistent foreign head and snapshot cannot replace the actual SQLite project identity',t=>{
 const f=fixture(t);rewriteStoredProject(f,project=>{project.activitySnapshot.id='foreign';retargetHead(project.activityDeliveryHead,'foreign');});
 const reopened=createHub({silent:true,dataDir:f.dataDir});
 try{assert.equal(reopened.getProject('p').id,'p');assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');}
 finally{reopened.closePersistence();}
});
for(const [name,mutate] of [
 ['null',project=>{project.activityDeliveryHead=null;}],
 ['false',project=>{project.activityDeliveryHead=false;}],
 ['zero',project=>{project.activityDeliveryHead=0;}],
 ['empty',project=>{project.activityDeliveryHead='';}],
 ['future schema',project=>{project.activityDeliveryHead.schemaVersion=99;}],
 ['record digest',project=>{project.activityDeliveryHead.recordDigest='0'.repeat(64);}],
 ['foreign epoch',project=>{retargetHead(project.activityDeliveryHead,'p','11111111-1111-4111-8111-111111111111');}],
])test(`present ${name} delivery metadata remains unavailable through GET and a business save cannot certify a repaired head`,t=>{
 const f=fixture(t);rewriteStoredProject(f,mutate);const reopened=createHub({silent:true,dataDir:f.dataDir});
 try{const before=structuredClone(reopened.getProject('p').activityDeliveryHead);assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');assert.deepEqual(reopened.getProject('p').activityDeliveryHead,before);reopened.mutateProjectState('p',()=>{});assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');assert.deepEqual(reopened.getProject('p').activityDeliveryHead,before);}
 finally{reopened.closePersistence();}
});
test('a genuinely missing legacy delivery head stays missing on GET and is born only on the next admitted save',t=>{
 const f=fixture(t),old=f.hub.getProjectActivity('p').delivery.head;rewriteStoredProject(f,project=>{delete project.activityDeliveryHead;delete project.activityDeliveryUnavailable;});
 const reopened=createHub({silent:true,dataDir:f.dataDir});
 try{assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');assert.equal(Object.hasOwn(reopened.getProject('p'),'activityDeliveryHead'),false);reopened.mutateProjectState('p',()=>{});const next=reopened.getProjectActivity('p').delivery.head;assert.equal(next.deliveryRevision,1);assert.notEqual(next.incarnation,old.incarnation);assert.notEqual(next.factId,old.factId);}
 finally{reopened.closePersistence();}
});
test('legacy delivered drift is unavailable even when the original lifecycle names it ready_to_deliver',t=>{
 const f=fixture(t);f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').status='delivered';});
 assert.equal(f.hub.getProjectLifecycle('p').state,'ready_to_deliver');const delivery=f.hub.getProjectActivity('p').delivery;assert.equal(delivery.status,'current');assert.equal(delivery.head.core.stage,'unavailable');assert.equal(delivery.head.core.diagnostics.includes('legacy_status_drift'),true);
});
test('an unavailable witness survives a real owner restart and a semantic ABA needs a new identity',t=>{
 const f=fixture(t),old=f.hub.getProjectActivity('p').delivery.head;f.hub.getProject('p').planRevisionRequired={taskId:f.task.id};f.hub.persistState({type:'project',projectId:'p'});f.hub.closePersistence();
 const reopened=createHub({silent:true,dataDir:f.dataDir});
 try{assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');delete reopened.getProject('p').planRevisionRequired;reopened.persistState({type:'project',projectId:'p'});assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');reopened.mutateProjectState('p',()=>{});const next=reopened.getProjectActivity('p').delivery.head;assert.equal(next.deliveryRevision,old.deliveryRevision+1);assert.notEqual(next.factId,old.factId);}
 finally{reopened.closePersistence();}
});
test('known damaged delivery metadata stays unknown while the original business callback and a clean SQLite project remain writable',t=>{
 const f=fixture(t);f.hub.createProject({id:'q',name:'Clean project',goal:'Keep independent state',poAgent:'po',members:[],autoAssignPo:false});
 rewriteStoredProject(f,project=>{project.activityDeliveryHead=null;});const reopened=createHub({silent:true,dataDir:f.dataDir});
 try{let actions=0;reopened.mutateProjectState('p',()=>{actions++;reopened.getProject('p').goal='Explicit business update';});assert.equal(actions,1);assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');reopened.mutateProjectState('q',()=>{reopened.getProject('q').goal='Clean project saved';});assert.equal(reopened.getPersistenceHealth().status,'ok');}
 finally{reopened.closePersistence();}
 const again=createHub({silent:true,dataDir:f.dataDir});try{assert.equal(again.getProject('q').goal,'Clean project saved');assert.equal(again.getProject('p').goal,'Explicit business update');assert.equal(again.getProjectActivity('p').delivery.status,'unavailable');}finally{again.closePersistence();}
});
test('damaged display metadata cannot block the original authenticated close or erase its human-action audit',t=>{
 const f=fixture(t);rewriteStoredProject(f,project=>{project.activityDeliveryHead=null;});const reopened=createHub({silent:true,dataDir:f.dataDir});
 try{const result=reopened.handleCloseProject('p','Original explicit close',{requestSource:'user',actorId:'owner'});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(reopened.getProject('p').status,'closed');assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');}
 finally{reopened.closePersistence();}
 const db=new DatabaseSync(f.dataDir.filePath);try{const actions=db.prepare("SELECT state_json FROM state_entities WHERE collection='humanAction' AND project_id='p'").all().map(row=>JSON.parse(row.state_json));assert.equal(actions.some(action=>action.action==='close_project'),true);}finally{db.close();}
});
test('exhausting the delivery counter preserves its committed identity as unknown and does not block original business state',t=>{
 const f=fixture(t);rewriteStoredProject(f,project=>{project.activityDeliveryHead.deliveryRevision=Number.MAX_SAFE_INTEGER;retargetHead(project.activityDeliveryHead,'p');});
 const reopened=createHub({silent:true,dataDir:f.dataDir});
 try{const before=structuredClone(reopened.getProject('p').activityDeliveryHead);reopened.mutateProjectState('p',()=>{reopened.getProject('p').planRevisionRequired={taskId:f.task.id};});assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');assert.deepEqual(reopened.getProject('p').activityDeliveryHead,before);reopened.mutateProjectState('p',()=>{delete reopened.getProject('p').planRevisionRequired;});assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');assert.deepEqual(reopened.getProject('p').activityDeliveryHead,before);}
 finally{reopened.closePersistence();}
});
test('a caller cannot replace a committed head, even with a self-consistent head for the actual project',t=>{
 const f=fixture(t),before=f.hub.getProjectActivity('p').delivery.head;
 f.hub.mutateProjectState('p',()=>{const head=f.hub.getProject('p').activityDeliveryHead;head.deliveryRevision+=100;retargetHead(head,'p');});
 assert.equal(f.hub.getProjectActivity('p').delivery.status,'unavailable');assert.deepEqual(f.hub.getProject('p').activityDeliveryHead,before);
});
test('unknown metadata also preserves the original JSON full-save close path and survives reopen',t=>{
 const f=fixture(t,'json');f.hub.closePersistence();const state=JSON.parse(readFileSync(f.dataDir.filePath,'utf8'));state.projects[0].activityDeliveryHead={schemaVersion:99,legacyUnknown:'Retain exact bytes'};writeFileSync(f.dataDir.filePath,JSON.stringify(state));
 const reopened=createHub({silent:true,dataDir:f.dataDir});
 try{assert.equal(reopened.handleCloseProject('p','Close with unknown display',{requestSource:'user',actorId:'owner'}).ok,true);assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');}
 finally{reopened.closePersistence();}
 const again=createHub({silent:true,dataDir:f.dataDir});try{assert.equal(again.getProject('p').status,'closed');assert.deepEqual(again.getProject('p').activityDeliveryHead,state.projects[0].activityDeliveryHead);assert.equal(again.getProjectActivity('p').delivery.status,'unavailable');}finally{again.closePersistence();}
});
test('the actual frozen SQLite board must match the delivery proof, not its earlier mutable source',t=>{
 const f=fixture(t),before=f.hub.getProjectActivity('p'),notices=[];f.hub.subscribeProjectActivity(event=>notices.push(event));
 assert.throws(()=>f.hub.mutateProjectState('p',()=>{f.task.toJSON=function(){const {toJSON,...data}=this;return{...data,status:'failed'};};}),/project_activity_delivery_write_set_conflict/);
 assert.deepEqual(f.hub.getProjectActivity('p'),before);assert.equal(notices.length,0);assert.equal(f.hub.getPersistenceHealth().status,'failed');
});
test('unknown historical bytes are checked against the private source witness after the actual write-set freeze',t=>{
 const f=fixture(t);rewriteStoredProject(f,project=>{project.activityDeliveryHead=null;});const reopened=createHub({silent:true,dataDir:f.dataDir});
 try{const before=reopened.getProjectActivity('p');assert.throws(()=>reopened.mutateProjectState('p',()=>{reopened.getProject('p').toJSON=function(){const {toJSON,...data}=this;return{...data,activityDeliveryHead:false};};}),/project_activity_delivery_write_set_conflict/);assert.deepEqual(reopened.getProjectActivity('p'),before);assert.equal(reopened.getPersistenceHealth().status,'failed');}
 finally{reopened.closePersistence();}
});
test('the original owner selection of historical approved finals is a real dependency, even when the visible lifecycle stays unchanged',t=>{
 const f=fixture(t),second=f.hub.registerFinalDeliverable('p',{submissionIdempotencyKey:'historical-second',kind:'file',artifactRef:{path:f.path,artifactId:'report'},taskId:f.task.id,workFolder:f.root,expectedFormat:'markdown'},{requestSource:'user',actorId:'owner'});assert.equal(second.ok,true,JSON.stringify(second));
 // Import two historical approved records through the original durable owner;
 // this tests read-model dependency selection, not the approval authority.
 const finals=f.hub.listFinalDeliverables('p');assert.equal(finals.length,2);
 f.hub.mutateProjectState('p',()=>{for(const [index,final] of finals.entries()){final.status='approved';final.updatedAt=`2026-11-0${index+1}T00:00:00.000Z`;}});
 const before=f.hub.getProjectActivity('p').delivery.head,selected=f.hub.listFinalDeliverables('p')[0].deliverableId;
 f.hub.mutateProjectState('p',()=>{[finals[0].updatedAt,finals[1].updatedAt]=[finals[1].updatedAt,finals[0].updatedAt];});
 const after=f.hub.getProjectActivity('p').delivery.head;assert.notEqual(f.hub.listFinalDeliverables('p')[0].deliverableId,selected);assert.deepEqual(after.core,before.core);assert.equal(after.deliveryRevision,before.deliveryRevision+1);assert.notEqual(after.inputDigest,before.inputDigest);
});
test('a caller cannot insert a head into a privately known absence and leave it in the post-commit source cache',t=>{
 const f=fixture(t),injected=f.hub.getProjectActivity('p').delivery.head;rewriteStoredProject(f,project=>{delete project.activityDeliveryHead;delete project.activityDeliveryUnavailable;});
 const reopened=createHub({silent:true,dataDir:f.dataDir});try{reopened.mutateProjectState('p',()=>{reopened.getProject('p').activityDeliveryHead=structuredClone(injected);});assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');assert.equal(Object.hasOwn(reopened.getProject('p'),'activityDeliveryHead'),false);reopened.mutateProjectState('p',()=>{});assert.equal(reopened.getProjectActivity('p').delivery.status,'unavailable');assert.equal(Object.hasOwn(reopened.getProject('p'),'activityDeliveryHead'),false);}finally{reopened.closePersistence();}
});
test('the original write-set freeze cannot silently omit both delivery metadata fields',t=>{
 const f=fixture(t),before=f.hub.getProjectActivity('p'),notices=[];f.hub.subscribeProjectActivity(event=>notices.push(event));
 assert.throws(()=>f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').toJSON=function(){const {toJSON,activityDeliveryHead,activityDeliveryUnavailable,...data}=this;return data;};}),/project_activity_delivery_(history|write_set)_conflict/);
 assert.deepEqual(f.hub.getProjectActivity('p'),before);assert.equal(notices.length,0);
});
test('the original write-set freeze cannot replace a qualified identity with a different self-consistent identity',t=>{
 const f=fixture(t),before=f.hub.getProjectActivity('p'),notices=[];f.hub.subscribeProjectActivity(event=>notices.push(event));
 assert.throws(()=>f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').toJSON=function(){const {toJSON,...data}=this;const head=structuredClone(data.activityDeliveryHead);head.deliveryRevision+=100;retargetHead(head,'p');return{...data,activityDeliveryHead:head};};}),/project_activity_delivery_(history|write_set)_conflict/);
 assert.deepEqual(f.hub.getProjectActivity('p'),before);assert.equal(notices.length,0);
});
test('a JSON project-scoped mutation checks both the scoped frozen frame and the actual full document without losing another project',t=>{
 const f=fixture(t,'json');const before=f.hub.getProjectActivity('p');f.hub.createProject({id:'q',name:'Second',goal:'A second JSON project',poAgent:'po',members:[],autoAssignPo:false});f.hub.mutateProjectState('q',()=>{f.hub.getProject('q').goal='Persist actual second change';});assert.deepEqual(f.hub.getProjectActivity('p'),before);f.hub.closePersistence();
 const reopened=createHub({silent:true,dataDir:f.dataDir});try{assert.equal(reopened.getProject('q').goal,'Persist actual second change');assert.deepEqual(reopened.getProjectActivity('p').delivery,before.delivery);}finally{reopened.closePersistence();}
});
test('a saturated retained critical history does not consume another event slot for independent delivery ABA',t=>{
 const f=fixture(t);rewriteStoredProject(f,project=>{
  const template=project.activityEventOutbox[0];project.activityEventOutbox=Array.from({length:4096},(_,index)=>({...template,eventId:`p#${index+1}`,sourceSequence:index+1,sourceRevision:String(index+1),kind:'input_required',sourceType:'review.required',occurredAt:Date.now()}));project.activityEventSeq=4096;project.committedActivitySeq=4096;project.activityGapRanges=[];
 });
 const reopened=createHub({silent:true,dataDir:f.dataDir});try{const before=reopened.getProjectActivity('p',{after:4096});assert.equal(before.events.length,0);reopened.getProject('p').planRevisionRequired={taskId:f.task.id};reopened.invalidateTeamPlansForAgent('worker');const blocked=reopened.getProjectActivity('p',{after:4096});assert.equal(blocked.headSeq,4096);assert.equal(blocked.events.length,0);assert.equal(blocked.delivery.head.deliveryRevision,before.delivery.head.deliveryRevision+1);assert.equal(reopened.getProject('p').activityEventOutbox.length,4096);delete reopened.getProject('p').planRevisionRequired;reopened.invalidateTeamPlansForAgent('worker');const again=reopened.getProjectActivity('p',{after:4096});assert.equal(again.delivery.head.core.stage,'ready_for_acceptance');assert.equal(again.delivery.head.deliveryRevision,blocked.delivery.head.deliveryRevision+1);assert.notEqual(again.delivery.head.factId,before.delivery.head.factId);assert.equal(again.headSeq,4096);}finally{reopened.closePersistence();}
});
test('the actual JSON bytes cannot omit both delivery metadata fields after the full-state check',t=>{
 const f=fixture(t,'json'),before=f.hub.getProjectActivity('p'),disk=readFileSync(f.dataDir.filePath,'utf8'),notices=[];f.hub.subscribeProjectActivity(event=>notices.push(event));
 assert.throws(()=>f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').toJSON=function(){const {toJSON,activityDeliveryHead,activityDeliveryUnavailable,...data}=this;return data;};}),/project_activity_delivery_write_set_conflict/);
 assert.deepEqual(f.hub.getProjectActivity('p'),before);assert.equal(readFileSync(f.dataDir.filePath,'utf8'),disk);assert.equal(notices.length,0);
});
test('the actual JSON bytes cannot replace the staged identity after the full-state check',t=>{
 const f=fixture(t,'json'),before=f.hub.getProjectActivity('p'),disk=readFileSync(f.dataDir.filePath,'utf8'),notices=[];f.hub.subscribeProjectActivity(event=>notices.push(event));
 assert.throws(()=>f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').toJSON=function(){const {toJSON,...data}=this;const head=structuredClone(data.activityDeliveryHead);head.deliveryRevision+=100;retargetHead(head,'p');return{...data,activityDeliveryHead:head};};}),/project_activity_delivery_write_set_conflict/);
 assert.deepEqual(f.hub.getProjectActivity('p'),before);assert.equal(readFileSync(f.dataDir.filePath,'utf8'),disk);assert.equal(notices.length,0);
});

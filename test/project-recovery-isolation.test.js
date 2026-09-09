import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoverProjectsIndependently} from '../src/core/project-recovery-isolation.js';
test('workspace recovery stays with its claim owner and one legacy failure cannot block other projects',async()=>{
 const seen=[],deferred=[],failed=[];
 await recoverProjectsIndependently({projects:[{id:'mapping',status:'active',requiredProtocol:'room_workspace_v1',workspaceMapping:{state:'mapping_required'}},{id:'bound',status:'active',requiredProtocol:'room_workspace_v1',workspaceMapping:{state:'active'}},{id:'broken',status:'active'},{id:'legacy',status:'active'}],recoverProject:async p=>{seen.push(p.id);if(p.id==='broken')throw new Error('unavailable');},onDeferred:(p,reason)=>deferred.push([p.id,reason]),onError:(p,error)=>failed.push([p.id,error.message])});
 assert.deepEqual(seen,['broken','legacy']);assert.deepEqual(failed,[['broken','unavailable']]);assert.deepEqual(deferred,[['mapping','workspace_mapping_required'],['bound','workspace_desktop_recovery_owner']]);
});

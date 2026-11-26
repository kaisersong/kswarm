import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {isAcceptanceRecord} from '../src/core/initial-plan-acceptance-contract.js';
const contract='ordinary_initial_plan_additive_v2';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
test('headless v2 and unknown reserved protocol records remain protected rather than falling into legacy',()=>{
 for(const value of [{contract},{initialPlanning:{contract:{protocol:contract}}},{kind:'ordinary_task_addition_receipt',contract},{contract:'ordinary_initial_plan_additive_v999'},{initialPlanning:{contract:{protocol:'ordinary_initial_plan_additive_v999'}}}])assert.equal(isAcceptanceRecord(value),true);
 assert.equal(isAcceptanceRecord({kind:'ordinary-note',text:'ordinary_initial_plan_additive_v2'}),false);
});
test('legacy import cannot mint a headless v2 protected binding without the original controller',t=>{
 const root=mkdtempSync(join(tmpdir(),'ordinary-task-v2-import-')),filePath=join(root,'state.sqlite'),legacyJsonPath=join(root,'legacy.json');let store;
 t.after(()=>{store?.close();rmSync(root,{recursive:true,force:true});});writeFileSync(legacyJsonPath,JSON.stringify({projects:[],protocolReceipts:[{id:'v2-binding',kind:'project_protocol_binding',projectId:'p',scope,initialPlanning:{contract:{protocol:contract}}}]}));
 store=createSqlitePersistence({filePath,legacyJsonPath});assert.throws(()=>store.load(),/initial_plan_legacy_birth_forbidden/);const db=new DatabaseSync(filePath,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM state_entities').get().n,0);}finally{db.close();}
});

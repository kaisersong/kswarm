import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'kswarm-protected-')); const path=join(root,'state.sqlite');
  let db=createSqlitePersistence({filePath:path});db.load();
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  return {filePath:path,get db(){return db;},reopen(){db.close();db=createSqlitePersistence({filePath:path});return db.load();}};
}
const entity=(collection,key,value)=>({collection,key,projectId:'p',value});
const receipt={id:'r',kind:'owner_command',projectId:'p',payloadHash:'hash',result:{taskId:'t'}};
test('protected receipt survives omitted scoped/full saves and restart', t=>{
 const f=fixture(t);
 f.db.save({entities:[entity('protocolReceipt','r',receipt)],scope:{type:'project',projectId:'p'}});
 f.db.save({entities:[],scope:{type:'full'}});
 assert.deepEqual(f.reopen().protocolReceipts,[receipt]);
});
test('same-key immutable receipt cannot be overwritten; entire transaction rolls back',t=>{
 const f=fixture(t);
 f.db.save({entities:[entity('project','p',{id:'p',name:'before'}),entity('protocolReceipt','r',receipt)]});
 assert.throws(()=>f.db.save({entities:[
  entity('project','p',{id:'p',name:'after'}),entity('protocolReceipt','r',{...receipt,result:{taskId:'forged'}})
 ]}),/immutable|protected/);
 const saved=f.reopen();assert.equal(saved.projects[0].name,'before');assert.deepEqual(saved.protocolReceipts,[receipt]);
});
test('protected CAS head requires consecutive revision and stable identity', t=>{
 const f=fixture(t);const head={id:'h',kind:'scope_control',projectId:'p',revision:1,value:{epoch:4}};
 f.db.save({entities:[entity('protocolHead','h',head)]});
 f.db.save({entities:[entity('protocolHead','h',head)]});
 f.db.save({entities:[entity('protocolHead','h',{...head,revision:2,value:{epoch:5}})]});
 assert.throws(()=>f.db.save({entities:[entity('protocolHead','h',{...head,revision:2,value:{epoch:2}})]}),/revision|CAS/);
 assert.equal(f.reopen().protocolHeads[0].value.epoch,5);
});
test('new protected head cannot start at an arbitrary revision',t=>{
 const f=fixture(t);
 assert.throws(()=>f.db.save({entities:[entity('protocolHead','x',{id:'x',kind:'scope_control',projectId:'p',revision:8})]}),/revision|CAS/);
 assert.equal(f.reopen(),null);
});

test('even an identical protected receipt cannot be addressed under another project scope',t=>{
 const f=fixture(t);f.db.save({entities:[entity('protocolReceipt','r',receipt)]});
 assert.throws(()=>f.db.save({entities:[{...entity('protocolReceipt','r',receipt),projectId:'other'}]}),/identity/);
 assert.deepEqual(f.reopen().protocolReceipts,[receipt]);
});
test('corrupt protected current head never rolls back silently to historical authority',t=>{
 const f=fixture(t);const h={id:'h',kind:'scope_control',projectId:'p',revision:1,value:{epoch:4}};
 f.db.save({entities:[entity('protocolHead','h',h)]});
 f.db.save({entities:[entity('protocolHead','h',{...h,revision:2,value:{epoch:5}})]});f.db.close();
 const raw=new DatabaseSync(f.filePath);raw.prepare("UPDATE state_entities SET state_json='{}' WHERE collection='protocolHead'").run();raw.close();
 assert.throws(()=>f.reopen(),/protected record integrity/);
});
test('SIGKILL after protected receipt commit preserves that exact receipt',t=>{
 const f=fixture(t);f.db.close();
 const moduleUrl=new URL('../src/core/sqlite-persistence.js',import.meta.url).href;
 const script='import {createSqlitePersistence} from '+JSON.stringify(moduleUrl)+';'
  +'const db=createSqlitePersistence({filePath:'+JSON.stringify(f.filePath)+'});db.load();'
  +'db.save({entities:'+JSON.stringify([entity('protocolReceipt','r',receipt)])+'});'
  +'process.kill(process.pid,"SIGKILL");';
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});
 console.log(JSON.stringify({test:'protected-receipt-kill',pid:child.pid,status:child.status,signal:child.signal}));
 assert.equal(child.error,undefined);
 if(process.platform==='win32')assert.notEqual(child.status,0);
 else assert.equal(child.signal,'SIGKILL');
 assert.deepEqual(f.reopen().protocolReceipts,[receipt]);
});

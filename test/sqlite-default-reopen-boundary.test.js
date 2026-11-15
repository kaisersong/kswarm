import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
const project=name=>({collection:'project',key:'p',projectId:'p',value:{id:'p',name}});
const receipt={collection:'protocolReceipt',key:'r',projectId:'p',value:{id:'r',kind:'owner_command',projectId:'p',payloadHash:'hash',result:{taskId:'t'}}};
for(const kind of ['writer-profile','immutable-receipt','CAS-head','stale-writer'])test('default ordinary source retains its held boundary after '+kind+' rejection',t=>{
 const root=mkdtempSync(join(tmpdir(),'kswarm-default-held-')),filePath=join(root,'state.sqlite'),stores=[];
 const open=options=>{const store=createSqlitePersistence({filePath,...options});stores.push(store);store.load();return store;};
 t.after(()=>{for(const store of stores)store.close();rmSync(root,{recursive:true,force:true});});
 let businessFailure;const reject=(action,pattern)=>assert.throws(()=>{try{action();}catch(raw){businessFailure=raw;throw raw;}},pattern);
 const head={collection:'protocolHead',key:'h',projectId:'p',value:{id:'h',kind:'scope_control',projectId:'p',revision:1}};
 const first=open();first.save({entities:[project('before'),receipt,head]});first.close();
 // Retain the actual default success path, alongside each failed-source case.
 const current=open();assert.equal(current.getHealth().status,'ok');
 if(kind==='writer-profile')reject(()=>current.save({requiredWriterProfile:'unsupported-future',entities:[project('after')]}),/writer.*profile/i);
 if(kind==='immutable-receipt')reject(()=>current.save({entities:[{...receipt,value:{...receipt.value,result:{taskId:'forged'}}}]}),/immutable|protected/);
 if(kind==='CAS-head')reject(()=>current.save({entities:[{...head,value:{...head.value,revision:9}}]}),/CAS|revision/);
 if(kind==='stale-writer'){
  const second=open({isProcessAlive:()=>false});second.save({entities:[project('second')]});
  reject(()=>current.save({entities:[project('stale')]}),/stale.*writer|writer.*revision/i);second.close();
 }
 current.close();
 assert.throws(()=>createSqlitePersistence({filePath}),error=>{assert.equal(error.message,'KSWARM_SQLITE_SOURCE_HELD');const originalCause=businessFailure.cause??businessFailure;assert.equal(error.cause,originalCause);return true;});
});

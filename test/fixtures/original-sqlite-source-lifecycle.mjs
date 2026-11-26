import nodeFs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=mkdtempSync(join(tmpdir(),'ks-source-life-')),home=process.env.HOME;
process.env.XIAOK_CONFIG_DIR=join(root,'config');mkdirSync(process.env.XIAOK_CONFIG_DIR,{mode:0o700});
const mode=process.argv[2],prototype=DatabaseSync.prototype,close=prototype.close,exec=prototype.exec;
const originalLstat=nodeFs.lstatSync;let runtimeReads=0;if(mode==='runtime-undefined'){nodeFs.lstatSync=function(path,...args){if(String(path).endsWith('/runtime/xiaok-source-runtime.cjs')){runtimeReads++;throw undefined;}return Reflect.apply(originalLstat,this,[path,...args]);};syncBuiltinESMExports();}
const seen=new WeakSet();let armed=false,hits=0,raw=new Error('original initialization failure'),release;
if(mode==='held-init')raw[Symbol('original SDK tail')]=new Promise(resolve=>{release=resolve;});
if(mode==='getter-init'){let calls=0;Object.defineProperty(raw,'unexpected',{get(){calls++;throw Error('getter executed');}});process.on('exit',()=>assert.equal(calls,0));}
prototype.exec=function(...args){seen.add(this);if(armed&&(mode==='init-before'||mode==='held-init'||mode==='getter-init')){hits++;throw raw;}const result=Reflect.apply(exec,this,args);if(armed&&mode==='init-after'){hits++;throw raw;}return result;};
prototype.close=function(...args){if(armed&&seen.has(this)&&mode.startsWith('close-')){hits++;if(mode==='close-after')Reflect.apply(close,this,args);throw undefined;}return Reflect.apply(close,this,args);};
const {createSqlitePersistence,readOriginalKSwarmPersistenceSource,isPersistenceCommitError,isPersistenceLoadError}=await import('../../src/core/sqlite-persistence.js');
const path=join(root,'state.sqlite');let orphan;
function blocked(){let traps=0;assert.throws(()=>createSqlitePersistence({filePath:path,fs:new Proxy({},{get(){traps++;throw Error('unexpected FS');}})}));assert.equal(traps,0);}
try{
 if(mode==='healthy'){
  const store=createSqlitePersistence({filePath:path}),source=readOriginalKSwarmPersistenceSource(store);store.load();source.assertCurrent();store.close();source.assertTerminated();await source.waitKnown();assert.equal(existsSync(path+'.lock'),false);assert.throws(()=>store.load());
  const next=createSqlitePersistence({filePath:path});next.load();next.close();readOriginalKSwarmPersistenceSource(next).assertTerminated();
 }else if(mode==='runtime-undefined'){
  for(let attempt=0;attempt<2;attempt++){let present=false;try{createSqlitePersistence({filePath:path});}catch(raw){present=true;assert.equal(raw,undefined);}assert.equal(present,true);}
  assert.equal(runtimeReads,1);assert.equal(existsSync(path),false);
 }else if(mode==='membership'){
  let traps=0;const foreign=new Proxy({},{get(){traps++;},getPrototypeOf(){traps++;},ownKeys(){traps++;}});
  assert.throws(()=>readOriginalKSwarmPersistenceSource(foreign));assert.equal(isPersistenceLoadError(foreign),false);assert.equal(isPersistenceCommitError(foreign),false);assert.throws(()=>createSqlitePersistence(foreign));assert.equal(traps,0);
 }else if(mode==='ctor-before'||mode==='ctor-after'||mode==='ctor-proxy'){
  let traps=0;const thrown=mode==='ctor-proxy'?new Proxy({},{get(){traps++;},getPrototypeOf(){traps++;},ownKeys(){traps++;}}):undefined;
  const store=createSqlitePersistence({filePath:path,sqliteFactory(p){if(mode==='ctor-after')orphan=new DatabaseSync(p);throw thrown;}});let observed;
  try{store.load();assert.fail('constructor must reject');}catch(error){observed=error;assert.equal(error.cause,thrown);assert.equal(Object.hasOwn(error,'cause'),true);}
  assert.equal(traps,0);assert.throws(()=>readOriginalKSwarmPersistenceSource(store).assertTerminated());assert.equal(existsSync(path+'.lock'),true);blocked();
  if(orphan)Reflect.apply(close,orphan,[]);
  assert.throws(()=>readOriginalKSwarmPersistenceSource(store).assertTerminated());assert.equal(observed.name,'PersistenceLoadError');
 }else{
  const store=createSqlitePersistence({filePath:path}),source=readOriginalKSwarmPersistenceSource(store);
  if(mode.startsWith('close-')){store.load();armed=true;let present=false;try{store.close();}catch(error){present=true;assert.equal(error,undefined);}assert.equal(present,true);assert.equal(hits,1);assert.equal(existsSync(path+'.lock'),true);assert.throws(()=>source.assertTerminated());blocked();}
  else{
   armed=true;let observed;try{store.load();assert.fail('initialization must reject');}catch(error){observed=error;assert.equal(error.cause,raw);}armed=false;assert.equal(hits,1);assert.equal(observed.name,'PersistenceLoadError');
   if(mode==='held-init'){
    assert.equal(existsSync(path+'.lock'),true);let settled=false;const wait=source.waitKnown().then(()=>{settled=true;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(settled,false);release();await wait;source.assertTerminated();assert.equal(existsSync(path+'.lock'),false);
   }else if(mode==='getter-init'){assert.equal(existsSync(path+'.lock'),true);await assert.rejects(source.waitKnown());assert.throws(()=>source.assertTerminated());blocked();}
   else{source.assertTerminated();assert.equal(existsSync(path+'.lock'),false);}
  }
 }
 assert.equal(process.env.HOME,home);console.log(JSON.stringify({kind:'original-sqlite-source-lifecycle',mode,pid:process.pid,root,hits,homeUnchanged:true,productionQualified:false}));
}finally{armed=false;prototype.close=close;prototype.exec=exec;nodeFs.lstatSync=originalLstat;syncBuiltinESMExports();}

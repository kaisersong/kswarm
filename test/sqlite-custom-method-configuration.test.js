import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOriginalSqliteSourceLifetime,openOriginalSqliteSource,assertOriginalSqliteSourceUsable,closeOriginalSqliteSource,readOriginalSqliteSourceLifetime,inventoryOriginalSqliteSourceOutcome} from '../src/core/original-sqlite-source-lifecycle.js';
const nativeExec=DatabaseSync.prototype.exec,nativeClose=DatabaseSync.prototype.close;
function fixture(t,make){
 const root=mkdtempSync(join(tmpdir(),'ks-custom-method-')),file=join(root,'state.sqlite');let db;
 const factory=path=>{db=new DatabaseSync(path);return make(db);};
 const token=createOriginalSqliteSourceLifetime(file,factory),returned=openOriginalSqliteSource(token,file,factory);
 t.after(()=>{try{Reflect.apply(nativeClose,db,[]);}catch{}rmSync(root,{recursive:true,force:true});});
 return {token,db:returned};
}
test('ordinary explicit factory can configure a real declared method without gaining a Native physical receipt',t=>{
 const f=fixture(t,db=>{db.exec=sql=>Reflect.apply(nativeExec,db,[sql]);return db;});
 assertOriginalSqliteSourceUsable(f.token);f.db.exec('CREATE TABLE fixture(id INTEGER)');
 assert.equal(f.db.prepare('SELECT count(*) n FROM fixture').get().n,0);
 closeOriginalSqliteSource(f.token);
 assert.throws(()=>readOriginalSqliteSourceLifetime(f.token).assertTerminated(),/PHYSICAL_UNCONFIRMED/);
});
for(const mode of ['extra-method','accessor','proxy-method','plain-object','proxy-prototype','constructor'])test('custom method configuration keeps '+mode+' unconfirmed without invoking traps',t=>{
 let traps=0;
 const f=fixture(t,db=>{
  if(mode==='extra-method')db.notDeclared=()=>{};
  if(mode==='accessor')Object.defineProperty(db,'exec',{get(){traps++;throw Error('getter invoked');}});
  if(mode==='proxy-method')db.exec=new Proxy(()=>{}, {get(){traps++;},ownKeys(){traps++;}});
  if(mode==='plain-object')return {exec(){}};
  if(mode==='proxy-prototype'){const proto=new Proxy(DatabaseSync.prototype,{getPrototypeOf(){traps++;throw Error('prototype trap');}});Object.setPrototypeOf(db,proto);db.exec=()=>{};}
  if(mode==='constructor')db.constructor=()=>{};
  return db;
 });
 assert.throws(()=>assertOriginalSqliteSourceUsable(f.token),/SOURCE_UNCONFIRMED/);
 assert.throws(()=>readOriginalSqliteSourceLifetime(f.token).assertTerminated(),/PHYSICAL_UNCONFIRMED/);
 assert.equal(traps,0);
});
for(const mode of ['promise','function','thenable'])test('actual configured exec SDK outcome remains unconfirmed: '+mode,t=>{
 const outcome=mode==='promise'?Promise.resolve():mode==='function'?()=>{}:{then(){throw Error('must not assimilate');}};
 const f=fixture(t,db=>{db.exec=sql=>{Reflect.apply(nativeExec,db,[sql]);return outcome;};return db;});
 assertOriginalSqliteSourceUsable(f.token);
 const raw=f.db.exec('CREATE TABLE fixture(id INTEGER)');inventoryOriginalSqliteSourceOutcome(f.token,raw);
 assert.throws(()=>assertOriginalSqliteSourceUsable(f.token),/SOURCE_UNCONFIRMED/);
 assert.throws(()=>readOriginalSqliteSourceLifetime(f.token).assertTerminated(),/PHYSICAL_UNCONFIRMED/);
});

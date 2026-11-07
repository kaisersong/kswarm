import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPersistence,bindJsonPersistenceWriteVerifier} from '../src/core/persistence.js';

function fixture(t,options={}) {
  const root=mkdtempSync(join(tmpdir(),'json-original-write-frame-')),filePath=join(root,'state.json');
  writeFileSync(filePath,'{"old":true}');
  const store=createPersistence({backend:'json',filePath,...options});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return{store,filePath,old:()=>readFileSync(filePath,'utf8')};
}
test('the original JSON backend verifies the exact once-serialized payload and writes the same data',t=>{
  const f=fixture(t),owner=bindJsonPersistenceWriteVerifier(f.store);let serialized=0,verified=0;
  const payload={full:()=>({toJSON(){serialized++;return{value:'Actual serialized value'};}})};
  owner.authorize(payload,actual=>{verified++;assert.deepEqual(actual,{value:'Actual serialized value'});});
  f.store.save(payload);assert.equal(serialized,1);assert.equal(verified,1);assert.deepEqual(JSON.parse(f.old()),{value:'Actual serialized value'});
  assert.throws(()=>f.store.saveSync(payload),/write_frame_required/);
});
test('a bound original backend requires its own actual payload identity, not a copied frame or another owner',t=>{
  const a=fixture(t),b=fixture(t),owner=bindJsonPersistenceWriteVerifier(a.store);bindJsonPersistenceWriteVerifier(b.store);let calls=0;
  const payload={full:()=>{calls++;return{next:true};}};owner.authorize(payload,()=>{});
  assert.throws(()=>b.store.save(payload),/write_frame_required/);assert.equal(calls,0);assert.deepEqual(JSON.parse(b.old()),{old:true});
  a.store.save(payload);assert.equal(calls,1);assert.throws(()=>bindJsonPersistenceWriteVerifier(a.store),/already_bound/);
});
test('full and verifier failures preserve the actual primary error and cannot write or replay a frame',t=>{
  for(const phase of ['full','verify']) {
    const f=fixture(t),owner=bindJsonPersistenceWriteVerifier(f.store),primary=new Error(`Original ${phase} failure`);
    const payload={full:()=>{if(phase==='full')throw primary;return{next:true};}};
    owner.authorize(payload,()=>{if(phase==='verify')throw primary;});
    assert.throws(()=>f.store.save(payload),error=>error===primary);assert.deepEqual(JSON.parse(f.old()),{old:true});assert.equal(f.store.getHealth().status,'failed');
    assert.throws(()=>f.store.save(payload),/failed_state/);
  }
});
test('a verifier cannot defer its decision to a returned promise',t=>{
  const f=fixture(t),owner=bindJsonPersistenceWriteVerifier(f.store),payload={full:()=>({next:true})};
  owner.authorize(payload,()=>Promise.reject(new Error('Actual late rejection')));
  assert.throws(()=>f.store.save(payload),/synchronous_void/);assert.deepEqual(JSON.parse(f.old()),{old:true});
});
for(const phase of ['factory','full','serialize','verify','clock'])test(`caught reentry from ${phase} poisons the original outer JSON save before writing`,t=>{
  let active=false,innerCalls=0;let store;
  const reenter=()=>{if(active)assert.throws(()=>store.save(()=>{innerCalls++;return{inner:true};}),/reentrant_save/);};
  const f=fixture(t,{now:()=>{if(phase==='clock')reenter();return 1;}});store=f.store;
  const owner=bindJsonPersistenceWriteVerifier(store),payload={full:()=>{if(phase==='full')reenter();return{toJSON(){if(phase==='serialize')reenter();return{outer:true};}};}};
  owner.authorize(payload,()=>{if(phase==='verify')reenter();});active=true;
  assert.throws(()=>store.save(()=>{if(phase==='factory')reenter();return payload;}),/reentrant_save/);
  assert.equal(innerCalls,0);assert.deepEqual(JSON.parse(f.old()),{old:true});assert.equal(store.getHealth().status,'failed');
});
test('the unbound generic JSON API keeps ordinary saves and also refuses caught recursive saves',t=>{
  const f=fixture(t);f.store.save(()=>({ordinary:true}));assert.deepEqual(JSON.parse(f.old()),{ordinary:true});
  assert.throws(()=>f.store.save(()=>{assert.throws(()=>f.store.save({inner:true}),/reentrant_save/);return{outer:true};}),/reentrant_save/);
  assert.deepEqual(JSON.parse(f.old()),{ordinary:true});
});

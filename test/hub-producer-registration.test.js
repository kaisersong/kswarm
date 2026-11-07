import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHub,readOriginalHubProducerSurface} from '../src/core/hub.js';
import {HUB_PRODUCER_REGISTRATION} from '../src/core/hub-producer-registration.js';
const here=dirname(fileURLToPath(import.meta.url)),hubPath=join(here,'../src/core/hub.js');
function absoluteImports(text,file,overrides={}){
 const url=relative=>overrides[relative]??new URL(relative,pathToFileURL(file)).href;
 return text.replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g,(_match,quote,relative)=>`from ${quote}${url(relative)}${quote}`).replace(/\bimport\((['"])(\.\.?\/[^'"]+)\1\)/g,(_match,quote,relative)=>`import(${quote}${url(relative)}${quote})`);
}
async function originalProbe(t,injection='publicApi.unregisteredMutation=publicApi.mutateProjectState;'){
 const root=mkdtempSync(join(tmpdir(),'hub-producer-registration-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const original=readFileSync(hubPath,'utf8'),anchor='  const migrationSafe=';
 assert.equal(original.split(anchor).length,2,'probe must hit the actual original public-wrapper boundary once');
 const probe=absoluteImports(original.replace(anchor,'  '+injection+'\n'+anchor),hubPath);
 const probePath=join(root,'hub.mjs');writeFileSync(probePath,probe);
 // Reuse the unchanged existing real-SQLite fixture/data producer. Only its
 // createHub import points to the original Hub with the one deliberate alias.
 const fixturePath=join(here,'dsh-owner-foundation.test.js'),fixtureSource=readFileSync(fixturePath,'utf8'),boundary=fixtureSource.indexOf("test('DSH floor7");
 assert.ok(boundary>1000);const prefix=fixtureSource.slice(0,boundary);assert.ok(prefix.includes('function fixture('));
 const fixtureModule=absoluteImports(prefix,fixturePath,{'../src/core/hub.js':pathToFileURL(probePath).href})+'\nexport {fixture};\n';
 const modulePath=join(root,'fixture.mjs');writeFileSync(modulePath,fixtureModule);
 return import(pathToFileURL(modulePath).href);
}
test('actual Hub rejects an unregistered alias before the original mutation callback on DSH work',async t=>{
 const {fixture}=await originalProbe(t),f=fixture(t);assert.equal(f.prepare().ok,true);f.baseline();const created=f.apply(await f.command()),id=created.receipt.ownerWorkId;assert.ok(id);
 let entered=0,result;try{result=await f.hub.unregisteredMutation(id,()=>{entered++;});}catch(raw){result=raw;}
 assert.equal(entered,0,'an unknown public alias must not enter its original callback before the persistence fence');
 assert.equal(result?.error,'DSH_PRODUCER_UNREGISTERED');
});
test('existing original ordinary user creation and mutation remain usable',async t=>{
 const {fixture}=await originalProbe(t),f=fixture(t);const project=f.hub.createProject({id:'ordinary',name:'Ordinary',goal:'Preserve original user capability',poAgent:'po',members:[],autoAssignPo:false,requestedStartPolicy:'plan_only'});assert.equal(project.id,'ordinary');
 let entered=0;f.hub.mutateProjectState('ordinary',()=>{entered++;});assert.equal(entered,1);assert.equal(f.hub.getProject('ordinary').id,'ordinary');
});
for(const [kind,injection,select] of [
 ['new port','publicApi.unregisteredPort=Object.freeze({run:publicApi.mutateProjectState});',hub=>hub.unregisteredPort.run],
 ['known port new method','publicApi.planningMigration=Object.freeze({...publicApi.planningMigration,run:publicApi.mutateProjectState});',hub=>hub.planningMigration.run],
])test('actual original Hub denies an unregistered '+kind+' before its callback',async t=>{
 const {fixture}=await originalProbe(t,injection),f=fixture(t);assert.equal(f.prepare().ok,true);f.baseline();const id=f.apply(await f.command()).receipt.ownerWorkId;let entered=0;
 assert.equal(select(f.hub)(id,()=>{entered++;}).error,'DSH_PRODUCER_UNREGISTERED');assert.equal(entered,0);
});
test('ordinary-looking arg0 cannot launder an unknown producer with another DSH target',async t=>{
 const {fixture}=await originalProbe(t,'publicApi.unregisteredWithDecoy=((raw)=>(_ordinary,id,action)=>raw(id,action))(publicApi.mutateProjectState);'),f=fixture(t);assert.equal(f.prepare().ok,true);f.baseline();const id=f.apply(await f.command()).receipt.ownerWorkId;let entered=0;
 assert.equal(f.hub.unregisteredWithDecoy('ordinary-looking',id,()=>{entered++;}).error,'DSH_PRODUCER_UNREGISTERED');assert.equal(entered,0);
});
test('private metadata is the exact original constructor surface and rejects foreign identities without getters',()=>{
 const hub=createHub({silent:true});try{const surface=readOriginalHubProducerSurface(hub);assert.deepEqual([...surface.publicKeys].sort(),[...HUB_PRODUCER_REGISTRATION.publicKeys].sort());assert.deepEqual([...surface.mutations].sort(),[...HUB_PRODUCER_REGISTRATION.mutations].sort());for(const name of Object.keys(surface.ports))assert.deepEqual([...surface.ports[name]].sort(),[...HUB_PRODUCER_REGISTRATION.ports[name]].sort());assert.equal(Object.isFrozen(surface),true);let traps=0;const foreign=new Proxy({},{get(){traps++;throw Error('trap');}});assert.throws(()=>readOriginalHubProducerSurface(foreign));assert.throws(()=>readOriginalHubProducerSurface({...hub}));assert.equal(traps,0);}finally{hub.closePersistence();}
});

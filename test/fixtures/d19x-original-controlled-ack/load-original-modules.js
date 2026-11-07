import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync,copyFileSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

/** Exact old production bodies, with their original relative module layout.
 * The second tree replaces ONLY rules with the actual current source. It tests
 * current-rule history under the frozen controlled runtime ABI, not a new
 * whole-binary floor adoption, a Native proof, or a fixture-issued Host grant. */
export async function loadOriginalControlledAckModules(t){
 const fixtures=new URL('./',import.meta.url),repo=fileURLToPath(new URL('../../../',import.meta.url));
 const manifest=JSON.parse(readFileSync(new URL('manifest.json',fixtures),'utf8'));
 const root=mkdtempSync(join(tmpdir(),'dsh-original-controlled-ack-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const frozen=[];
 for(const entry of manifest.files){
  const bytes=readFileSync(new URL(entry.fixture,fixtures));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,entry.source);
  frozen.push({entry,bytes});
 }
 async function load(kind){
  const target=join(root,kind);
  cpSync(join(repo,'src'),join(target,'src'),{recursive:true});
  copyFileSync(join(repo,'package.json'),join(target,'package.json'));
  symlinkSync(join(repo,'node_modules'),join(target,'node_modules'),'dir');
  for(const {entry,bytes} of frozen)writeFileSync(join(target,entry.source),bytes);
  if(kind==='current-rules'){
   const bytes=readFileSync(join(repo,'src/core/default-dispatch-operation-rules.js'));
   writeFileSync(join(target,'src/core/default-dispatch-operation-rules.js'),bytes);
   console.log(JSON.stringify({fixture:'original-controlled-ack-current-rules-history',packetSha256:manifest.packetSha256,
    currentRulesSha256:createHash('sha256').update(bytes).digest('hex'),nativeHostQualified:false,wholeBinaryFloorAdoption:false}));
  }
  const url=name=>pathToFileURL(join(target,'src/core',name)).href;
  const [hub,persistence,authority]=await Promise.all([
   import(url('hub.js')),import(url('sqlite-persistence.js')),import(url('project-input-authority.js')),
  ]);
  return Object.freeze({createHub:hub.createHub,bindHubServerScheduler:hub.bindHubServerScheduler,
   createSqlitePersistence:persistence.createSqlitePersistence,createProjectInputAuthority:authority.createProjectInputAuthority});
 }
 return Object.freeze({original:await load('original'),currentRules:await load('current-rules')});
}

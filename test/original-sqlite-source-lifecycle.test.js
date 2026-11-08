import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
for(const mode of ['healthy','runtime-undefined','membership','ctor-before','ctor-after','ctor-proxy','close-before','close-after','init-before','init-after','held-init','getter-init'])test('actual original SQLite source lifetime: '+mode,()=>{
 const root=mkdtempSync(join(tmpdir(),'ks-life-test-'));mkdirSync(join(root,'config'),{mode:0o700});
 assert.equal(existsSync(join(repo,'runtime/xiaok-source-runtime.cjs')),true,'build-bound original shared runtime fixture prerequisite');
 const args=[join(repo,'test/fixtures/original-sqlite-source-lifecycle.mjs'),mode],raw=spawnSync(process.execPath,args,{cwd:repo,env:{...process.env,XIAOK_CONFIG_DIR:join(root,'config')},encoding:'utf8',timeout:10000});
 const receipt={pid:raw.pid,command:process.execPath,args,status:raw.status,signal:raw.signal,stdout:raw.stdout,stderr:raw.stderr,error:raw.error?.message};writeFileSync(join(root,'run.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({kind:'ks-life-test-birth',mode,pid:raw.pid,root,status:raw.status,signal:raw.signal}));
 assert.equal(raw.error,undefined);assert.equal(raw.status,0,raw.stderr);const facts=JSON.parse(raw.stdout);assert.equal(facts.kind,'original-sqlite-source-lifecycle');assert.equal(facts.mode,mode);assert.equal(facts.homeUnchanged,true);assert.equal(facts.productionQualified,false);
});

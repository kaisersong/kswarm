import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,win32} from 'node:path';
import {lookupProjectWorkspace} from '../src/server/project-workspace.js';
test('a workspace lookup returns detached metadata without creating directories or updating the original cache',t=>{
 const root=mkdtempSync(join(tmpdir(),'workspace-observation-'));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5}));const cache=new Map(),projects=join(root,'projects');const first=lookupProjectWorkspace(cache,projects,'p');assert.deepEqual(first,{path:join(projects,'p'),artifacts:join(projects,'p','artifacts'),custom:false});assert.equal(existsSync(projects),false);assert.equal(cache.size,0);assert.equal(Object.isFrozen(first),true);
 const existing={path:join(root,'custom'),artifacts:join(root,'custom','artifacts'),custom:true};cache.set('p',existing);const next=lookupProjectWorkspace(cache,projects,'p');assert.notEqual(next,existing);assert.equal(Object.isFrozen(next),true);assert.equal(existsSync(existing.path),false);assert.equal(cache.get('p'),existing);
});
test('pure workspace lookup preserves Windows drive and UNC metadata on every host',()=>{
 for(const path of ['D:\\work\\project','\\\\host\\share\\project']){const result=lookupProjectWorkspace(new Map(),'unused','p',path);assert.equal(result.path,path);assert.equal(result.artifacts,win32.join(path,'artifacts'));}
 const result=lookupProjectWorkspace(new Map(),'D:\\projects','p');assert.equal(result.path,'D:\\projects\\p');assert.equal(result.artifacts,'D:\\projects\\p\\artifacts');
});
test('a cached workspace accessor is rejected without executing it or writing a repair',()=>{
 let reads=0;const cached={artifacts:'x',custom:true};Object.defineProperty(cached,'path',{enumerable:true,get(){reads++;return'forged';}});const cache=new Map([['p',cached]]);assert.throws(()=>lookupProjectWorkspace(cache,'unused','p'));assert.equal(reads,0);assert.equal(cache.get('p'),cached);
});

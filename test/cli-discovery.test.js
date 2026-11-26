import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {createAgentStore} from '../src/core/agent-store.js';
import {resolveAgentRuntimeSelection} from '../src/core/agent-runtime-selection.js';
import {findAgentExecutable} from '../src/core/cli-discovery.js';

test('absolute CLI paths containing spaces and Unicode are discovered without running their payload',()=>{
 const root=mkdtempSync(join(tmpdir(),'kswarm-cli 中文 ')),marker=join(root,'must-not-exist'),file=join(root,process.platform==='win32'?'fixture.cmd':'fixture-cli');
 try{writeFileSync(file,process.platform==='win32'?'@echo off\r\necho effect > "'+marker+'"\r\n':'#!/bin/sh\nprintf effect > "'+marker+'"\n',{mode:0o700});assert.equal(findAgentExecutable(file),process.platform==='win32'?realpathSync.native(file):file);assert.equal(existsSync(marker),false);assert.equal(findAgentExecutable(join(root,'missing')),null);assert.equal(findAgentExecutable(root),null);}finally{rmSync(root,{recursive:true,force:true});}
});
test('PATH lookup preserves Unicode and literal names without executing a found CLI',()=>{
 const root=mkdtempSync(join(tmpdir(),'kswarm-cli-path 中文 ')),marker=join(root,'effect'),name='kswarm-fixture-'+process.pid,file=join(root,name+(process.platform==='win32'?'.cmd':'')),before=process.env.PATH;
 try{writeFileSync(file,process.platform==='win32'?'@echo off\r\necho effect > "'+marker+'"\r\n':'#!/bin/sh\nprintf effect > "'+marker+'"\n',{mode:0o700});process.env.PATH=root+delimiter+(before??'');assert.equal(findAgentExecutable(name),process.platform==='win32'?realpathSync.native(file):file);assert.equal(existsSync(marker),false);assert.equal(findAgentExecutable(name+'; echo effect'),null);assert.equal(existsSync(marker),false);assert.equal(findAgentExecutable('--help'),null);assert.equal(findAgentExecutable(name+'\n'),null);}finally{if(before===undefined)delete process.env.PATH;else process.env.PATH=before;rmSync(root,{recursive:true,force:true});}
});

test('the original Agent Store publishes the detected explicit CLI to runtime selection without invoking it',()=>{
 const root=mkdtempSync(join(tmpdir(),'kswarm-store 中文 ')),marker=join(root,'effect'),file=join(root,process.platform==='win32'?'codex.cmd':'codex'),before=process.env.KSWARM_CODEX_PATH;
 try{writeFileSync(file,process.platform==='win32'?'@echo off\r\necho effect > "'+marker+'"\r\n':'#!/bin/sh\nprintf effect > "'+marker+'"\n',{mode:0o700});process.env.KSWARM_CODEX_PATH=file;const store=createAgentStore({filePath:join(root,'agents.json')}),selection=resolveAgentRuntimeSelection({runtimeType:'codex'},store.detectCLIs());assert.equal(selection.runtimeType,'codex');assert.equal(selection.runtimePath,process.platform==='win32'?realpathSync.native(file):file);assert.equal(existsSync(marker),false);}finally{if(before===undefined)delete process.env.KSWARM_CODEX_PATH;else process.env.KSWARM_CODEX_PATH=before;rmSync(root,{recursive:true,force:true});}
});

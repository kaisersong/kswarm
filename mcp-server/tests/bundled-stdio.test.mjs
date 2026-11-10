import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

test('the actual bundled stdio artifact initializes and exposes strict create-node permissions without business calls',{timeout:10000},async()=>{
 const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/server.bundle.js',import.meta.url))],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,KSWARM_URL:'http://127.0.0.1:9',KSWARM_WS_URL:'ws://127.0.0.1:9/ws'}});
 let stderr='';child.stderr.on('data',b=>{stderr+=b;});
 const closed=once(child,'close');let hasClosed=false;closed.then(()=>{hasClosed=true;});
 const reader=createInterface({input:child.stdout}),replies=new Map();
 reader.on('line',line=>{const message=JSON.parse(line);const resolve=replies.get(message.id);if(resolve){replies.delete(message.id);resolve(message);}});
 async function call(id,method,params){
  let timer;const reply=new Promise(resolve=>replies.set(id,resolve));
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  try{return await Promise.race([reply,closed.then(([code,signal])=>{throw Error('artifact exited before reply: '+JSON.stringify({code,signal,stderr}));}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('artifact reply timeout: '+stderr)),5000);})]);}finally{clearTimeout(timer);replies.delete(id);}
 }
 try{
  const initialized=await call(1,'initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'release-artifact-regression',version:'1'}});assert.equal(initialized.error,undefined);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const listed=await call(2,'tools/list',{});assert.equal(listed.error,undefined);
  const create=listed.result.tools.find(tool=>tool.name==='workflow/create-node');assert.ok(create);
  const permissions=create.inputSchema.properties.permissions;assert.equal(permissions.additionalProperties,false);assert.ok(permissions.properties.deniedCommandIds);assert.ok(permissions.properties.deniedCommands);assert.ok(permissions.properties.toolCategories);
 }finally{
  reader.close();child.stdin.end();if(!hasClosed)child.kill('SIGTERM');
  let timer;try{await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('artifact child close unconfirmed')),1000);})]);}catch(error){if(!hasClosed)child.kill('SIGKILL');await closed;throw error;}finally{clearTimeout(timer);}
 }
});

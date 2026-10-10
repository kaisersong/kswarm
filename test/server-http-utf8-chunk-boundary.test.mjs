import {test} from 'node:test';import assert from 'node:assert/strict';
import {request} from 'node:http';import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
import {createOwnedServer} from './support/utf8-owned-server/fixture.mjs';

const records=f=>existsSync(join(f.root,'received-chunks.jsonl'))?readFileSync(join(f.root,'received-chunks.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
async function forced(f,body,label,offset,t){
 const path='/projects/project/artifacts/report.html?utf8case='+label;
 const original=Buffer.from(JSON.stringify({content:body}));const mark=Buffer.from(label==='two-byte'?'é':label==='three-byte'?'中':'😀');const split=original.indexOf(mark)+offset;assert.ok(split>0&&split<original.length);
 const output=new Promise((resolve,reject)=>{
  const req=request(f.base+path,{method:'PUT',headers:{'content-type':'application/json','content-length':String(original.length),'x-kswarm-mutation-token':'temporary-test-token'}},res=>{const chunks=[];res.on('data',c=>chunks.push(Buffer.from(c)));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});
  req.on('error',reject);req.setTimeout(1800,()=>req.destroy(Error('owned forced body request timeout')));
  req.write(original.subarray(0,split));
  void (async()=>{try{let received;
   for(let n=0;n<100;n++){received=records(f).filter(r=>r.url===path);if(received.reduce((sum,r)=>sum+r.length,0)===split)break;await new Promise(resolve=>setTimeout(resolve,5));}
   assert.equal(received.reduce((sum,r)=>sum+r.length,0),split,'first write must be observed in actual service IncomingMessage before tail is sent');
   assert.ok(received.at(-1).suffixHex.endsWith(original.subarray(split-offset,split).toString('hex')));
   req.end(original.subarray(split));
  }catch(error){req.destroy(error);}})();
 });
 const response=await output;const received=records(f).filter(r=>r.url===path);assert.equal(received.reduce((sum,r)=>sum+r.length,0),original.length);assert.equal(response.status,200,response.body);
 const file=readFileSync(join(f.workspace.artifacts,'report.html'));const get=await f.nativeFetch(f.base+'/projects/project/artifacts/report.html');assert.equal(get.status,200);const publicBytes=Buffer.from(await get.arrayBuffer());
 const row={label,split,expectedBodyBytes:Buffer.byteLength(body),actualFileBytes:file.length,expectedHex:Buffer.from(body).toString('hex'),actualHex:file.toString('hex'),received};t.diagnostic(JSON.stringify(row));
 assert.deepEqual(file,Buffer.from(body),'original Unicode content must persist byte-identically');assert.deepEqual(publicBytes,Buffer.from(body),'real artifact GET must retain original Unicode bytes');
}
for(const [label,char,offset] of [['two-byte','é',1],['three-byte','中',1],['four-byte','😀',2]])test('actual KSwarm artifact PUT/GET retains '+label+' across observed split',async t=>{
 const f=await createOwnedServer();try{writeFileSync(join(f.workspace.artifacts,'report.html'),'before');await forced(f,'<html>prefix'+char+'suffix</html>',label,offset,t);}finally{await f.close();}
});
test('retains original empty malformed invalid-byte and unauthorized mutation envelopes',async()=>{
 const f=await createOwnedServer();try{
  const file=join(f.workspace.artifacts,'report.html');writeFileSync(file,'before');const path=f.base+'/projects/project/artifacts/report.html';const headers={'content-type':'application/json','x-kswarm-mutation-token':'temporary-test-token'};
  const empty=await f.nativeFetch(path,{method:'PUT',headers,body:''});assert.equal(empty.status,400);assert.deepEqual(await empty.json(),{ok:false,error:'content_required'});
  const malformed=await f.nativeFetch(path,{method:'PUT',headers,body:'{'});assert.equal(malformed.status,500);assert.deepEqual(await malformed.json(),{error:'Invalid JSON'});
  const invalid=Buffer.concat([Buffer.from('{"content":"'),Buffer.from([0xff]),Buffer.from('"}')]);const invalidResponse=await f.nativeFetch(path,{method:'PUT',headers,body:invalid});assert.equal(invalidResponse.status,200);assert.equal(readFileSync(file,'utf8'),'�');
  for(const token of ['', 'wrong-token']){const response=await f.nativeFetch(f.base+'/projects/project/tasks/human',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-kswarm-mutation-token':token}:{})},body:'{'});assert.equal(response.status,401);const result=await response.json();assert.equal(typeof result.error,'string');assert.notEqual(result.error,'Invalid JSON');}
  const normal='<html>ASCII and 中文 😀</html>';const normalResponse=await f.nativeFetch(path,{method:'PUT',headers,body:JSON.stringify({content:normal})});assert.equal(normalResponse.status,200);assert.equal(readFileSync(file,'utf8'),normal);
 }finally{await f.close();}
});

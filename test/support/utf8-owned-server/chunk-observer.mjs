import http from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync,realpathSync,statSync} from 'node:fs';
import {join,basename,dirname} from 'node:path';import os from 'node:os';
const root=process.env.XIAOK_UTF8_FIXTURE_HOME;
if(!root||realpathSync(root)!==root||dirname(root)!==realpathSync(os.tmpdir())||!basename(root).startsWith('kswarm-utf8-')||statSync(root).uid!==os.userInfo().uid)throw Error('observer_owned_temp_required');
const nativeCreateServer=http.createServer;
http.createServer=function(...args){
 const server=Reflect.apply(nativeCreateServer,this,args);
 server.prependListener('request',req=>{
  if(req.method!=='PUT'||!req.url?.includes('utf8case='))return;
  const ownOn=Object.getOwnPropertyDescriptor(req,'on'),nativeOn=req.on;
  const restore=()=>{if(ownOn)Object.defineProperty(req,'on',ownOn);else delete req.on;};
  let ordinal=0;
  const observe=chunk=>{
   if(!Buffer.isBuffer(chunk))throw Error('observer_expected_original_Buffer');
   appendFileSync(join(root,'received-chunks.jsonl'),JSON.stringify({url:req.url,ordinal:ordinal++,length:chunk.length,prefixHex:chunk.subarray(0,12).toString('hex'),suffixHex:chunk.subarray(-12).toString('hex'),observerAttachedAfterProductionDataReader:true})+'\n');
  };
  Object.defineProperty(req,'on',{configurable:true,writable:true,value:function(name,...rest){
   const result=Reflect.apply(nativeOn,this,[name,...rest]);
   if(this===req&&name==='data'){
    restore();
    Reflect.apply(nativeOn,req,['data',observe]);
   }
   return result;
  }});
  // Close observer does not resume the body if a route never installs a reader.
  Reflect.apply(nativeOn,req,['close',restore]);
 });
 return server;
};
syncBuiltinESMExports();

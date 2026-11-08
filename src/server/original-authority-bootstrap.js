// Installed fixed entry. Native birth is consumed before configuration or any
// business module import. IPC data configures the service, never its file family.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {types} from 'node:util';
const requireFixed=createRequire(import.meta.url),native=requireFixed('../../runtime/protected_sqlite.node');
const originalNamespace=native.consumeOriginalKSwarmSource();
native.assertOriginalNamespace(originalNamespace);
const descriptor=Object.getOwnPropertyDescriptor,own=Object.hasOwn,keys=Reflect.ownKeys,apply=Reflect.apply;
const held=[native,originalNamespace],define=Object.defineProperty;
function retain(raw){define(held,String(held.length),{__proto__:null,value:raw});}
function reject(){throw Error('KSWARM_ORIGINAL_STARTUP_REQUIRED');}
const reserved=new Set(['NODE_OPTIONS','NODE_PATH','NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE','ELECTRON_RUN_AS_NODE','XIAOK_NODE_CMD']);
function startup(raw){
 if(!raw||typeof raw!=='object'||types.isProxy(raw))reject();const names=keys(raw);
 if(names.length!==2||!own(raw,'kind')||!own(raw,'environment'))reject();
 const kind=descriptor(raw,'kind'),environment=descriptor(raw,'environment');
 if(!kind||!own(kind,'value')||kind.value!=='original_kswarm_start_v1'||!environment||!own(environment,'value'))reject();
 const value=environment.value;if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))reject();
 const entries=keys(value);if(entries.length>256)reject();let bytes=0;const captured=Object.create(null);
 for(let index=0;index<entries.length;index++){
  const name=entries[index],row=descriptor(value,name);
  if(typeof name!=='string'||!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(name)||reserved.has(name)||!row||!own(row,'value')||typeof row.value!=='string'||row.value.includes('\0'))reject();
  bytes+=Buffer.byteLength(name)+Buffer.byteLength(row.value);if(bytes>131072)reject();define(captured,name,{__proto__:null,value:row.value,enumerable:true});
 }
 // Config isolation must precede the bundled ordinary observer's first import.
 if(!captured.XIAOK_CONFIG_DIR||!captured.KSWARM_DATA_ROOT)reject();return captured;
}
const on=process.on,remove=process.removeListener;
const configuration=await new Promise((yes,no)=>{
 let completed=false;const finish=(raw,rejected)=>{if(completed)return;completed=true;clearTimeout(timer);apply(remove,process,['message',message]);apply(remove,process,['disconnect',disconnect]);if(rejected)no(raw);else yes(raw);};
 const message=raw=>{retain(raw);try{finish(startup(raw),false);}catch(error){retain(error);finish(error,true);}};
 const disconnect=()=>finish(Error('KSWARM_ORIGINAL_STARTUP_DISCONNECTED'),true);
 const timer=setTimeout(()=>finish(Error('KSWARM_ORIGINAL_STARTUP_TIMEOUT'),true),5000);
 apply(on,process,['message',message]);apply(on,process,['disconnect',disconnect]);
});
for(const name of keys(configuration))process.env[name]=configuration[name];
const entry=new URL('./index.js',import.meta.url);
// Existing health identity describes the original business entry and tree.
process.argv[1]=fileURLToPath(entry);
try{const imported=import('./index.js');retain(imported);retain(await imported);}catch(raw){retain(raw);throw raw;}

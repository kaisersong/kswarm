import {createHub} from '../../../src/core/hub.js';
import {installOwnedDesktopControl} from '../../../src/server/owned-desktop-control.js';
import {createSqlitePersistence} from '../../../src/core/sqlite-persistence.js';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {writeFileSync,existsSync,readFileSync,renameSync} from 'node:fs';
const root=process.env.CONTROL_TEST_ROOT,scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
const mark=(name,value)=>{const pending=join(root,name+'.pending');writeFileSync(pending,JSON.stringify(value),{mode:0o600});renameSync(pending,join(root,name));};
function later(name,done){const timer=setInterval(()=>{if(existsSync(join(root,'release-'+name))){clearInterval(timer);done();}},5);}
const rawSend=process.send.bind(process);
let sendingHello=false;
const orphanRefs=[];let gcTurns=0;
if(process.env.CONTROL_PREFIX_RAW_MODE==='orphan')setInterval(()=>{if(!orphanRefs.length)return;global.gc();if(++gcTurns===4)mark('raw-retention.json',{retained:orphanRefs[0].deref()!==undefined});},15);
process.send=function(frame,callback){
 const tag=frame.type+'-'+(frame.id??0);
 if(frame.type==='prefix_drained'&&sendingHello)mark('prefix-reentered.json',{pid:process.pid});
 const synchronous=frame.type==='hello_ack'&&process.env.CONTROL_PREFIX_SYNC_HELLO==='1';
 const result=rawSend(frame,error=>{
  if(synchronous)return;
  const finish=()=>{mark('callback-'+tag+'.json',{pid:process.pid,error:error?.message??null});callback(error??(process.env.CONTROL_PREFIX_CALLBACK_ERROR===tag?Error('original prefix SDK callback failed'):null));};
  if((process.env.CONTROL_PREFIX_HOLD_TYPES??'').split(',').includes(frame.type)){mark('held-'+tag+'.json',{pid:process.pid,type:frame.type,id:frame.id??0});later(tag,finish);}else finish();
 });
 if(synchronous){sendingHello=true;callback(null);process.emit('message',{protocol:frame.protocol,type:'seal_prefix',nonce:frame.nonce,scope:frame.scope,instance:frame.instance,throughId:0,sealNonce:'d'.repeat(64)});sendingHello=false;mark('hello-return-classification.json',{pid:process.pid});}
 if(process.env.CONTROL_PREFIX_RAW_TYPE===frame.type){
  if(process.env.CONTROL_PREFIX_RAW_MODE==='orphan'){const raw=new Promise(()=>{});orphanRefs.push(new WeakRef(raw));return raw;}
  if(process.env.CONTROL_PREFIX_RAW_MODE==='thenable')return {get then(){mark('then-read.json',{pid:process.pid});throw Error('unexpected SDK then getter');}};
  if(process.env.CONTROL_PREFIX_RAW_MODE==='throw')throw Error('original prefix SDK synchronous throw');
  return new Promise(resolve=>{mark('raw-'+tag+'.json',{pid:process.pid});later('raw-'+tag,resolve);});
 }
 return result;
};
let armed=false;const path=join(root,'state.sqlite');
const persistence=createSqlitePersistence({filePath:path,sqliteFactory(file){const db=new DatabaseSync(file),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT'&&process.env.CONTROL_PREFIX_NATIVE_FAULT==='1'){armed=false;throw Error('original prefix Native COMMIT failed');}return exec(sql);};return db;}});
const hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath:path},persistence});armed=true;
for(const name of ['prepareFreshInitialPlanAcceptanceWriter','inspectDefaultDispatchWriter']){const invoke=hub[name].bind(hub);let calls=0;hub[name]=(...args)=>{mark(name+'.json',{calls:++calls});const result=invoke(...args);if(name==='prepareFreshInitialPlanAcceptanceWriter'&&process.env.CONTROL_PREFIX_OPERATION_THROW==='1')throw Error('original operation threw after Native commit');return result;};}
process.on('message',frame=>{if(frame?.type==='request')mark('received-'+frame.id+'.json',{id:frame.id});});
installOwnedDesktopControl({hub,scope,onPersistenceCommitFailure(){mark('native-failstop.json',{pid:process.pid});setImmediate(()=>process.exit(75));}});
process.on('disconnect',()=>{try{hub.closePersistence();}catch{}});

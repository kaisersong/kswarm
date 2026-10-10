import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';import {createServer} from 'node:net';
import {createHub} from '../../../src/core/hub.js';
const repositoryRoot=fileURLToPath(new URL('../../../',import.meta.url));
const brokerRoot=resolve(repositoryRoot,'../intent-broker');
/** Real server/index and real Hub/SQLite/broker, with only owned temporary state. */
export async function createOwnedServer(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'kswarm-utf8-'))),data=join(root,'data');mkdirSync(data);mkdirSync(join(root,'config'));
 let child,deadline,broker,brokerHTTP,hub,logs='';const nativeFetch=globalThis.fetch;
 const stop=async()=>{clearTimeout(deadline);if(child&&child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1000);try{await exit;}finally{clearTimeout(timer);}}};
 const close=async()=>{hub?.closePersistence();await stop();if(broker){let drained=false;for(let n=0;n<100;n++){if(broker.getWebSocketNotifier().listConnections().length===0){drained=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(drained,'owned broker connections must be drained before removing temporary state');broker.close();}await brokerHTTP?.close();rmSync(root,{recursive:true,force:true});};
 try{
  hub=createHub({silent:true,eventLogDir:join(data,'events'),projectStorageRoot:join(data,'projects'),dataDir:{backend:'sqlite',filePath:join(data,'state.sqlite'),legacyJsonPath:join(data,'state.json'),silent:true}});
  hub.createProject({id:'project',name:'Owned UTF8 project',goal:'Own temporary artifact',poAgent:'xiaok-po',members:['xiaok-worker'],autoAssignPo:false});hub.closePersistence();hub=null;
  const workspace={path:join(data,'projects/project'),artifacts:join(data,'projects/project/artifacts')};mkdirSync(workspace.artifacts,{recursive:true});
  const {createBrokerService}=await import(join(brokerRoot,'src/broker/service.js'));
  const {createServer:createBrokerHTTPServer}=await import(join(brokerRoot,'src/http/server.js'));
  broker=createBrokerService({dbPath:join(root,'broker.sqlite')});brokerHTTP=createBrokerHTTPServer({broker,roomService:broker.room});broker.attachWebSocket(brokerHTTP.raw());await brokerHTTP.listen(0,'127.0.0.1');const brokerBase='http://127.0.0.1:'+brokerHTTP.address().port;
  const reservation=createServer();await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const base='http://127.0.0.1:'+port;
  child=spawn(process.execPath,['--import',fileURLToPath(new URL('./child-account-preload.mjs',import.meta.url)),'--import',fileURLToPath(new URL('./chunk-observer.mjs',import.meta.url)),'src/server/index.js'],{cwd:repositoryRoot,env:{...process.env,XIAOK_UTF8_FIXTURE_HOME:root,KSWARM_DATA_ROOT:data,KSWARM_PORT:String(port),BROKER_URL:brokerBase,KSWARM_DESKTOP_MUTATION_TOKEN:'temporary-test-token',XIAOK_CONFIG_DIR:join(root,'config'),XIAOK_DISABLE_GLOBAL_PLUGINS:'1'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',bytes=>{logs+=bytes.toString();});child.stderr.on('data',bytes=>{logs+=bytes.toString();});
  deadline=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},5000);
  let ready=false;for(let n=0;n<30;n++){if(child.exitCode!==null||child.signalCode!==null)throw Error('owned server exited: '+logs);try{if((await nativeFetch(base+'/health',{signal:AbortSignal.timeout(100)})).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,25));}assert.ok(ready,'actual owned server must be ready');
  return {root,base,workspace,nativeFetch,close};
 }catch(error){try{await close();}catch(cleanup){error.ownedCleanupRoot=root;error.ownedCleanupError=cleanup.message;}throw error;}
}

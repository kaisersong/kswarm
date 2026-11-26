import {createRequire} from 'node:module';
import {lstatSync} from 'node:fs';
import {types} from 'node:util';
import {fileURLToPath} from 'node:url';
const requireFixed=createRequire(import.meta.url),path=fileURLToPath(new URL('../../runtime/xiaok-source-runtime.cjs',import.meta.url));
const descriptor=Object.getOwnPropertyDescriptor,keys=Reflect.ownKeys,own=Object.hasOwn,isFrozen=Object.isFrozen;
const expected=['createRoomTurnCustody','retainSourceErrorTails','assertOrdinarySourceWriterRoute','observeOrdinarySQLiteWriter'];
let state='initial',value,first;
const held=[];const define=Object.defineProperty;
function retain(raw){define(held,String(held.length),{__proto__:null,value:raw,enumerable:true});}
function code(raw){if(!raw||typeof raw!=='object'||types.isProxy(raw))return;const d=descriptor(raw,'code');return d&&own(d,'value')?d.value:undefined;}
/** Fixed ordinary SDK resource. Its presence/shape is not a Native role; the
 * installed child separately authenticates the build-bound release closure. */
export function readOriginalSqliteSourceRuntime(){
 if(state==='ready')return value;if(state==='absent')return null;
 if(state==='failed')throw first;if(state!=='initial')throw new Error('KSWARM_SQLITE_SOURCE_RUNTIME_UNCONFIRMED');state='loading';
 try{
  let file;try{file=lstatSync(path);}catch(raw){if(code(raw)==='ENOENT'){state='absent';return null;}throw raw;}
  if(!file.isFile()||file.isSymbolicLink())throw Error('KSWARM_SQLITE_SOURCE_RUNTIME_FILE');
  const raw=requireFixed(path);retain(raw);
  if(!raw||typeof raw!=='object'||types.isProxy(raw)||!isFrozen(raw))throw Error('KSWARM_SQLITE_SOURCE_RUNTIME_SHAPE');
  const names=keys(raw);if(names.length!==expected.length||names.some(n=>typeof n!=='string'||!expected.includes(n)))throw Error('KSWARM_SQLITE_SOURCE_RUNTIME_SHAPE');
  for(const name of expected){const d=descriptor(raw,name);if(!d||!own(d,'value')||typeof d.value!=='function'||types.isProxy(d.value)||!isFrozen(d.value))throw Error('KSWARM_SQLITE_SOURCE_RUNTIME_SHAPE');}
  value=raw;state='ready';return value;
 }catch(raw){retain(raw);first=raw;state='failed';throw raw;}
}

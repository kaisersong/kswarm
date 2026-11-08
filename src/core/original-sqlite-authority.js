import {createRequire} from 'node:module';
import {lstatSync} from 'node:fs';
import {types} from 'node:util';
import {fileURLToPath} from 'node:url';
const requireFixed=createRequire(import.meta.url),path=fileURLToPath(new URL('../../runtime/original-authority-sqlite.cjs',import.meta.url));
const descriptor=Object.getOwnPropertyDescriptor,own=Object.hasOwn,keys=Reflect.ownKeys;
let state='initial',value,failure;const held=[];const define=Object.defineProperty;
function retain(raw){define(held,String(held.length),{__proto__:null,value:raw});}
function code(raw){if(!raw||typeof raw!=='object'||types.isProxy(raw))return;const d=descriptor(raw,'code');return d&&own(d,'value')?d.value:undefined;}
/** Fixed build-bound child bootstrap; a file/shape is never a Native grant. The
 * addon consumes its original seed before this module can obtain a namespace. */
export function readOriginalSqliteAuthority(){
 if(state==='ready')return value;if(state==='absent')return null;if(state!=='initial')throw failure;state='loading';
 try{
  try{const file=lstatSync(path);if(!file.isFile()||file.isSymbolicLink())throw Error('KSWARM_ORIGINAL_AUTHORITY_FILE');}catch(raw){if(code(raw)==='ENOENT'){state='absent';return null;}throw raw;}
  const raw=requireFixed(path);retain(raw);
  if(!raw||typeof raw!=='object'||types.isProxy(raw)||!Object.isFrozen(raw))throw Error('KSWARM_ORIGINAL_AUTHORITY_SHAPE');
  const ds=Object.getOwnPropertyDescriptors(raw),names=keys(ds);if(names.length!==3||names.some(n=>!['namespace','bindNamespace','finish'].includes(n)))throw Error('KSWARM_ORIGINAL_AUTHORITY_SHAPE');
  for(const name of names)if(!own(ds[name],'value'))throw Error('KSWARM_ORIGINAL_AUTHORITY_SHAPE');
  if(typeof ds.bindNamespace.value!=='function'||types.isProxy(ds.bindNamespace.value)||typeof ds.finish.value!=='function'||types.isProxy(ds.finish.value))throw Error('KSWARM_ORIGINAL_AUTHORITY_SHAPE');
  if(ds.namespace.value===null){state='absent';return null;}
  value=raw;state='ready';return value;
 }catch(raw){retain(raw);failure=raw;state='failed';throw raw;}
}

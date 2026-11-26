import {types} from 'node:util';
import {IntrinsicSet} from './intrinsic-collections.js';
const descriptor=Object.getOwnPropertyDescriptor;
const apply=Reflect.apply,descriptors=Object.getOwnPropertyDescriptors,ownKeys=Reflect.ownKeys,own=Object.hasOwn,prototype=Object.getPrototypeOf;
const create=Object.create,define=Object.defineProperty,setPrototype=Object.setPrototypeOf,NativeArray=Array,isArray=Array.isArray;
const isProxy=types.isProxy,isPromise=types.isPromise,finite=Number.isFinite,safeInteger=Number.isSafeInteger,json=JSON.stringify,bytes=Buffer.byteLength;
const objectPrototype=Object.prototype,arrayPrototype=Array.prototype;
const exec=Function.prototype.call.bind(RegExp.prototype.exec),number=Number;
const put=(object,key,value)=>define(object,key,{__proto__:null,value,writable:true,configurable:true,enumerable:true});
export class BusinessWireDataError extends Error {constructor(){super('DISPATCH_BUSINESS_DATA_INVALID');}}
/** Detached inert JSON. No post-COMMIT toJSON/then/getter/iterator callbacks.
 * The caller retains every unsafe SDK object before a shape rejection. */
export function captureDispatchBusinessData(raw,onUnsafe=()=>{}){
 const path=new IntrinsicSet(),unsafe=new IntrinsicSet(),incomplete=new IntrinsicSet();let nodes=0,invalid=false;
 const bad=value=>{invalid=true;if(value!==null&&(typeof value==='object'||typeof value==='function'))unsafe.add(value);};
 function walk(value,depth){
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!finite(value))invalid=true;return value;}
  if(typeof value!=='object'&&typeof value!=='function'){bad(value);return null;}
  if(isProxy(value)){bad(value);return null;}
  if(typeof value==='function'||isPromise(value))bad(value);
  const array=isArray(value),proto=prototype(value);if(array?proto!==arrayPrototype&&proto!==null:proto!==objectPrototype&&proto!==null)bad(value);
  if(++nodes>1000000||depth>128){incomplete.add(value);bad(value);return null;}
  if(path.has(value)){bad(value);return null;}path.add(value);
  const rows=descriptors(value),names=ownKeys(rows);if(own(rows,'then'))bad(value);
  const length=array?rows.length?.value:0,validLength=!array||safeInteger(length)&&length>=0&&length<=1000000;
  if(!validLength)bad(value);
  const out=array&&validLength?new NativeArray(length):create(null);if(array&&validLength)setPrototype(out,null);
  for(let i=0;i<names.length;i++){
   const name=names[i],row=rows[name];if(array&&name==='length')continue;
   if(!own(row,'value')){bad(value);continue;}
   if(typeof name!=='string'||!row.enumerable){bad(value);walk(row.value,depth+1);continue;}
   if(array&&(!validLength||exec(/^(0|[1-9][0-9]*)$/,name)===null||number(name)>=length)){bad(value);walk(row.value,depth+1);continue;}
   put(out,name,walk(row.value,depth+1));
  }
  if(array&&names.length!==length+1)bad(value);
  path.delete(value);return out;
 }
 const out=walk(raw,0);for(const value of unsafe)onUnsafe(value,incomplete.has(value)?'incomplete':'invalid');
 if(invalid)throw new BusinessWireDataError();if(bytes(apply(json,undefined,[out]),'utf8')>8*1024*1024)throw new BusinessWireDataError();return out;
}
/** Routing only. It does not grant a session or a user business request. */
export function dispatchBusinessProtocolTag(raw){
 if(!raw||typeof raw!=='object'||isProxy(raw)||isArray(raw))return undefined;
 const row=descriptor(raw,'protocol');return row&&own(row,'value')&&typeof row.value==='string'?row.value:undefined;
}

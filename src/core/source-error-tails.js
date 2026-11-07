import {types} from 'node:util';
import {IntrinsicSet} from './intrinsic-collections.js';
const keys=Reflect.ownKeys,descriptor=Object.getOwnPropertyDescriptor,own=Object.hasOwn,prototype=Object.getPrototypeOf;
const isProxy=types.isProxy,isPromise=types.isPromise,isError=types.isNativeError,isArray=Array.isArray;
const objectPrototype=Object.prototype,arrayPrototype=Array.prototype;
const nativeStack=descriptor(Error(),'stack');
/** Inventory original own fields without invoking accessors. Only the exact
 * module-born native Error.stack accessor pair is metadata; a data stack is
 * ordinary data and may itself hold a real SDK tail. */
export function retainSourceErrorTails(error,retain){
 const seen=new IntrinsicSet(),promises=new IntrinsicSet(),unknowns=new IntrinsicSet();let count=0;
 const hold=(value,kind='unknown')=>{const reported=kind==='promise'?promises:unknowns;if(!reported.has(value)){reported.add(value);retain(value,error,kind);}};
 function walk(value,depth){
  if(value===null||typeof value!=='object'&&typeof value!=='function'||seen.has(value))return;
  seen.add(value);if(isProxy(value)){hold(value);return;}
  if(++count>100000||depth>128){hold(value);return;}
  const nativeError=isError(value),promise=isPromise(value),array=isArray(value),proto=prototype(value);
  if(promise)hold(value,'promise');
  else if(typeof value==='function'||!nativeError&&(array?proto!==arrayPrototype&&proto!==null:proto!==objectPrototype&&proto!==null))hold(value);
  const names=keys(value);
  for(let i=0;i<names.length;i++){
   const name=names[i],row=descriptor(value,name);
   if(nativeError&&name==='stack'&&row&&!own(row,'value')&&nativeStack&&!own(nativeStack,'value')&&row.get===nativeStack.get&&row.set===nativeStack.set)continue;
   if(!row||!own(row,'value')){hold(value);continue;}
   if(name==='then')hold(value);
   walk(row.value,depth+1);
  }
 }
 walk(error,0);
}

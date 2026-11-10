import {types} from 'node:util';
import {IntrinsicWeakMap} from './intrinsic-collections.js';
const create=Object.create,freeze=Object.freeze,define=Object.defineProperty;
const descriptors=Object.getOwnPropertyDescriptors,own=Object.hasOwn,keys=Reflect.ownKeys;
const isProxy=types.isProxy,isAsync=types.isAsyncFunction,prototype=Object.getPrototypeOf,asyncPrototype=Object.getPrototypeOf(async()=>{}),births=new IntrinsicWeakMap();
/** The sole construction point of the original Server owner. This birth is
 * not a Hub binding, a transport admission, or an execution permission. */
export function createOriginalTaskDeliveryOwner(options){
 if(!options||typeof options!=='object'||isProxy(options))throw Error('ORIGINAL_TASK_DELIVERY_CONSTRUCTION_REQUIRED');
 const fields=descriptors(options),names=keys(fields);
 if((names.length!==2&&names.length!==3)||!own(fields,'constructionBinding')||!own(fields,'legacySend')||!own(fields.constructionBinding,'value')||!own(fields.legacySend,'value')||names.length===3&&(!own(fields,'preparationSend')||!own(fields.preparationSend,'value')))throw Error('ORIGINAL_TASK_DELIVERY_CONSTRUCTION_REQUIRED');
 const legacySend=fields.legacySend.value;if(typeof legacySend!=='function'||isProxy(legacySend))throw Error('ORIGINAL_TASK_DELIVERY_CONSTRUCTION_REQUIRED');
 const preparationSend=own(fields,'preparationSend')?fields.preparationSend.value:undefined;
 if(names.length===3&&(typeof preparationSend!=='function'||isProxy(preparationSend)||isAsync(preparationSend)||prototype(preparationSend)===asyncPrototype))throw Error('ORIGINAL_TASK_DELIVERY_CONSTRUCTION_REQUIRED');
 const owner=create(null),identity=freeze(create(null));define(owner,'send',{__proto__:null,value:legacySend,enumerable:true});
 if(preparationSend)define(owner,'startDefaultDispatchPreparation',{__proto__:null,value:preparationSend,enumerable:true});
 births.set(owner,freeze({__proto__:null,constructionBinding:fields.constructionBinding.value,view:freeze({__proto__:null,identity})}));return freeze(owner);
}
/** Membership before property access. A public constructor birth by itself
 * cannot match an original Hub's private, one-use construction binding. */
export function readOriginalTaskDeliveryOwnerBirth(candidate){
 return candidate&&typeof candidate==='object'?births.get(candidate)?.view:undefined;
}

/** Compare private construction identity without exporting the binding. */
export function originalTaskDeliveryOwnerMatchesBinding(candidate,binding){
 const entry=candidate&&typeof candidate==='object'?births.get(candidate):undefined;
 return entry!==undefined&&entry.constructionBinding===binding;
}

import {types} from 'node:util';
import {IntrinsicWeakMap} from './intrinsic-collections.js';
const births=new IntrinsicWeakMap(),create=Object.create,define=Object.defineProperty;
const descriptors=Object.getOwnPropertyDescriptors,own=Object.hasOwn,keys=Reflect.ownKeys;
const proxy=types.isProxy;
/** Fresh original Net identity. Source matching is a construction fact only;
 * the original Hub still pins one exact client before minting any proof. */
export function createOriginalBrokerClient(options){
 if(!options||typeof options!=='object'||proxy(options))throw Error('ORIGINAL_BROKER_CLIENT_CONSTRUCTION_REQUIRED');
 const fields=descriptors(options);if(keys(fields).length!==2||!own(fields,'preparationSource')||!own(fields,'methods')||!own(fields.preparationSource,'value')||!own(fields.methods,'value'))throw Error('ORIGINAL_BROKER_CLIENT_CONSTRUCTION_REQUIRED');
 const preparationSource=fields.preparationSource.value,methods=fields.methods.value;
 if(!methods||typeof methods!=='object'||proxy(methods))throw Error('ORIGINAL_BROKER_CLIENT_CONSTRUCTION_REQUIRED');
 const rows=descriptors(methods),names=keys(rows),client=create(Object.prototype);
 for(let i=0;i<names.length;i++){
  const name=names[i],row=rows[name];if(!own(row,'value')||typeof row.value!=='function'||proxy(row.value))throw Error('ORIGINAL_BROKER_CLIENT_CONSTRUCTION_REQUIRED');
  const fixed=name==='sendDefaultDispatchPreparation'||name==='sealDefaultDispatchPreparations'||name==='drainDefaultDispatchPreparations';
  define(client,name,{__proto__:null,value:row.value,enumerable:true,writable:!fixed,configurable:!fixed});
 }
 const required=['sendDefaultDispatchPreparation','sealDefaultDispatchPreparations','drainDefaultDispatchPreparations'];
 for(let i=0;i<required.length;i++)if(!own(rows,required[i]))throw Error('ORIGINAL_BROKER_CLIENT_CONSTRUCTION_REQUIRED');
 births.set(client,{__proto__:null,source:preparationSource});return client;
}
export function originalBrokerClientMatchesSource(client,source){
 const birth=client&&typeof client==='object'?births.get(client):undefined;return birth!==undefined&&birth.source===source;
}

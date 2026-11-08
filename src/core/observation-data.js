import {types} from 'node:util';
import {captureExecutionData} from './task-execution-content.js';
const safeData=new WeakSet();
const fail=()=>{throw Error('SERVER_OBSERVATION_DATA_UNAVAILABLE');};
function hooks(){if(Object.getOwnPropertyDescriptor(Object.prototype,'toJSON')||Object.getOwnPropertyDescriptor(Array.prototype,'toJSON'))fail();}
/** Each actual source row retains the original encoded/depth/node bounds.
 * This data cache never issues an owner, scheduler or execution capability. */
export function captureObservationRow(raw){hooks();const row=captureExecutionData(raw);if(row&&typeof row==='object')safeData.add(row);return row;}
export function captureObservationRows(raw){
 hooks();if(!Array.isArray(raw)||types.isProxy(raw)||Object.getPrototypeOf(raw)!==Array.prototype)fail();const fields=Object.getOwnPropertyDescriptors(raw),length=fields.length?.value;
 if(!Number.isSafeInteger(length)||length<0||length>100000||Reflect.ownKeys(fields).length!==length+1)fail();const rows=[];
 for(let i=0;i<length;i++){const field=fields[i];if(!field||!field.enumerable||!Object.hasOwn(field,'value'))fail();rows.push(captureObservationRow(field.value));}
 Object.freeze(rows);safeData.add(rows);return rows;
}
/** Closed readonly aggregates may contain many independently valid rows.
 * No new collection-wide byte limit is imposed on the legacy HTTP views. */
export function captureObservationComposite(raw){
 hooks();let count=0;const active=new Set(),memo=new WeakMap();
 function visit(value,depth){
  if(depth>64)fail();if(value&&typeof value==='object'){if(types.isProxy(value))fail();if(safeData.has(value))return value;}if(++count>100000)fail();
  if(value===undefined||value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))fail();return value;}
  if(typeof value==='string')return captureObservationRow(value);
  if(typeof value!=='object'||types.isProxy(value))fail();
  if(active.has(value))fail();if(memo.has(value))return memo.get(value);
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value);if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail();const fields=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(fields).some(key=>typeof key!=='string'))fail();active.add(value);let result;
  try{
   if(array){const length=fields.length?.value;if(!Number.isSafeInteger(length)||length<0||length>100000||Object.keys(fields).length!==length+1)fail();result=[];for(let i=0;i<length;i++){const field=fields[i];if(!field||!field.enumerable||!Object.hasOwn(field,'value'))fail();result.push(visit(field.value,depth+1)??null);}}
   else{const entries=[];for(const key of Object.keys(fields).sort()){const field=fields[key];if(!field.enumerable||!Object.hasOwn(field,'value'))fail();if(field.value!==undefined)entries.push([key,visit(field.value,depth+1)]);}result=Object.fromEntries(entries);}
  }finally{active.delete(value);}
  Object.freeze(result);memo.set(value,result);safeData.add(result);return result;
 }
 return visit(raw,0);
}

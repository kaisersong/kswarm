import {types} from 'node:util';
import {join} from 'node:path';
import {protocolDigest} from './project-protocol.js';
const bad=()=>{throw Error('DEFAULT_DISPATCH_CONTENT_UNAVAILABLE');};
const own=Object.hasOwn,descriptor=Object.getOwnPropertyDescriptor,descriptors=Object.getOwnPropertyDescriptors,keys=Object.keys,symbols=Object.getOwnPropertySymbols,prototype=Object.getPrototypeOf,define=Object.defineProperty,freeze=Object.freeze,create=Object.create;
const objectPrototype=Object.prototype,arrayPrototype=Array.prototype,isArray=Array.isArray,isProxy=types.isProxy,finite=Number.isFinite,stringify=JSON.stringify,byteLength=Buffer.byteLength,NativeSet=Set,NativeString=String;
const sort=Function.prototype.call.bind(Array.prototype.sort),trim=Function.prototype.call.bind(String.prototype.trim),setHas=Function.prototype.call.bind(Set.prototype.has),setAdd=Function.prototype.call.bind(Set.prototype.add),setDelete=Function.prototype.call.bind(Set.prototype.delete);
const put=(object,key,value)=>define(object,key,{__proto__:null,value,enumerable:true,writable:true,configurable:true});
/** Data only. Neither this snapshot nor its digest grants execution. */
export function captureExecutionData(value){
 if(descriptor(objectPrototype,'toJSON')||descriptor(arrayPrototype,'toJSON'))bad();
 const ancestors=new NativeSet();let nodes=0;
 function copy(value,depth=0){
  if(++nodes>100000||depth>64)bad();
  if(value===null||value===undefined||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!finite(value))bad();return value;}
  if(typeof value!=='object'||isProxy(value)||setHas(ancestors,value)||symbols(value).length)bad();
  const array=isArray(value),proto=prototype(value);if(array?proto!==arrayPrototype:proto!==objectPrototype&&proto!==null)bad();
  const props=descriptors(value),names=keys(props);
  for(let i=0;i<names.length;i++){const key=names[i],row=props[key];if(!own(row,'value')||!row.enumerable&&!(array&&key==='length'))bad();}
  setAdd(ancestors,value);let out;
  if(array){if(value.length>100000||names.length!==value.length+1)bad();out=[];for(let i=0;i<value.length;i++){if(!own(props,i))bad();put(out,i,copy(props[i].value,depth+1)??null);}}
  else {out={};sort(names);for(let i=0;i<names.length;i++){const key=names[i];if(props[key].value!==undefined)put(out,key,copy(props[key].value,depth+1));}}
  setDelete(ancestors,value);return freeze(out);
 }
 const result=copy(value),encoded=stringify(result);if(encoded!==undefined&&byteLength(encoded,'utf8')>8388608)bad();return result;
}
// Shared by the actual handoff producer and business-content lineage. Dynamic
// run/claim/time/result-path fields belong to the dispatcher, not business birth.
function selected(value,selectedKeys){
 if(!value||typeof value!=='object'||isProxy(value)||isArray(value))bad();const proto=prototype(value);if(proto!==objectPrototype&&proto!==null)bad();
 const fields=descriptors(value),out={};
 for(let i=0;i<selectedKeys.length;i++){const key=selectedKeys[i];if(!own(fields,key))continue;const row=fields[key];if(!own(row,'value'))bad();put(out,key,row.value);}
 const data=captureExecutionData(out),selected=create(null),rows=descriptors(data),names=keys(rows);for(let i=0;i<names.length;i++)put(selected,names[i],rows[names[i]].value);return freeze(selected);
}
export function projectHandoffContent(project){
 const p=selected(project,['id','name','goal','requirements','workFolder','artifactsDir']);if(typeof p?.id!=='string')bad();
 return captureExecutionData({id:p.id,name:p.name,goal:p.goal,requirements:p.requirements||'',workFolder:p.workFolder||null,artifactsDir:p.artifactsDir||(p.workFolder?join(p.workFolder,'artifacts'):null)});
}
export function taskHandoffContent(project,task){
 const p=projectHandoffContent(project),t=selected(task,['id','localTaskId','title','brief','acceptanceCriteria','requiredOutputs','outputContract','executionContract','evidenceContract','repairInstruction']);
 if(typeof t?.id!=='string')bad();
 return captureExecutionData({project:p,task:{id:t.id,localTaskId:t.localTaskId||null,title:t.title,brief:t.brief||'',acceptanceCriteria:t.acceptanceCriteria||'',requiredOutputs:normalizeRequiredOutputTypes(t.requiredOutputs),outputContract:t.outputContract||null,executionContract:t.executionContract||null,evidenceContract:t.evidenceContract||null,repairInstruction:t.repairInstruction||''}});
}
export function taskBusinessContentDigest(project,task){
 const content=taskHandoffContent(project,task),t=selected(task,['desiredRoute','candidateRef','candidateRefs']);
 return protocolDigest(['default-dispatch-business-content-v1',content,{desiredRoute:t.desiredRoute??null,candidateRef:t.candidateRef??null,candidateRefs:t.candidateRefs??null}]);
}
function normalizeRequiredOutputTypes(outputs=[]){
 if(!isArray(outputs))return[];const result=[],seen=new NativeSet(),fields=['type','format','kind','mimeType'];
 for(let i=0;i<outputs.length;i++){
  const output=outputs[i];let type=typeof output==='string'?output:'';
  if(output&&typeof output==='object')for(let k=0;k<fields.length;k++)if(own(output,fields[k])&&output[fields[k]]){type=output[fields[k]];break;}
  const value=trim(dataString(type||''));if(value&&!setHas(seen,value)){setAdd(seen,value);put(result,result.length,value);}
 }
 return result;
}
// Preserve standard coercion of already-captured JSON data without invoking
// mutable Object/Array coercion methods. Functions/symbols/proxies were refused.
function dataString(value){
 if(value===null)return'null';if(typeof value!=='object')return NativeString(value);
 if(isArray(value)){let out='';for(let i=0;i<value.length;i++){if(i)out+=',';if(value[i]!==null&&value[i]!==undefined)out+=dataString(value[i]);}return out;}
 if(own(value,'toString'))throw new TypeError('Cannot convert object to primitive value');return'[object Object]';
}

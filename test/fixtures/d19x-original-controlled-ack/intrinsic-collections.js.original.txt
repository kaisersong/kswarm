// Private owner bookkeeping must not expose its receiver or values through
// ambient collection/iterator hooks installed by an admitted SDK callback.
const NativeMap=Map,NativeSet=Set,NativeWeakMap=WeakMap,apply=Reflect.apply,define=Object.defineProperty,create=Object.create,freeze=Object.freeze,isArray=Array.isArray,ownKeys=Reflect.ownKeys;
const mg=Map.prototype.get,ms=Map.prototype.set,mh=Map.prototype.has,md=Map.prototype.delete,mc=Map.prototype.clear,me=Map.prototype.entries,mk=Map.prototype.keys,mv=Map.prototype.values,msize=Object.getOwnPropertyDescriptor(Map.prototype,'size').get;
const sa=Set.prototype.add,sh=Set.prototype.has,sd=Set.prototype.delete,sc=Set.prototype.clear,sv=Set.prototype.values,ssize=Object.getOwnPropertyDescriptor(Set.prototype,'size').get;
const wg=WeakMap.prototype.get,ws=WeakMap.prototype.set,wh=WeakMap.prototype.has,wd=WeakMap.prototype.delete;
const mn=Object.getPrototypeOf(new NativeMap().entries()).next,sn=Object.getPrototypeOf(new NativeSet().values()).next;
function object(fields){const out=create(null),names=ownKeys(fields);for(let i=0;i<names.length;i++)define(out,names[i],{__proto__:null,value:fields[names[i]],enumerable:true});return freeze(out);}
function pair(key,value){const out=[key,value];define(out,Symbol.iterator,{__proto__:null,value:()=>{let index=0;return object({next:()=>index<2?{done:false,value:index++===0?key:value}:{done:true,value:undefined},[Symbol.iterator](){return this;}});}});return freeze(out);}
function iterator(raw,next,paired=false){return object({next(){const row=apply(next,raw,[]);return row.done?{done:true,value:undefined}:{done:false,value:paired?pair(row.value[0],row.value[1]):row.value};},[Symbol.iterator](){return this;}});}
function each(values,work){if(values===undefined)return;if(isArray(values)){for(let i=0;i<values.length;i++)work(values[i]);}else for(const value of values)work(value);}
export function IntrinsicMap(values){
 const raw=new NativeMap(),out=create(null);const methods={get:key=>apply(mg,raw,[key]),set(key,value){apply(ms,raw,[key,value]);return out;},has:key=>apply(mh,raw,[key]),delete:key=>apply(md,raw,[key]),clear:()=>apply(mc,raw,[]),entries:()=>iterator(apply(me,raw,[]),mn,true),keys:()=>iterator(apply(mk,raw,[]),mn),values:()=>iterator(apply(mv,raw,[]),mn),[Symbol.iterator]:()=>iterator(apply(me,raw,[]),mn,true)};
 const names=ownKeys(methods);for(let i=0;i<names.length;i++)define(out,names[i],{__proto__:null,value:methods[names[i]],enumerable:true});define(out,'size',{__proto__:null,get:()=>apply(msize,raw,[])});each(values,row=>apply(ms,raw,[row[0],row[1]]));return freeze(out);
}
export function IntrinsicSet(values){
 const raw=new NativeSet(),out=create(null);const methods={add(value){apply(sa,raw,[value]);return out;},has:value=>apply(sh,raw,[value]),delete:value=>apply(sd,raw,[value]),clear:()=>apply(sc,raw,[]),values:()=>iterator(apply(sv,raw,[]),sn),keys:()=>iterator(apply(sv,raw,[]),sn),[Symbol.iterator]:()=>iterator(apply(sv,raw,[]),sn)};
 const names=ownKeys(methods);for(let i=0;i<names.length;i++)define(out,names[i],{__proto__:null,value:methods[names[i]],enumerable:true});define(out,'size',{__proto__:null,get:()=>apply(ssize,raw,[])});each(values,value=>apply(sa,raw,[value]));return freeze(out);
}
export function IntrinsicWeakMap(){const raw=new NativeWeakMap();let out;out=object({get:key=>apply(wg,raw,[key]),set(key,value){apply(ws,raw,[key,value]);return out;},has:key=>apply(wh,raw,[key]),delete:key=>apply(wd,raw,[key])});return out;}

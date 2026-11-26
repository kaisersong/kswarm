const originalSend=process.send&&process.send.bind(process),originalOff=process.off,originalOn=process.on;
const originalIncludes=Array.prototype.includes;
const mode=process.env.DISPATCH_BUSINESS_SDK_MODE||'off-reentry',NativePromise=Promise,nativeThen=Promise.prototype.then,ctor=Object.getOwnPropertyDescriptor(Promise.prototype,'constructor'),thenDescriptor=Object.getOwnPropertyDescriptor(Promise.prototype,'then');let session,reentered=false,release,poisoned=false;
globalThis.businessSdkFacts={secondSendInvocations:0,secondCallbackDone:false,offReentered:false,faultSendInvocations:0,asyncOnBodies:0,asyncOffBodies:0,constructorGetterCalls:0,thenGetterCalls:0};
globalThis.restoreBusinessSdk=()=>{Array.prototype.includes=originalIncludes;Object.defineProperty(NativePromise.prototype,'constructor',ctor);Object.defineProperty(NativePromise.prototype,'then',thenDescriptor);};
process.send=function(message,callback){
 const facts=globalThis.businessSdkFacts;
 if(message?.protocol==='kswarm_dispatch_business_v1'&&message.type==='hello_ack'){session=message;if(mode==='op-includes')Array.prototype.includes=function(value,...rest){if(this.length===3&&this[0]==='read_plan'&&this[1]==='capture_default_dispatch'&&this[2]==='read_operation')return true;return Reflect.apply(originalIncludes,this,[value,...rest]);};}
 if(mode==='off-reentry'&&message?.protocol==='kswarm_dispatch_business_v1'&&message.type==='response'&&message.id===2)facts.secondSendInvocations++;
 if(mode==='fault-reentry'&&message?.protocol==='kswarm_dispatch_business_v1'&&message.type==='fault'){
  facts.faultSendInvocations++;if(facts.faultSendInvocations<3&&session)process.emit('message',{protocol:session.protocol,nonce:session.nonce,instance:session.instance,scope:session.scope,type:'request',id:1,op:'unknown',projectId:'p',input:null});
 }
 if(mode==='promise-constructor'&&!poisoned&&message?.protocol==='kswarm_dispatch_business_v1'&&message.type==='response'){
  poisoned=true;Object.defineProperty(NativePromise.prototype,'constructor',{configurable:true,get(){facts.constructorGetterCalls++;return NativePromise;}});Object.defineProperty(NativePromise.prototype,'then',{configurable:true,get(){facts.thenGetterCalls++;return nativeThen;}});
 }
 return originalSend(message,error=>{if(mode==='off-reentry'&&message?.protocol==='kswarm_dispatch_business_v1'&&message.type==='response'&&message.id===2){release=()=>{facts.secondCallbackDone=true;callback(error);};}else callback?.(error);});
};
globalThis.releaseBusinessSdk=()=>{if(release){const complete=release;release=undefined;complete();}};
if(mode==='off-reentry')process.off=function(event,handler){
 if(event==='message'&&!reentered&&session){reentered=true;globalThis.businessSdkFacts.offReentered=true;process.emit('message',{protocol:session.protocol,nonce:session.nonce,instance:session.instance,scope:session.scope,type:'request',id:2,op:'read_plan',projectId:'p',input:null});}
 return Reflect.apply(originalOff,this,[event,handler]);
};
if(mode==='async-on')process.on=(async function(event,handler){if(event==='message'){globalThis.businessSdkFacts.asyncOnBodies++;await new NativePromise(yes=>setImmediate(yes));}return Reflect.apply(originalOn,this,[event,handler]);}).bind(process);
if(mode==='async-off')process.off=(async function(event,handler){if(event==='message'){globalThis.businessSdkFacts.asyncOffBodies++;await new NativePromise(yes=>setImmediate(yes));}return Reflect.apply(originalOff,this,[event,handler]);}).bind(process);

if(mode==='commit-before'||mode==='commit-after'||mode==='commit-known'||mode==='post-bookkeeping'){
 const {DatabaseSync}=require('node:sqlite'),exec=DatabaseSync.prototype.exec;let armed=true;
 DatabaseSync.prototype.exec=function(sql){let fail=false;if(armed&&sql==='COMMIT')try{fail=Number(this.prepare("SELECT count(*) n FROM state_entities WHERE collection='protocolReceipt' AND state_json LIKE '%ordinary_default_dispatch_operations_v1%'").get().n)>0;}catch{}if(fail){armed=false;if(mode==='commit-before')throw Error('actual business before COMMIT');const value=Reflect.apply(exec,this,[sql]);if(mode==='post-bookkeeping'){const clone=globalThis.structuredClone;globalThis.structuredClone=function(){globalThis.structuredClone=clone;throw Error('actual post-COMMIT bookkeeping');};return value;}if(mode==='commit-known'||mode==='post-bookkeeping'){try{globalThis.businessAfterKnownCommit();}catch{}return value;}throw Error('actual business after COMMIT');}return Reflect.apply(exec,this,[sql]);};
}

if(mode==='startup-compile-held'||mode==='startup-instantiate-held'){
 const name=mode==='startup-compile-held'?'compile':'instantiate',original=WebAssembly[name];let first=true,releaseStartup,fixtureBytes,fixtureModule;
 // Newer Node defers Undici Wasm beyond Response lookup. Exercise genuine
 // Native SDK work in the getter on that ABI, without claiming a default boot
 // compile occurred. Node 22 retains its real default eager initializer test.
 if(Number(process.versions.node.split('.')[0])>=24){
  const actualResponse=globalThis.Response;fixtureBytes=new Uint8Array([0,97,115,109,1,0,0,0]);
  Object.defineProperty(globalThis,'Response',{configurable:true,get(){const raw=WebAssembly.compile(fixtureBytes);Reflect.apply(nativeThen,raw,[value=>{fixtureModule=value;return WebAssembly.instantiate(value);}]);return actualResponse;}});
 }
 globalThis.releaseStartupSdk=()=>releaseStartup?.();
 process.stdin.on('data',text=>{if(String(text).includes('release-sdk'))globalThis.releaseStartupSdk();});
 WebAssembly[name]=function(...args){
  const raw=Reflect.apply(original,this,args);if(!first||fixtureBytes&&args[0]!== (name==='compile'?fixtureBytes:fixtureModule))return raw;first=false;
  const held=new NativePromise(yes=>{releaseStartup=yes;});
  require('node:fs').writeFileSync(require('node:path').join(process.env.DISPATCH_BUSINESS_TEST_ROOT,'startup-sdk-held.json'),JSON.stringify({pid:process.pid,kind:name}));
  return Reflect.apply(nativeThen,raw,[value=>Reflect.apply(nativeThen,held,[()=>value])]);
 };
}

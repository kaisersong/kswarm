import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
const target=new URL('../src/core/original-preparation-transport.js',import.meta.url).href;
// Node 22 eagerly initializes Undici's Wasm during Response lookup; newer
// Node may defer it until HTTP. These probes place genuine Native Wasm calls
// in that same SDK getter so the ownership contract is tested on both shapes.
const controlledLookup=`const actualResponse=globalThis.Response,fixtureBytes=new Uint8Array([0,97,115,109,1,0,0,0]);let fixtureModule;const sdkThen=Promise.prototype.then;Object.defineProperty(globalThis,'Response',{configurable:true,get(){const compiling=WebAssembly.compile(fixtureBytes);Reflect.apply(sdkThen,compiling,[value=>{fixtureModule=value;return WebAssembly.instantiate(value);}]);return actualResponse;}});`;

for(const sdk of ['compile','instantiate'])for(const empty of [false,true])test('original '+sdk+' SDK negative '+(empty?'undefined':'Error')+' cannot export a usable original module',()=>{
 const script=`${controlledLookup}const original=WebAssembly[${JSON.stringify(sdk)}],then=Promise.prototype.then;let first=true;const failure=${empty?'undefined':"Error('actual Native SDK rejection')"};WebAssembly[${JSON.stringify(sdk)}]=function(...args){const raw=Reflect.apply(original,this,args);if(!first||args[0]!==(${JSON.stringify(sdk)}==='compile'?fixtureBytes:fixtureModule))return raw;first=false;return Reflect.apply(then,raw,[()=>{throw failure;}]);};let refused=false;try{await import(${JSON.stringify(target)});}catch(error){if(error!==failure)throw Error('original SDK cause lost');refused=true;}if(!refused)throw Error('negative SDK exported usable module');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});assert.equal(child.signal,null);assert.equal(child.status,0,child.stderr);assert.equal(child.error,undefined);
});
test('original Response SDK constructor proxy is refused before descriptor traps',()=>{
 const script=`let traps=0;Object.defineProperty(globalThis,'Response',{configurable:true,value:new Proxy(function(){},{getOwnPropertyDescriptor(){traps++;return undefined;}})});let refused=false;try{await import(${JSON.stringify(target)});}catch(error){if(error?.message!=='ORIGINAL_RESPONSE_SDK_UNAVAILABLE')throw error;refused=true;}if(!refused||traps!==0)throw Error('constructor proxy traps='+traps);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});assert.equal(child.signal,null);assert.equal(child.status,0,child.stderr);assert.equal(child.error,undefined);
});
test('negative SDK startup joins a visible pre-existing cause Promise before its original error can leave',async t=>{
 const root=mkdtempSync(join(tmpdir(),'sdk-startup-cause-')),marker=join(root,'actual-native-negative');
 const script=`import {writeFileSync} from 'node:fs';${controlledLookup}const then=Promise.prototype.then,compile=WebAssembly.compile;let release,first=true;const failure=Error('actual Native failure with held original cause');failure.cause=new Promise(yes=>{release=yes;});process.stdin.on('data',()=>release());WebAssembly.compile=function(...args){const raw=Reflect.apply(compile,this,args);if(!first||args[0]!==fixtureBytes)return raw;first=false;return Reflect.apply(then,raw,[()=>{writeFileSync(${JSON.stringify(marker)},'1');throw failure;}]);};let result;try{await import(${JSON.stringify(target)});result='UNEXPECTED_EXPORT';}catch(error){result=error===failure?'ORIGINAL_CAUSE':'LOST_CAUSE';}process.stdout.write('SETTLED:'+result+'\\n');`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',value=>{output+=value;});child.stderr.on('data',value=>{output+=value;});const closed=new Promise(yes=>child.once('close',(code,signal)=>{console.log(JSON.stringify({test:'actual-sdk-startup-cause',pid:child.pid,code,signal,reaped:true,notWholeNativeProfile:true}));yes({code,signal});}));
 t.after(async()=>{child.stdin.end('release\n');if(child.exitCode===null&&child.signalCode===null){await Promise.race([closed,delay(1000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}await closed;rmSync(root,{recursive:true,force:true});});
 try{for(let n=0;n<200&&!existsSync(marker);n++)await delay(5);assert.equal(existsSync(marker),true,output);await delay(80);assert.equal(output.includes('SETTLED:'),false,output);}
 finally{child.stdin.write('release\n');}
 for(let n=0;n<200&&!output.includes('SETTLED:');n++)await delay(5);assert.ok(output.includes('SETTLED:ORIGINAL_CAUSE'),output);
});

test('fulfilled Native startup result retains its visible pre-existing sidecar Promise',async t=>{
 const root=mkdtempSync(join(tmpdir(),'sdk-startup-value-')),marker=join(root,'actual-native-result');
 const script=`import {writeFileSync} from 'node:fs';${controlledLookup}const then=Promise.prototype.then,instantiate=WebAssembly.instantiate;let release,first=true;const held=new Promise(yes=>{release=yes;});process.stdin.on('data',()=>release());WebAssembly.instantiate=function(...args){const raw=Reflect.apply(instantiate,this,args);if(!first||args[0]!==fixtureModule)return raw;first=false;return Reflect.apply(then,raw,[value=>{Object.defineProperty(value,Symbol('actual SDK sidecar'),{value:held});writeFileSync(${JSON.stringify(marker)},'1');return value;}]);};await import(${JSON.stringify(target)});process.stdout.write('KNOWN_RESULT\\n');`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',value=>{output+=value;});child.stderr.on('data',value=>{output+=value;});const closed=new Promise(yes=>child.once('close',(code,signal)=>{console.log(JSON.stringify({test:'actual-sdk-startup-value',pid:child.pid,code,signal,reaped:true,notWholeNativeProfile:true}));yes({code,signal});}));
 t.after(async()=>{child.stdin.end('release\n');if(child.exitCode===null&&child.signalCode===null){await Promise.race([closed,delay(1000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}await closed;rmSync(root,{recursive:true,force:true});});
 try{for(let n=0;n<200&&!existsSync(marker);n++)await delay(5);assert.equal(existsSync(marker),true,output);await delay(80);assert.equal(output.includes('KNOWN_RESULT'),false,output);}finally{child.stdin.write('release\n');}
 for(let n=0;n<200&&!output.includes('KNOWN_RESULT');n++)await delay(5);assert.ok(output.includes('KNOWN_RESULT'),output);
});

test('the original SDK method namespace keeps a visible pre-existing Promise sidecar',async t=>{
 const root=mkdtempSync(join(tmpdir(),'sdk-startup-method-'));
 const script=`let release;const held=new Promise(yes=>{release=yes;});Object.defineProperty(globalThis.Response.prototype.json,Symbol('original SDK method sidecar'),{value:held});process.stdin.on('data',()=>release());await import(${JSON.stringify(target)});process.stdout.write('KNOWN_METHOD\\n');`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',value=>{output+=value;});child.stderr.on('data',value=>{output+=value;});const closed=new Promise(yes=>child.once('close',(code,signal)=>{console.log(JSON.stringify({test:'actual-sdk-startup-method',pid:child.pid,code,signal,reaped:true,notWholeNativeProfile:true}));yes({code,signal});}));
 t.after(async()=>{child.stdin.end('release\n');if(child.exitCode===null&&child.signalCode===null){await Promise.race([closed,delay(1000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}await closed;rmSync(root,{recursive:true,force:true});});
 try{await delay(150);assert.equal(output.includes('KNOWN_METHOD'),false,output);}finally{child.stdin.write('release\n');}
 for(let n=0;n<200&&!output.includes('KNOWN_METHOD');n++)await delay(5);assert.ok(output.includes('KNOWN_METHOD'),output);
});

test('deep callable SDK namespace sidecars cannot escape before their actual held leaf',async t=>{
 const script=`let release;const held=new Promise(yes=>{release=yes;});let chain=function(){};chain.raw=held;for(let n=0;n<10000;n++){const parent=function(){};parent.next=chain;chain=parent;}Object.defineProperty(globalThis.Response.prototype.json,Symbol('deep actual SDK sidecar'),{value:chain});process.stdin.on('data',()=>release());try{await import(${JSON.stringify(target)});process.stdout.write('SETTLED_OK\\n');}catch(error){process.stdout.write('SETTLED_REJECT\\n');}`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',value=>{output+=value;});child.stderr.on('data',value=>{output+=value;});const closed=new Promise(yes=>child.once('close',(code,signal)=>{console.log(JSON.stringify({test:'actual-sdk-startup-deep',pid:child.pid,code,signal,reaped:true,notWholeNativeProfile:true}));yes({code,signal});}));
 t.after(async()=>{child.stdin.end('release\n');if(child.exitCode===null&&child.signalCode===null){await Promise.race([closed,delay(1000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}await closed;});
 try{await delay(200);assert.equal(output.includes('SETTLED_'),false,output);}finally{child.stdin.write('release\n');}
 for(let n=0;n<400&&!output.includes('SETTLED_');n++)await delay(5);assert.ok(output.includes('SETTLED_OK'),output);
});

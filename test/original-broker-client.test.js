import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOriginalBrokerClient,originalBrokerClientMatchesSource} from '../src/core/original-broker-client.js';
test('original Net construction closes options before touching getters or proxy traps',()=>{
 let reads=0;const bad=Object.defineProperty({},'preparationSource',{enumerable:true,get(){reads++;throw Error('forbidden');}});
 const proxy=new Proxy({},{get(){reads++;throw Error('forbidden');},ownKeys(){reads++;throw Error('forbidden');}});
 for(const options of [bad,proxy])assert.throws(()=>createOriginalBrokerClient(options));assert.equal(reads,0);
});
test('the original client fixes its three preparation methods and never brands copies',()=>{
 const source=Object.freeze({}),methods={sendDefaultDispatchPreparation(){},sealDefaultDispatchPreparations(){},drainDefaultDispatchPreparations(){},legacy(){}};
 const client=createOriginalBrokerClient({preparationSource:source,methods});assert.equal(originalBrokerClientMatchesSource(client,source),true);assert.equal(originalBrokerClientMatchesSource({...client},source),false);assert.equal(originalBrokerClientMatchesSource(new Proxy(client,{}),source),false);
 assert.throws(()=>{client.sendDefaultDispatchPreparation=()=>{};},TypeError);assert.throws(()=>Object.defineProperty(client,'drainDefaultDispatchPreparations',{value(){}}),TypeError);client.legacy=()=>true;assert.equal(client.legacy(),true);
});

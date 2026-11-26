import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaultDispatchActionRecord,captureDefaultDispatchActionRecord} from '../src/core/default-dispatch-action-data.js';
const golden=JSON.parse(readFileSync(new URL('./fixtures/default-dispatch-action-golden.json',import.meta.url),'utf8'));
test('canonical action data matches an actual original Main A producer byte for byte',()=>{
 assert.deepEqual(defaultDispatchActionRecord(golden.observation),golden.fact);assert.deepEqual(captureDefaultDispatchActionRecord(golden.fact),golden.fact);
});
test('action metadata cannot wash a changed field, hash, version or extra key',()=>{
 for(const mutation of [{...golden.fact,payloadHash:'0'.repeat(64)},{...golden.fact,actorId:'agent:po'},{...golden.fact,actionId:'main-default-dispatch:'+'0'.repeat(64)},{...golden.fact,planRevision:3},{...golden.fact,schemaVersion:2},{...golden.fact,grant:true}])assert.throws(()=>captureDefaultDispatchActionRecord(mutation));
});
test('data capture rejects accessors and malformed scope without invoking hooks',()=>{
 let getters=0;const value={...golden.fact};Object.defineProperty(value,'taskSetDigest',{enumerable:true,get(){getters++;throw Error('forbidden fact getter');}});assert.throws(()=>captureDefaultDispatchActionRecord(value));assert.equal(getters,0);
 for(const value of [{...golden.observation,scope:{...golden.observation.scope,extra:true}},{...golden.observation,dispatchGeneration:0},{...golden.observation,bindingDigest:{}},{...golden.observation,taskSetDigest:[]}])assert.throws(()=>defaultDispatchActionRecord(value));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureObservationRow,captureObservationRows,captureObservationComposite} from '../src/core/observation-data.js';
test('readonly aggregates join independently bounded rows without relaxing the original per-row encoded limit',()=>{
 const rows=captureObservationRows([{text:'x'.repeat(5*1024*1024)},{text:'y'.repeat(5*1024*1024)}]),view=captureObservationComposite({rows});assert.equal(view.rows,rows);assert.equal(Object.isFrozen(view),true);assert.ok(Buffer.byteLength(JSON.stringify(view))>8388608);assert.throws(()=>captureObservationRow({text:'\u0000'.repeat(2*1024*1024)}),/CONTENT_UNAVAILABLE/);
});
test('both raw-row and aggregate paths reject accessors proxies sparse arrays functions symbols and cycles without invoking hooks',()=>{
 let reads=0;const getter={};Object.defineProperty(getter,'field',{enumerable:true,get(){reads++;return'bad';}});const proxy=new Proxy({},{ownKeys(){reads++;return[];}});
 for(const value of [getter,proxy]){assert.throws(()=>captureObservationRows([value]));assert.throws(()=>captureObservationComposite(value));}assert.equal(reads,0);const sparse=new Array(2);assert.throws(()=>captureObservationRows(sparse));assert.throws(()=>captureObservationComposite(sparse));for(const value of [{fn(){}},{symbol:Symbol('x')}])assert.throws(()=>captureObservationComposite(value));const cycle={};cycle.self=cycle;assert.throws(()=>captureObservationComposite(cycle));
});
test('known immutable data does not bypass the inherited serializer-hook gate',()=>{
 const row=captureObservationRow({nested:{text:'original'}});let calls=0;Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){calls++;return{};}});try{assert.throws(()=>captureObservationComposite(row));assert.throws(()=>captureObservationRows([row]));assert.equal(calls,0);}finally{delete Object.prototype.toJSON;}
});

test('many independently closed view rows do not consume one aggregate structure budget',()=>{
 const rows=Array.from({length:10000},(_,id)=>({id,labels:Array.from({length:20},(_,key)=>'value-'+key)}));assert.throws(()=>captureObservationComposite(rows));const views=rows.map(row=>captureObservationComposite(row)),joined=captureObservationComposite(views);assert.equal(joined.length,10000);assert.equal(Object.isFrozen(joined),true);assert.equal(Object.isFrozen(joined[9999]),true);
});

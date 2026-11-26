import assert from 'node:assert/strict';
import { test, mock, afterEach } from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
let factory = fs.createWriteStream;
mock.module('node:fs', { namedExports: { mkdirSync: fs.mkdirSync, readdirSync: fs.readdirSync, readFileSync: fs.readFileSync, statSync: fs.statSync, unlinkSync: fs.unlinkSync, existsSync: fs.existsSync, createWriteStream: (...args) => factory(...args) } });
const { createEventLog } = await import('../src/core/event-log.js');
const roots = [];
function setup() {
 const root = fs.mkdtempSync(join(tmpdir(), 'kswarm-close-')); roots.push(root);
 const streams = []; factory = () => { const stream = new EventEmitter(); stream.writableEnded = false; stream.write = () => true; stream.end = callback => { stream.writableEnded = true; callback?.(); }; stream.destroy = () => {}; streams.push(stream); return stream; };
 return { root, streams, log: createEventLog({ logDir: root, silent: true }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
afterEach(() => { mock.timers.reset(); factory = fs.createWriteStream; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test('close caches, seals saved emit before getters, and waits close beyond end callback', async () => {
 const { log, streams } = setup(); log.emit('before'); const emit = log.emit;
 const closing = log.close(); let settled = false; closing.then(() => { settled = true; });
 assert.equal(log.close(), closing); const count = log.getEvents().length;
 assert.throws(() => emit('late', { get payload() { throw Error('getter touched'); } }), /event_log_closed/);
 assert.equal(log.getEvents().length, count); await tick(); assert.equal(settled, false);
 streams[0].emit('finish'); await tick(); assert.equal(settled, false);
 streams[0].emit('close'); await closing; assert.equal(settled, true);
});

test('day rollover keeps the old stream until its actual close', async () => {
 mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 1).getTime() });
 const { log, streams } = setup(); log.emit('day-one');
 mock.timers.setTime(new Date(2026, 0, 2).getTime()); log.emit('day-two'); assert.equal(streams.length, 2);
 const closing = log.close(); let settled = false; closing.then(() => { settled = true; });
 streams[1].emit('close'); await tick(); assert.equal(settled, false);
 streams[0].emit('close'); await closing;
});

for (const phase of ['open', 'write', 'rotation-end', 'close-end', 'destroy', 'event']) test(`retains ${phase} failure until all streams close`, async () => {
 mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 1).getTime() });
 const { log, streams } = setup(), failure = Error(phase);
 if (phase === 'open') factory = () => { throw failure; };
 log.emit('one');
 if (phase === 'write') { streams[0].write = () => { throw failure; }; log.emit('two'); }
 if (phase === 'rotation-end') {
  streams[0].end = () => { throw failure; }; mock.timers.setTime(new Date(2026, 0, 2).getTime()); log.emit('next-day');
 }
 if (phase === 'close-end' || phase === 'destroy') streams[0].end = () => { throw failure; };
 if (phase === 'destroy') streams[0].destroy = () => { throw Error('destroy failure'); };
 if (phase === 'event') { streams[0].emit('error', failure); streams[0].emit('close'); }
 const closing = log.close(); const rejected = assert.rejects(closing, error => error instanceof AggregateError && error.errors.includes(failure) && (phase !== 'destroy' || error.errors.some(item => item.message === 'destroy failure')));
 await tick(); for (const stream of streams) stream.emit('close'); await rejected;
 assert.equal(log.close(), closing);
});

test('close waits queued ready invocation but does not await external returned work', async () => {
 const { log } = setup(); await new Promise(resolve => log.onReady(resolve));
 let called = false, release; const external = new Promise(resolve => { release = resolve; });
 log.onReady(() => { called = true; return external; });
 const closing = log.close(); await closing; assert.equal(called, true);
 assert.throws(() => log.onReady(() => {}), /event_log_closed/); release();
 assert.throws(() => log.emit('late'), /event_log_closed/);
});

test('pre-replay ready callback returning close does not deadlock', async () => {
 const { log } = setup(); let fromCallback;
 log.onReady(() => { fromCallback = log.close(); return fromCallback; });
 const closing = log.close(); await closing; assert.equal(fromCallback, closing);
});

test('real filesystem stream drains all bytes and does not reopen', async () => {
 const { log, root } = setup(); factory = fs.createWriteStream;
 log.emit('actual', { projectId: 'p', message: 'tail' }); await log.close();
 const files = fs.readdirSync(root); assert.equal(files.length, 1); const bytes = fs.readFileSync(join(root, files[0]), 'utf8');
 assert.equal(JSON.parse(bytes).message, 'tail'); assert.throws(() => log.emit('late'), /event_log_closed/);
 assert.equal(fs.readFileSync(join(root, files[0]), 'utf8'), bytes);
});

test('ready callback may initiate the first close and return that same promise', async () => {
 const { log } = setup(); let notify; const called = new Promise(resolve => { notify = resolve; }); let closing;
 log.onReady(() => { closing = log.close(); notify(); return closing; });
 await called; await closing; assert.equal(log.close(), closing);
});

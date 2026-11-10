import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServerWorkerLifetime } from '../src/server/server-worker-lifetime.js';

test('actual owned direct child is closed before drain resolves', async () => {
  const owner = createServerWorkerLifetime();
  const child = owner.spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data'); let closed = false;
  child.once('close', () => { closed = true; });
  const closing = owner.close(); assert.strictEqual(owner.close(), closing);
  await closing; assert.equal(closed, true);
  assert.throws(() => owner.spawn(process.execPath, ['-e', '']), /server_shutting_down/);
});
test('missing executable child without pid still drains actual close', async () => {
  const owner = createServerWorkerLifetime();
  const child = owner.spawn('/nonexistent-kswarm-test-executable', []);
  let closed = false; child.once('close', () => { closed = true; });
  await owner.close(); assert.equal(closed, true);
});
test('signal exception remains failure after actual close and siblings close', async () => {
  const owner = createServerWorkerLifetime();
  const child = owner.spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  const sibling = owner.spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  await Promise.all([once(child.stdout, 'data'), once(sibling.stdout, 'data')]);
  const realKill = child.kill.bind(child);
  child.kill = signal => { if (signal === 'SIGTERM') throw new Error('test TERM failure'); return realKill(signal); };
  let siblingClosed = false; sibling.once('close', () => { siblingClosed = true; });
  await assert.rejects(owner.close(), error => error.errors.some(item => item.message === 'test TERM failure'));
  assert.equal(siblingClosed, true);
});

test('false TERM result remains failure even if child subsequently closes', async () => {
  const owner = createServerWorkerLifetime();
  const child = owner.spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data'); const realKill = child.kill.bind(child);
  child.kill = signal => { if (signal === 'SIGTERM') { setImmediate(() => realKill('SIGTERM')); return false; } return realKill(signal); };
  await assert.rejects(owner.close(), error => error.errors.some(item => item.code === 'child_signal_failed'));
});

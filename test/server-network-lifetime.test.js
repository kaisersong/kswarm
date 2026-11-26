import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { createServerNetworkLifetime } from '../src/server/server-network-lifetime.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('actual half request and websocket close before network drain resolves', { timeout: 5_000 }, async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const wss = new WebSocketServer({ server });
  const owner = createServerNetworkLifetime(server, wss);
  owner.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const socket = net.connect(port, '127.0.0.1'); await once(socket, 'connect');
  socket.resume();
  socket.write('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10000\r\n\r\nx');
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); await once(ws, 'open');
  const wsClosed = once(ws, 'close'), socketClosed = once(socket, 'close');
  const closing = owner.close(); assert.strictEqual(owner.close(), closing);
  await closing; await wsClosed; await socketClosed;
  assert.equal(server.listening, false);
});
test('actual delayed listen attempt cannot be confirmed closed early', { timeout: 5_000 }, async () => {
  const server = http.createServer(); const wss = new WebSocketServer({ server });
  const realListen = server.listen.bind(server); let release;
  server.listen = (...args) => { release = () => realListen(...args); return server; };
  const owner = createServerNetworkLifetime(server, wss);
  owner.listen(0, '127.0.0.1');
  let closed = false; const closing = owner.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  release(); await closing; assert.equal(server.listening, false);
});
test('closed network owner cannot start a later listener', { timeout: 5_000 }, async () => {
  const server = http.createServer(); const wss = new WebSocketServer({ server });
  const owner = createServerNetworkLifetime(server, wss);
  await owner.close(); assert.throws(() => owner.listen(0), /server_shutting_down/);
});

test('a thrown close call stays unconfirmed until the actual listener closes', { timeout: 5_000 }, async () => {
  const server = http.createServer(); const wss = new WebSocketServer({ server });
  const owner = createServerNetworkLifetime(server, wss);
  owner.listen(0, '127.0.0.1'); await once(server, 'listening');
  const realClose = server.close.bind(server);
  server.close = () => { throw new Error('close failed'); };
  const closing = owner.close(); let settled = false;
  closing.then(() => { settled = true; }, () => { settled = true; });
  await tick(); assert.equal(settled, false); assert.equal(server.listening, true);
  realClose(); await assert.rejects(closing, error => error.errors.some(item => item.message === 'close failed'));
});

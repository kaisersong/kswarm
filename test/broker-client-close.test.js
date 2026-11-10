import assert from 'node:assert/strict';
import { test, mock, afterEach } from 'node:test';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import RealWebSocket, { WebSocketServer } from 'ws';
const sockets = []; let realSockets = false;
class Socket extends EventEmitter {
 static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
 constructor(...args) { super(); if (realSockets) return new RealWebSocket(...args); this.readyState = 0; this.closes = 0; this.terminations = 0; sockets.push(this); }
 open() { this.readyState = 1; this.emit('open'); }
 close() { this.closes++; this.readyState = 2; }
 terminate() { this.terminations++; this.readyState = 2; }
 endClose() { this.readyState = 3; this.emit('close'); }
}
mock.module('ws', { defaultExport: Socket });
const { createBrokerClient } = await import('../src/net/broker-client.js');
const clients = []; const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(extra = {}) {
 const fetches = []; const client = createBrokerClient({ participantId: 'test', silent: true, roomSystemToken: 'test-token', fetchImpl: async (...args) => { fetches.push(args); return { json: async () => ({ ok: true }) }; }, ...extra });
 clients.push(client); return { client, fetches };
}
afterEach(async () => { for (const socket of sockets) socket.endClose(); for (const client of clients.splice(0)) await client.close?.().catch(() => {}); sockets.length = 0; realSockets = false; mock.timers.reset(); });

test('manual disconnect does not reschedule reconnect and explicit connect still works', async () => {
 mock.timers.enable({ apis: ['setTimeout'] }); const { client } = setup(); const first = client.connect(); sockets[0].open(); await first;
 client.disconnect(); sockets[0].endClose(); mock.timers.tick(5000); assert.equal(sockets.length, 1);
 const next = client.connect(); sockets[1].open(); assert.equal(await next, true);
 const closing = client.close(); sockets[1].endClose(); await closing;
});

test('connecting close settles original connect only after observing actual socket close', async () => {
 const { client } = setup(); const connecting = client.connect(); const closing = client.close();
 assert.equal(client.close(), closing); let settled = false; closing.then(() => { settled = true; });
 await tick(); assert.equal(settled, false); assert.equal(sockets[0].terminations, 1);
 sockets[0].endClose(); assert.equal(await connecting, false); await closing;
});

test('duplicate connect reuses handshake and old closing socket cannot alter new state', async () => {
 const { client } = setup(); const first = client.connect(), duplicate = client.connect(); assert.equal(sockets.length, 1);
 client.disconnect(); const next = client.connect(); assert.equal(sockets.length, 2); sockets[1].open(); await next;
 sockets[0].open(); sockets[0].endClose(); assert.equal(client.isConnected(), true); assert.equal(await first, false); assert.equal(await duplicate, false);
 const closing = client.close(); sockets[1].endClose(); await closing;
});

test('permanent close waits every historical socket', async () => {
 const { client } = setup(); const first = client.connect(); sockets[0].open(); await first; client.disconnect();
 const second = client.connect(); sockets[1].open(); await second;
 const closing = client.close(); let settled = false; closing.then(() => { settled = true; });
 sockets[1].endClose(); await tick(); assert.equal(settled, false); sockets[0].endClose(); await closing;
});

test('a socket already closing gets terminate watchdog but timeout does not confirm close', async () => {
 mock.timers.enable({ apis: ['setTimeout'] }); const { client } = setup(); const connecting = client.connect(); sockets[0].open(); await connecting;
 client.disconnect(); const closing = client.close(); let settled = false; closing.then(() => { settled = true; });
 mock.timers.tick(1000); await tick(); assert.equal(sockets[0].terminations, 1); assert.equal(settled, false);
 sockets[0].endClose(); await closing;
});

test('all async entrances reject before reading saved late inputs', async () => {
 const { client, fetches } = setup(); const methods = ['register','connect','sendIntent','sendTo','readInbox','getRoomSnapshot','acquireRoomMembershipLease','publishRoomProjectEvent','verifyWorkspaceMappingTicket','verifyWorkspaceClaim','verifyWorkspaceCommitTicket','workspaceMappingApplied','workspaceMappingRejected','httpPost','httpGet'];
 const saved = methods.map(name => client[name]); await client.close(); let reads = 0;
 const input = new Proxy({}, { get() { reads++; throw Error('input read'); } });
 for (const method of saved) await assert.rejects(method(input, input, input), /broker_client_closed/);
 assert.equal(reads, 0); assert.equal(fetches.length, 0); assert.equal(sockets.length, 0); assert.equal(client.isConnected(), false);
});

test('reentrant serialization closes admission before fetch', async () => {
 const { client, fetches } = setup(); let closing;
 const request = client.httpPost('/test', { toJSON() { closing = client.close(); return { x: 1 }; } });
 await assert.rejects(request, /broker_client_closed/); await closing; assert.equal(fetches.length, 0);
});

test('response body already running remains owned after abort until it really settles', async () => {
 let release, enter; const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
 const { client } = setup({ fetchImpl: async () => ({ json: async () => { enter(); await held; return { ok: true }; } }) });
 const reading = client.httpGet('/test'); await entered; const closing = client.close(); let settled = false; closing.then(() => { settled = true; });
 await tick(); assert.equal(settled, false); release(); await reading; await closing;
});

test('signal invocation failure is retained while sibling sockets still drain', async () => {
 const { client } = setup(); const first = client.connect(); sockets[0].open(); await first; client.disconnect();
 const second = client.connect(); sockets[1].open(); await second; sockets[1].close = () => { throw Error('socket close failure'); };
 const closing = client.close(); const rejected = assert.rejects(closing, /broker_client_close_unconfirmed/);
 sockets[1].endClose(); await tick(); sockets[0].endClose(); await rejected;
});

test('real local HTTP and websocket observe permanent close', async () => {
 realSockets = true; const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
 const wss = new WebSocketServer({ server }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const peerReady = once(wss, 'connection'); const { client } = setup({ brokerUrl: `http://127.0.0.1:${server.address().port}`, fetchImpl: fetch });
 try { await client.register(); assert.equal(await client.connect(), true); const [peer] = await peerReady; const closed = once(peer, 'close'); await client.close(); await closed; assert.equal(client.isConnected(), false); }
 finally { for (const peer of wss.clients) peer.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); }
});

test('abort listener observes isConnected false synchronously during close', async () => {
 let seen, client;
 ({ client } = setup({ fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { seen = client.isConnected(); reject(init.signal.reason); }, { once: true })) }));
 const connect = client.connect(); sockets[0].open(); await connect;
 const request = client.httpGet('/held'); const failed = assert.rejects(request, /closed/);
 const closing = client.close(); assert.equal(seen, false); sockets[0].endClose(); await failed; await closing;
});

test('naturally scheduled and already-triggered reconnect cannot revive a permanently closed client', async () => {
 mock.timers.enable({ apis: ['setTimeout'] }); const { client } = setup();
 const connected = client.connect(); sockets[0].open(); await connected; sockets[0].endClose();
 mock.timers.tick(2000); assert.equal(sockets.length, 2);
 const closing = client.close(); sockets[1].endClose(); await closing; mock.timers.tick(10000); assert.equal(sockets.length, 2);
});

test('a socket entering CLOSING independently still gets the close watchdog', async () => {
 mock.timers.enable({ apis: ['setTimeout'] }); const { client } = setup(); const connected = client.connect(); sockets[0].open(); await connected;
 sockets[0].readyState = Socket.CLOSING; const closing = client.close();
 mock.timers.tick(1000); assert.equal(sockets[0].terminations, 1); sockets[0].endClose(); await closing;
});

test('fetch resolution is still awaited after seal without faking cancellation', async () => {
 let release; const held = new Promise(resolve => { release = resolve; }); const { client } = setup({ fetchImpl: () => held });
 const work = client.httpGet('/held'); const closing = client.close(); let settled = false; closing.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
 release({ json: async () => ({ ok: true }) }); await work; await closing;
});

for (const phase of ['fetch', 'json']) test(`${phase} rejection is settled business failure without skipping socket close`, async () => {
 const { client } = setup({ fetchImpl: async () => { if (phase === 'fetch') throw Error('request failed'); return { json: async () => { throw Error('request failed'); } }; } });
 const connected = client.connect(); sockets[0].open(); await connected;
 await assert.rejects(client.httpGet('/fail'), /request failed/); const closing = client.close(); let settled = false; closing.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
 sockets[0].endClose(); await closing;
});

test('CONNECTING terminate throw does not skip the older closing sibling', async () => {
 const { client } = setup(); const first = client.connect(); sockets[0].open(); await first; client.disconnect();
 const next = client.connect(); sockets[1].terminate = () => { throw Error('terminate failed'); };
 const closing = client.close(); const failed = assert.rejects(closing, error => error instanceof AggregateError && error.errors.some(item => item.message === 'terminate failed'));
 sockets[1].endClose(); await next; sockets[0].endClose(); await failed;
});

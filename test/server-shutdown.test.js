import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { createAgentStore } from '../src/core/agent-store.js';
import { createHub } from '../src/core/hub.js';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(t, { monitor = false, brokerUrl, preload = null, env = {}, waitReady = true, initialize = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kswarm-shutdown-'));
  const free = net.createServer(); free.listen(0, '127.0.0.1'); await once(free, 'listening');
  const port = free.address().port; await new Promise(resolve => free.close(resolve));
  initialize?.(root);
  const accountPath=join(root,'account.mjs');
  writeFileSync(accountPath,`import os from 'node:os';import{mkdirSync}from'node:fs';import{join}from'node:path';import{syncBuiltinESMExports}from'node:module';const root=${JSON.stringify(root)},original=os.userInfo;mkdirSync(join(root,'config'),{mode:0o700});os.homedir=()=>root;os.userInfo=options=>{const info=original(options);return {...info,homedir:Buffer.isBuffer(info.homedir)?Buffer.from(root):root};};syncBuiltinESMExports();`);
  const args = ['--import',accountPath];
  if (monitor) {
    const path = join(root, 'monitor.mjs');
    writeFileSync(path, `import http from 'node:http';\nimport { DatabaseSync } from 'node:sqlite';\nimport { appendFileSync,existsSync,realpathSync } from 'node:fs';\nconst stateFile=${JSON.stringify(join(root, 'data/state.sqlite'))};\nconst prepare=DatabaseSync.prototype.prepare;\nconst marker=${JSON.stringify(join(root, 'observations'))};\nlet active=0;const emit=http.Server.prototype.emit;http.Server.prototype.emit=function(event,...args){if(event==='request'){active++;args[1].once('close',()=>active--);}return emit.call(this,event,...args);};\nconst close=DatabaseSync.prototype.close;DatabaseSync.prototype.close=function(...args){const errors=[];let result;try{const file=prepare.call(this,'PRAGMA database_list').all().find(row=>row.name==='main')?.file;if(file&&existsSync(stateFile)&&realpathSync(file)===realpathSync(stateFile))appendFileSync(marker,'sqlite-close-active='+active+'\\n');}catch(raw){errors.push(raw);}try{result=close.apply(this,args);}catch(raw){errors.push(raw);}if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'monitor_close_failed',{cause:errors[0]});return result;};`);
    args.push('--import', path);
  }
  if (preload) { const path = join(root, 'fault.mjs'); writeFileSync(path, preload(root)); args.push('--import', path); }
  const child = spawn(process.execPath, [...args, 'src/server/index.js'], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, XIAOK_CONFIG_DIR:join(root,'config'), KSWARM_DATA_ROOT: join(root, 'data'), KSWARM_PORT: String(port), BROKER_URL: brokerUrl || 'http://127.0.0.1:9', KSWARM_DESKTOP_MUTATION_TOKEN: 'shutdown-test-token', ...env },
  });
  let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  if (!waitReady) return { child, closed, root, port, url, output: () => output };
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { const response = await fetch(`${url}/health`); await response.text(); if (response.ok) return { child, closed, root, port, url, output: () => output }; } catch {}
    await delay(30);
  }
  throw new Error(`startup timeout ${output}`);
}
test('actual partial POST is drained before SQLite closes', { timeout: 10_000 }, async t => {
  const fixture = await start(t, { monitor: true });
  const socket = net.connect(fixture.port, '127.0.0.1'); socket.resume(); t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('POST /projects HTTP/1.1\r\nHost: localhost\r\nx-kswarm-mutation-token: shutdown-test-token\r\nContent-Length: 10000\r\n\r\n{"name":');
  await delay(75); fixture.child.kill('SIGTERM');
  const [code, signal] = await fixture.closed; assert.equal(signal, null); assert.equal(code, 0, fixture.output());
  const facts = readFileSync(join(fixture.root, 'observations'), 'utf8');
  assert.match(facts, /sqlite-close-active=0/); assert.doesNotMatch(facts, /sqlite-close-active=[1-9]/);
});
test('actual successful project and event tail survive normal shutdown', { timeout: 10_000 }, async t => {
  const fixture = await start(t);
  const response = await fetch(`${fixture.url}/projects`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kswarm-mutation-token': 'shutdown-test-token' }, body: JSON.stringify({ name: 'Shutdown persistence', goal: 'Save tail', poAgent: 'xiaok-po', autoStartPlanning: false, members: [] }) });
  const created = await response.json(); assert.equal(response.status, 201, JSON.stringify(created));
  fixture.child.kill('SIGTERM'); const [code] = await fixture.closed; assert.equal(code, 0, fixture.output());
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(fixture.root, 'data/state.sqlite'), { readOnly: true });
  try { assert.ok(db.prepare("SELECT count(*) AS n FROM state_entities WHERE collection = 'project'").get().n > 0); } finally { db.close(); }
  const events = readdirSync(join(fixture.root, 'data/events')).filter(name => name.endsWith('.ndjson')).flatMap(name => readFileSync(join(fixture.root, 'data/events', name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  assert.ok(events.some(event => event.type === 'project.created'));
  assert.doesNotMatch(fixture.output(), /server_shutting_down.*runtime_offline|Persistence commit failed/);
});

async function broker(t, handler) {
  const server = http.createServer(handler);
  const wss = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, wss, url: `http://127.0.0.1:${server.address().port}` };
}
test('pending registration body is actually aborted before clean server exit', { timeout: 10_000 }, async t => {
  let entered; const pending = new Promise(resolve => { entered = resolve; });
  let connectionClosed; const closed = new Promise(resolve => { connectionClosed = resolve; });
  const local = await broker(t, (req, res) => {
    if (req.url === '/participants/register') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
      res.on('close', connectionClosed); entered();
    } else res.end('{}');
  });
  const fixture = await start(t, { brokerUrl: local.url }); await pending;
  fixture.child.kill('SIGTERM'); const [code] = await fixture.closed; await closed;
  assert.equal(code, 0, fixture.output());
  assert.doesNotMatch(fixture.output(), /Broker registration\/connect failed.*closed|unconfirmed/);
});
test('SIGTERM during real planning fetch does not persist blocked preparation', { timeout: 10_000 }, async t => {
  let entered; const pending = new Promise(resolve => { entered = resolve; });
  const local = await broker(t, (req, res) => {
    if (req.url === '/participants') { entered(); return; }
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  const fixture = await start(t, { brokerUrl: local.url });
  const request = fetch(`${fixture.url}/projects`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kswarm-mutation-token': 'shutdown-test-token' }, body: JSON.stringify({ name: 'Cancelled planning', poAgent: 'test-po-notinstalled', members: [], autoStartPlanning: false }) });
  await pending; fixture.child.kill('SIGTERM');
  const response = await request; assert.equal(response.status, 503); await response.text();
  const [code] = await fixture.closed; assert.equal(code, 0, fixture.output());
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(fixture.root, 'data/state.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare("SELECT state_json FROM state_entities WHERE collection = 'project'").all();
    assert.equal(rows.length, 1); assert.equal(JSON.parse(rows[0].state_json).preparation, null);
  } finally { db.close(); }
  assert.doesNotMatch(fixture.output(), /Failed to send request_task|Workflow node handoff delivery failed|readiness_probe_send_failed|server_shutting_down.*offline/);
});
test('background broker mutation COMMIT failure locks exit 75 without HTTP failure', { timeout: 10_000 }, async t => {
  const local = await broker(t, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{}'); });
  const connected = once(local.wss, 'connection');
  const fixture = await start(t, { brokerUrl: local.url, preload: root => `import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
const marker=${JSON.stringify(join(root, 'fail-commit'))};
const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql,...args){if(sql==='COMMIT'&&existsSync(marker))throw new Error('injected real SQLite COMMIT failure');return exec.call(this,sql,...args);};` });
  const [socket] = await connected;
  writeFileSync(join(fixture.root, 'fail-commit'), '1');
  socket.send(JSON.stringify({ type: 'new_intent', event: { kind: 'workflow_node_failed', fromParticipantId: 'test-worker', payload: { projectId: 'missing-project', workflowRunId: 'missing-run', nodeId: 'missing-node' } } }));
  const [code] = await fixture.closed; assert.equal(code, 75, fixture.output());
  assert.match(fixture.output(), /Fail-stop: exiting with code 75/);
  assert.doesNotMatch(fixture.output(), /API error|shutdown resources settled.*"code":0/);
});

test('ordinary IO error concurrent with shutdown remains in actual diagnostics', { timeout: 10_000 }, async t => {
  let entered; const pending = new Promise(resolve => { entered = resolve; });
  const local = await broker(t, (req, res) => { if (req.url === '/participants') { entered(); return; } res.end('{}'); });
  const fixture = await start(t, { brokerUrl: local.url, preload: () => `const realFetch=globalThis.fetch;globalThis.fetch=(url,init)=>realFetch(url,init).catch(error=>{if(String(url).endsWith('/participants')&&init?.signal?.aborted)throw new Error('late_original_io_error');throw error;});` });
  const request = fetch(`${fixture.url}/participants`); await pending; fixture.child.kill('SIGTERM');
  const response = await request; await response.text(); await fixture.closed;
  assert.match(fixture.output(), /late_original_io_error/);
});

test('actual main waits for delayed native listen before acknowledging shutdown', { timeout: 10_000 }, async t => {
  const fixture = await start(t, { waitReady: false, preload: root => `import http from 'node:http';
import { appendFileSync } from 'node:fs';
const marker=${JSON.stringify(join(root, 'listen-facts'))};
const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(...args){appendFileSync(marker,'attempt\\n');this.once('listening',()=>appendFileSync(marker,'listening\\n'));this.once('close',()=>appendFileSync(marker,'closed\\n'));setTimeout(()=>listen.apply(this,args),250);return this;};` });
  for (let n = 0; n < 100; n++) { try { if (readFileSync(join(fixture.root, 'listen-facts'), 'utf8').includes('attempt')) break; } catch {} await delay(10); }
  fixture.child.kill('SIGTERM'); const [code] = await fixture.closed; assert.equal(code, 0, fixture.output());
  assert.equal(readFileSync(join(fixture.root, 'listen-facts'), 'utf8'), 'attempt\nlistening\nclosed\n');
  assert.doesNotMatch(fixture.output(), /Connected to intent-broker|KSwarm API server started/);
});
test('unconfirmed actual listener close forces 70 and never closes SQLite early', { timeout: 10_000 }, async t => {
  const fixture = await start(t, { monitor: true, preload: () => `import http from 'node:http';http.Server.prototype.close=function(){throw new Error('actual listener close failure');};` });
  fixture.child.kill('SIGTERM'); const [code] = await fixture.closed; assert.equal(code, 70, fixture.output());
  assert.match(fixture.output(), /shutdown unconfirmed/);
  assert.throws(() => readFileSync(join(fixture.root, 'observations')), { code: 'ENOENT' });
});
test('background commit failure keeps 75 with simultaneous SIGTERM and unclosed listener', { timeout: 10_000 }, async t => {
  const local = await broker(t, (_req, res) => res.end('{}')); const connected = once(local.wss, 'connection');
  const fixture = await start(t, { brokerUrl: local.url, preload: root => `import http from 'node:http';import { DatabaseSync } from 'node:sqlite';import { existsSync } from 'node:fs';
http.Server.prototype.close=function(){return this;};const marker=${JSON.stringify(join(root, 'fail-commit'))};const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql,...args){if(sql==='COMMIT'&&existsSync(marker)){process.kill(process.pid,'SIGTERM');throw new Error('commit failure concurrent signal');}return exec.call(this,sql,...args);};` });
  const [socket] = await connected; writeFileSync(join(fixture.root, 'fail-commit'), '1');
  const began = Date.now();
  socket.send(JSON.stringify({ type: 'new_intent', event: { kind: 'workflow_node_failed', payload: { projectId: 'absent', workflowRunId: 'absent', nodeId: 'absent' } } }));
  const [code] = await fixture.closed; assert.equal(code, 75, fixture.output());
  assert.ok(Date.now() - began < 2_000, fixture.output());
  assert.match(fixture.output(), /Fail-stop: exiting with code 75/);
});

test('three reachable worker spawn routes own real children; pooled desktop seeds remain refused', { timeout: 10_000 }, async t => {
  const fixture = await start(t, {
    initialize: root => {
      const store = createAgentStore({ filePath: join(root, '.kswarm/agents.json') });
      for (const id of ['adapter-start', 'adapter-auto']) {
        assert.equal(store.create({ id, name: id, runtimeType: 'xiaok', runtimeSource: 'local-cli', runtimePath: '/unused/test-adapter', execution: { mode: 'self_running', participantId: id } }).ok, true);
      }
    },
    preload: root => `import childProcess from 'node:child_process';import { syncBuiltinESMExports } from 'node:module';import { appendFileSync } from 'node:fs';
const marker=${JSON.stringify(join(root, 'spawn-facts'))};const spawn=childProcess.spawn;childProcess.spawn=function(command,args,options){if(String(args?.[0]).endsWith('/scripts/auto-worker.js')){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);appendFileSync(marker,JSON.stringify({event:'spawn',id:args[1],pid:child.pid})+'\\n');child.once('close',()=>appendFileSync(marker,JSON.stringify({event:'close',id:args[1],pid:child.pid})+'\\n'));return child;}return spawn(command,args,options);};syncBuiltinESMExports();`,
  });
  async function post(path, body) {
    const response = await fetch(`${fixture.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kswarm-mutation-token': 'shutdown-test-token' }, body: JSON.stringify(body) });
    const result = await response.json(); return { status: response.status, result };
  }
  assert.equal((await post('/spawn-worker', { workerId: 'legacy-worker' })).status, 201);
  assert.equal((await post('/agents/adapter-start/start', {})).status, 201);
  assert.equal((await post('/projects', { name: 'Auto start adapter', poAgent: 'adapter-auto', members: [], autoStartPlanning: false })).status, 201);
  assert.equal((await post('/projects', { name: 'Desktop pooled seed boundary', poAgent: 'xiaok-po', members: ['xiaok-worker'], autoStartPlanning: false })).status, 201);
  const refused = await post('/agents/xiaok-po/start', {}); assert.equal(refused.status, 409); assert.equal(refused.result.error, 'desktop_runtime_required');
  fixture.child.kill('SIGTERM'); const [code] = await fixture.closed; assert.equal(code, 0, fixture.output());
  const facts = readFileSync(join(fixture.root, 'spawn-facts'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(facts.filter(item => item.event === 'spawn').map(item => item.id).sort(), ['adapter-auto', 'adapter-start', 'legacy-worker']);
  assert.deepEqual(facts.filter(item => item.event === 'close').map(item => item.id).sort(), ['adapter-auto', 'adapter-start', 'legacy-worker']);
  for (const item of facts.filter(item => item.event === 'spawn')) assert.throws(() => process.kill(item.pid, 0), { code: 'ESRCH' });
});

test('fixed source census has no unowned top-level async producer or worker spawn', () => {
  const source = readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8');
  const implementations = [...source.matchAll(/^async function (\w+)Implementation\(/gm)].map(match => match[1]);
  assert.equal(implementations.length, 17);
  for (const name of implementations) assert.ok(source.includes(`const work = serverOperations.run(() => ${name}Implementation(...args));`), name);
  assert.deepEqual([...source.matchAll(/^async function (\w+)\(/gm)].map(match => match[1]).filter(name => !name.endsWith('Implementation')), ['awaitServerOperation']);
  assert.equal((source.match(/\bspawnAutoWorkerProcess\(/g) || []).length, 1);
  assert.equal((source.match(/const spawned = spawnOwnedAutoWorker\(/g) || []).length, 4);
  assert.match(source, /spawnFn: workerLifetime.spawn/);
});

test('actual offline-delivery polling SIGTERM exits clean without failure or retry mutations', { timeout: 10_000 }, async t => {
  let checks = 0, entered; const polling = new Promise(resolve => { entered = resolve; });
  const local = await broker(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/participants') {
      checks++;
      res.end(JSON.stringify({ participants: checks === 1 ? [{ participantId: 'offline-worker', kind: 'agent', status: 'online' }] : [] }));
      if (checks >= 2) entered();
    } else res.end('{}');
  });
  const connected = once(local.wss, 'connection');
  const fixture = await start(t, { brokerUrl: local.url, initialize: root => {
    const store = createAgentStore({ filePath: join(root, '.kswarm/agents.json') });
    assert.equal(store.create({ id: 'offline-worker', name: 'offline-worker', runtimeType: 'xiaok', runtimeSource: 'desktop-agent-runtime', execution: { mode: 'hosted', hostParticipantId: 'offline-worker' } }).ok, true);
    const hub = createHub({ silent: true, dataDir: { backend: 'sqlite', filePath: join(root, 'data/state.sqlite'), silent: true } });
    hub.createProject({ id: 'offline-project', name: 'Offline delivery', goal: 'goal', poAgent: 'po', members: ['offline-worker'], autoAssignPo: false });
    assert.equal(hub.handleCreateTasks('offline-project', [{ id: 'item-1', title: 'First', brief: 'Do first', assignedAgent: 'offline-worker', dependencies: [] }], 'po').ok, true);
    assert.equal(hub.handleApprove('offline-project').ok, true);
    hub.closePersistence(); void hub.getEventLog().close();
  } });
  await connected;
  const originalAgents = readFileSync(join(fixture.root, '.kswarm/agents.json'), 'utf8');
  const restoredProject = await (await fetch(`${fixture.url}/projects/offline-project`)).json();
  const request = fetch(`${fixture.url}/projects/offline-project/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromAgent: restoredProject.project.poAgent }) });
  // Race only the test readiness observation; the production operation remains owned.
  const enteredPolling = await Promise.race([polling.then(() => true), request.then(async res => { throw new Error(`delivery ended before polling: ${await res.clone().text()}`); }), delay(3_000).then(() => { throw new Error(`no delivery polling: ${fixture.output()}`); })]);
  assert.equal(enteredPolling, true); fixture.child.kill('SIGTERM');
  const response = await request; assert.equal(response.status, 503); await response.text();
  const [code] = await fixture.closed; assert.equal(code, 0, fixture.output());
  assert.equal(readFileSync(join(fixture.root, '.kswarm/agents.json'), 'utf8'), originalAgents);
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(fixture.root, 'data/state.sqlite'), { readOnly: true });
  try {
    const board = JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='board' AND entity_key='offline-project'").get().state_json);
    assert.equal(board.tasks[0].status, 'dispatched'); assert.ok(board.tasks[0].suspendedAt);
    assert.ok(!board.tasks[0].failureReason); assert.ok(!board.tasks[0].retryNotBefore);
  } finally { db.close(); }
  const events = readdirSync(join(fixture.root, 'data/events')).filter(name => name.endsWith('.ndjson')).flatMap(name => readFileSync(join(fixture.root, 'data/events', name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  assert.ok(events.some(event => event.type === 'task.dispatched'));
  assert.ok(events.every(event => !/failed|retry|offline|blocked/.test(event.type)), JSON.stringify(events));
});

test('actual timer-stop failure prevents final SQLite close after sibling drains settle', { timeout: 10_000 }, async t => {
  const fixture = await start(t, { monitor: true, preload: root => `import { appendFileSync } from 'node:fs';const marker=${JSON.stringify(join(root, 'stop-facts'))};const clear=globalThis.clearInterval;let first=true;globalThis.clearInterval=(timer)=>{appendFileSync(marker,'stop\\n');if(first){first=false;throw new Error('heartbeat stop failed');}return clear(timer);};` });
  fixture.child.kill('SIGTERM'); const [code] = await fixture.closed; assert.equal(code, 70, fixture.output());
  const stops = readFileSync(join(fixture.root, 'stop-facts'), 'utf8').trim().split('\n');
  assert.ok(stops.length >= 4, JSON.stringify(stops));
  assert.throws(() => readFileSync(join(fixture.root, 'observations')), { code: 'ENOENT' });
  assert.match(fixture.output(), /heartbeat stop failed/);
});

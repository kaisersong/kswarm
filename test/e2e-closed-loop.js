#!/usr/bin/env node
/**
 * KSwarm 真实闭环 E2E — 完整项目生命周期
 *
 * Human 创建项目 → PO 收到通知 → PO 分解任务 → Human 审批 →
 * Hub 派发 → Workers 接受执行提交 → PO review mark_done →
 * PO 派发后续任务 → Worker 执行 → PO 交付 → 项目 delivered
 *
 * 所有通信经过真实 intent-broker WebSocket。
 */

import { createBrokerClient } from '../src/net/broker-client.js';

const HUB = 'http://127.0.0.1:4400';
const BROKER = 'http://127.0.0.1:4318';

async function api(method, path, body) {
  const opts = { method, headers: { 'content-type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return (await fetch(`${HUB}${path}`, opts)).json();
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0, total = 0;

function assert(cond, msg) {
  total++;
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.log(`  ✗ FAIL: ${msg}`); failed++; }
}

// ─── Agent Factory ────────────────────────────────────────────────

function agent(id, alias, kind, roles, caps) {
  const inbox = [];
  const client = createBrokerClient({
    brokerUrl: BROKER,
    participantId: id,
    kind,
    alias,
    roles,
    capabilities: caps,
    silent: true,
    onIntent: (intent) => inbox.push(intent),
  });
  return { client, inbox, id };
}

// ─── Main ─────────────────────────────────────────────────────────

async function run() {
  console.log('');
  console.log('┌────────────────────────────────────────────────────┐');
  console.log('│  KSwarm E2E — Complete Project Lifecycle            │');
  console.log('│  broker(:4318) ↔ hub(:4400) ↔ PO + Workers         │');
  console.log('└────────────────────────────────────────────────────┘');
  console.log('');

  // 0. Preflight
  console.log('[0] Preflight');
  const bh = await fetch(`${BROKER}/health`).then(r => r.json());
  assert(bh.ok, 'Broker healthy');
  const hh = await api('GET', '/health');
  assert(hh.ok && hh.brokerConnected, 'Hub healthy + broker connected');

  // 1. Connect agents
  console.log('\n[1] Connect agents to broker');
  const po = agent('e2e-po', 'PO-Agent', 'agent', ['project_owner'], ['planning', 'review']);
  const w1 = agent('e2e-w1', 'Frontend-Dev', 'agent', ['worker'], ['coding', 'frontend']);
  const w2 = agent('e2e-w2', 'Backend-Dev', 'agent', ['worker'], ['coding', 'backend']);

  await po.client.register();
  await po.client.connect();
  await w1.client.register();
  await w1.client.connect();
  await w2.client.register();
  await w2.client.connect();
  assert(po.client.isConnected(), 'PO connected');
  assert(w1.client.isConnected(), 'Worker-1 (frontend) connected');
  assert(w2.client.isConnected(), 'Worker-2 (backend) connected');
  await wait(300);

  // 2. Human creates project
  console.log('\n[2] Human creates project');
  const proj = await api('POST', '/projects', {
    name: 'User Auth Feature',
    goal: 'Login page + JWT token + refresh flow',
    poAgent: 'e2e-po',
    members: ['e2e-w1', 'e2e-w2'],
  });
  assert(proj.ok, `Project created: ${proj.project.id}`);
  const PID = proj.project.id;

  await wait(800);
  assert(po.inbox.some(i => i.kind === 'assign_po'), 'PO received assign_po via broker');

  // 3. PO decomposes
  console.log('\n[3] PO decomposes goal into tasks');
  const tasks = await api('POST', `/projects/${PID}/tasks`, {
    fromAgent: 'e2e-po',
    tasks: [
      { id: `${PID}-t1`, title: 'Login form component', brief: 'React + validation', dependencies: [], assignedAgent: 'e2e-w1' },
      { id: `${PID}-t2`, title: 'Auth API endpoints', brief: 'POST /login, /signup, /refresh', dependencies: [], assignedAgent: 'e2e-w2' },
      { id: `${PID}-t3`, title: 'E2E integration test', brief: 'Full login flow test', dependencies: [`${PID}-t1`, `${PID}-t2`], assignedAgent: 'e2e-w1' },
    ],
  });
  assert(tasks.ok && tasks.taskIds.length === 3, `3 tasks created`);

  // 4. Human approves
  console.log('\n[4] Human reviews and approves plan');
  const d1 = await api('GET', `/projects/${PID}`);
  assert(d1.project.status === 'planning', 'Status = planning');

  const appr = await api('POST', `/projects/${PID}/approve`);
  assert(appr.ok, 'Approved → active');

  // 5. PO dispatches (only t1, t2 — t3 blocked)
  console.log('\n[5] PO dispatches ready tasks');
  const disp = await api('POST', `/projects/${PID}/dispatch`, { fromAgent: 'e2e-po' });
  assert(disp.ok && disp.dispatched.length === 2, `2 tasks dispatched (t3 blocked by deps)`);

  await wait(500);

  // 6. Workers accept
  console.log('\n[6] Workers accept tasks via broker');
  await w1.client.sendIntent({ kind: 'accept_task', taskId: `${PID}-t1`, threadId: `t-${PID}`, payload: { participantId: 'e2e-w1' } });
  await w2.client.sendIntent({ kind: 'accept_task', taskId: `${PID}-t2`, threadId: `t-${PID}`, payload: { participantId: 'e2e-w2' } });
  await wait(400);

  const d2 = await api('GET', `/projects/${PID}`);
  assert(d2.tasks.find(t => t.id === `${PID}-t1`)?.status === 'accepted', 't1 accepted');
  assert(d2.tasks.find(t => t.id === `${PID}-t2`)?.status === 'accepted', 't2 accepted');

  // 7. Workers work and report
  console.log('\n[7] Workers report progress');
  await w1.client.sendIntent({ kind: 'report_progress', taskId: `${PID}-t1`, threadId: `t-${PID}`, payload: { stage: 'started', body: { message: 'Building form...' } } });
  await w2.client.sendIntent({ kind: 'report_progress', taskId: `${PID}-t2`, threadId: `t-${PID}`, payload: { stage: 'started', body: { message: 'Setting up routes...' } } });
  await wait(300);

  const d3 = await api('GET', `/projects/${PID}`);
  assert(d3.tasks.find(t => t.id === `${PID}-t1`)?.status === 'in_progress', 't1 in_progress');
  assert(d3.tasks.find(t => t.id === `${PID}-t2`)?.status === 'in_progress', 't2 in_progress');

  // 8. Workers submit
  console.log('\n[8] Workers submit results');
  await w1.client.sendIntent({ kind: 'submit_result', taskId: `${PID}-t1`, threadId: `t-${PID}`, payload: { summary: 'Login form done', artifacts: ['Login.jsx'] } });
  await w2.client.sendIntent({ kind: 'submit_result', taskId: `${PID}-t2`, threadId: `t-${PID}`, payload: { summary: 'Auth API ready', artifacts: ['auth.js', 'routes.js'] } });
  await wait(400);

  const d4 = await api('GET', `/projects/${PID}`);
  assert(d4.tasks.find(t => t.id === `${PID}-t1`)?.status === 'submitted', 't1 submitted');
  assert(d4.tasks.find(t => t.id === `${PID}-t2`)?.status === 'submitted', 't2 submitted');

  // 9. PO reviews and marks done
  console.log('\n[9] PO marks tasks done');
  const done1 = await api('POST', `/projects/${PID}/tasks/${PID}-t1/done`, { fromAgent: 'e2e-po' });
  assert(done1.ok, 't1 marked done');

  const done2 = await api('POST', `/projects/${PID}/tasks/${PID}-t2/done`, { fromAgent: 'e2e-po' });
  assert(done2.ok, 't2 marked done');

  // 10. t3 deps satisfied → dispatch
  console.log('\n[10] t3 deps satisfied → dispatch');
  const disp2 = await api('POST', `/projects/${PID}/dispatch`, { fromAgent: 'e2e-po' });
  assert(disp2.ok && disp2.dispatched.includes(`${PID}-t3`), 't3 now dispatched');

  // 11. Worker completes t3
  console.log('\n[11] Worker completes final task (t3)');
  await w1.client.sendIntent({ kind: 'accept_task', taskId: `${PID}-t3`, threadId: `t-${PID}`, payload: { participantId: 'e2e-w1' } });
  await wait(200);
  await w1.client.sendIntent({ kind: 'report_progress', taskId: `${PID}-t3`, threadId: `t-${PID}`, payload: { stage: 'started' } });
  await wait(200);
  await w1.client.sendIntent({ kind: 'submit_result', taskId: `${PID}-t3`, threadId: `t-${PID}`, payload: { summary: 'E2E tests pass', artifacts: ['test/auth.spec.js'] } });
  await wait(400);

  const d5 = await api('GET', `/projects/${PID}`);
  assert(d5.tasks.find(t => t.id === `${PID}-t3`)?.status === 'submitted', 't3 submitted');

  const done3 = await api('POST', `/projects/${PID}/tasks/${PID}-t3/done`, { fromAgent: 'e2e-po' });
  assert(done3.ok, 't3 marked done');

  // 12. PO delivers project
  console.log('\n[12] PO delivers project');
  const deliver = await api('POST', `/projects/${PID}/deliver`, {
    fromAgent: 'e2e-po',
    deliverable: { summary: 'Auth feature complete', artifacts: ['Login.jsx', 'auth.js', 'routes.js', 'auth.spec.js'] },
  });
  assert(deliver.ok, 'Project delivered!');

  const final = await api('GET', `/projects/${PID}`);
  assert(final.project.status === 'delivered', `Final status = delivered`);
  assert(final.tasks.every(t => t.status === 'done'), 'All 3 tasks done');

  // 13. Verify logs
  console.log('\n[13] Verify logs trace full lifecycle');
  const logs = await api('GET', '/logs?limit=100');
  const msgs = logs.logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('Project created')), 'Log: created');
  assert(msgs.some(m => m.includes('Tasks created')), 'Log: tasks');
  assert(msgs.some(m => m.includes('approved')), 'Log: approved');
  assert(msgs.some(m => m.includes('Dispatched')), 'Log: dispatched');
  assert(msgs.some(m => m.includes('accept_task')), 'Log: accept');
  assert(msgs.some(m => m.includes('submit_result')), 'Log: submit');
  assert(msgs.some(m => m.includes('done')), 'Log: done');
  assert(msgs.some(m => m.includes('delivered')), 'Log: delivered');

  // Final board snapshot
  console.log('\n[Final] Project board:');
  for (const t of final.tasks) {
    console.log(`  [${t.status}] ${t.title} → @${t.assignedAgent}`);
  }
  console.log(`  Project: ${final.project.name} — ${final.project.status}`);

  // Cleanup
  po.client.disconnect();
  w1.client.disconnect();
  w2.client.disconnect();

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  ${passed}/${total} passed, ${failed} failed`);
  console.log(`${'═'.repeat(52)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });

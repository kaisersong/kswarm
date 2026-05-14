#!/usr/bin/env node
/**
 * KSwarm Web E2E — 验证完整的 Web UI 操作流程
 *
 * 前置条件：
 * 1. intent-broker 运行在 :4318
 * 2. kswarm server 运行在 :4400 (npm run server)
 * 3. vite dev server 运行在 :5188 (cd web && npx vite)
 */

const API = 'http://localhost:5188/api';

async function post(path, body) {
  const resp = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function get(path) {
  const resp = await fetch(`${API}${path}`);
  return resp.json();
}

async function del(path) {
  const resp = await fetch(`${API}${path}`, { method: 'DELETE' });
  return resp.json();
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.log(`  ✗ ${msg}`); failed++; }
}

async function run() {
  console.log('KSwarm Web E2E — Full Flow\n');

  // 1. Health
  console.log('1. System health');
  const health = await get('/health');
  assert(health.ok === true, 'KSwarm server healthy');
  assert(health.brokerConnected === true, 'Broker connected');

  // 2. Add Agents
  console.log('2. Agent management');
  const po = await post('/agents', { id: 'e2e-po', alias: 'E2E-PO', kind: 'agent', roles: ['project_owner'], capabilities: ['analysis'] });
  assert(po.ok && po.agent.id === 'e2e-po', 'PO agent registered');

  const w1 = await post('/agents', { id: 'e2e-worker-1', alias: 'Worker-1', kind: 'agent', roles: ['worker'], capabilities: ['coding'] });
  assert(w1.ok && w1.agent.id === 'e2e-worker-1', 'Worker agent registered');

  const agentList = await get('/agents');
  assert(agentList.agents.length >= 2, `Agents listed: ${agentList.agents.length}`);

  // 3. Create Project
  console.log('3. Project creation');
  const proj = await post('/projects', { name: 'E2E Test Project', goal: 'Verify full KSwarm flow', poAgent: 'e2e-po' });
  assert(proj.ok && proj.project.id, `Project created: ${proj.project.id}`);
  assert(proj.project.status === 'created', 'Status = created');

  const projectId = proj.project.id;

  // 4. PO creates tasks
  console.log('4. Task creation by PO');
  const tasks = await post(`/projects/${projectId}/tasks`, {
    fromAgent: 'e2e-po',
    tasks: [
      { id: 'task-a', title: 'Design API schema', brief: 'OpenAPI spec', dependencies: [] },
      { id: 'task-b', title: 'Implement auth endpoints', brief: 'JWT login/signup', dependencies: ['task-a'] },
      { id: 'task-c', title: 'Write integration tests', brief: 'Jest + supertest', dependencies: ['task-b'] },
    ],
  });
  assert(tasks.ok, `Tasks created: ${tasks.taskIds?.length}`);

  // 5. Check project detail
  console.log('5. Project detail');
  const detail = await get(`/projects/${projectId}`);
  assert(detail.project.status === 'planning', 'Status = planning after tasks created');
  assert(detail.tasks.length === 3, `3 tasks in board`);

  // 6. Human approves
  console.log('6. Human approval');
  const approve = await post(`/projects/${projectId}/approve`, {});
  assert(approve.ok, 'Project approved');

  const afterApprove = await get(`/projects/${projectId}`);
  assert(afterApprove.project.status === 'active', 'Status = active after approval');

  // 7. Logs
  console.log('7. System logs');
  const logs = await get('/logs');
  assert(logs.logs.length > 0, `${logs.logs.length} log entries`);
  const hasProjectLog = logs.logs.some(l => l.msg.includes('Project created'));
  assert(hasProjectLog, 'Logs contain project creation');

  // 8. Cleanup
  console.log('8. Cleanup');
  await del('/agents/e2e-po');
  await del('/agents/e2e-worker-1');
  const afterCleanup = await get('/agents');
  const hasE2e = afterCleanup.agents.some(a => a.id.startsWith('e2e-'));
  assert(!hasE2e, 'E2E agents cleaned up');

  // Summary
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

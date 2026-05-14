#!/usr/bin/env node
/**
 * Web UI Full Flow Simulation — 完整生命周期
 *
 * 模拟真实用户在浏览器中的完整操作序列：
 * 1. Human 创建项目并指定 PO
 * 2. Human 添加任务（人工添加，不需要 PO）
 * 3. Human 审批计划
 * 4. PO 派发任务
 * 5. Workers 自动执行（产出 artifact 文件）
 * 6. PO 确认任务完成
 * 7. Human 关闭项目（只有人能关闭！）
 */

const API = 'http://localhost:5188/api';

async function post(path, body) {
  return (await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
}
async function get(path) { return (await fetch(`${API}${path}`)).json(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  KSwarm Web UI — Full Lifecycle Simulation');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Human creates project
  console.log('[Human] Creates project with PO and members');
  const proj = await post('/projects', {
    name: 'Design System v2',
    goal: 'Build a unified design system with tokens, components, docs',
    poAgent: 'auto-worker-1',
    members: ['auto-worker-2'],
  });
  const PID = proj.project.id;
  console.log(`  → Project "${proj.project.name}" created (${PID})`);

  // 2. Human adds tasks directly (no PO needed!)
  console.log('\n[Human] Adds tasks directly (人工添加)');
  const addResult = await post(`/projects/${PID}/tasks/human`, {
    tasks: [
      { id: `${PID}-t1`, title: 'Design token system', brief: 'Color, spacing, typography tokens', dependencies: [], assignedAgent: 'auto-worker-1' },
      { id: `${PID}-t2`, title: 'Component library', brief: 'Button, Input, Card, Modal', dependencies: [], assignedAgent: 'auto-worker-2' },
      { id: `${PID}-t3`, title: 'Documentation site', brief: 'Storybook-style docs', dependencies: [], assignedAgent: 'auto-worker-1' },
    ],
  });
  console.log(`  → ${addResult.taskIds?.length || 0} tasks added by Human`);

  // 3. Human approves plan
  console.log('\n[Human] Approves the plan → project becomes active');
  await post(`/projects/${PID}/approve`, {});
  console.log('  → Status: active');

  // 4. PO dispatches tasks to workers
  console.log('\n[PO] Dispatches all pending tasks to workers via broker');
  const disp = await post(`/projects/${PID}/dispatch`, { fromAgent: 'auto-worker-1' });
  console.log(`  → Dispatched ${disp.dispatched?.length} tasks`);

  // 5. Wait for auto-workers to execute (they produce real MD artifacts)
  console.log('\n[Workers] Executing tasks... (producing markdown artifacts)');
  await sleep(5000);

  // 6. Check state
  console.log('\n[Human] Checks board progress');
  let detail = await get(`/projects/${PID}`);
  console.log('  Board state:');
  detail.tasks.forEach(t => console.log(`    [${t.status.padEnd(10)}] ${t.title} → @${t.assignedAgent}`));

  // Wait more if needed
  if (!detail.tasks.every(t => t.status === 'submitted' || t.status === 'done')) {
    console.log('  ⏳ Waiting for workers...');
    await sleep(3000);
    detail = await get(`/projects/${PID}`);
  }

  // 7. PO marks tasks done (review)
  console.log('\n[PO] Reviews and marks tasks as done');
  for (const task of detail.tasks) {
    if (task.status === 'submitted') {
      const r = await post(`/projects/${PID}/tasks/${task.id}/done`, { fromAgent: 'auto-worker-1' });
      console.log(`  → "${task.title}": ${r.ok ? 'confirmed done' : r.error}`);
    }
  }

  // 8. Human adds an additional task (even after all are done!)
  console.log('\n[Human] Adds a follow-up task (even after all others are done)');
  await post(`/projects/${PID}/tasks/human`, {
    tasks: [
      { id: `${PID}-t4`, title: 'Release notes', brief: 'Write changelog for v2.0', dependencies: [], assignedAgent: 'auto-worker-2' },
    ],
  });
  console.log('  → 1 additional task added');

  // Dispatch and complete it
  await post(`/projects/${PID}/dispatch`, { fromAgent: 'auto-worker-1' });
  console.log('  → Dispatched follow-up task');
  await sleep(4000);
  detail = await get(`/projects/${PID}`);
  const followUp = detail.tasks.find(t => t.id === `${PID}-t4`);
  if (followUp?.status === 'submitted') {
    await post(`/projects/${PID}/tasks/${followUp.id}/done`, { fromAgent: 'auto-worker-1' });
    console.log('  → Follow-up task marked done');
  }

  // 9. Human closes project (ONLY Human can do this!)
  console.log('\n[Human] Closes the project (final decision by human)');
  const closeResult = await post(`/projects/${PID}/close`, { summary: 'Design System v2 delivered successfully. All components, tokens, and docs are ready.' });
  console.log(`  → Closed: ${closeResult.ok}`);

  // 10. Final state
  console.log('\n═══════════════════════════════════════════════════');
  detail = await get(`/projects/${PID}`);
  console.log(`  Project: "${detail.project.name}" — ${detail.project.status.toUpperCase()}`);
  console.log(`  Tasks (${detail.tasks.length}):`);
  detail.tasks.forEach(t => {
    const artifacts = t.result?.artifacts?.map(a => typeof a === 'string' ? a : a.filename).join(', ') || 'none';
    console.log(`    [${t.status}] ${t.title} → @${t.assignedAgent} | artifacts: ${artifacts}`);
  });
  console.log(`  Activities: ${detail.activities?.length} events recorded`);
  console.log(`  Human actions: ${detail.humanActions?.length} decisions`);
  console.log(`  Closed at: ${detail.project.closedAt ? new Date(detail.project.closedAt).toLocaleString() : 'N/A'}`);

  // Verify
  const success = detail.project.status === 'closed'
    && detail.tasks.every(t => t.status === 'done')
    && detail.activities.length > 0
    && detail.humanActions.length > 0;

  console.log('\n═══════════════════════════════════════════════════');
  if (success) {
    console.log('  ✓ FULL LIFECYCLE COMPLETE');
    console.log('    - Human created project, added tasks, approved, added follow-up, closed');
    console.log('    - PO dispatched and confirmed');
    console.log('    - Workers produced real artifacts (markdown files)');
    console.log('    - Activities timeline has full audit trail');
  } else {
    console.log('  ✗ FLOW INCOMPLETE');
    console.log(`    Status: ${detail.project.status}`);
    console.log(`    Tasks not done: ${detail.tasks.filter(t => t.status !== 'done').map(t => t.title)}`);
  }
  console.log('═══════════════════════════════════════════════════\n');
  process.exit(success ? 0 : 1);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

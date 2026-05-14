/**
 * KSwarm v2 — Scenario Tests with PO Agent
 *
 * 验证新架构：Hub 只做路由/看板/规则，PO Agent 做所有业务决策。
 *
 * Run: node test/scenarios-v2.test.js
 */

import { createHub } from '../src/core/hub.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let total = 0, passed = 0, failed = 0;
function assert(cond, msg) {
  total++;
  if (cond) { passed++; console.log(`    ✓ ${msg}`); }
  else { failed++; console.log(`    ✗ FAIL: ${msg}`); }
}
function scenario(name, fn) {
  console.log(`\n  ━━━ 场景: ${name} ━━━\n`);
  fn();
}

/** Mock bridge that records all messages */
function createMockBridge() {
  const sent = [];
  return {
    send(msg) { sent.push(msg); },
    requestTask(p) { sent.push({ type: 'intent', kind: 'request_task', ...p }); },
    getSent: () => sent,
    getSentOf: (kind) => sent.filter(m => m.kind === kind),
    isConnected: () => true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 场景 1: 完整流程 — Human → Hub → PO 分解 → Workers 执行 → PO 验收 → 交付
// ═══════════════════════════════════════════════════════════════════════════════

scenario('1. 完整流程 — PO 主导，Hub 只路由', () => {
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });

  // ── Step 1: Human 创建项目，指定 @xiaok 为 PO
  console.log('    [Human] "做一个实时协作白板技术方案"，PO = @xiaok');
  const project = hub.createProject({
    id: 'proj-001',
    name: '实时协作白板技术方案',
    goal: '设计一个支持多人实时协作的在线白板系统',
    poAgent: 'xiaok-default',
  });

  assert(project.status === 'created', 'Hub 创建项目，状态 = created');
  assert(bridge.getSentOf('assign_po').length === 1, 'Hub 通知 PO 被指派');

  // ── Step 2: PO 收到指派，自己做分解，提交任务列表给 Hub
  //    注意：分解逻辑在 PO 侧，Hub 只是接收结果
  console.log('    [PO @xiaok] 收到项目，开始分解...');
  const poTasks = [
    { id: 't1', title: '技术选型调研', brief: '对比 CRDT/OT 方案', dependencies: [], requiredCapabilities: ['research'] },
    { id: 't2', title: '需求梳理', brief: '整理白板核心功能需求', dependencies: [], requiredCapabilities: ['product'] },
    { id: 't3', title: '架构设计', brief: '设计系统架构', dependencies: ['t1', 't2'], requiredCapabilities: ['architecture'] },
    { id: 't4', title: '接口定义', brief: '定义 API 和数据模型', dependencies: ['t3'], requiredCapabilities: ['engineering'] },
    { id: 't5', title: '方案文档整合', brief: '整合所有产出为最终文档', dependencies: ['t3', 't4'], requiredCapabilities: ['documentation'] },
  ];

  const createResult = hub.handleCreateTasks('proj-001', poTasks, 'xiaok-default');
  assert(createResult.ok, `PO 提交 ${poTasks.length} 个任务到 Hub`);

  const board = hub.getBoard('proj-001');
  assert(board.getAllTasks().length === 5, 'Board 上有 5 个任务');
  assert(board.getAllTasks().every(t => t.status === 'pending'), '所有任务初始 pending');

  // ── Step 3: PO 指定任务分配
  console.log('    [PO @xiaok] 分配任务...');
  hub.handleAssignTask('proj-001', 't1', 'qoder-default', 'xiaok-default');    // 调研 → @qoder
  hub.handleAssignTask('proj-001', 't2', 'xiaok-default', 'xiaok-default');    // 需求 → 自己做
  hub.handleAssignTask('proj-001', 't3', 'claude-code-default', 'xiaok-default'); // 架构 → @claude
  hub.handleAssignTask('proj-001', 't4', 'codex-default', 'xiaok-default');    // 接口 → @codex
  hub.handleAssignTask('proj-001', 't5', 'xiaok-default', 'xiaok-default');    // 整合 → 自己做

  assert(board.getTask('t1').assignedAgent === 'qoder-default', 't1 分配给 @qoder');
  assert(board.getTask('t3').assignedAgent === 'claude-code-default', 't3 分配给 @claude');

  // ── Step 4: Human 审批
  console.log('    [Human] /approve');
  hub.handleApprove('proj-001');
  const approvedProject = hub.getProject('proj-001');
  assert(approvedProject.status === 'active', 'Human approve → 项目 active');
  assert(bridge.getSentOf('plan_approved').length === 1, 'Hub 通知 PO 已批准');

  // ── Step 5: PO 请求 Hub 派发
  console.log('    [PO @xiaok] 请求派发...');
  const dispatchResult = hub.handleRequestDispatch('proj-001', 'xiaok-default');
  assert(dispatchResult.ok, 'PO 请求派发成功');
  assert(dispatchResult.dispatched.length === 2, `Hub 派出 ${dispatchResult.dispatched.length} 个任务（t1, t2 无依赖）`);

  // t3 有依赖（t1, t2），不应该被派出
  assert(!dispatchResult.dispatched.includes('t3'), 't3 未被派出（有依赖）');

  // 验证 Hub 通过 broker 发出了 request_task
  const requestTasks = bridge.getSentOf('request_task');
  assert(requestTasks.length === 2, 'Broker 收到 2 个 request_task');
  assert(requestTasks[0].targetParticipantId === 'qoder-default', 'request_task 目标是 PO 指定的 agent');

  // ── Step 6: Workers 执行并提交结果
  console.log('    [@qoder] 接受 t1，开始调研...');
  hub.handleAcceptTask('proj-001', 't1', 'qoder-default');
  hub.handleProgress('proj-001', 't1', 'started', 'qoder-default');
  assert(board.getTask('t1').status === 'in_progress', 't1 状态 = in_progress');

  // PO 应该收到通知
  assert(bridge.getSentOf('task_accepted').length >= 1, 'PO 收到 agent 接受通知');

  // Worker 提交结果
  console.log('    [@qoder] 提交 t1 结果');
  hub.handleSubmitResult('proj-001', 't1', {
    success: true,
    summary: 'CRDT 方案更适合，推荐 Yjs',
    artifacts: [{ name: 'tech-research.md', type: 'text' }],
  }, 'qoder-default');
  assert(board.getTask('t1').status === 'submitted', 't1 状态 = submitted（等 PO 确认）');

  // PO 收到结果通知
  assert(bridge.getSentOf('result_submitted').length >= 1, 'PO 收到结果提交通知');

  // ── Step 7: PO review 后确认完成
  console.log('    [PO @xiaok] review t1 结果 → mark_done');
  hub.handleMarkDone('proj-001', 't1', 'xiaok-default');
  assert(board.getTask('t1').status === 'done', 't1 状态 = done（PO 确认）');

  // 同时 xiaok 自己完成 t2
  hub.handleAcceptTask('proj-001', 't2', 'xiaok-default');
  hub.handleProgress('proj-001', 't2', 'started', 'xiaok-default');
  hub.handleSubmitResult('proj-001', 't2', { success: true, summary: '需求清单完成' }, 'xiaok-default');
  hub.handleMarkDone('proj-001', 't2', 'xiaok-default');
  assert(board.getTask('t2').status === 'done', 't2 done');

  // ── Step 8: t1, t2 都 done → t3 的依赖满足
  console.log('    [PO @xiaok] t1+t2 完成，请求派发 t3...');
  const dispatch2 = hub.handleRequestDispatch('proj-001', 'xiaok-default');
  assert(dispatch2.dispatched.includes('t3'), 't3 现在可以派发了（依赖满足）');
  assert(!dispatch2.dispatched.includes('t4'), 't4 还不能派（等 t3）');

  // 完成 t3
  hub.handleAcceptTask('proj-001', 't3', 'claude-code-default');
  hub.handleProgress('proj-001', 't3', 'started', 'claude-code-default');
  hub.handleSubmitResult('proj-001', 't3', { success: true, summary: '架构设计完成' }, 'claude-code-default');
  hub.handleMarkDone('proj-001', 't3', 'xiaok-default');

  // 完成 t4
  const dispatch3 = hub.handleRequestDispatch('proj-001', 'xiaok-default');
  assert(dispatch3.dispatched.includes('t4'), 't4 可以派发');
  hub.handleAcceptTask('proj-001', 't4', 'codex-default');
  hub.handleProgress('proj-001', 't4', 'started', 'codex-default');
  hub.handleSubmitResult('proj-001', 't4', { success: true, summary: 'API 定义完成' }, 'codex-default');
  hub.handleMarkDone('proj-001', 't4', 'xiaok-default');

  // 完成 t5 (依赖 t3 + t4)
  const dispatch4 = hub.handleRequestDispatch('proj-001', 'xiaok-default');
  assert(dispatch4.dispatched.includes('t5'), 't5 可以派发（t3+t4 done）');
  hub.handleAcceptTask('proj-001', 't5', 'xiaok-default');
  hub.handleProgress('proj-001', 't5', 'started', 'xiaok-default');
  hub.handleSubmitResult('proj-001', 't5', { success: true, summary: '最终方案文档整合完成' }, 'xiaok-default');
  hub.handleMarkDone('proj-001', 't5', 'xiaok-default');

  // ── Step 9: PO 确认全部完成，提交交付
  console.log('    [PO @xiaok] 所有任务完成，提交交付...');
  assert(board.isAllDone(), 'Board 所有任务 done');

  const deliverResult = hub.handleDeliver('proj-001', {
    summary: '实时协作白板技术方案已完成',
    artifacts: ['tech-research.md', 'requirements.md', 'architecture.md', 'api-spec.md', 'final-proposal.md'],
  }, 'xiaok-default');
  assert(deliverResult.ok, 'PO 提交交付成功');
  assert(hub.getProject('proj-001').status === 'delivered', '项目状态 = delivered');

  // ── 验证：Hub 全程没做任何业务判断
  const events = hub.getEventLog().getEvents();
  console.log(`\n    事件总数: ${events.length}`);
  assert(events.some(e => e.type === 'po.assigned'), 'Hub 只做了: 指派 PO');
  assert(events.some(e => e.type === 'tasks.created'), 'Hub 只做了: 收录 PO 提交的任务');
  assert(events.some(e => e.type === 'task.dispatched'), 'Hub 只做了: 按 PO 指定路由派发');
  assert(events.some(e => e.type === 'project.delivered'), 'Hub 只做了: 记录交付');
  // Hub 没做: 分解目标、选择 agent、判断质量
});

// ═══════════════════════════════════════════════════════════════════════════════
// 场景 2: 权限隔离 — 非 PO 不能操作
// ═══════════════════════════════════════════════════════════════════════════════

scenario('2. 权限隔离 — 只有 PO 能管理任务', () => {
  const hub = createHub({ silent: true });

  hub.createProject({ id: 'proj-002', name: 'test', goal: 'test', poAgent: 'xiaok-default' });
  hub.handleCreateTasks('proj-002', [
    { id: 'tx', title: 'task', brief: 'test', dependencies: [], requiredCapabilities: [] },
  ], 'xiaok-default');
  hub.handleApprove('proj-002');

  // 非 PO 尝试派发 → 拒绝
  const r1 = hub.handleRequestDispatch('proj-002', 'codex-default');
  assert(!r1.ok, '非 PO 不能 request_dispatch');
  assert(r1.error === 'not_po', `错误原因: ${r1.error}`);

  // 非 PO 尝试 mark_done → 拒绝
  const r2 = hub.handleMarkDone('proj-002', 'tx', 'codex-default');
  assert(!r2.ok, '非 PO 不能 mark_done');

  // 非 PO 尝试 deliver → 拒绝
  const r3 = hub.handleDeliver('proj-002', {}, 'codex-default');
  assert(!r3.ok, '非 PO 不能 deliver');

  // PO 可以
  const r4 = hub.handleRequestDispatch('proj-002', 'xiaok-default');
  assert(r4.ok, 'PO 可以 request_dispatch');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 场景 3: 返工流程 — PO 要求 worker 重做
// ═══════════════════════════════════════════════════════════════════════════════

scenario('3. 返工 — PO review 不通过，要求重做', () => {
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });

  hub.createProject({ id: 'proj-003', name: 'rework test', goal: 'test', poAgent: 'xiaok-default' });
  hub.handleCreateTasks('proj-003', [
    { id: 'r1', title: '写方案', brief: 'test', dependencies: [], requiredCapabilities: [] },
  ], 'xiaok-default');
  hub.handleApprove('proj-003');
  hub.handleRequestDispatch('proj-003', 'xiaok-default');

  // Worker 提交了一个质量不好的结果
  hub.handleAcceptTask('proj-003', 'r1', 'codex-default');
  hub.handleProgress('proj-003', 'r1', 'started', 'codex-default');
  hub.handleSubmitResult('proj-003', 'r1', { success: true, summary: '草率的结果' }, 'codex-default');

  const board = hub.getBoard('proj-003');
  assert(board.getTask('r1').status === 'submitted', '提交后 status = submitted');

  // PO review 后要求返工
  console.log('    [PO] 质量不行，要求返工');
  const rework = hub.handleRework('proj-003', 'r1', '缺少性能分析部分', 'xiaok-default');
  assert(rework.ok, 'PO 可以要求返工');
  assert(board.getTask('r1').status === 'in_progress', '返工后 status 回到 in_progress');

  // Hub 通知了 worker
  assert(bridge.getSentOf('rework').length === 1, 'Hub 通知 worker 返工');

  // Worker 重新提交
  hub.handleSubmitResult('proj-003', 'r1', { success: true, summary: '补充了性能分析' }, 'codex-default');
  assert(board.getTask('r1').status === 'submitted', '重新提交后 status = submitted');

  // PO 这次满意了
  hub.handleMarkDone('proj-003', 'r1', 'xiaok-default');
  assert(board.getTask('r1').status === 'done', '第二次 PO 确认 → done');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 场景 4: 状态机保护 — 非法状态流转被拒绝
// ═══════════════════════════════════════════════════════════════════════════════

scenario('4. 状态机 — 非法流转被拒绝', () => {
  const hub = createHub({ silent: true });

  hub.createProject({ id: 'proj-004', name: 'state test', goal: 'test', poAgent: 'po-1' });
  hub.handleCreateTasks('proj-004', [
    { id: 's1', title: 'task', brief: 'test', dependencies: [], requiredCapabilities: [] },
  ], 'po-1');
  hub.handleApprove('proj-004');

  const board = hub.getBoard('proj-004');

  // pending → done 是非法的（必须经过 dispatched → accepted → in_progress → submitted → done）
  const r1 = board.transition('s1', 'done');
  assert(!r1.ok, 'pending → done 非法');
  assert(r1.error.includes('invalid_transition'), `错误: ${r1.error}`);

  // pending → dispatched 合法
  const r2 = board.transition('s1', 'dispatched');
  assert(r2.ok, 'pending → dispatched 合法');

  // dispatched → in_progress 非法（必须先 accepted）
  const r3 = board.transition('s1', 'in_progress');
  assert(!r3.ok, 'dispatched → in_progress 非法（跳过了 accepted）');

  // dispatched → accepted 合法
  const r4 = board.transition('s1', 'accepted');
  assert(r4.ok, 'dispatched → accepted 合法');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 场景 5: 不能越过审批门
// ═══════════════════════════════════════════════════════════════════════════════

scenario('5. 审批门控 — 项目未 active，PO 不能派发', () => {
  const hub = createHub({ silent: true });

  hub.createProject({ id: 'proj-005', name: 'gate test', goal: 'test', poAgent: 'po-1' });
  hub.handleCreateTasks('proj-005', [
    { id: 'g1', title: 'task', brief: 'test', dependencies: [], requiredCapabilities: [] },
  ], 'po-1');

  // 项目还在 planning，PO 尝试派发 → Hub 拒绝
  const r = hub.handleRequestDispatch('proj-005', 'po-1');
  assert(!r.ok, 'planning 阶段不能 dispatch');
  assert(r.error === 'project_not_active', `错误: ${r.error}`);

  // Human approve 后可以
  hub.handleApprove('proj-005');
  const r2 = hub.handleRequestDispatch('proj-005', 'po-1');
  assert(r2.ok, 'active 阶段可以 dispatch');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 场景 6: 不能提前交付
// ═══════════════════════════════════════════════════════════════════════════════

scenario('6. 交付门控 — 任务没做完不能交付', () => {
  const hub = createHub({ silent: true });

  hub.createProject({ id: 'proj-006', name: 'delivery gate', goal: 'test', poAgent: 'po-1' });
  hub.handleCreateTasks('proj-006', [
    { id: 'd1', title: 't1', brief: 'test', dependencies: [], requiredCapabilities: [] },
    { id: 'd2', title: 't2', brief: 'test', dependencies: [], requiredCapabilities: [] },
  ], 'po-1');
  hub.handleApprove('proj-006');

  // 只完成 d1，尝试交付
  hub.handleRequestDispatch('proj-006', 'po-1');
  hub.handleAcceptTask('proj-006', 'd1', 'worker-1');
  hub.handleProgress('proj-006', 'd1', 'started', 'worker-1');
  hub.handleSubmitResult('proj-006', 'd1', { success: true }, 'worker-1');
  hub.handleMarkDone('proj-006', 'd1', 'po-1');

  const r = hub.handleDeliver('proj-006', { summary: 'done' }, 'po-1');
  assert(!r.ok, 'd2 未完成，不能交付');
  assert(r.error === 'tasks_not_all_done', `错误: ${r.error}`);

  // 完成 d2 后可以
  hub.handleAcceptTask('proj-006', 'd2', 'worker-1');
  hub.handleProgress('proj-006', 'd2', 'started', 'worker-1');
  hub.handleSubmitResult('proj-006', 'd2', { success: true }, 'worker-1');
  hub.handleMarkDone('proj-006', 'd2', 'po-1');

  const r2 = hub.handleDeliver('proj-006', { summary: 'done' }, 'po-1');
  assert(r2.ok, '全部完成后可以交付');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log(`  验证结果: ${passed}/${total} passed, ${failed} failed`);
console.log(`${'═'.repeat(60)}`);

if (failed > 0) {
  console.log('\n  ❌ 部分场景失败\n');
  process.exit(1);
} else {
  console.log(`
  ✅ 全部 6 个场景通过

  职责验证:
  ┌──────────┬────────────────────────────────┐
  │ KSwarm   │ 路由、状态机、门控、事件记录    │
  │ (Hub)    │ 不分解、不分配、不判断质量      │
  ├──────────┼────────────────────────────────┤
  │ PO Agent │ 分解目标、指定 agent、review    │
  │          │ 确认完成、提交交付              │
  ├──────────┼────────────────────────────────┤
  │ Workers  │ 接受任务、执行、提交结果        │
  └──────────┴────────────────────────────────┘
`);
}

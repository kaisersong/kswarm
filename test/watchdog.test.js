/**
 * KSwarm — Watchdog Unit Tests
 *
 * Run: node test/watchdog.test.js
 */

import { createWatchdog } from '../src/core/watchdog.js';
import { createTaskBoard } from '../src/core/task-board.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

let total = 0, passed = 0, failed = 0;
function assert(cond, msg) {
  total++;
  if (cond) { passed++; console.log(`    ✓ ${msg}`); }
  else { failed++; console.log(`    ✗ FAIL: ${msg}`); }
}
function scenario(name, fn) {
  console.log(`\n  ━━━ ${name} ━━━\n`);
  fn();
}

function createTestBoard(tasks, projectId = 'p1') {
  const board = createTaskBoard(projectId);
  board.addTasks(tasks);
  return board;
}

// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n╔═══════════════════════════════════════════════════╗');
console.log('║   KSwarm — Watchdog Tests                         ║');
console.log('╚═══════════════════════════════════════════════════╝');

// ── 超时检测 ────────────────────────────────────────────────────────────────

scenario('超时检测 — in_progress 任务超时触发重试', () => {
  const board = createTestBoard([
    { id: 't1', title: 'stuck task', brief: '', dependencies: [] },
  ]);
  // Move to in_progress
  board.transition('t1', 'dispatched');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');

  // Manually set updatedAt to past
  const task = board.getTask('t1');
  task.updatedAt = Date.now() - 700_000; // 11+ min ago

  const watchdog = createWatchdog({
    listProjects: () => [{ id: 'p1', status: 'active' }],
    getBoard: () => board,
    timeoutMs: 600_000,
    maxRetries: 2,
  });

  const actions = watchdog.check();
  assert(actions.length === 1, `检测到 1 个超时任务: ${actions.length}`);
  assert(actions[0].action === 'retry', `动作为 retry: ${actions[0].action}`);
  assert(board.getTask('t1').status === 'pending', `任务回到 pending: ${board.getTask('t1').status}`);
});

scenario('超时检测 — dispatched 任务超时直接回退 pending', () => {
  const board = createTestBoard([
    { id: 't1', title: 'dispatched stuck', brief: '', dependencies: [] },
  ]);
  board.transition('t1', 'dispatched');
  board.getTask('t1').updatedAt = Date.now() - 700_000;

  const watchdog = createWatchdog({
    listProjects: () => [{ id: 'p1', status: 'active' }],
    getBoard: () => board,
    timeoutMs: 600_000,
    maxRetries: 2,
  });

  const actions = watchdog.check();
  assert(actions.length === 1, `检测到超时: ${actions.length}`);
  assert(board.getTask('t1').status === 'pending', `回退到 pending: ${board.getTask('t1').status}`);
});

scenario('超时检测 — 未超时任务不被处理', () => {
  const board = createTestBoard([
    { id: 't1', title: 'recent task', brief: '', dependencies: [] },
  ]);
  board.transition('t1', 'dispatched');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');
  // updatedAt is fresh (just set by transition)

  const watchdog = createWatchdog({
    listProjects: () => [{ id: 'p1', status: 'active' }],
    getBoard: () => board,
    timeoutMs: 600_000,
    maxRetries: 2,
  });

  const actions = watchdog.check();
  assert(actions.length === 0, `无超时: ${actions.length}`);
  assert(board.getTask('t1').status === 'in_progress', '状态未变');
});

// ── 重试计数 ────────────────────────────────────────────────────────────────

scenario('重试计数 — 达到 maxRetries 后永久失败', () => {
  const board = createTestBoard([
    { id: 't1', title: 'doomed task', brief: '', dependencies: [] },
  ]);

  const watchdog = createWatchdog({
    listProjects: () => [{ id: 'p1', status: 'active' }],
    getBoard: () => board,
    timeoutMs: 600_000,
    maxRetries: 2,
  });

  // Retry 1
  board.transition('t1', 'dispatched');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');
  board.getTask('t1').updatedAt = Date.now() - 700_000;
  watchdog.check();
  const taskId = board.getTask('t1').id;
  assert(watchdog.getRetryCount(taskId) === 1, `重试次数=1: ${watchdog.getRetryCount(taskId)}`);
  assert(board.getTask('t1').status === 'pending', '回到 pending');

  // Retry 2
  board.transition('t1', 'dispatched');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');
  board.getTask('t1').updatedAt = Date.now() - 700_000;
  watchdog.check();
  assert(watchdog.getRetryCount(taskId) === 2, `重试次数=2: ${watchdog.getRetryCount(taskId)}`);
  assert(board.getTask('t1').status === 'pending', '回到 pending');

  // Retry 3 — should fail permanently
  board.transition('t1', 'dispatched');
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');
  board.getTask('t1').updatedAt = Date.now() - 700_000;
  const actions = watchdog.check();
  assert(actions[0].action === 'failed_permanently', `永久失败: ${actions[0].action}`);
  assert(board.getTask('t1').status === 'failed', `最终状态 failed: ${board.getTask('t1').status}`);
});

// ── 项目过滤 ────────────────────────────────────────────────────────────────

scenario('跳过已关闭/已交付项目', () => {
  const board = createTestBoard([
    { id: 't1', title: 'old task', brief: '', dependencies: [] },
  ]);
  board.transition('t1', 'dispatched');
  board.getTask('t1').updatedAt = Date.now() - 700_000;

  const watchdog = createWatchdog({
    listProjects: () => [{ id: 'p1', status: 'closed' }],
    getBoard: () => board,
    timeoutMs: 600_000,
    maxRetries: 2,
  });

  const actions = watchdog.check();
  assert(actions.length === 0, '已关闭项目不检查');
});

scenario('跳过 pending/done/submitted 状态任务', () => {
  const board = createTestBoard([
    { id: 't1', title: 'pending', brief: '', dependencies: [] },
    { id: 't2', title: 'done', brief: '', dependencies: [] },
  ]);
  // t1 stays pending, t2 goes to done
  board.transition('t2', 'dispatched');
  board.transition('t2', 'accepted');
  board.transition('t2', 'in_progress');
  board.transition('t2', 'submitted');
  board.transition('t2', 'done');

  // Make them "old"
  board.getTask('t1').updatedAt = Date.now() - 700_000;
  board.getTask('t2').updatedAt = Date.now() - 700_000;

  const watchdog = createWatchdog({
    listProjects: () => [{ id: 'p1', status: 'active' }],
    getBoard: () => board,
    timeoutMs: 600_000,
    maxRetries: 2,
  });

  const actions = watchdog.check();
  assert(actions.length === 0, `pending 和 done 不被检测: ${actions.length}`);
});

// ── onTimeout 回调 ──────────────────────────────────────────────────────────

scenario('onTimeout 回调被调用', () => {
  const board = createTestBoard([
    { id: 't1', title: 'timeout', brief: '', dependencies: [] },
  ]);
  board.transition('t1', 'dispatched');
  board.getTask('t1').updatedAt = Date.now() - 700_000;

  const callbacks = [];
  const watchdog = createWatchdog({
    listProjects: () => [{ id: 'p1', status: 'active' }],
    getBoard: () => board,
    onTimeout: (pid, task, action) => callbacks.push({ pid, taskId: task.id, action }),
    timeoutMs: 600_000,
    maxRetries: 2,
  });

  watchdog.check();
  assert(callbacks.length === 1, `回调被调用: ${callbacks.length}`);
  assert(callbacks[0].pid === 'p1', `项目 ID 正确: ${callbacks[0].pid}`);
  assert(callbacks[0].taskId === 'p1__t1', `任务 ID 正确: ${callbacks[0].taskId}`);
});

// ── start/stop ──────────────────────────────────────────────────────────────

scenario('start/stop 控制定时器', () => {
  const watchdog = createWatchdog({
    listProjects: () => [],
    getBoard: () => null,
    intervalMs: 100_000,
    timeoutMs: 600_000,
    maxRetries: 2,
  });

  watchdog.start();
  watchdog.start(); // idempotent
  watchdog.stop();
  watchdog.stop(); // idempotent
  assert(true, 'start/stop 不抛异常');
});

// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '─'.repeat(50));
console.log(`  结果: ${passed}/${total} 通过, ${failed} 失败`);
console.log('─'.repeat(50) + '\n');

process.exit(failed > 0 ? 1 : 0);

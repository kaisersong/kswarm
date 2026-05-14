/**
 * KSwarm — Task Matcher Unit Tests
 *
 * Run: node test/task-matcher.test.js
 */

import { computeCapabilityScore, matchTaskToAgent, assignTasksSmartly } from '../src/core/task-matcher.js';

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

// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n╔═══════════════════════════════════════════════════╗');
console.log('║   KSwarm — Task Matcher Tests                     ║');
console.log('╚═══════════════════════════════════════════════════╝');

// ── computeCapabilityScore ──────────────────────────────────────────────────

scenario('computeCapabilityScore — 基本匹配', () => {
  const score1 = computeCapabilityScore('implement user login API', ['coding']);
  assert(score1 > 0, `coding agent 匹配 "implement user login API" → score=${score1}`);

  const score2 = computeCapabilityScore('write unit tests for auth', ['testing']);
  assert(score2 > 0, `testing agent 匹配 "write unit tests for auth" → score=${score2}`);

  const score3 = computeCapabilityScore('design database schema', ['design']);
  assert(score3 > 0, `design agent 匹配 "design database schema" → score=${score3}`);
});

scenario('computeCapabilityScore — 直接能力名匹配得高分', () => {
  const directScore = computeCapabilityScore('this task requires coding', ['coding']);
  const keywordScore = computeCapabilityScore('implement a function', ['coding']);
  assert(directScore >= keywordScore, `直接匹配 (${directScore}) >= 关键词匹配 (${keywordScore})`);
});

scenario('computeCapabilityScore — 多能力累加', () => {
  const score = computeCapabilityScore('implement and test the module', ['coding', 'testing']);
  const codingOnly = computeCapabilityScore('implement and test the module', ['coding']);
  assert(score > codingOnly, `多能力得分 (${score}) > 单能力 (${codingOnly})`);
});

scenario('computeCapabilityScore — 无匹配返回 0', () => {
  const score = computeCapabilityScore('deploy to production', ['testing']);
  assert(score === 0, `testing agent 不匹配 deploy 任务 → score=${score}`);
});

scenario('computeCapabilityScore — 空输入', () => {
  assert(computeCapabilityScore('', ['coding']) === 0, '空 taskText 返回 0');
  assert(computeCapabilityScore('test something', []) === 0, '空 capabilities 返回 0');
  assert(computeCapabilityScore(null, null) === 0, 'null 输入返回 0');
});

scenario('computeCapabilityScore — 中文匹配', () => {
  const score = computeCapabilityScore('实现用户登录接口开发', ['coding']);
  assert(score > 0, `中文 "开发" 匹配 coding → score=${score}`);

  const score2 = computeCapabilityScore('编写测试用例验证功能', ['testing']);
  assert(score2 > 0, `中文 "测试" 匹配 testing → score=${score2}`);
});

// ── matchTaskToAgent ────────────────────────────────────────────────────────

scenario('matchTaskToAgent — 按能力匹配', () => {
  const agents = [
    { id: 'agent-coder', capabilities: ['coding'], maxConcurrentTasks: 5 },
    { id: 'agent-tester', capabilities: ['testing'], maxConcurrentTasks: 5 },
    { id: 'agent-designer', capabilities: ['design'], maxConcurrentTasks: 5 },
  ];
  const loads = { 'agent-coder': 0, 'agent-tester': 0, 'agent-designer': 0 };

  const result1 = matchTaskToAgent({ title: 'implement login API', brief: 'code the auth endpoint' }, agents, loads);
  assert(result1 === 'agent-coder', `编码任务分配给 coder: ${result1}`);

  const result2 = matchTaskToAgent({ title: 'write e2e tests', brief: 'verify login flow' }, agents, loads);
  assert(result2 === 'agent-tester', `测试任务分配给 tester: ${result2}`);

  const result3 = matchTaskToAgent({ title: 'design UI wireframe', brief: 'create layout for dashboard' }, agents, loads);
  assert(result3 === 'agent-designer', `设计任务分配给 designer: ${result3}`);
});

scenario('matchTaskToAgent — 负载均衡', () => {
  const agents = [
    { id: 'agent-a', capabilities: ['coding'], maxConcurrentTasks: 5 },
    { id: 'agent-b', capabilities: ['coding'], maxConcurrentTasks: 5 },
  ];
  const loads = { 'agent-a': 3, 'agent-b': 1 };

  const result = matchTaskToAgent({ title: 'implement feature', brief: 'code it' }, agents, loads);
  assert(result === 'agent-b', `同能力选负载低的: ${result} (a=3, b=1)`);
});

scenario('matchTaskToAgent — maxConcurrentTasks 限制', () => {
  const agents = [
    { id: 'agent-a', capabilities: ['coding'], maxConcurrentTasks: 2 },
    { id: 'agent-b', capabilities: ['analysis'], maxConcurrentTasks: 5 },
  ];
  const loads = { 'agent-a': 2, 'agent-b': 0 };

  const result = matchTaskToAgent({ title: 'implement feature', brief: 'build module' }, agents, loads);
  assert(result === 'agent-b', `满载 agent 被跳过，选了 b: ${result}`);
});

scenario('matchTaskToAgent — 所有都满载时仍能分配', () => {
  const agents = [
    { id: 'agent-a', capabilities: ['coding'], maxConcurrentTasks: 1 },
    { id: 'agent-b', capabilities: ['coding'], maxConcurrentTasks: 1 },
  ];
  const loads = { 'agent-a': 2, 'agent-b': 1 };

  const result = matchTaskToAgent({ title: 'code something', brief: '' }, agents, loads);
  assert(result !== null, `满载时仍返回 agent: ${result}`);
  assert(result === 'agent-b', `选负载较低的: ${result}`);
});

scenario('matchTaskToAgent — 单 agent 直接返回', () => {
  const agents = [{ id: 'only-one', capabilities: [], maxConcurrentTasks: 5 }];
  const result = matchTaskToAgent({ title: 'anything', brief: '' }, agents, {});
  assert(result === 'only-one', `单 agent 直接返回: ${result}`);
});

scenario('matchTaskToAgent — 无匹配时 fallback 到最空闲', () => {
  const agents = [
    { id: 'agent-a', capabilities: ['design'], maxConcurrentTasks: 5 },
    { id: 'agent-b', capabilities: ['testing'], maxConcurrentTasks: 5 },
  ];
  const loads = { 'agent-a': 2, 'agent-b': 0 };

  // Task doesn't match any capability
  const result = matchTaskToAgent({ title: 'deploy to cloud', brief: 'setup kubernetes' }, agents, loads);
  assert(result === 'agent-b', `无匹配时选最空闲: ${result}`);
});

// ── assignTasksSmartly ──────────────────────────────────────────────────────

scenario('assignTasksSmartly — 批量分配', () => {
  const agents = [
    { id: 'coder', capabilities: ['coding'], maxConcurrentTasks: 3 },
    { id: 'tester', capabilities: ['testing'], maxConcurrentTasks: 3 },
  ];
  const tasks = [
    { title: 'implement auth', brief: 'code login' },
    { title: 'write tests', brief: 'unit test auth' },
    { title: 'code dashboard', brief: 'build UI' },
  ];

  const result = assignTasksSmartly(tasks, agents, {});
  assert(result[0].assignedAgent === 'coder', `任务1 → coder: ${result[0].assignedAgent}`);
  assert(result[1].assignedAgent === 'tester', `任务2 → tester: ${result[1].assignedAgent}`);
  assert(result.every(t => t.assignedAgent), '所有任务都被分配');
});

scenario('assignTasksSmartly — 保留已有分配', () => {
  const agents = [
    { id: 'coder', capabilities: ['coding'], maxConcurrentTasks: 5 },
    { id: 'tester', capabilities: ['testing'], maxConcurrentTasks: 5 },
  ];
  const tasks = [
    { title: 'do something', brief: 'stuff', assignedAgent: 'manual-pick' },
    { title: 'write tests', brief: 'verify' },
  ];

  const result = assignTasksSmartly(tasks, agents, {});
  assert(result[0].assignedAgent === 'manual-pick', '已有分配不被覆盖');
  assert(result[1].assignedAgent === 'tester', '未分配的正常匹配');
});

scenario('assignTasksSmartly — 负载递增', () => {
  const agents = [
    { id: 'a', capabilities: ['coding'], maxConcurrentTasks: 5 },
    { id: 'b', capabilities: ['coding'], maxConcurrentTasks: 5 },
  ];
  const tasks = [
    { title: 'code feature 1', brief: 'implement' },
    { title: 'code feature 2', brief: 'implement' },
    { title: 'code feature 3', brief: 'implement' },
    { title: 'code feature 4', brief: 'implement' },
  ];

  const result = assignTasksSmartly(tasks, agents, {});
  const aCount = result.filter(t => t.assignedAgent === 'a').length;
  const bCount = result.filter(t => t.assignedAgent === 'b').length;
  assert(aCount === 2 && bCount === 2, `均匀分配: a=${aCount}, b=${bCount}`);
});

// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '─'.repeat(50));
console.log(`  结果: ${passed}/${total} 通过, ${failed} 失败`);
console.log('─'.repeat(50) + '\n');

process.exit(failed > 0 ? 1 : 0);

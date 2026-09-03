/**
 * KSwarm — hub.js:handleSubmitPlan 接入 deriveRiskFloor（design §4.1）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §4.1 —— "项目建立时由 KSwarm 的纯函数 deriveRiskFloor(plan, executionContracts,
 *   requestedOutput) 给出确定性保守下界，planner 只能提高，不能降低...最终
 *   riskProfile = max(deterministicFloor, plannerProposal, userSelection)"
 *
 * 现状核实（2026-09-02）：risk-floor.js 的 deriveRiskFloor/resolveEffectiveRiskProfile
 * 此前完全没有被任何生产代码调用（零调用孤岛）；project 对象上从未有过 riskProfile
 * 字段。真正合适的接入点是 handleSubmitPlan（PO 提交计划、项目正式进入执行范围
 * 的时刻），不是 createProject（此时还没有 plan）。
 *
 * Run: node test/hub-submit-plan-risk-floor.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('handleSubmitPlan 后 project.riskProfile 被设为 deriveRiskFloor 计算的下界（无外部来源/无用户交付物关键词的普通计划 → low）', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-risk-low';
  hub.createProject({ id: projectId, name: projectId, goal: '内部草稿', poAgent: 'po', members: ['worker'] });
  const result = hub.handleSubmitPlan(projectId, { analysis: '内部草稿分析', phases: [] }, 'po');
  assert.equal(result.ok, true);
  const project = hub.getProject(projectId);
  assert.equal(project.riskProfile, 'low');
});

test('handleSubmitPlan 后命中财务/合规关键词且是公开发布场景时 project.riskProfile = high', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-risk-high';
  hub.createProject({
    id: projectId, name: projectId, goal: '公开发布的财务合规审计报告', poAgent: 'po', members: ['worker'],
    // design §4.1：isPublicRelease 的判定依赖结构化 requestedOutput.audience/kind，
    // 不能只靠纯文本关键词（"关键词只作保守加分，不能是唯一信号"）。
    requestedOutput: { audience: 'public', kind: 'financial_audit_report' },
  });
  const result = hub.handleSubmitPlan(projectId, {
    analysis: '本报告将公开发布，涉及财务合规审计结论',
    phases: [{ id: 'p1', name: 'p1', items: [{ id: 'item-1', title: '财务审计', brief: '公开发布财务合规审计结论', assignedAgent: 'worker' }] }],
  }, 'po');
  assert.equal(result.ok, true);
  const project = hub.getProject(projectId);
  assert.equal(project.riskProfile, 'high');
});

test('handleRevisePlan 不降低已确定的 riskProfile（deterministic floor 一旦计算不因修订而降低）', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-risk-no-downgrade';
  hub.createProject({
    id: projectId, name: projectId, goal: '公开发布的财务合规审计报告', poAgent: 'po', members: ['worker'],
    requestedOutput: { audience: 'public', kind: 'financial_audit_report' },
  });
  hub.handleSubmitPlan(projectId, {
    analysis: '本报告将公开发布，涉及财务合规审计结论',
    phases: [{ id: 'p1', name: 'p1', items: [{ id: 'item-1', title: '财务审计', brief: '公开发布财务合规审计结论', assignedAgent: 'worker' }] }],
  }, 'po');
  const project = hub.getProject(projectId);
  assert.equal(project.riskProfile, 'high');

  // 修订新增一个看起来风险更低的普通任务，riskProfile 也不能降低（§4.1："用户
  // 可以撤销 planner 额外抬高的档位，但不能降到 deterministic floor 以下"）。
  const revised = hub.handleRevisePlan(projectId, {
    reason: 'add a plain task',
    changes: [{ type: 'add', phaseId: 'p1', item: { id: 'item-2', title: '整理会议纪要', brief: '内部草稿', assignedAgent: 'worker' } }],
  }, 'po');
  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.equal(hub.getProject(projectId).riskProfile, 'high', 'riskProfile 一旦确定不应因 revise 而降低');
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    if (process.env.DEBUG) console.log(err.stack);
  }
}
console.log(`\n${passed}/${tests.length} hub submit plan risk floor tests passed\n`);
if (failed > 0) process.exit(1);

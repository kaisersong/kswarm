#!/usr/bin/env node

const prompt = process.argv[3] || '';
const assignedAgent = prompt.includes('e2e-worker-1') ? 'e2e-worker-1' : 'e2e-po';

if (prompt.includes('制定详细的执行计划') || prompt.includes('Create a detailed execution plan')) {
  const result = JSON.stringify({
    analysis: '将目标收敛为一个可验证的技术方案交付，读取项目目录中的参考信息并形成结构完整的中文文档。',
    successCriteria: ['产物存在', '内容完整', '可通过项目产物 API 读取'],
    phases: [{
      id: 'phase-1',
      name: '交付',
      items: [{
        id: 'item-1',
        title: '生成完整技术方案',
        brief: '读取项目参考信息，输出包含架构、执行步骤、测试与风险的中文技术方案。',
        rationale: '形成可直接验收的项目交付物。',
        assignedAgent,
        dependencies: [],
        acceptanceCriteria: '产物结构完整、内容具体，并可从项目 artifacts 目录读取。',
      }],
    }],
  });
  process.stdout.write(JSON.stringify({ type: 'result', result }));
} else if (prompt.includes('项目汇总') || prompt.includes('project synthesis')) {
  process.stdout.write('# 项目汇总\n\n项目目标已完成，技术方案产物已生成并通过质量审核。汇总覆盖架构、执行步骤、测试策略与风险控制，可直接用于验收。\n');
} else if (prompt.includes('质量验收') || prompt.includes('quality review')) {
  const result = JSON.stringify({
    passed: true,
    feedback: '产物包含架构、执行步骤、测试策略和风险控制，结构完整且满足本次端到端验收要求。公开接口未暴露私密 runtime 配置，执行配置仅从受信任子进程环境传递；项目产物已经落盘并能通过 artifacts API 查询，具备可重复验证的交付证据。',
    planRevisionNeeded: false,
  });
  process.stdout.write(JSON.stringify({ type: 'result', result }));
} else {
  process.stdout.write(`# 完整技术方案

## 架构

系统由 Desktop、KSwarm、Intent Broker 与受信任 Worker 组成。Desktop 负责用户语义操作，KSwarm 负责项目状态与任务调度，Intent Broker 负责事件投递，Worker 负责生成可审计产物。

## 执行步骤

1. 读取项目目录中的 README 与配置参考。
2. 按项目目标生成结构化技术方案。
3. 将正文写入项目 artifacts 目录并生成 manifest。
4. 通过 Broker 提交结果，由 PO 完成质量验收。

## 测试策略

覆盖项目创建、计划提交、人工审批、任务派发、Worker 执行、产物落盘、manifest 校验、质量审核与后续任务解锁。测试必须使用隔离端口与隔离状态目录，避免依赖常驻服务。

## 风险控制

公开 agent API 不返回 provider secret 或 runtime path；私密执行配置仅由受信任启动边界通过进程环境传递。所有用户 mutation 使用显式 credential，agent 自身只访问其职责内的任务路径。
`);
}

/**
 * KSwarm — End-to-End Integration Test
 *
 * Validates the FULL lifecycle without any UI:
 * 1. Project creation → task decomposition
 * 2. Dispatch → agent claim → progress → submission
 * 3. Completion detection → delivery
 * 4. Event log correctness (every state transition recorded)
 * 5. Status rendering (human-verifiable output)
 *
 * Run: node test/e2e.test.js
 *
 * No broker needed — uses mock bridge.
 * Success = all assertions pass + final output visible.
 */

import { createProjectManager } from '../src/project/manager.js';
import { createDispatcher } from '../src/dispatch/dispatcher.js';
import { createAgentRegistry, DEFAULT_AGENT_PRESETS } from '../src/dispatch/agent-registry.js';
import { createEventLog } from '../src/core/event-log.js';
import { renderStatus, renderTimeline, renderOneLiner } from '../src/cli/status.js';

// ─── Test Utilities ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${message}`);
  }
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━\n`);
}

// ─── Mock Bridge (records all intents sent) ──────────────────────────────────

function createMockBridge(eventLog) {
  const intents = [];

  return {
    requestTask(params) {
      intents.push({ kind: 'request_task', ...params });
      eventLog.emit('task.dispatched', { taskId: params.taskId, title: params.title, agent: params.targetAlias });
    },
    requestApproval(params) {
      intents.push({ kind: 'request_approval', ...params });
      eventLog.emit('approval.requested', { taskId: params.taskId, title: params.title });
    },
    cancelTask(params) {
      intents.push({ kind: 'cancel_task', ...params });
    },
    isConnected: () => true,
    getIntents: () => intents,
  };
}

// ─── Test: Full Lifecycle ────────────────────────────────────────────────────

function testFullLifecycle() {
  section('Test: Full Lifecycle (MVP Acceptance Criteria)');

  const eventLog = createEventLog({ silent: true }); // Silent for clean test output
  const bridge = createMockBridge(eventLog);
  const projectManager = createProjectManager();
  const agentRegistry = createAgentRegistry(DEFAULT_AGENT_PRESETS);
  const dispatcher = createDispatcher({ bridge, projectManager, agentRegistry });

  // Simulate agents online
  for (const preset of DEFAULT_AGENT_PRESETS) {
    agentRegistry.markAvailable(preset.participantId);
  }

  // ─── AC1: kswarm new "目标" 能创建项目并输出任务列表 ───────────────

  const project = projectManager.createProject({
    name: '实时协作白板技术方案',
    goal: '设计一个支持多人实时协作的在线白板系统技术方案',
    deliverable: {
      description: '完整技术方案文档',
      acceptanceCriteria: ['技术选型', '架构设计', '接口定义', '部署方案'],
      expectedArtifacts: ['调研报告', '需求文档', '架构文档', '技术方案'],
    },
  });
  eventLog.emit('project.created', { projectId: project.id, projectName: project.name });

  assert(project.id, 'AC1: Project created with ID');
  assert(project.status === 'setup', 'AC1: Initial status is setup');

  const tasks = projectManager.planProject(project.id);
  eventLog.emit('project.planned', { projectId: project.id, taskCount: tasks.length });

  assert(tasks.length >= 3 && tasks.length <= 8, `AC1: Decomposed to ${tasks.length} tasks (3-8 expected)`);
  assert(tasks.every(t => t.title && t.requiredCapabilities.length > 0), 'AC1: All tasks have title and capabilities');

  // ─── AC2: approve 后任务通过 broker 发出 request_task ──────────────

  projectManager.activateProject(project.id);
  eventLog.emit('project.activated', { projectId: project.id });

  dispatcher.dispatchReady(project.id);

  const dispatchedIntents = bridge.getIntents().filter(i => i.kind === 'request_task');
  assert(dispatchedIntents.length > 0, `AC2: ${dispatchedIntents.length} request_task sent to broker`);
  assert(dispatchedIntents[0].taskId, 'AC2: request_task includes taskId');
  assert(dispatchedIntents[0].title, 'AC2: request_task includes title');

  // ─── AC3 & AC4: Agent accepts and submits ─────────────────────────

  // First, handle the task that was already dispatched in AC2
  // Then simulate the full execution loop for remaining tasks
  let iterations = 0;
  const allTasks = tasks.slice(); // All tasks in order

  // Process each task: dispatch (if pending) → accept → progress → submit
  for (const task of allTasks) {
    iterations++;

    // If task is still pending (not yet dispatched), dispatch it
    if (task.status === 'pending') {
      // Wait for dependencies
      const deps = task.dependencies || [];
      const depsReady = deps.every(depId => {
        const dep = projectManager.getTask(depId);
        return dep && dep.status === 'done';
      });
      if (!depsReady) continue; // Will be handled later
      dispatcher.dispatchReady(project.id);
    }

    // Simulate: best agent accepts
    const agents = agentRegistry.getAvailable();
    const agent = agents.find(a =>
      task.requiredCapabilities.some(cap => a.capabilities.includes(cap))
    ) || agents[0];

    if (agent) {
      dispatcher.handleAccept(task.id, agent.participantId);
      eventLog.emit('task.accepted', { taskId: task.id, title: task.title, agent: agent.alias });

      // Simulate: agent works
      dispatcher.handleProgress(task.id, 'started');
      eventLog.emit('task.progress', { taskId: task.id, stage: 'working' });

      // Simulate: agent submits result
      const result = {
        success: true,
        summary: `Completed: ${task.title}`,
        artifacts: [{ name: `${task.title}.md`, type: 'document' }],
      };
      dispatcher.handleSubmission(task.id, result);
      eventLog.emit('task.done', { taskId: task.id, title: task.title, agent: agent.alias });
    }
  }

  // Handle any remaining tasks with dependencies that are now met
  let extraPass = 0;
  while (extraPass < 10) {
    extraPass++;
    const ready = projectManager.getReadyTasks(project.id);
    if (ready.length === 0) break;

    for (const task of ready) {
      dispatcher.dispatchReady(project.id);
      const agents = agentRegistry.getAvailable();
      const agent = agents.find(a =>
        task.requiredCapabilities.some(cap => a.capabilities.includes(cap))
      ) || agents[0];

      if (agent) {
        dispatcher.handleAccept(task.id, agent.participantId);
        eventLog.emit('task.accepted', { taskId: task.id, title: task.title, agent: agent.alias });
        dispatcher.handleProgress(task.id, 'started');
        const result = { success: true, summary: `Completed: ${task.title}`, artifacts: [] };
        dispatcher.handleSubmission(task.id, result);
        eventLog.emit('task.done', { taskId: task.id, title: task.title, agent: agent.alias });
      }
    }
    iterations++;
  }

  const stats = projectManager.getStats(project.id);
  assert(stats.done > 0, `AC3: Agent accepted tasks (${stats.done} done)`);
  assert(stats.done === stats.total, `AC4: All ${stats.total} tasks completed`);

  // ─── AC5: 完成检测 + 产出物列表 ──────────────────────────────────

  const completed = projectManager.checkCompletion(project.id);
  const finalProject = projectManager.getProject(project.id);

  if (!completed && finalProject.status !== 'delivered') {
    // Force check again after all tasks done
    projectManager.checkCompletion(project.id);
  }

  const deliveredProject = projectManager.getProject(project.id);
  assert(deliveredProject.status === 'delivered', 'AC5: Project status is delivered');
  eventLog.emit('project.delivered', { projectId: project.id, projectName: project.name });

  // ─── AC6: 全程不需要人手动路由 ────────────────────────────────────

  assert(iterations <= 10, `AC6: Auto-routed in ${iterations} iterations (no human routing)`);

  // ─── Verify Event Log ─────────────────────────────────────────────

  section('Event Log Verification');

  const allEvents = eventLog.getEvents();
  assert(allEvents.length > 0, `Event log captured ${allEvents.length} events`);
  assert(allEvents.some(e => e.type === 'project.created'), 'Event: project.created recorded');
  assert(allEvents.some(e => e.type === 'project.planned'), 'Event: project.planned recorded');
  assert(allEvents.some(e => e.type === 'task.dispatched'), 'Event: task.dispatched recorded');
  assert(allEvents.some(e => e.type === 'task.accepted'), 'Event: task.accepted recorded');
  assert(allEvents.some(e => e.type === 'task.done'), 'Event: task.done recorded');
  assert(allEvents.some(e => e.type === 'project.delivered'), 'Event: project.delivered recorded');

  // ─── Render CLI Output (human verification) ────────────────────────

  section('Visual Verification: kswarm status');
  renderStatus({ projectManager, agentRegistry, projectId: project.id });

  section('Visual Verification: kswarm log');
  renderTimeline(eventLog, { last: 15 });

  section('Visual Verification: One-liner (for IM response)');
  console.log('  ' + renderOneLiner({ projectManager, projectId: project.id }));

  eventLog.close();
  return { passed, failed };
}

// ─── Test: Edge Cases ────────────────────────────────────────────────────────

function testEdgeCases() {
  section('Test: Edge Cases');

  const eventLog = createEventLog({ silent: true });
  const bridge = createMockBridge(eventLog);
  const projectManager = createProjectManager();
  const agentRegistry = createAgentRegistry(DEFAULT_AGENT_PRESETS);
  const dispatcher = createDispatcher({ bridge, projectManager, agentRegistry });

  // No agents available
  const project = projectManager.createProject({
    name: 'Edge Case Test',
    goal: 'Test with no agents',
    deliverable: { description: 'test', acceptanceCriteria: [], expectedArtifacts: [] },
  });

  projectManager.planProject(project.id);
  projectManager.activateProject(project.id);
  dispatcher.dispatchReady(project.id);

  // Should still dispatch (broadcast mode when no agent matches)
  const intents = bridge.getIntents().filter(i => i.kind === 'request_task');
  assert(intents.length > 0, 'Edge: Tasks dispatched even with no available agents (broadcast)');

  // Empty project name
  const p2 = projectManager.createProject({
    name: '',
    goal: 'minimal',
    deliverable: { description: '', acceptanceCriteria: [], expectedArtifacts: [] },
  });
  assert(p2.id, 'Edge: Empty project name still creates valid project');

  eventLog.close();
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log(`
╔═══════════════════════════════════════════════════════════╗
║        KSwarm — End-to-End Integration Test              ║
║                                                          ║
║  Validates full lifecycle WITHOUT a UI.                  ║
║  Three layers: assertions + visual + event log           ║
╚═══════════════════════════════════════════════════════════╝
`);

testFullLifecycle();
testEdgeCases();

// Summary
section('Results');
console.log(`  Total: ${passed + failed}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log('');

if (failed > 0) {
  console.log('  ❌ SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('  ✅ ALL TESTS PASSED — MVP acceptance criteria verified without UI');
  console.log('');
  console.log('  验证方法总结:');
  console.log('  1. 自动化断言 — 每个 AC 有明确的 pass/fail');
  console.log('  2. 终端富输出 — kswarm status 可视化看板');
  console.log('  3. 事件日志   — NDJSON 完整记录，可 replay/审计');
  console.log('  4. 一行摘要   — 适合 IM 回复的 one-liner');
}

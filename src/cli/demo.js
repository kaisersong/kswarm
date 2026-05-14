/**
 * KSwarm — Demo
 *
 * Runs the full flow without a real broker:
 * Goal → Plan → Dispatch → (mock) Accept → Progress → Submit → Delivery
 *
 * Shows KSwarm doing its job: decomposition, dispatch, completion detection.
 * In production, the broker bridge handles real WebSocket communication.
 */

import { createProjectManager } from '../project/manager.js';
import { createDispatcher } from '../dispatch/dispatcher.js';
import { createAgentRegistry, DEFAULT_AGENT_PRESETS } from '../dispatch/agent-registry.js';

// ─── Mock broker bridge (simulates broker + agents) ─────────────────────────

function createMockBridge() {
  const dispatched = []; // Tasks sent to "broker"

  return {
    requestTask(params) {
      dispatched.push(params);
    },
    requestApproval() {},
    cancelTask() {},
    isConnected: () => true,
    getDispatched: () => dispatched,
  };
}

// ─── Simulated agent responses ──────────────────────────────────────────────

function simulateAgentWork(task, agent) {
  const roleOutputs = {
    analyst: { summary: `Analysis complete: identified 3 market opportunities for "${task.title}"` },
    pm: { summary: `PRD defined: 4 user stories with acceptance criteria for "${task.title}"` },
    architect: { summary: `Architecture designed: event-driven microservices for "${task.title}"` },
    engineer: { summary: `Implemented: 4 modules, 500 LOC, tests passing for "${task.title}"` },
    qa: { summary: `QA complete: 12 test cases, 11 pass, 1 edge case documented for "${task.title}"` },
    devops: { summary: `Deployed: CI/CD configured, health check green for "${task.title}"` },
  };
  const output = roleOutputs[agent.role] || { summary: `Done: ${task.title}` };
  return { success: true, ...output, artifacts: [{ name: `${task.title.toLowerCase().replace(/\s+/g, '-')}.md`, type: 'text', content: output.summary }] };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║              KSwarm — Independent Project Demo             ║
║                                                           ║
║  Brain layer on top of intent-broker protocol.            ║
║  Dispatches to xiaok / cc / codex / qoder via broker.     ║
╚═══════════════════════════════════════════════════════════╝
`);

  // 1. Setup
  const bridge = createMockBridge();
  const projectManager = createProjectManager();
  const agentRegistry = createAgentRegistry(DEFAULT_AGENT_PRESETS);
  const dispatcher = createDispatcher({ bridge, projectManager, agentRegistry });

  // Mark agents as available (in real life, broker presence events do this)
  for (const preset of DEFAULT_AGENT_PRESETS) {
    agentRegistry.markAvailable(preset.participantId);
  }

  // 2. Human defines a goal
  console.log('━━━ Human: "I want to build a meeting notes AI assistant" ━━━\n');

  const project = projectManager.createProject({
    name: 'Meeting Notes AI',
    goal: 'Build an AI meeting notes assistant that transcribes, summarizes, and extracts action items',
    deliverable: {
      description: 'Working MVP: upload audio → get summary + action items',
      acceptanceCriteria: [
        'Accepts audio upload',
        'Produces text transcript',
        'Generates meeting summary',
        'Extracts action items with owners',
        'Web UI for viewing results',
      ],
      expectedArtifacts: ['PRD', 'Architecture doc', 'Source code', 'Deploy URL', 'QA report'],
    },
  });

  console.log(`  Project: ${project.name}`);
  console.log(`  Goal: ${project.goal}`);
  console.log(`  Done when: ${project.deliverable.description}\n`);

  // 3. Plan (decompose goal)
  console.log('━━━ Hub decomposes goal into tasks ━━━\n');

  const tasks = projectManager.planProject(project.id);
  for (const task of tasks) {
    const deps = task.dependencies.length ? ` (after: ${task.dependencies.map(d => d.slice(0, 6)).join(', ')})` : ' (ready)';
    console.log(`  📋 ${task.title}${deps}`);
    console.log(`     caps: [${task.requiredCapabilities.join(', ')}]`);
  }

  // 4. Activate and execute
  console.log('\n━━━ Plan approved → dispatching via intent-broker ━━━\n');
  projectManager.activateProject(project.id);

  // Simulate iterative dispatch loop
  let iteration = 0;
  while (true) {
    iteration++;
    const ready = projectManager.getReadyTasks(project.id);
    if (ready.length === 0) break;

    for (const task of ready) {
      // Dispatch
      dispatcher.dispatchReady(project.id);

      // Simulate: agent accepts
      const agents = agentRegistry.getAvailable();
      const bestAgent = agents.find(a =>
        task.requiredCapabilities.some(c => a.capabilities.includes(c))
      ) || agents[0];

      if (bestAgent) {
        dispatcher.handleAccept(task.id, bestAgent.participantId);
        console.log(`  → ${bestAgent.alias} accepted "${task.title}"`);

        // Simulate: agent works and submits
        dispatcher.handleProgress(task.id, 'started');
        const result = simulateAgentWork(task, bestAgent);
        dispatcher.handleSubmission(task.id, result);
        console.log(`  ✓ ${result.summary}`);
      }
    }

    // Check completion
    if (projectManager.checkCompletion(project.id)) break;
    if (iteration > 20) { console.log('  ⚠ Max iterations'); break; }
  }

  // 5. Summary
  const stats = projectManager.getStats(project.id);
  const finalProject = projectManager.getProject(project.id);

  console.log(`
━━━ Delivery Summary ━━━

  Status: ${finalProject.status === 'delivered' ? '✅ DELIVERED' : '⏳ In Progress'}
  Tasks: ${stats.done}/${stats.total} completed
  
  Broker messages sent: ${bridge.getDispatched().length} request_task intents
  
  In production, these would flow through:
    Hub → intent-broker (WebSocket) → agent adapters → xiaok/cc/codex
    
  Human interactions via:
    intent-broker → yunzhijia/slack adapter → IM app
    intent-broker → hexdeck → desktop activity card
`);

  console.log(`━━━ Architecture in Action ━━━

  ┌──────────┐  goal   ┌───────────┐  request_task   ┌──────────────┐
  │  Human   │ ──────▶ │  KSwarm   │ ─────────────▶  │Intent Broker │
  │(via IM)  │ ◀────── │  (本项目)  │ ◀─────────────  │  (协议层)     │
  └──────────┘ status  └───────────┘  submit_result  └──────┬───────┘
                                                            │
                          ┌─────────────────────────────────┤
                          ↓              ↓            ↓     ↓
                       @xiaok         @claude      @codex  @qoder
`);
}

main();

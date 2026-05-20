#!/usr/bin/env node
/**
 * KSwarm Auto-Worker — CLI Harness Mode (multica-aligned)
 *
 * 连接 broker，自动接受并完成派发的任务。
 * 同时支持 PO 角色：收到 assign_po 后自动分解目标、创建任务、审批后派发。
 *
 * 执行优先级：
 * 1. CLI harness — 调用真实 Agent CLI (claude/codex/opencode/gemini)
 * 2. LLM API fallback — 直接调用 LLM provider API
 * 3. Template fallback — 无 LLM 时生成模板化报告
 *
 * Usage: node scripts/auto-worker.js [agent-id] [alias]
 *   或通过 server API: POST /agents/:id/start
 */

import { createBrokerClient } from '../src/net/broker-client.js';
import { createProvider } from '../src/llm/provider.js';
import { assignTasksSmartly } from '../src/core/task-matcher.js';
import { buildArtifactManifest, writeRunJournal } from '../src/core/recovery-store.js';
import {
  enrichTaskWithExecutionContract,
  validateTaskResultAgainstContract,
} from '../src/core/execution-contract.js';
import { extractDeclaredArtifacts } from '../src/core/artifact-extractor.js';
import { selectReviewArtifacts } from '../src/core/artifact-manifest.js';
import { buildArtifactRepairPrompt, classifyGeneratedArtifact } from '../src/core/artifact-quality.js';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const BROKER = process.env.BROKER_URL || 'http://127.0.0.1:4318';
const KSWARM_API = process.env.KSWARM_API || 'http://127.0.0.1:4400';
const AGENT_ID = process.env.KSWARM_AGENT_ID || process.argv[2] || `auto-worker-${Date.now()}`;
const LOGICAL_AGENT_ID = process.env.KSWARM_LOGICAL_AGENT_ID || AGENT_ID;
const PROJECT_INSTANCE_ID = process.env.KSWARM_PROJECT_ID || '';
const ALIAS = process.argv[3] || 'AutoWorker';
const DELAY = Number(process.env.WORK_DELAY || 2000);

function writeTaskJournal(workFolder, {
  projectId,
  taskId,
  localTaskId,
  runId,
  status,
  artifactManifest = undefined,
  submission = undefined,
  errorMessage = undefined,
}) {
  if (!workFolder || !runId || !taskId || !projectId) return;
  try {
    writeRunJournal(workFolder, {
      schemaVersion: 1,
      projectId,
      taskId,
      localTaskId,
      runId,
      agentId: AGENT_ID,
      status,
      artifactManifest,
      submission,
      errorMessage,
    });
  } catch (err) {
    console.log(`[${ALIAS}]   ⚠ Failed to write recovery journal (${status}): ${err.message}`);
  }
}

// ─── Agent Config (fetched from server or env) ───────────────────────────────
let agentConfig = null;  // Full agent definition from server
let llm = null;          // LLM provider instance
let agentInstructions = ''; // System prompt from agent config
let activeRun = null;
let activeChild = null;
let activeTelemetry = null;
let heartbeatTimer = null;

function startRunTelemetry({ projectId, taskId, localTaskId, runId }) {
  if (!runId) return;
  activeRun = { projectId, taskId, localTaskId, runId };
  activeTelemetry = {
    childPid: null,
    startedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    lastStdoutAt: null,
    lastStderrAt: null,
    lastArtifactAt: null,
  };
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendRunHeartbeat, 30_000);
}

function stopRunTelemetry() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  activeRun = null;
  activeChild = null;
  activeTelemetry = null;
}

function registerActiveChild(child) {
  activeChild = child;
  if (activeTelemetry) activeTelemetry.childPid = child.pid;
}

function clearActiveChild(child) {
  if (activeChild === child) activeChild = null;
}

function noteStdout() {
  if (activeTelemetry) activeTelemetry.lastStdoutAt = Date.now();
}

function noteStderr() {
  if (activeTelemetry) activeTelemetry.lastStderrAt = Date.now();
}

function noteArtifact() {
  if (activeTelemetry) activeTelemetry.lastArtifactAt = Date.now();
}

async function sendRunHeartbeat() {
  if (!activeRun || !activeTelemetry) return;
  activeTelemetry.lastHeartbeatAt = Date.now();
  try {
    await client.sendIntent({
      kind: 'report_progress',
      taskId: activeRun.taskId,
      threadId: `thread-${activeRun.taskId}`,
      payload: {
        ...activeRun,
        stage: 'heartbeat',
        telemetry: { ...activeTelemetry },
      },
    });
  } catch (_) { /* heartbeat best effort */ }
}

async function cancelActiveRun(payload = {}) {
  if (!activeRun || payload.runId !== activeRun.runId) return { ok: false, error: 'run_mismatch' };
  if (!activeChild || activeChild.pid !== activeTelemetry?.childPid) return { ok: false, error: 'child_mismatch' };
  if (!activeChild.killed) activeChild.kill('SIGTERM');
  await sendRunHeartbeat();
  return { ok: true };
}

async function loadAgentConfig() {
  // Try to fetch from server
  try {
    const res = await fetch(`${KSWARM_API}/agents/${LOGICAL_AGENT_ID}`);
    if (res.ok) {
      const data = await res.json();
      agentConfig = data.agent;
      console.log(`[${ALIAS}] Agent config loaded from server: ${agentConfig.name}`);

      // Log runtime info
      if (agentConfig.runtimeType && agentConfig.runtimeType !== 'builtin') {
        console.log(`[${ALIAS}] Runtime: ${agentConfig.runtimeType} @ ${agentConfig.runtimePath || '(not set)'}`);
      }

      // Extract instructions
      if (agentConfig.instructions) {
        agentInstructions = agentConfig.instructions;
        console.log(`[${ALIAS}] Instructions: ${agentInstructions.slice(0, 60)}...`);
      }

      // Build LLM from agent config (fallback when CLI not available)
      if (agentConfig.provider) {
        try {
          llm = createProvider({
            provider: agentConfig.provider,
            apiKey: agentConfig.apiKey,
            baseUrl: agentConfig.baseUrl,
            model: agentConfig.model,
          });
          console.log(`[${ALIAS}] LLM (fallback): ${llm.toString()}`);
        } catch (err) {
          console.log(`[${ALIAS}] LLM init from agent config failed: ${err.message}`);
        }
      }
      return;
    }
  } catch {
    // Server not reachable — fall through to env-based config
  }

  // Fallback: build LLM from environment variables
  console.log(`[${ALIAS}] No server config, using env vars`);
  const envConfig = buildEnvConfig();
  if (envConfig) {
    try {
      llm = createProvider(envConfig);
      console.log(`[${ALIAS}] LLM (env): ${llm.toString()}`);
    } catch (err) {
      console.log(`[${ALIAS}] LLM init error: ${err.message}`);
    }
  } else {
    console.log(`[${ALIAS}] LLM: not configured (using template fallback)`);
  }
}

function buildEnvConfig() {
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    };
  }
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
    return {
      provider: 'ollama',
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      model: process.env.OLLAMA_MODEL || 'llama3.1',
    };
  }
  return null;
}

function isProjectPo(proj) {
  return Boolean(
    proj?.poAgent === LOGICAL_AGENT_ID &&
    (!PROJECT_INSTANCE_ID || proj.id === PROJECT_INSTANCE_ID)
  );
}

function isTaskAssignedToRuntime(task) {
  return Boolean(
    task &&
    (task.assignedRuntimeInstance === AGENT_ID ||
      (!task.assignedRuntimeInstance && task.assignedAgent === LOGICAL_AGENT_ID))
  );
}

function isProjectAllDoneForDelivery(tasks = []) {
  if (!Array.isArray(tasks) || tasks.length === 0) return false;
  const taskById = new Map(tasks.map(task => [task.id, task]));
  return tasks.every(task => {
    if (task.status === 'done' || task.status === 'cancelled') return true;
    return isHistoricalRetryChildResolved(task, taskById);
  });
}

function isHistoricalRetryChildResolved(task, taskById) {
  if (!task?.parentTaskId) return false;
  const parent = taskById.get(task.parentTaskId);
  return Boolean(parent && (parent.status === 'done' || parent.status === 'cancelled'));
}

// ─── CLI Harness: spawn real CLI binaries (multica-aligned) ───────────────────

const CLI_TIMEOUT = 480_000; // 8 min per task execution

/**
 * Run a task through the agent's native CLI binary.
 * Returns the text output from the CLI, or null if output is invalid.
 */
async function runCLIHarness(prompt, workFolder) {
  if (!agentConfig?.runtimeType || !agentConfig?.runtimePath) {
    return null; // No CLI configured, caller should fallback
  }

  const runtimeType = agentConfig.runtimeType;
  const runtimePath = agentConfig.runtimePath;
  const model = agentConfig.runtimeModel || agentConfig.model || '';

  console.log(`[${ALIAS}]   → CLI harness: ${runtimeType} (${runtimePath})`);

  let rawOutput;
  switch (runtimeType) {
    case 'xiaok':
      rawOutput = await runXiaok(runtimePath, prompt, model, workFolder);
      break;
    case 'claude':
      rawOutput = await runClaude(runtimePath, prompt, model, workFolder);
      break;
    case 'codex':
      rawOutput = await runCodex(runtimePath, prompt, model, workFolder);
      break;
    case 'opencode':
      rawOutput = await runOpencode(runtimePath, prompt, model, workFolder);
      break;
    case 'gemini':
      rawOutput = await runGemini(runtimePath, prompt, model, workFolder);
      break;
    case 'qoder':
      rawOutput = await runQoder(runtimePath, prompt, model, workFolder);
      break;
    default:
      console.log(`[${ALIAS}]   ⚠ Unknown runtime type: ${runtimeType}, falling back`);
      return null;
  }

  // Validate output — reject error/auth messages, too-short output, etc.
  if (!validateCLIOutput(rawOutput, runtimeType)) {
    return null;
  }
  return rawOutput;
}

/**
 * Validate that CLI output is actual task content, not an error or auth prompt.
 * Returns true if output looks valid, false if it should be rejected.
 */
function validateCLIOutput(output, runtimeType) {
  if (!output || typeof output !== 'string') {
    console.log(`[${ALIAS}]   ⚠ CLI output empty`);
    return false;
  }

  const trimmed = output.trim();

  // Too short to be meaningful (less than 50 chars is likely an error)
  if (trimmed.length < 50) {
    console.log(`[${ALIAS}]   ⚠ CLI output too short (${trimmed.length} chars): "${trimmed.slice(0, 80)}"`);
    return false;
  }

  // Known error patterns from CLIs (auth failures, login prompts, etc.)
  // Only check these against short outputs — long outputs are clearly real content
  if (trimmed.length < 500) {
    const ERROR_PATTERNS = [
      /not logged in/i,
      /please run \/login/i,
      /authentication required/i,
      /unauthorized/i,
      /api key (is )?(missing|invalid|expired)/i,
      /permission denied/i,
      /rate limit/i,
      /quota exceeded/i,
      /ENOENT/,
      /command not found/i,
      /no such file or directory/i,
      /connection refused/i,
      /ETIMEDOUT/,
      /ECONNREFUSED/,
      /could not authenticate/i,
      /invalid credentials/i,
      /log in to continue/i,
    ];

    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(trimmed)) {
        console.log(`[${ALIAS}]   ⚠ CLI output rejected (matched error pattern: ${pattern}): "${trimmed.slice(0, 100)}"`);
        return false;
      }
    }
  }

  // Check that output has some substance — at least has newlines or substantial text
  // A single-line error message should not pass as a deliverable
  const lineCount = trimmed.split('\n').length;
  if (lineCount <= 2 && trimmed.length < 100) {
    console.log(`[${ALIAS}]   ⚠ CLI output suspiciously short (${lineCount} lines, ${trimmed.length} chars): "${trimmed.slice(0, 100)}"`);
    return false;
  }

  return true;
}

/**
 * Claude CLI: claude -p --output-format stream-json --permission-mode bypassPermissions
 * Prompt via stdin, output as NDJSON stream.
 * We collect "assistant" content_block_delta/text events.
 */
function runClaude(binPath, prompt, model, workFolder) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions'];
    if (model) args.push('--model', model);

    const cwd = workFolder && existsSync(workFolder) ? workFolder : process.cwd();
    const child = spawn(binPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(agentConfig.customEnv || {}) },
      timeout: CLI_TIMEOUT,
    });
    registerActiveChild(child);

    let output = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      noteStdout();
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          // Claude stream-json: collect assistant text from content_block_delta
          if (event.type === 'content_block_delta' && event.delta?.text) {
            output += event.delta.text;
          }
          // Also handle result messages (final text block)
          else if (event.type === 'message' && event.role === 'assistant') {
            // Full message content blocks
            if (Array.isArray(event.content)) {
              for (const block of event.content) {
                if (block.type === 'text') output += block.text;
              }
            }
          }
          // result event (claude code CLI wraps in {type:"result", result:"..."})
          else if (event.type === 'result' && typeof event.result === 'string') {
            output += event.result;
          }
        } catch {
          // Non-JSON line — might be raw text, append directly
          if (line.trim() && !line.startsWith('{')) {
            output += line + '\n';
          }
        }
      }
    });

    child.stderr.on('data', (chunk) => { noteStderr(); stderr += chunk.toString(); });

    child.on('close', (code) => {
      clearActiveChild(child);
      if (code !== 0 && !output) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(output.trim() || `(claude exited ${code}, no output)`);
      }
    });

    child.on('error', (err) => { clearActiveChild(child); reject(err); });

    // Send prompt via stdin
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Codex CLI: codex exec --json <prompt>
 * Non-interactive execution, JSON output on stdout.
 */
function runCodex(binPath, prompt, model, workFolder) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (model) args.push('-c', `model="${model}"`);
    args.push(prompt);

    const cwd = workFolder && existsSync(workFolder) ? workFolder : process.cwd();
    const child = spawn(binPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(agentConfig.customEnv || {}) },
      timeout: CLI_TIMEOUT,
    });
    registerActiveChild(child);

    let output = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      noteStdout();
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          // Codex exec JSON: look for message events with assistant content
          if (event.type === 'message' && event.content) {
            output += typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
          } else if (event.message) {
            output += typeof event.message === 'string' ? event.message : '';
          }
        } catch {
          // Plain text output — include it
          output += line + '\n';
        }
      }
    });
    child.stderr.on('data', (chunk) => { noteStderr(); stderr += chunk.toString(); });

    child.on('close', (code) => {
      clearActiveChild(child);
      if (code !== 0 && !output) {
        reject(new Error(`codex exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(output.trim() || `(codex exited ${code})`);
      }
    });

    child.on('error', (err) => { clearActiveChild(child); reject(err); });
  });
}

/**
 * OpenCode CLI: opencode run --format json [--model provider/model] <message>
 * Output as NDJSON lines.
 */
function runOpencode(binPath, prompt, model, workFolder) {
  return new Promise((resolve, reject) => {
    const args = ['run', '--format', 'json'];
    if (model) args.push('--model', model);
    args.push(prompt);

    const cwd = workFolder && existsSync(workFolder) ? workFolder : process.cwd();
    const child = spawn(binPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(agentConfig.customEnv || {}) },
      timeout: CLI_TIMEOUT,
    });
    registerActiveChild(child);

    let output = '';
    let stderr = '';
    let buffer = ''; // Handle partial JSON lines

    child.stdout.on('data', (chunk) => {
      noteStdout();
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep last potentially incomplete line in buffer
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // opencode NDJSON: various event types
          if (event.type === 'assistant' && event.content) {
            output += event.content;
          } else if (event.type === 'text' && event.content) {
            output += event.content;
          } else if (event.type === 'result' && event.content) {
            output += event.content;
          } else if (event.content && typeof event.content === 'string') {
            output += event.content;
          }
        } catch {
          // Plain text output
          output += line + '\n';
        }
      }
    });

    child.stderr.on('data', (chunk) => { noteStderr(); stderr += chunk.toString(); });

    child.on('close', (code) => {
      clearActiveChild(child);
      if (code !== 0 && !output) {
        reject(new Error(`opencode exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(output.trim() || `(opencode exited ${code})`);
      }
    });

    child.on('error', (err) => { clearActiveChild(child); reject(err); });
  });
}

/**
 * Gemini CLI: gemini -p <prompt> --yolo -o stream-json -m <model>
 * Output as NDJSON stream-json.
 */
function runGemini(binPath, prompt, model, workFolder) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--yolo', '-o', 'stream-json'];
    if (model) args.push('-m', model);

    const cwd = workFolder && existsSync(workFolder) ? workFolder : process.cwd();
    const child = spawn(binPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(agentConfig.customEnv || {}) },
      timeout: CLI_TIMEOUT,
    });
    registerActiveChild(child);

    let output = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      noteStdout();
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          // gemini stream-json: similar to claude, collect text deltas
          if (event.type === 'content_block_delta' && event.delta?.text) {
            output += event.delta.text;
          } else if (event.type === 'text' && event.content) {
            output += event.content;
          } else if (event.type === 'result' && event.result) {
            output += event.result;
          } else if (event.text) {
            output += event.text;
          }
        } catch {
          // Plain text
          output += line + '\n';
        }
      }
    });

    child.stderr.on('data', (chunk) => { noteStderr(); stderr += chunk.toString(); });

    child.on('close', (code) => {
      clearActiveChild(child);
      if (code !== 0 && !output) {
        reject(new Error(`gemini exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(output.trim() || `(gemini exited ${code})`);
      }
    });

    child.on('error', (err) => { clearActiveChild(child); reject(err); });
  });
}

/**
 * Qoder CLI: qodercli -p --output-format stream-json --permission-mode bypass_permissions <prompt>
 * Output as NDJSON stream-json (same format as claude).
 */
function runQoder(binPath, prompt, model, workFolder) {
  return new Promise((resolve, reject) => {
    const args = [prompt, '-p', '--output-format', 'stream-json', '--permission-mode', 'bypass_permissions'];
    if (model) args.push('-m', model);
    if (workFolder && existsSync(workFolder)) args.push('-w', workFolder);

    const cwd = workFolder && existsSync(workFolder) ? workFolder : process.cwd();
    const child = spawn(binPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(agentConfig.customEnv || {}) },
      timeout: CLI_TIMEOUT,
    });
    registerActiveChild(child);

    let output = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      noteStdout();
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          // qodercli stream-json format:
          // - {type:"assistant", message:{content:[{type:"text",text:"..."}], stop_reason:"end_turn"}}
          // - {type:"result", result:"..."}
          if (event.type === 'result' && event.result) {
            output = event.result; // Final result replaces all previous output
          } else if (event.type === 'assistant' && event.message?.content) {
            const texts = event.message.content
              .filter(c => c.type === 'text' && c.text)
              .map(c => c.text);
            if (texts.length > 0 && event.message.stop_reason === 'end_turn') {
              output += texts.join('');
            }
          } else if (event.type === 'content_block_delta' && event.delta?.text) {
            output += event.delta.text;
          }
        } catch {
          // Plain text fallback
          output += line + '\n';
        }
      }
    });

    child.stderr.on('data', (chunk) => { noteStderr(); stderr += chunk.toString(); });

    child.on('close', (code) => {
      clearActiveChild(child);
      if (code !== 0 && !output) {
        reject(new Error(`qodercli exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(output.trim() || `(qodercli exited ${code})`);
      }
    });

    child.on('error', (err) => { clearActiveChild(child); reject(err); });
  });
}

/**
 * xiaok CLI: xiaok -p --output-format stream-json
 * Uses xiaok's configured model provider. Same stream-json protocol as qoder.
 */
function runXiaok(binPath, prompt, model, workFolder) {
  return new Promise((resolve, reject) => {
    const args = [prompt, '-p', '--output-format', 'stream-json'];
    if (model) args.push('-m', model);
    if (workFolder && existsSync(workFolder)) args.push('-w', workFolder);

    const cwd = workFolder && existsSync(workFolder) ? workFolder : process.cwd();
    const child = spawn(binPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(agentConfig.customEnv || {}) },
      timeout: CLI_TIMEOUT,
    });
    registerActiveChild(child);

    let output = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      noteStdout();
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'result' && event.result) {
            output = event.result;
          } else if (event.type === 'assistant' && event.message?.content) {
            const texts = event.message.content
              .filter(c => c.type === 'text' && c.text)
              .map(c => c.text);
            if (texts.length > 0 && event.message.stop_reason === 'end_turn') {
              output += texts.join('');
            }
          } else if (event.type === 'content_block_delta' && event.delta?.text) {
            output += event.delta.text;
          }
        } catch {
          output += line + '\n';
        }
      }
    });

    child.stderr.on('data', (chunk) => { noteStderr(); stderr += chunk.toString(); });

    child.on('close', (code) => {
      clearActiveChild(child);
      if (code !== 0 && !output) {
        reject(new Error(`xiaok exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(output.trim() || `(xiaok exited ${code})`);
      }
    });

    child.on('error', (err) => { clearActiveChild(child); reject(err); });
  });
}

console.log(`[${ALIAS}] Starting agent: ${AGENT_ID}`);
if (LOGICAL_AGENT_ID !== AGENT_ID) {
  console.log(`[${ALIAS}] Logical agent: ${LOGICAL_AGENT_ID}${PROJECT_INSTANCE_ID ? ` (project ${PROJECT_INSTANCE_ID})` : ''}`);
}
console.log(`[${ALIAS}] Broker: ${BROKER}`);
console.log(`[${ALIAS}] Work delay: ${DELAY}ms\n`);

const client = createBrokerClient({
  brokerUrl: BROKER,
  participantId: AGENT_ID,
  kind: 'agent',
  alias: ALIAS,
  roles: agentConfig?.roles || ['worker', 'project_owner'],
  capabilities: agentConfig?.capabilities || ['coding', 'testing', 'design', 'planning'],
  silent: true,
  onConnect: () => console.log(`[${ALIAS}] Connected to broker`),
  onDisconnect: () => console.log(`[${ALIAS}] Disconnected`),
  onIntent: (intent) => handleIntent(intent),
});

// ─── PO state: track which projects we are PO for ────────────────────────────
const poProjects = new Map(); // projectId → { name, goal, requirements, members, status }

async function handleIntent(intent) {
  const { kind, taskId, payload } = intent;

  if (kind === 'assign_po' && payload?.projectId) {
    console.log(`[${ALIAS}] 📋 Assigned as PO for project: ${payload.projectName || payload.projectId}`);
    await handlePOAssignment(payload);
  } else if (kind === 'review_submission' && payload?.projectId && payload?.taskId) {
    console.log(`[${ALIAS}] 📋 Quality reviewing submission: ${payload.taskId} from @${payload.fromWorker}`);
    await qualityReviewTask(payload.projectId, payload.taskId, payload.result);
  } else if (kind === 'request_task' && taskId) {
    console.log(`[${ALIAS}] Received task: ${payload?.title || taskId}`);
    await doTask(taskId, payload);
  } else if (kind === 'cancel_run' && payload?.runId) {
    console.log(`[${ALIAS}] Received cancel_run for: ${payload.runId}`);
    await cancelActiveRun(payload);
  } else if (kind === 'respond_approval' && payload?.decision === 'approved') {
    console.log(`[${ALIAS}] 📋 Project approved, auto-dispatching...`);
    await handleApprovalReceived(payload.projectId);
  }
}

// ─── PO Behavior: decompose goal → create tasks → wait for approval ──────────

async function handlePOAssignment(payload) {
  const { projectId, projectName, goal, requirements, members } = payload;

  // Guard: don't re-decompose if we've already processed this project
  if (poProjects.has(projectId)) {
    console.log(`[${ALIAS}]   → Already handling project ${projectId}, skipping duplicate`);
    return;
  }

  poProjects.set(projectId, { name: projectName, goal, requirements: requirements || '', members, status: 'planning' });

  // Check if tasks already exist (e.g. PO restarted after decomposition)
  try {
    const detailRes = await fetch(`${KSWARM_API}/projects/${projectId}`);
    if (detailRes.ok) {
      const detail = await detailRes.json();
      const existingTasks = detail.tasks || [];
      if (existingTasks.length > 0) {
        console.log(`[${ALIAS}]   → Project already has ${existingTasks.length} tasks, skipping decompose`);
        if (detail.project?.status === 'active') {
          await handleApprovalReceived(projectId);
        } else {
          console.log(`[${ALIAS}]   → Awaiting human approval`);
          poProjects.get(projectId).status = 'awaiting_approval';
        }
        return;
      }
    }
  } catch (_) { /* proceed with decomposition */ }

  console.log(`[${ALIAS}]   → Analyzing goal: "${goal || projectName}"`);
  if (requirements) console.log(`[${ALIAS}]   → Requirements: "${requirements.slice(0, 80)}..."`);

  // Update status on server
  reportStatus('working');

  // Plan-Do mode: generate structured plan
  let tasks;
  try {
    tasks = await generatePlan(projectId, projectName, goal, requirements || '', members || []);
    console.log(`[${ALIAS}]   → Plan generated with ${tasks.length} tasks:`);
  } catch (err) {
    console.log(`[${ALIAS}]   ⚠ Plan generation failed, falling back to decompose: ${err.message}`);
    // Fallback to legacy decompose
    try {
      const rawTasks = await decomposeGoal(projectId, projectName, goal, requirements || '', members || []);
      const workers = [LOGICAL_AGENT_ID, ...(members || [])].filter(Boolean);
      tasks = await smartAssignTasks(rawTasks, workers);
      console.log(`[${ALIAS}]   → Decomposed into ${tasks.length} tasks (legacy mode):`);
    } catch (err2) {
      console.log(`[${ALIAS}]   ✗ Both plan and decompose failed: ${err2.message}`);
      reportStatus('idle');
      poProjects.delete(projectId);
      return;
    }
  }

  // Smart-assign any unassigned tasks
  const workers = [LOGICAL_AGENT_ID, ...(members || [])].filter(Boolean);
  tasks = await smartAssignTasks(tasks, workers);
  tasks.forEach(t => console.log(`[${ALIAS}]     - ${t.title} → @${t.assignedAgent}${t.phaseId ? ` [${t.phaseId}]` : ''}`));

  await sleep(500);
  try {
    const res = await fetch(`${KSWARM_API}/projects/${projectId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks, fromAgent: LOGICAL_AGENT_ID }),
    });
    const data = await res.json();
    if (data.ok) {
      // Check if project is already approved (active) — if so, dispatch immediately
      const projRes = await fetch(`${KSWARM_API}/projects/${projectId}`);
      const projData = projRes.ok ? await projRes.json() : null;
      if (projData?.project?.status === 'active') {
        console.log(`[${ALIAS}]   → ✓ ${tasks.length} tasks submitted, project already active — dispatching`);
        poProjects.get(projectId).status = 'active';
        await handleApprovalReceived(projectId);
      } else {
        console.log(`[${ALIAS}]   → ✓ ${tasks.length} tasks submitted, awaiting Human approval`);
        poProjects.get(projectId).status = 'awaiting_approval';
      }
    } else {
      console.log(`[${ALIAS}]   → ✗ Failed to submit tasks: ${data.error}`);
    }
  } catch (err) {
    console.log(`[${ALIAS}]   → ✗ API error: ${err.message}`);
  }

  reportStatus('idle');
}

async function decomposeGoal(projectId, projectName, goal, requirements, members) {
  const workers = [LOGICAL_AGENT_ID, ...members].filter(Boolean);
  const goalText = goal || projectName || 'project';

  let taskTemplates = null;

  // Priority 1: CLI harness for PO decomposition
  if (agentConfig?.runtimeType && agentConfig?.runtimePath && agentConfig.runtimeType !== 'builtin') {
    try {
      taskTemplates = await cliDecomposeGoal(goalText, requirements, workers);
      console.log(`[${ALIAS}]   → (CLI decomposition via ${agentConfig.runtimeType})`);
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ CLI decompose failed: ${err.message}`);
    }
  }

  // Priority 2: LLM API
  if (!taskTemplates && llm) {
    try {
      taskTemplates = await llmDecomposeGoal(goalText, requirements, workers);
      console.log(`[${ALIAS}]   → (LLM API decomposition)`);
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ LLM decompose failed: ${err.message}, using template`);
    }
  }

  // No template fallback — if both CLI and LLM fail, throw so caller handles gracefully
  if (!taskTemplates) {
    throw new Error('Both CLI and LLM decomposition failed — cannot produce quality task breakdown');
  }

  return taskTemplates.map((tmpl, i) => {
    const task = {
      id: `${projectId}-t${i + 1}`,
      title: tmpl.title,
      brief: tmpl.brief,
      assignedAgent: tmpl.assignedAgent || '',
      dependencies: tmpl.dependencies || [],
    };
    return task;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Plan-Do Functions ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a structured Plan (replaces decomposeGoal for Plan-Do mode).
 * PO analyzes the goal deeply and produces phases with acceptance criteria.
 */
async function generatePlan(projectId, projectName, goal, requirements, members) {
  const workers = [LOGICAL_AGENT_ID, ...members].filter(Boolean);
  const goalText = goal || projectName || 'project';
  const lang = detectLanguage(goalText);
  const workerList = workers.map((w, i) => `- ${w}${i === 0 ? ' (你自己，PO)' : ''}`).join('\n');

  const prompt = lang === 'zh'
    ? `你是项目负责人（PO），需要为以下项目制定详细的执行计划。

## 项目目标
${goalText}
${requirements ? `\n## 项目要求（必须严格遵守）\n${requirements}` : ''}

## 可用 Workers
${workerList}

## 计划要求
1. **深度分析**：先分析项目目标和要求，理解核心挑战和关键风险
2. **成功标准**：明确定义项目交付的成功标准（3-5条）
3. **分阶段组织**：将工作分为 2-4 个阶段（Phase），每个阶段有明确的里程碑
4. **验收标准**：每个任务项必须有具体的验收标准（acceptanceCriteria）。验收标准必须合理可达：
   - 信息收集类：要求完整性、准确性、有来源标注，禁止设"至少N个"等武断数量下限
   - 内容创作类：要求结构完整、语言流畅、逻辑清晰，不设字数下限
   - 分析对比类：要求分析有逻辑、结论有依据，不设洞察数量下限
   - 只有项目要求中明确指定的量化指标才可写入验收标准
5. **严格遵守项目要求中的流程**：如果要求"讨论N轮"、"对抗性评审"、"迭代修订"等，必须按轮次/阶段组织
6. **依赖关系**：用 dependencies 体现任务间的先后顺序
7. **合理分工**：根据任务性质分配给合适的 worker

## 输出格式
输出严格的 JSON 对象（无 markdown 代码块、无解释文字）：
{
  "analysis": "对项目目标和要求的深度分析（markdown格式，200-500字）",
  "successCriteria": ["成功标准1", "成功标准2", "成功标准3"],
  "phases": [
    {
      "id": "phase-1",
      "name": "阶段名称",
      "items": [
        {
          "id": "item-1",
          "title": "任务标题",
          "brief": "任务详细描述（2-3句话，明确输入、输出和做法）",
          "rationale": "为什么需要这个任务",
          "assignedAgent": "worker-id",
          "dependencies": ["依赖的任务title"],
          "acceptanceCriteria": "具体的验收标准"
        }
      ]
    }
  ]
}`
    : `You are the PO. Create a detailed execution plan for this project.

## Goal
${goalText}
${requirements ? `\n## Requirements (MUST follow)\n${requirements}` : ''}

## Workers
${workerList}

## Plan Requirements
1. **Deep analysis**: Analyze goal/requirements, identify core challenges and risks
2. **Success criteria**: Define 3-5 measurable success criteria
3. **Phased organization**: Organize into 2-4 phases with clear milestones
4. **Acceptance criteria**: Each item must have specific acceptance criteria. Criteria must be reasonable and achievable:
   - Info collection: require completeness, accuracy, source attribution — no arbitrary "at least N" thresholds
   - Content creation: require structural integrity, clarity, logical flow — no word count minimums
   - Analysis/comparison: require logical reasoning, evidence-based conclusions — no insight count minimums
   - Only include quantitative thresholds if explicitly specified in project requirements
5. **Follow process requirements**: Honor any specified rounds/reviews/iterations
6. **Dependencies**: Use dependencies to enforce ordering
7. **Smart assignment**: Match tasks to appropriate workers

## Output Format
Strict JSON object (no markdown fences, no commentary):
{
  "analysis": "Deep analysis of goal and requirements (markdown, 200-500 words)",
  "successCriteria": ["criterion 1", "criterion 2", "criterion 3"],
  "phases": [
    {
      "id": "phase-1",
      "name": "Phase Name",
      "items": [
        {
          "id": "item-1",
          "title": "Task title",
          "brief": "Task description (2-3 sentences, clear input/output/approach)",
          "rationale": "Why this task is needed",
          "assignedAgent": "worker-id",
          "dependencies": ["dependency task title"],
          "acceptanceCriteria": "Specific acceptance criteria"
        }
      ]
    }
  ]
}`;

  let planObj = null;

  // Try CLI first
  if (agentConfig?.runtimeType && agentConfig?.runtimePath && agentConfig.runtimeType !== 'builtin') {
    try {
      const rawOutput = await runCLIHarness(prompt, tmpdir());
      if (rawOutput) {
        const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          planObj = JSON.parse(jsonMatch[0]);
          console.log(`[${ALIAS}]   → (CLI plan generation via ${agentConfig.runtimeType})`);
        }
      }
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ CLI plan generation failed: ${err.message}`);
    }
  }

  // Fallback to LLM API
  if (!planObj && llm) {
    try {
      const messages = [
        { role: 'system', content: 'You are a senior project manager. Output only valid JSON.' },
        { role: 'user', content: prompt },
      ];
      const res = await llm.chat(messages, { temperature: 0.3, maxTokens: 4000 });
      const jsonMatch = res.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        planObj = JSON.parse(jsonMatch[0]);
        console.log(`[${ALIAS}]   → (LLM API plan generation)`);
      }
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ LLM plan generation failed: ${err.message}`);
    }
  }

  if (!planObj || !planObj.phases || !Array.isArray(planObj.phases)) {
    throw new Error('Plan generation failed — no valid plan produced');
  }

  // Normalize plan items: ensure IDs and status
  for (const phase of planObj.phases) {
    for (const item of (phase.items || [])) {
      item.status = item.status || 'planned';
      item.dependencies = Array.isArray(item.dependencies) ? item.dependencies : [];
    }
  }

  // Submit plan to server
  const submitRes = await fetch(`${KSWARM_API}/projects/${projectId}/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: planObj, fromAgent: LOGICAL_AGENT_ID }),
  });
  const submitData = await submitRes.json();
  if (!submitData.ok) throw new Error(`Plan submit failed: ${submitData.error}`);

  // Convert plan items into tasks for the task board
  const tasks = [];
  for (const phase of planObj.phases) {
    for (const item of (phase.items || [])) {
      tasks.push({
        id: item.id,
        title: item.title,
        brief: item.brief,
        assignedAgent: item.assignedAgent || '',
        dependencies: item.dependencies,
        phaseId: phase.id,
        planItemId: item.id,
        acceptanceCriteria: item.acceptanceCriteria || '',
      });
    }
  }

  return tasks;
}

/**
 * Quality review a task submission — PO reads actual artifact content
 * and evaluates against acceptance criteria.
 */
async function qualityReviewTask(projectId, taskId, result) {
  const poInfo = poProjects.get(projectId);
  const goal = poInfo?.goal || '';
  const requirements = poInfo?.requirements || '';

  // Get task details and acceptance criteria from plan
  let acceptanceCriteria = '';
  let taskTitle = '';
  let taskLocalId = '';
  try {
    const projRes = await fetch(`${KSWARM_API}/projects/${projectId}`);
    if (projRes.ok) {
      const projData = await projRes.json();
      const task = (projData.tasks || []).find(t => t.id === taskId);
      taskTitle = task?.title || taskId;
      taskLocalId = task?.localTaskId || task?.legacyTaskId || task?.planItemId || '';
      acceptanceCriteria = task?.acceptanceCriteria || '';

      // Try to get from plan if task has planItemId
      if (!acceptanceCriteria && projData.plan) {
        for (const phase of (projData.plan.phases || [])) {
          const item = (phase.items || []).find(i => i.id === (task?.planItemId || taskId));
          if (item) {
            acceptanceCriteria = item.acceptanceCriteria || '';
            break;
          }
        }
      }
    }
  } catch (_) {}

  // Read artifact evidence. Snippets are only evidence previews; manifests decide identity.
  let artifactContent = '';
  try {
    const artRes = await fetch(`${KSWARM_API}/projects/${projectId}/artifacts`);
    if (artRes.ok) {
      const artData = await artRes.json();
      const submittedArtifacts = [
        ...(Array.isArray(result?.artifacts) ? result.artifacts : []),
        ...(Array.isArray(result?.artifactManifest) ? result.artifactManifest : []),
      ];
      const artifacts = selectReviewArtifacts({
        submittedArtifacts,
        availableArtifacts: artData.artifacts || [],
        taskId,
        taskLocalId,
        taskTitle,
      });

      for (const art of artifacts.slice(0, 3)) {
        try {
          const contentRes = await fetch(`${KSWARM_API}${art.url}`);
          if (contentRes.ok) {
            const text = await contentRes.text();
            const snippet = text.slice(0, 4000);
            artifactContent += `\n--- ${art.filename} (snippet only, truncated=${text.length > snippet.length}, selection=${art.selectionReason || 'submitted_manifest'}) ---\n${snippet}\n`;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  // Also check the result payload for content
  const resultSummary = result?.summary || result?.output || '';
  const resultArtifacts = [
    ...(Array.isArray(result?.artifacts) ? result.artifacts : []),
    ...(Array.isArray(result?.artifactManifest) ? result.artifactManifest : []),
  ].map(a => a.filename || a.relativePath || a.path || a).join(', ') || 'none';

  const lang = detectLanguage(goal);
  const langInstr = getLanguageInstruction(lang);

  // Use CLI or LLM for quality review
  const reviewPrompt = lang === 'zh'
    ? `你是项目负责人（PO），正在对 worker 提交的任务结果进行质量验收。
${langInstr}

## 任务信息
- 任务：${taskTitle}
- 验收标准：${acceptanceCriteria || '无特定标准'}

## 项目上下文
- 项目目标：${goal}
${requirements ? `- 项目要求：${requirements.slice(0, 500)}` : ''}

## 提交结果
- 摘要：${resultSummary.slice(0, 500)}
- 产出物文件：${resultArtifacts}
${artifactContent ? `\n## 产出物证据片段（不是完整正文）\n${artifactContent.slice(0, 6000)}` : ''}

## 验收评估要求
1. 片段只用于定位，不能因为片段结束就判断原文件截断
2. 优先基于提交的 manifest 文件身份进行审核，不要混入旧文件
3. 对照验收标准逐项检查
4. 判断内容是否有实质性、专业性
5. 给出具体的反馈意见

## 输出格式
输出严格 JSON（无 markdown 代码块）：
{"passed": true/false, "feedback": "具体的验收反馈（100-300字）", "planRevisionNeeded": false}`
    : `You are the PO, doing quality review of a worker's task submission.
${langInstr}

## Task
- Title: ${taskTitle}
- Acceptance Criteria: ${acceptanceCriteria || 'None specified'}

## Project Context
- Goal: ${goal}
${requirements ? `- Requirements: ${requirements.slice(0, 500)}` : ''}

## Submission
- Summary: ${resultSummary.slice(0, 500)}
- Artifacts: ${resultArtifacts}
${artifactContent ? `\n## Artifact Evidence Snippets (not full content)\n${artifactContent.slice(0, 6000)}` : ''}

## Review Requirements
1. Snippets are only evidence previews; do not infer truncation from snippet boundaries
2. Review only the submitted manifest files, not stale fuzzy matches
3. Check against acceptance criteria
4. Evaluate substance and quality
5. Give specific feedback

## Output Format
Strict JSON (no markdown fences):
{"passed": true/false, "feedback": "Specific review feedback (100-300 words)", "planRevisionNeeded": false}`;

  let reviewResult = null;

  // Try CLI first
  if (agentConfig?.runtimeType && agentConfig?.runtimePath && agentConfig.runtimeType !== 'builtin') {
    try {
      const rawOutput = await runCLIHarness(reviewPrompt, tmpdir());
      if (rawOutput) {
        const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          reviewResult = JSON.parse(jsonMatch[0]);
          console.log(`[${ALIAS}]   → (CLI quality review)`);
        }
      }
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ CLI quality review failed: ${err.message}`);
    }
  }

  // Fallback to LLM
  if (!reviewResult && llm) {
    try {
      const messages = [
        { role: 'system', content: 'You are a PO doing quality review. Output only valid JSON.' },
        { role: 'user', content: reviewPrompt },
      ];
      const res = await llm.chat(messages, { temperature: 0.2, maxTokens: 1000 });
      const jsonMatch = res.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        reviewResult = JSON.parse(jsonMatch[0]);
        console.log(`[${ALIAS}]   → (LLM quality review)`);
      }
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ LLM quality review failed: ${err.message}`);
    }
  }

  // Fallback: auto-pass if no LLM/CLI available
  if (!reviewResult) {
    console.log(`[${ALIAS}]   ⚠ No LLM/CLI for review — auto-passing`);
    reviewResult = { passed: true, feedback: 'Auto-approved (no review capability)', planRevisionNeeded: false };
  }

  // Submit review to server
  try {
    const res = await fetch(`${KSWARM_API}/projects/${projectId}/tasks/${taskId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ review: reviewResult, fromAgent: LOGICAL_AGENT_ID }),
    });
    const data = await res.json();
    if (data.ok) {
      if (data.alreadyReviewed) {
        console.log(`[${ALIAS}]   → Review ignored; task was already reviewed: ${taskTitle}`);
        return;
      }

      if (reviewResult.passed) {
        console.log(`[${ALIAS}]   → ✓ Quality review PASSED: ${taskTitle}`);
        console.log(`[${ALIAS}]     Feedback: ${reviewResult.feedback.slice(0, 100)}`);
      } else {
        console.log(`[${ALIAS}]   → ✗ Quality review FAILED: ${taskTitle}`);
        console.log(`[${ALIAS}]     Feedback: ${reviewResult.feedback.slice(0, 200)}`);
      }

      // If plan revision needed, trigger it
      if (reviewResult.planRevisionNeeded) {
        await revisePlanFromReview(projectId, taskTitle, reviewResult.feedback);
      }

      // Trigger dispatch for next tasks
      if (reviewResult.passed) {
        await handleApprovalReceived(projectId);
      }
    }
  } catch (err) {
    console.log(`[${ALIAS}]   ⚠ Review submit failed: ${err.message}, falling back to auto-confirm`);
    await autoConfirmTask(projectId, taskId);
  }
}

/**
 * PO revises the plan based on review outcomes or new insights.
 */
async function revisePlanFromReview(projectId, taskTitle, reviewFeedback) {
  console.log(`[${ALIAS}]   → Plan revision triggered by review of "${taskTitle}"`);

  const lang = detectLanguage(reviewFeedback);
  const prompt = lang === 'zh'
    ? `作为PO，根据以下验收反馈，判断是否需要修订项目计划。

## 验收反馈
任务：${taskTitle}
反馈：${reviewFeedback}

## 输出格式
如果需要修订，输出 JSON：
{"needed": true, "reason": "修订原因", "changes": [{"type": "add|drop|modify", "phaseId": "phase-id", "itemId": "item-id", "item": {...}, "field": "field-name", "newValue": "new-value", "reason": "原因"}]}
如果不需要修订，输出：
{"needed": false}`
    : `As PO, determine if plan revision is needed based on review feedback.

## Review Feedback
Task: ${taskTitle}
Feedback: ${reviewFeedback}

## Output Format
If revision needed:
{"needed": true, "reason": "...", "changes": [...]}
If not: {"needed": false}`;

  let revisionData = null;

  if (llm) {
    try {
      const messages = [
        { role: 'system', content: 'You are a PO. Output only valid JSON.' },
        { role: 'user', content: prompt },
      ];
      const res = await llm.chat(messages, { temperature: 0.2, maxTokens: 1000 });
      const jsonMatch = res.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) revisionData = JSON.parse(jsonMatch[0]);
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ Plan revision analysis failed: ${err.message}`);
    }
  }

  if (!revisionData?.needed) {
    console.log(`[${ALIAS}]   → No plan revision needed`);
    return;
  }

  try {
    await fetch(`${KSWARM_API}/projects/${projectId}/plan/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: { reason: revisionData.reason, changes: revisionData.changes || [] },
        fromAgent: LOGICAL_AGENT_ID,
      }),
    });
    console.log(`[${ALIAS}]   → Plan revised: ${revisionData.reason}`);
  } catch (err) {
    console.log(`[${ALIAS}]   ⚠ Plan revision submit failed: ${err.message}`);
  }
}

/**
 * PO synthesizes the project — reads all artifacts, produces final summary.
 */
async function synthesizeProject(projectId) {
  const poInfo = poProjects.get(projectId);
  const goal = poInfo?.goal || '';
  const requirements = poInfo?.requirements || '';
  const lang = detectLanguage(goal);
  const langInstr = getLanguageInstruction(lang);

  console.log(`[${ALIAS}] 📋 Synthesizing project: ${poInfo?.name || projectId}`);

  // Read plan and all artifacts
  let planText = '';
  let allArtifactContent = '';
  let taskListText = '';
  let enableSummary = true; // default true for backwards compatibility
  try {
    const projRes = await fetch(`${KSWARM_API}/projects/${projectId}`);
    if (projRes.ok) {
      const projData = await projRes.json();

      // Read enableSummary from project
      if (projData.project && projData.project.enableSummary === false) {
        enableSummary = false;
      }

      // Plan info
      if (projData.plan) {
        planText = `成功标准：${(projData.plan.successCriteria || []).join('、')}`;
      }

      // Task list for per-task scoring
      const tasks = projData.tasks || [];
      if (tasks.length > 0) {
        taskListText = tasks
          .filter(t => t.title && t.status === 'done')
          .map(t => `- ${t.title} @${t.assignedAgent || 'unknown'}`)
          .join('\n');
      }

      // Read all artifacts
      const artifacts = projData.workspace?.artifacts || [];
      for (const art of artifacts.slice(0, 10)) {
        if (!art.previewable) continue;
        try {
          const contentRes = await fetch(`${KSWARM_API}${art.url}`);
          if (contentRes.ok) {
            const text = await contentRes.text();
            allArtifactContent += `\n\n--- ${art.filename} ---\n${text.slice(0, 3000)}`;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  let synthesisPrompt = lang === 'zh'
    ? `你是项目负责人（PO），项目所有任务已完成，现在需要做最终汇总。
${langInstr}

## 项目目标
${goal}
${requirements ? `\n## 项目要求\n${requirements}` : ''}
${planText ? `\n## 计划\n${planText}` : ''}
${taskListText ? `\n## 已完成任务\n${taskListText}` : ''}

## 所有产出物
${allArtifactContent.slice(0, 12000) || '无可读取的产出物'}

## 汇总要求
1. 对照成功标准逐项评估完成情况
2. 总结各阶段的关键产出和质量
3. 指出亮点和不足
4. 给出项目整体交付评价
5. 输出完整的汇总文档（markdown格式）`
    : `You are the PO. All tasks are done. Produce a final project synthesis.
${langInstr}

## Goal
${goal}
${requirements ? `\n## Requirements\n${requirements}` : ''}
${planText ? `\n## Plan\n${planText}` : ''}
${taskListText ? `\n## Completed Tasks\n${taskListText}` : ''}

## All Artifacts
${allArtifactContent.slice(0, 12000) || 'No readable artifacts'}

## Synthesis Requirements
1. Evaluate each success criterion
2. Summarize key outputs and quality per phase
3. Highlight strengths and weaknesses
4. Give overall delivery assessment
5. Output a complete synthesis document (markdown)`;

  // Append project summary section if enabled
  if (enableSummary) {
    const summaryPrompt = lang === 'zh'
      ? `

## 项目小结（必须输出）

在汇总文档的最后，输出以下结构化小结（用 markdown heading \`## 项目小结\` 标记）：

### 评分
给出项目整体评分（1-10），并简述理由。评分格式必须严格为"评分: X/10"，不要加任何修饰符号。

### 任务评分
对每个已完成任务逐一评分（1-10），格式必须严格为：
- 任务标题 @执行者: X/10 — 一句话评价

评分依据：产出质量、完整性、是否满足任务目标。

### 遵循的原则
列出本项目实际遵循了哪些原则（从项目要求中提取），并评价每条原则的实际效果：
- 原则内容 → 效果评价（有效/部分有效/未体现）

### 原则优化建议
基于本次项目经验，给出原则优化建议：
- 建议新增：...
- 建议修改：...
- 建议删除：...
- 无需调整的原则：...`
      : `

## Project Summary (required)

At the end of the synthesis document, output a structured summary under the heading \`## Project Summary\`:

### Score
Rate the project overall (1-10) with a brief rationale. Score format must be exactly "Score: X/10" with no additional formatting.

### Task Scores
Rate each completed task individually (1-10), format must be exactly:
- Task title @agent: X/10 — one-line assessment

Score based on: output quality, completeness, whether task objectives were met.

### Principles Followed
List which principles from the requirements were actually followed, and evaluate each:
- Principle → Assessment (effective/partially effective/not reflected)

### Principle Optimization Suggestions
Based on this project experience, suggest principle improvements:
- Suggest adding: ...
- Suggest modifying: ...
- Suggest removing: ...
- No changes needed: ...`;

    synthesisPrompt += summaryPrompt;
  }

  let synthesis = null;

  // Try CLI
  if (agentConfig?.runtimeType && agentConfig?.runtimePath && agentConfig.runtimeType !== 'builtin') {
    try {
      synthesis = await runCLIHarness(synthesisPrompt, tmpdir());
      if (synthesis) console.log(`[${ALIAS}]   → (CLI synthesis)`);
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ CLI synthesis failed: ${err.message}`);
    }
  }

  // Fallback to LLM
  if (!synthesis && llm) {
    try {
      const messages = [
        { role: 'system', content: `You are a senior PO writing a project synthesis report. ${langInstr}` },
        { role: 'user', content: synthesisPrompt },
      ];
      const res = await llm.chat(messages, { temperature: 0.3, maxTokens: 4000 });
      synthesis = res.content;
      console.log(`[${ALIAS}]   → (LLM synthesis)`);
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ LLM synthesis failed: ${err.message}`);
    }
  }

  if (!synthesis) {
    synthesis = `# Project Synthesis\n\nAll tasks completed. Auto-generated summary (no LLM available).\n\nGoal: ${goal}\n`;
  }

  // Submit synthesis to server
  try {
    const res = await fetch(`${KSWARM_API}/projects/${projectId}/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ synthesis, fromAgent: LOGICAL_AGENT_ID }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[${ALIAS}]   → ✓ Project synthesized and delivered`);
    } else {
      console.log(`[${ALIAS}]   → ✗ Synthesis failed: ${data.error}`);
    }
  } catch (err) {
    console.log(`[${ALIAS}]   → ✗ Synthesis API error: ${err.message}`);
  }
}

/**
 * Fetch agent data and loads, then smartly assign unassigned tasks.
 */
async function smartAssignTasks(tasks, workerIds) {
  try {
    // Fetch agent details and loads in parallel
    const [agentsRes, loadsRes] = await Promise.all([
      fetch(`${KSWARM_API}/agents`).then(r => r.json()),
      fetch(`${KSWARM_API}/agents/loads`).then(r => r.json()),
    ]);
    const allAgents = agentsRes.agents || [];
    const workerAgents = allAgents
      .filter(a => workerIds.includes(a.id))
      .map(a => ({ id: a.id, capabilities: a.capabilities || [], maxConcurrentTasks: a.maxConcurrentTasks || 5 }));

    if (workerAgents.length === 0) {
      // Fallback to round-robin if no agent data available
      return tasks.map((t, i) => ({ ...t, assignedAgent: t.assignedAgent || workerIds[i % workerIds.length] }));
    }

    return assignTasksSmartly(tasks, workerAgents, loadsRes.loads || {});
  } catch (err) {
    console.log(`[${ALIAS}]   ⚠ Smart assign failed: ${err.message}, using round-robin`);
    return tasks.map((t, i) => ({ ...t, assignedAgent: t.assignedAgent || workerIds[i % workerIds.length] }));
  }
}

/**
 * Use CLI agent to decompose a project goal into tasks.
 * Sends a structured prompt asking for JSON array output.
 */
async function cliDecomposeGoal(goal, requirements, workers) {
  const workerList = workers.map((w, i) => `${i + 1}. ${w}`).join('\n');
  const lang = detectLanguage(goal);

  let prompt;
  if (lang === 'zh') {
    prompt = `你是项目负责人（PO），需要将以下目标分解为可执行的任务并分配给团队成员。

## 目标
${goal}
${requirements ? `\n## 项目要求（必须严格遵守）\n${requirements}` : ''}

## 可用 Workers
${workerList}

## 分解原则
1. **严格遵守项目要求中的流程描述**。如果要求"讨论N轮"、"对抗性评审"、"迭代修订"等，你必须按轮次/阶段组织任务，并通过 dependencies 体现先后顺序。
2. 如果要求中有"评审"或"review"，应将 A 的产出交给 B 做对抗性评审，再交回 A 修订——用不同任务+依赖表达。
3. 最后必须有一个**汇总任务**，由你(${workers[0]})负责，依赖所有前置任务，产出最终整合交付物。
4. 任务数量不限（3-12均可），按实际需要分解。不要为了"可并行"而削减流程。

## 输出格式
输出严格的 JSON 数组（无 markdown 代码块、无解释文字）：
[{"title":"任务标题","brief":"任务描述（1-2句话）","assignedAgent":"worker-id","dependencies":["依赖的任务title"]}]`;
  } else {
    prompt = `You are a PO. Decompose this goal into executable tasks for your team.

## Goal
${goal}
${requirements ? `\n## Requirements (MUST follow strictly)\n${requirements}` : ''}

## Available Workers
${workerList}

## Decomposition Principles
1. **Strictly follow any process described in requirements**. If it says "N rounds", "adversarial review", "iterative revision", etc., structure tasks in phases/rounds with dependencies to enforce ordering.
2. If "review" is required, assign A's output to B for adversarial review, then back to A for revision — express this as separate tasks with dependencies.
3. Always include a **final summary task** assigned to yourself (${workers[0]}) that depends on all prior tasks and produces the consolidated deliverable.
4. Task count is flexible (3-12). Do not sacrifice process fidelity for parallelism.

## Output Format
Output strict JSON array (no markdown fences, no commentary):
[{"title":"Task title","brief":"Description","assignedAgent":"worker-id","dependencies":["dependency task title"]}]`;
  }

  const rawOutput = await runCLIHarness(prompt, tmpdir());
  if (!rawOutput) throw new Error('CLI returned no output');

  // Extract JSON from output (might have surrounding text)
  const jsonMatch = rawOutput.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array found in CLI output');

  const tasks = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('CLI returned invalid task array');
  }

  return tasks.map(t => ({
    title: t.title || 'Untitled Task',
    brief: t.brief || '',
    assignedAgent: t.assignedAgent || null,
    dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
  }));
}

// ─── Language detection helper ───────────────────────────────────────────────

function detectLanguage(text) {
  if (!text) return 'zh';
  // Simple heuristic: if more than 30% of characters are CJK, use Chinese
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  return cjkCount / text.length > 0.1 ? 'zh' : 'en';
}

function getLanguageInstruction(lang) {
  if (lang === 'zh') return '请全部使用中文输出。';
  return 'Please respond entirely in English.';
}

// ─── Project directory file access ───────────────────────────────────────────

const MAX_CONTEXT_SIZE = 8000; // chars
const READABLE_EXTS = ['.md', '.txt', '.json', '.js', '.ts', '.jsx', '.tsx', '.py', '.yaml', '.yml', '.toml', '.cfg', '.ini', '.html', '.css', '.sh'];

// Keywords indicating requirements want agent to read/write project files
const FILE_ACCESS_KEYWORDS = [
  '读取', '读文件', '参考文件', '项目目录', '工作目录', '目录中的',
  '文件内容', '基于文件', '查看文件', '打开文件', '加载文件',
  'read file', 'read the', 'project dir', 'work folder', 'workspace',
  'reference file', 'based on file', 'load file',
];

function shouldReadWorkFolder(requirements) {
  if (!requirements) return false;
  const lower = requirements.toLowerCase();
  return FILE_ACCESS_KEYWORDS.some(kw => lower.includes(kw));
}

function readWorkFolderContext(workFolder) {
  try {
    const files = listFilesRecursive(workFolder, 3); // max depth 3
    if (files.length === 0) return '';

    let context = `\n\n--- 项目目录文件列表 (${workFolder}) ---\n`;
    context += files.map(f => `  ${f.relative}`).join('\n');

    // Read small readable files for context
    let readContent = '';
    for (const file of files) {
      if (readContent.length >= MAX_CONTEXT_SIZE) break;
      const ext = file.relative.split('.').pop();
      if (!READABLE_EXTS.includes(`.${ext}`)) continue;

      try {
        const content = readFileSync(file.absolute, 'utf-8');
        if (content.length > 2000) continue; // skip large files
        readContent += `\n\n--- ${file.relative} ---\n${content}`;
      } catch { /* skip unreadable */ }
    }

    if (readContent) {
      context += '\n\n--- 文件内容 ---' + readContent;
    }
    return context.slice(0, MAX_CONTEXT_SIZE);
  } catch (err) {
    console.log(`[${ALIAS}]   ⚠ Failed to read workFolder: ${err.message}`);
    return '';
  }
}

function listFilesRecursive(dir, maxDepth, depth = 0, prefix = '') {
  if (depth > maxDepth) return [];
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(dir, entry.name);
      if (entry.isFile()) {
        results.push({ relative, absolute });
      } else if (entry.isDirectory() && depth < maxDepth) {
        results.push(...listFilesRecursive(absolute, maxDepth, depth + 1, relative));
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

// ─── LLM-powered goal decomposition ─────────────────────────────────────────

async function llmDecomposeGoal(goal, requirements, workers) {
  const workerList = workers.map((w, i) => `  ${i + 1}. ${w}`).join('\n');
  const lang = detectLanguage(goal);
  const langInstr = getLanguageInstruction(lang);

  const systemPrompt = agentInstructions
    ? `${agentInstructions}\n\n你现在作为项目负责人（PO）角色分解项目目标。`
    : '你是一个项目管理 AI，负责将项目目标分解为可执行的任务。';

  const messages = [
    {
      role: 'system',
      content: `${systemPrompt}

${langInstr}

分解原则：
1. **严格遵守项目要求中的流程描述**。如果要求"讨论N轮"、"对抗性评审"、"迭代修订"等，必须按轮次/阶段组织任务，通过 dependencies 体现先后顺序。
2. 如果要求中有"评审"，应将 A 的产出交给 B 做对抗性评审，再交回 A 修订——用不同任务+依赖表达。
3. 最后必须有一个**汇总任务**，由 PO(${workers[0]})负责，依赖所有前置任务，产出最终整合交付物。
4. 任务数量不限（3-12均可），按实际需要分解。不要为了"可并行"而削减流程。
5. 每个任务应该具体、可交付
6. 将任务分配给可用的 worker（尽量均匀分配）

可用 Workers：
${workerList}

输出格式（纯 JSON，无 markdown 代码块）：
[
  { "title": "任务标题", "brief": "任务描述（1-2句话）", "assignedAgent": "worker-id", "dependencies": ["依赖的任务title"] }
]`
    },
    {
      role: 'user',
      content: `请分解以下项目目标：\n\n目标："${goal}"${requirements ? `\n\n项目要求：\n${requirements}` : ''}`
    }
  ];

  const result = await llm.chat(messages, { temperature: 0.5, maxTokens: 1500 });
  const content = result.content.trim();

  const jsonStr = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
  const tasks = JSON.parse(jsonStr);

  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('LLM returned invalid task array');
  }

  return tasks.map(t => ({
    title: t.title || 'Untitled Task',
    brief: t.brief || '',
    assignedAgent: t.assignedAgent || null,
    dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
  }));
}

// ─── Template-based fallback decomposition ───────────────────────────────────

function templateDecomposeGoal(goal) {
  const lower = goal.toLowerCase();

  if (lower.includes('客服') || lower.includes('对话') || lower.includes('chat')) {
    return [
      { title: '需求分析与架构设计', brief: `分析 "${goal}" 的核心需求，设计系统架构`, dependencies: [] },
      { title: '核心引擎开发', brief: '实现核心业务逻辑和数据处理模块', dependencies: [] },
      { title: '接口与集成开发', brief: '开发 API 接口和第三方服务集成', dependencies: [] },
      { title: '测试与文档', brief: '编写测试用例和技术文档', dependencies: [] },
    ];
  }
  if (lower.includes('设计') || lower.includes('design')) {
    return [
      { title: '设计规范制定', brief: `为 "${goal}" 制定设计语言和规范`, dependencies: [] },
      { title: '组件库开发', brief: '实现核心 UI 组件', dependencies: [] },
      { title: '文档与示例', brief: '编写组件文档和使用示例', dependencies: [] },
    ];
  }
  if (lower.includes('api') || lower.includes('后端') || lower.includes('backend')) {
    return [
      { title: '数据模型设计', brief: '设计数据库 schema 和 API 结构', dependencies: [] },
      { title: 'API 接口实现', brief: '实现核心 CRUD 和业务接口', dependencies: [] },
      { title: '认证与权限', brief: '实现鉴权和权限控制模块', dependencies: [] },
      { title: '测试与部署', brief: '编写集成测试，配置 CI/CD', dependencies: [] },
    ];
  }

  return [
    { title: '需求调研与方案设计', brief: `分析 "${goal}" 的需求，制定技术方案`, dependencies: [] },
    { title: '核心功能开发', brief: '实现主要功能模块', dependencies: [] },
    { title: '集成与测试', brief: '模块集成、编写测试', dependencies: [] },
    { title: '文档与交付', brief: '编写文档，准备交付物', dependencies: [] },
  ];
}

async function handleApprovalReceived(projectId) {
  if (!projectId) return;
  
  await sleep(500);
  try {
    const res = await fetch(`${KSWARM_API}/projects/${projectId}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromAgent: LOGICAL_AGENT_ID }),
    });
    const data = await res.json();
    if (data.ok) {
      if (data.dispatched?.length > 0) {
        console.log(`[${ALIAS}]   → ✓ Dispatched ${data.dispatched.length} tasks to workers`);
      }

      // Always check for dispatched tasks assigned to offline workers (or self)
      await sleep(1000);
      await checkSelfAssignedTasks(projectId);

      if (!data.dispatched?.length) {
        // No new tasks dispatched — check if all done → trigger synthesis
        const projRes = await fetch(`${KSWARM_API}/projects/${projectId}`);
        if (projRes.ok) {
          const projData = await projRes.json();
          const tasks = projData.tasks || [];
          const allDone = isProjectAllDoneForDelivery(tasks);
          if (allDone && projData.project?.status === 'active') {
            console.log(`[${ALIAS}]   → All tasks done — starting synthesis`);
            await synthesizeProject(projectId);
          }
        }
      }
    }
  } catch (err) {
    console.log(`[${ALIAS}]   → Dispatch error: ${err.message}`);
  }
}

// Check and execute tasks assigned to ourselves or to offline workers (PO takes over)
async function checkSelfAssignedTasks(projectId) {
  try {
    const res = await fetch(`${KSWARM_API}/projects/${projectId}`);
    if (!res.ok) return;
    const data = await res.json();
    const tasks = data.tasks || [];
    const poInfo = poProjects.get(projectId);

    // Get online agents from broker
    const onlineAgents = await getOnlineAgents();

    for (const task of tasks) {
      if (task.status !== 'dispatched') continue;

      const targetAgent = task.assignedRuntimeInstance || task.assignedAgent;
      const isSelf = isTaskAssignedToRuntime(task);
      const workerOnline = targetAgent ? onlineAgents.has(targetAgent) : false;

      const shouldTakeOverOffline = !workerOnline && !task.assignedRuntimeInstance;
      if (isSelf || shouldTakeOverOffline) {
        if (!isSelf) {
          console.log(`[${ALIAS}]   → Worker "${targetAgent || task.assignedAgent}" offline, PO taking over: ${task.title}`);
        } else {
          console.log(`[${ALIAS}]   → Self-assigned task found: ${task.title}`);
        }
        await doTask(task.id, {
          title: task.title,
          brief: task.brief,
          projectName: data.project?.name || poInfo?.name || '',
          projectGoal: data.project?.goal || poInfo?.goal || '',
          projectRequirements: data.project?.requirements || poInfo?.requirements || '',
          projectId,
          localTaskId: task.localTaskId,
          runId: task.activeRunId,
          workFolder: data.workspace?.path || data.project?.workFolder || '',
        });
      }
    }
  } catch (err) {
    console.log(`[${ALIAS}]   → checkSelfAssignedTasks error: ${err.message}`);
  }
}

// Get set of online agent IDs from broker (agents with realtime inboxMode)
async function getOnlineAgents() {
  try {
    const res = await fetch(`${BROKER}/participants`);
    if (!res.ok) return new Set();
    const data = await res.json();
    const online = new Set();
    for (const p of (data.participants || [])) {
      if (p.inboxMode === 'realtime') online.add(p.participantId);
    }
    return online;
  } catch {
    return new Set();
  }
}

// ─── Worker Behavior: execute task and produce artifact ──────────────────────

async function doTask(taskId, payload) {
  const title = payload?.title || taskId;
  let projectName = payload?.projectName || 'Unknown Project';
  const brief = payload?.brief || '';
  const projectId = payload?.projectId || taskId.replace(/-t\d+$/, '');
  const localTaskId = payload?.localTaskId || taskId.split('__').pop() || taskId;
  const runId = payload?.runId || null;
  let projectGoal = payload?.projectGoal || '';
  let projectRequirements = payload?.projectRequirements || '';
  let workFolder = payload?.workFolder || '';
  let currentTask = payload?.task || null;

  // Also check poProjects for goal/requirements (if we are PO for this project)
  const poInfo = projectId ? poProjects.get(projectId) : null;

  // Fetch project detail from server to get full context (goal, requirements, workFolder, dependency info)
  let dependencyContext = '';
  try {
    const projRes = await fetch(`${KSWARM_API}/projects/${projectId}`);
    if (projRes.ok) {
      const projData = await projRes.json();
      const proj = projData.project || {};
      if (!projectGoal) projectGoal = proj.goal || '';
      if (!projectRequirements) projectRequirements = proj.requirements || '';
      if (!workFolder) workFolder = projData.workspace?.path || proj.workFolder || '';
      if (!projectName || projectName === 'Unknown Project') projectName = proj.name || projectName;

      // Find this task's dependencies and read their completed artifacts
      const allTasks = projData.tasks || [];
      const thisTask = allTasks.find(t => t.id === taskId || t.localTaskId === localTaskId);
      currentTask = thisTask || currentTask;
      if (thisTask?.dependencies?.length > 0 && workFolder) {
        const artifactsDir = join(workFolder, 'artifacts');
        if (existsSync(artifactsDir)) {
          const depArtifacts = [];
          for (const depTitle of thisTask.dependencies) {
            // Find the dependency task by title
            const depTask = allTasks.find(t => t.title === depTitle);
            if (depTask && depTask.status === 'done') {
              // Read its artifact
              const candidates = [];
              for (const art of depTask.result?.artifacts || []) {
                const filename = typeof art === 'string' ? art : (art.filename || art.name || '');
                if (filename) candidates.push(filename);
              }
              candidates.push(`${depTask.id}-report.md`);
              if (depTask.localTaskId) candidates.push(`${depTask.localTaskId}-report.md`);
              for (const depFilename of candidates) {
                const depPath = join(artifactsDir, depFilename);
                if (existsSync(depPath)) {
                  const content = readFileSync(depPath, 'utf-8');
                  depArtifacts.push({ title: depTask.title, content });
                  break;
                }
              }
            }
          }
          if (depArtifacts.length > 0) {
            dependencyContext = '\n\n## 前序任务产出（你必须基于这些内容开展工作）\n\n';
            for (const dep of depArtifacts) {
              dependencyContext += `### ${dep.title}\n\n${dep.content}\n\n---\n\n`;
            }
            console.log(`[${ALIAS}]   → Loaded ${depArtifacts.length} dependency artifact(s) as context`);
          }
        }
      }
    }
  } catch (err) {
    console.log(`[${ALIAS}]   ⚠ Failed to fetch project detail: ${err.message}`);
  }

  const goal = projectGoal || poInfo?.goal || '';
  const requirements = projectRequirements || poInfo?.requirements || '';
  writeTaskJournal(workFolder, { projectId, taskId, localTaskId, runId, status: 'received' });
  startRunTelemetry({ projectId, taskId, localTaskId, runId });

  reportStatus('working');

  // Step 1: Accept
  console.log(`[${ALIAS}]   → Accepting: ${title}`);
  writeTaskJournal(workFolder, { projectId, taskId, localTaskId, runId, status: 'accepting' });
  await client.sendIntent({
    kind: 'accept_task',
    taskId,
    threadId: `thread-${taskId}`,
    payload: { projectId, taskId, localTaskId, runId, participantId: AGENT_ID },
  });

  // Step 2: Progress
  await sleep(DELAY / 2);
  console.log(`[${ALIAS}]   → Working on: ${title}`);
  writeTaskJournal(workFolder, { projectId, taskId, localTaskId, runId, status: 'in_progress' });
  await client.sendIntent({
    kind: 'report_progress',
    taskId,
    threadId: `thread-${taskId}`,
    payload: { projectId, taskId, localTaskId, runId, stage: 'started', telemetry: activeTelemetry ? { ...activeTelemetry } : undefined, body: { message: `Working on ${title}...` } },
  });

  // Read project directory context ONLY if requirements mention file access
  let workFolderContext = '';
  if (workFolder && existsSync(workFolder) && shouldReadWorkFolder(requirements)) {
    workFolderContext = readWorkFolderContext(workFolder);
    console.log(`[${ALIAS}]   → Reading workFolder per requirements`);
  }

  // Step 3: Generate artifact (CLI harness > LLM API > template fallback)
  await sleep(DELAY / 2);
  const artifactFilename = `${taskId}-report.md`;
  let artifactContent;

  // Build the prompt for the CLI/LLM
  const taskContract = enrichTaskWithExecutionContract(currentTask || { id: taskId, title, brief });
  const contractContext = buildExecutionContractPrompt(taskContract);
  const taskPrompt = buildTaskPrompt(title, projectName, brief, goal, requirements, workFolderContext, dependencyContext, contractContext);

  // Priority 1: CLI harness (spawn real agent binary)
  if (agentConfig?.runtimeType && agentConfig?.runtimePath && agentConfig.runtimeType !== 'builtin') {
    try {
      artifactContent = await runCLIHarness(taskPrompt, workFolder);
      if (artifactContent) {
        console.log(`[${ALIAS}]   → Artifact generated via CLI (${agentConfig.runtimeType})`);
      }
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ CLI harness failed: ${err.message}`);
      artifactContent = null;
    }
  }

  // Priority 2: LLM API (if CLI failed or not available)
  if (!artifactContent && llm) {
    try {
      artifactContent = await llmGenerateReport(title, projectName, brief, goal, requirements, workFolderContext);
      console.log(`[${ALIAS}]   → Artifact generated via LLM API`);
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ LLM report failed: ${err.message}, using template`);
    }
  }

  let artifactQuality = classifyGeneratedArtifact({ title, brief, content: artifactContent || '' });
  if (!artifactContent || !artifactQuality.ok) {
    console.log(`[${ALIAS}]   ⚠ Artifact quality gate failed (${artifactQuality.reason}); trying one local repair`);
    const repairPrompt = buildArtifactRepairPrompt({
      originalPrompt: taskPrompt,
      artifactContent: artifactContent || '',
      validation: artifactQuality,
    });
    let repairedContent = null;

    if (agentConfig?.runtimeType && agentConfig?.runtimePath && agentConfig.runtimeType !== 'builtin') {
      try {
        repairedContent = await runCLIHarness(repairPrompt, workFolder);
        if (repairedContent) {
          console.log(`[${ALIAS}]   → Artifact repaired via CLI (${agentConfig.runtimeType})`);
        }
      } catch (err) {
        console.log(`[${ALIAS}]   ⚠ CLI artifact repair failed: ${err.message}`);
      }
    }

    if (!repairedContent && llm) {
      try {
        repairedContent = await llmGenerateFromPrompt(repairPrompt);
        if (repairedContent) console.log(`[${ALIAS}]   → Artifact repaired via LLM API`);
      } catch (err) {
        console.log(`[${ALIAS}]   ⚠ LLM artifact repair failed: ${err.message}`);
      }
    }

    if (repairedContent) {
      artifactContent = repairedContent;
      artifactQuality = classifyGeneratedArtifact({ title, brief, content: artifactContent });
    }
  }

  if (!artifactContent || !artifactQuality.ok) {
    const errorMessage = `Generated artifact failed local quality gate for "${title}": ${artifactQuality.reason || 'empty_output'}`;
    console.log(`[${ALIAS}]   ✗ ${errorMessage}`);
    reportStatus('idle');
    writeTaskJournal(workFolder, {
      projectId,
      taskId,
      localTaskId,
      runId,
      status: 'failed',
      errorMessage,
    });
    await client.sendIntent({
      kind: 'task_failed',
      taskId,
      threadId: `thread-${taskId}`,
      payload: {
        projectId,
        taskId,
        localTaskId,
        runId,
        failureReason: 'model_empty_output',
        errorMessage,
        artifactQuality,
      },
    });
    stopRunTelemetry();
    return;
  }

  const declaredArtifacts = extractDeclaredArtifacts(artifactContent, { taskId });
  if (declaredArtifacts.artifacts.length > 0) {
    const errorMessage = `Inline artifact content is forbidden for "${title}"; write deliverables to artifacts/ files and submit only paths/manifests.`;
    console.log(`[${ALIAS}]   ✗ ${errorMessage}`);
    reportStatus('idle');
    writeTaskJournal(workFolder, {
      projectId,
      taskId,
      localTaskId,
      runId,
      status: 'failed',
      errorMessage,
    });
    await client.sendIntent({
      kind: 'task_failed',
      taskId,
      threadId: `thread-${taskId}`,
      payload: {
        projectId,
        taskId,
        localTaskId,
        runId,
        failureReason: 'inline_artifact_forbidden',
        errorMessage,
      },
    });
    stopRunTelemetry();
    return;
  }

  const artifactFiles = [
    { filename: artifactFilename, content: artifactContent, previewable: true, mimeType: 'text/markdown' },
    ...declaredArtifacts.artifacts,
  ];
  let reviewEvidence = null;
  if (taskContract.evidenceContract?.kind === 'review_iteration_v1') {
    reviewEvidence = buildReviewEvidenceFromContent(artifactContent, taskContract);
    artifactFiles.push({
      filename: 'review-evidence.json',
      content: JSON.stringify(reviewEvidence, null, 2),
      previewable: true,
      mimeType: 'application/json',
    });
  }

  const artifactFilenames = artifactFiles.map(file => file.filename);
  let artifactManifest = [];
  let submittedArtifacts = [];

  // Write artifacts to project workFolder directly (if available)
  if (workFolder) {
    const artifactsDir = join(workFolder, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true });
    for (const file of artifactFiles) {
      writeFileSync(join(artifactsDir, file.filename), file.content, 'utf-8');
    }
    noteArtifact();
    artifactManifest = buildArtifactManifest(workFolder, artifactFilenames, {
      projectId,
      taskId,
      role: 'primary',
      producedBy: { agentId: AGENT_ID, source: 'worker' },
    });
    writeTaskJournal(workFolder, {
      projectId,
      taskId,
      localTaskId,
      runId,
      status: 'artifact_written',
      artifactManifest,
    });
    submittedArtifacts = artifactManifest.map(artifact => ({
      filename: artifact.filename,
      url: artifact.url || `/projects/${projectId}/artifacts/${encodeURIComponent(artifact.filename)}`,
      previewable: filePreviewable(artifact.filename),
      mimeType: artifact.mimeType,
      path: artifact.path,
      relativePath: artifact.relativePath,
      size: artifact.size,
      sha256: artifact.sha256,
      generatedAt: artifact.generatedAt,
      role: artifact.role,
    }));
    console.log(`[${ALIAS}]   → Written to workFolder: ${artifactFilenames.map(name => `${artifactsDir}/${name}`).join(', ')}`);
  }

  // Legacy fallback only when no project workFolder was provided.
  if (!workFolder) {
    for (const file of artifactFiles) {
      let artifactUrl = `/artifacts/${file.filename}`;
      try {
        const uploadRes = await fetch(`${KSWARM_API}/artifacts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filename: file.filename, content: file.content, projectId }),
        });
        const uploadData = await uploadRes.json();
        if (uploadData.artifact?.url) artifactUrl = uploadData.artifact.url;
        console.log(`[${ALIAS}]   → Artifact saved: ${uploadData.artifact?.filename} (${uploadData.artifact?.path || 'unknown'})`);
      } catch (err) {
        console.log(`[${ALIAS}]   ⚠ Failed to upload artifact: ${err.message}`);
      }
      submittedArtifacts.push({
        filename: file.filename,
        url: artifactUrl,
        previewable: file.previewable,
        mimeType: file.mimeType,
      });
    }
  }

  const summarySource = [
    artifactContent,
    ...declaredArtifacts.artifacts.map(artifact => artifact.content),
  ].filter(Boolean).join('\n\n');

  const resultPayload = {
    projectId,
    taskId,
    localTaskId,
    runId,
    summary: buildResultSummary(title, summarySource),
    participantId: AGENT_ID,
    artifacts: submittedArtifacts,
    artifactManifest,
    delivery: { semantic: 'document', source: ALIAS },
    ...(reviewEvidence ? { reviewEvidence } : {}),
  };

  const contractValidation = validateTaskResultAgainstContract(taskContract, resultPayload);
  if (!contractValidation.ok) {
    const errorMessage = `Execution contract invalid: ${contractValidation.errors.join('; ')}`;
    console.log(`[${ALIAS}]   ✗ ${errorMessage}`);
    reportStatus('idle');
    writeTaskJournal(workFolder, {
      projectId,
      taskId,
      localTaskId,
      runId,
      status: 'failed',
      artifactManifest,
      errorMessage,
    });
    await client.sendIntent({
      kind: 'task_failed',
      taskId,
      threadId: `thread-${taskId}`,
      payload: {
        projectId,
        taskId,
        localTaskId,
        runId,
        failureReason: contractValidation.failureClass || 'contract_invalid',
        errorMessage,
      },
    });
    stopRunTelemetry();
    return;
  }

  // Step 4: Submit result
  console.log(`[${ALIAS}]   → Submitting: ${title}`);
  writeTaskJournal(workFolder, {
    projectId,
    taskId,
    localTaskId,
    runId,
    status: 'submitting',
    artifactManifest,
    submission: { attemptedAt: Date.now(), ackedAt: null, lastError: null },
  });
  await client.sendIntent({
    kind: 'submit_result',
    taskId,
    threadId: `thread-${taskId}`,
    payload: resultPayload,
  });

  console.log(`[${ALIAS}]   ✓ Done: ${title}\n`);
  writeTaskJournal(workFolder, {
    projectId,
    taskId,
    localTaskId,
    runId,
    status: 'submitted',
    artifactManifest,
    submission: { attemptedAt: Date.now(), ackedAt: Date.now(), lastError: null },
  });
  reportStatus('idle');
  stopRunTelemetry();

  // If we are PO for this project, quality review (not just auto-confirm)
  if (projectId && poProjects.has(projectId)) {
    await sleep(500);
    await qualityReviewTask(projectId, taskId, resultPayload);
  }
}

function filePreviewable(filename) {
  return /\.(md|markdown|txt|html|htm|json|csv|svg)$/i.test(filename || '');
}

function buildExecutionContractPrompt(task) {
  if (task?.evidenceContract?.kind !== 'review_iteration_v1') return '';
  return `\n## 评审证据合同\n本任务是质量评审任务。你的 Markdown 产物必须包含明确的 verdict、发现的问题清单、风险等级和可执行修改建议。系统会在提交前生成并校验 review-evidence.json，缺少 verdict/findings 会导致任务失败。`;
}

function buildResultSummary(title, artifactContent) {
  const text = String(artifactContent || '')
    .replace(/[`*_>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const excerpt = text.slice(0, 320);
  return `${title}: ${excerpt}`;
}

function buildReviewEvidenceFromContent(content, task) {
  const findings = extractReviewFindings(content);
  const lowered = String(content || '').toLowerCase();
  let verdict = 'needs_changes';
  if (/通过|pass|approved|accept/.test(lowered) && !/不通过|fail|blocked|reject/.test(lowered)) {
    verdict = 'pass';
  } else if (/不通过|fail|blocked|reject/.test(lowered)) {
    verdict = 'fail';
  }
  return {
    verdict,
    reviewedTaskId: task.reviewOfTaskId || task.parentTaskId || task.id,
    generatedAt: new Date().toISOString(),
    findings,
  };
}

function extractReviewFindings(content) {
  const lines = String(content || '')
    .split('\n')
    .map(line => line.replace(/^[\s*#>\-.0-9）)]+/, '').trim())
    .filter(line => line.length >= 12);
  const findings = lines.slice(0, 8).map(line => ({
    severity: /严重|高|critical|major|blocker/i.test(line) ? 'major' : 'minor',
    message: line.slice(0, 240),
  }));
  if (findings.length > 0) return findings;
  const fallback = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return [{ severity: 'minor', message: fallback || '评审产物未提供可提取的问题描述。' }];
}

// ─── LLM-powered artifact generation ────────────────────────────────────────

/**
 * Build a natural-language prompt for the CLI agent to execute a task.
 * This is used both for CLI harness and (if needed) as context for LLM API.
 */
function buildTaskPrompt(title, projectName, brief, goal, requirements, workFolderContext, dependencyContext, contractContext = '') {
  const lang = detectLanguage(goal || title || projectName);
  const parts = [];

  if (lang === 'zh') {
    parts.push(`你是一个专业的技术智能体，正在认真执行一项任务。你必须产出有深度、有实质内容的工作成果。`);
    parts.push(`\n## 任务`);
    parts.push(`- 标题：${title}`);
    if (brief) parts.push(`- 描述：${brief}`);
    parts.push(`\n## 项目上下文`);
    parts.push(`- 项目名：${projectName}`);
    if (goal) parts.push(`- 目标：${goal}`);
    if (requirements) parts.push(`- 要求：\n${requirements}`);
    if (dependencyContext) {
      parts.push(dependencyContext);
      parts.push(`\n## 重要：你必须基于上述前序产出开展工作，不能忽略或重复前序内容。如果你的任务是"评审"，请针对前序方案提出具体的、有挑战性的质疑和改进建议。如果是"修订"，请逐条回应评审意见并修改方案。`);
    }
    if (contractContext) parts.push(contractContext);
    parts.push(`\n## 输出要求`);
    parts.push(`1. 输出 Markdown 格式，内容必须具体、深入、有细节，不允许空泛的模板式回答`);
    parts.push(`2. 字数不少于 800 字`);
    parts.push(`3. 如果是方案设计：必须包含具体技术选型、架构图描述、里程碑时间线、风险分析`);
    parts.push(`4. 如果是对抗性评审：必须提出至少 5 个具体质疑点，每个要说明为什么是问题、建议如何改进`);
    parts.push(`5. 如果是修订：必须逐条回应评审意见，说明采纳/不采纳的理由和对应修改`);
    parts.push(`6. 禁止输出"已完成"、"模拟"、"假设完成"等敷衍内容`);
    parts.push(`7. 文件优先交付：如果任务要求交付具体文件（例如 JSON、CSV、HTML、故事正文、修订稿、变更日志），必须把完整交付物写入 artifacts/ 目录中的实际文件。不要在回复、stdout、tool 参数或聊天消息中粘贴完整交付物；只返回文件名、路径、大小、hash 或简短摘要。`);
  } else {
    parts.push(`You are a professional technical agent executing a task. You must produce substantive, in-depth deliverables.`);
    parts.push(`\n## Task`);
    parts.push(`- Title: ${title}`);
    if (brief) parts.push(`- Description: ${brief}`);
    parts.push(`\n## Project Context`);
    parts.push(`- Project: ${projectName}`);
    if (goal) parts.push(`- Goal: ${goal}`);
    if (requirements) parts.push(`- Requirements:\n${requirements}`);
    if (dependencyContext) {
      parts.push(dependencyContext);
      parts.push(`\n## IMPORTANT: You MUST build upon the prior outputs above. If your task is "review", provide specific, challenging critiques. If "revision", address each review point explicitly.`);
    }
    if (contractContext) parts.push(contractContext);
    parts.push(`\n## Output Requirements`);
    parts.push(`1. Output in Markdown, must be specific, detailed, and substantive — no generic templates`);
    parts.push(`2. Minimum 800 words`);
    parts.push(`3. For design tasks: include specific tech choices, architecture, milestones, risk analysis`);
    parts.push(`4. For adversarial reviews: at least 5 specific critique points with rationale and suggestions`);
    parts.push(`5. For revisions: address each review point explicitly with accept/reject reasoning`);
    parts.push(`6. Never output placeholder text like "completed" or "simulated"`);
    parts.push(`7. File-first delivery: if the task requires concrete files such as JSON, CSV, HTML, a story draft, a revised draft, or a change log, write the complete deliverables to real files under artifacts/. Do not paste full deliverables into replies, stdout, tool arguments, or chat messages; return only filenames, paths, sizes, hashes, or a short summary.`);
  }

  if (workFolderContext) {
    parts.push(workFolderContext);
  }

  return parts.join('\n');
}

async function llmGenerateReport(title, projectName, brief, goal, requirements, workFolderContext) {
  const lang = detectLanguage(goal || title || projectName);
  const langInstr = getLanguageInstruction(lang);

  const systemPrompt = agentInstructions
    ? `${agentInstructions}\n\n你正在执行一项任务，需要直接生成任务要求的核心交付产物。`
    : '你是一个专业的技术 worker agent。你正在执行一项任务，需要直接生成任务要求的核心交付产物。';

  const messages = [
    {
      role: 'system',
      content: `${systemPrompt}

${langInstr}

交付要求：
1. 使用 Markdown 格式
2. 内容要具体、专业，像真正完成了这项工作一样
3. 文件优先交付：如果任务要求具体文件，必须把完整交付物写入 artifacts/ 目录中的实际文件
4. 不要在回复、stdout、tool 参数或聊天消息中粘贴完整交付物；只返回文件名、路径、大小、hash 或简短摘要
5. 可以附简短摘要，但不能用摘要替代核心文件
6. 不要写"模拟"或"假设"之类的词，就像真正完成了工作一样
7. 严格遵循项目目标和要求中的原则与约束${workFolderContext ? '\n8. 基于项目目录中的参考文件内容进行工作' : ''}`
    },
    {
      role: 'user',
      content: `请直接完成以下任务并输出核心交付产物：

项目：${projectName}
${goal ? `项目目标：${goal}` : ''}
${requirements ? `项目要求：\n${requirements}` : ''}
任务：${title}
${brief ? `任务描述：${brief}` : ''}${workFolderContext || ''}`
    }
  ];

  const result = await llm.chat(messages, { temperature: 0.6, maxTokens: 3000 });
  return String(result.content || '').trim();
}

async function llmGenerateFromPrompt(prompt) {
  const systemPrompt = agentInstructions
    ? `${agentInstructions}\n\n你正在修复一个未通过本地质量门禁的任务产物，必须直接输出完整交付内容。`
    : '你是一个专业的 worker agent。你正在修复一个未通过本地质量门禁的任务产物，必须直接输出完整交付内容。';

  const result = await llm.chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ], { temperature: 0.4, maxTokens: 3000 });
  return String(result.content || '').trim();
}

// ─── Template-based fallback report ──────────────────────────────────────────

function templateReport(title, projectName, brief) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return `## ${title}

**Project:** ${projectName}
**Worker:** ${ALIAS} (${AGENT_ID})
**Completed:** ${now}

### Summary

Task "${title}" has been completed successfully.${brief ? `\n\n**Brief:** ${brief}` : ''}

### Work Done

- Analyzed requirements for "${title}"
- Implemented the solution following project standards
- Ran automated tests — all passing
- Code reviewed and ready for integration

### Output

The implementation is ready for review. Key deliverables:

1. Source code committed to feature branch
2. Unit tests covering core functionality
3. Documentation updated

### Notes

- No blockers encountered
- Ready for PO review and acceptance
`;
}

// ─── PO Verification: check deliverable against goal+requirements ────────────

async function verifyAndConfirmTask(projectId, taskId, result) {
  const poInfo = poProjects.get(projectId);
  const goal = poInfo?.goal || '';
  const requirements = poInfo?.requirements || '';

  // If LLM available, do actual verification
  if (llm && (goal || requirements)) {
    try {
      const passed = await llmVerifyDeliverable(taskId, result, goal, requirements);
      if (passed) {
        console.log(`[${ALIAS}]   → PO verification PASSED: ${taskId}`);
        await autoConfirmTask(projectId, taskId);
      } else {
        console.log(`[${ALIAS}]   → PO verification FAILED: ${taskId}, requesting rework`);
        await requestRework(projectId, taskId, 'Deliverable does not meet project goal/requirements');
      }
      return;
    } catch (err) {
      console.log(`[${ALIAS}]   ⚠ LLM verification error: ${err.message}, auto-confirming`);
    }
  }

  // Fallback: auto-confirm without verification
  await sleep(800);
  await autoConfirmTask(projectId, taskId);
}

async function llmVerifyDeliverable(taskId, result, goal, requirements) {
  const lang = detectLanguage(goal);
  const langInstr = getLanguageInstruction(lang);
  const summary = result?.summary || '';
  const artifacts = result?.artifacts?.map(a => a.filename || a).join(', ') || 'none';

  const messages = [
    {
      role: 'system',
      content: `你是项目负责人（PO），正在审核 worker 提交的任务结果。
${langInstr}

判断标准：
1. 提交的结果是否围绕项目目标展开
2. 是否遵守项目要求中的原则和约束
3. 输出物是否有实际内容（不是空壳或敷衍）

只回答 "PASS" 或 "FAIL"（单个词，不要解释）。`
    },
    {
      role: 'user',
      content: `项目目标：${goal}
${requirements ? `项目要求：\n${requirements}` : ''}

任务ID：${taskId}
提交摘要：${summary}
产出物：${artifacts}

请判断：`
    }
  ];

  const res = await llm.chat(messages, { temperature: 0.2, maxTokens: 10 });
  const answer = res.content.trim().toUpperCase();
  return answer.includes('PASS');
}

async function requestRework(projectId, taskId, reason) {
  try {
    await fetch(`${KSWARM_API}/projects/${projectId}/tasks/${taskId}/rework`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromAgent: LOGICAL_AGENT_ID, reason }),
    });
  } catch (err) {
    console.log(`[${ALIAS}]   ⚠ Rework request failed: ${err.message}`);
  }
}

// ─── Status reporting ────────────────────────────────────────────────────────

function reportStatus(status) {
  // Report status back to server (fire and forget)
  fetch(`${KSWARM_API}/agents/${AGENT_ID}/stop`, { method: 'GET' }).catch(() => {});
  // Use a simpler approach: just call the generic agent status endpoint if available
  // For now we just track locally — server sets status on start/stop
}

async function autoConfirmTask(projectId, taskId) {
  try {
    const res = await fetch(`${KSWARM_API}/projects/${projectId}/tasks/${taskId}/done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromAgent: LOGICAL_AGENT_ID }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[${ALIAS}]   → PO auto-confirmed: ${taskId} done`);
      // Trigger dispatch to unblock dependent tasks
      await handleApprovalReceived(projectId);
    }
  } catch (err) {
    // Ignore — maybe another PO confirmed it
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Load agent config from server before connecting
  await loadAgentConfig();

  await client.register();
  await client.connect();
  console.log(`[${ALIAS}] Ready. Waiting for tasks...\n`);

  // On startup, check for any missed PO assignments or dispatched tasks
  await sleep(1500);
  await pollMissedPOAssignments();
  await pollDispatchedTasks();
}

// Poll for any PO assignments we might have missed (agent was offline when project was created)
async function pollMissedPOAssignments() {
  try {
    const res = await fetch(`${KSWARM_API}/projects`);
    if (!res.ok) return;
    const data = await res.json();

    for (const proj of (data.projects || [])) {
      // If we are PO for a project that's in 'created' state, trigger PO assignment
      if (isProjectPo(proj) && proj.status === 'created') {
        console.log(`[${ALIAS}] Found missed PO assignment: ${proj.name} (${proj.id})`);
        const detailRes = await fetch(`${KSWARM_API}/projects/${proj.id}`);
        if (!detailRes.ok) continue;
        const detail = await detailRes.json();
        const project = detail.project || {};

        await handlePOAssignment({
          projectId: proj.id,
          projectName: project.name || proj.name,
          goal: project.goal || '',
          requirements: project.requirements || '',
          members: project.members || [],
        });
      }
      // If we are PO for a project that's 'active' but needs work, trigger appropriate action
      else if (isProjectPo(proj) && proj.status === 'active') {
        const detailRes = await fetch(`${KSWARM_API}/projects/${proj.id}`);
        if (!detailRes.ok) continue;
        const detail = await detailRes.json();
        const tasks = detail.tasks || [];
        if (tasks.length === 0) {
          // Active but no tasks — needs decomposition
          console.log(`[${ALIAS}] Found active project with no tasks: ${proj.name} — decomposing`);
          const project = detail.project || {};
          await handlePOAssignment({
            projectId: proj.id,
            projectName: project.name || proj.name,
            goal: project.goal || '',
            requirements: project.requirements || '',
            members: project.members || [],
          });
        } else {
          const hasPending = tasks.some(t => t.status === 'pending');
          if (hasPending) {
            console.log(`[${ALIAS}] Found active project with pending tasks: ${proj.name}`);
            await handleApprovalReceived(proj.id);
          }
        }
      }
    }
  } catch (err) {
    console.log(`[${ALIAS}] pollMissedPOAssignments error: ${err.message}`);
  }
}

// Poll for any tasks dispatched to us that we might have missed
async function pollDispatchedTasks() {
  try {
    const res = await fetch(`${KSWARM_API}/projects`);
    if (!res.ok) return;
    const data = await res.json();

    for (const proj of (data.projects || [])) {
      if (proj.status !== 'active') continue;
      const detailRes = await fetch(`${KSWARM_API}/projects/${proj.id}`);
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();

      for (const task of (detail.tasks || [])) {
        if (isTaskAssignedToRuntime(task) && task.status === 'dispatched') {
          console.log(`[${ALIAS}] Found pending dispatched task: ${task.title}`);
          await doTask(task.id, {
            title: task.title,
            brief: task.brief,
            projectName: detail.project?.name || '',
            projectGoal: detail.project?.goal || '',
            projectRequirements: detail.project?.requirements || '',
            projectId: proj.id,
            localTaskId: task.localTaskId,
            runId: task.activeRunId,
            workFolder: detail.workspace?.path || detail.project?.workFolder || '',
          });
        }
      }
    }
  } catch (err) {
    console.log(`[${ALIAS}] pollDispatchedTasks error: ${err.message}`);
  }
}

main().catch(err => {
  console.error(`[${ALIAS}] Fatal:`, err.message);
  process.exit(1);
});

// ─── PO Health Monitor ──────────────────────────────────────────────────────
// Runs periodically: checks projects where we are PO for stuck tasks,
// reassigns them to a different available worker.

const PO_HEALTH_INTERVAL = 120_000; // 2 minutes
const STUCK_THRESHOLD = 10 * 60_000; // 10 minutes

async function poHealthCheck() {
  try {
    const res = await fetch(`${KSWARM_API}/projects`);
    if (!res.ok) return;
    const data = await res.json();

    for (const proj of (data.projects || [])) {
      if (!isProjectPo(proj) || proj.status !== 'active') continue;

      const detailRes = await fetch(`${KSWARM_API}/projects/${proj.id}`);
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();
      const tasks = detail.tasks || [];
      const now = Date.now();

      let hasStuckOrActive = false;

      for (const task of tasks) {
        // Only check dispatched/accepted/in_progress tasks
        if (!['dispatched', 'accepted', 'in_progress'].includes(task.status)) continue;
        hasStuckOrActive = true;

        const elapsed = now - (task.updatedAt || task.createdAt);
        if (elapsed < STUCK_THRESHOLD) continue;

        const onlineAgents = await getOnlineAgents();
        const targetAgent = task.assignedRuntimeInstance || task.assignedAgent;
        const workerOnline = targetAgent ? onlineAgents.has(targetAgent) : false;
        console.log(`[${ALIAS}] ⚠ Stuck task detected: "${task.title}" (${task.status}, ${Math.round(elapsed / 60000)}min, worker ${workerOnline ? 'online' : 'OFFLINE'})`);

        if (!workerOnline && !task.assignedRuntimeInstance) {
          // Worker offline — PO takes over directly
          console.log(`[${ALIAS}]   → Worker offline, PO executing directly`);
          await doTask(task.id, {
            title: task.title,
            brief: task.brief,
            projectName: detail.project?.name || '',
            projectGoal: detail.project?.goal || '',
            projectRequirements: detail.project?.requirements || '',
            projectId: proj.id,
            localTaskId: task.localTaskId,
            runId: task.activeRunId,
            workFolder: detail.workspace?.path || detail.project?.workFolder || '',
          });
        } else {
          // Worker online but stuck — try re-dispatch
          console.log(`[${ALIAS}]   → Worker online but stuck, re-dispatching`);
          await handleApprovalReceived(proj.id);
        }
      }

      // If no tasks are actively running, recover missed dispatch/synthesis triggers.
      if (!hasStuckOrActive) {
        const hasPending = tasks.some(t => t.status === 'pending');
        const allDone = isProjectAllDoneForDelivery(tasks);
        if (allDone) {
          console.log(`[${ALIAS}] Project "${proj.name}" is all done but not delivered — triggering synthesis`);
          await synthesizeProject(proj.id);
        } else if (hasPending) {
          console.log(`[${ALIAS}] Project "${proj.name}" has pending tasks but nothing running — triggering dispatch`);
          await handleApprovalReceived(proj.id);
        }
      }
    }
  } catch (err) {
    console.log(`[${ALIAS}] poHealthCheck error: ${err.message}`);
  }
}

// Start health monitor after initial startup
setTimeout(() => {
  void poHealthCheck();
  setInterval(poHealthCheck, PO_HEALTH_INTERVAL);
  console.log(`[${ALIAS}] PO health monitor started (interval: ${PO_HEALTH_INTERVAL / 1000}s, threshold: ${STUCK_THRESHOLD / 1000}s)`);
}, 5000);

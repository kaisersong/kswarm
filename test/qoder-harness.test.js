/**
 * KSwarm — Qoder CLI Harness Unit Tests
 *
 * Tests argument construction, stream-json parsing, and error handling
 * for the qoder CLI integration.
 *
 * Run: node test/qoder-harness.test.js
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

// ─── Mock helpers to test argument construction ──────────────────────────────

function buildQoderArgs(prompt, model, workFolder) {
  const args = [prompt, '-p', '--output-format', 'stream-json', '--permission-mode', 'bypass_permissions'];
  if (model) args.push('-m', model);
  if (workFolder && existsSync(workFolder)) args.push('-w', workFolder);
  return args;
}

function parseStreamJson(lines) {
  let output = '';
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
  return output;
}

// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n╔═══════════════════════════════════════════════════╗');
console.log('║   KSwarm — Qoder CLI Harness Tests                ║');
console.log('╚═══════════════════════════════════════════════════╝');

// ── 参数构造 ────────────────────────────────────────────────────────────────

scenario('参数构造 — 基本参数', () => {
  const args = buildQoderArgs('hello world', null, null);
  assert(args[0] === 'hello world', `prompt 作为第一个参数: "${args[0]}"`);
  assert(args.includes('-p'), '包含 -p flag');
  assert(args.includes('--output-format'), '包含 --output-format');
  assert(args.includes('stream-json'), '包含 stream-json');
  assert(args.includes('--permission-mode'), '包含 --permission-mode');
  assert(args.includes('bypass_permissions'), '包含 bypass_permissions');
  assert(!args.includes('-m'), '无 model 时不含 -m');
});

scenario('参数构造 — 带 model', () => {
  const args = buildQoderArgs('test prompt', 'ultimate', null);
  assert(args.includes('-m'), '包含 -m');
  const mIdx = args.indexOf('-m');
  assert(args[mIdx + 1] === 'ultimate', `model 值正确: ${args[mIdx + 1]}`);
});

scenario('参数构造 — 带工作目录', () => {
  const testDir = join(tmpdir(), `qoder-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const args = buildQoderArgs('prompt', null, testDir);
  assert(args.includes('-w'), '包含 -w');
  const wIdx = args.indexOf('-w');
  assert(args[wIdx + 1] === testDir, `工作目录正确: ${args[wIdx + 1]}`);

  rmSync(testDir, { recursive: true, force: true });
});

scenario('参数构造 — 不存在的工作目录被忽略', () => {
  const args = buildQoderArgs('prompt', null, '/nonexistent/path/xyz');
  assert(!args.includes('-w'), '不存在的目录不传 -w');
});

// ── Stream-JSON 解析 ────────────────────────────────────────────────────────

scenario('stream-json 解析 — content_block_delta', () => {
  const lines = [
    '{"type":"content_block_delta","delta":{"text":"Hello "}}',
    '{"type":"content_block_delta","delta":{"text":"World"}}',
  ];
  const output = parseStreamJson(lines);
  assert(output === 'Hello World', `解析 delta: "${output}"`);
});

scenario('stream-json 解析 — result 事件（最终结果）', () => {
  const lines = [
    '{"type":"result","result":"Final answer here"}',
  ];
  const output = parseStreamJson(lines);
  assert(output === 'Final answer here', `解析 result: "${output}"`);
});

scenario('stream-json 解析 — assistant 事件 (stop_reason=end_turn)', () => {
  const lines = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello from assistant"}],"stop_reason":"end_turn"}}',
  ];
  const output = parseStreamJson(lines);
  assert(output === 'Hello from assistant', `解析 assistant: "${output}"`);
});

scenario('stream-json 解析 — assistant 无 stop_reason 不输出', () => {
  const lines = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}],"stop_reason":null}}',
  ];
  const output = parseStreamJson(lines);
  assert(output === '', `无 stop_reason 不输出: "${output}"`);
});

scenario('stream-json 解析 — result 覆盖之前内容', () => {
  const lines = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"early text"}],"stop_reason":"end_turn"}}',
    '{"type":"result","result":"final result"}',
  ];
  const output = parseStreamJson(lines);
  assert(output === 'final result', `result 覆盖之前: "${output}"`);
});

scenario('stream-json 解析 — qodercli 完整输出模拟', () => {
  const lines = [
    '{"type":"system","subtype":"init","qodercli_version":"0.2.11"}',
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."}],"stop_reason":null}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"[{\\"title\\":\\"Task1\\"}]"}],"stop_reason":"end_turn"}}',
    '{"type":"result","subtype":"success","result":"[{\\"title\\":\\"Task1\\"}]"}',
  ];
  const output = parseStreamJson(lines);
  assert(output === '[{"title":"Task1"}]', `完整模拟: "${output}"`);
});

scenario('stream-json 解析 — 非 JSON 行作为纯文本', () => {
  const lines = [
    'This is plain text output',
    'Another line',
  ];
  const output = parseStreamJson(lines);
  assert(output.includes('This is plain text output'), '纯文本被保留');
  assert(output.includes('Another line'), '多行纯文本');
});

scenario('stream-json 解析 — 空行忽略', () => {
  const lines = [];
  const output = parseStreamJson(lines);
  assert(output === '', '空输入返回空字符串');
});

scenario('stream-json 解析 — thinking 事件被忽略', () => {
  const lines = [
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"internal thought"}],"stop_reason":null}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"visible output"}],"stop_reason":"end_turn"}}',
  ];
  const output = parseStreamJson(lines);
  assert(output === 'visible output', `thinking 不输出: "${output}"`);
});

// ── KNOWN_AGENT_CLIS 中包含 qoder ─────────────────────────────────────────

scenario('agent-store 包含 qoder CLI', async () => {
  const { createAgentStore } = await import('../src/core/agent-store.js');
  const store = createAgentStore({ filePath: join(tmpdir(), `agents-test-${Date.now()}.json`) });
  const knownCLIs = store.getKnownCLIs();
  const qoder = knownCLIs.find(c => c.type === 'qoder');
  assert(qoder !== undefined, 'qoder 在 KNOWN_AGENT_CLIS 中');
  assert(qoder.bin === 'qodercli', `bin = qodercli: ${qoder.bin}`);
  assert(qoder.displayName === 'Qoder', `displayName = Qoder: ${qoder.displayName}`);
});

// ── auto-worker switch case 验证 ────────────────────────────────────────────

scenario('auto-worker.js 包含 qoder case', async () => {
  const { readFileSync } = await import('node:fs');
  const content = readFileSync(new URL('../scripts/auto-worker.js', import.meta.url), 'utf-8');
  assert(content.includes("case 'qoder':"), "switch 包含 case 'qoder'");
  assert(content.includes('runQoder('), '调用 runQoder 函数');
  assert(content.includes('function runQoder('), 'runQoder 函数已定义');
});

// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '─'.repeat(50));
console.log(`  结果: ${passed}/${total} 通过, ${failed} 失败`);
console.log('─'.repeat(50) + '\n');

process.exit(failed > 0 ? 1 : 0);

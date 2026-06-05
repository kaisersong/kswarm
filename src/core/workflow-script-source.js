/**
 * workflow-script-source — KSwarm 侧动态工作流脚本源归一化与哈希
 *
 * 必须与 desktop 端 `workflow-script-contract.ts` 的 normalizeWorkflowScript /
 * hashWorkflowScript 保持**字节级一致**：
 * - normalize：trim → 若整体被 ```js/```javascript fence 包裹则取 fence 内文本再 trim
 * - hash：对归一化后文本取 SHA-256（hex）
 *
 * 两端用同一组共享测试向量（test/workflow-script-source.test.js）锁定一致性。
 * 任一端修改归一化规则都必须同步另一端，否则 resume 时 hash 永久 mismatch。
 */

import { createHash } from 'node:crypto';

const FENCE_PATTERN = /^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i;

export function normalizeWorkflowScript(script) {
  if (typeof script !== 'string') {
    const error = new Error('workflow script must be a string');
    error.code = 'workflow_script_required';
    throw error;
  }
  let text = script.trim();
  const fence = text.match(FENCE_PATTERN);
  if (fence) text = fence[1].trim();
  return text;
}

export function hashWorkflowScript(script) {
  return createHash('sha256').update(script).digest('hex');
}

/**
 * 对原始脚本源做归一化并返回 { source, scriptHash }。
 * source 为归一化后的文本（用于持久化），scriptHash 为其 SHA-256。
 */
export function normalizeAndHashWorkflowScript(script) {
  const source = normalizeWorkflowScript(script);
  return { source, scriptHash: hashWorkflowScript(source) };
}

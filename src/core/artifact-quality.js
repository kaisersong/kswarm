const TASK_LEVEL_FAILURE_CLASS = 'model_empty_output';

const CONTENT_HEAVY_PATTERNS = [
  /报告|分析|研究|方案|评审|草稿|文档|文章|总结|故事|脚本|复盘/,
  /\b(report|analysis|research|plan|proposal|review|draft|document|article|summary|story|script)\b/i,
];

const PLACEHOLDER_PATTERNS = [
  /^(已完成|完成|done|completed|ok)$/i,
  /模拟|假设完成|placeholder|todo/i,
];

const CONTENT_HEAVY_MIN_CHARS = 180;
const GENERAL_MIN_CHARS = 3;

export function isContentHeavyTask(task = {}) {
  const text = `${task.title || ''}\n${task.brief || ''}`.trim();
  if (!text) return false;
  return CONTENT_HEAVY_PATTERNS.some(pattern => pattern.test(text));
}

export function classifyGeneratedArtifact({ title = '', brief = '', content = '' } = {}) {
  const raw = typeof content === 'string' ? content : '';
  const fence = validateArtifactFences(raw);
  if (!fence.ok) {
    return failure('artifact_fence_unclosed', {
      artifactFenceOpenCount: fence.openCount,
      artifactFenceCloseCount: fence.closeCount,
    });
  }

  const visible = normalizeVisibleText(raw);
  const charCount = visible.length;
  const heavy = isContentHeavyTask({ title, brief });

  if (charCount < GENERAL_MIN_CHARS) {
    return failure('empty_content', { charCount, minChars: GENERAL_MIN_CHARS, contentHeavy: heavy });
  }

  if (PLACEHOLDER_PATTERNS.some(pattern => pattern.test(visible))) {
    return failure('placeholder_content', { charCount, contentHeavy: heavy });
  }

  if (heavy && charCount < CONTENT_HEAVY_MIN_CHARS) {
    return failure('content_too_short', {
      charCount,
      minChars: CONTENT_HEAVY_MIN_CHARS,
      contentHeavy: true,
    });
  }

  return {
    ok: true,
    failureClass: null,
    reason: null,
    message: null,
    details: {
      charCount,
      contentHeavy: heavy,
    },
  };
}

export function buildArtifactRepairPrompt({
  originalPrompt = '',
  artifactContent = '',
  validation = {},
} = {}) {
  const reason = validation.reason || 'quality_gate_failed';
  const details = validation.details ? JSON.stringify(validation.details, null, 2) : '{}';
  const previous = String(artifactContent || '').trim();
  return `${originalPrompt}

## Local artifact quality gate failed

The previous output was not submitted because it failed the local quality gate.

- Failure class: ${validation.failureClass || TASK_LEVEL_FAILURE_CLASS}
- Reason: ${reason}
- Details: ${details}

Regenerate the task deliverable now. The new output must be substantive, complete, and directly usable. Do not return only a title, date, acknowledgement, placeholder, or summary.

## Previous rejected output

${previous ? previous.slice(0, 4000) : '(empty output)'}`;
}

function failure(reason, details = {}) {
  return {
    ok: false,
    failureClass: TASK_LEVEL_FAILURE_CLASS,
    reason,
    message: `Generated artifact rejected by local quality gate: ${reason}`,
    details,
  };
}

function validateArtifactFences(content) {
  const lines = String(content || '').split(/\r?\n/);
  let open = false;
  let openCount = 0;
  let closeCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!open && /^~~~artifact\b/i.test(trimmed)) {
      open = true;
      openCount += 1;
      continue;
    }
    if (open && trimmed === '~~~') {
      open = false;
      closeCount += 1;
    }
  }
  return { ok: !open, openCount, closeCount };
}

function normalizeVisibleText(content) {
  return String(content || '')
    .replace(/^~~~artifact\b[^\n]*$/gim, '')
    .replace(/^~~~$/gm, '')
    .replace(/```[\s\S]*?```/g, block => block.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''))
    .replace(/[#>*_`~\-[\](){}|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

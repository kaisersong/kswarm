export function superviseTaskFailure(task = {}, failure = {}, options = {}) {
  const source = failure.source || 'runtime';
  const failureClass = failure.failureClass || 'agent_error';

  if (source === 'quality_review') {
    return superviseQualityFailure(task, failure, options);
  }
  return superviseRuntimeFailure(task, failure, options);
}

function superviseQualityFailure(task, failure, options) {
  const maxReworks = options.maxQualityReworks ?? task.maxQualityReworks ?? 1;
  const qualityFailureCount = (task.qualityFailureCount || 0) + 1;
  const feedback = failure.feedback || failure.errorMessage || '质量验收未通过';

  if (qualityFailureCount > maxReworks) {
    return {
      action: 'block',
      blockKind: 'quality_gate_blocked',
      qualityFailureCount,
      failureClass: failure.failureClass || 'quality_content_failed',
      blockedReason: feedback,
      nextActions: [
        '人工确认验收标准或补充缺失证据',
        '必要时调整任务拆分或更换执行 agent',
      ],
    };
  }

  return {
    action: 'rework',
    qualityFailureCount,
    failureClass: failure.failureClass || 'quality_content_failed',
    feedback,
    nextActions: [
      '补充缺失证据、产物链接和验收说明后重新提交',
      '返工提交必须覆盖本次评审反馈',
    ],
  };
}

function superviseRuntimeFailure(task, failure, options) {
  const attempt = task.attempt || 1;
  const maxAttempts = options.maxAttempts ?? task.maxAttempts ?? 2;
  const runtimeFailureCount = (task.runtimeFailureCount || 0) + 1;
  const feedback = failure.feedback || failure.errorMessage || 'agent 执行失败';

  if (attempt < maxAttempts) {
    return {
      action: 'retry',
      runtimeFailureCount,
      failureClass: failure.failureClass || 'agent_error',
      feedback,
      nextActions: ['自动创建重试任务并保留原 run 的失败证据'],
    };
  }

  return {
    action: 'block',
    blockKind: 'runtime_exhausted',
    runtimeFailureCount,
    failureClass: failure.failureClass || 'agent_error',
    blockedReason: feedback,
    nextActions: [
      '人工检查 agent 运行环境、鉴权和产物目录',
      '修复后手动恢复或重新派发任务',
    ],
  };
}

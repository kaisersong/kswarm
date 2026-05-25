export function superviseTaskFailure(task = {}, failure = {}, options = {}) {
  const source = failure.source || 'runtime';
  const failureClass = failure.failureClass || 'agent_error';

  if (source === 'quality_review') {
    return superviseQualityFailure(task, failure, options);
  }
  return superviseRuntimeFailure(task, failure, options);
}

function superviseQualityFailure(task, failure, options) {
  const maxReworks = options.maxQualityReworks ?? task.maxQualityReworks ?? 2;
  const qualityFailureCount = (task.qualityFailureCount || 0) + 1;
  const feedback = failure.feedback || failure.errorMessage || '质量验收未通过';

  if (isTemporalAcceptanceImpossible(feedback, options.now ?? Date.now())) {
    return {
      action: 'block',
      blockKind: 'plan_revision_required',
      qualityFailureCount,
      failureClass: 'quality_temporal_impossible',
      blockedReason: feedback,
      nextActions: [
        '修订计划：将当前任务验收范围限定为当前日期及以前',
        '如果需要完整自然月数据，设置后续更新或等待月份结束后再执行',
      ],
    };
  }

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

export function isTemporalAcceptanceImpossible(feedback, nowMs) {
  const text = String(feedback || '');
  if (!/(缺少|补齐|补充|覆盖|完整|未满足|无法验证|missing|complete|cover)/iu.test(text)) return false;
  const now = new Date(nowMs);
  if (Number.isNaN(now.getTime())) return false;

  if (hasFutureChineseDateReference(text, now)) return true;
  if (hasFutureIsoDateReference(text, now)) return true;
  return hasFutureMonthCompletionReference(text, now);
}

function hasFutureChineseDateReference(text, now) {
  const currentYear = now.getUTCFullYear();
  const datePattern = /(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?\s*(?:[-~—至到]\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*(?:日|号)?)?/giu;
  for (const match of text.matchAll(datePattern)) {
    const startMonth = Number(match[1]);
    const startDay = Number(match[2]);
    const endMonth = Number(match[3] || match[1]);
    const endDay = Number(match[4] || match[2]);
    if (isFutureUtcDate(currentYear, startMonth, startDay, now)) return true;
    if (isFutureUtcDate(currentYear, endMonth, endDay, now)) return true;
  }
  return false;
}

function hasFutureIsoDateReference(text, now) {
  const isoPattern = /(\d{4})-(\d{1,2})-(\d{1,2})/gu;
  for (const match of text.matchAll(isoPattern)) {
    if (isFutureUtcDate(Number(match[1]), Number(match[2]), Number(match[3]), now)) return true;
  }
  return false;
}

function hasFutureMonthCompletionReference(text, now) {
  const monthPattern = /(\d{1,2})\s*月份?/gu;
  for (const match of text.matchAll(monthPattern)) {
    const month = Number(match[1]);
    if (!Number.isInteger(month) || month < 1 || month > 12) continue;
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), month, 0, 23, 59, 59, 999));
    if (monthEnd <= now) continue;
    const index = match.index || 0;
    const nearby = text.slice(Math.max(0, index - 8), index + match[0].length + 12);
    const monthNumber = String(month);
    const completionNearMonth = new RegExp(
      `(?:整个月|整个|完整|全月|整月|31\\s*天|30\\s*天).{0,6}${monthNumber}\\s*月份?|${monthNumber}\\s*月份?.{0,8}(?:整个月|整个|完整|全月|整月|31\\s*天|30\\s*天)`,
      'u',
    );
    if (completionNearMonth.test(nearby)) return true;
  }
  return false;
}

function isFutureUtcDate(year, month, day, now) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  return date > now;
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

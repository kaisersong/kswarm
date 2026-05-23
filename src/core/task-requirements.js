const EXPLICIT_OUTPUT_PATTERNS = [
  { type: 'pptx', pattern: /(\.pptx\b|\bpptx\b|\bpowerpoint\b|\bppt\s*(文件|file|deck)?\b)/i },
  { type: 'markdown', pattern: /(\.md\b|\.markdown\b|\bmarkdown\b)/i },
  { type: 'html', pattern: /(\.html?\b|\bhtml\b|网页报告)/i },
];

const SLIDE_OUTPUT_PATTERN = /(幻灯片|演示文稿|slide deck|slides|presentation)/i;
const REPORT_OUTPUT_PATTERN = /(报告|\breport\b)/i;
const REPORT_RENDERER_PATTERN = /(report\s+renderer|kai-report-creator|报告\s*renderer)/i;
const SLIDE_RENDERER_PATTERN = /(slide\s+renderer|kai-slide-creator|幻灯片\s*renderer)/i;
const FINAL_OUTPUT_PATTERN = /(最终|定稿|交付|输出|生成|制作|创建|撰写|成稿|render|final|deliver|delivery|generate|create|produce|write)/i;
const INTERMEDIATE_CONTENT_PATTERN = /(背景|素材|资料|收集|采集|调研|初稿|草稿|大纲|提纲|source|sources|background|material|collect|draft|outline)/i;
const INTERMEDIATE_STRUCTURE_PATTERN = /(框架设计|报告框架|结构规划|章节规划|大纲|提纲|outline|framework|structure plan)/i;
const REVIEW_TASK_PATTERN = /(评审|审核|验收|质检|review|audit|qa|quality)/i;
const SPEECH_CONTENT_PATTERN = /(演讲稿|演讲报告)/i;

export function inferTaskRequirements(task = {}, project = {}) {
  const text = collectTaskText(task, project);
  const requiredOutputs = normalizeOutputs(task.requiredOutputs);
  const requiredCapabilities = normalizeCapabilities(task.requiredCapabilities);

  if (shouldNormalizeReportRendererOutputs(text, requiredOutputs)) {
    removeHardOutputs(requiredOutputs, ['markdown', 'html']);
  }
  if (shouldNormalizeIntermediateReportPlanningOutputs(text, requiredOutputs)) {
    removeHardOutputs(requiredOutputs, ['html', 'report_html']);
  }

  for (const { type, pattern } of EXPLICIT_OUTPUT_PATTERNS) {
    if (pattern.test(text)) {
      if (type === 'html' && shouldReserveHtmlForSemanticRenderer(text, requiredOutputs)) continue;
      if (type === 'html' && shouldTreatHtmlAsIntermediateReportContext(text, requiredOutputs)) continue;
      if (type === 'html' && shouldTreatHtmlAsReviewSubject(text, requiredOutputs)) continue;
      if (type === 'markdown' && shouldTreatMarkdownAsRendererInput(text, requiredOutputs)) continue;
      addOutput(requiredOutputs, { type, enforcement: 'hard', source: 'explicit' });
      if (type === 'pptx') addCapability(requiredCapabilities, 'presentation_generation');
    }
  }

  if (shouldInferReportHtml(text, requiredOutputs)) {
    addOutput(requiredOutputs, { type: 'report_html', enforcement: 'hard', source: 'inferred' });
    addCapability(requiredCapabilities, 'report_generation');
  }

  if (shouldInferSlideHtml(text, requiredOutputs)) {
    addOutput(requiredOutputs, { type: 'slide_html', enforcement: 'hard', source: 'inferred' });
    addCapability(requiredCapabilities, 'slide_generation');
  } else if (!requiredOutputs.some(output => output.type === 'pptx') && SPEECH_CONTENT_PATTERN.test(text)) {
    addOutput(requiredOutputs, { type: 'presentation_content', enforcement: 'soft', source: 'inferred' });
    addCapability(requiredCapabilities, 'presentation_content');
  }

  if (shouldNormalizeReviewReportOutputs(text, requiredOutputs)) {
    removeHardOutputs(requiredOutputs, ['html', 'report_html']);
  }

  return {
    requiredOutputs,
    requiredCapabilities,
  };
}

function shouldInferReportHtml(text, requiredOutputs) {
  if (!REPORT_OUTPUT_PATTERN.test(text)) return false;
  if (REVIEW_TASK_PATTERN.test(text)) return false;
  if (!isFinalOutputTask(text) && !isFinalRendererOutputTask(text, REPORT_RENDERER_PATTERN)) return false;
  if (hasAnyHardOutput(requiredOutputs)) return false;
  if (hasHardOutput(requiredOutputs, ['markdown', 'pptx', 'report_html', 'slide_html'])) return false;
  return true;
}

function shouldInferSlideHtml(text, requiredOutputs) {
  if (!SLIDE_OUTPUT_PATTERN.test(text)) return false;
  if (REVIEW_TASK_PATTERN.test(text)) return false;
  if (hasSlideNegation(text)) return false;
  if (!isFinalOutputTask(text) && !isFinalRendererOutputTask(text, SLIDE_RENDERER_PATTERN)) return false;
  if (hasAnyHardOutput(requiredOutputs)) return false;
  if (hasHardOutput(requiredOutputs, ['markdown', 'pptx', 'slide_html'])) return false;
  return true;
}

function shouldReserveHtmlForSemanticRenderer(text, requiredOutputs) {
  if (hasHardOutput(requiredOutputs, ['markdown', 'pptx'])) return false;
  return (
    ((SLIDE_OUTPUT_PATTERN.test(text) || SLIDE_RENDERER_PATTERN.test(text)) && !hasSlideNegation(text) && (isFinalOutputTask(text) || isFinalRendererOutputTask(text, SLIDE_RENDERER_PATTERN))) ||
    ((REPORT_OUTPUT_PATTERN.test(text) || REPORT_RENDERER_PATTERN.test(text)) && (isFinalOutputTask(text) || isFinalRendererOutputTask(text, REPORT_RENDERER_PATTERN)))
  );
}

function shouldTreatMarkdownAsRendererInput(text, requiredOutputs) {
  if (hasHardOutput(requiredOutputs, ['pptx'])) return false;
  return (
    REPORT_RENDERER_PATTERN.test(text) &&
    /html/i.test(text) &&
    (isFinalOutputTask(text) || isFinalRendererOutputTask(text, REPORT_RENDERER_PATTERN))
  );
}

function shouldNormalizeReportRendererOutputs(text, requiredOutputs) {
  return (
    REPORT_RENDERER_PATTERN.test(text) &&
    /html/i.test(text) &&
    (isFinalOutputTask(text) || isFinalRendererOutputTask(text, REPORT_RENDERER_PATTERN)) &&
    hasHardOutput(requiredOutputs, ['markdown', 'html'])
  );
}

function shouldNormalizeIntermediateReportPlanningOutputs(text, requiredOutputs) {
  return shouldTreatHtmlAsIntermediateReportContext(text, requiredOutputs) &&
    hasHardOutput(requiredOutputs, ['html', 'report_html']);
}

function shouldTreatHtmlAsIntermediateReportContext(text, requiredOutputs) {
  return (
    REPORT_OUTPUT_PATTERN.test(text) &&
    /html/i.test(text) &&
    INTERMEDIATE_STRUCTURE_PATTERN.test(text) &&
    (/\bmarkdown\b|\.md\b|（markdown）|\(markdown\)/i.test(text) || hasHardOutput(requiredOutputs, ['markdown'])) &&
    !hasExplicitDualMarkdownHtmlRequest(text)
  );
}

function shouldTreatHtmlAsReviewSubject(text, requiredOutputs) {
  return (
    REVIEW_TASK_PATTERN.test(text) &&
    /html/i.test(text) &&
    (/\bmarkdown\b|\.md\b|（markdown）|\(markdown\)|评审报告|review report/i.test(text) || hasHardOutput(requiredOutputs, ['markdown'])) &&
    !hasExplicitHtmlReviewDeliverableRequest(text)
  );
}

function shouldNormalizeReviewReportOutputs(text, requiredOutputs) {
  return (
    shouldTreatHtmlAsReviewSubject(text, requiredOutputs) &&
    hasHardOutput(requiredOutputs, ['markdown'])
  );
}

function hasExplicitHtmlReviewDeliverableRequest(text) {
  return /(评审报告|review report).{0,16}(html|\.html?)|(html|\.html?).{0,16}(评审报告|review report)/i.test(text) &&
    !/(评审报告|review report).{0,16}(markdown|\.md)|(markdown|\.md).{0,16}(评审报告|review report)/i.test(text);
}

function hasExplicitDualMarkdownHtmlRequest(text) {
  return /(同时|分别|都|both|also).{0,16}(markdown|\.md).{0,16}(html|\.html?)|(markdown|\.md).{0,16}(和|与|及|and|&).{0,16}(html|\.html?)/i.test(text);
}

function hasSlideNegation(text) {
  return /(不|无需|不要|不需要|不是).{0,8}(幻灯片|演示文稿|slide deck|slides|presentation)/i.test(text);
}

function isFinalOutputTask(text) {
  return FINAL_OUTPUT_PATTERN.test(text) && !INTERMEDIATE_CONTENT_PATTERN.test(text);
}

function isFinalRendererOutputTask(text, rendererPattern) {
  return rendererPattern.test(text) && /html/i.test(text) && FINAL_OUTPUT_PATTERN.test(text);
}

function hasHardOutput(outputs, types) {
  const set = new Set(types);
  return outputs.some(output => set.has(output.type) && output.enforcement !== 'soft');
}

function hasAnyHardOutput(outputs) {
  return outputs.some(output => output.enforcement !== 'soft');
}

function removeHardOutputs(outputs, types) {
  const set = new Set(types);
  for (let i = outputs.length - 1; i >= 0; i -= 1) {
    if (set.has(outputs[i]?.type) && outputs[i]?.enforcement !== 'soft') outputs.splice(i, 1);
  }
}

function collectTaskText(task, project) {
  const parts = [
    task.title,
    task.brief,
    task.description,
    task.requirements,
    project.goal,
    project.requirements,
  ];

  if (Array.isArray(task.acceptanceCriteria)) parts.push(...task.acceptanceCriteria);
  else if (typeof task.acceptanceCriteria === 'string') parts.push(task.acceptanceCriteria);
  if (Array.isArray(project.acceptanceCriteria)) parts.push(...project.acceptanceCriteria);
  else if (typeof project.acceptanceCriteria === 'string') parts.push(project.acceptanceCriteria);
  if (project.deliverable) {
    if (typeof project.deliverable === 'string') parts.push(project.deliverable);
    else parts.push(project.deliverable.description, ...(project.deliverable.expectedArtifacts || []));
  }

  return parts.filter(Boolean).join('\n');
}

function normalizeOutputs(outputs = []) {
  if (!Array.isArray(outputs)) return [];
  const normalized = [];
  for (const output of outputs) {
    if (!output) continue;
    const item = typeof output === 'string'
      ? { type: output, enforcement: 'hard', source: 'task' }
      : {
          type: output.type || output.format || output.kind,
          enforcement: output.enforcement || 'hard',
          source: output.source || 'task',
        };
    if (!item.type) continue;
    addOutput(normalized, item);
  }
  return normalized;
}

function addOutput(outputs, output) {
  const type = String(output.type || '').trim().toLowerCase();
  if (!type) return;
  if (outputs.some(existing => existing.type === type)) return;
  outputs.push({
    type,
    enforcement: output.enforcement || 'hard',
    source: output.source || 'inferred',
  });
}

function normalizeCapabilities(capabilities = []) {
  if (!Array.isArray(capabilities)) return [];
  const normalized = [];
  for (const capability of capabilities) addCapability(normalized, capability);
  return normalized;
}

function addCapability(capabilities, capability) {
  const value = String(capability || '').trim().toLowerCase();
  if (value && !capabilities.includes(value)) capabilities.push(value);
}

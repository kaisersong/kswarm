const EXPLICIT_OUTPUT_PATTERNS = [
  { type: 'pptx', pattern: /(\.pptx\b|\bpptx\b|\bpowerpoint\b|\bppt\s*(文件|file|deck)?\b)/i },
  { type: 'markdown', pattern: /(\.md\b|\.markdown\b|\bmarkdown\b)/i },
  { type: 'html', pattern: /(\.html?\b|\bhtml\b|网页报告)/i },
];

const PRESENTATION_CONTENT_PATTERN = /(幻灯片|演示文稿|演讲稿|演讲报告|slide deck|slides|presentation)/i;

export function inferTaskRequirements(task = {}, project = {}) {
  const text = collectTaskText(task, project);
  const requiredOutputs = normalizeOutputs(task.requiredOutputs);
  const requiredCapabilities = normalizeCapabilities(task.requiredCapabilities);

  for (const { type, pattern } of EXPLICIT_OUTPUT_PATTERNS) {
    if (pattern.test(text)) {
      addOutput(requiredOutputs, { type, enforcement: 'hard', source: 'explicit' });
      if (type === 'pptx') addCapability(requiredCapabilities, 'presentation_generation');
    }
  }

  if (!requiredOutputs.some(output => output.type === 'pptx') && PRESENTATION_CONTENT_PATTERN.test(text)) {
    addOutput(requiredOutputs, { type: 'presentation_content', enforcement: 'soft', source: 'inferred' });
    addCapability(requiredCapabilities, 'presentation_content');
  }

  return {
    requiredOutputs,
    requiredCapabilities,
  };
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
  if (Array.isArray(project.acceptanceCriteria)) parts.push(...project.acceptanceCriteria);
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

const BOOLEAN_PERMISSION_KEYS = ['allowShell', 'allowWrite', 'allowNetwork', 'allowRenderer'];

function normalizeCommandList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    seen.add(trimmed);
  }
  return [...seen];
}

export function normalizeNodePermissions(permissions) {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return null;
  const normalized = {};
  for (const key of BOOLEAN_PERMISSION_KEYS) {
    if (typeof permissions[key] === 'boolean') normalized[key] = permissions[key];
  }
  const toolCategories = normalizeCommandList(permissions.toolCategories);
  if (toolCategories.length > 0) normalized.toolCategories = toolCategories;
  const deniedCommands = normalizeCommandList(permissions.deniedCommands);
  if (deniedCommands.length > 0) normalized.deniedCommands = deniedCommands;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

// Advisory only: no runner is launched behind a shell interceptor, so this
// section persuades the agent rather than preventing the command.
export function buildDeniedCommandsPromptSection(permissions) {
  const normalized = normalizeNodePermissions(permissions);
  const deniedCommands = normalized?.deniedCommands || [];
  if (deniedCommands.length === 0) return '';
  return [
    '## Denied Commands',
    'The workflow node declares these commands as out of bounds for this task. Do not run them; if you believe one is required, record it as a context gap instead.',
    ...deniedCommands.map(command => `- ${command}`),
  ].join('\n');
}

// Returns basePrompt separately so callers can still reject a node that
// declares permissions but carries no instructions.
export function composeNodePrompt(input) {
  const basePrompt = input?.prompt || input?.value || '';
  const deniedCommandsSection = buildDeniedCommandsPromptSection(input?.permissions);
  return {
    basePrompt,
    prompt: deniedCommandsSection ? `${basePrompt}\n\n${deniedCommandsSection}` : basePrompt,
  };
}

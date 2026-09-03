export const DENIED_COMMAND_LABELS = Object.freeze({
  'git-diff': 'git diff',
  'git-stash': 'git stash',
});

const ALLOWED_PERMISSION_KEYS = Object.freeze([
  'deniedCommandIds',
  'deniedCommands',
  'toolCategories',
]);
const COMMAND_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function normalizeStringList(value) {
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

function normalizeCommandIds(value) {
  return normalizeStringList(value).filter(
    id => COMMAND_ID_PATTERN.test(id) && Object.hasOwn(DENIED_COMMAND_LABELS, id),
  );
}

export function normalizeNodePermissions(permissions) {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return null;
  const normalized = {};
  const toolCategories = normalizeStringList(permissions.toolCategories);
  if (toolCategories.length > 0) normalized.toolCategories = toolCategories;
  const deniedCommandIds = normalizeCommandIds(permissions.deniedCommandIds);
  if (deniedCommandIds.length > 0) {
    normalized.deniedCommandIds = deniedCommandIds;
    normalized.deniedCommands = deniedCommandIds.map(id => DENIED_COMMAND_LABELS[id]);
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function validateNodePermissions(permissions) {
  if (permissions === null || permissions === undefined) {
    return { ok: true, permissions: null };
  }
  if (typeof permissions !== 'object' || Array.isArray(permissions)) {
    return { ok: false, error: 'workflow_script_permissions_invalid' };
  }
  if (Object.keys(permissions).some(key => !ALLOWED_PERMISSION_KEYS.includes(key))) {
    return { ok: false, error: 'workflow_script_permissions_unsupported' };
  }
  if (Object.keys(permissions).length === 0) {
    return { ok: false, error: 'workflow_script_permissions_invalid' };
  }

  const validateStringArray = (value, { min = 0, max }) =>
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= max &&
    value.every(entry =>
      typeof entry === 'string' &&
      entry === entry.trim() &&
      entry.length >= 1 &&
      entry.length <= 64
    );

  if (
    permissions.deniedCommandIds !== undefined &&
    (!validateStringArray(permissions.deniedCommandIds, { min: 1, max: 16 }) ||
      permissions.deniedCommandIds.some(
        id => !COMMAND_ID_PATTERN.test(id) || !Object.hasOwn(DENIED_COMMAND_LABELS, id),
      ))
  ) {
    return { ok: false, error: 'workflow_script_denied_command_id_invalid' };
  }
  if (
    permissions.deniedCommands !== undefined &&
    !validateStringArray(permissions.deniedCommands, { min: 1, max: 16 })
  ) {
    return { ok: false, error: 'workflow_script_denied_command_label_invalid' };
  }
  if (
    permissions.toolCategories !== undefined &&
    !validateStringArray(permissions.toolCategories, { min: 1, max: 32 })
  ) {
    return { ok: false, error: 'workflow_script_tool_categories_invalid' };
  }

  const normalized = normalizeNodePermissions(permissions);
  if (permissions.deniedCommandIds !== undefined) {
    if (normalized?.deniedCommandIds?.length !== permissions.deniedCommandIds.length) {
      return { ok: false, error: 'workflow_script_denied_command_id_invalid' };
    }
  }
  if (permissions.toolCategories !== undefined) {
    const normalizedCategories = normalized?.toolCategories || [];
    if (
      normalizedCategories.length !== permissions.toolCategories.length ||
      normalizedCategories.some((category, index) => category !== permissions.toolCategories[index])
    ) {
      return { ok: false, error: 'workflow_script_tool_categories_invalid' };
    }
  }
  if (permissions.deniedCommands !== undefined) {
    if (!normalized?.deniedCommandIds) {
      return { ok: false, error: 'workflow_script_denied_command_label_invalid' };
    }
    const expectedLabels = normalized.deniedCommandIds.map(id => DENIED_COMMAND_LABELS[id]);
    if (
      permissions.deniedCommands.length !== expectedLabels.length ||
      permissions.deniedCommands.some((label, index) => label !== expectedLabels[index])
    ) {
      return { ok: false, error: 'workflow_script_denied_command_label_invalid' };
    }
  }

  return { ok: true, permissions: normalized };
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
    ...deniedCommands.map(command => `- \`${command}\``),
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

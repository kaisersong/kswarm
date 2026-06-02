const VALID_SELECTION_SOURCES = new Set(['default_seed', 'explicit_user', 'system_migration']);

function normalizeSelectionSource(source, fallback) {
  return VALID_SELECTION_SOURCES.has(source) ? source : fallback;
}

function normalizeAgentId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeAgentIdList(values = []) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const agentId = normalizeAgentId(value);
    if (agentId && !result.includes(agentId)) result.push(agentId);
  }
  return result;
}

function normalizeSelectionMember(member, index, members, fallbackSource) {
  const record = member && typeof member === 'object' && !Array.isArray(member) ? member : null;
  const agentId = record
    ? (normalizeAgentId(record.agentId) || normalizeAgentId(record.id) || normalizeAgentId(members[index]))
    : (normalizeAgentId(member) || normalizeAgentId(members[index]));
  if (!agentId) return null;
  return {
    agentId,
    source: normalizeSelectionSource(record?.source, fallbackSource),
  };
}

export function normalizeProjectAgentSelection({ poAgent, members = [], agentSelection = null, defaultSource = 'system_migration' } = {}) {
  const fallbackSource = normalizeSelectionSource(defaultSource, 'system_migration');
  const selection = agentSelection && typeof agentSelection === 'object' ? agentSelection : {};
  const selectionMembers = Array.isArray(selection.members) ? selection.members : null;

  return {
    ...selection,
    poAgent: {
      agentId: normalizeAgentId(selection.poAgent?.agentId) || normalizeAgentId(poAgent),
      source: normalizeSelectionSource(selection.poAgent?.source, fallbackSource),
    },
    members: selectionMembers
      ? selectionMembers
        .map((member, index) => normalizeSelectionMember(member, index, members, fallbackSource))
        .filter(Boolean)
      : (Array.isArray(members) ? members : [])
        .map(agentId => normalizeAgentId(agentId))
        .filter(Boolean)
        .map(agentId => ({
          agentId,
          source: fallbackSource,
        })),
  };
}

export function reconcileProjectAgentSelectionWithEffectiveAgents(project, { defaultSource = 'system_migration' } = {}) {
  if (!project || typeof project !== 'object') return false;

  const selectionMembers = Array.isArray(project.agentSelection?.members)
    ? project.agentSelection.members.map(member => member?.agentId || member?.id || member)
    : [];
  const normalizedPoAgent = normalizeAgentId(project.poAgent) || normalizeAgentId(project.agentSelection?.poAgent?.agentId);
  const projectMembers = normalizeAgentIdList(project.members);
  const fallbackMembers = normalizeAgentIdList(selectionMembers);
  const normalizedMembers = (projectMembers.length > 0 ? projectMembers : fallbackMembers)
    .filter(agentId => agentId !== normalizedPoAgent);
  let changed = project.poAgent !== normalizedPoAgent
    || JSON.stringify(project.members || []) !== JSON.stringify(normalizedMembers);

  project.poAgent = normalizedPoAgent;
  project.members = normalizedMembers;

  const selection = normalizeProjectAgentSelection({
    poAgent: normalizedPoAgent,
    members: normalizedMembers,
    agentSelection: project.agentSelection || null,
    defaultSource,
  });

  changed = changed || JSON.stringify(selection) !== JSON.stringify(project.agentSelection || null);
  if (normalizedPoAgent && selection.poAgent?.agentId !== normalizedPoAgent) {
    selection.poAgent = { agentId: normalizedPoAgent, source: normalizeSelectionSource(defaultSource, 'system_migration') };
    changed = true;
  }

  project.agentSelection = selection;
  return changed;
}

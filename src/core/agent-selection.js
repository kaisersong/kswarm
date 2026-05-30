const VALID_SELECTION_SOURCES = new Set(['default_seed', 'explicit_user', 'system_migration']);

function normalizeSelectionSource(source, fallback) {
  return VALID_SELECTION_SOURCES.has(source) ? source : fallback;
}

export function normalizeProjectAgentSelection({ poAgent, members = [], agentSelection = null, defaultSource = 'system_migration' } = {}) {
  const fallbackSource = normalizeSelectionSource(defaultSource, 'system_migration');
  const selection = agentSelection && typeof agentSelection === 'object' ? agentSelection : {};
  const selectionMembers = Array.isArray(selection.members) ? selection.members : null;

  return {
    ...selection,
    poAgent: {
      agentId: selection.poAgent?.agentId || poAgent,
      source: normalizeSelectionSource(selection.poAgent?.source, fallbackSource),
    },
    members: selectionMembers
      ? selectionMembers.map((member, index) => ({
          agentId: member?.agentId || member?.id || member || members[index],
          source: normalizeSelectionSource(member?.source, fallbackSource),
        })).filter(member => member.agentId)
      : (Array.isArray(members) ? members : []).map(agentId => ({
          agentId,
          source: fallbackSource,
        })),
  };
}

export function reconcileProjectAgentSelectionWithEffectiveAgents(project, { defaultSource = 'system_migration' } = {}) {
  if (!project || typeof project !== 'object') return false;

  const selection = normalizeProjectAgentSelection({
    poAgent: project.poAgent,
    members: project.members || [],
    agentSelection: project.agentSelection || null,
    defaultSource,
  });

  let changed = JSON.stringify(selection) !== JSON.stringify(project.agentSelection || null);
  if (project.poAgent && selection.poAgent?.agentId !== project.poAgent) {
    selection.poAgent = { agentId: project.poAgent, source: normalizeSelectionSource(defaultSource, 'system_migration') };
    changed = true;
  }

  project.agentSelection = selection;
  return changed;
}

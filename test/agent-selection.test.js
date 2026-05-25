import assert from 'node:assert/strict';
import { normalizeProjectAgentSelection } from '../src/core/agent-selection.js';

{
  const selection = normalizeProjectAgentSelection({
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
    defaultSource: 'default_seed',
  });

  assert.deepEqual(selection, {
    poAgent: { agentId: 'xiaok-po', source: 'default_seed' },
    members: [{ agentId: 'xiaok-worker', source: 'default_seed' }],
  });
}

{
  const selection = normalizeProjectAgentSelection({
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
  });

  assert.deepEqual(selection, {
    poAgent: { agentId: 'xiaok-po', source: 'system_migration' },
    members: [{ agentId: 'xiaok-worker', source: 'system_migration' }],
  });
}

{
  const selection = normalizeProjectAgentSelection({
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
    defaultSource: 'default_seed',
    agentSelection: {
      poAgent: { agentId: 'manual-po', source: 'explicit_user' },
      members: [{ agentId: 'manual-worker', source: 'explicit_user' }],
    },
  });

  assert.deepEqual(selection, {
    poAgent: { agentId: 'manual-po', source: 'explicit_user' },
    members: [{ agentId: 'manual-worker', source: 'explicit_user' }],
  });
}

console.log('agent-selection tests passed');

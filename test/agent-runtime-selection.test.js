import assert from 'node:assert/strict';

import {
  listSupportedCliRuntimeTypes,
  resolveAgentRuntimeSelection,
} from '../src/core/agent-runtime-selection.js';

const detected = [
  { type: 'kimi', path: '/Users/test/.kimi-code/bin/kimi', model: 'kimi-k3' },
  { type: 'kiro', path: '/Users/test/bin/kiro', model: '' },
];

assert.ok(listSupportedCliRuntimeTypes().includes('kimi'));
assert.deepEqual(resolveAgentRuntimeSelection({ runtimeType: 'kimi' }, detected), {
  runtimeType: 'kimi',
  runtimePath: '/Users/test/.kimi-code/bin/kimi',
  runtimeModel: 'kimi-k3',
  provider: null,
  model: null,
  baseUrl: null,
  apiKey: null,
});
assert.throws(
  () => resolveAgentRuntimeSelection({ runtimeType: 'kiro' }, detected),
  /runtime_unsupported:kiro/,
);
assert.throws(
  () => resolveAgentRuntimeSelection({ runtimeType: 'kimi' }, []),
  /runtime_unavailable:kimi/,
);
assert.throws(
  () => resolveAgentRuntimeSelection({ runtimeType: '..\/evil' }, detected),
  /runtime_unsupported/,
);

console.log('✓ agent runtime selection validates supported and detected Kimi runtime');

import assert from 'node:assert/strict';
import { getEffectiveAgentConcurrency } from '../src/core/effective-agent-concurrency.js';

{
  const concurrency = getEffectiveAgentConcurrency({
    baseConcurrency: { 'xiaok-worker': 3 },
    agents: [
      { id: 'xiaok-worker', runtimeType: 'xiaok', runtimeSource: 'desktop-agent-runtime' },
    ],
  });

  assert.deepEqual(concurrency, { 'xiaok-worker': 1 });
}

{
  const concurrency = getEffectiveAgentConcurrency({
    baseConcurrency: { 'xiaok-worker': 3 },
    agents: [
      { id: 'xiaok-worker', runtimeType: 'xiaok', runtimeSource: 'auto-worker-runtime' },
    ],
  });

  assert.deepEqual(concurrency, { 'xiaok-worker': 3 });
}

console.log('effective-agent-concurrency tests passed');

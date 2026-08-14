import assert from 'node:assert/strict';
import { buildAgentChildEnv } from '../src/server/agent-child-env.js';

const env = buildAgentChildEnv({
  id: 'cli-worker',
  runtimeType: 'xiaok',
  runtimePath: '/opt/xiaok/bin/xiaok',
  runtimeModel: 'configured-model',
  customEnv: { SAFE_FLAG: '1' },
}, 'cli-worker', { BASE: '1' });

assert.equal(env.BASE, '1');
assert.equal(env.SAFE_FLAG, '1');
assert.equal(env.KSWARM_AGENT_ID, 'cli-worker');
assert.equal(env.KSWARM_AGENT_RUNTIME_TYPE, 'xiaok');
assert.equal(env.KSWARM_AGENT_RUNTIME_PATH, '/opt/xiaok/bin/xiaok');
assert.equal(env.KSWARM_AGENT_RUNTIME_MODEL, 'configured-model');

console.log('auto-worker-private-runtime-env: 1/1 passed');

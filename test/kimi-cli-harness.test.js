import assert from 'node:assert/strict';

import { buildKimiCliArgs } from '../src/core/kimi-cli-harness.js';

assert.deepEqual(buildKimiCliArgs('研究并输出结果', ''), [
  '--prompt', '研究并输出结果', '--output-format', 'text',
]);
assert.deepEqual(buildKimiCliArgs('研究并输出结果', 'kimi-k3'), [
  '--prompt', '研究并输出结果', '--output-format', 'text', '--model', 'kimi-k3',
]);

console.log('✓ Kimi CLI harness builds fixed non-shell argv');

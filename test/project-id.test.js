import assert from 'node:assert/strict';
import { createProjectInstanceId } from '../src/core/project-id.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('creates project instance ids with a UUID identity', () => {
  const first = createProjectInstanceId();
  const second = createProjectInstanceId();

  assert.match(first, /^proj-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(second, /^proj-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} project id tests passed`);

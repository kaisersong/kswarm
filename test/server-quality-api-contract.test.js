/**
 * KSwarm — server quality API wiring contract tests
 *
 * Run: node test/server-quality-api-contract.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/server/index.js'), 'utf-8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('server wires public quality API endpoints through the quality API handler', () => {
  assert.match(source, /handleQualityApiRequest/);
  assert.match(source, /createQualityOverlayStore/);
  assert.match(source, /path\.startsWith\('\/quality\/'\)/);
  assert.match(source, /qualityOverlayStore/);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} server quality API contract tests passed`);
}

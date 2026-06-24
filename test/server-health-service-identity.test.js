/**
 * KSwarm - server health service identity contract tests
 *
 * Run: node test/server-health-service-identity.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/server/index.js'), 'utf-8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('/health response exposes desktop-required workflow and service identity contracts', () => {
  const healthStart = source.indexOf("if (path === '/health' && req.method === 'GET')");
  const healthEnd = source.indexOf("if ((path === '/runtime/suspend'", healthStart);
  const healthBlock = source.slice(
    healthStart,
    healthEnd,
  );

  assert.notEqual(healthStart, -1, 'expected to find /health handler start');
  assert.notEqual(healthEnd, -1, 'expected to find /health handler end');
  assert.notEqual(healthBlock.length, 0, 'expected to find /health handler block');
  assert.match(source, /function getServiceIdentity\(\)/);
  assert.match(source, /function computeServiceSourceHash\(\)/);
  assert.match(source, /const WORKFLOW_CAPABILITIES\s*=/);
  assert.match(healthBlock, /service:\s*getServiceIdentity\(\)/);
  assert.match(healthBlock, /workflowCapabilities:\s*WORKFLOW_CAPABILITIES/);
  assert.match(source, /schemaVersion:\s*'kswarm_workflow_patterns_v1'/);
  assert.match(source, /compiledContract:\s*true/);
  assert.match(source, /patternPublicView:\s*true/);
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
  console.log(`\n${passed}/${tests.length} server health service identity contract tests passed`);
}

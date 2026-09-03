/**
 * KSwarm — GET /projects/:id/gate-snapshot 路由契约测试（design §9.1/§9.3）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §9.1 getProjectGateSnapshot(projectId)
 *   §9.3 Desktop preload getProjectGateSnapshot(projectId)
 *
 * hub.js:getProjectGateSnapshot 本身的行为已在 hub-get-project-gate-snapshot.test.js
 * 充分测试；本文件只验证 HTTP 路由正确注册并转发到该函数，不重复内部逻辑测试。
 *
 * Run: node test/server-gate-snapshot-route-contract.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/server/index.js'), 'utf-8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('server wires GET /projects/:id/gate-snapshot to hub.getProjectGateSnapshot', () => {
  assert.match(source, /gate-snapshot/);
  assert.match(source, /hub\.getProjectGateSnapshot\(/);
  assert.match(source, /projectGateSnapshotMatch/);
});

test('gate-snapshot route returns 404 for project_not_found (not a generic 400)', () => {
  const routeBlockMatch = source.match(/projectGateSnapshotMatch && req\.method === 'GET'\) \{([\s\S]{0,300})\}/);
  assert.ok(routeBlockMatch, 'route handler block must exist');
  assert.match(routeBlockMatch[1], /project_not_found.*404|404.*project_not_found/);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}
console.log(`\n${passed}/${tests.length} server gate-snapshot route contract tests passed\n`);
if (failed > 0) process.exit(1);

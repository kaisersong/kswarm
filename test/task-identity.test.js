/**
 * KSwarm — Global task identity tests
 *
 * Run: node test/task-identity.test.js
 */

import assert from 'node:assert/strict';
import {
  buildTaskAliases,
  isGlobalTaskId,
  makeTaskId,
  normalizeLocalTaskId,
  normalizeTasksForProject,
  parseTaskId,
  resolveTaskRef,
} from '../src/core/task-identity.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('makeTaskId creates stable project-scoped global IDs', () => {
  assert.equal(makeTaskId('proj-a', 'item-1'), 'proj-a__item-1');
  assert.equal(makeTaskId('proj-a', 'proj-a__item-1'), 'proj-a__item-1');
  assert.equal(isGlobalTaskId('proj-a__item-1'), true);
});

test('parseTaskId restores project and local IDs', () => {
  assert.deepEqual(parseTaskId('proj-a__item-1'), {
    global: true,
    projectId: 'proj-a',
    localTaskId: 'item-1',
    taskId: 'proj-a__item-1',
  });
  assert.equal(parseTaskId('item-1').global, false);
});

test('normalizeLocalTaskId rejects path and separator ambiguity', () => {
  assert.equal(normalizeLocalTaskId('阶段 1/任务 1'), '1-1');
  assert.equal(normalizeLocalTaskId('../old-project/item__1'), 'old-project-item-1');
  assert.equal(normalizeLocalTaskId(''), 'item-1');
});

test('normalizeTasksForProject globalizes local IDs', () => {
  const result = normalizeTasksForProject('proj-a', [
    { id: 'item-1', title: 'Task 1', dependencies: [] },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.tasks[0].id, 'proj-a__item-1');
  assert.equal(result.tasks[0].localTaskId, 'item-1');
  assert.equal(result.tasks[0].legacyTaskId, 'item-1');
});

test('normalizeTasksForProject rejects duplicate normalized local IDs', () => {
  const result = normalizeTasksForProject('proj-a', [
    { id: 'item 1', title: 'Task 1', dependencies: [] },
    { id: 'item/1', title: 'Task 2', dependencies: [] },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'duplicate_local_task_id');
});

test('dependencies resolve by unique title and local ID', () => {
  const result = normalizeTasksForProject('proj-a', [
    { id: 'item-1', title: 'Research', dependencies: [] },
    { id: 'item-2', title: 'Draft', dependencies: ['Research'] },
    { id: 'item-3', title: 'Review', dependencies: ['item-2'] },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tasks[1].dependencies, ['proj-a__item-1']);
  assert.deepEqual(result.tasks[2].dependencies, ['proj-a__item-2']);
});

test('duplicate titles are not used as aliases', () => {
  const result = normalizeTasksForProject('proj-a', [
    { id: 'item-1', title: 'Same', dependencies: [] },
    { id: 'item-2', title: 'Same', dependencies: [] },
    { id: 'item-3', title: 'Later', dependencies: ['Same'] },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tasks[2].dependencies, []);
  assert.deepEqual(result.tasks[2].unresolvedDependencies, ['Same']);
});

test('projects can each have local item-1 without collision', () => {
  const a = normalizeTasksForProject('proj-a', [{ id: 'item-1', title: 'A', dependencies: [] }]);
  const b = normalizeTasksForProject('proj-b', [{ id: 'item-1', title: 'B', dependencies: [] }]);
  assert.equal(a.tasks[0].id, 'proj-a__item-1');
  assert.equal(b.tasks[0].id, 'proj-b__item-1');
});

test('resolveTaskRef accepts global, local, and unique title refs', () => {
  const tasks = normalizeTasksForProject('proj-a', [
    { id: 'item-1', title: 'Research', dependencies: [] },
  ]).tasks;
  assert.equal(resolveTaskRef('proj-a', 'proj-a__item-1', tasks).taskId, 'proj-a__item-1');
  assert.equal(resolveTaskRef('proj-a', 'item-1', tasks).taskId, 'proj-a__item-1');
  assert.equal(resolveTaskRef('proj-a', 'Research', tasks).taskId, 'proj-a__item-1');
  assert.equal(resolveTaskRef('proj-b', 'proj-a__item-1', tasks), null);
});

test('buildTaskAliases omits duplicate title aliases', () => {
  const tasks = normalizeTasksForProject('proj-a', [
    { id: 'item-1', title: 'Same', dependencies: [] },
    { id: 'item-2', title: 'Same', dependencies: [] },
  ]).tasks;
  const aliases = buildTaskAliases('proj-a', tasks);
  assert.equal(aliases.has('Same'), false);
  assert.equal(aliases.get('item-1'), 'proj-a__item-1');
});

test('buildTaskAliases resolves duplicate retry title to original parent', () => {
  const tasks = normalizeTasksForProject('proj-a', [
    { id: 'item-1', title: 'Research', dependencies: [] },
    { id: 'item-1-retry-1', title: 'Research', parentTaskId: 'proj-a__item-1', dependencies: [] },
    { id: 'item-2', title: 'Draft', dependencies: ['Research'] },
  ]).tasks;
  const aliases = buildTaskAliases('proj-a', tasks);

  assert.equal(aliases.get('Research'), 'proj-a__item-1');
  assert.deepEqual(tasks[2].dependencies, ['proj-a__item-1']);
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
  console.log(`\n${passed}/${tests.length} task identity tests passed`);
}

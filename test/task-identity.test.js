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
import { restoreTaskBoard } from '../src/core/task-board.js';

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

test('normalizeTasksForProject ignores metadata-only plan rows', () => {
  const result = normalizeTasksForProject('proj-a', [
    { id: 'item-1', title: 'Executable task', dependencies: [] },
    { key: 'background', value: 'Only plan context, not a task' },
    { fields: ['source', 'baseline'], assumptions: ['Use public customs data'] },
    { description: 'Description-only executable task', assignedAgent: 'worker' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks.map(task => task.title || task.description), [
    'Executable task',
    'Description-only executable task',
  ]);
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

test('phase dependencies expand to all concrete tasks in that phase', () => {
  const result = normalizeTasksForProject('proj-a', [
    { id: 'item-1', title: 'Anthropic research', phaseId: 'phase-1', dependencies: [] },
    { id: 'item-2', title: 'OpenAI research', phaseId: 'phase-1', dependencies: [] },
    { id: 'item-3', title: 'Compare research', phaseId: 'phase-2', dependencies: ['phase-1'] },
    { id: 'item-4', title: 'Final report', phaseId: 'phase-3', dependencies: ['phase-2'] },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.tasks[2].dependencies, ['proj-a__item-1', 'proj-a__item-2']);
  assert.deepEqual(result.tasks[2].unresolvedDependencies, []);
  assert.deepEqual(result.tasks[3].dependencies, ['proj-a__item-3']);
  assert.deepEqual(result.tasks[3].unresolvedDependencies, []);
});

test('near-title dependency resolves when there is one high-confidence title match', () => {
  const result = normalizeTasksForProject('proj-a', [
    { id: 'p1-item1', title: '建立官方信息监控渠道', dependencies: [] },
    { id: 'p2-item1', title: '清洗去重与分类', dependencies: ['收集官方信息监控渠道'] },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tasks[1].dependencies, ['proj-a__p1-item1']);
  assert.deepEqual(result.tasks[1].unresolvedDependencies, []);
});

test('near-title dependency remains unresolved when the shared phrase is too generic', () => {
  const result = normalizeTasksForProject('proj-a', [
    { id: 'p1-item1', title: '建立官方信息监控渠道', dependencies: [] },
    { id: 'p1-item2', title: '收集社区信息监控渠道', dependencies: [] },
    { id: 'p2-item1', title: '清洗去重与分类', dependencies: ['收集行业信息监控渠道'] },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tasks[2].dependencies, []);
  assert.deepEqual(result.tasks[2].unresolvedDependencies, ['收集行业信息监控渠道']);
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

test('restoreTaskBoard skips persisted metadata-only tasks', () => {
  const board = restoreTaskBoard([
    { id: 'item-1', status: 'pending', assignedAgent: null, phaseId: 'phase-1', planItemId: 'item-1' },
    { id: 'item-2', title: 'Executable task', status: 'pending', dependencies: ['item-1'] },
  ], 'proj-a');

  const tasks = board.getAllTasks();
  assert.deepEqual(tasks.map(task => task.id), ['proj-a__item-2']);
  assert.deepEqual(tasks[0].unresolvedDependencies, ['item-1']);
});

test('restoreTaskBoard preserves description-only persisted tasks', () => {
  const board = restoreTaskBoard([
    { id: 'item-1', description: 'Description-only task that can still be executed', status: 'pending' },
  ], 'proj-a');

  const tasks = board.getAllTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'proj-a__item-1');
  assert.equal(tasks[0].description, 'Description-only task that can still be executed');
});

test('restoreTaskBoard expands persisted phase dependency refs', () => {
  const board = restoreTaskBoard([
    { id: 'item-1', title: 'Research A', status: 'done', phaseId: 'phase-1', dependencies: [] },
    { id: 'item-2', title: 'Research B', status: 'done', phaseId: 'phase-1', dependencies: [] },
    { id: 'item-3', title: 'Synthesis', status: 'pending', phaseId: 'phase-2', dependencyRefs: ['phase-1'], dependencies: [], unresolvedDependencies: ['phase-1'] },
  ], 'proj-a');

  const task = board.getTask('item-3');
  assert.deepEqual(task.dependencies, ['proj-a__item-1', 'proj-a__item-2']);
  assert.deepEqual(task.unresolvedDependencies, []);
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

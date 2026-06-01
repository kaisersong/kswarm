import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createProject(hub, overrides = {}) {
  return hub.createProject({
    id: overrides.id || 'proj-create',
    name: overrides.name || '欢迎页固定项目',
    goal: overrides.goal || '验证欢迎页 few-shot 创建项目',
    poAgent: overrides.poAgent || 'xiaok-po',
    members: overrides.members || ['xiaok-worker'],
    clientRequestKey: overrides.clientRequestKey,
  });
}

test('reuses an existing project for the same clientRequestKey', () => {
  const hub = createHub({ silent: true });
  const first = createProject(hub, {
    id: 'proj-first',
    clientRequestKey: 'create-project:task-session-1:abc',
  });

  const reusable = hub.findReusableProjectForCreateRequest({
    name: '另一个名字也应被 key 覆盖',
    clientRequestKey: 'create-project:task-session-1:abc',
    reuseExistingLiveProject: false,
  });

  assert.equal(reusable?.id, first.id);
});

test('does not reuse a live project just because the display name matches', () => {
  const hub = createHub({ silent: true });
  createProject(hub, {
    id: 'proj-live',
    name: '  动态工作流真实交付验证  ',
  });

  const reusable = hub.findReusableProjectForCreateRequest({
    name: '动态工作流真实交付验证',
    reuseExistingLiveProject: true,
  });

  assert.equal(reusable, null);
});

test('does not reuse a delivered same-name project without the same clientRequestKey', () => {
  const hub = createHub({ silent: true });
  const project = createProject(hub, {
    id: 'proj-delivered',
    name: '动态工作流真实交付验证',
  });
  project.status = 'delivered';

  const reusable = hub.findReusableProjectForCreateRequest({
    name: '动态工作流真实交付验证',
    reuseExistingLiveProject: true,
  });

  assert.equal(reusable, null);
});

test('allows separate project instances to keep the same display name', () => {
  const hub = createHub({ silent: true });
  const first = createProject(hub, {
    id: 'proj-first',
    name: '欢迎页固定项目',
  });
  const second = createProject(hub, {
    id: 'proj-second',
    name: '欢迎页固定项目',
  });

  assert.notEqual(first.id, second.id);
  assert.equal(first.name, '欢迎页固定项目');
  assert.equal(second.name, '欢迎页固定项目');
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} project create idempotency tests passed`);

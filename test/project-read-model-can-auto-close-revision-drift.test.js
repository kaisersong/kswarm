/**
 * KSwarm — canAutoClose 必须对已批准 decision 的 project revision/manifest
 * revision 漂移 fail closed（design §8.2 canAutoClose 项、§8.3）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.2 `project-read-model.js:deriveProjectLifecycle/canAutoClose` —— "只消费
 *   通过 `verifyCommittedReviewGateDecision` 的 committed decision + snapshot；
 *   condition/evaluation/blocker 缺失或 revision/hash 漂移时 canAutoClose=false"
 *   §8.3 —— "任何漂移使 read model 返回不可关闭"
 *
 * 现状核实（2026-09-02）：`verifyCommittedReviewGateDecision` 本身是纯函数，
 * 但需要 `hydratedGateFacts`（需读盘重算 hash）才能检测 final artifact bytes
 * 是否被篡改；`canAutoClose` 是高频同步只读路径，接入完整 hydration 会引入
 * 不可接受的 I/O，这部分维持架构待办不变。
 *
 * 但 `lifecycleVersion`/`manifestRevision` 漂移检测不需要读盘——两者都已经是
 * project 对象上的内存字段，且 `reviewGateDecision.projectGateSnapshotRef` 在
 * 批准时已经把批准时刻的这两个值固化保存。本文件证明当前 `canAutoClose`
 * 没有做这一层轻量、无 I/O 的漂移检测：approval 之后 project 又新增了任务
 * （lifecycleVersion 递增）时，旧的 passing decision 依然被判定为可自动关闭。
 *
 * Run: node test/project-read-model-can-auto-close-revision-drift.test.js
 */

import assert from 'node:assert/strict';
import { deriveProjectLifecycle } from '../src/core/project-read-model.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function buildApprovedProject({ lifecycleVersion, manifestRevision, snapshotLifecycleVersion, snapshotManifestRevision }) {
  const project = {
    id: 'proj-1',
    status: 'active',
    lifecycleVersion,
    manifestRevision,
    planRevisionRequired: null,
  };
  const finalDeliverables = [{
    deliverableId: 'fd-1',
    status: 'approved',
    kind: 'none',
    requiresReview: false,
    submitted: { requestContext: { requestSource: 'user' } },
    approval: { requestContext: { requestSource: 'user' } },
  }];
  const reviewGateDecisions = [{
    finalDeliverableId: 'fd-1',
    decision: 'passed',
    autoCloseAllowed: true,
    decidedAtProjectVersion: snapshotLifecycleVersion,
    decidedAtManifestRevision: snapshotManifestRevision,
    projectGateSnapshotRef: {
      finalDeliverableId: 'fd-1',
      projectId: 'proj-1',
      projectLifecycleVersion: snapshotLifecycleVersion,
      manifestRevision: snapshotManifestRevision,
      finalArtifactSha256: 'hash-at-approval-time',
    },
  }];
  return { project, finalDeliverables, reviewGateDecisions };
}

test('lifecycleVersion 在批准后发生漂移时，canAutoClose 必须为 false（当前会错误为 true）', () => {
  const { project, finalDeliverables, reviewGateDecisions } = buildApprovedProject({
    lifecycleVersion: 3, // 批准之后又发生了一次 project mutation（比如新增了任务）
    manifestRevision: 1,
    snapshotLifecycleVersion: 2, // 批准时刻锁定的版本
    snapshotManifestRevision: 1,
  });
  const lifecycle = deriveProjectLifecycle({ project, tasks: [], finalDeliverables, reviewGateDecisions });
  assert.equal(lifecycle.canAutoClose, false, 'lifecycleVersion 漂移后不应允许自动关闭');
});

test('manifestRevision 在批准后发生漂移时，canAutoClose 必须为 false（当前会错误为 true）', () => {
  const { project, finalDeliverables, reviewGateDecisions } = buildApprovedProject({
    lifecycleVersion: 2,
    manifestRevision: 4, // 批准之后又发生了一次 canonical artifact mutation
    snapshotLifecycleVersion: 2,
    snapshotManifestRevision: 1,
  });
  const lifecycle = deriveProjectLifecycle({ project, tasks: [], finalDeliverables, reviewGateDecisions });
  assert.equal(lifecycle.canAutoClose, false, 'manifestRevision 漂移后不应允许自动关闭');
});

test('lifecycleVersion/manifestRevision 与批准时刻一致时，canAutoClose 仍可为 true（不引入误报）', () => {
  const { project, finalDeliverables, reviewGateDecisions } = buildApprovedProject({
    lifecycleVersion: 2,
    manifestRevision: 1,
    snapshotLifecycleVersion: 2,
    snapshotManifestRevision: 1,
  });
  const lifecycle = deriveProjectLifecycle({ project, tasks: [], finalDeliverables, reviewGateDecisions });
  assert.equal(lifecycle.canAutoClose, true, '版本一致时不应被误判为漂移');
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
console.log(`\n${passed}/${tests.length} canAutoClose revision drift tests passed\n`);
if (failed > 0) process.exit(1);

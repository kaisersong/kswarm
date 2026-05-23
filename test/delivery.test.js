/**
 * KSwarm — Delivery Aggregation Unit Tests
 *
 * Run: node test/delivery.test.js
 */

import { aggregateDelivery, buildUserFacingDeliveryFiles, selectUserFacingDeliveryTask } from '../src/core/delivery.js';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Test Helpers ────────────────────────────────────────────────────────────

let total = 0, passed = 0, failed = 0;
function assert(cond, msg) {
  total++;
  if (cond) { passed++; console.log(`    ✓ ${msg}`); }
  else { failed++; console.log(`    ✗ FAIL: ${msg}`); }
}
function scenario(name, fn) {
  console.log(`\n  ━━━ ${name} ━━━\n`);
  fn();
}

const TEST_DIR = join(tmpdir(), `kswarm-delivery-test-${Date.now()}`);

function createTestWorkspace(artifacts = {}) {
  const ws = join(TEST_DIR, `proj-${Math.random().toString(36).slice(2, 8)}`);
  const artifactsDir = join(ws, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  for (const [name, content] of Object.entries(artifacts)) {
    writeFileSync(join(artifactsDir, name), content, 'utf-8');
  }
  return ws;
}

// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n╔═══════════════════════════════════════════════════╗');
console.log('║   KSwarm — Delivery Aggregation Tests             ║');
console.log('╚═══════════════════════════════════════════════════╝');

scenario('基本聚合 — 多个 markdown artifact', () => {
  const ws = createTestWorkspace({
    'proj1-t1-report.md': '# Task 1 Result\n\nDid the first thing.',
    'proj1-t2-report.md': '# Task 2 Result\n\nDid the second thing.',
  });

  const result = aggregateDelivery(ws, { name: 'Test Project', goal: 'test goal' });

  assert(result !== null, '返回非 null');
  assert(existsSync(result.manifestPath), 'manifest 文件存在');
  assert(result.reportPath !== null, 'report 文件存在');
  assert(existsSync(result.reportPath), 'report 文件可读');

  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));
  assert(manifest.project === 'Test Project', `project name: ${manifest.project}`);
  assert(manifest.artifacts.length === 2, `artifact 数量: ${manifest.artifacts.length}`);
  assert(manifest.artifacts[0].type === 'markdown', `类型识别: ${manifest.artifacts[0].type}`);

  const report = readFileSync(result.reportPath, 'utf-8');
  assert(report.includes('Task 1 Result'), 'report 包含 task 1 内容');
  assert(report.includes('Task 2 Result'), 'report 包含 task 2 内容');
});

scenario('taskId 提取 — 从文件名解析 taskId', () => {
  const ws = createTestWorkspace({
    'proj1-t1-report.md': 'content1',
    'random-file.txt': 'content2',
  });

  const result = aggregateDelivery(ws);
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));

  assert(manifest.artifacts[0].taskId === 'proj1-t1', `taskId 提取: ${manifest.artifacts[0].taskId}`);
  assert(manifest.artifacts[1].taskId === null, `无法提取时为 null: ${manifest.artifacts[1].taskId}`);
});

scenario('混合类型 — text + binary', () => {
  const ws = createTestWorkspace({
    'report.md': '# Report\n\nSome text.',
    'data.json': '{"key": "value"}',
  });
  // Add a "binary" file
  writeFileSync(join(ws, 'artifacts', 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const result = aggregateDelivery(ws);
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));

  assert(manifest.artifacts.length === 3, `3 个 artifact: ${manifest.artifacts.length}`);

  const types = manifest.artifacts.map(a => a.type);
  assert(types.includes('markdown'), '包含 markdown 类型');
  assert(types.includes('data'), '包含 data 类型');
  assert(types.includes('image'), '包含 image 类型');

  // Report should only merge text files
  const report = readFileSync(result.reportPath, 'utf-8');
  assert(report.includes('Report'), 'report 包含 md 内容');
  assert(report.includes('"key"'), 'report 包含 json 内容');
});

scenario('空 artifacts 目录 — 返回 null', () => {
  const ws = createTestWorkspace({}); // empty artifacts
  const result = aggregateDelivery(ws);
  assert(result === null, '空 artifacts 返回 null');
});

scenario('无 artifacts 目录 — 返回 null', () => {
  const ws = join(TEST_DIR, 'no-artifacts');
  mkdirSync(ws, { recursive: true });
  const result = aggregateDelivery(ws);
  assert(result === null, '无 artifacts 目录返回 null');
});

scenario('delivery 目录生成 — 文件正确拷贝', () => {
  const ws = createTestWorkspace({
    'task-report.md': 'hello world',
  });

  const result = aggregateDelivery(ws);
  const deliveryDir = join(ws, 'delivery');

  assert(existsSync(deliveryDir), 'delivery 目录被创建');
  assert(existsSync(join(deliveryDir, 'task-report.md')), 'artifact 被拷贝到 delivery');
  assert(existsSync(join(deliveryDir, 'delivery-manifest.json')), 'manifest 在 delivery 目录');
  assert(existsSync(join(deliveryDir, 'delivery-report.md')), 'report 在 delivery 目录');
});

scenario('manifest 元数据 — 包含 project meta', () => {
  const ws = createTestWorkspace({ 'r.md': 'x' });
  const meta = { name: '项目A', goal: '做好事', poAgent: 'agent-po', deliveredAt: 1700000000000 };
  const result = aggregateDelivery(ws, meta);
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));

  assert(manifest.project === '项目A', `project: ${manifest.project}`);
  assert(manifest.goal === '做好事', `goal: ${manifest.goal}`);
  assert(manifest.deliveredBy === 'agent-po', `deliveredBy: ${manifest.deliveredBy}`);
  assert(manifest.deliveredAt === 1700000000000, `deliveredAt: ${manifest.deliveredAt}`);
});

scenario('最终产物选择 — 显式最终 Markdown 优先于依赖更多的中间任务', () => {
  const finalTask = selectUserFacingDeliveryTask([
    {
      id: 'proj-1__p2-item3',
      title: '整合社区动态与行业影响',
      status: 'done',
      completedAt: 2000,
      dependencies: ['proj-1__p1-item2', 'proj-1__p2-item2'],
      result: { artifactManifest: [{ filename: 'proj-1__p2-item3-report.md' }] },
    },
    {
      id: 'proj-1__p4-item1',
      title: '生成最终 Markdown 文件',
      status: 'done',
      completedAt: 3000,
      dependencies: ['proj-1__p3-item2'],
      result: { artifactManifest: [{ filename: 'proj-1__p4-item1-report.md' }] },
    },
    {
      id: 'proj-1__p4-item2',
      title: '项目总结与复盘',
      status: 'done',
      completedAt: 4000,
      dependencies: ['proj-1__p4-item1'],
      result: { artifactManifest: [{ filename: 'proj-1__p4-item2-report.md' }] },
    },
  ]);

  assert(finalTask?.id === 'proj-1__p4-item1', `最终产物任务: ${finalTask?.id}`);
});

scenario('最终交付文件 — 包含可点击 artifact URL 和 MIME 类型', () => {
  const files = buildUserFacingDeliveryFiles({
    projectId: 'proj-1',
    finalTask: { id: 'proj-1__p4-item1', localTaskId: 'p4-item1' },
    artifacts: [
      { filename: 'proj-1__p2-item3-report.md', type: 'markdown', size: 739, taskId: 'proj-1__p2-item3' },
      { filename: 'proj-1__p4-item1-report.md', type: 'markdown', size: 873, taskId: 'proj-1__p4-item1' },
    ],
  });

  assert(files.length === 1, `最终交付文件数: ${files.length}`);
  assert(files[0].name === 'proj-1__p4-item1-report.md', `最终交付文件: ${files[0].name}`);
  assert(files[0].url === '/projects/proj-1/artifacts/proj-1__p4-item1-report.md', `URL: ${files[0].url}`);
  assert(files[0].mimeType === 'text/markdown', `MIME: ${files[0].mimeType}`);
});

scenario('最终交付文件 — 优先使用成功任务提交的 artifacts，忽略同 taskId 的旧文件', () => {
  const files = buildUserFacingDeliveryFiles({
    projectId: 'proj-1',
    finalTask: {
      id: 'proj-1__p4-item1',
      localTaskId: 'p4-item1',
      result: {
        artifacts: [
          { filename: 'proj-1__p4-item1-report.html', type: 'report_html', mimeType: 'text/html', size: 2600, taskId: 'proj-1__p4-item1' },
        ],
      },
    },
    artifacts: [
      { filename: 'proj-1__p4-item1-report.html', type: 'html', size: 2600, taskId: 'proj-1__p4-item1' },
      { filename: 'proj-1__p4-item1-report.md', type: 'markdown', size: 180, taskId: 'proj-1__p4-item1' },
    ],
  });

  assert(files.length === 1, `最终交付文件数: ${files.length}`);
  assert(files[0].name === 'proj-1__p4-item1-report.html', `最终交付文件: ${files[0].name}`);
  assert(files[0].mimeType === 'text/html', `MIME: ${files[0].mimeType}`);
});

scenario('最终交付文件 — 使用项目标题生成正式文件名并创建 delivery 别名', () => {
  const ws = createTestWorkspace({
    'proj-1__p4-item1-report.html': '<!doctype html><html><body>报告正文</body></html>',
  });
  const delivery = aggregateDelivery(ws, { name: '金蝶本月产品分析', goal: '输出金蝶本月产品分析报告' });
  const files = buildUserFacingDeliveryFiles({
    projectId: 'proj-1',
    projectName: '金蝶本月产品分析',
    goal: '输出金蝶本月产品分析报告',
    deliveryDir: join(ws, 'delivery'),
    finalTask: {
      id: 'proj-1__p4-item1',
      localTaskId: 'p4-item1',
      title: '使用report renderer生成HTML报告',
      result: {
        artifacts: [
          { filename: 'proj-1__p4-item1-report.html', type: 'report_html', mimeType: 'text/html', size: 2600, taskId: 'proj-1__p4-item1' },
        ],
      },
    },
    artifacts: delivery.manifest.artifacts,
  });

  assert(files.length === 1, `最终交付文件数: ${files.length}`);
  assert(files[0].name === '金蝶本月产品分析报告.html', `正式文件名: ${files[0].name}`);
  assert(files[0].filename === '金蝶本月产品分析报告.html', `正式 filename: ${files[0].filename}`);
  assert(files[0].url === `/projects/proj-1/delivery/${encodeURIComponent('金蝶本月产品分析报告.html')}`, `delivery URL: ${files[0].url}`);
  assert(files[0].path === 'delivery/金蝶本月产品分析报告.html', `delivery path: ${files[0].path}`);
  assert(existsSync(join(ws, 'delivery', '金蝶本月产品分析报告.html')), 'delivery 正式别名文件存在');
});

scenario('最终产物选择 — renderer HTML 优先于短 wrapper Markdown', () => {
  const finalTask = selectUserFacingDeliveryTask([
    {
      id: 'proj-1__p4-item1',
      title: '生成最终 HTML 报告',
      status: 'done',
      completedAt: 3000,
      dependencies: ['proj-1__p3-item2'],
      result: {
        artifactManifest: [
          { filename: 'final-report.html', mimeType: 'text/html', type: 'report_html', size: 2600, taskId: 'proj-1__p4-item1' },
        ],
      },
    },
    {
      id: 'proj-1__p4-item2',
      title: '项目总结与复盘',
      status: 'done',
      completedAt: 4000,
      dependencies: ['proj-1__p4-item1'],
      result: {
        artifactManifest: [
          { filename: 'proj-1__p4-item2-report.md', mimeType: 'text/markdown', type: 'markdown', size: 180, taskId: 'proj-1__p4-item2' },
        ],
      },
    },
  ]);

  assert(finalTask?.id === 'proj-1__p4-item1', `renderer 最终产物任务: ${finalTask?.id}`);
});

// ═══════════════════════════════════════════════════════════════════════════════

// Cleanup
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

console.log('\n' + '─'.repeat(50));
console.log(`  结果: ${passed}/${total} 通过, ${failed} 失败`);
console.log('─'.repeat(50) + '\n');

process.exit(failed > 0 ? 1 : 0);

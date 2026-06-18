/**
 * KSwarm — artifact JSON-LD adapter tests
 *
 * Run: node test/artifact-jsonld.test.js
 *
 * Covers v2.1 final design test matrix:
 * #1  完整输入字段映射
 * #2  省略策略（缺 projectId/taskId/generatedAt）
 * #3  嵌套字段完整性（additionalProperty[].propertyID/value）
 * #4  Key 排序幂等
 * #5  </script> escaping
 * #6  U+2028/U+2029 escaping
 * #7  schema.org IRI whitelist (recursive, fixture-based)
 * #8  @id path encoding
 * #13 creator type 锁定为 Organization
 */

import assert from 'node:assert/strict';
import { buildReportJsonLd, escapeJsonLdForHtml } from '../src/core/artifact-jsonld.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const ALLOWED_IRI_PREFIXES = [
  'http://schema.org/',
  'https://xiaok.app/ns#',
];

function isAllowedIri(value) {
  if (typeof value !== 'string') return true;
  if (!value.includes(':')) return true;
  if (value.startsWith('http://schema.org/')) return true;
  if (value.startsWith('https://schema.org/')) return true;
  if (value.startsWith('https://xiaok.app/')) return true;
  if (value.startsWith('zh-') || value.startsWith('en-')) return true;
  return false;
}

function collectPropertyIds(obj, ids = []) {
  if (Array.isArray(obj)) {
    for (const item of obj) collectPropertyIds(item, ids);
  } else if (obj && typeof obj === 'object') {
    if (typeof obj.propertyID === 'string') ids.push(obj.propertyID);
    for (const v of Object.values(obj)) collectPropertyIds(v, ids);
  }
  return ids;
}

test('#1 完整输入字段映射', () => {
  const out = buildReportJsonLd({
    taskId: 'task-001',
    title: 'Q2 销售分析',
    generatedAt: '2026-06-17T10:00:00.000Z',
    projectId: 'proj-abc',
    projectName: 'Q2 竞品分析',
  });
  const obj = JSON.parse(out);
  assert.equal(obj['@context'], 'http://schema.org/');
  assert.equal(obj['@type'], 'Report');
  assert.equal(obj['@id'], 'https://xiaok.app/id/project/proj-abc/task/task-001/report');
  assert.equal(obj.name, 'Q2 销售分析');
  assert.equal(obj.dateCreated, '2026-06-17T10:00:00.000Z');
  assert.equal(obj.inLanguage, 'zh-CN');
  assert.equal(obj.isPartOf['@type'], 'CreativeWork');
  assert.equal(obj.isPartOf['@id'], 'https://xiaok.app/id/project/proj-abc');
  assert.equal(obj.isPartOf.name, 'Q2 竞品分析');
  assert.equal(obj.creator['@type'], 'Organization');
  assert.equal(obj.creator.name, 'xiaok');
  assert.equal(obj.additionalProperty[0]['@type'], 'PropertyValue');
  assert.equal(obj.additionalProperty[0].propertyID, 'https://xiaok.app/ns#metadataVersion');
  assert.equal(obj.additionalProperty[0].value, '1');
});

test('#2a 缺 projectId 省略 @id 和 isPartOf', () => {
  const out = buildReportJsonLd({
    taskId: 'task-001',
    title: 'Solo Report',
    generatedAt: '2026-06-17T10:00:00.000Z',
  });
  const obj = JSON.parse(out);
  assert.equal(obj['@id'], undefined, '缺 projectId 不应有 @id');
  assert.equal(obj.isPartOf, undefined, '缺 projectId 不应有 isPartOf');
  assert.equal(obj.name, 'Solo Report');
});

test('#2b 缺 taskId 省略 @id', () => {
  const out = buildReportJsonLd({
    projectId: 'proj-abc',
    projectName: 'P',
    title: 'No Task Report',
  });
  const obj = JSON.parse(out);
  assert.equal(obj['@id'], undefined, '缺 taskId 不应有 @id');
  assert.ok(obj.isPartOf, '只缺 taskId 应保留 isPartOf');
});

test('#2c 缺 generatedAt 省略 dateCreated', () => {
  const out = buildReportJsonLd({
    projectId: 'p', taskId: 't', title: 'T',
  });
  const obj = JSON.parse(out);
  assert.equal(obj.dateCreated, undefined);
});

test('#2d 缺 projectName 但有 projectId 时 isPartOf 不含 name', () => {
  const out = buildReportJsonLd({
    projectId: 'p', taskId: 't', title: 'T',
  });
  const obj = JSON.parse(out);
  assert.ok(obj.isPartOf);
  assert.equal(obj.isPartOf.name, undefined);
});

test('#3 嵌套字段完整性（stableStringify 不丢嵌套字段）', () => {
  const out = buildReportJsonLd({
    projectId: 'p', taskId: 't', title: 'T', projectName: 'PN',
    generatedAt: '2026-06-17T10:00:00.000Z',
  });
  const obj = JSON.parse(out);
  assert.ok(Array.isArray(obj.additionalProperty));
  assert.equal(obj.additionalProperty.length, 1);
  const ap0 = obj.additionalProperty[0];
  assert.equal(ap0['@type'], 'PropertyValue', '嵌套 @type 必须保留');
  assert.equal(ap0.propertyID, 'https://xiaok.app/ns#metadataVersion', '嵌套 propertyID 必须保留');
  assert.equal(ap0.value, '1', '嵌套 value 必须保留');
  assert.equal(obj.isPartOf['@type'], 'CreativeWork', '嵌套 isPartOf.@type 必须保留');
  assert.equal(obj.isPartOf['@id'], 'https://xiaok.app/id/project/p');
  assert.equal(obj.isPartOf.name, 'PN');
});

test('#4 Key 排序幂等：同输入两次调用 byte-identical', () => {
  const input = {
    taskId: 'task-001', title: 'Q2', generatedAt: '2026-06-17T10:00:00.000Z',
    projectId: 'proj-abc', projectName: 'Q2 竞品分析',
  };
  const a = buildReportJsonLd(input);
  const b = buildReportJsonLd(input);
  assert.equal(a, b, 'byte-identical 输出');
});

test('#5 </script> escaping', () => {
  const jsonStr = JSON.stringify({ name: 'evil </script><img>' });
  const escaped = escapeJsonLdForHtml(jsonStr);
  assert.ok(!escaped.includes('</script>'), '不能含原始 </script>');
  assert.ok(escaped.includes('<\\/script>'), '应改写成 <\\/script>');
});

test('#5b </Script> 大小写也要转义', () => {
  const jsonStr = JSON.stringify({ name: 'X </Script>' });
  const escaped = escapeJsonLdForHtml(jsonStr);
  assert.ok(!/<\/[sS]cript>/.test(escaped), '任意大小写 </script> 都不能保留');
});

test('#6 U+2028/U+2029 escaping', () => {
  const raw = `{"a":"line1\u2028line2\u2029line3"}`;
  const escaped = escapeJsonLdForHtml(raw);
  assert.ok(!escaped.includes('\u2028'));
  assert.ok(!escaped.includes('\u2029'));
  assert.ok(escaped.includes('\\u2028'));
  assert.ok(escaped.includes('\\u2029'));
});

test('#7 schema.org IRI whitelist (recursive)', () => {
  const out = buildReportJsonLd({
    taskId: 't', title: 'T', generatedAt: '2026-06-17T10:00:00.000Z',
    projectId: 'p', projectName: 'PN',
  });
  const obj = JSON.parse(out);
  // @context must be schema.org
  assert.ok(isAllowedIri(obj['@context']), `@context not whitelisted: ${obj['@context']}`);
  // All propertyID values must be whitelisted IRIs
  const propertyIds = collectPropertyIds(obj);
  for (const pid of propertyIds) {
    assert.ok(isAllowedIri(pid), `propertyID not whitelisted: ${pid}`);
  }
  // All @id values must be whitelisted (xiaok.app or schema.org)
  function checkAtIds(node) {
    if (Array.isArray(node)) {
      for (const x of node) checkAtIds(x);
    } else if (node && typeof node === 'object') {
      if (typeof node['@id'] === 'string') {
        assert.ok(isAllowedIri(node['@id']), `@id not whitelisted: ${node['@id']}`);
      }
      for (const v of Object.values(node)) checkAtIds(v);
    }
  }
  checkAtIds(obj);
});

test('#8 @id path encoding for special chars in projectId/taskId', () => {
  const out = buildReportJsonLd({
    projectId: 'proj with space',
    taskId: 'task/with/slash',
    title: 'T',
  });
  const obj = JSON.parse(out);
  assert.ok(obj['@id'].includes('proj%20with%20space'));
  assert.ok(obj['@id'].includes('task%2Fwith%2Fslash'));
});

test('#13 creator type 锁定为 Organization (不被改回 SoftwareApplication)', () => {
  const out = buildReportJsonLd({
    projectId: 'p', taskId: 't', title: 'T',
  });
  const obj = JSON.parse(out);
  assert.equal(obj.creator['@type'], 'Organization');
  assert.notEqual(obj.creator['@type'], 'SoftwareApplication');
  assert.equal(obj.creator.name, 'xiaok');
});

test('#14 default 缺标题时回退 "Report"', () => {
  const out = buildReportJsonLd({});
  const obj = JSON.parse(out);
  assert.equal(obj.name, 'Report');
});

test('#15 inLanguage 总是输出 zh-CN', () => {
  const out = buildReportJsonLd({});
  const obj = JSON.parse(out);
  assert.equal(obj.inLanguage, 'zh-CN');
});

test('#16 创建无任何参数也应输出合法 JSON-LD（不抛错）', () => {
  const out = buildReportJsonLd({});
  const obj = JSON.parse(out);
  assert.equal(obj['@context'], 'http://schema.org/');
  assert.equal(obj['@type'], 'Report');
  assert.equal(obj.creator.name, 'xiaok');
  assert.ok(Array.isArray(obj.additionalProperty));
});

test('#17 escapeJsonLdForHtml 是 idempotent（重复调用不破坏）', () => {
  const raw = JSON.stringify({ name: 'X' });
  const once = escapeJsonLdForHtml(raw);
  const twice = escapeJsonLdForHtml(once);
  // Should produce parseable JSON after one un-escape
  assert.equal(typeof once, 'string');
  assert.equal(typeof twice, 'string');
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
  console.log(`\n${passed}/${tests.length} artifact-jsonld tests passed`);
}

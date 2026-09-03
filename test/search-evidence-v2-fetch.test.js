/**
 * KSwarm — fetchPageEvidenceV2 unit tests
 *
 * 设计依据：design §3.5（v2 fetch 规则：原子落盘、精确 hash、截断标记）
 *
 * Run: node test/search-evidence-v2-fetch.test.js
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPageEvidenceV2 } from '../src/core/search-evidence.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fakeFetch(bodyText, { status = 200, ok = true, headers = {} } = {}) {
  return async () => ({
    ok,
    status,
    headers: { get: (key) => headers[key.toLowerCase()] ?? null },
    // 使用 Uint8Array.buffer 的精确切片，而不是 Buffer.from(...).buffer——
    // Node 的 Buffer 分配器可能使用一个更大的内部 pool，直接读 .buffer 会
    // 拿到整个底层 ArrayBuffer（例如默认 8KB/64KB pool），而不是精确的内容
    // 字节数。必须用 byteOffset/byteLength 做精确切片。
    arrayBuffer: async () => {
      const buf = Buffer.from(bodyText, 'utf-8');
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  });
}

test('successfully fetches and atomically writes a snapshot, with hash covering the exact stored bytes', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-snapshot-'));
  const body = 'hello world, this is the fetched page content';
  const result = await fetchPageEvidenceV2('https://example.com/page', {
    fetchFn: fakeFetch(body, { headers: { 'content-length': String(Buffer.byteLength(body)) } }),
    snapshotDir,
    snapshotFilename: 'page-1.html',
  });

  assert.equal(result.ok, true);
  assert.equal(result.fetchCompleted, true);
  assert.equal(result.truncated, false);
  assert.equal(result.bytesStored, Buffer.byteLength(body));
  assert.equal(result.contentLength, Buffer.byteLength(body));

  const written = readFileSync(join(snapshotDir, 'page-1.html'));
  assert.equal(written.toString('utf-8'), body);
  const expectedHash = `sha256:${createHash('sha256').update(written).digest('hex')}`;
  assert.equal(result.contentHash, expectedHash);

  // no leftover .tmp- files after successful rename
  const remaining = readdirSync(snapshotDir);
  assert.deepEqual(remaining, ['page-1.html']);

  rmSync(snapshotDir, { recursive: true, force: true });
});

test('truncates content exceeding maxBytes and marks truncated=true, hash covers only the stored (truncated) bytes', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-snapshot-'));
  const body = 'x'.repeat(1000);
  const result = await fetchPageEvidenceV2('https://example.com/big', {
    fetchFn: fakeFetch(body),
    snapshotDir,
    snapshotFilename: 'big.html',
    maxBytes: 100,
  });

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.bytesStored, 100);

  const written = readFileSync(join(snapshotDir, 'big.html'));
  assert.equal(written.length, 100);
  const expectedHash = `sha256:${createHash('sha256').update(written).digest('hex')}`;
  assert.equal(result.contentHash, expectedHash, 'hash must cover only the stored (truncated) bytes, not the full original body');

  rmSync(snapshotDir, { recursive: true, force: true });
});

test('fails closed when snapshotDir/snapshotFilename are not provided', async () => {
  const result = await fetchPageEvidenceV2('https://example.com/page', {
    fetchFn: fakeFetch('body'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'snapshot_destination_required');
  assert.equal(result.fetchCompleted, false);
});

test('reports fetchCompleted=false and does not throw when the network fetch itself fails', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-snapshot-'));
  const result = await fetchPageEvidenceV2('https://example.com/page', {
    fetchFn: async () => { throw new Error('network unreachable'); },
    snapshotDir,
    snapshotFilename: 'page.html',
  });
  assert.equal(result.ok, false);
  assert.equal(result.fetchCompleted, false);
  assert.match(result.error, /network unreachable/);
  rmSync(snapshotDir, { recursive: true, force: true });
});

test('does not leave a half-written snapshot file if the write step fails before rename', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-snapshot-'));
  const result = await fetchPageEvidenceV2('https://example.com/page', {
    fetchFn: fakeFetch('some content'),
    snapshotDir,
    snapshotFilename: 'page.html',
    writeFileFn: async () => { throw new Error('disk full'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /snapshot_write_failed/);
  // No partial file (neither the temp file nor the final file) should exist —
  // the write never reached the atomic rename step.
  assert.equal(existsSync(join(snapshotDir, 'page.html')), false);
  const remaining = readdirSync(snapshotDir).filter(name => name.includes('page.html'));
  assert.deepEqual(remaining, [], 'no leftover temp file should remain after a failed write');
  rmSync(snapshotDir, { recursive: true, force: true });
});

test('propagates a non-ok HTTP status while still completing the fetch and snapshot write', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-snapshot-'));
  const result = await fetchPageEvidenceV2('https://example.com/missing', {
    fetchFn: fakeFetch('Not Found', { status: 404, ok: false }),
    snapshotDir,
    snapshotFilename: 'missing.html',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.fetchCompleted, true, 'a completed fetch with a non-2xx status is still a completed fetch, distinct from a network failure');
  rmSync(snapshotDir, { recursive: true, force: true });
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.message || err);
  }
}
console.log(`\n${passed}/${tests.length} search-evidence v2 fetch tests passed`);
if (passed !== tests.length) process.exitCode = 1;

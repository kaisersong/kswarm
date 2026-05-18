/**
 * KSwarm — event log persistence tests
 *
 * Covers:
 *   1. Write + replay round-trip
 *   2. Day rollover within one process
 *   3. Replay window honors replayDays (today + N-1 days)
 *   4. Per-project bucket truncation with events.truncated marker
 *   5. Corrupt line tolerance during replay
 *   6. Read-only logDir falls back to in-memory mode without throwing
 *   7. Concurrent emit during replay merges correctly
 *   8. seq starting point survives bucket truncation
 *   9. Oversized payload is truncated to keep single line under maxLineBytes
 *  10. Hub integration: createHub → emit → close → re-create → events restored
 *  11. replayDays < 1 normalized
 *  12. Missing logDir auto-created
 *  13. retentionDays prunes old files
 *  14. Backward compat for events without seq/ts
 *  15. Each emit writes exactly one ndjson line (line atomicity smoke test)
 *
 * Run: node test/event-log-persistence.test.js
 */

import assert from 'node:assert/strict';
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdtempSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createEventLog } from '../src/core/event-log.js';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeTempDir(label = 'event-log') {
  return mkdtempSync(join(tmpdir(), `kswarm-${label}-`));
}

function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function writeNdjsonFile(dir, dateStr, events) {
  const path = join(dir, `kswarm-${dateStr}.ndjson`);
  const lines = events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  writeFileSync(path, lines);
  return path;
}

async function waitForReady(log, timeoutMs = 2000) {
  if (typeof log.onReady !== 'function') return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('onReady timeout')), timeoutMs);
    log.onReady(() => { clearTimeout(timer); resolve(); });
  });
}

function installFakeDate(fixedNow) {
  const realDate = global.Date;
  let currentNow = fixedNow instanceof realDate ? fixedNow.getTime() : fixedNow;
  class FakeDate extends realDate {
    constructor(...args) {
      if (args.length === 0) { super(currentNow); return; }
      super(...args);
    }
    static now() { return currentNow; }
  }
  global.Date = FakeDate;
  return {
    setNow(next) { currentNow = next instanceof realDate ? next.getTime() : next; },
    restore() { global.Date = realDate; },
    realDate,
  };
}

// ── 1. Write + replay round-trip ──────────────────────────────────────────
test('round-trip: emit, close, re-create restores events in chronological order', async () => {
  const dir = makeTempDir('roundtrip');
  try {
    const first = createEventLog({ logDir: dir, silent: true });
    await waitForReady(first);
    first.emit('project.created', { projectId: 'p1', projectName: 'A' });
    first.emit('po.assigned', { projectId: 'p1', agent: 'po-1' });
    first.emit('task.dispatched', { projectId: 'p1', taskId: 't1' });
    await first.close();

    const second = createEventLog({ logDir: dir, silent: true });
    await waitForReady(second);
    const restored = second.getEvents();
    assert.equal(restored.length, 3);
    assert.equal(restored[0].type, 'project.created');
    assert.equal(restored[1].type, 'po.assigned');
    assert.equal(restored[2].type, 'task.dispatched');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. Day rollover ───────────────────────────────────────────────────────
test('day rollover writes separate files for separate local days', async () => {
  const dir = makeTempDir('rollover');
  const clock = installFakeDate(new Date('2026-05-17T12:00:00').getTime());
  try {
    const log = createEventLog({ logDir: dir, silent: true });
    await waitForReady(log);
    log.emit('task.progress', { projectId: 'p1', taskId: 't1', stage: 'before-midnight' });
    clock.setNow(new clock.realDate('2026-05-18T12:00:00').getTime());
    log.emit('task.progress', { projectId: 'p1', taskId: 't1', stage: 'after-midnight' });
    log.close();
    await new Promise(r => setTimeout(r, 50));

    const files = readdirSync(dir).filter(n => n.endsWith('.ndjson')).sort();
    assert.equal(files.length, 2, `expected 2 files, got ${files.join(', ')}`);
    const day1 = readFileSync(join(dir, files[0]), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const day2 = readFileSync(join(dir, files[1]), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(day1.length, 1);
    assert.equal(day1[0].stage, 'before-midnight');
    assert.equal(day2.length, 1);
    assert.equal(day2[0].stage, 'after-midnight');
  } finally {
    clock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. replayDays window ──────────────────────────────────────────────────
test('replay window includes today + (replayDays - 1) days', async () => {
  const dir = makeTempDir('window');
  const now = new Date('2026-05-18T12:00:00');
  const clock = installFakeDate(now);
  try {
    for (let i = 0; i < 10; i++) {
      const d = new clock.realDate(now);
      d.setDate(d.getDate() - (9 - i));
      writeNdjsonFile(dir, dayKey(d), [
        { ts: d.toISOString(), seq: i, type: 'task.progress', projectId: 'p1', taskId: `t-${i}` },
      ]);
    }
    const log = createEventLog({ logDir: dir, silent: true, replayDays: 3 });
    await waitForReady(log);
    const events = log.getEvents();
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(e => e.taskId), ['t-7', 't-8', 't-9']);
    log.close();
  } finally {
    clock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replayDays=1 includes only today', async () => {
  const dir = makeTempDir('window-today');
  const now = new Date('2026-05-18T12:00:00');
  const clock = installFakeDate(now);
  try {
    const yesterday = new clock.realDate(now); yesterday.setDate(yesterday.getDate() - 1);
    writeNdjsonFile(dir, dayKey(yesterday), [
      { ts: yesterday.toISOString(), seq: 0, type: 'task.progress', projectId: 'p1', taskId: 'old' },
    ]);
    writeNdjsonFile(dir, dayKey(now), [
      { ts: now.toISOString(), seq: 0, type: 'task.progress', projectId: 'p1', taskId: 'new' },
    ]);
    const log = createEventLog({ logDir: dir, silent: true, replayDays: 1 });
    await waitForReady(log);
    const events = log.getEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].taskId, 'new');
    log.close();
  } finally {
    clock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. Per-project bucket truncation ──────────────────────────────────────
test('per-project truncation keeps tail and inserts events.truncated marker', async () => {
  const dir = makeTempDir('bucket');
  const now = new Date('2026-05-18T12:00:00');
  const clock = installFakeDate(now);
  try {
    const big = [];
    for (let i = 0; i < 8000; i++) {
      big.push({
        ts: new clock.realDate(now.getTime() - (8000 - i) * 1000).toISOString(),
        seq: i,
        type: 'task.progress',
        projectId: 'A',
        taskId: `a-${i}`,
      });
    }
    const small = [];
    for (let i = 0; i < 100; i++) {
      small.push({
        ts: new clock.realDate(now.getTime() - (100 - i) * 1000).toISOString(),
        seq: 8000 + i,
        type: 'task.progress',
        projectId: 'B',
        taskId: `b-${i}`,
      });
    }
    writeNdjsonFile(dir, dayKey(now), [...big, ...small]);

    const log = createEventLog({ logDir: dir, silent: true, perProjectReplayLimit: 5000 });
    await waitForReady(log);
    const events = log.getEvents();

    const aEvents = events.filter(e => e.projectId === 'A' && e.type === 'task.progress');
    const bEvents = events.filter(e => e.projectId === 'B' && e.type === 'task.progress');
    assert.equal(aEvents.length, 5000);
    assert.equal(bEvents.length, 100);
    assert.equal(aEvents[aEvents.length - 1].taskId, 'a-7999');
    assert.equal(aEvents[0].taskId, 'a-3000');

    const truncated = events.filter(e => e.type === 'events.truncated');
    assert.ok(truncated.some(e => e.projectId === 'A' && e.count === 3000),
      'should mark 3000 events truncated for A');
    assert.equal(truncated.filter(e => e.projectId === 'B').length, 0);
    log.close();
  } finally {
    clock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5. Corrupt line tolerance ─────────────────────────────────────────────
test('corrupt lines are skipped without aborting replay', async () => {
  const dir = makeTempDir('corrupt');
  const now = new Date();
  const path = join(dir, `kswarm-${dayKey(now)}.ndjson`);
  writeFileSync(
    path,
    [
      JSON.stringify({ ts: now.toISOString(), type: 'project.created', projectId: 'p1' }),
      'this is not json',
      JSON.stringify({ ts: now.toISOString(), type: 'task.dispatched', projectId: 'p1', taskId: 't1' }),
      JSON.stringify({ projectId: 'p1' }),
      JSON.stringify({ ts: now.toISOString(), type: 'task.done', projectId: 'p1', taskId: 't1' }),
      '',
    ].join('\n') + '\n',
  );
  try {
    const log = createEventLog({ logDir: dir, silent: true });
    await waitForReady(log);
    const types = log.getEvents().map(e => e.type);
    assert.deepEqual(types, ['project.created', 'task.dispatched', 'task.done']);
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 6. logDir not writable ────────────────────────────────────────────────
test('unwritable logDir falls back to in-memory mode without throwing', async () => {
  const bogus = '/__nonexistent_kswarm_root_owned_path__/events';
  const log = createEventLog({ logDir: bogus, silent: true });
  await waitForReady(log);
  log.emit('task.progress', { projectId: 'p', taskId: 't' });
  assert.equal(log.getEvents().length, 1);
  log.close();
});

// ── 7. Concurrent emit during replay ──────────────────────────────────────
test('emit during async replay merges historical + live events without seq collision', async () => {
  const dir = makeTempDir('concurrent');
  const now = new Date('2026-05-18T12:00:00');
  const clock = installFakeDate(now);
  try {
    const historical = [];
    for (let i = 0; i < 50; i++) {
      historical.push({
        ts: new clock.realDate(now.getTime() - (50 - i) * 1000).toISOString(),
        seq: i,
        type: 'task.progress',
        projectId: 'p1',
        taskId: `h-${i}`,
      });
    }
    writeNdjsonFile(dir, dayKey(now), historical);

    const log = createEventLog({ logDir: dir, silent: true });
    log.emit('task.progress', { projectId: 'p1', taskId: 'live-1' });
    log.emit('task.progress', { projectId: 'p1', taskId: 'live-2' });
    await waitForReady(log);
    log.emit('task.progress', { projectId: 'p1', taskId: 'live-3' });

    const events = log.getEvents();
    const taskIds = events.map(e => e.taskId);
    assert.ok(taskIds.includes('h-0'), 'historical preserved');
    assert.ok(taskIds.includes('h-49'), 'historical tail preserved');
    assert.ok(taskIds.includes('live-1'), 'pre-ready emit preserved');
    assert.ok(taskIds.includes('live-3'), 'post-ready emit preserved');

    const seqs = events.filter(e => typeof e.seq === 'number').map(e => e.seq);
    const seen = new Set();
    for (const s of seqs) {
      assert.ok(!seen.has(s), `duplicate seq ${s}`);
      seen.add(s);
    }
    log.close();
  } finally {
    clock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 8. seq starting point after bucket truncation ─────────────────────────
test('seq after bucket truncation starts above highest historical seq', async () => {
  const dir = makeTempDir('seq');
  const now = new Date('2026-05-18T12:00:00');
  const clock = installFakeDate(now);
  try {
    const historical = [];
    for (let i = 0; i < 9000; i++) {
      historical.push({
        ts: new clock.realDate(now.getTime() - (9000 - i) * 1000).toISOString(),
        seq: i,
        type: 'task.progress',
        projectId: 'A',
        taskId: `h-${i}`,
      });
    }
    writeNdjsonFile(dir, dayKey(now), historical);

    const log = createEventLog({ logDir: dir, silent: true, perProjectReplayLimit: 1000 });
    await waitForReady(log);
    const event = log.emit('task.progress', { projectId: 'A', taskId: 'after-truncation' });
    assert.ok(event.seq >= 9000, `expected seq >= 9000, got ${event.seq}`);
    log.close();
  } finally {
    clock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 9. Oversized payload truncation ───────────────────────────────────────
test('emit truncates oversized payloads to keep single line under maxLineBytes', async () => {
  const dir = makeTempDir('oversize');
  try {
    const log = createEventLog({ logDir: dir, silent: true, maxLineBytes: 4000 });
    await waitForReady(log);
    const huge = 'x'.repeat(50_000);
    const event = log.emit('task.failed', {
      projectId: 'p',
      taskId: 't',
      feedback: huge,
      errorMessage: huge,
    });
    assert.equal(event.truncated, true);
    const line = JSON.stringify(event);
    assert.ok(line.length <= 4000, `expected <= 4000B, got ${line.length}`);
    assert.equal(event.type, 'task.failed');
    assert.equal(event.taskId, 't');
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 10. Hub integration ───────────────────────────────────────────────────
test('hub integration: events survive close + re-create cycle', async () => {
  const baseDir = makeTempDir('hub');
  const eventDir = join(baseDir, 'events');
  const stateFile = join(baseDir, 'state.json');
  try {
    const hub1 = createHub({ eventLogDir: eventDir, dataDir: stateFile, silent: true });
    if (typeof hub1.getEventLog().onReady === 'function') {
      await waitForReady(hub1.getEventLog());
    }
    hub1.createProject({
      id: 'p-int',
      name: 'integration',
      goal: 'g',
      poAgent: 'po-1',
      members: [],
    });
    await new Promise(r => setTimeout(r, 700));
    hub1.persistState();
    hub1.getEventLog().close();
    await new Promise(r => setTimeout(r, 100));

    const hub2 = createHub({ eventLogDir: eventDir, dataDir: stateFile, silent: true });
    await waitForReady(hub2.getEventLog());
    const restored = hub2.getEventLog().getEvents();
    assert.ok(
      restored.some(e => e.type === 'project.created' && e.projectId === 'p-int'),
      'project.created event should survive restart',
    );
    hub2.getEventLog().close();
    await new Promise(r => setTimeout(r, 700));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ── 11. replayDays < 1 normalized ────────────────────────────────────────
test('replayDays < 1 is normalized to 1', async () => {
  const dir = makeTempDir('replaydays-zero');
  const now = new Date('2026-05-18T12:00:00');
  const clock = installFakeDate(now);
  try {
    writeNdjsonFile(dir, dayKey(now), [
      { ts: now.toISOString(), type: 'task.progress', projectId: 'p1', taskId: 'today' },
    ]);
    const log = createEventLog({ logDir: dir, silent: true, replayDays: 0 });
    await waitForReady(log);
    assert.equal(log.getEvents().length, 1);
    log.close();
  } finally {
    clock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 12. Missing logDir auto-created ──────────────────────────────────────
test('logDir is created if missing and replay yields no events', async () => {
  const base = makeTempDir('missing-dir');
  const dir = join(base, 'fresh-events');
  try {
    assert.equal(existsSync(dir), false);
    const log = createEventLog({ logDir: dir, silent: true });
    await waitForReady(log);
    assert.equal(existsSync(dir), true, 'directory should be created');
    assert.equal(log.getEvents().length, 0);
    log.emit('project.created', { projectId: 'p', projectName: 'N' });
    log.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── 13. Retention pruning ─────────────────────────────────────────────────
test('retentionDays prunes old ndjson files at startup', async () => {
  const dir = makeTempDir('retention');
  const now = new Date('2026-05-18T12:00:00');
  const clock = installFakeDate(now);
  try {
    const ancient = new clock.realDate(now); ancient.setDate(ancient.getDate() - 60);
    const recent = new clock.realDate(now); recent.setDate(recent.getDate() - 5);
    writeNdjsonFile(dir, dayKey(ancient), [
      { ts: ancient.toISOString(), type: 'task.progress', projectId: 'p', taskId: 'old' },
    ]);
    writeNdjsonFile(dir, dayKey(recent), [
      { ts: recent.toISOString(), type: 'task.progress', projectId: 'p', taskId: 'recent' },
    ]);

    const log = createEventLog({ logDir: dir, silent: true, retentionDays: 30 });
    await waitForReady(log);
    const remaining = readdirSync(dir).filter(n => n.endsWith('.ndjson')).sort();
    assert.equal(remaining.length, 1, `expected 1 file, got ${remaining.join(', ')}`);
    assert.ok(remaining[0].includes(dayKey(recent)), 'recent file kept');
    log.close();
  } finally {
    clock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 14. Backward compat for events without seq/ts ────────────────────────
test('events lacking seq or ts still load and get normalized', async () => {
  const dir = makeTempDir('legacy');
  const now = new Date();
  try {
    writeNdjsonFile(dir, dayKey(now), [
      { type: 'project.created', projectId: 'p1' },
      { ts: now.toISOString(), type: 'task.dispatched', projectId: 'p1', taskId: 't1' },
    ]);
    const log = createEventLog({ logDir: dir, silent: true });
    await waitForReady(log);
    const events = log.getEvents();
    assert.equal(events.length, 2);
    assert.ok(events.every(e => typeof e.seq === 'number'));
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 15. emit writes exactly one ndjson line ──────────────────────────────
test('emit writes exactly one ndjson line per event', async () => {
  const dir = makeTempDir('atomic');
  try {
    const log = createEventLog({ logDir: dir, silent: true });
    await waitForReady(log);
    log.emit('a.x', { projectId: 'p' });
    log.emit('b.y', { projectId: 'p' });
    log.emit('c.z', { projectId: 'p' });
    log.close();
    await new Promise(r => setTimeout(r, 100));

    const files = readdirSync(dir).filter(n => n.endsWith('.ndjson'));
    assert.equal(files.length, 1);
    const content = readFileSync(join(dir, files[0]), 'utf-8');
    const lines = content.split('\n').filter(l => l.length > 0);
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── runner ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(err);
  }
}
console.log(`\n${passed}/${tests.length} event-log persistence tests passed`);
if (failed > 0) process.exitCode = 1;

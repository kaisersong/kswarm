/**
 * Event Log — Structured NDJSON event stream with persistence
 *
 * Every lifecycle event (project created, task dispatched, agent accepted, etc.)
 * is emitted as a single-line JSON record. Events are:
 *
 * 1. Held in an in-memory buffer for fast read access (UI / tests).
 * 2. Appended to a daily NDJSON file under `logDir/kswarm-YYYY-MM-DD.ndjson`.
 * 3. Replayed asynchronously on construction, restoring the most recent
 *    `replayDays` of history into the in-memory buffer. Per-project bucket
 *    truncation keeps the tail of high-traffic projects bounded.
 *
 * The on-disk format is the source of truth for verification (`cat | jq`).
 * The in-memory buffer is the source of truth for runtime queries; it is
 * deliberately allowed to drift from the files (truncation, format changes).
 *
 * Failure modes are warn-only: we never throw out of `emit` or replay so
 * that hub startup and mutations cannot be blocked by disk issues.
 */

import { createWriteStream, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FILE_PATTERN = /^kswarm-(\d{4}-\d{2}-\d{2})\.ndjson$/;
const DEFAULT_REPLAY_DAYS = 7;
const DEFAULT_PER_PROJECT_LIMIT = 5_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_LINE_BYTES = 4_000;
const TRUNCATABLE_FIELDS = ['feedback', 'errorMessage', 'failureReason', 'reason', 'blockedReason', 'brief'];

function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayKeyMinusDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() - days);
  return dayKey(d);
}

export function createEventLog({
  logDir,
  silent = false,
  replayDays = DEFAULT_REPLAY_DAYS,
  perProjectReplayLimit = DEFAULT_PER_PROJECT_LIMIT,
  retentionDays = DEFAULT_RETENTION_DAYS,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
} = {}) {
  const events = [];
  let nextSeq = 0;
  let fileStream = null;
  let currentDay = null;
  let logDirReady = false;
  let ready = false;
  const readyCbs = [];

  const normalizedReplayDays = Math.max(1, Math.floor(Number(replayDays) || 0) || DEFAULT_REPLAY_DAYS);

  // ── Setup logDir ───────────────────────────────────────────────────────
  if (logDir) {
    try {
      mkdirSync(logDir, { recursive: true });
      logDirReady = true;
    } catch (err) {
      if (!silent) console.warn(`[event-log] logDir not writable, falling back to memory: ${err.message}`);
      logDirReady = false;
    }
  }

  // ── Replay ─────────────────────────────────────────────────────────────
  function listEventFiles() {
    if (!logDirReady) return [];
    try {
      return readdirSync(logDir)
        .filter(name => FILE_PATTERN.test(name))
        .sort();
    } catch (err) {
      if (!silent) console.warn(`[event-log] failed to list ${logDir}: ${err.message}`);
      return [];
    }
  }

  function pruneOldFiles() {
    if (!logDirReady) return;
    const cutoff = dayKeyMinusDays(new Date(), Math.max(1, Math.floor(Number(retentionDays) || 0)));
    for (const name of listEventFiles()) {
      const m = FILE_PATTERN.exec(name);
      if (!m) continue;
      if (m[1] < cutoff) {
        try { unlinkSync(join(logDir, name)); } catch (err) {
          if (!silent) console.warn(`[event-log] failed to prune ${name}: ${err.message}`);
        }
      }
    }
  }

  function bucketAndTruncate(rawEvents) {
    const buckets = new Map();
    for (const ev of rawEvents) {
      const key = ev.projectId ?? '__nopid__';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(ev);
    }
    const out = [];
    for (const [projectId, bucket] of buckets.entries()) {
      if (bucket.length > perProjectReplayLimit) {
        const dropped = bucket.length - perProjectReplayLimit;
        const kept = bucket.slice(-perProjectReplayLimit);
        const marker = {
          type: 'events.truncated',
          projectId: projectId === '__nopid__' ? undefined : projectId,
          count: dropped,
          ts: kept[0]?.ts || new Date().toISOString(),
        };
        out.push(marker, ...kept);
      } else {
        out.push(...bucket);
      }
    }
    out.sort((a, b) => {
      const ta = a.ts || '';
      const tb = b.ts || '';
      if (ta === tb) return 0;
      return ta < tb ? -1 : 1;
    });
    return out;
  }

  async function replay() {
    if (!logDirReady) return { restored: [], maxSeq: -1 };
    pruneOldFiles();

    const cutoff = dayKeyMinusDays(new Date(), normalizedReplayDays - 1);
    const files = listEventFiles().filter(name => {
      const m = FILE_PATTERN.exec(name);
      return m && m[1] >= cutoff;
    });

    const raw = [];
    let maxSeq = -1;
    for (const name of files) {
      let content = '';
      try {
        content = readFileSync(join(logDir, name), 'utf-8');
      } catch (err) {
        if (!silent) console.warn(`[event-log] failed to read ${name}: ${err.message}`);
        continue;
      }
      for (const line of content.split('\n')) {
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch {
          if (!silent) console.warn(`[event-log] skipping corrupt line in ${name}`);
          continue;
        }
        if (!parsed || typeof parsed.type !== 'string') {
          if (!silent) console.warn(`[event-log] skipping malformed event in ${name}`);
          continue;
        }
        if (typeof parsed.seq === 'number' && parsed.seq > maxSeq) maxSeq = parsed.seq;
        raw.push(parsed);
      }
    }

    const restored = bucketAndTruncate(raw);
    let nextSeqForLegacy = maxSeq + 1;
    for (const ev of restored) {
      if (typeof ev.seq !== 'number') ev.seq = nextSeqForLegacy++;
      if (!ev.ts) ev.ts = new Date().toISOString();
      if (ev.seq > maxSeq) maxSeq = ev.seq;
    }
    return { restored, maxSeq };
  }

  function ensureFileStreamForToday() {
    if (!logDirReady) return;
    const day = dayKey();
    if (day === currentDay && fileStream) return;
    if (fileStream) {
      try { fileStream.end(); } catch { /* ignore */ }
    }
    currentDay = day;
    try {
      fileStream = createWriteStream(join(logDir, `kswarm-${day}.ndjson`), { flags: 'a' });
      fileStream.on('error', (err) => {
        if (!silent) console.warn(`[event-log] write stream error: ${err.message}`);
      });
    } catch (err) {
      if (!silent) console.warn(`[event-log] failed to open ${day} stream: ${err.message}`);
      fileStream = null;
    }
  }

  function truncateLongFields(event) {
    const line = JSON.stringify(event);
    if (line.length <= maxLineBytes) return event;

    const overhead = line.length - maxLineBytes;
    const truncated = { ...event, truncated: true };
    let savings = 0;
    for (const key of TRUNCATABLE_FIELDS) {
      if (savings >= overhead + 32) break; // small buffer for added "truncated" field
      const value = truncated[key];
      if (typeof value !== 'string' || value.length === 0) continue;
      const remaining = overhead + 32 - savings;
      const cutTo = Math.max(0, value.length - Math.min(value.length, remaining + 16));
      const newValue = value.slice(0, Math.min(value.length, Math.max(120, cutTo)));
      const safeNewValue = newValue.length < value.length ? newValue + '…[truncated]' : newValue;
      savings += value.length - safeNewValue.length;
      truncated[key] = safeNewValue;
    }

    let result = JSON.stringify(truncated);
    if (result.length > maxLineBytes) {
      // hard cap: nuke the largest field entirely
      let largestKey = null;
      let largestLen = 0;
      for (const [k, v] of Object.entries(truncated)) {
        if (typeof v === 'string' && v.length > largestLen) {
          largestKey = k; largestLen = v.length;
        }
      }
      if (largestKey) {
        truncated[largestKey] = '[truncated]';
        result = JSON.stringify(truncated);
      }
    }
    if (result.length > maxLineBytes && !silent) {
      console.warn(`[event-log] event still > ${maxLineBytes}B after truncation: ${result.length}`);
    }
    return truncated;
  }

  // ── Public API ────────────────────────────────────────────────────────
  function emit(type, payload = {}) {
    let event = {
      ts: new Date().toISOString(),
      seq: nextSeq++,
      type,
      ...payload,
    };
    event = truncateLongFields(event);

    events.push(event);

    if (logDirReady) {
      ensureFileStreamForToday();
      if (fileStream) {
        try {
          fileStream.write(JSON.stringify(event) + '\n');
        } catch (err) {
          if (!silent) console.warn(`[event-log] write failed: ${err.message}`);
        }
      }
    }

    if (!silent) printEvent(event);
    return event;
  }

  function printEvent(event) {
    const time = (event.ts || '').split('T')[1]?.split('.')[0] || '';
    const symbols = {
      'project.created': '📁',
      'project.planned': '📋',
      'project.activated': '▶️',
      'project.delivered': '✅',
      'task.ready': '⏳',
      'task.dispatched': '📤',
      'task.accepted': '🤝',
      'task.progress': '⚙️',
      'task.done': '✓',
      'task.failed': '✗',
      'agent.online': '🟢',
      'agent.offline': '🔴',
      'agent.busy': '🟡',
      'approval.requested': '❓',
      'approval.granted': '👍',
    };
    const sym = symbols[event.type] || '•';
    const detail = event.title || event.agent || event.projectName || '';
    process.stderr.write(`  ${time} ${sym} ${event.type} ${detail}\n`);
  }

  function getEvents(filter) {
    if (!filter) return [...events];
    return events.filter(e => e.type === filter || e.type.startsWith(filter + '.'));
  }

  function getLastOf(type) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === type) return events[i];
    }
    return null;
  }

  function close() {
    if (!fileStream) return Promise.resolve();
    const stream = fileStream;
    fileStream = null;
    return new Promise((resolve) => {
      try {
        stream.end(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  function isReady() { return ready; }

  function onReady(cb) {
    if (ready) {
      // Defer to next tick so callers can wire up before the callback fires.
      queueMicrotask(() => cb());
      return;
    }
    readyCbs.push(cb);
  }

  // ── Kick off async replay ─────────────────────────────────────────────
  (async () => {
    try {
      const { restored, maxSeq } = await replay();

      // Capture any events that were emitted during replay.
      const liveEmitted = events.splice(0, events.length);

      // Restore historical first.
      for (const ev of restored) events.push(ev);

      // Re-append live events, bumping their seq above any historical ones to avoid collisions.
      let seqStart = Math.max(maxSeq, restored.length - 1) + 1;
      for (const ev of liveEmitted) {
        ev.seq = seqStart++;
        events.push(ev);
      }
      nextSeq = seqStart;
    } catch (err) {
      if (!silent) console.warn(`[event-log] replay failed: ${err.message}`);
    } finally {
      ready = true;
      const cbs = readyCbs.splice(0, readyCbs.length);
      for (const cb of cbs) {
        try { cb(); } catch (err) {
          if (!silent) console.warn(`[event-log] onReady callback threw: ${err.message}`);
        }
      }
    }
  })();

  return {
    emit,
    getEvents,
    getLastOf,
    close,
    isReady,
    onReady,
  };
}

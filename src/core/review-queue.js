/**
 * Durable review queue.
 *
 * Pure in-memory data structure (snapshot/restore for persistence) that tracks
 * `review_submission` deliveries to the PO. A submission is only considered
 * resolved once the PO acks it; until then it stays sendable so a reconnecting
 * PO gets the backlog replayed.
 *
 * dedupe key = projectId/taskId/submittedAt/resultHash
 * statuses: pending -> sent -> acked (terminal) | failed (sendable again)
 */

import { createHash } from 'node:crypto';

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function hashReviewResult(result) {
  return createHash('sha256').update(stableStringify(result ?? null)).digest('hex').slice(0, 16);
}

export function reviewDedupeKey({ projectId, taskId, submittedAt, result }) {
  return `${projectId}::${taskId}::${submittedAt}::${hashReviewResult(result)}`;
}

const SENDABLE_STATUSES = new Set(['pending', 'failed']);

export function createReviewQueue() {
  const entries = new Map();

  function enqueue(submission) {
    const key = reviewDedupeKey(submission);
    const existing = entries.get(key);
    if (existing) {
      return { ok: true, deduped: true, entry: existing };
    }
    const now = Date.now();
    const entry = {
      key,
      projectId: submission.projectId,
      taskId: submission.taskId,
      submittedAt: submission.submittedAt,
      fromWorker: submission.fromWorker || null,
      result: submission.result ?? null,
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    entries.set(key, entry);
    return { ok: true, deduped: false, entry };
  }

  function get(key) {
    return entries.get(key) || null;
  }

  function markSent(key) {
    const entry = entries.get(key);
    if (!entry) return { ok: false, error: 'review_entry_not_found' };
    entry.status = 'sent';
    entry.attempts += 1;
    entry.lastError = null;
    entry.updatedAt = Date.now();
    return { ok: true, entry };
  }

  function markAcked(key) {
    const entry = entries.get(key);
    if (!entry) return { ok: false, error: 'review_entry_not_found' };
    entry.status = 'acked';
    entry.ackedAt = Date.now();
    entry.updatedAt = entry.ackedAt;
    return { ok: true, entry };
  }

  function markFailed(key, reason = null) {
    const entry = entries.get(key);
    if (!entry) return { ok: false, error: 'review_entry_not_found' };
    entry.status = 'failed';
    entry.lastError = reason;
    entry.updatedAt = Date.now();
    return { ok: true, entry };
  }

  function listSendable() {
    return [...entries.values()].filter(e => SENDABLE_STATUSES.has(e.status));
  }

  function listPending() {
    return [...entries.values()].filter(e => e.status !== 'acked');
  }

  function snapshot() {
    return { schemaVersion: 1, entries: [...entries.values()].map(e => ({ ...e })) };
  }

  function restore(snap) {
    entries.clear();
    if (!snap || snap.schemaVersion !== 1 || !Array.isArray(snap.entries)) return;
    for (const e of snap.entries) {
      if (e && e.key) entries.set(e.key, { ...e });
    }
  }

  return { enqueue, get, markSent, markAcked, markFailed, listSendable, listPending, snapshot, restore };
}

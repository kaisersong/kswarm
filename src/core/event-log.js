/**
 * Event Log — Structured NDJSON event stream
 *
 * Every lifecycle event (project created, task dispatched, agent accepted, etc.)
 * is emitted as a single-line JSON record. This serves as:
 *
 * 1. Verification: `cat events.ndjson | jq` to see full history
 * 2. Debugging: replay events to understand what happened
 * 3. Integration: pipe to HexDeck or any dashboard later
 * 4. Testing: assert on emitted events in integration tests
 *
 * No UI needed — the log IS the observable state.
 */

import { createWriteStream } from 'fs';
import { join } from 'path';
import { mkdirSync } from 'fs';

export function createEventLog({ logDir, silent = false } = {}) {
  const events = []; // In-memory buffer for testing
  let fileStream = null;

  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `kswarm-${Date.now()}.ndjson`);
    fileStream = createWriteStream(logPath, { flags: 'a' });
    if (!silent) {
      console.log(`[event-log] Writing to ${logPath}`);
    }
  }

  function emit(type, payload) {
    const event = {
      ts: new Date().toISOString(),
      seq: events.length,
      type,
      ...payload,
    };

    events.push(event);

    // Write to file
    const line = JSON.stringify(event);
    if (fileStream) {
      fileStream.write(line + '\n');
    }

    // Print to terminal (human-readable one-liner)
    if (!silent) {
      printEvent(event);
    }

    return event;
  }

  function printEvent(event) {
    const time = event.ts.split('T')[1].split('.')[0];
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
    if (fileStream) fileStream.end();
  }

  return { emit, getEvents, getLastOf, close };
}

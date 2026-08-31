/**
 * KSwarm server Room event publisher ownership contract.
 *
 * Run: node test/server-room-event-publisher-contract.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/server/index.js'), 'utf-8');

assert.match(source, /function startRoomEventOutboxPublisher\(\)/);
assert.match(source, /roomEventOutboxFlushInFlight/);
assert.match(source, /hub\.flushRoomEventOutbox\(\)/);
assert.match(source, /setInterval\(flushRoomEventOutboxOnce,/);
assert.match(source, /startRoomEventOutboxPublisher\(\)/);
assert.match(source, /clearInterval\(roomEventOutboxTimer\)/);

console.log('1/1 server room event publisher contract tests passed');

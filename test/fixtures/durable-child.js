/**
 * Test fixture: create a Hub with a SQLite backend, commit one mutation, then
 * stay alive so the parent test can SIGKILL it and verify durable recovery.
 */
import { createHub } from '../../src/core/hub.js';

const filePath = process.argv[2];
const hub = createHub({ silent: true, dataDir: { backend: 'sqlite', filePath } });
hub.createProject({ id: 'kill-p', name: 'Kill', goal: 'g', poAgent: 'po-1', members: [] });
process.stdout.write('COMMITTED\n');
setInterval(() => {}, 1000);

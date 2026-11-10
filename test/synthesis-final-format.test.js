import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createHub } from '../src/core/hub.js';

test('real synthesis HTTP binds final format while preserving candidate and approval gates', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'synthesis-format-'));
  let child;
  try {
    const hub = createHub({ silent: true, dataDir: { backend: 'sqlite', filePath: join(root, 'state.sqlite'), legacyJsonPath: join(root, 'state.json') } });
    const fixtures = [
      ['html', 'report.HTML', '<!DOCTYPE html><html><body>Fixture report</body></html>', 'html'],
      ['markdown', 'report.md', '# Fixture report', 'markdown'],
      ['unknown', 'report.txt', 'Fixture report', 'markdown'],
      ['invalid-html', 'report.html', 'Plain text pretending to be HTML', null],
      ['missing', 'missing.html', null, null],
      ['outside', '../outside.html', '<html>Outside</html>', null],
    ];
    for (const [id, filename, content] of fixtures) {
      const workFolder = join(root, 'projects', id);
      mkdirSync(join(workFolder, 'artifacts'), { recursive: true });
      const path = join(workFolder, 'artifacts', filename);
      // outside must actually be outside the project workspace.
      const artifactPath = id === 'outside' ? join(root, 'outside.html') : path;
      if (content !== null) writeFileSync(artifactPath, content);
      hub.createProject({ id, name: 'Fixture', goal: 'Fixture', poAgent: 'po', members: ['worker'], workFolder });
      hub.handleCreateTasks(id, [{ id: 'final', title: 'Fixture', assignedAgent: 'worker' }], 'po');
      hub.mutateProjectState(id, () => {
        hub.getProject(id).workFolder = workFolder;
        const task = hub.getBoard(id).getAllTasks()[0];
        task.status = 'done';
        task.reviewResult = { passed: true };
        task.result = { summary: 'Fixture', artifacts: [{ filename, path: artifactPath, role: 'primary' }] };
      });
      if (id === 'html') {
        const old = hub.handleDeliver(id, { artifactRef: { path: artifactPath } }, 'po', { workspacePath: workFolder, taskId: `${id}__final` });
        assert.equal(old.finalDeliverable.expectedFormat, 'markdown');
      }
    }
    hub.closePersistence();
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    child = spawn(process.execPath, ['src/server/index.js'], { cwd: process.cwd(), env: {
      ...process.env, HOME: root, USERPROFILE: root, KSWARM_DATA_ROOT: root,
      KSWARM_PORT: String(port), BROKER_URL: 'http://127.0.0.1:1', KSWARM_DESKTOP_MUTATION_TOKEN: 'fixture-token',
    }, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    for (;;) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* startup */ }
      if (child.exitCode !== null || Date.now() > deadline) throw Error('isolated synthesis server unavailable');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const synthesize = async (id, fromAgent) => {
      const detail = await (await fetch(`${base}/projects/${id}`)).json();
      return (await fetch(`${base}/projects/${id}/synthesize`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-kswarm-mutation-token': 'fixture-token' },
      body: JSON.stringify({ fromAgent: fromAgent ?? detail.project.poAgent, synthesis: 'Fixture project synthesis.' }),
    })).json();
    };
    for (const [id, , , expected] of fixtures) {
      const result = await synthesize(id);
      if (expected) {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.finalDeliverable.expectedFormat, expected, id);
        assert.equal(result.status, 'awaiting_user_approval');
        assert.equal((await synthesize(id)).finalDeliverable.deliverableId, result.finalDeliverable.deliverableId);
      } else assert.equal(result.ok, false, `${id}: ${JSON.stringify(result)}`);
    }
    assert.equal((await synthesize('html', 'not-po')).ok, false);
    const detail = await (await fetch(`${base}/projects/html`)).json();
    assert.notEqual(detail.project.status, 'delivered');
    assert.deepEqual(detail.deliverables.map(d => d.expectedFormat).sort(), ['html', 'markdown']);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

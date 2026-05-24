import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskHandoffPackage } from '../src/core/handoff-package.js';

const root = mkdtempSync(join(tmpdir(), 'kswarm-handoff-'));
try {
  const result = createTaskHandoffPackage({
    projectRoot: root,
    project: { id: 'proj-1', name: 'Project', goal: 'Write report', requirements: 'Use sources' },
    task: {
      id: 'proj-1__item-1',
      localTaskId: 'item-1',
      title: 'Research',
      brief: 'Collect sources',
      acceptanceCriteria: 'Include source links',
      requiredOutputs: [{ type: 'markdown', enforcement: 'hard' }, { kind: 'report_html' }, 'json'],
      evidenceContract: { version: 1, kind: 'external_source_v1', required: true },
      executionContract: { version: 1, requireMeaningfulSummary: true },
      repairInstruction: 'Previous submission had no artifacts',
    },
    runId: 'run-1',
    targetParticipantId: 'xiaok-worker@inst-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.handoff.kind, 'kswarm_task_handoff_v1');
  assert.equal(result.handoff.runId, 'run-1');
  assert.equal(result.handoff.targetParticipantId, 'xiaok-worker@inst-1');
  assert.match(result.handoffPath, /handoffs\/run-1\/request\.json$/);

  const persisted = JSON.parse(readFileSync(result.handoffPath, 'utf-8'));
  assert.equal(persisted.project.id, 'proj-1');
  assert.equal(persisted.task.id, 'proj-1__item-1');
  assert.equal(persisted.task.acceptanceCriteria, 'Include source links');
  assert.deepEqual(persisted.task.requiredOutputs, ['markdown', 'report_html', 'json']);
  assert.equal(persisted.task.evidenceContract.required, true);
  assert.equal(persisted.task.executionContract.requireMeaningfulSummary, true);
  assert.equal(persisted.task.repairInstruction, 'Previous submission had no artifacts');
  assert.equal(persisted.contextPolicy.largeContent, 'file_reference_only');
  assert.equal(JSON.stringify(persisted).includes('apiKey'), false);

  console.log('✓ handoff package writes file-only runtime request');
} finally {
  rmSync(root, { recursive: true, force: true });
}

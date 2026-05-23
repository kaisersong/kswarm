import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrokerTaskRequest } from '../src/server/broker-task-request.js';

test('createBrokerTaskRequest persists a file handoff and includes only file references in request_task payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'kswarm-broker-task-request-'));
  try {
    const result = createBrokerTaskRequest({
      handoffRoot: join(root, 'handoffs'),
      project: {
        id: 'proj-1',
        name: 'Project',
        goal: 'Write report',
        requirements: 'Use current sources',
        workFolder: join(root, 'project'),
      },
      workspace: {
        path: join(root, 'project'),
        artifacts: join(root, 'project', 'artifacts'),
      },
      task: {
        id: 'task-1',
        localTaskId: 'item-1',
        activeRunId: 'run-1',
        attempt: 1,
        title: 'Write',
        brief: 'Write report',
        requiredOutputs: ['report_html'],
        assignedAgent: 'xiaok-worker',
      },
      targetAgent: 'xiaok-worker',
    });

    assert.equal(result.ok, true);
    assert.equal(result.request.taskId, 'task-1');
    assert.equal(result.request.payload.handoffPath, result.handoffPath);
    assert.equal(result.request.payload.projectRequirements, undefined);
    assert.equal(result.request.payload.apiKey, undefined);

    const handoff = JSON.parse(readFileSync(result.handoffPath, 'utf-8'));
    assert.equal(handoff.kind, 'kswarm_task_handoff_v1');
    assert.equal(handoff.runId, 'run-1');
    assert.equal(handoff.project.workFolder, join(root, 'project'));
    assert.equal(handoff.project.artifactsDir, join(root, 'project', 'artifacts'));
    assert.equal(handoff.contextPolicy.largeContent, 'file_reference_only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

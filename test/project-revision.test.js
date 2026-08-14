import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const hub = createHub({ silent: true });
const project = hub.createProject({ id: 'project-1', name: 'Alpha', goal: 'goal', poAgent: 'po', members: ['worker'], autoAssignPo: false });
assert.equal(project.projectRevision, 1);

hub.handleHumanAddTasks(project.id, [{ title: 'Implement', description: 'work' }]);
assert.equal(hub.getProject(project.id).projectRevision, 2);

hub.setProjectTeamPlan(project.id, { planDigest: 'old', projectRevision: 2, status: 'proposed', roles: [] });
hub.invalidateTeamPlansForAgent('worker');
assert.equal(hub.getProject(project.id).projectRevision, 3);
assert.equal(hub.getProject(project.id).teamPlan.status, 'stale');
console.log('project-revision: 1/1 passed');

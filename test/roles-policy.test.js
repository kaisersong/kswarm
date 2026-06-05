import assert from 'node:assert/strict';
import {
  agentHasExplicitRole,
  agentMatchesRole,
  isWorkerEligible,
  isProjectOwnerEligible,
} from '../src/core/roles.js';

const roleless = { id: 'a', roles: [] };
const rolelessUndef = { id: 'b' };
const worker = { id: 'w', roles: ['worker'] };
const po = { id: 'p', roles: ['project_owner'] };
const both = { id: 'pw', roles: ['project_owner', 'worker'] };

// agentHasExplicitRole — strict membership
assert.equal(agentHasExplicitRole(roleless, 'worker'), false, 'role-less has no explicit worker');
assert.equal(agentHasExplicitRole(rolelessUndef, 'worker'), false, 'undefined roles has no explicit worker');
assert.equal(agentHasExplicitRole(worker, 'worker'), true);
assert.equal(agentHasExplicitRole(po, 'project_owner'), true);
assert.equal(agentHasExplicitRole(worker, undefined), true, 'no role requested → true');

// agentMatchesRole — gating semantics: role-less is worker-universal, PO must be explicit
assert.equal(agentMatchesRole(roleless, 'worker'), true, 'role-less matches worker');
assert.equal(agentMatchesRole(rolelessUndef, 'worker'), true, 'undefined roles matches worker');
assert.equal(agentMatchesRole(roleless, 'project_owner'), false, 'role-less must NOT match PO');
assert.equal(agentMatchesRole(rolelessUndef, 'project_owner'), false, 'undefined roles must NOT match PO');
assert.equal(agentMatchesRole(worker, 'project_owner'), false, 'pure worker is not PO');
assert.equal(agentMatchesRole(po, 'project_owner'), true);
assert.equal(agentMatchesRole(both, 'project_owner'), true);
assert.equal(agentMatchesRole(po, 'worker'), false, 'pure PO does not match worker by explicit roles');
assert.equal(agentMatchesRole(worker, undefined), true, 'no role requested → true');

// isWorkerEligible — role-less OR explicit worker
assert.equal(isWorkerEligible(roleless), true, 'role-less is worker eligible');
assert.equal(isWorkerEligible(rolelessUndef), true, 'undefined roles is worker eligible');
assert.equal(isWorkerEligible(worker), true);
assert.equal(isWorkerEligible(both), true);
assert.equal(isWorkerEligible(po), false, 'pure PO is not worker eligible');
assert.equal(isWorkerEligible(null), false);

// isProjectOwnerEligible — explicit project_owner only
assert.equal(isProjectOwnerEligible(roleless), false, 'role-less is NOT PO eligible');
assert.equal(isProjectOwnerEligible(rolelessUndef), false, 'undefined roles is NOT PO eligible');
assert.equal(isProjectOwnerEligible(worker), false, 'pure worker is NOT PO eligible');
assert.equal(isProjectOwnerEligible(po), true);
assert.equal(isProjectOwnerEligible(both), true);
assert.equal(isProjectOwnerEligible(null), false);

console.log('roles-policy.test.js: all assertions passed');

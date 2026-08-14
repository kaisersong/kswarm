import assert from 'node:assert/strict';
import { createMutationAuthority } from '../src/core/persistence-hub.js';

const authority = createMutationAuthority({ token: 'desktop-token' });
assert.equal(authority.authorize({ method: 'POST', path: '/agents', headers: {}, requestSource: 'user' }).ok, false);
assert.equal(authority.authorize({ method: 'POST', path: '/agents', headers: { 'x-kswarm-mutation-token': 'desktop-token' }, requestSource: 'agent' }).ok, false);
assert.equal(authority.authorize({ method: 'POST', path: '/agents', headers: { 'x-kswarm-mutation-token': 'desktop-token' }, requestSource: 'user' }).ok, true);
assert.equal(authority.authorize({ method: 'GET', path: '/agents/agent-1/probe', headers: {}, requestSource: 'user' }).ok, false);
assert.equal(authority.authorize({ method: 'DELETE', path: '/projects/p1/members/a', headers: { 'x-kswarm-mutation-token': 'desktop-token' }, requestSource: 'user' }).ok, true);
console.log('server-mutation-authority: 1/1 passed');

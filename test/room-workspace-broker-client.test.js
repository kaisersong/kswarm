import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBrokerClient} from '../src/net/broker-client.js';

test('workspace broker requests require KSwarm authentication and encode room identity',async()=>{
  const calls=[];
  const fetchImpl=async(url,init)=>{calls.push({url,init});return {json:async()=>({ok:true})};};
  const denied=createBrokerClient({participantId:'kswarm',roomSystemToken:null,fetchImpl});
  assert.equal((await denied.verifyWorkspaceMappingTicket({roomId:'room',ticketId:'t'})).ok,false);
  assert.equal(calls.length,0);
  const client=createBrokerClient({participantId:'kswarm',roomSystemToken:'secret-test',fetchImpl});
  await client.verifyWorkspaceMappingTicket({roomId:'r/a',ticketId:'t'});
  await client.verifyWorkspaceClaim({roomId:'r/a',claimId:'c',projectId:'p'});
  await client.verifyWorkspaceCommitTicket({roomId:'r/a',ticketId:'ct',claimId:'c',projectId:'p'});
  await client.workspaceMappingApplied({roomId:'r/a',ticketId:'t',mappingRevision:1});
  assert.deepEqual(calls.map(call=>new URL(call.url).pathname),[
    '/rooms/r%2Fa/workspace/verify-mapping-ticket','/rooms/r%2Fa/workspace/verify-claim',
    '/rooms/r%2Fa/workspace/verify-commit-ticket','/rooms/r%2Fa/workspace/mapping-applied',
  ]);
  for(const call of calls){assert.equal(call.init.method,'POST');assert.equal(call.init.headers['x-intent-broker-room-token'],'secret-test');}
});

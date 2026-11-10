import {createHash} from 'node:crypto';
import {protocolDigest} from '../../src/core/project-protocol.js';
import {deriveRoomConversionSourceIds} from '../../src/core/room-user-source-contract.js';
const sha=value=>createHash('sha256').update(value).digest('hex'),scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
// Metadata contract fixture. IDs use production derivation, with a separate
// Desktop contract test covering the actual Main original-owner producer.
export function roomSourceFor(bindingDigest,input={action:'add_task',expectedProjectRevision:1,title:'Report',body:'Original Room text'},originOverride={}){
 const origin={...scope,actorId:'desktop-user:'+scope.profileId,brokerUserId:'user.local',brokerOriginDigest:'c'.repeat(64),roomId:'room',roomMessageId:'message',...originOverride};
 const ids=deriveRoomConversionSourceIds(origin,'11111111-1111-4111-8111-111111111111');
 const wire={action:input.action,roomId:origin.roomId,messageId:origin.roomMessageId,projectId:'p',expectedProjectRevision:input.expectedProjectRevision};
 for(const key of input.action==='add_task'?['title','brief']:['logicalArtifactId','expectedArtifactRevision','expectedReservationRevision'])if(Object.hasOwn(input,key))wire[key]=input[key];
 const request={...input,sourceMessageId:ids.canonicalMessageId};
 const source={schemaVersion:3,sourceFamily:'main_room_conversion_v1',...origin,...ids,messageSequence:4,messageSha256:sha('Original Room text'),projectId:'p',projectBindingDigest:bindingDigest,
  userIntentHash:protocolDigest(wire),envelopeHash:protocolDigest(['main-room-conversion-envelope-v1',ids.originKey,4,sha('Original Room text'),'p',bindingDigest,wire]),
  inputDigest:protocolDigest(['ordinary-input-envelope-v1','p',request]),promptSha256:sha(request.body),permissionMode:'default'};
 return {source,input:request};
}

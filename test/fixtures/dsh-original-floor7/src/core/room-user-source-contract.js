import {types} from 'node:util';
import {createHash} from 'node:crypto';
import {protocolDigest} from './project-protocol.js';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const reference=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!value.includes('\0');
const positive=value=>Number.isSafeInteger(value)&&value>0;
const noncePattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fields=['schemaVersion','sourceFamily','profileId','workspaceId','actorId','brokerUserId','brokerOriginDigest','captureId','originKey','canonicalMessageId','canonicalUserTaskId',
 'roomId','roomMessageId','messageSequence','messageSha256','projectId','projectBindingDigest','userIntentHash','envelopeHash','inputDigest','promptSha256','permissionMode'];
const textHash=value=>createHash('sha256').update(value).digest('hex');
function dataRecord(value,allowed,required=allowed){
 if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
 return keys.every(key=>allowed.includes(key)&&descriptors[key].enumerable&&Object.hasOwn(descriptors[key],'value'))&&required.every(key=>Object.hasOwn(descriptors,key));
}
/** Public deterministic metadata derivation, NEVER an authorization issuer.
 * The authenticated Main source/intent proof chain remains mandatory. */
export function deriveRoomConversionSourceIds(origin,nonce){
 if(!noncePattern.test(nonce))throw Error('project_input_source_invalid');
 const originKey=protocolDigest(['main-room-conversion-origin-v1',origin.profileId,origin.workspaceId,origin.actorId,origin.brokerUserId,origin.brokerOriginDigest,origin.roomId,origin.roomMessageId,0]);
 const canonicalId=protocolDigest(['main-room-conversion-id-v1',originKey,nonce]);
 return {originKey,captureId:`main-room-conversion:${originKey}:${nonce}`,canonicalMessageId:`main-user-message:${canonicalId}`,canonicalUserTaskId:`main-user-task:${canonicalId}`};
}
export function validateRoomUserSource(source,scope){
 if(!dataRecord(source,fields)||source.schemaVersion!==3||source.sourceFamily!=='main_room_conversion_v1'
  ||source.profileId!==scope.profileId||source.workspaceId!==scope.workspaceId||source.actorId!==`desktop-user:${scope.profileId}`
  ||source.brokerUserId!=='user.local'||source.permissionMode!=='default'||!positive(source.messageSequence)
  ||!['roomId','roomMessageId','projectId','captureId'].every(key=>reference(source[key]))
  ||!['brokerOriginDigest','originKey','messageSha256','projectBindingDigest','userIntentHash','envelopeHash','inputDigest','promptSha256'].every(key=>hash(source[key])))throw Error('project_input_source_invalid');
 const parts=source.captureId.split(':');if(parts.length!==3||parts[0]!=='main-room-conversion')throw Error('project_input_source_invalid');
 const ids=deriveRoomConversionSourceIds(source,parts[2]);if(Object.entries(ids).some(([key,value])=>source[key]!==value))throw Error('project_input_source_invalid');
 return Object.freeze(Object.fromEntries(fields.map(key=>[key,source[key]])));
}
/** Exact source/wire/body binding before receipts or business writes. This
 * validates Main's attestation; no hash is a replacement for its permission. */
export function roomUserSourceMatchesInput(source,projectId,bindingDigest,input){
 if(source.schemaVersion!==3||source.projectId!==projectId||source.projectBindingDigest!==bindingDigest)return false;
 const common=['action','expectedProjectRevision','sourceMessageId','body'];
 if(!input||!['add_task','add_revision'].includes(input.action))return false;
 const actionFields=input.action==='add_task'?['title','brief']:['logicalArtifactId','expectedArtifactRevision','expectedReservationRevision'];
 if(!dataRecord(input,[...common,...actionFields],input.action==='add_task'?common:[...common,...actionFields])
  ||!positive(input.expectedProjectRevision)||input.sourceMessageId!==source.canonicalMessageId||typeof input.body!=='string')return false;
 const wire={action:input.action,roomId:source.roomId,messageId:source.roomMessageId,projectId,expectedProjectRevision:input.expectedProjectRevision};
 if(input.action==='add_task'){
  if(Object.hasOwn(input,'title')&&(typeof input.title!=='string'||input.title.length>1024||Buffer.byteLength(input.title,'utf8')>4096))return false;
  if(Object.hasOwn(input,'brief')&&(typeof input.brief!=='string'||input.brief.length>65536||Buffer.byteLength(input.brief,'utf8')>65536))return false;
  if(Object.hasOwn(input,'brief')?input.body!==input.brief:textHash(input.body)!==source.messageSha256)return false;
 }else if(!reference(input.logicalArtifactId)||!positive(input.expectedArtifactRevision)||!positive(input.expectedReservationRevision)||textHash(input.body)!==source.messageSha256)return false;
 for(const key of actionFields)if(Object.hasOwn(input,key))wire[key]=input[key];
 return source.userIntentHash===protocolDigest(wire)
  &&source.envelopeHash===protocolDigest(['main-room-conversion-envelope-v1',source.originKey,source.messageSequence,source.messageSha256,projectId,bindingDigest,wire])
  &&source.inputDigest===protocolDigest(['ordinary-input-envelope-v1',projectId,input])&&source.promptSha256===textHash(input.body);
}

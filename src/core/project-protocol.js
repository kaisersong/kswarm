import {createHash,Hash} from 'node:crypto';
import {resolveProjectInputAuthority} from './project-input-authority.js';
import {types} from 'node:util';
const jsonParse=JSON.parse,jsonStringify=JSON.stringify,objectKeys=Object.keys,isArray=Array.isArray,define=Object.defineProperty;
const descriptors=Object.getOwnPropertyDescriptors,own=Object.hasOwn,symbols=Object.getOwnPropertySymbols,prototype=Object.getPrototypeOf,objectPrototype=Object.prototype,isProxy=types.isProxy;
const sort=Function.prototype.call.bind(Array.prototype.sort);
const nativeCreateHash=createHash,hashUpdate=Hash.prototype.update,hashDigest=Hash.prototype.digest,hashApply=Reflect.apply;

// Canonical JSON operates on a JSON snapshot: omitted optional fields have the
// same meaning before and after SQLite/JSON recovery. No caller supplies hashes.
function ordered(value) {
  if (isArray(value)){const out=[];for(let i=0;i<value.length;i++)define(out,i,{__proto__:null,value:ordered(value[i]),enumerable:true,writable:true,configurable:true});return out;}
  if (value && typeof value === 'object'){const out={},names=objectKeys(value);sort(names);for(let i=0;i<names.length;i++){const key=names[i];define(out,key,{__proto__:null,value:ordered(value[key]),enumerable:true,writable:true,configurable:true});}return out;}
  return value;
}
export function protocolDigest(value) {
  const hash=nativeCreateHash('sha256');
  hashApply(hashUpdate,hash,[jsonStringify(ordered(jsonParse(jsonStringify(value))))]);
  return hashApply(hashDigest,hash,['hex']);
}
export function isProjectProtocolScope(value){
  if(!value||typeof value!=='object'||isProxy(value)||isArray(value)||symbols(value).length)return false;
  const proto=prototype(value);if(proto!==objectPrototype&&proto!==null)return false;
  const fields=descriptors(value);if(objectKeys(fields).length!==2||!own(fields,'profileId')||!own(fields,'workspaceId'))return false;
  const profile=fields.profileId,workspace=fields.workspaceId;
  return own(profile,'value')&&profile.enumerable&&own(workspace,'value')&&workspace.enumerable&&scopeHash(profile.value)&&scopeHash(workspace.value);
}
function scopeHash(value){if(typeof value!=='string'||value.length!==64)return false;for(let i=0;i<64;i++){const ch=value[i];if(!(ch>='0'&&ch<='9'||ch>='a'&&ch<='f'))return false;}return true;}
export function projectProtocolIds(projectId) {
  const key=protocolDigest(['project-protocol-v1',projectId]);
  return {binding:`project-binding:${key}`,receipt:`project-create:${key}`};
}

/** Only called after the existing owner create authorization/validation. This
 * does not backfill old projects or authorize DSH, mode, dispatch or a listener. */
export function createOrdinaryProtocolRecords(project,requestContext,authorityToken,initialPlanWriterStoreId) {
  const ids=projectProtocolIds(project.id);
  // Permanent authority metadata must survive body retention/deletion without
  // retaining another undeletable copy of goal, requirements or filesystem paths.
  const snapshot={id:project.id,createdAt:project.createdAt,requestedStartPolicy:project.requestedStartPolicy,
    creationPayloadHash:protocolDigest(['ordinary-create-payload-v1',project]),...(initialPlanWriterStoreId?{initialPlanWriterStoreId}:{})};
  const canonicalCreateDigest=protocolDigest(['ordinary-create-v1',snapshot]);
  const authority=resolveProjectInputAuthority(authorityToken);
  const scope=authority ? {profileId:authority.profileId,workspaceId:authority.workspaceId} : undefined;
  const initialPlanning=authority?.kind==='main_bootstrap_create'?authority.creation:undefined;
  const createReceipt={id:ids.receipt,kind:'project_create_receipt',schemaVersion:1,projectId:project.id,
    ...(scope ? {scope} : {}),
    ...(initialPlanning ? {initialPlanning} : {}),
    canonicalCreateDigest,snapshot,requestContext:requestContext ?? null};
  const binding={id:ids.binding,kind:'project_protocol_binding',schemaVersion:1,projectId:project.id,
    ...(scope ? {scope} : {}),
    ...(initialPlanning ? {initialPlanning} : {}),
    protocol:'ordinary_v1',canonicalCreateDigest,createReceiptDigest:protocolDigest(createReceipt),createReceiptId:ids.receipt};
  return {binding,createReceipt};
}

export function readProjectProtocolBinding(projectId,receipts) {
  const ids=projectProtocolIds(projectId);
  const binding=receipts.get(ids.binding),createReceipt=receipts.get(ids.receipt);
  const unknown=reasonCode=>({classification:'unknown',reasonCode});
  if (!binding || !createReceipt) return unknown('PROTOCOL_BINDING_UNVERIFIED');
  if (binding.kind!=='project_protocol_binding' || binding.schemaVersion!==1 || binding.projectId!==projectId
    || binding.id!==ids.binding || binding.createReceiptId!==ids.receipt || createReceipt.id!==ids.receipt
    || createReceipt.kind!=='project_create_receipt' || createReceipt.schemaVersion!==1 || createReceipt.projectId!==projectId
    || createReceipt.snapshot?.id!==projectId || binding.createReceiptDigest!==protocolDigest(createReceipt)
    || binding.canonicalCreateDigest!==createReceipt.canonicalCreateDigest
    || protocolDigest(binding.scope ?? null)!==protocolDigest(createReceipt.scope ?? null)
    || protocolDigest(binding.initialPlanning ?? null)!==protocolDigest(createReceipt.initialPlanning ?? null)
    || createReceipt.canonicalCreateDigest!==protocolDigest(['ordinary-create-v1',createReceipt.snapshot])) {
    return unknown('PROTOCOL_BINDING_INTEGRITY_FAILED');
  }
  if (binding.protocol!=='ordinary_v1') return unknown('PROTOCOL_BINDING_UNSUPPORTED');
  return structuredClone({classification:'ordinary',binding,createReceipt});
}

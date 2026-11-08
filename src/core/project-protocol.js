import {createHash} from 'node:crypto';

// Canonical JSON operates on a JSON snapshot: omitted optional fields have the
// same meaning before and after SQLite/JSON recovery. No caller supplies hashes.
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])]));
  return value;
}
export function protocolDigest(value) {
  return createHash('sha256').update(JSON.stringify(ordered(JSON.parse(JSON.stringify(value))))).digest('hex');
}
export function projectProtocolIds(projectId) {
  const key=protocolDigest(['project-protocol-v1',projectId]);
  return {binding:`project-binding:${key}`,receipt:`project-create:${key}`};
}

/** Only called after the existing owner create authorization/validation. This
 * does not backfill old projects or authorize DSH, mode, dispatch or a listener. */
export function createOrdinaryProtocolRecords(project,requestContext) {
  const ids=projectProtocolIds(project.id);
  // Permanent authority metadata must survive body retention/deletion without
  // retaining another undeletable copy of goal, requirements or filesystem paths.
  const snapshot={id:project.id,createdAt:project.createdAt,requestedStartPolicy:project.requestedStartPolicy,
    creationPayloadHash:protocolDigest(['ordinary-create-payload-v1',project])};
  const canonicalCreateDigest=protocolDigest(['ordinary-create-v1',snapshot]);
  const createReceipt={id:ids.receipt,kind:'project_create_receipt',schemaVersion:1,projectId:project.id,
    canonicalCreateDigest,snapshot,requestContext:requestContext ?? null};
  const binding={id:ids.binding,kind:'project_protocol_binding',schemaVersion:1,projectId:project.id,
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
    || createReceipt.canonicalCreateDigest!==protocolDigest(['ordinary-create-v1',createReceipt.snapshot])) {
    return unknown('PROTOCOL_BINDING_INTEGRITY_FAILED');
  }
  if (binding.protocol!=='ordinary_v1') return unknown('PROTOCOL_BINDING_UNSUPPORTED');
  return structuredClone({classification:'ordinary',binding,createReceipt});
}

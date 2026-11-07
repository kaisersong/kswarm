import { createHash, Hash } from 'node:crypto';
import { protocolDigest } from './project-protocol.js';
import { dshClosed as closed, dshFields as fields, dshHash as hash, dshText as text, dshRevision as revision, dshFail as fail } from './dsh-owner-data.js';
const apply = Reflect.apply, keys = Reflect.ownKeys, define = Object.defineProperty, create = Object.create, byteLength = Buffer.byteLength;
const charCodeAt = String.prototype.charCodeAt;
const update = Hash.prototype.update, digest = Hash.prototype.digest, nativeHash = createHash;
export const DSH_DRAFT_FIELDS = Object.freeze(['schemaVersion', 'scope', 'thread', 'bindingId', 'generation', 'ownerWorkId', 'draftCommitKey', 'artifactId', 'draftInvocationId', 'attemptId', 'expectedOwnerVersion', 'authority', 'manifest', 'budgetCommitProof', 'content', 'payloadHash', 'attemptPayloadHash']);
export const DSH_COMMIT_PROOF_FIELDS = Object.freeze(['proofId', 'budgetOwnerId', 'reservationRef', 'operationKey', 'ownerWorkId', 'bindingId', 'inputManifestHash', 'finalizedUsageRevision', 'validUntil', 'receiptDigest', 'chargedBasis', 'ledgerRevision']);
const omit = (value, names) => { const out = create(null), all = keys(value); for (let i = 0; i < all.length; i++) {
    let skip = false;
    for (let j = 0; j < names.length; j++)
        if (all[i] === names[j])
            skip = true;
    if (!skip)
        define(out, all[i], { __proto__: null, value: value[all[i]], enumerable: true });
} return out; };
export function dshDraftContentHash(value) {
    if (typeof value !== 'string' || apply(byteLength, Buffer, [value, 'utf8']) > 65536)
        fail('DSH_DRAFT_CONTENT_INVALID');
    for (let i = 0; i < value.length; i++) {
        const n = apply(charCodeAt, value, [i]);
        if (n === 0)
            fail('DSH_DRAFT_CONTENT_INVALID');
        if (n >= 0xd800 && n <= 0xdbff) {
            const b = apply(charCodeAt, value, [++i]);
            if (!(b >= 0xdc00 && b <= 0xdfff))
                fail('DSH_DRAFT_CONTENT_INVALID');
        }
        else if (n >= 0xdc00 && n <= 0xdfff)
            fail('DSH_DRAFT_CONTENT_INVALID');
    }
    const h = nativeHash('sha256');
    apply(update, h, [value, 'utf8']);
    return apply(digest, h, ['hex']);
}
/** Candidate hashes are data, never a Source or receipt verifier. */
export function dshDraftHashes(value) {
    const semantic = omit(value, ['payloadHash', 'attemptPayloadHash', 'attemptId', 'expectedOwnerVersion', 'authority', 'content']);
    // Prepare command retry identity does not replace its complete authorization
    // semantics, evidence, policy, input set or fixed deadline.
    define(semantic, 'content', { __proto__: null, value: { kind: value.content.kind, contentHash: value.content.contentHash, contentRef: 'dsh-content:' + protocolDigest(value.draftCommitKey) }, enumerable: true });
    define(semantic, 'authority', { __proto__: null, value: omit(value.authority, ['commandId', 'expectedOwnerVersion', 'attemptPayloadHash']), enumerable: true });
    const payloadHash = protocolDigest(['dsh-draft-payload-v1', semantic]);
    const attempt = omit(value, ['attemptPayloadHash', 'payloadHash']);
    define(attempt, 'payloadHash', { __proto__: null, value: payloadHash, enumerable: true });
    return closed({ payloadHash, attemptPayloadHash: protocolDigest(['dsh-draft-attempt-v1', attempt]) });
}
export function validateDshDraft(value) {
    fields(value, DSH_DRAFT_FIELDS);
    if (value.schemaVersion !== 1 || value.generation !== 1 || !revision(value.expectedOwnerVersion))
        fail('DSH_DRAFT_INVALID');
    for (const k of ['bindingId', 'ownerWorkId', 'draftCommitKey', 'artifactId', 'draftInvocationId', 'attemptId'])
        if (!text(value[k]))
            fail('DSH_DRAFT_INVALID');
    fields(value.content, ['kind', 'text', 'contentHash']);
    if (value.content.kind !== 'dsh_model_text_v1' || !hash(value.content.contentHash) || dshDraftContentHash(value.content.text) !== value.content.contentHash)
        fail('DSH_DRAFT_CONTENT_INVALID');
    fields(value.budgetCommitProof, DSH_COMMIT_PROOF_FIELDS);
    const proof = value.budgetCommitProof;
    for (const k of ['proofId', 'budgetOwnerId', 'reservationRef', 'operationKey', 'ownerWorkId', 'bindingId'])
        if (!text(proof[k]))
            fail('DSH_BUDGET_COMMIT_REQUIRED');
    if (!hash(proof.inputManifestHash) || !hash(proof.receiptDigest) || !revision(proof.finalizedUsageRevision) || !revision(proof.ledgerRevision) || (proof.chargedBasis !== 'actual' && proof.chargedBasis !== 'conservative_upper_bound'))
        fail('DSH_BUDGET_COMMIT_REQUIRED');
    const expected = dshDraftHashes(value);
    if (value.payloadHash !== expected.payloadHash || value.attemptPayloadHash !== expected.attemptPayloadHash)
        fail('DSH_DRAFT_HASH_CONFLICT');
    return value;
}

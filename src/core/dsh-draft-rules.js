import { protocolDigest } from './project-protocol.js';
import { dshClosed as closed, dshFields as fields, dshFail as fail } from './dsh-owner-data.js';
import { validateDshDraft, dshDraftHashes, dshDraftContentHash, DSH_COMMIT_PROOF_FIELDS } from './dsh-draft-data.js';
const now = Date.now, NativeDate = Date, dateIso = Date.prototype.toISOString, apply = Reflect.apply, parseTime = Date.parse, keys = Reflect.ownKeys, define = Object.defineProperty, create = Object.create, freeze = Object.freeze;
const equal = (a, b) => { if (protocolDigest(a) !== protocolDigest(b))
    fail('DSH_DRAFT_CONFLICT'); };
const withoutDigest = row => { const out = create(null), names = keys(row); for (let i = 0; i < names.length; i++)
    if (names[i] !== 'recordDigest')
        define(out, names[i], { __proto__: null, value: row[names[i]], enumerable: true }); return out; };
/** Child rules of the one original owner/transaction. No connection, scheduler,
 * model, resource admission or independent budget is created here. */
export function createDshDraftRules({ receipts, heads, record, work, validateAuthority, current, manifest, budget, localGraph }) {
    function slotOf(value) {
        const ctx = work(value.authority), slot = receipts.get(value.draftCommitKey);
        if (ctx.id !== value.ownerWorkId || !slot || slot.kind !== 'dsh_draft_slot' || slot.projectId !== ctx.id || slot.artifactId !== value.artifactId || slot.draftInvocationId !== value.draftInvocationId || slot.inputSetRevision !== value.authority.inputSetRevision || slot.assessmentHash !== value.authority.assessmentHash)
            fail('DSH_DRAFT_SLOT_CONFLICT');
        if (slot.executionProfile !== 'model_text_only_v1' || value.authority.executionProfile !== 'model_text_only_v1')
            fail('DSH_DRAFT_PROFILE_UNAVAILABLE');
        return { ctx, slot };
    }
    function validate(value) { validateDshDraft(value); validateAuthority(value.authority); equal(value.scope, value.authority.scope); equal(value.thread, value.authority.thread); if (value.bindingId !== value.authority.bindingId || value.generation !== value.authority.generation)
        fail('DSH_DRAFT_SCOPE_CONFLICT'); return slotOf(value); }
    function currentDraft(value, before, projected) {
        const { ctx, slot } = slotOf(value), control = ctx.control;
        if (control.recordDigest !== before.recordDigest && (!projected || control.recordDigest !== projected.recordDigest))
            fail('DSH_DRAFT_OWNER_CONFLICT');
        current(value.authority, before);
        equal(value.manifest, manifest(ctx, slot, before));
        if (value.budgetCommitProof.ownerWorkId !== ctx.id || value.budgetCommitProof.bindingId !== value.bindingId || value.budgetCommitProof.inputManifestHash !== value.manifest.manifestHash || value.budgetCommitProof.reservationRef !== value.authority.budgetReservationRef)
            fail('DSH_BUDGET_COMMIT_REQUIRED');
    }
    function prepare(value, purpose, opened, snapshot) {
        const { ctx, slot } = validate(value), candidateId = slot.id + ':candidate', candidate = receipts.get(candidateId), artifact = receipts.get(slot.artifactId), attemptId = 'dsh-draft-attempt:' + protocolDigest([value.scope, value.attemptId]), attempt = receipts.get(attemptId);
        if (attempt && attempt.attemptPayloadHash !== value.attemptPayloadHash)
            fail('DSH_DRAFT_ATTEMPT_CONFLICT');
        if (candidate && candidate.payloadHash !== value.payloadHash || artifact && artifact.payloadHash !== value.payloadHash)
            fail('DSH_DRAFT_PAYLOAD_CONFLICT');
        if (artifact) {
            const receipt = receipts.get(slot.id + ':committed');
            if (!receipt)
                fail('DSH_GRAPH_UNVERIFIED');
            return { old: true, response: closed({ ok: true, result: 'already_committed', artifactId: artifact.id, receipt }) };
        }
        if (purpose === 'draft_commit' && !candidate)
            fail('DSH_DRAFT_STAGE_REQUIRED');
        if (candidate && purpose === 'draft_stage')
            return { old: true, response: closed({ ok: true, result: 'already_staged', candidate }) };
        if (ctx.control.ownerVersion !== value.expectedOwnerVersion || ctx.control.completionLatch)
            fail('DSH_DRAFT_OWNER_CONFLICT');
        currentDraft(value, ctx.control);
        const before = ctx.control, records = [];
        let response, projected;
        const issueBudget = () => budget(opened, value);
        let budgetGuard;
        if (purpose === 'draft_stage') {
            budgetGuard = issueBudget();
            const contentRef = 'dsh-content:' + protocolDigest(slot.id), candidateData = { ...value, content: { kind: value.content.kind, contentHash: value.content.contentHash, contentRef } };
            const staged = record('dsh_draft_candidate', candidateId, ctx.id, value, { draftCommitKey: slot.id, payloadHash: value.payloadHash, candidate: candidateData });
            records.push(['protocolReceipt', staged]);
            records.push(['protocolHead', record('dsh_draft_content', contentRef, ctx.id, value, { revision: 1, draftCommitKey: slot.id, payloadHash: value.payloadHash, contentHash: value.content.contentHash, state: 'stored', text: value.content.text })]);
            response = closed({ ok: true, result: 'staged', candidate: staged });
        }
        else {
            equal(candidate.candidate.payloadHash, value.payloadHash);
            budgetGuard = issueBudget();
            const proof = value.budgetCommitProof, consumeId = 'dsh-budget-proof:' + protocolDigest([proof.budgetOwnerId, proof.proofId]);
            if (receipts.has(consumeId))
                fail('DSH_BUDGET_PROOF_ALREADY_CONSUMED');
            const createdAt = apply(dateIso, new NativeDate(now()), []);
            const output = record('dsh_draft_artifact', slot.artifactId, ctx.id, value, { draftCommitKey: slot.id, payloadHash: value.payloadHash, content: candidate.candidate.content, inputManifestHash: value.manifest.manifestHash, budgetProofId: proof.proofId, createdAt });
            const committed = record('dsh_draft_commit_receipt', slot.id + ':committed', ctx.id, value, { draftCommitKey: slot.id, artifactId: output.id, payloadHash: value.payloadHash, contentHash: value.content.contentHash, budgetProofId: proof.proofId, createdAt });
            records.push(['protocolReceipt', output], ['protocolReceipt', committed]);
            records.push(['protocolReceipt', record('dsh_budget_proof_consumption', consumeId, ctx.id, value, { proof, artifactId: output.id, payloadHash: value.payloadHash })]);
            records.push(['protocolHead', record('dsh_budget_commit_ack', consumeId + ':ack', ctx.id, value, { revision: 1, state: 'pending', proofId: proof.proofId, artifactId: output.id, commitReceiptId: committed.id })]);
            projected = record('dsh_control', before.id, ctx.id, value, { ...withoutDigest(before), revision: before.revision + 1, ownerVersion: before.ownerVersion + 1, completionLatch: true, generationClosed: true, currentDraftRef: output.id, currentDraftValid: true, completionReachedAt: createdAt });
            records.push(['protocolHead', projected]);
            response = closed({ ok: true, result: 'committed', artifactId: output.id, receipt: committed });
        }
        if (!attempt)
            records.push(['protocolReceipt', record('dsh_draft_attempt', attemptId, ctx.id, value, { draftCommitKey: slot.id, attemptId: value.attemptId, attemptPayloadHash: value.attemptPayloadHash, payloadHash: value.payloadHash })]);
        const guard = () => { opened.guard(); budgetGuard(); currentDraft(value, before, projected); };
        guard();
        return { projectId: ctx.id, records, response, guard, local: () => localGraph(snapshot, records) };
    }
    function validateRecord(value) {
        const base = ['kind', 'id', 'projectId', 'schemaVersion', 'contract', 'scope', 'writerStoreId', 'recordDigest'];
        const shape = names => { const all = []; for (let i = 0; i < base.length; i++)
            all.push(base[i]); for (let i = 0; i < names.length; i++)
            all.push(names[i]); fields(value, all); };
        const candidateOf = () => { const row = receipts.get(value.draftCommitKey + ':candidate'); if (!row || row.kind !== 'dsh_draft_candidate' || row.projectId !== value.projectId || row.payloadHash !== value.payloadHash)
            fail('DSH_GRAPH_UNVERIFIED'); return row; };
        if (value.kind === 'dsh_draft_candidate') {
            shape(['draftCommitKey', 'payloadHash', 'candidate']);
            const stored = value.candidate;
            fields(stored, ['schemaVersion', 'scope', 'thread', 'bindingId', 'generation', 'ownerWorkId', 'draftCommitKey', 'artifactId', 'draftInvocationId', 'attemptId', 'expectedOwnerVersion', 'authority', 'manifest', 'budgetCommitProof', 'content', 'payloadHash', 'attemptPayloadHash']);
            fields(stored.content, ['kind', 'contentHash', 'contentRef']);
            fields(stored.budgetCommitProof, DSH_COMMIT_PROOF_FIELDS);
            validateAuthority(stored.authority);
            const { ctx, slot } = slotOf(stored);
            equal(value.scope, stored.scope);
            if (stored.schemaVersion !== 1 || stored.generation !== 1 || value.projectId !== ctx.id || value.id !== value.draftCommitKey + ':candidate' || stored.draftCommitKey !== value.draftCommitKey || stored.payloadHash !== value.payloadHash || stored.content.kind !== 'dsh_model_text_v1' || stored.content.contentRef !== 'dsh-content:' + protocolDigest(slot.id) || dshDraftHashes(stored).payloadHash !== value.payloadHash)
                fail('DSH_GRAPH_UNVERIFIED');
        }
        else if (value.kind === 'dsh_draft_content') {
            shape(['revision', 'draftCommitKey', 'payloadHash', 'contentHash', 'state', 'text']);
            const candidate = candidateOf();
            if (value.id !== candidate.candidate.content.contentRef || value.contentHash !== candidate.candidate.content.contentHash || value.state === 'stored' && dshDraftContentHash(value.text) !== value.contentHash || value.state === 'redacted' && value.text !== null || value.state !== 'stored' && value.state !== 'redacted')
                fail('DSH_GRAPH_UNVERIFIED');
        }
        else if (value.kind === 'dsh_draft_attempt') {
            shape(['draftCommitKey', 'attemptId', 'attemptPayloadHash', 'payloadHash']);
            candidateOf();
            if (value.id !== 'dsh-draft-attempt:' + protocolDigest([value.scope, value.attemptId]))
                fail('DSH_GRAPH_UNVERIFIED');
        }
        else if (value.kind === 'dsh_draft_artifact') {
            shape(['draftCommitKey', 'payloadHash', 'content', 'inputManifestHash', 'budgetProofId', 'createdAt']);
            const candidate = candidateOf(), stored = candidate.candidate, receipt = receipts.get(value.draftCommitKey + ':committed');
            equal(value.content, stored.content);
            if (value.id !== stored.artifactId || value.inputManifestHash !== stored.manifest.manifestHash || value.budgetProofId !== stored.budgetCommitProof.proofId || !receipt || receipt.artifactId !== value.id || receipt.createdAt !== value.createdAt)
                fail('DSH_GRAPH_UNVERIFIED');
        }
        else if (value.kind === 'dsh_draft_commit_receipt') {
            shape(['draftCommitKey', 'artifactId', 'payloadHash', 'contentHash', 'budgetProofId', 'createdAt']);
            const candidate = candidateOf(), stored = candidate.candidate, artifact = receipts.get(value.artifactId), consumeId = 'dsh-budget-proof:' + protocolDigest([stored.budgetCommitProof.budgetOwnerId, stored.budgetCommitProof.proofId]), consumed = receipts.get(consumeId);
            if (value.id !== value.draftCommitKey + ':committed' || value.artifactId !== stored.artifactId || !artifact || artifact.kind !== 'dsh_draft_artifact' || artifact.projectId !== value.projectId || value.contentHash !== stored.content.contentHash || value.budgetProofId !== stored.budgetCommitProof.proofId || !consumed || consumed.artifactId !== value.artifactId)
                fail('DSH_GRAPH_UNVERIFIED');
        }
        else if (value.kind === 'dsh_budget_proof_consumption') {
            shape(['proof', 'artifactId', 'payloadHash']);
            fields(value.proof, DSH_COMMIT_PROOF_FIELDS);
            const artifact = receipts.get(value.artifactId), candidate = artifact && receipts.get(artifact.draftCommitKey + ':candidate');
            if (value.id !== 'dsh-budget-proof:' + protocolDigest([value.proof.budgetOwnerId, value.proof.proofId]) || !artifact || artifact.projectId !== value.projectId || artifact.payloadHash !== value.payloadHash || !candidate)
                fail('DSH_GRAPH_UNVERIFIED');
            equal(value.proof, candidate.candidate.budgetCommitProof);
            if (!heads.get(value.id + ':ack'))
                fail('DSH_GRAPH_UNVERIFIED');
        }
        else if (value.kind === 'dsh_budget_commit_ack') {
            shape(['revision', 'state', 'proofId', 'artifactId', 'commitReceiptId']);
            const receipt = receipts.get(value.commitReceiptId), artifact = receipts.get(value.artifactId);
            if (value.state !== 'pending' || !receipt || !artifact || receipt.projectId !== value.projectId || receipt.artifactId !== value.artifactId || receipt.budgetProofId !== value.proofId || value.id !== 'dsh-budget-proof:' + protocolDigest([receipts.get(artifact.draftCommitKey + ':candidate').candidate.budgetCommitProof.budgetOwnerId, value.proofId]) + ':ack')
                fail('DSH_GRAPH_UNVERIFIED');
        }
    }
    function read(ctx, slot) {
        const candidate = receipts.get(slot.id + ':candidate'), artifact = receipts.get(slot.artifactId), receipt = receipts.get(slot.id + ':committed');
        return closed({ ok: true, draft: { state: artifact ? 'committed' : candidate ? 'staged' : 'prepared', draftCommitKey: slot.id, artifactId: slot.artifactId, payloadHash: artifact?.payloadHash ?? candidate?.payloadHash ?? null, contentHash: artifact?.content.contentHash ?? candidate?.candidate.content.contentHash ?? null, currentDraftValid: !!artifact && ctx.control.currentDraftValid, receipt: receipt ?? null } });
    }
    return freeze({ prepare, validateRecord, read });
}

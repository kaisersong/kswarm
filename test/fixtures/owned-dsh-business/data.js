// Controlled authenticated parent facts for the original B protocol. All hashes
// and command identities come from the production codecs, never a mirror hash.
import { protocolDigest } from "../../../src/core/project-protocol.js";
import {
  dshCommandIdentity,
  dshEvidenceManifest,
} from "../../../src/core/dsh-owner-data.js";
import {
  DSH_POLICY_AXES,
  dshScopeChain,
  dshLeafId,
} from "../../../src/core/dsh-scope-control-data.js";
export const scope = { profileId: "a".repeat(64), workspaceId: "b".repeat(64) };
export const thread = {
  tenantId: "tenant",
  workspaceId: "workspace",
  sourceBindingId: "binding-source",
  provider: "github",
  repositoryId: "repo",
  kind: "issue",
  threadId: "123",
};
export const authScope = {
  tenantId: thread.tenantId,
  workspaceId: thread.workspaceId,
  connectionId: "connection-1",
  providerAccountId: "github-account",
  repositoryId: thread.repositoryId,
  credentialEpoch: 1,
};
export function controls() {
  const chain = dshScopeChain(scope, thread, "mandate"),
    out = [];
  for (const cell of chain)
    for (const axis of DSH_POLICY_AXES)
      out.push({
        scope,
        type: "policy",
        identity: cell.identity,
        axis,
        epoch: 1,
        value:
          axis === "mode"
            ? { mode: "auto_draft" }
            : { allowed: true, restriction: null },
        authorityRef: "controlled-original-parent-authority",
      });
  const ownerDomains = [
    { domainId: "fixture-b-owner", kind: "work" },
    { domainId: "fixture-egress", kind: "egress_gate" },
    { domainId: "fixture-pointer", kind: "active_pointer" },
  ];
  const facts = {
    source_auth: {
      authScope,
      sourceBindingVersion: 1,
      roleMappingVersion: 1,
      provenanceVersion: 1,
      status: "active",
      attestationRef: "source-auth-attestation",
    },
    mandate: {
      schemaVersion: 1,
      mandateId: "mandate",
      sourceBindingId: thread.sourceBindingId,
      revision: 1,
      authorizationEpoch: 1,
      status: "active",
      issuedByUserId: "user",
      allowedActorProviderIds: ["github-user"],
      allowedActions: [
        "source.read",
        "model.process_source",
        "local.draft.create",
        "local.draft.revise",
      ],
      ruleVersion: "github_issue_draft_v1",
      selection: { issueIds: ["123"] },
      validUntil: "2100-01-01T00:00:00.000Z",
      maxInputBytes: 1000000,
      budgetRef: "actual-test-budget-owner",
      limits: {
        maxActiveWorks: 10,
        maxDraftRunsPerWork: 10,
        maxTokens: 10000,
        maxCostMinor: 100,
        currency: "USD",
        executionDeadline: "2100-01-01T00:00:00.000Z",
      },
      dataEgressPolicyRef: "egress",
      ownerDomains,
      ownerDomainsHash: protocolDigest(["dsh-owner-domains-v1", ownerDomains]),
      followup: {
        enabled: false,
        observationEndsAt: "2100-01-01T00:00:00.000Z",
        completionPredicate: "draft_ready",
        resumeAfterCompletion: false,
      },
    },
    egress: {
      policyRef: "egress",
      policyHash: "e".repeat(64),
      provider: "model-provider",
      destinationRef: "model-destination",
      purposes: ["draft"],
      enabled: true,
    },
    readonly: {
      executionProfile: "model_text_only_v1",
      schemaVersion: 1,
      snapshotHash: null,
      snapshotPolicyDigest: null,
      approvalRef: null,
    },
  };
  for (const [factKind, value] of Object.entries(facts))
    out.push({
      scope,
      type: "leaf",
      identity: chain[factKind === "source_auth" ? 3 : 4].identity,
      factKind,
      epoch: 1,
      value,
      authorityRef: "controlled-original-parent-leaf",
    });
  return out;
}
export function command(imported, overrides = {}) {
  const chain = dshScopeChain(scope, thread, "mandate"),
    modeGuards = [],
    policies = [],
    leaves = [];
  for (const row of imported) {
    if (row.kind === "dsh_scope_control") {
      policies.push({
        scopeKey: row.scopeKey,
        axis: row.axis,
        epoch: row.epoch,
        canonicalHash: row.canonicalHash,
        controlRevision: row.revision,
      });
      if (row.axis === "mode")
        modeGuards.push({ scopeKey: row.scopeKey, epoch: row.epoch });
    }
  }
  for (const kind of ["source_auth", "mandate", "egress", "readonly"]) {
    const id = dshLeafId(chain[kind === "source_auth" ? 3 : 4].scopeKey, kind),
      row = imported.find((row) => row.id === id);
    leaves.push({
      id,
      epoch: row.epoch,
      canonicalHash: row.canonicalHash,
      controlRevision: row.revision,
    });
  }
  const data = {
    scope,
    thread,
    authScope,
    schemaVersion: 2,
    commandId: "command-create",
    bindingId: "binding",
    generation: 1,
    ownerKind: "kswarm_dsh",
    mandateId: "mandate",
    mandateRevision: 1,
    authorizationEpoch: 1,
    action: "create_draft_work",
    purpose: "draft",
    inputId: "input-1",
    input: {
      inputId: "input-1",
      sourceObjectId: "issue-123",
      sourceRevision: "r1",
      contentHash: "1".repeat(64),
      provenanceHash: "2".repeat(64),
      objectKind: "issue",
      provenanceVersion: 1,
      actorMappingVersion: 1,
      snapshotRef: "snapshot-input-1",
    },
    canonical: { inputId: "input-1", createManifestHash: "3".repeat(64) },
    targetWorkId: null,
    expectedOwnerVersion: null,
    targetFenceEpoch: null,
    dispatchPolicy: "draft_only_no_business_dispatch",
    assessmentRef: "assessment",
    assessmentHash: "4".repeat(64),
    admissionWindowRef: "window",
    freshnessAttestationRef: "freshness",
    budgetReservationRef: "budget-1",
    authorityValidUntil: "2100-01-01T00:00:00.000Z",
    executionDeadline: "2100-01-01T00:00:00.000Z",
    executionProfile: "model_text_only_v1",
    modeGuards,
    controlGuards: { policies, leaves },
    workGuard: null,
    egressGuard: { policyRef: "egress", epoch: 1, policyHash: "e".repeat(64) },
    ...overrides,
  };
  const input = data.input,
    manifest = dshEvidenceManifest(
      thread,
      [
        {
          inputId: input.inputId,
          objectKind: input.objectKind,
          objectId: input.sourceObjectId,
          revision: input.sourceRevision,
          contentHash: input.contentHash,
          provenanceVersion: 1,
          actorEvidenceHash: input.provenanceHash,
          actorMappingVersion: 1,
        },
      ],
      "2026-01-01T00:00:00.000Z",
    );
  data.evidence = { manifest, attestationRef: "evidence-attestation" };
  data.evidenceManifestHash = manifest.manifestHash;
  data.freshness = {
    window: {
      windowId: "window",
      sourceBindingId: thread.sourceBindingId,
      prefixModeGuardsHash: protocolDigest(modeGuards),
      admissionGrantHash: "7".repeat(64),
      effectiveAt: "2026-01-01T00:00:00.000Z",
      baselineCheckpointRef: "baseline",
      providerTimeBasisProofRef: "provider-time",
      freshnessPolicyVersion: 1,
    },
    eventTimeEvidenceRef: "event-time",
    attestationRef: "freshness",
  };
  return { ...data, ...dshCommandIdentity(data) };
}
export const budget = (data) => ({
  reservationId: data.budgetReservationRef,
  issuerDomain: "actual-test-budget-owner",
  mandateId: data.mandateId,
  mandateRevision: data.mandateRevision,
  authorizationEpoch: data.authorizationEpoch,
  scope,
  thread,
  operationKey: data.operationKey,
  semanticPayloadHash: data.semanticPayloadHash,
  assessmentRef: data.assessmentRef,
  purpose:
    data.action === "prepare_draft" ? "draft_prepare" : "draft_admission",
  state: "reserved",
});

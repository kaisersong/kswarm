// Controlled private fixture Source, not Native/Main authority.
// Fixture setup copied from dsh-owner-foundation.test.js; business state,
// hashes, acceptance and persistence always use the original production entry.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHub, bindHubServerScheduler } from "../src/core/hub.js";
import { createSqlitePersistence } from "../src/core/sqlite-persistence.js";
import { createProjectInputAuthority } from "../src/core/project-input-authority.js";
import { protocolDigest } from "../src/core/project-protocol.js";
import {
  DSH_POLICY_AXES,
  dshScopeChain,
  dshPolicyId,
  dshLeafId,
} from "../src/core/dsh-scope-control-data.js";
const scope = { profileId: "a".repeat(64), workspaceId: "b".repeat(64) };
const thread = {
  tenantId: "tenant",
  workspaceId: "workspace",
  sourceBindingId: "binding-source",
  provider: "github",
  repositoryId: "repo",
  kind: "issue",
  threadId: "123",
};
const authScope = {
  tenantId: thread.tenantId,
  workspaceId: thread.workspaceId,
  connectionId: "connection-1",
  providerAccountId: "github-account",
  repositoryId: thread.repositoryId,
  credentialEpoch: 1,
};
function fixture(t, { sqliteFactory } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-owner-")),
    filePath = join(root, "state.sqlite"),
    authority = createProjectInputAuthority(scope),
    frames = new WeakMap(),
    budgets = new WeakMap(),
    hubs = [],
    effects = [];
  let hub,
    backend,
    current = true,
    readCurrent = true,
    resolveHook,
    guardHook,
    budgetHook;
  const source = {
    resolve(frame, purpose) {
      const entry = frames.get(frame);
      if (!entry || entry.purpose !== purpose)
        throw Error("TEST_SOURCE_PRIVATE_FRAME_REQUIRED");
      if (resolveHook) {
        const result = resolveHook(entry, purpose);
        if (result !== undefined) return result;
      }
      return {
        data: entry.data,
        budgetProof: entry.budgetProof ?? null,
        assertCurrent() {
          guardHook?.(entry, purpose);
          if (!(purpose === "read" ? readCurrent : current))
            throw Error("TEST_SOURCE_REVOKED");
        },
      };
    },
  };
  const budgetSource = {
    resolve(proof) {
      if (budgetHook) budgetHook();
      const data = budgets.get(proof);
      if (!data) throw Error("TEST_BUDGET_PRIVATE_PROOF_REQUIRED");
      return {
        data,
        assertCurrent() {
          if (!current) throw Error("TEST_BUDGET_REVOKED");
        },
      };
    },
  };
  const issue = (purpose, data, budgetProof) => {
    const frame = Object.freeze(Object.create(null));
    frames.set(frame, { purpose, data, budgetProof });
    return frame;
  };
  const open = () => {
    backend = createSqlitePersistence({
      filePath,
      ...(sqliteFactory ? { sqliteFactory } : {}),
    });
    hub = createHub({
      silent: true,
      dataDir: { backend: "sqlite", filePath },
      persistence: backend,
      dshBusinessSource: source,
      dshBudgetSource: budgetSource,
      bridge: {
        requestTask(input) {
          effects.push(input);
          return { ok: true };
        },
      },
    });
    hubs.push(hub);
  };
  open();
  t.after(() => {
    for (const owner of hubs) {
      try {
        owner.closePersistence();
      } catch (error) {
        backend.close();
        t.diagnostic(
          JSON.stringify({
            fixtureOnlyForcedNativeClose: true,
            notProductionClose: true,
            error: String(error),
          }),
        );
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const control = {
    requestSource: "user",
    projectInputAuthority: authority.reader(),
  };
  const raw = (fn) => {
    const db = new DatabaseSync(filePath, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const physical = () =>
    raw((db) => ({
      rows: db
        .prepare("SELECT * FROM state_entities ORDER BY collection,entity_key")
        .all(),
      history: db
        .prepare("SELECT * FROM state_entity_history ORDER BY rowid")
        .all(),
      meta: db.prepare("SELECT * FROM state_meta ORDER BY meta_key").all(),
    }));
  const imported = new Map();
  const scopes = (t = thread, m = "mandate") => dshScopeChain(scope, t, m);
  const importControl = (data) => {
    const result = hub.applyDshScopeFence(issue("control", data), {
      requestSource: "scheduler",
    });
    if (result.ok) imported.set(result.control.id, result.control);
    return result;
  };
  const policyFence = (identity, axis, value, epoch = 1) =>
    importControl({
      scope,
      type: "policy",
      identity,
      axis,
      epoch,
      value,
      authorityRef: "test-authenticated-control",
    });
  const sourceFact = (auth) => ({
    authScope: auth,
    sourceBindingVersion: 1,
    roleMappingVersion: 1,
    provenanceVersion: 1,
    status: "active",
    attestationRef: "source-auth-attestation",
  });
  const mandateFact = (value = {}) => {
    const ownerDomains = [
      { domainId: "fixture-b-owner", kind: "work" },
      { domainId: "fixture-egress", kind: "egress_gate" },
      { domainId: "fixture-pointer", kind: "active_pointer" },
    ];
    return {
      schemaVersion: 1,
      mandateId: value.mandateId ?? "mandate",
      sourceBindingId: thread.sourceBindingId,
      revision: value.mandateRevision ?? 1,
      authorizationEpoch: value.authorizationEpoch ?? 1,
      status: value.status ?? "active",
      issuedByUserId: "user",
      allowedActorProviderIds: ["github-user"],
      allowedActions: [
        "source.read",
        "model.process_source",
        "local.draft.create",
        "local.draft.revise",
      ],
      ruleVersion: "github_issue_draft_v1",
      selection: { issueIds: ["123", "456"] },
      validUntil: new Date(value.expiresAt ?? 4102444800000).toISOString(),
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
    };
  };
  const leafFence = (identity, factKind, value, epoch = 1) =>
    importControl({
      scope,
      type: "leaf",
      identity,
      factKind,
      epoch,
      value,
      authorityRef: "test-authenticated-leaf",
    });
  const fence = (axis, value, epoch = 1, auth = authScope) => {
    const chain = scopes();
    if (auth !== authScope) {
      const current = imported.get(dshLeafId(chain[3].scopeKey, "source_auth"));
      assert.equal(
        leafFence(
          chain[3].identity,
          "source_auth",
          sourceFact(auth),
          Math.max(epoch, (current?.epoch ?? 0) + 1),
        ).ok,
        true,
      );
    }
    if (axis === "mode")
      return policyFence(chain[4].identity, axis, value, epoch);
    if (axis === "privacy")
      return policyFence(
        chain[4].identity,
        axis,
        { allowed: value.valid, restriction: null },
        epoch,
      );
    const data =
      axis === "mandate"
        ? mandateFact(value)
        : axis === "egress"
          ? {
              policyRef: value.policyRef,
              policyHash: value.policyHash,
              provider: "model-provider",
              destinationRef: "model-destination",
              purposes: ["draft"],
              enabled: value.allowed,
            }
          : {
              executionProfile: value.executionProfile,
              schemaVersion:
                value.executionProfile === "model_text_only_v1" ? 1 : 2,
              snapshotHash: value.snapshotHash,
              snapshotPolicyDigest:
                value.snapshotHash === null ? null : "d".repeat(64),
              approvalRef:
                value.snapshotHash === null ? null : "actual-readonly-approval",
            };
    return leafFence(chain[4].identity, axis, data, epoch);
  };
  const baseline = ({ omitScopeLevels = [], thread: target = thread } = {}) => {
    const chain = scopes(target);
    for (const cell of chain)
      if (!omitScopeLevels.includes(cell.identity.kind))
        for (const axis of DSH_POLICY_AXES)
          assert.equal(
            policyFence(
              cell.identity,
              axis,
              axis === "mode"
                ? { mode: "auto_draft" }
                : { allowed: true, restriction: null },
            ).ok,
            true,
          );
    assert.equal(
      leafFence(chain[3].identity, "source_auth", sourceFact(authScope)).ok,
      true,
    );
    assert.equal(
      leafFence(chain[4].identity, "mandate", mandateFact()).ok,
      true,
    );
    assert.equal(
      leafFence(chain[4].identity, "egress", {
        policyRef: "egress",
        policyHash: "e".repeat(64),
        provider: "model-provider",
        destinationRef: "model-destination",
        purposes: ["draft"],
        enabled: true,
      }).ok,
      true,
    );
    assert.equal(
      leafFence(chain[4].identity, "readonly", {
        executionProfile: "model_text_only_v1",
        schemaVersion: 1,
        snapshotHash: null,
        snapshotPolicyDigest: null,
        approvalRef: null,
      }).ok,
      true,
    );
  };
  async function command(overrides = {}) {
    const { dshCommandIdentity, dshEvidenceManifest } = await import(
      "../src/core/dsh-owner-data.js"
    );
    const data = {
      scope,
      thread,
      authScope,
      schemaVersion: 1,
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
      dispatchPolicy: "draft_only_no_business_dispatch",
      assessmentRef: "assessment",
      assessmentHash: "4".repeat(64),
      admissionWindowRef: "window",
      freshnessAttestationRef: "freshness",
      evidenceManifestHash: "5".repeat(64),
      budgetReservationRef: "budget-1",
      authorityValidUntil: "2100-01-01T00:00:00.000Z",
      executionDeadline: "2100-01-01T00:00:00.000Z",
      executionProfile: "model_text_only_v1",
      ...overrides,
    };
    const chain = scopes(data.thread, data.mandateId),
      policies = [],
      leaves = [],
      modes = [];
    for (const cell of chain)
      for (const axis of DSH_POLICY_AXES) {
        const row = imported.get(dshPolicyId(cell.scopeKey, axis));
        if (row) {
          policies.push({
            scopeKey: cell.scopeKey,
            axis,
            epoch: row.epoch,
            canonicalHash: row.canonicalHash,
            controlRevision: row.revision,
          });
          if (axis === "mode")
            modes.push({ scopeKey: cell.scopeKey, epoch: row.epoch });
        }
      }
    for (const kind of ["source_auth", "mandate", "egress", "readonly"]) {
      const cell = chain[kind === "source_auth" ? 3 : 4],
        id = dshLeafId(cell.scopeKey, kind),
        row = imported.get(id);
      if (row)
        leaves.push({
          id,
          epoch: row.epoch,
          canonicalHash: row.canonicalHash,
          controlRevision: row.revision,
        });
    }
    if (!Object.hasOwn(data, "modeGuards")) data.modeGuards = modes;
    else if (Object.keys(data.modeGuards).length === 5) data.modeGuards = modes; // retained old positive fixture shorthand; malformed empty guards stay malformed
    data.controlGuards ??= { policies, leaves };
    data.targetFenceEpoch ??= data.action === "request_stop" ? 1 : null;
    const inputs = overrides.evidenceInputs ?? [data.input];
    delete data.evidenceInputs;
    const entries = inputs.map((row) => ({
      inputId: row.inputId,
      objectKind: row.objectKind,
      objectId: row.sourceObjectId,
      revision: row.sourceRevision,
      contentHash: row.contentHash,
      provenanceVersion: row.provenanceVersion,
      actorEvidenceHash: row.provenanceHash,
      actorMappingVersion: row.actorMappingVersion,
    }));
    const manifest = dshEvidenceManifest(
      data.thread,
      entries,
      "2026-01-01T00:00:00.000Z",
    );
    data.evidence ??= { manifest, attestationRef: "evidence-attestation" };
    data.evidenceManifestHash = manifest.manifestHash;
    data.egressGuard ??= {
      policyRef: "egress",
      epoch: imported.get(dshLeafId(chain[4].scopeKey, "egress"))?.epoch ?? 1,
      policyHash: "e".repeat(64),
    };
    data.freshness ??= {
      window: {
        windowId: data.admissionWindowRef,
        sourceBindingId: data.thread.sourceBindingId,
        prefixModeGuardsHash: protocolDigest(data.modeGuards),
        admissionGrantHash: "7".repeat(64),
        effectiveAt: "2026-01-01T00:00:00.000Z",
        baselineCheckpointRef: "baseline",
        providerTimeBasisProofRef: "provider-time",
        freshnessPolicyVersion: 1,
      },
      eventTimeEvidenceRef: "event-time",
      attestationRef: data.freshnessAttestationRef,
    };
    return { ...data, ...dshCommandIdentity(data) };
  }
  function budget(data, overrides = {}) {
    const proof = Object.freeze(Object.create(null));
    budgets.set(proof, {
      reservationId: data.budgetReservationRef,
      issuerDomain: "actual-test-budget-owner",
      mandateId: data.mandateId,
      mandateRevision: data.mandateRevision,
      authorizationEpoch: data.authorizationEpoch,
      scope: data.scope,
      thread: data.thread,
      operationKey: data.operationKey,
      semanticPayloadHash: data.semanticPayloadHash,
      assessmentRef: data.assessmentRef,
      purpose:
        data.action === "prepare_draft" ? "draft_prepare" : "draft_admission",
      state: "reserved",
      ...overrides,
    });
    return proof;
  }
  const apply = (data) =>
    data.action === "request_stop" || data.action === "invalidate_input"
      ? hub.applyDshNarrowingCommand(issue("narrow", data), {
          requestSource: "scheduler",
        })
      : hub.applyDshOwnerCommand(issue("effect", data, budget(data)), {
          requestSource: "scheduler",
        });
  const read = (kind, lookup) =>
    hub[kind](
      issue("read", {
        scope,
        thread,
        bindingId: "binding",
        generation: 1,
        ...lookup,
      }),
    );
  return {
    root,
    filePath,
    hooks({ resolve, guard, budget } = {}) {
      resolveHook = resolve;
      guardHook = guard;
      budgetHook = budget;
    },
    get hub() {
      return hub;
    },
    get backend() {
      return backend;
    },
    control,
    authority,
    source,
    budgetSource,
    issue,
    fence,
    policyFence,
    leafFence,
    scopes,
    baseline,
    command,
    apply,
    budget,
    read,
    physical,
    raw,
    effects,
    prepare() {
      assert.equal(typeof hub.prepareDshOwnerWriter, "function");
      return hub.prepareDshOwnerWriter(control);
    },
    reopen() {
      hub.closePersistence();
      open();
    },
    revoke() {
      current = false;
    },
    revokeRead() {
      readCurrent = false;
    },
  };
}

import { Hash } from "node:crypto";

const commandB = async (f) =>
  f.command({
    thread: { ...thread, threadId: "456" },
    commandId: "command-thread-456",
    inputId: "input-456",
    input: {
      inputId: "input-456",
      sourceObjectId: "issue-456",
      sourceRevision: "r1",
      contentHash: "6".repeat(64),
      provenanceHash: "2".repeat(64),
      objectKind: "issue",
      provenanceVersion: 1,
      actorMappingVersion: 1,
      snapshotRef: "snapshot-456",
    },
    canonical: { inputId: "input-456", createManifestHash: "9".repeat(64) },
  });
test("control original Hub creates separate real SQLite work and receipt for two allowed threads", async (t) => {
  const f = fixture(t);
  f.prepare();
  f.baseline();
  const a = await f.command(),
    first = f.apply(a),
    b = await commandB(f),
    second = f.apply(b);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  t.diagnostic(
    JSON.stringify({
      case: "control",
      firstWork: first.receipt.ownerWorkId,
      secondWork: second.receipt.ownerWorkId,
      firstThread: first.receipt.command.thread.threadId,
      secondThread: second.receipt.command.thread.threadId,
      physicalProjects: f.raw(
        (db) =>
          db
            .prepare(
              "SELECT count(*) n FROM state_entities WHERE collection='project'",
            )
            .get().n,
      ),
      effects: f.effects.length,
    }),
  );
  assert.notEqual(second.receipt.ownerWorkId, first.receipt.ownerWorkId);
  assert.equal(second.receipt.command.thread.threadId, "456");
  assert.equal(f.hub.listProjects().length, 2);
  assert.equal(f.effects.length, 0);
});
test("late public Hash SDK must not reuse another real Thread operation receipt", async (t) => {
  const f = fixture(t);
  f.prepare();
  f.baseline();
  const a = await f.command(),
    first = f.apply(a);
  assert.equal(first.ok, true, JSON.stringify(first));
  const update = Hash.prototype.update,
    digest = Hash.prototype.digest,
    seen = new WeakMap();
  let updateHits = 0,
    hits = 0,
    b,
    second;
  Hash.prototype.update = function (value, ...args) {
    seen.set(this, typeof value === "string" ? value : String(value));
    if (
      typeof value === "string" &&
      (value.startsWith('["dsh-operation-v1",') ||
        value.startsWith('["dsh-semantic-v1",'))
    )
      updateHits++;
    return Reflect.apply(update, this, [value, ...args]);
  };
  Hash.prototype.digest = function (...args) {
    const value = seen.get(this) ?? "";
    if (value.includes('"threadId":"456"')) {
      if (value.startsWith('["dsh-operation-v1",')) {
        hits++;
        return a.operationKey.slice("dsh-operation:".length);
      }
      if (value.startsWith('["dsh-semantic-v1",')) {
        hits++;
        return a.semanticPayloadHash;
      }
    }
    return Reflect.apply(digest, this, args);
  };
  try {
    b = await commandB(f);
    second = f.apply(b);
  } finally {
    Hash.prototype.update = update;
    Hash.prototype.digest = digest;
  }
  const physical = f.raw((db) => ({
    projects: db
      .prepare(
        "SELECT count(*) n FROM state_entities WHERE collection='project'",
      )
      .get().n,
    commands: db
      .prepare(
        "SELECT state_json FROM state_entities WHERE collection='protocolReceipt'",
      )
      .all()
      .map((r) => JSON.parse(r.state_json))
      .filter((r) => r.kind === "dsh_command")
      .map((r) => ({
        thread: r.command.thread.threadId,
        input: r.command.inputId,
        operation: r.operationKey,
      })),
  }));
  t.diagnostic(
    JSON.stringify({
      case: "late-hash-real-hub",
      hits,
      updateHits,
      requestedThread: b.thread.threadId,
      requestedInput: b.inputId,
      resultOk: second.ok,
      firstWork: first.receipt.ownerWorkId,
      returnedWork: second.receipt?.ownerWorkId,
      returnedThread: second.receipt?.command?.thread?.threadId,
      returnedInput: second.receipt?.command?.inputId,
      physical,
      effects: f.effects.length,
    }),
  );
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.receipt.ownerWorkId, first.receipt.ownerWorkId);
  assert.equal(second.receipt.command.thread.threadId, "456");
  assert.equal(physical.projects, 2);
  assert.equal(physical.commands.length, 2);
  assert.equal(second.receipt.command.inputId, "input-456");
  assert.equal(hits, 0);
  assert.equal(updateHits, 0);
});

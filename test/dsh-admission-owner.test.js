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
function fixture(t, { sqliteFactory, allowedActions } = {}) {
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
      allowedActions: allowedActions ?? [
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
    if (!Object.hasOwn(data, "workGuard")) {
      data.workGuard = null;
      if (data.action === "append_input" || data.action === "prepare_draft") {
        const observed = read("readDshWork", {
          ownerWorkId: data.targetWorkId,
        });
        if (observed.ok && observed.work.guard) {
          const g = observed.work.guard;
          data.workGuard = {
            scopeKey: g.scopeKey,
            epoch: g.epoch,
            revision: g.revision,
          };
        }
      }
    }
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
    commitBudget(proof){const cap=Object.freeze(Object.create(null));budgets.set(cap,{issuerDomain:'actual-test-budget-owner',proof});return cap;},
    read,
    physical,
    raw,
    effects,
    prepare() {
      assert.equal(typeof hub.prepareDshAdmissionOwnerWriter, "function");
      return hub.prepareDshAdmissionOwnerWriter(control);
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

test("DSH8 fresh profile is distinct and old7 does not lazy-upgrade", (t) => {
  const f = fixture(t);
  assert.equal(f.prepare().ok, true);
  const floor = f.hub.inspectDefaultDispatchWriter(f.control).profile.floor;
  assert.equal(floor.schemaVersion, 8);
  assert.equal(floor.profile, "dsh_admission_owner_writer_v1");
  const old = fixture(t);
  assert.equal(old.hub.prepareDshOwnerWriter(old.control).ok, true);
  const before = old.physical();
  assert.equal(old.prepare().ok, false);
  assert.deepEqual(old.physical(), before);
});
test("original create transaction births real work guard and trusted creation time", async (t) => {
  const f = fixture(t);
  assert.equal(f.prepare().ok, true);
  f.baseline();
  const data = await f.command(),
    created = f.apply(data);
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.receipt.ownerWorkId,
    read = f.read("readDshWork", { ownerWorkId: id });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.work.guard.mode, "auto_draft");
  assert.equal(read.work.guard.epoch, 1);
  assert.equal(read.work.guard.revision, 1);
  assert.equal(read.work.guard.ownerWorkId, id);
  assert.equal(read.work.control.workGuardId, read.work.guard.id);
  const project = f.hub.getProject(id);
  assert.equal(
    read.work.control.workCreatedAt,
    new Date(project.createdAt).toISOString(),
  );
  assert.equal(Number.isSafeInteger(project.createdAt), true);
  const before = f.physical();
  f.reopen();
  assert.deepEqual(f.read("readDshWork", { ownerWorkId: id }), read);
  assert.deepEqual(f.physical(), before);
  assert.deepEqual(f.effects, []);
});
test("actual B append advances owner version while keeping guard and time stable", async (t) => {
  const f = fixture(t);
  f.prepare();
  f.baseline();
  const create = await f.command(),
    first = f.apply(create),
    id = first.receipt.ownerWorkId;
  const initial = f.read("readDshWork", { ownerWorkId: id }).work;
  const append = await f.command({
    action: "append_input",
    commandId: "append-2",
    inputId: "input-2",
    input: { ...create.input, inputId: "input-2", sourceRevision: "r2" },
    canonical: null,
    targetWorkId: id,
    expectedOwnerVersion: 1,
  });
  assert.equal(f.apply(append).ok, true);
  const current = f.read("readDshWork", { ownerWorkId: id }).work;
  assert.equal(current.control.ownerVersion, 2);
  assert.deepEqual(current.guard, initial.guard);
  assert.equal(current.control.workCreatedAt, initial.control.workCreatedAt);
});
for (const targetMode of ["off", "observe"])
  test(`work ${targetMode} closes only its original generation and rejects late append`, async (t) => {
    const f = fixture(t);
    f.prepare();
    f.baseline();
    const create = await f.command(),
      first = f.apply(create),
      id = first.receipt.ownerWorkId;
    const mode = {
      scope,
      thread,
      bindingId: "binding",
      generation: 1,
      ownerWorkId: id,
      targetMode,
      targetEpoch: 2,
      expectedGuardRevision: 1,
      commandId: "mode-" + targetMode,
      operationKey: "work-mode-" + targetMode,
      attemptPayloadHash: "c".repeat(64),
      semanticPayloadHash: "d".repeat(64),
      authorityRef: "authenticated-local-control",
    };
    const { dshWorkModeIdentity } = await import(
      "../src/core/dsh-owner-data.js"
    );
    Object.assign(mode, dshWorkModeIdentity(mode));
    const result = f.hub.applyDshWorkModeFence(f.issue("work_control", mode), {
      requestSource: "user",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const observed = f.read("readDshWork", { ownerWorkId: id }).work;
    assert.equal(observed.guard.mode, targetMode);
    assert.equal(observed.guard.epoch, 2);
    assert.equal(observed.control.generationClosed, true);
    const append = await f.command({
      action: "append_input",
      commandId: "late-" + targetMode,
      inputId: "late-input",
      input: { ...create.input, inputId: "late-input" },
      canonical: null,
      targetWorkId: id,
      expectedOwnerVersion: observed.control.ownerVersion,
    });
    assert.equal(f.apply(append).ok, false);
    const slot = await f.command({
      action: "prepare_draft",
      commandId: "late-slot-" + targetMode,
      targetWorkId: id,
      expectedOwnerVersion: observed.control.ownerVersion,
      inputSetRevision: 1,
    });
    assert.equal(
      f.hub.prepareDshDraftSlot(f.issue("slot", slot, f.budget(slot)), {
        requestSource: "scheduler",
      }).ok,
      false,
    );
    assert.equal(f.hub.listProjects().length, 1);
    assert.deepEqual(f.effects, []);
  });
test("one original Native cut authenticates receipt, creation, guard and physical project time", async (t) => {
  const f = fixture(t);
  f.prepare();
  f.baseline();
  const data = await f.command(),
    created = f.apply(data);
  assert.equal(typeof f.hub.readDshAdmissionReceiptBasis, "function");
  const basis = f.read("readDshAdmissionReceiptBasis", {
    operationKey: data.operationKey,
  });
  assert.equal(basis.ok, true, JSON.stringify(basis));
  assert.deepEqual(basis.basis.commandReceipt, created.receipt);
  assert.equal(basis.basis.createRecord.canonicalInputId, data.inputId);
  assert.equal(
    basis.basis.projectCreatedAt,
    f.hub.getProject(created.receipt.ownerWorkId).createdAt,
  );
  assert.equal(basis.basis.workGuard.epoch, 1);
});

for (const phase of ["before", "after"])
  test(`B8 actual ${phase} COMMIT preserves atomic guard/time and original cause`, async (t) => {
    let armed = false;
    const cause = Error("B8 actual " + phase + " COMMIT");
    const f = fixture(t, {
      sqliteFactory(path) {
        const db = new DatabaseSync(path),
          exec = db.exec.bind(db);
        db.exec = (sql) => {
          if (armed && sql === "COMMIT" && phase === "before") {
            armed = false;
            throw cause;
          }
          const value = exec(sql);
          if (armed && sql === "COMMIT" && phase === "after") {
            armed = false;
            throw cause;
          }
          return value;
        };
        return db;
      },
    });
    f.prepare();
    f.baseline();
    const data = await f.command();
    armed = true;
    assert.throws(
      () => f.apply(data),
      (error) => {
        if (phase === "before") assert.equal(error.cause, cause);
        else assert.equal(error.cause.cause, cause);
        return true;
      },
    );
    const rows = f.raw((db) =>
      db
        .prepare(
          "SELECT state_json FROM state_entities WHERE collection IN ('protocolReceipt','protocolHead')",
        )
        .all()
        .map((row) => JSON.parse(row.state_json)),
    );
    assert.equal(
      rows.filter((row) => row.kind === "dsh_work_guard").length,
      phase === "after" ? 1 : 0,
    );
    assert.equal(
      rows.filter((row) => row.kind === "dsh_applied_operation").length,
      phase === "after" ? 1 : 0,
    );
    f.reopen();
    const result = f.read("readDshAdmissionReceiptBasis", {
      operationKey: data.operationKey,
    });
    assert.equal(result.ok, phase === "after");
    if (result.ok)
      assert.equal(
        result.basis.control.workCreatedAt,
        new Date(result.basis.projectCreatedAt).toISOString(),
      );
  });
test("new actual guard can never revive an already closed generation", async (t) => {
  const f = fixture(t);
  f.prepare();
  f.baseline();
  const data = await f.command(),
    first = f.apply(data),
    id = first.receipt.ownerWorkId,
    { dshWorkModeIdentity } = await import("../src/core/dsh-owner-data.js");
  const mode = (targetMode, targetEpoch, expectedGuardRevision) => {
    const value = {
      scope,
      thread,
      bindingId: "binding",
      generation: 1,
      ownerWorkId: id,
      targetMode,
      targetEpoch,
      expectedGuardRevision,
      commandId: "mode-" + targetEpoch,
      authorityRef: "local-control",
    };
    Object.assign(value, dshWorkModeIdentity(value));
    return f.hub.applyDshWorkModeFence(f.issue("work_control", value), {
      requestSource: "user",
    });
  };
  assert.equal(mode("off", 2, 1).ok, true);
  assert.equal(mode("auto_draft", 3, 2).ok, true);
  const current = f.read("readDshWork", { ownerWorkId: id }).work;
  assert.equal(current.guard.mode, "auto_draft");
  assert.equal(current.control.stopped, true);
  assert.equal(current.control.generationClosed, true);
  const append = await f.command({
    action: "append_input",
    commandId: "after-auto",
    inputId: "input-2",
    input: { ...data.input, inputId: "input-2" },
    canonical: null,
    targetWorkId: id,
    expectedOwnerVersion: current.control.ownerVersion,
  });
  assert.equal(f.apply(append).ok, false);
});
test("work mode fence cannot close the other actual thread in the same mandate", async (t) => {
  const f = fixture(t);
  f.prepare();
  f.baseline();
  const one = f.apply(await f.command()),
    otherThread = { ...thread, threadId: "456" },
    other = await f.command({
      thread: otherThread,
      commandId: "create-other",
      bindingId: "binding-other",
      inputId: "input-other",
      input: {
        inputId: "input-other",
        sourceObjectId: "issue-456",
        sourceRevision: "r1",
        contentHash: "a".repeat(64),
        provenanceHash: "b".repeat(64),
        objectKind: "issue",
        provenanceVersion: 1,
        actorMappingVersion: 1,
        snapshotRef: "snapshot-other",
      },
      canonical: { inputId: "input-other", createManifestHash: "3".repeat(64) },
    }),
    two = f.apply(other);
  assert.equal(two.ok, true);
  const { dshWorkModeIdentity } = await import("../src/core/dsh-owner-data.js"),
    value = {
      scope,
      thread,
      bindingId: "binding",
      generation: 1,
      ownerWorkId: one.receipt.ownerWorkId,
      targetMode: "observe",
      targetEpoch: 2,
      expectedGuardRevision: 1,
      commandId: "close-one",
      authorityRef: "local-control",
    };
  Object.assign(value, dshWorkModeIdentity(value));
  assert.equal(
    f.hub.applyDshWorkModeFence(f.issue("work_control", value), {
      requestSource: "user",
    }).ok,
    true,
  );
  const read = f.hub.readDshWork(
    f.issue("read", {
      scope,
      thread: otherThread,
      bindingId: "binding-other",
      generation: 1,
      ownerWorkId: two.receipt.ownerWorkId,
    }),
  );
  assert.equal(read.ok, true);
  assert.equal(read.work.control.generationClosed, false);
  assert.equal(read.work.guard.epoch, 1);
});
test("unknown or copied admission read frame invokes no DTO getter and cannot mutate", async (t) => {
  const f = fixture(t);
  f.prepare();
  f.baseline();
  const data = await f.command();
  f.apply(data);
  const before = f.physical();
  let getters = 0;
  const fake = new Proxy(
    {},
    {
      get() {
        getters++;
        throw Error("forbidden");
      },
    },
  );
  assert.equal(f.hub.readDshAdmissionReceiptBasis(fake).ok, false);
  assert.equal(getters, 0);
  assert.deepEqual(f.physical(), before);
  const frame = f.issue("read", {
    scope,
    thread,
    bindingId: "binding",
    generation: 1,
    operationKey: data.operationKey,
  });
  assert.equal(f.hub.readDshAdmissionReceiptBasis({ ...frame }).ok, false);
  assert.deepEqual(f.physical(), before);
});
test("schema2 command cannot omit work guard or borrow a foreign actual scope", async (t) => {
  const f = fixture(t);
  f.prepare();
  f.baseline();
  const data = await f.command(),
    first = f.apply(data),
    id = first.receipt.ownerWorkId;
  const base = await f.command({
      action: "append_input",
      commandId: "guard-negative",
      inputId: "input-2",
      input: { ...data.input, inputId: "input-2" },
      canonical: null,
      targetWorkId: id,
      expectedOwnerVersion: 1,
    }),
    before = f.physical(),
    { dshCommandIdentity } = await import("../src/core/dsh-owner-data.js");
  const missing = { ...base };
  delete missing.workGuard;
  Object.assign(missing, dshCommandIdentity(missing));
  assert.equal(f.apply(missing).ok, false);
  assert.deepEqual(f.physical(), before);
  const wrong = {
    ...base,
    workGuard: { ...base.workGuard, scopeKey: "foreign-work" },
  };
  Object.assign(wrong, dshCommandIdentity(wrong));
  assert.equal(f.apply(wrong).ok, false);
  assert.equal(f.hub.listProjects().length, 1);
  assert.deepEqual(f.effects, []);
});

test("actual original floor7 held connection and nine precompiled Native writes reject new8", async (t) => {
  const f = fixture(t),
    old = await import(
      "./fixtures/dsh-original-floor7/src/core/sqlite-writer-floor.js"
    ),
    db = new DatabaseSync(f.filePath);
  try {
    const floor = old.createSqliteWriterFloor(db);
    assert.equal(floor.read(), null);
    const sql = [
        "INSERT INTO state_entities VALUES('project','old','old','{}','x',1,'x')",
        "UPDATE state_entities SET updated_at='old'",
        "DELETE FROM state_entities",
        "INSERT INTO state_entity_history VALUES('project','old','old','{}','x',1,'x')",
        "UPDATE state_entity_history SET updated_at='old'",
        "DELETE FROM state_entity_history",
        "INSERT INTO state_meta VALUES('old','x')",
        "UPDATE state_meta SET meta_value='0' WHERE meta_key='revision'",
        "DELETE FROM state_meta WHERE meta_key='revision'",
      ],
      statements = sql.map((text) => db.prepare(text));
    f.prepare();
    f.baseline();
    assert.equal(f.apply(await f.command()).ok, true);
    const before = f.physical();
    for (const statement of statements)
      assert.throws(
        () => statement.run(),
        /kswarm_dsh_admission_owner_writer_v1|writer_floor/,
      );
    assert.deepEqual(f.physical(), before);
    assert.throws(() => floor.assertWritable(), /integrity|unsupported/);
  } finally {
    db.close();
  }
});
for (const mutation of ["delete_guard", "change_created_at"])
  test(`cold original graph rejects ${mutation} without repair`, async (t) => {
    const f = fixture(t);
    f.prepare();
    f.baseline();
    const data = await f.command(),
      created = f.apply(data),
      id = created.receipt.ownerWorkId;
    f.hub.closePersistence();
    const db = new DatabaseSync(f.filePath);
    try {
      const floor = JSON.parse(
        db
          .prepare(
            "SELECT meta_value FROM state_meta WHERE meta_key='writer_floor_v1'",
          )
          .get().meta_value,
      );
      db.function(
        "kswarm_dsh_admission_owner_writer_v1",
        () => floor.writerProfileDigest,
      );
      if (mutation === "delete_guard")
        db.prepare(
          "DELETE FROM state_entities WHERE collection='protocolHead' AND entity_key=?",
        ).run(id + ":work-guard");
      else {
        const row = db
            .prepare(
              "SELECT state_json FROM state_entities WHERE collection='project' AND entity_key=?",
            )
            .get(id),
          project = JSON.parse(row.state_json);
        project.createdAt++;
        const text = JSON.stringify(project),
          checksum = createHash("sha256").update(text).digest("hex");
        db.prepare(
          "UPDATE state_entities SET state_json=?,checksum=? WHERE collection='project' AND entity_key=?",
        ).run(text, checksum, id);
      }
    } finally {
      db.close();
    }
    f.reopen();
    const before = f.physical(),
      result = f.read("readDshAdmissionReceiptBasis", {
        operationKey: data.operationKey,
      });
    assert.equal(result.ok, false);
    assert.deepEqual(f.physical(), before);
    assert.deepEqual(f.effects, []);
  });

test("unsupported old7 basis read and agent work controls enter no Source SDK", (t) => {
  const f = fixture(t);
  assert.equal(f.hub.prepareDshOwnerWriter(f.control).ok, true);
  let calls = 0;
  f.hooks({
    resolve() {
      calls++;
    },
  });
  assert.equal(
    f.hub.readDshAdmissionReceiptBasis({}).error,
    "DSH_ADMISSION_PROFILE_REQUIRED",
  );
  assert.equal(calls, 0);
  const g = fixture(t);
  g.prepare();
  g.hooks({
    resolve() {
      calls++;
    },
  });
  assert.equal(
    g.hub.applyDshWorkModeFence({}, { requestSource: "agent" }).ok,
    false,
  );
  assert.equal(calls, 0);
});

test('original B exposes draft stage commit and read on its accepted slot',async t=>{
  const f=fixture(t);assert.equal(f.prepare().ok,true);f.baseline();
  const created=f.apply(await f.command());assert.equal(created.ok,true);
  const authority=await f.command({commandId:'prepare-text',action:'prepare_draft',targetWorkId:created.receipt.ownerWorkId,expectedOwnerVersion:1,inputSetRevision:1});
  const prepared=f.hub.prepareDshDraftSlot(f.issue('slot',authority,f.budget(authority)),{requestSource:'scheduler'});assert.equal(prepared.ok,true,JSON.stringify(prepared));
  for(const name of ['stageDshDraft','commitDshDraft','readDshDraft'])assert.equal(typeof f.hub[name],'function',name);
  assert.deepEqual(f.effects,[]);
});

async function draftFixture(t,options){
 const f=fixture(t,options);assert.equal(f.prepare().ok,true);f.baseline();
 const created=f.apply(await f.command());assert.equal(created.ok,true);
 const authority=await f.command({commandId:'prepare-candidate',action:'prepare_draft',targetWorkId:created.receipt.ownerWorkId,expectedOwnerVersion:1,inputSetRevision:1});
 const prepared=f.hub.prepareDshDraftSlot(f.issue('slot',authority,f.budget(authority)),{requestSource:'scheduler'});assert.equal(prepared.ok,true,JSON.stringify(prepared));
 const observed=f.read('readDshDraftSlot',{ownerWorkId:created.receipt.ownerWorkId,draftCommitKey:prepared.slot.id});assert.equal(observed.ok,true,JSON.stringify(observed));
 const {dshDraftContentHash,dshDraftHashes}=await import('../src/core/dsh-draft-data.js');
 const proof={proofId:'original-usage-proof',budgetOwnerId:'original-budget-uuid',reservationRef:authority.budgetReservationRef,operationKey:authority.operationKey,ownerWorkId:created.receipt.ownerWorkId,bindingId:authority.bindingId,inputManifestHash:observed.inputManifest.manifestHash,finalizedUsageRevision:1,validUntil:'2100-01-01T00:00:00.000Z',receiptDigest:'9'.repeat(64),chargedBasis:'conservative_upper_bound',ledgerRevision:1};
 const candidate={schemaVersion:1,scope,thread,bindingId:'binding',generation:1,ownerWorkId:created.receipt.ownerWorkId,draftCommitKey:prepared.slot.id,artifactId:prepared.slot.artifactId,draftInvocationId:prepared.slot.draftInvocationId,attemptId:'draft-commit-attempt',expectedOwnerVersion:prepared.receipt.ownerVersion,authority,manifest:observed.inputManifest,budgetCommitProof:proof,content:{kind:'dsh_model_text_v1',text:'Original bounded draft text.',contentHash:dshDraftContentHash('Original bounded draft text.')}};
 Object.assign(candidate,dshDraftHashes(candidate));
 const stage=value=>f.hub.stageDshDraft(f.issue('draft_stage',value,f.commitBudget(value.budgetCommitProof)),{requestSource:'scheduler'});
 const commit=value=>f.hub.commitDshDraft(f.issue('draft_commit',value,f.commitBudget(value.budgetCommitProof)),{requestSource:'scheduler'});
 return{f,candidate,stage,commit};
}
test('original B stages a bounded candidate before one committed artifact and survives reopen',async t=>{
 const {f,candidate,stage,commit}=await draftFixture(t);
 const staged=stage(candidate);assert.equal(staged.ok,true,JSON.stringify(staged));assert.equal(staged.result,'staged');
 assert.equal(JSON.stringify(staged).includes(candidate.content.text),false,'immutable stage response is metadata only');
 f.reopen();assert.equal(stage(candidate).result,'already_staged');
 const result=commit(candidate);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result,'committed');
 f.reopen();assert.equal(commit(candidate).result,'already_committed');
 const read=f.read('readDshDraft',{ownerWorkId:candidate.ownerWorkId,draftCommitKey:candidate.draftCommitKey});assert.equal(read.draft.state,'committed');assert.equal(read.draft.currentDraftValid,true);assert.equal(JSON.stringify(read).includes(candidate.content.text),false);
 const work=f.read('readDshWork',{ownerWorkId:candidate.ownerWorkId});assert.equal(work.work.control.completionLatch,true);assert.equal(work.work.control.generationClosed,true);
 assert.deepEqual(f.effects,[]);
});
test('original B refuses candidate replacement and exact attempt conflict without another artifact',async t=>{
 const {f,candidate,stage,commit}=await draftFixture(t),{dshDraftHashes,dshDraftContentHash}=await import('../src/core/dsh-draft-data.js');
 assert.equal(stage(candidate).ok,true);
 const changed={...candidate,attemptId:'changed-attempt',content:{...candidate.content,text:'different bounded text',contentHash:dshDraftContentHash('different bounded text')}};Object.assign(changed,dshDraftHashes(changed));
 assert.equal(stage(changed).error,'DSH_DRAFT_PAYLOAD_CONFLICT');
 const sameAttempt={...candidate,expectedOwnerVersion:candidate.expectedOwnerVersion+1};Object.assign(sameAttempt,dshDraftHashes(sameAttempt));
 assert.equal(stage(sameAttempt).error,'DSH_DRAFT_ATTEMPT_CONFLICT');
 assert.equal(commit(candidate).ok,true);assert.deepEqual(f.effects,[]);
});
test('original B last policy fence rejects a new commit but preserves immutable staged bytes',async t=>{
 const {f,candidate,stage,commit}=await draftFixture(t);assert.equal(stage(candidate).ok,true);
 const scopeCell=f.scopes(thread,'mandate')[0];assert.equal(f.policyFence(scopeCell.identity,'mode',{mode:'off'},2).ok,true);
 const result=commit(candidate);assert.equal(result.ok,false);assert.equal(f.read('readDshDraft',{ownerWorkId:candidate.ownerWorkId,draftCommitKey:candidate.draftCommitKey}).draft.state,'staged');
});
test('original invalidation masks derived content without erasing historical completion or paid proof',async t=>{
 const {f,candidate,stage,commit}=await draftFixture(t);assert.equal(stage(candidate).ok,true);assert.equal(commit(candidate).ok,true);
 const change=await f.command({commandId:'actual-invalidate-after-artifact',action:'invalidate_input',purpose:'invalidation',targetWorkId:candidate.ownerWorkId,expectedOwnerVersion:3});
 const result=f.apply(change);assert.equal(result.ok,true,JSON.stringify(result));
 const read=f.read('readDshDraft',{ownerWorkId:candidate.ownerWorkId,draftCommitKey:candidate.draftCommitKey});assert.equal(read.draft.state,'committed');assert.equal(read.draft.currentDraftValid,false);
 const records=f.raw(db=>db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolHead'").all());const body=records.map(row=>JSON.parse(row.state_json)).find(row=>row.kind==='dsh_draft_content');assert.equal(body?.text,null);assert.equal(body?.state,'redacted');
 assert.equal(f.read('readDshWork',{ownerWorkId:candidate.ownerWorkId}).work.control.completionLatch,true);
 assert.equal(commit(candidate).result,'already_committed');
});

for(const operation of ['stage','commit'])test(`original B ${operation} post-COMMIT Source failure retains durable truth without positive return`,async t=>{
 let armed=false,revoke;
 const options={sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{const result=exec(sql);if(armed&&sql==='COMMIT'){armed=false;revoke();}return result;};return db;}};
 const {f,candidate,stage,commit}=await draftFixture(t,options);revoke=()=>f.revoke();
 if(operation==='commit')assert.equal(stage(candidate).ok,true);
 armed=true;assert.throws(()=>operation==='stage'?stage(candidate):commit(candidate),/DSH_SOURCE_REJECTED/);
 assert.equal(f.read('readDshDraft',{ownerWorkId:candidate.ownerWorkId,draftCommitKey:candidate.draftCommitKey}).draft.state,operation==='stage'?'staged':'committed');
});
test('cold admission basis observes only the exact immutable blocked command without replaying it',async t=>{
 const f=fixture(t);f.prepare();f.baseline();const created=f.apply(await f.command());assert.equal(created.ok,true);
 const command=await f.command({commandId:'blocked-append-audit',action:'append_input',targetWorkId:created.receipt.ownerWorkId,expectedOwnerVersion:1,canonical:null});
 const result=f.hub.applyDshOwnerCommand(f.issue('effect',command,f.budget(command,{state:'unknown'})),{requestSource:'scheduler'});assert.equal(result.ok,false);assert.equal(result.receipt.result,'blocked');
 f.reopen();const before=f.physical();
 const observed=f.read('readDshAdmissionReceiptBasis',{operationKey:command.operationKey,commandId:command.commandId});assert.deepEqual(observed,result);
 assert.equal(f.read('readDshAdmissionReceiptBasis',{operationKey:command.operationKey}).error,'DSH_OPERATION_NOT_FOUND');
 assert.equal(f.read('readDshAdmissionReceiptBasis',{operationKey:command.operationKey,commandId:'wrong-command'}).error,'DSH_OPERATION_NOT_FOUND');
 assert.equal(f.read('readDshAdmissionReceiptBasis',{operationKey:command.operationKey,commandId:command.commandId,bindingId:'foreign'}).error,'DSH_READ_FORBIDDEN');
 assert.deepEqual(f.physical(),before);assert.deepEqual(f.effects,[]);
});


test("create-only authority covers the first slot, stage and committed artifact", async (t) => {
  const { f, candidate, stage, commit } = await draftFixture(t, {
    allowedActions: ["source.read", "model.process_source", "local.draft.create"],
  });
  assert.equal(stage(candidate).ok, true);
  f.reopen();
  const committed = commit(candidate);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(committed.result, "committed");
  f.reopen();
  assert.equal(commit(candidate).result, "already_committed");
  const invalidation = await f.command({
    commandId: "mask-create-only-artifact", action: "invalidate_input", purpose: "invalidation",
    targetWorkId: candidate.ownerWorkId, expectedOwnerVersion: 3,
  });
  assert.equal(f.apply(invalidation).ok, true);
  assert.equal(f.read("readDshDraft", {
    ownerWorkId: candidate.ownerWorkId, draftCommitKey: candidate.draftCommitKey,
  }).draft.currentDraftValid, false);
  const next = await f.command({
    commandId: "cannot-recreate-after-masked-artifact", action: "prepare_draft",
    targetWorkId: candidate.ownerWorkId, expectedOwnerVersion: 4, inputSetRevision: 2,
  });
  const refused = f.hub.prepareDshDraftSlot(f.issue("slot", next, f.budget(next)), {
    requestSource: "scheduler",
  });
  assert.equal(refused.ok, false);
  const history = f.raw(db => db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt'").all());
  assert.equal(history.map(row => JSON.parse(row.state_json)).filter(row => row.kind === "dsh_draft_artifact").length, 1);
  assert.equal(commit(candidate).result, "already_committed");
});

test("create-only authority does not grant append and revise-only does not grant create", async (t) => {
  const f = fixture(t, { allowedActions: ["source.read", "model.process_source", "local.draft.create"] });
  f.prepare(); f.baseline();
  const created = f.apply(await f.command());
  assert.equal(created.ok, true);
  const append = await f.command({ commandId: "append-needs-revise", action: "append_input",
    targetWorkId: created.receipt.ownerWorkId, expectedOwnerVersion: 1, canonical: null });
  assert.equal(f.apply(append).error, "DSH_AUTHORITY_BLOCKED");
  const g = fixture(t, { allowedActions: ["source.read", "model.process_source", "local.draft.revise"] });
  g.prepare(); g.baseline();
  assert.equal(g.apply(await g.command()).error, "DSH_AUTHORITY_BLOCKED");
});

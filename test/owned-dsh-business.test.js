import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedDefaultDispatchBusiness } from "../src/server/owned-default-dispatch-business.js";
const scope = { profileId: "a".repeat(64), workspaceId: "b".repeat(64) },
  protocol = "kswarm_dispatch_business_v1";
async function fixture(
  t,
  { holdCallback = false, holdRaw = false, server = false } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "owned-dsh-business-")),
    messages = [],
    waiters = [];
  let output = "";
  const child = spawn(
    process.execPath,
    [
      server
        ? "src/server/index.js"
        : "test/fixtures/owned-dsh-business/entry.js",
    ],
    {
      env: {
        ...process.env,
        ...(server
          ? {
              HOME: root,
              USERPROFILE: root,
              KSWARM_DATA_ROOT: root,
              KSWARM_PORT: "0",
              BROKER_URL: "http://127.0.0.1:9",
              XIAOK_CONFIG_DIR: join(root, "config"),
              KSWARM_DESKTOP_PROFILE_ID: scope.profileId,
              KSWARM_DESKTOP_WORKSPACE_ID: scope.workspaceId,
              XIAOK_DISABLE_GLOBAL_PLUGINS: "1",
            }
          : {}),
        DSH_BUSINESS_ROOT: root,
        DSH_HOLD_CALLBACK: holdCallback ? "1" : "",
        DSH_HOLD_RAW: holdRaw ? "1" : "",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
  );
  const closed = new Promise((yes) =>
    child.once("close", (code, signal) => {
      console.log(
        JSON.stringify({
          fixture: "owned-dsh-business",
          pid: child.pid,
          code,
          signal,
          reaped: true,
        }),
      );
      yes({ code, signal });
    }),
  );
  child.stdout.on("data", (v) => {
    output += v;
  });
  child.stderr.on("data", (v) => {
    output += v;
  });
  const wait = (predicate) =>
    new Promise((yes, no) => {
      const old = messages.find(predicate);
      if (old) return yes(old);
      const row = {
        predicate,
        yes,
        timer: setTimeout(
          () =>
            no(
              Error(
                "response_timeout " + output + " " + JSON.stringify(messages),
              ),
            ),
          5000,
        ),
      };
      waiters.push(row);
    });
  child.on("message", (message) => {
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i--)
      if (waiters[i].predicate(message)) {
        const row = waiters.splice(i, 1)[0];
        clearTimeout(row.timer);
        row.yes(message);
      }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.stdin.write("release-callback\nrelease-raw\nclose\n");
    await Promise.race([closed, new Promise((yes) => setTimeout(yes, 500))]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await closed;
    for (const row of waiters) clearTimeout(row.timer);
    rmSync(root, { recursive: true, force: true });
  });
  if (!server) await wait((m) => m.protocol === "fixture_ready");
  const nonce = "c".repeat(64);
  child.send({ protocol, type: "hello", scope, nonce });
  const hello = await wait(
    (m) => m.protocol === protocol && m.type === "hello_ack",
  );
  let id = 0;
  return {
    child,
    messages,
    wait,
    request(op, input = null, extra = { family: "dsh" }) {
      const number = ++id;
      child.send({
        protocol,
        type: "request",
        scope,
        nonce,
        instance: hello.instance,
        id: number,
        op,
        projectId: "@dsh-domain",
        input,
        ...extra,
      });
      return wait(
        (m) =>
          m.protocol === protocol &&
          (m.type === "fault" || (m.type === "response" && m.id === number)),
      );
    },
  };
}
test("independent DSH sources reject unknown proof before any caller getter", () => {
  const endpoint = createOwnedDefaultDispatchBusiness({ scope });
  let traps = 0;
  const fake = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error("forbidden");
      },
    },
  );
  assert.equal(typeof endpoint.dshSource, "object");
  assert.notEqual(endpoint.dshSource, endpoint.source);
  assert.notEqual(endpoint.dshSource, endpoint.preparationSource);
  assert.throws(() => endpoint.dshSource.resolve(fake, "read"));
  assert.throws(() => endpoint.dshBudgetSource.resolve(fake));
  assert.equal(traps, 0);
});
test("same original IPC session initializes actual floor8 and reads its authenticated original B domain", async (t) => {
  const f = await fixture(t),
    prepared = await f.request("prepare_dsh_owner");
  assert.equal(prepared.result?.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.family, "dsh");
  const reply = await f.request("read_dsh_domain", {
    data: { scope },
    budget: null,
  });
  assert.equal(reply.result?.ok, true, JSON.stringify(reply));
  assert.equal(reply.family, "dsh");
  assert.equal(reply.result.domain.ownerKind, "kswarm_dsh");
  assert.equal(reply.result.domain.writerSchemaVersion, 8);
  assert.deepEqual(reply.result.domain.scope, scope);
  assert.match(reply.result.domain.storeId, /\S/);
});
test("DSH route does not make original user operations or extra budget fields admissible", async (t) => {
  const f = await fixture(t),
    reply = await f.request("read_plan");
  assert.equal(reply.type, "fault");
  assert.equal(reply.error.message, "DISPATCH_BUSINESS_PROTOCOL_INVALID");
});

import { dshWorkModeIdentity } from "../src/core/dsh-owner-data.js";
import {
  controls,
  command,
  budget,
  thread,
} from "./fixtures/owned-dsh-business/data.js";
async function baseline(f) {
  assert.equal((await f.request("prepare_dsh_owner")).result.ok, true);
  const imported = [];
  for (const data of controls()) {
    const reply = await f.request("apply_dsh_control", { data, budget: null });
    assert.equal(reply.result?.ok, true, JSON.stringify(reply));
    imported.push(reply.result.control);
  }
  return imported;
}
test("actual original receiver imports full baseline, commits one dedicated work and reads B receipt/work/slot in one session", async (t) => {
  const f = await fixture(t),
    imported = await baseline(f),
    data = command(imported),
    input = { data, budget: budget(data) };
  const created = await f.request("apply_dsh_command", input);
  assert.equal(created.result?.ok, true, JSON.stringify(created));
  assert.deepEqual(created.result.receipt.consumedInputIds, ["input-1"]);
  const repeated = await f.request("apply_dsh_command", input);
  assert.deepEqual(repeated.result, created.result);
  const lookup = { scope, thread, bindingId: "binding", generation: 1 };
  const basis = await f.request("read_dsh_basis", {
    data: { ...lookup, operationKey: data.operationKey },
    budget: null,
  });
  assert.equal(basis.result?.ok, true, JSON.stringify(basis));
  assert.deepEqual(basis.result.basis.commandReceipt, created.result.receipt);
  assert.equal(basis.result.basis.workGuard.epoch, 1);
  const work = await f.request("read_dsh_work", {
    data: { ...lookup, ownerWorkId: created.result.receipt.ownerWorkId },
    budget: null,
  });
  assert.equal(work.result?.ok, true, JSON.stringify(work));
  const guard = work.result.work.guard,
    slotData = command(imported, {
      commandId: "slot",
      action: "prepare_draft",
      targetWorkId: created.result.receipt.ownerWorkId,
      expectedOwnerVersion: 1,
      inputSetRevision: 1,
      workGuard: {
        scopeKey: guard.scopeKey,
        epoch: guard.epoch,
        revision: guard.revision,
      },
    });
  const slot = await f.request("prepare_dsh_slot", {
    data: slotData,
    budget: budget(slotData),
  });
  assert.equal(slot.result?.ok, true, JSON.stringify(slot));
  const read = await f.request("read_dsh_slot", {
    data: {
      ...lookup,
      ownerWorkId: created.result.receipt.ownerWorkId,
      draftCommitKey: slot.result.slot.draftCommitKey,
    },
    budget: null,
  });
  assert.deepEqual(read.result.slot, slot.result.slot);
  const mode = {
    scope,
    thread,
    bindingId: "binding",
    generation: 1,
    ownerWorkId: created.result.receipt.ownerWorkId,
    targetMode: "off",
    targetEpoch: 2,
    expectedGuardRevision: 1,
    commandId: "work-off",
    authorityRef: "controlled-original-parent",
  };
  const off = await f.request("apply_dsh_control", {
    data: { ...mode, ...dshWorkModeIdentity(mode) },
    budget: null,
  });
  assert.equal(off.result?.ok, true, JSON.stringify(off));
  const closed = await f.request("read_dsh_work", {
    data: { ...lookup, ownerWorkId: created.result.receipt.ownerWorkId },
    budget: null,
  });
  assert.equal(closed.result.work.control.generationClosed, true);
  assert.equal(closed.result.work.guard.mode, "off");
  const stop = command(imported, {
    commandId: "stop-old-version",
    action: "request_stop",
    purpose: "control",
    targetWorkId: created.result.receipt.ownerWorkId,
    targetFenceEpoch: 1,
    expectedOwnerVersion: 1,
  });
  const stopped = await f.request("apply_dsh_command", {
    data: stop,
    budget: null,
  });
  assert.equal(stopped.result?.ok, true, JSON.stringify(stopped));
});
test("scope mismatch, budget on reads and malformed wrapper produce no authorized B operation", async (t) => {
  const f = await fixture(t);
  await f.request("prepare_dsh_owner");
  for (const input of [
    {
      data: { scope: { ...scope, workspaceId: "9".repeat(64) } },
      budget: null,
    },
    { data: { scope }, budget: {} },
    { data: { scope }, budget: null, extra: null },
  ]) {
    const reply = await f.request("read_dsh_domain", input);
    assert.equal(reply.result?.ok, false, JSON.stringify(reply));
    assert.equal(reply.result.notInvoked, true);
  }
  assert.equal(
    (await f.request("read_dsh_domain", { data: { scope }, budget: null }))
      .result.ok,
    true,
  );
});

for (const holdRaw of [false, true])
  test(
    "DSH original response " +
      (holdRaw ? "raw and callback" : "callback") +
      " remain physical roots after the parent sees a logical result",
    async (t) => {
      const f = await fixture(t, { holdCallback: true, holdRaw });
      assert.equal((await f.request("prepare_dsh_owner")).result.ok, true);
      const reply = await f.request("read_dsh_domain", {
        data: { scope },
        budget: null,
      });
      assert.equal(reply.result.ok, true);
      f.child.stdin.write("drain\n");
      await new Promise((yes) => setTimeout(yes, 30));
      assert.equal(
        f.messages.some((m) => m.protocol === "fixture_drained"),
        false,
      );
      f.child.stdin.write("release-callback\n");
      await new Promise((yes) => setTimeout(yes, 30));
      if (holdRaw) {
        assert.equal(
          f.messages.some((m) => m.protocol === "fixture_drained"),
          false,
        );
        f.child.stdin.write("release-raw\n");
      }
      const drained = await f.wait((m) => m.protocol === "fixture_drained");
      assert.equal(drained.ok, !holdRaw);
    },
  );

test("actual original Server index composes independent DSH constructor Sources before its original Hub", async (t) => {
  const f = await fixture(t, { server: true });
  const prepared = await f.request("prepare_dsh_owner");
  assert.equal(prepared.result?.ok, true, JSON.stringify(prepared));
  const domain = await f.request("read_dsh_domain", {
    data: { scope },
    budget: null,
  });
  assert.equal(domain.result?.ok, true, JSON.stringify(domain));
  assert.equal(domain.result.domain.writerSchemaVersion, 8);
  t.diagnostic(
    "The original Server child is fixture-owned; its SIGTERM cleanup does not attest whole-production drain.",
  );
});

import { join } from "node:path";
import { createInterface } from "node:readline";
import { createHub } from "../../../src/core/hub.js";
import { createOwnedDefaultDispatchBusiness } from "../../../src/server/owned-default-dispatch-business.js";
const scope = process.env.DSH_BUSINESS_SCOPE ? JSON.parse(process.env.DSH_BUSINESS_SCOPE) : { profileId: "a".repeat(64), workspaceId: "b".repeat(64) };
const endpoint = createOwnedDefaultDispatchBusiness({ scope });
const hub = createHub({
  silent: true,
  dataDir: {
    backend: "sqlite",
    filePath: join(process.env.DSH_BUSINESS_ROOT, "state.sqlite"),
  },
  defaultDispatchActionSource: endpoint.source,
  dshBusinessSource: endpoint.dshSource,
  dshBudgetSource: endpoint.dshBudgetSource,
});
let callback, releaseRaw;
const originalSend = process.send.bind(process);
if (process.env.DSH_HOLD_CALLBACK === "1" || process.env.DSH_HOLD_RAW === "1")
  process.send = function (frame, done) {
    const returned = originalSend(frame, (error) => {
      if (
        frame.op === "read_dsh_domain" &&
        frame.type === "response" &&
        process.env.DSH_HOLD_CALLBACK === "1"
      )
        callback = () => done?.(error);
      else done?.(error);
    });
    if (
      frame.op === "read_dsh_domain" &&
      frame.type === "response" &&
      process.env.DSH_HOLD_RAW === "1"
    )
      return new Promise((yes) => {
        releaseRaw = yes;
      });
    return returned;
  };
const controller = endpoint.install(hub);
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  if (line === "release-callback") callback?.();
  if (line === "release-raw") releaseRaw?.();
  if (line === "drain") {
    try {
      await controller.drain();
      originalSend({ protocol: "fixture_drained", ok: true });
    } catch (error) {
      originalSend({
        protocol: "fixture_drained",
        ok: false,
        error: error?.message,
      });
    }
  }
  if (line === "close") {
    let failed = false;
    try {
      await controller.drain();
    } catch {
      failed = true;
    }
    try {
      hub.closePersistence();
    } catch {
      failed = true;
    }
    lines.close();
    process.exit(failed ? 1 : 0);
  }
});
process.send({ protocol: "fixture_ready" });

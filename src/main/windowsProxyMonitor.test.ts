import assert from "node:assert/strict";
import test from "node:test";
import { WindowsProxyMonitor, type WindowsProxyHealth, type ProxyRecoveryCheckpoint } from "./windowsProxyMonitor";
import type { WindowsProxyOwnership } from "./systemProxyRecovery";

function fixture(checkpoint = { state: "available" as ProxyRecoveryCheckpoint }) {
  let ownership: WindowsProxyOwnership = "owned", key = "service-1", active = true;
  let writes = 0, failWrite = false;
  const states: WindowsProxyHealth[] = [], warnings: WindowsProxyHealth[] = [];
  const queued: (() => Promise<void>)[] = [];
  const monitor = new WindowsProxyMonitor({
    context: async () => {
      if (!active) return null;
      const captured = key;
      return { key, current: () => active && key === captured,
        read: async () => ownership,
        repair: async () => { writes++; if (failWrite) throw new Error("deadline"); ownership = "owned"; } };
    },
    enqueue: async op => { queued.push(op); },
    changed: state => states.push(state), warning: state => warnings.push(state), log: () => {},
    loadCheckpoint: () => checkpoint.state,
    saveCheckpoint: state => { checkpoint.state = state; },
  });
  return { monitor, states, warnings, queued,
    set ownership(v: WindowsProxyOwnership) { ownership = v; },
    set active(v: boolean) { active = v; },
    set key(v: string) { key = v; },
    set failWrite(v: boolean) { failWrite = v; },
    get writes() { return writes; },
    flush: async () => { while (queued.length) await queued.shift()!(); },
  };
}

test("local schedule confirms a disabled matching endpoint within two polls without network probes", async () => {
  const f = fixture();
  assert.equal(await f.monitor.poll(), 2000);
  f.ownership = "detached";
  assert.equal(await f.monitor.poll(), 1000);
  assert.equal(f.writes, 0);
  await f.monitor.poll();
  assert.equal(f.states.at(-1), "repairing");
  await f.flush();
  assert.equal(f.writes, 1);
  assert.equal(f.states.at(-1), "healthy");
});

test("queued writes do not block reads or duplicate repair; stop/TUN invalidate the queued action", async () => {
  const f = fixture(); f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll();
  await f.monitor.poll(); await f.monitor.poll();
  assert.equal(f.queued.length, 1);
  f.active = false;
  await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 0);
  assert.equal(f.states.at(-1), "inactive");
});

test("repair quota survives node changes, service transitions and stale samples", async () => {
  const f = fixture(); f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  // Changing node selection deliberately is not part of the local identity.
  f.active = false; await f.monitor.poll();
  f.active = true; f.key = "automatic-reload";
  f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 1);
  assert.equal(f.states.at(-1), "suspended");
  assert.deepEqual(f.warnings, ["suspended"]);
  f.monitor.newSession();
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 2);
});

test("foreign address/PAC is visible and warned once, never automatically reclaimed", async () => {
  const f = fixture(); f.ownership = "foreign";
  await f.monitor.poll(); await f.monitor.poll();
  assert.deepEqual(f.warnings, ["foreign"]);
  f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 0);
  assert.equal(f.states.at(-1), "suspended");
});

test("ownership change while repair waits cancels the write and preserves yielding", async () => {
  const f = fixture(); f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll();
  f.ownership = "foreign"; await f.flush();
  f.ownership = "detached"; await f.monitor.poll(); await f.monitor.poll();
  await f.flush(); assert.equal(f.writes, 0);
});

test("RPC timeout stays unknown and never repeats even if a late write succeeds", async () => {
  const f = fixture(); f.ownership = "detached"; f.failWrite = true;
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.states.at(-1), "unknown");
  f.ownership = "owned"; await f.monitor.poll();
  f.ownership = "detached"; await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 1);
  assert.equal(f.states.at(-1), "unknown");
});

test("confirmation cannot span a profile or service identity change", async () => {
  const f = fixture(); f.ownership = "detached";
  await f.monitor.poll(); f.key = "service-2"; await f.monitor.poll();
  assert.equal(f.queued.length, 0);
  await f.monitor.poll(); await f.flush(); assert.equal(f.writes, 1);
});

test("restarting only the application cannot replenish the persisted repair allowance", async () => {
  const checkpoint = { state: "available" as ProxyRecoveryCheckpoint };
  const first = fixture(checkpoint); first.ownership = "detached";
  await first.monitor.poll(); await first.monitor.poll(); await first.flush();
  assert.equal(checkpoint.state, "used");
  const second = fixture(checkpoint); second.ownership = "detached";
  await second.monitor.poll(); await second.monitor.poll(); await second.flush();
  assert.equal(second.writes, 0); assert.equal(second.states.at(-1), "suspended");
});

test("timed-out repair remains uncertain across application restart", async () => {
  const checkpoint = { state: "unknown" as ProxyRecoveryCheckpoint };
  const f = fixture(checkpoint); f.ownership = "detached";
  await f.monitor.poll(); await f.monitor.poll(); await f.flush();
  assert.equal(f.writes, 0); assert.equal(f.states.at(-1), "unknown");
});

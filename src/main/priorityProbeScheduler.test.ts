import assert from "node:assert/strict";
import test from "node:test";
import { PriorityProbeScheduler, type NodeSample } from "./priorityProbeScheduler";
import { PriorityFailover } from "./priorityFailover";

const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
test("slow backups never delay active-node failure confirmation; backup parallelism is bounded", async () => {
  let now = 0, activeCalls = 0, backupCalls = 0;
  const completions: ((value: boolean) => void)[] = [];
  const samples: NodeSample[] = [];
  const scheduler = new PriorityProbeScheduler({
    now: () => now,
    probe: async candidate => {
      if (candidate.tag === "active") { activeCalls++; return false; }
      backupCalls++;
      return new Promise<boolean>(resolve => completions.push(resolve));
    },
    sample: async sample => { samples.push(sample); }, activeDelay: () => 1000,
    backupInterval: () => 30000, round: () => {}, error: error => { throw error; },
  });
  const candidates = ["active", "slow1", "slow2", "slow3"].map((tag, port) => ({ tag, port }));
  for (now = 0; now <= 2000; now += 1000) {
    scheduler.tick("session", "active", candidates, () => true);
    await drain();
  }
  assert.equal(activeCalls, 3);
  assert.equal(backupCalls, 2);
  assert.deepEqual(samples.map(s => s.tag), ["active", "active", "active"]);
  completions.shift()!(false); await drain();
  assert.equal(backupCalls, 3);
  for (const complete of completions) complete(false);
  await drain();
});

test("late probe results after manual selection/stop never reach the policy", async () => {
  let valid = true;
  const complete: ((value: boolean) => void)[] = [], samples: NodeSample[] = [];
  const scheduler = new PriorityProbeScheduler({
    now: () => 0, probe: () => new Promise(resolve => complete.push(resolve)),
    sample: async sample => { samples.push(sample); }, activeDelay: () => 1000,
    backupInterval: () => 30000, round: () => assert.fail("stale round"), error: error => { throw error; },
  });
  scheduler.tick("a", "main", [{ tag: "main", port: 1 }, { tag: "backup", port: 2 }], () => valid);
  valid = false;
  for (const resolve of complete) resolve(true);
  await drain();
  assert.equal(samples.length, 0);
});

test("partial samples do not fabricate failures or extra success rounds on unsampled nodes", () => {
  const policy = new PriorityFailover(["main", "backup"]); policy.observeSelection("main");
  policy.record(new Map([["backup", true]]), 0);
  for (const now of [1000, 2000, 3000]) assert.equal(policy.record(new Map([["main", false]]), now), null);
  assert.equal(policy.record(new Map([["backup", true]]), 4000), "backup");
  assert.equal(policy.decide(100000), null); // old successes cannot authorize switching
});

test("late older success cannot overwrite a newer failed backup verification", () => {
  const policy = new PriorityFailover(["main", "backup"]); policy.observeSelection("main");
  for (const now of [0, 1000, 2000]) policy.record(new Map([["main", false], ["backup", true]]), now);
  policy.record(new Map([["backup", false]]), 4000, 3000);
  assert.equal(policy.record(new Map([["backup", true]]), 5000, 2500), null);
});

test("an unused failed backup does not accelerate the independent healthy active lane", () => {
  const policy = new PriorityFailover(["main", "backup"]); policy.observeSelection("main");
  policy.record(new Map([["backup", false]]), 0);
  const result = new Map([["main", true]]);
  policy.record(result, 1000);
  assert.equal(policy.nextProbeDelay("main", result), 30000);
});

test("single-node groups still produce complete all-down evidence", async () => {
  let now = 0;
  const rounds: Map<string, boolean>[] = [];
  const scheduler = new PriorityProbeScheduler({
    now: () => now,
    probe: async () => { now += 10; return false; },
    sample: async () => {}, activeDelay: () => 1000, backupInterval: () => 30000,
    round: (_at, _end, result) => rounds.push(result), error: error => { throw error; },
  });
  scheduler.tick("one", "only", [{ tag: "only", port: 1 }], () => true);
  await drain();
  assert.deepEqual([...rounds.at(-1)!], [["only", false]]);
});

test("a proven healthy backup can be chosen before unrelated slow probes finish", async () => {
  let now = 2000;
  const policy = new PriorityFailover(["main", "healthy", "slow"]); policy.observeSelection("main");
  policy.record(new Map([["healthy", true]]), 0);
  policy.record(new Map([["healthy", true]]), 1000);
  const chosen: string[] = [];
  let finishSlow!: (value: boolean) => void;
  const scheduler = new PriorityProbeScheduler({
    now: () => now,
    probe: async c => c.tag === "slow" ? new Promise<boolean>(r => { finishSlow = r; }) : c.tag === "healthy",
    sample: async sample => {
      const next = policy.record(new Map([[sample.tag, sample.reachable]]), now, sample.at);
      if (next) chosen.push(next);
    },
    activeDelay: ok => policy.nextProbeDelay("main", new Map([["main", ok]])),
    backupInterval: () => 30000, round: () => {}, error: error => { throw error; },
  });
  const candidates = ["main", "healthy", "slow"].map((tag, port) => ({ tag, port }));
  for (now = 2000; now <= 4000; now += 1000) {
    scheduler.tick("session", "main", candidates, () => true); await drain();
  }
  assert.ok(chosen.includes("healthy"));
  assert.equal(scheduler.busy, true); // slow backup has not completed
  finishSlow(false); await drain();
});

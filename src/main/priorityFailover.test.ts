import test from "node:test";
import assert from "node:assert/strict";
import { PriorityFailover, priorityGroups, priorityTags, addProbeRoutes, allocateProbePorts } from "./priorityFailover";
import { redactCoreMessage, CoreLogArchive } from "./coreLogArchive";
import { HealthLog } from "./healthLog";
import { parsePrioritySettings, loadPrioritySettings, prioritySettingsSnapshot, savePrioritySettings } from "./prioritySettings";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tags = ["DMIT-4", "DMIT-6", "VMISS-4", "MoeCloud-4"];
const sample = (...good: string[]) => new Map(tags.map(t => [t, good.includes(t)]));
test("entry discovery excludes business, aggregate, direct, mixed and malformed groups by structure", () => {
  const config = { outbounds: [
    { tag: "Renamed Proxy Pool", type: "selector", outbounds: ["one", "two"] },
    { tag: "Single Proxy", type: "selector", outbounds: ["two"] },
    { tag: "one", type: "vless" }, { tag: "two", type: "shadowsocks" },
    { tag: "DIRECT", type: "direct" }, { tag: "deny", type: "block" },
    { tag: "auto", type: "urltest", outbounds: ["one"] },
    { tag: "dns", type: "dns" }, { tag: "broken" },
    ...["Renamed Proxy Pool", "DIRECT", "deny", "auto", "dns", "missing", "broken"].map((tag, i) =>
      ({ tag: `Excluded ${i}`, type: "selector", outbounds: ["one", tag] })),
    { tag: "empty", type: "selector", outbounds: [] },
    { tag: "invalid", type: "selector", outbounds: [42] },
  ] };
  const content = JSON.stringify(config);
  assert.deepEqual(priorityGroups(content), [
    { tag: "Renamed Proxy Pool", nodes: ["one", "two"] },
    { tag: "Single Proxy", nodes: ["two"] },
  ]);
  assert.deepEqual(priorityTags(content), []); // no hardcoded initial selection
  for (let i = 0; i < 7; i++) {
    const settings = parsePrioritySettings({ group: `Excluded ${i}`, order: ["one"] });
    assert.deepEqual(priorityTags(content, settings), []);
    assert.deepEqual(addProbeRoutes(content, [], settings).candidates, []);
  }
  config.outbounds[0].tag = "Another Name";
  assert.equal(priorityGroups(JSON.stringify(config))[0].tag, "Another Name");
});

test("ordered failure switching needs three bad rounds and a proven backup", () => {
  const p = new PriorityFailover(tags); p.observeSelection(tags[0]);
  assert.equal(p.record(sample(tags[2], tags[3]), 0), null);
  assert.equal(p.nextProbeDelay(tags[0], sample(tags[2], tags[3])), 1000);
  assert.equal(p.record(sample(tags[2], tags[3]), 10000), null);
  assert.equal(p.nextProbeDelay(tags[0], sample(tags[2], tags[3])), 1000);
  assert.equal(p.record(sample(tags[2], tags[3]), 20000), tags[2]);
  assert.equal(p.nextProbeDelay(tags[0], sample(tags[2], tags[3])), 10000);
  p.switched(tags[2], 20000);
  assert.equal(p.record(sample(tags[3]), 30000), null);
  assert.equal(p.record(sample(tags[3]), 40000), null);
  assert.equal(p.record(sample(tags[3]), 50000), tags[3]);
});
test("confirmation burst resets on recovery and backs off if every backup stays down", () => {
  const p = new PriorityFailover(tags); p.observeSelection(tags[0]);
  const down = sample();
  assert.equal(p.record(down, 0), null);
  assert.equal(p.nextProbeDelay(tags[0], down), 1000);
  assert.equal(p.record(sample(tags[0]), 1000), null);
  assert.equal(p.nextProbeDelay(tags[0], sample(tags[0])), 10000);
  assert.equal(p.record(down, 11000), null);
  assert.equal(p.nextProbeDelay(tags[0], down), 1000);
  assert.equal(p.record(down, 12000), null);
  assert.equal(p.nextProbeDelay(tags[0], down), 1000);
  assert.equal(p.record(down, 13000), null);
  assert.equal(p.nextProbeDelay(tags[0], down), 10000);
  assert.equal(p.record(sample(...tags), 23000), null);
  assert.equal(p.nextProbeDelay(tags[0], sample(...tags)), 30000);
});
test("recovery requires 120 seconds of continuous good rounds, not lowest latency", () => {
  const p = new PriorityFailover(tags); p.observeSelection(tags[2]);
  for (const now of [0, 30000, 60000, 90000]) assert.equal(p.record(sample(...tags), now), null);
  assert.equal(p.record(sample(...tags), 120000), tags[0]);
});
test("a recovery failure resets the stable window; all-down never selects DIRECT", () => {
  const p = new PriorityFailover(tags); p.observeSelection(tags[2]);
  p.record(sample(...tags), 0); p.record(sample(...tags), 60000);
  assert.equal(p.record(sample(tags[2]), 90000), null);
  assert.equal(p.record(sample(...tags), 120000), null);
  assert.equal(p.record(sample(...tags), 180000), null);
  assert.equal(p.record(sample(...tags), 240000), tags[0]);
  for (let i = 0; i < 10; i++) assert.equal(p.record(sample(), 300000 + i * 10000), null);
});
test("manual selection pauses automatic switches including failback", () => {
  const p = new PriorityFailover(tags); p.observeSelection(tags[0]); p.observeSelection(tags[3]);
  for (const now of [0, 60000, 120000, 180000]) assert.equal(p.record(sample(...tags), now), null);
  assert.equal(p.paused, true);
  assert.equal(p.nextProbeDelay(tags[3], sample()), 10000);
});
test("automatic selection is not misclassified as manual", () => {
  const p = new PriorityFailover(tags); p.observeSelection(tags[0]); p.switched(tags[2], 0); p.observeSelection(tags[2]);
  assert.equal(p.paused, false);
});
test("sleep gaps do not count toward stable recovery", () => {
  const p = new PriorityFailover(tags); p.observeSelection(tags[2]);
  p.record(sample(...tags), 0); p.record(sample(...tags), 30000);
  assert.equal(p.record(sample(...tags), 1_000_000), null);
  assert.equal(p.record(sample(...tags), 1_030_000), null);
  assert.equal(p.record(sample(...tags), 1_120_000), tags[0]);
});
test("declared concrete members follow configuration order, not provider names", async () => {
  const cfg = { inbounds: [], route: { rules: [{ clash_mode: "Global", outbound: "US-West Entry" }] }, outbounds: [
    { tag: "US-West Entry", type: "selector", outbounds: [tags[3], tags[2], tags[0], tags[1]] },
    ...tags.map(tag => ({ tag, type: "vless", server: "example.invalid", uuid: "unchanged" })), { tag: "DIRECT", type: "direct" }] };
  const content = JSON.stringify(cfg); const order = [tags[3], tags[2], tags[0], tags[1]];
  const settings = parsePrioritySettings({ group: "US-West Entry" });
  assert.deepEqual(priorityTags(content, settings), order);
  const ports = await allocateProbePorts(tags.length); assert.equal(new Set(ports).size, tags.length);
  const runtime = JSON.parse(addProbeRoutes(content, ports, settings).content);
  assert.deepEqual(runtime.outbounds, cfg.outbounds);
  assert.ok(runtime.inbounds.every((i: any) => i.listen === "127.0.0.1"));
  assert.deepEqual(runtime.route.rules.slice(0, tags.length).map((r: any) => r.outbound), order);
  assert.deepEqual(runtime.route.rules.at(-1), cfg.route.rules[0]);
  assert.equal(addProbeRoutes('{"outbounds":[]}', []).content, '{"outbounds":[]}');
});
test("arbitrary group and node names, explicit order, disable and invalid membership", () => {
  const content = JSON.stringify({outbounds:[{tag:'My Entry',type:'selector',outbounds:['New Vendor','Other']},
    {tag:'New Vendor',type:'vless'},{tag:'Other',type:'shadowsocks'},{tag:'DIRECT',type:'direct'}]});
  const settings=parsePrioritySettings({group:'My Entry'});
  assert.deepEqual(priorityTags(content,settings),['New Vendor','Other']);
  const explicit=parsePrioritySettings({group:'My Entry',order:['Other','New Vendor']});
  assert.deepEqual(priorityTags(content,explicit),['Other','New Vendor']);
  assert.deepEqual(JSON.parse(addProbeRoutes(content,[51001,51002],explicit).content).route.rules.map((r:any)=>r.outbound),['Other','New Vendor']);
  assert.deepEqual(priorityTags(content,parsePrioritySettings({enabled:false})),[]);
  for(const order of [['Unknown'],['DIRECT']]) assert.throws(()=>priorityTags(content,parsePrioritySettings({group:'My Entry',order})));
});
test("configured thresholds control both failure and recovery decisions", () => {
  const settings=parsePrioritySettings({failureRounds:1,backupSuccessRounds:1,recoverySuccessRounds:2,recoveryStableMs:10000,failbackCooldownMs:10000});
  const p=new PriorityFailover(tags,settings); p.observeSelection(tags[0]);
  assert.equal(p.record(sample(tags[2]),0),tags[2]);
  assert.equal(p.nextProbeDelay(tags[0],sample(tags[2])),settings.failureIntervalMs);
  p.switched(tags[2],0);
  assert.equal(p.record(sample(...tags),10000),null);
  assert.equal(p.record(sample(...tags),20000),tags[0]);
});
test("configured long failure intervals do not erase consecutive failure evidence", () => {
  const settings=parsePrioritySettings({failureIntervalMs:300000,failureRounds:2});
  const p=new PriorityFailover(tags,settings); p.observeSelection(tags[0]);
  assert.equal(p.record(sample(tags[2]),0),null);
  assert.equal(p.record(sample(tags[2]),300000),tags[2]);
});
test("settings validate types, bounds, duplicate tags and typo fields", () => {
  for(const value of [null,[],{enabled:'true'},{group:' '},{order:['a','a']},{failureRounds:0},
    {backupSuccessRounds:21},{recoveryStableMs:1},{failbackCooldownMs:Infinity},{failureRound:3},
    {probeTimeoutMs:0},{healthyIntervalMs:1000},{failureIntervalMs:600001}]) {
    assert.throws(()=>parsePrioritySettings(value));
  }
});
test("first run creates editable settings and subsequent loads never overwrite them", async () => {
  const dir=await mkdtemp(join(tmpdir(),'mxh-settings-test-'));
  try {
    const path=join(dir,'priority-failover.json');
    const first=await loadPrioritySettings(path); assert.deepEqual(first.order,[]); assert.equal(first.group,'');
    const {writeFile}=await import('node:fs/promises');
    await writeFile(path,JSON.stringify({group:'Custom Group',enabled:false}));
    assert.equal((await loadPrioritySettings(path)).group,'Custom Group');
    assert.equal((await loadPrioritySettings(path)).enabled,false);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test("log rotation retains bounded generations and survives re-instantiation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-log-test-"));
  try {
    const path = join(dir, "core.log"); const writer = new HealthLog(path, 100, 3);
    for (let i = 0; i < 20; i++) await writer.write("test", { marker: i });
    await writer.flush(); assert.equal((await readdir(dir)).length, 4);
    const next = new HealthLog(path, 100, 3); await next.write("reopened");
    assert.match(await readFile(path, "utf8"), /reopened/);
    const archive = new CoreLogArchive(join(dir, "archive.log"));
    await archive.write(3, "token=not-for-output"); await archive.event("source-buffer-reset"); await archive.flush();
    const text = await readFile(join(dir, "archive.log"), "utf8");
    assert.ok(!text.includes("not-for-output")); assert.match(text, /source-buffer-reset/); assert.match(text, /core/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("credential-shaped fields are redacted but timeout diagnostics remain", () => {
  const text = redactCoreMessage("DMIT timeout password=abc token=def uuid=xyz https://u:p@example.invalid/?token=ghi");
  for (const secret of ["abc", "def", "xyz", "ghi", "u:p"]) assert.ok(!text.includes(secret));
  assert.match(text, /DMIT timeout/);
});
test("GUI saves atomically and refuses stale or invalid writes", async () => {
  const dir=await mkdtemp(join(tmpdir(),'mxh-gui-settings-'));
  try {
    const path=join(dir,'priority-failover.json');const first=await prioritySettingsSnapshot(path);
    await savePrioritySettings(path,{...first.settings,group:'Another Entry'},first.revision);
    const second=await prioritySettingsSnapshot(path);assert.equal(second.settings.group,'Another Entry');assert.notEqual(second.revision,first.revision);
    await assert.rejects(savePrioritySettings(path,first.settings,first.revision),/其他位置修改/);
    await assert.rejects(savePrioritySettings(path,{...second.settings,failureRounds:0},second.revision));
    assert.deepEqual(await prioritySettingsSnapshot(path),second);
    const results=await Promise.allSettled([savePrioritySettings(path,{...second.settings,failureRounds:4},second.revision),savePrioritySettings(path,{...second.settings,failureRounds:5},second.revision)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.deepEqual(await readdir(dir),['priority-failover.json']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

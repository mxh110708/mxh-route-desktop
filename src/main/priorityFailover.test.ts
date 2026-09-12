import test from "node:test";
import assert from "node:assert/strict";
import { PriorityFailover, priorityTags, addProbeRoutes, allocateProbePorts } from "./priorityFailover";
import { redactCoreMessage, CoreLogArchive } from "./coreLogArchive";
import { HealthLog } from "./healthLog";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tags = ["DMIT-4", "DMIT-6", "VMISS-4", "MoeCloud-4"];
const sample = (...good: string[]) => new Map(tags.map(t => [t, good.includes(t)]));
test("ordered failure switching needs three bad rounds and a proven backup", () => {
  const p = new PriorityFailover(tags); p.observeSelection(tags[0]);
  assert.equal(p.record(sample(tags[2], tags[3]), 0), null);
  assert.equal(p.record(sample(tags[2], tags[3]), 10000), null);
  assert.equal(p.record(sample(tags[2], tags[3]), 20000), tags[2]);
  p.switched(tags[2], 20000);
  assert.equal(p.record(sample(tags[3]), 30000), null);
  assert.equal(p.record(sample(tags[3]), 40000), null);
  assert.equal(p.record(sample(tags[3]), 50000), tags[3]);
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
test("only declared direct node members are probed, in provider order", async () => {
  const cfg = { inbounds: [], route: { rules: [{ clash_mode: "Global", outbound: "US-West Entry" }] }, outbounds: [
    { tag: "US-West Entry", type: "selector", outbounds: [tags[3], "DIRECT", tags[2], tags[0], tags[1]] },
    ...tags.map(tag => ({ tag, type: "vless", server: "example.invalid", uuid: "unchanged" })), { tag: "DIRECT", type: "direct" }] };
  const content = JSON.stringify(cfg); assert.deepEqual(priorityTags(content), tags);
  const ports = await allocateProbePorts(tags.length); assert.equal(new Set(ports).size, tags.length);
  const runtime = JSON.parse(addProbeRoutes(content, ports).content);
  assert.deepEqual(runtime.outbounds, cfg.outbounds);
  assert.ok(runtime.inbounds.every((i: any) => i.listen === "127.0.0.1"));
  assert.deepEqual(runtime.route.rules.slice(0, tags.length).map((r: any) => r.outbound), tags);
  assert.deepEqual(runtime.route.rules.at(-1), cfg.route.rules[0]);
  assert.equal(addProbeRoutes('{"outbounds":[]}', []).content, '{"outbounds":[]}');
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

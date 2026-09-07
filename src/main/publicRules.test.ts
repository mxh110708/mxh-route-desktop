import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicRuleCache, portablePublicRules, PUBLIC_RULE_BUNDLE_URL, PUBLIC_RULE_BUNDLE_SHA256 } from "./publicRules";
const rule = { type: "remote", tag: "geosite-cn", format: "binary", url: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/cn.srs", initial_path: "F:/private/old.srs", update_interval: "1d" };
const profile = JSON.stringify({ outbounds: [{ tag: "private", password: "never-send-this" }], route: { rule_set: [rule] } });
const bundle = await readFile(new URL("../../resources/public-rules-v1.json", import.meta.url));
test("portable export strips only known public rule paths", () => {
  const value = JSON.parse(portablePublicRules(profile));
  assert.equal(value.route.rule_set[0].initial_path, undefined);
  assert.equal(value.outbounds[0].password, "never-send-this");
  const custom = JSON.stringify({ route: { rule_set: [{ ...rule, url: "https://example.org/private.srs" }] } });
  assert.equal(portablePublicRules(custom), custom);
  assert.equal(portablePublicRules("not json"), "not json");
});
test("download, verify, cache, offline startup, repair and concurrency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-rules-")); let calls = 0;
  const request = (async (url: unknown, options: RequestInit) => {
    calls++; assert.equal(url, PUBLIC_RULE_BUNDLE_URL); assert.equal(options.body, undefined);
    return new Response(bundle);
  }) as typeof fetch;
  try {
    const cache = new PublicRuleCache(dir, request);
    const [a, b] = await Promise.all([cache.prepare(profile), cache.prepare(profile)]);
    assert.equal(calls, 1); assert.equal(a, b);
    const value = JSON.parse(a); const path = value.route.rule_set[0].initial_path;
    assert.ok(path.startsWith(dir)); assert.ok(path.includes(PUBLIC_RULE_BUNDLE_SHA256));
    assert.equal(value.route.rule_set[0].update_interval, "1d");
    assert.deepEqual(value.outbounds, JSON.parse(profile).outbounds);
    const offline = new PublicRuleCache(dir, (async () => { throw Error("offline"); }) as typeof fetch);
    assert.equal(await offline.prepare(profile), a);
    await writeFile(path, "corrupted"); await offline.prepare(profile);
    assert.equal((await readFile(path)).subarray(0, 3).toString(), "SRS");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("tampered bundle and offline first import fail closed without credential leakage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-rules-"));
  try {
    for (const request of [(async () => new Response("untrusted")), (async () => { throw Error("offline"); })]) {
      await assert.rejects(new PublicRuleCache(dir, request as typeof fetch).prepare(profile), /没有有效缓存/u);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("unrecognized rules never trigger downloads", async () => {
  const cache = new PublicRuleCache("unused", (async () => { throw Error("must not fetch"); }) as typeof fetch);
  assert.equal(await cache.prepare("{}"), "{}");
  const content = JSON.stringify({ route: { rule_set: [{ ...rule, url: "https://untrusted.invalid/x.srs" }] } });
  assert.equal(await cache.prepare(content), content);
});

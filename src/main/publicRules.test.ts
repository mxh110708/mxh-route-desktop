import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicRuleCache, portablePublicRules, PUBLIC_RULE_BUNDLE_FILE, PUBLIC_RULE_NAMES, PUBLIC_RULE_BUNDLE_URL, PUBLIC_RULE_BUNDLE_SHA256, validatePublicRuleBundle } from "./publicRules";
const rule = { type: "remote", tag: "geosite-cn", format: "binary", url: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/cn.srs", initial_path: "F:/private/old.srs", update_interval: "1d" };
const profile = JSON.stringify({ outbounds: [{ tag: "private", password: "never-send-this" }], route: { rule_set: [rule] } });
const bundle = await readFile(new URL("../../resources/public-rules-v1.json", import.meta.url));
const bundledPath = new URL("../../resources/public-rules-v1.json", import.meta.url);
const offlineRequest = (async () => { throw Error("offline"); }) as typeof fetch;
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
test("without an installed seed, tampered downloads and offline first imports fail closed", async () => {
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

test("empty cache and blocked network allow concurrent first imports from the bundled seed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-rules-"));
  let calls = 0;
  const request = (async () => { calls++; throw Error("network must not be used"); }) as typeof fetch;
  try {
    const seed = join(dir, "installed", PUBLIC_RULE_BUNDLE_FILE);
    await mkdir(join(dir, "installed"));
    await writeFile(seed, bundle);
    const cacheDirectory = join(dir, "user-data", "public-rule-cache");
    const cache = new PublicRuleCache(cacheDirectory, request, seed);
    const [a, b] = await Promise.all([cache.prepare(profile), cache.prepare(profile)]);
    assert.equal(a, b);
    assert.equal(calls, 0);
    const value = JSON.parse(a);
    const srsPath = join(cacheDirectory, PUBLIC_RULE_BUNDLE_SHA256, "geosite-cn.srs");
    assert.equal(value.route.rule_set[0].initial_path, srsPath);
    assert.equal((await readFile(srsPath)).subarray(0, 3).toString(), "SRS");
    assert.deepEqual(await readFile(join(cacheDirectory, PUBLIC_RULE_BUNDLE_SHA256, "bundle.json")), bundle);
    assert.deepEqual(await readFile(seed), bundle);
    assert.deepEqual(value.outbounds, JSON.parse(profile).outbounds);
    assert.equal(value.route.rule_set[0].url, rule.url);
    assert.equal(value.route.rule_set[0].update_interval, "1d");
    assert.equal(JSON.parse(portablePublicRules(a)).route.rule_set[0].initial_path, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a verified cache remains usable even when the installed bundle is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-rules-"));
  try {
    const seed = join(dir, PUBLIC_RULE_BUNDLE_FILE);
    await writeFile(seed, bundle);
    const cacheDirectory = join(dir, "cache");
    const prepared = await new PublicRuleCache(cacheDirectory, offlineRequest, seed).prepare(profile);
    await rm(seed);
    assert.equal(await new PublicRuleCache(cacheDirectory, offlineRequest, seed).prepare(profile), prepared);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("clearing all cached rules can be recovered offline from the read-only bundled seed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-rules-"));
  try {
    const seed = join(dir, PUBLIC_RULE_BUNDLE_FILE);
    await writeFile(seed, bundle);
    const cacheDirectory = join(dir, "cache");
    const cache = new PublicRuleCache(cacheDirectory, offlineRequest, seed);
    const prepared = await cache.prepare(profile);
    await rm(cacheDirectory, { recursive: true });
    assert.equal(await cache.prepare(profile), prepared);
    assert.deepEqual(await readFile(seed), bundle);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("damaged cached bundle and SRS files are rebuilt from the verified installed bundle offline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-rules-"));
  try {
    const seed = join(dir, PUBLIC_RULE_BUNDLE_FILE);
    await writeFile(seed, bundle);
    const cache = new PublicRuleCache(join(dir, "cache"), offlineRequest, seed);
    const prepared = await cache.prepare(profile);
    const path = JSON.parse(prepared).route.rule_set[0].initial_path;
    const expected = await readFile(path);
    const cacheBundle = join(dir, "cache", PUBLIC_RULE_BUNDLE_SHA256, "bundle.json");
    await writeFile(cacheBundle, "corrupted");
    await writeFile(path, "corrupted");
    assert.equal(await cache.prepare(profile), prepared);
    assert.deepEqual(await readFile(path), expected);
    assert.deepEqual(await readFile(cacheBundle), bundle);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing or tampered installed bundles fall back only to the fixed verified public download", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-rules-"));
  let calls = 0;
  const request = (async (url: unknown, options: RequestInit) => {
    calls++;
    assert.equal(url, PUBLIC_RULE_BUNDLE_URL);
    assert.equal(options.body, undefined);
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, "error");
    return new Response(bundle);
  }) as typeof fetch;
  try {
    const seed = join(dir, PUBLIC_RULE_BUNDLE_FILE);
    await new PublicRuleCache(join(dir, "missing"), request, seed).prepare(profile);
    await writeFile(seed, "SRS untrusted");
    const prepared = await new PublicRuleCache(join(dir, "tampered"), request, seed).prepare(profile);
    assert.equal((await readFile(JSON.parse(prepared).route.rule_set[0].initial_path)).subarray(0, 3).toString(), "SRS");
    assert.equal(calls, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid cache, seed and download fail closed without profile or credential leakage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-rules-"));
  try {
    const seed = join(dir, PUBLIC_RULE_BUNDLE_FILE);
    await writeFile(seed, "untrusted");
    const cacheDirectory = join(dir, "cache");
    const cacheBundleDirectory = join(cacheDirectory, PUBLIC_RULE_BUNDLE_SHA256);
    await mkdir(cacheBundleDirectory, { recursive: true });
    await writeFile(join(cacheBundleDirectory, "bundle.json"), "untrusted");
    for (const request of [offlineRequest, (async () => new Response("untrusted")) as typeof fetch]) {
      await assert.rejects(new PublicRuleCache(cacheDirectory, request, seed).prepare(profile), (error: Error) => {
        assert.match(error.message, /重新安装完整的 MXH Route/u);
        assert.doesNotMatch(error.message, /never-send-this|private\/old|geosite\/cn/u);
        return true;
      });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed import does not poison later offline retries after the seed is repaired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-rules-"));
  try {
    const seed = join(dir, PUBLIC_RULE_BUNDLE_FILE);
    const cache = new PublicRuleCache(join(dir, "cache"), offlineRequest, seed);
    await assert.rejects(cache.prepare(profile));
    await writeFile(seed, bundle);
    assert.equal((await readFile(JSON.parse(await cache.prepare(profile)).route.rule_set[0].initial_path)).subarray(0, 3).toString(), "SRS");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("all five known rules bootstrap offline without changing custom rules or remote update settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-rules-"));
  try {
    const rules = PUBLIC_RULE_NAMES.map((name) => {
      const geo = name.startsWith("geoip-") ? "geoip" : "geosite";
      const leaf = name.replace(/^geo(?:site|ip)-/u, "").replace("geolocation-not-cn", "geolocation-!cn");
      return { ...rule, tag: name, url: `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/${geo}/${leaf}.srs`, download_detour: "private-entry" };
    });
    const custom = { ...rule, tag: "custom", url: "https://untrusted.invalid/custom.srs", initial_path: "custom.srs" };
    const content = `// Local private JSONC\n${JSON.stringify({ route: { rule_set: [...rules, custom] } })}`;
    const prepared = JSON.parse(await new PublicRuleCache(dir, offlineRequest, fileURLToPath(bundledPath)).prepare(content));
    for (let index = 0; index < rules.length; index++) {
      const { initial_path: path, ...remaining } = prepared.route.rule_set[index];
      const { initial_path: _oldPath, ...original } = rules[index];
      assert.deepEqual(remaining, original);
      assert.equal((await readFile(path)).subarray(0, 3).toString(), "SRS");
    }
    assert.deepEqual(prepared.route.rule_set[5], custom);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("installer resource, runtime path and packaging preflight include the pinned bundle", async () => {
  validatePublicRuleBundle(bundle);
  assert.throws(() => validatePublicRuleBundle(Buffer.from("untrusted")), /校验失败/u);
  const builder = await readFile(new URL("../../electron-builder.yml", import.meta.url), "utf8");
  assert.match(builder, /extraResources:[\s\S]*?from: resources\/public-rules-v1\.json\s+to: public-rules-v1\.json/u);
  assert.match(await readFile(new URL("../../electron-builder.custom.yml", import.meta.url), "utf8"), /extends: electron-builder\.yml/u);
  assert.match(await readFile(new URL("./profiles.ts", import.meta.url), "utf8"), /resourcePath\(PUBLIC_RULE_BUNDLE_FILE\)/u);
  assert.match(await readFile(new URL("../../scripts/package.ts", import.meta.url), "utf8"), /validatePublicRuleBundle\(fs\.readFileSync/u);
});

test("afterPack rejects missing or altered bootstrap resources before signing", async () => {
  const { afterPack } = createRequire(import.meta.url)("../../scripts/afterPack.cjs");
  const dir = await mkdtemp(join(tmpdir(), "mxh-rules-package-"));
  let signed = 0;
  try {
    const resources = join(dir, "app", "resources");
    await mkdir(resources, { recursive: true });
    await mkdir(join(dir, "resources"));
    await writeFile(join(dir, "resources", PUBLIC_RULE_BUNDLE_FILE), bundle);
    const context = {
      electronPlatformName: "win32",
      appOutDir: join(dir, "app"),
      packager: { projectDir: dir, getResourcesDir: () => resources, signIf: async () => { signed++; return true; } },
    };
    await assert.rejects(afterPack(context), /ENOENT/u);
    await writeFile(join(resources, PUBLIC_RULE_BUNDLE_FILE), "untrusted");
    await assert.rejects(afterPack(context), /differs from the verified source/u);
    assert.equal(signed, 0);
    await writeFile(join(resources, PUBLIC_RULE_BUNDLE_FILE), bundle);
    await afterPack(context);
    assert.equal(signed, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

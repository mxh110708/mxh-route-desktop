import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { assertProxyPortsAvailable, carryProxyPortPriorityPreference, commitProxyPortChange, parseProxyPorts, prepareProxyPortConfig, readProxyPorts } from "./proxyPorts";
import { buildRuntimeConfig, readSystemProxyEndpoint } from "./runtimeConfig";

const original = JSON.stringify({
  inbounds: [
    { type: "mixed", tag: "local", listen: "127.0.0.1", listen_port: 2080, users: [{ username: "fixture", password: "fixture-only" }] },
    { type: "tun", tag: "tun", auto_route: true, strict_route: true },
  ],
  outbounds: [{ type: "direct", tag: "DIRECT" }],
  route: { final: "DIRECT", rules: [{ inbound: ["local"], outbound: "DIRECT" }] },
});
const ports = { mixed: { enabled: true as const, port: 22080 }, socks: { enabled: true, port: 22081 }, http: { enabled: true, port: 22082 } };

test("initial values follow the profile and missing optional ports are suggested without collisions", () => {
  const source = JSON.stringify({ inbounds: [{ type: "mixed", listen_port: 65535 }, { type: "direct", listen_port: 1 }] });
  assert.deepEqual(readProxyPorts(source), {
    mixed: { enabled: true, port: 65535 }, socks: { enabled: false, port: 2 }, http: { enabled: false, port: 3 },
  });
});

test("invalid and conflicting enabled ports cannot be saved", () => {
  for (const value of [0, 65536, 1.5, NaN, "7897"]) {
    assert.throws(() => parseProxyPorts({ ...ports, mixed: { enabled: true, port: value } }));
  }
  assert.throws(() => parseProxyPorts({ ...ports, mixed: { enabled: false, port: 22080 } }));
  assert.throws(() => parseProxyPorts({ ...ports, http: { enabled: true, port: 22080 } }));
  assert.doesNotThrow(() => parseProxyPorts({ ...ports, http: { enabled: false, port: 22080 } }));
});

test("port edits preserve authentication, existing tags, inbound order, routing and outbounds", () => {
  const source = `// retained comment\n${original}`;
  const result = prepareProxyPortConfig(source, ports);
  assert.ok(result.startsWith("// retained comment"));
  const decoded = JSON.parse(result.slice(result.indexOf("{")));
  const previous = JSON.parse(original);
  assert.deepEqual(decoded.inbounds[0], { ...previous.inbounds[0], listen_port: 22080 });
  assert.deepEqual(decoded.inbounds[1], previous.inbounds[1]);
  assert.deepEqual(decoded.outbounds, previous.outbounds);
  assert.deepEqual(decoded.route, previous.route);
  assert.equal(decoded.inbounds[2].listen, "127.0.0.1");
  assert.equal(decoded.inbounds[3].listen, "127.0.0.1");
  assert.deepEqual(readSystemProxyEndpoint(result), { server: "127.0.0.1", port: 22080 });
  const runtime = JSON.parse(buildRuntimeConfig(result, "system-proxy"));
  assert.equal(runtime.inbounds.find((item: { type: string }) => item.type === "tun").platform.http_proxy.server_port, 22080);
});

test("optional listeners can be disabled and new listener tags do not collide", () => {
  const source = JSON.stringify({ inbounds: [
    { type: "tun", tag: "desktop-mixed-in" },
    { type: "socks", tag: "old-socks", listen_port: 2000 },
    { type: "http", tag: "old-http", listen_port: 2001 },
  ] });
  const result = JSON.parse(prepareProxyPortConfig(source, { ...ports, socks: { enabled: false, port: 22081 } }));
  assert.deepEqual(result.inbounds.map((item: { type: string }) => item.type), ["tun", "http", "mixed"]);
  assert.equal(result.inbounds[2].tag, "desktop-mixed-in-2");
  assert.equal(result.inbounds[1].tag, "old-http");
});

test("advanced duplicate listeners and clashes with other inbound types are not silently rewritten", () => {
  assert.throws(() => prepareProxyPortConfig(JSON.stringify({ inbounds: [
    { type: "mixed", listen_port: 2000 }, { type: "mixed", listen_port: 2001 },
  ] }), ports), /多个 mixed/);
  assert.throws(() => prepareProxyPortConfig(JSON.stringify({ inbounds: [
    { type: "direct", listen: "0.0.0.0", listen_port: 22080 },
  ] }), ports), /其他入站冲突/);
});

test("an occupied TCP port is rejected before writes while an existing active listener can be reused", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const content = JSON.stringify({ inbounds: [{ type: "mixed", listen: "127.0.0.1", listen_port: address.port }] });
  try {
    await assert.rejects(assertProxyPortsAvailable("{}", content, false), /占用/);
    await assert.doesNotReject(assertProxyPortsAvailable(content, content, true));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("failed reload restores configuration before restarting the previous listener", async () => {
  let disk = original;
  const calls: string[] = [];
  await assert.rejects(commitProxyPortChange(original, "new-config", {
    current: () => true,
    write: async (content) => { disk = content; calls.push(content === original ? "restore" : "write"); },
    apply: async (content, rollback) => {
      assert.equal(disk, content);
      calls.push(rollback ? "restart-old" : "restart-new");
      if (!rollback) throw new Error("new listener failed");
    },
  }), /new listener failed/);
  assert.equal(disk, original);
  assert.deepEqual(calls, ["write", "restart-new", "restore", "restart-old"]);
});

test("cancellation after a write restores the file without overriding a newer stop or profile selection", async () => {
  let current = true;
  let disk = original;
  let reloads = 0;
  await assert.rejects(commitProxyPortChange(original, "new-config", {
    current: () => current,
    write: async (content) => { disk = content; current = false; },
    apply: async () => { reloads++; },
  }), /取消/);
  assert.equal(disk, original);
  assert.equal(reloads, 0);
});

test("a stopped service can save without starting a proxy and rollback failures are reported", async () => {
  let disk = original;
  await commitProxyPortChange(original, "new-config", { current: () => true, write: async (content) => { disk = content; } });
  assert.equal(disk, "new-config");
  await assert.rejects(commitProxyPortChange(original, "new-config", {
    current: () => true, write: async () => {}, apply: async () => { throw new Error("listener failed"); },
  }), AggregateError);
});

test("cancellation during a reload restores the profile but never restarts against a newer user action", async () => {
  let current = true;
  let disk = original;
  let reloads = 0;
  await assert.rejects(commitProxyPortChange(original, "new-config", {
    current: () => current,
    write: async (content) => { disk = content; },
    apply: async () => { reloads++; current = false; },
  }), /取消/);
  assert.equal(disk, original);
  assert.equal(reloads, 1);
});

test("stopped port-only edits retain the preferred node without making stale probe listeners look current", () => {
  const saved = { profile: "profile-a", hash: "original", preferred: "manual-choice", candidates: [{ port: 2000 }] };
  const first = carryProxyPortPriorityPreference(saved, "profile-a", "original", "edit-one");
  assert.deepEqual(first, { ...saved, portEditedHash: "edit-one" });
  assert.equal(saved.hash, "original");
  const second = carryProxyPortPriorityPreference(first, "profile-a", "edit-one", "edit-two");
  assert.equal(second?.hash, "original");
  assert.equal(second?.preferred, "manual-choice");
  assert.equal(second?.portEditedHash, "edit-two");
  assert.equal(carryProxyPortPriorityPreference(saved, "profile-b", "original", "next"), null);
  assert.equal(carryProxyPortPriorityPreference(saved, "profile-a", "unrelated-edit", "next"), null);
  assert.equal(carryProxyPortPriorityPreference(null, "profile-a", "original", "next"), null);
});

import assert from "node:assert/strict";
import { createServer, createConnection } from "node:net";
import { createServer as createTLSServer } from "node:tls";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthLog } from "./healthLog";
import test from "node:test";

import {
  ConsecutiveFailureRecovery,
  nextSystemProxyProbeDelay,
  probeSystemProxy,
  classifyProxyQuality,
  proxySelectionSnapshot,
  summarizeWindowsProxy,
  RecoveryCoordinator,
} from "./systemProxyRecovery";

test("switch invalidates queued reload even before selection subscription catches up", () => {
  const coordinator = new RecoveryCoordinator();
  const old = coordinator.snapshot();
  assert.equal(coordinator.accepts(old, 1000, 2000), true);
  coordinator.begin();
  assert.equal(coordinator.accepts(old, 1000, 2000), false);
  assert.throws(() => coordinator.begin(), /overlapping/);
  coordinator.finish(3000);
  assert.equal(coordinator.accepts(old, 40000, 41000), false);
});

test("reload needs probes started after observation, not old probes finishing after it", () => {
  const coordinator = new RecoveryCoordinator(); coordinator.begin(); coordinator.finish(1000);
  const epoch = coordinator.snapshot();
  assert.equal(coordinator.accepts(epoch, 30000, 32000), false);
  assert.equal(coordinator.accepts(epoch, 31000, 32000), true);
  assert.equal(coordinator.freshIndependent(30000, 32000), false);
  assert.equal(coordinator.freshIndependent(31000, 32000), true);
  assert.equal(coordinator.freshIndependent(31000, 76000), false);
});

test("failed switch and repeated switches restart observation without blocking failover", async () => {
  const coordinator = new RecoveryCoordinator();
  await assert.rejects((async () => { coordinator.begin(); try { throw new Error("RPC timeout"); } finally { coordinator.finish(1000); } })());
  coordinator.begin(); coordinator.finish(2000);
  assert.equal(coordinator.accepts(coordinator.snapshot(), 31000, 33000), false);
  assert.equal(coordinator.accepts(coordinator.snapshot(), 32000, 33000), true);
});

test("recovery gate triggers once after consecutive failures and rearms on success", () => {
  const gate = new ConsecutiveFailureRecovery(3);
  assert.equal(gate.recordFailure(), false);
  assert.equal(gate.recordFailure(), false);
  assert.equal(gate.recordFailure(), true);
  assert.equal(gate.recoveryArmed, false);
  assert.equal(gate.consecutiveFailures, 3);
  assert.equal(gate.recordFailure(), false);
  assert.equal(gate.consecutiveFailures, 3);
  gate.recordSuccess();
  assert.equal(gate.recoveryArmed, true);
  assert.equal(gate.consecutiveFailures, 0);
  assert.equal(gate.recordFailure(), false);
});

test("recovery gate validates and resets its threshold", () => {
  assert.throws(() => new ConsecutiveFailureRecovery(0), /positive integer/);
  const gate = new ConsecutiveFailureRecovery(1);
  assert.equal(gate.recordFailure(), true);
  gate.reset();
  assert.equal(gate.recoveryArmed, true);
  assert.equal(gate.recordFailure(), true);
});

test("healthy checks stay sparse while armed failures use rapid confirmation", () => {
  const gate = new ConsecutiveFailureRecovery(3);
  assert.equal(nextSystemProxyProbeDelay(gate, 60_000, 5_000), 60_000);
  assert.equal(gate.recordFailure(), false);
  assert.equal(nextSystemProxyProbeDelay(gate, 60_000, 5_000), 5_000);
  assert.equal(gate.recordFailure(), false);
  assert.equal(nextSystemProxyProbeDelay(gate, 60_000, 5_000), 5_000);
  assert.equal(gate.recordFailure(), true);
  assert.equal(nextSystemProxyProbeDelay(gate, 60_000, 5_000), 60_000);
  gate.recordSuccess();
  assert.equal(nextSystemProxyProbeDelay(gate, 60_000, 5_000), 60_000);
});

async function withProxyResponse(
  response: string,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end(response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test proxy has no TCP address");
    }
    await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

test("CONNECT 200 without working TLS is not healthy", async () => {
  await withProxyResponse("HTTP/1.1 200 Connection established\r\n\r\n", async (port) => {
    await assert.rejects(probeSystemProxy({ server: "127.0.0.1", port }, { timeoutMs: 1_000 }), /tls:/);
  });
});

test("real TLS and HTTPS status are required; 403 is reachable not an outage", async () => {
  // Public test-only self-signed certificate; never used by the application.
  const cert = await readFile(new URL("./testdata/health-test-cert.txt", import.meta.url));
  const key = await readFile(new URL("./testdata/health-test-key.txt", import.meta.url));
  const tls = createTLSServer({ cert, key }, s => {
    s.once("data", () => s.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"));
    s.on("error", () => {});
  });
  tls.on("tlsClientError", () => {});
  await new Promise<void>(r => tls.listen(0, "127.0.0.1", r));
  const target = tls.address(); assert.ok(target && typeof target !== "string");
  const proxy = createServer(s => { s.once("data", () => {
    const upstream = createConnection(target.port, "127.0.0.1", () => { s.write("HTTP/1.1 200 Connection established\r\n\r\n"); s.pipe(upstream); upstream.pipe(s); });
    s.on("close", () => upstream.destroy()); upstream.on("error", () => s.destroy()); s.on("error", () => upstream.destroy());
  }); });
  await new Promise<void>(r => proxy.listen(0, "127.0.0.1", r));
  const address = proxy.address(); assert.ok(address && typeof address !== "string");
  try {
    const result = await probeSystemProxy({ server: "127.0.0.1", port: address.port }, { ca: cert, timeoutMs: 2_000 });
    assert.equal(result.status, 403); assert.ok(result.totalMs >= result.tlsMs);
    await assert.rejects(probeSystemProxy({ server: "127.0.0.1", port: address.port }, { timeoutMs: 2_000 }), /tls:/);
  } finally { await new Promise<void>(r => proxy.close(() => r())); await new Promise<void>(r => tls.close(() => r())); }
});

test("quality policy distinguishes one slow site from repeated multi-site degradation", () => {
  const good = { status: "fulfilled" as const, value: { target: "test", tcpMs: 1, connectMs: 1, tlsMs: 1, httpMs: 1, totalMs: 40, status: 403 } };
  const slow = { ...good, value: { ...good.value, totalMs: 6_000 } };
  const failed = { status: "rejected" as const, reason: new Error("TLS timeout") };
  assert.deepEqual(classifyProxyQuality([good, good, good]), { degraded: false, recoverable: false });
  assert.deepEqual(classifyProxyQuality([good, good, slow]), { degraded: true, recoverable: false });
  assert.equal(classifyProxyQuality([slow, failed, good]).recoverable, false);
  assert.equal(classifyProxyQuality([slow, slow, slow]).recoverable, false);
  assert.equal(classifyProxyQuality([failed, failed, good]).recoverable, true);
});

test("selection snapshots ignore list order but invalidate results after any group switch", () => {
  const groups = [{ tag: "entry", selected: "a" }, { tag: "business", selected: "entry" }];
  assert.equal(proxySelectionSnapshot(groups), proxySelectionSnapshot([...groups].reverse()));
  assert.notEqual(proxySelectionSnapshot(groups), proxySelectionSnapshot([{ ...groups[0], selected: "b" }, groups[1]]));
  assert.notEqual(proxySelectionSnapshot(groups), proxySelectionSnapshot([groups[0], { ...groups[1], selected: "direct" }]));
});

test("Windows proxy diagnostics distinguish endpoint drift without exposing private URLs", () => {
  const endpoint = { server: "127.0.0.1", port: 2080 };
  const summary = summarizeWindowsProxy("ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http://127.0.0.1:2080\nAutoConfigURL REG_SZ https://private.invalid/token", endpoint);
  assert.deepEqual(summary, { enabled: true, httpMatches: true, httpsMatches: true, pacConfigured: true, autoDetect: false });
  assert.ok(!JSON.stringify(summary).includes("private.invalid"));
  const split = summarizeWindowsProxy("ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ http=127.0.0.1:2080;https=127.0.0.1:9999", endpoint);
  assert.equal(split.enabled, false); assert.equal(split.httpMatches, true); assert.equal(split.httpsMatches, false);
  assert.equal(summarizeWindowsProxy("", endpoint).httpsMatches, false);
});

test("health log rotates and preserves complete concurrent records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxh-health-log-")); const path = join(dir, "health.log");
  try {
    const log = new HealthLog(path, 180);
    await Promise.all(Array.from({ length: 10 }, (_, i) => log.write("sample", { sequence: i })));
    for (const p of [path, path + ".1"]) {
      const text = await readFile(p, "utf8"); assert.ok(Buffer.byteLength(text) <= 180);
      for (const line of text.trim().split("\n")) assert.equal(JSON.parse(line).event, "sample");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("system proxy probe rejects an unsuccessful CONNECT response", async () => {
  await withProxyResponse("HTTP/1.1 502 Bad Gateway\r\n\r\n", async (port) => {
    await assert.rejects(
      probeSystemProxy({ server: "127.0.0.1", port }, { timeoutMs: 1_000 }),
      /502 Bad Gateway/,
    );
  });
});

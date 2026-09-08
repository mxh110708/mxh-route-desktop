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
} from "./systemProxyRecovery";

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
  assert.equal(classifyProxyQuality([slow, failed, good]).recoverable, true);
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

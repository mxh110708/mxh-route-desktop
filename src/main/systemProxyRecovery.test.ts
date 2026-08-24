import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import {
  ConsecutiveFailureRecovery,
  nextSystemProxyProbeDelay,
  probeSystemProxy,
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

test("system proxy probe accepts a successful CONNECT response", async () => {
  await withProxyResponse("HTTP/1.1 200 Connection established\r\n\r\n", async (port) => {
    await probeSystemProxy({ server: "127.0.0.1", port }, { timeoutMs: 1_000 });
  });
});

test("system proxy probe rejects an unsuccessful CONNECT response", async () => {
  await withProxyResponse("HTTP/1.1 502 Bad Gateway\r\n\r\n", async (port) => {
    await assert.rejects(
      probeSystemProxy({ server: "127.0.0.1", port }, { timeoutMs: 1_000 }),
      /502 Bad Gateway/,
    );
  });
});

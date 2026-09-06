import assert from "node:assert/strict";
import test from "node:test";
import { assertConfigRpcSize, RPC_MAX_MESSAGE_BYTES, rpcMessageLimits } from "./rpcLimits";

test("RPC transports allow 10 MiB in both directions", () => {
  assert.equal(RPC_MAX_MESSAGE_BYTES, 10485760);
  assert.deepEqual(rpcMessageLimits, { readMaxBytes: 10485760, writeMaxBytes: 10485760 });
});
test("raw profile size checks allow old failing import and reserve metadata space", () => {
  assert.doesNotThrow(() => assertConfigRpcSize(" ".repeat(4941773)));
  assert.doesNotThrow(() => assertConfigRpcSize(" ".repeat(RPC_MAX_MESSAGE_BYTES - 65536)));
  assert.throws(() => assertConfigRpcSize(" ".repeat(RPC_MAX_MESSAGE_BYTES)), /10 MiB/);
  assert.throws(() => assertConfigRpcSize("中".repeat(4 * 1024 * 1024)), /10 MiB/);
});

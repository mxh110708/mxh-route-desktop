// Serialized protobuf message limit. Keep in sync with daemon/message_limit.go.
export const RPC_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const rpcMessageLimits = {
  readMaxBytes: RPC_MAX_MESSAGE_BYTES,
  writeMaxBytes: RPC_MAX_MESSAGE_BYTES,
};

// Reserve room for protobuf fields and runtime options around configuration text.
export function assertConfigRpcSize(source: string): void {
  if (Buffer.byteLength(source, "utf8") > RPC_MAX_MESSAGE_BYTES - 64 * 1024) {
    throw new Error("configuration exceeds the 10 MiB desktop RPC message limit (64 KiB reserved for metadata)");
  }
}

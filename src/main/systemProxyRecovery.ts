import { createConnection } from "node:net";

import type { SystemProxyEndpoint } from "./runtimeConfig";

export interface SystemProxyProbeOptions {
  targetHost?: string;
  targetPort?: number;
  timeoutMs?: number;
}

export class ConsecutiveFailureRecovery {
  private failures = 0;
  private armed = true;

  constructor(private readonly threshold: number) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error("recovery threshold must be a positive integer");
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.armed = true;
  }

  recordFailure(): boolean {
    if (!this.armed) {
      return false;
    }
    this.failures += 1;
    if (this.failures < this.threshold) {
      return false;
    }
    this.armed = false;
    return true;
  }

  reset(): void {
    this.failures = 0;
    this.armed = true;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  get recoveryArmed(): boolean {
    return this.armed;
  }
}

export function nextSystemProxyProbeDelay(
  recovery: ConsecutiveFailureRecovery,
  normalDelayMs: number,
  retryDelayMs: number,
): number {
  return recovery.recoveryArmed && recovery.consecutiveFailures > 0
    ? retryDelayMs
    : normalDelayMs;
}

export function probeSystemProxy(
  endpoint: SystemProxyEndpoint,
  options: SystemProxyProbeOptions = {},
): Promise<void> {
  const targetHost = options.targetHost ?? "www.gstatic.com";
  const targetPort = options.targetPort ?? 443;
  const timeoutMs = options.timeoutMs ?? 8_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let response = "";
    const socket = createConnection({ host: endpoint.server, port: endpoint.port });

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };

    socket.setNoDelay(true);
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          "Proxy-Connection: close\r\n\r\n",
      );
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
      if (response.length > 8_192) {
        finish(new Error("system proxy returned an oversized response"));
        return;
      }
      const headerEnd = response.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const statusLine = response.slice(0, response.indexOf("\r\n"));
      if (/^HTTP\/1\.[01] 2\d\d(?: |$)/u.test(statusLine)) {
        finish();
      } else {
        finish(new Error(`system proxy CONNECT failed: ${statusLine || "invalid response"}`));
      }
    });
    socket.once("timeout", () => finish(new Error("system proxy probe timed out")));
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) {
        finish(new Error("system proxy closed the probe connection"));
      }
    });
  });
}

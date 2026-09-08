import { createConnection } from "node:net";
import { connect as connectTLS, type TLSSocket } from "node:tls";

import type { SystemProxyEndpoint } from "./runtimeConfig";

export interface SystemProxyProbeOptions {
  targetHost?: string;
  targetPort?: number;
  timeoutMs?: number;
  path?: string;
  ca?: string | Buffer;
}

export interface ProxyQuality {
  target: string;
  tcpMs: number;
  connectMs: number;
  tlsMs: number;
  httpMs: number;
  totalMs: number;
  status: number;
}

export function classifyProxyQuality(results: PromiseSettledResult<ProxyQuality>[]): {
  degraded: boolean; recoverable: boolean;
} {
  const bad = results.filter(r => r.status === "rejected" || r.value.totalMs >= 5_000).length;
  // A single site's failure/challenge is not evidence the whole proxy needs restarting.
  return { degraded: bad > 0, recoverable: bad >= 2 };
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
): Promise<ProxyQuality> {
  const targetHost = options.targetHost ?? "www.gstatic.com";
  const targetPort = options.targetPort ?? 443;
  const timeoutMs = options.timeoutMs ?? 8_000;

  return new Promise((resolve, reject) => {
    const started = performance.now();
    let tcpAt = started, connectAt = started, tlsAt = started;
    let stage = "proxy-tcp";
    let secure: TLSSocket | undefined;
    let settled = false;
    let response = "";
    const socket = createConnection({ host: endpoint.server, port: endpoint.port });

    const timer = setTimeout(() => finish(new Error("deadline exceeded")), timeoutMs);
    const finish = (error?: Error, status = 0) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      secure?.destroy();
      socket.destroy();
      if (error === undefined) {
        const now = performance.now();
        resolve({ target: targetHost, tcpMs: Math.round(tcpAt-started), connectMs: Math.round(connectAt-tcpAt), tlsMs: Math.round(tlsAt-connectAt), httpMs: Math.round(now-tlsAt), totalMs: Math.round(now-started), status });
      } else {
        reject(new Error(`${stage}: ${error.message} (${Math.round(performance.now()-started)}ms)`));
      }
    };

    socket.setNoDelay(true);
    socket.once("connect", () => {
      tcpAt = performance.now(); stage = "proxy-connect";
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          "Proxy-Connection: close\r\n\r\n",
      );
    });
    const onProxyData = (chunk: Buffer) => {
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
        connectAt = performance.now(); stage = "tls";
        socket.removeListener("data", onProxyData);
        socket.removeListener("close", onProxyClose);
        const remaining = Buffer.from(response.slice(headerEnd + 4), "latin1");
        if (remaining.length) socket.unshift(remaining);
        response = "";
        secure = connectTLS({ socket, servername: targetHost, ca: options.ca, ALPNProtocols: ["http/1.1"], rejectUnauthorized: true });
        secure.once("secureConnect", () => {
          tlsAt = performance.now(); stage = "https-header";
          secure!.write(`HEAD ${options.path ?? "/generate_204"} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`);
        });
        secure.on("data", (data: Buffer) => {
          response += data.toString("latin1");
          if (response.length > 32_768) { finish(new Error("oversized HTTPS headers")); return; }
          if (!response.includes("\r\n\r\n")) return;
          const match = /^HTTP\/1\.[01] ([2-5]\d\d)(?: |\r)/u.exec(response);
          if (!match) { finish(new Error("invalid HTTPS response")); return; }
          // 403/429 prove transport works; record them without treating them as an outage.
          finish(undefined, Number(match[1]));
        });
        secure.once("error", error => finish(error));
        secure.once("close", () => { if (!settled) finish(new Error("TLS closed before HTTPS response")); });
      } else {
        finish(new Error(`system proxy CONNECT failed: ${statusLine || "invalid response"}`));
      }
    };
    socket.on("data", onProxyData);
    socket.once("error", (error) => finish(error));
    const onProxyClose = () => {
      if (!settled) {
        finish(new Error("system proxy closed the probe connection"));
      }
    };
    socket.once("close", onProxyClose);
  });
}

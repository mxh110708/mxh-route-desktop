import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { connect as connectTLS, type TLSSocket } from "node:tls";

import type { SystemProxyEndpoint } from "./runtimeConfig";

export function summarizeWindowsProxy(registry: string, endpoint: SystemProxyEndpoint) {
  const value = (key: string) => new RegExp(`^\\s*${key}\\s+REG_\\w+\\s+(.*)$`, "mi").exec(registry)?.[1].trim() ?? "";
  const expected = `${endpoint.server}:${endpoint.port}`.toLowerCase();
  const proxy = value("ProxyServer").toLowerCase().replace(/^https?:\/\//, "");
  const matches = (scheme: string) => {
    if (!proxy.includes("=")) return proxy === expected;
    return proxy.split(";").some(item => item.trim() === `${scheme}=${expected}`);
  };
  return { enabled: Number(value("ProxyEnable")) === 1, httpMatches: matches("http"), httpsMatches: matches("https"),
    pacConfigured: value("AutoConfigURL") !== "", autoDetect: Number(value("AutoDetect")) === 1 };
}

/** Read-only, bounded diagnostic. Never log PAC URLs or foreign proxy addresses. */
export async function readWindowsProxyDiagnostic(endpoint: SystemProxyEndpoint) {
  if (process.platform !== "win32") return { supported: false };
  try {
    const { stdout } = await promisify(execFile)(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"),
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { timeout: 2000, windowsHide: true, maxBuffer: 128 * 1024 });
    return { supported: true, readable: true, ...summarizeWindowsProxy(stdout, endpoint) };
  } catch { return { supported: true, readable: false }; }
}

export type WindowsProxyOwnership = "owned" | "detached" | "foreign" | "unknown";

export function classifyWindowsProxyOwnership(reading: {
  supported: boolean;
  readable?: boolean;
  enabled?: boolean;
  httpMatches?: boolean;
  httpsMatches?: boolean;
  pacConfigured?: boolean;
  autoDetect?: boolean;
}): WindowsProxyOwnership {
  if (!reading.supported || !reading.readable) return "unknown";
  // A foreign endpoint, PAC, or auto-detection can be intentional. Never take
  // ownership of those settings based on a successful loopback probe.
  if (!reading.httpMatches || !reading.httpsMatches || reading.pacConfigured || reading.autoDetect) return "foreign";
  return reading.enabled ? "owned" : "detached";
}

/** At most one automatic reassertion per service session; repeated changes yield. */
export class WindowsProxyRecoveryGate {
  private detachedSamples = 0;
  private repairAttempted = false;
  private suspended = false;

  observe(state: WindowsProxyOwnership): "healthy" | "retry" | "repair" | "foreign" | "unknown" | "suspended" {
    if (state === "owned") {
      this.detachedSamples = 0;
      return "healthy";
    }
    if (state === "unknown") {
      this.detachedSamples = 0;
      return "unknown";
    }
    if (state === "foreign") {
      this.suspended = true;
      return "foreign";
    }
    if (this.suspended || this.repairAttempted) {
      this.suspended = true;
      return "suspended";
    }
    this.detachedSamples++;
    if (this.detachedSamples < 2) return "retry";
    this.repairAttempted = true;
    return "repair";
  }

  reset(): void {
    this.detachedSamples = 0;
    this.repairAttempted = false;
    this.suspended = false;
  }

  cancelPendingRepair(): void {
    if (this.suspended) return;
    this.detachedSamples = 0;
    this.repairAttempted = false;
  }
}

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
  // Slow successful requests are degraded, not evidence that restarting helps.
  return { degraded: bad > 0, recoverable: results.filter(r => r.status === "rejected").length >= 2 };
}

export function proxySelectionSnapshot(groups: readonly { tag: string; selected?: string }[]): string {
  return JSON.stringify(groups.map(group => [group.tag, group.selected ?? ""]).sort((a, b) => a[0].localeCompare(b[0])));
}

/** Shared mutation epoch; observation delays only automatic reload, never failover. */
export class RecoveryCoordinator {
  private epoch = 0;
  private active = false;
  private notBefore = 0;
  constructor(private readonly observationMs = 30000) {}
  snapshot(): number { return this.epoch; }
  begin(): void {
    if (this.active) throw new Error("overlapping recovery operation");
    this.active = true; this.epoch++;
  }
  finish(now: number): void {
    this.active = false; this.notBefore = now + this.observationMs;
  }
  accepts(epoch: number, sampleStartedAt: number, now: number): boolean {
    return !this.active && epoch === this.epoch && sampleStartedAt >= this.notBefore && now >= sampleStartedAt;
  }
  freshIndependent(at: number, now: number): boolean {
    return !this.active && at >= this.notBefore && now >= at && now - at < 45000;
  }
  freshCompletedRound(startedAt: number, completedAt: number, now: number): boolean {
    return !this.active && startedAt >= this.notBefore && completedAt >= startedAt &&
      now >= completedAt && now - completedAt < 60000;
  }
}

export interface PriorityProbeEvidence {
  at: number;
  finishedAt: number;
  reachable: ReadonlyMap<string, boolean>;
}

export interface SelectedProbeEvidence {
  tag: string;
  at: number;
  reachable: boolean;
}

export function classifyPriorityRecoveryEvidence(
  selected: string | undefined,
  result: PriorityProbeEvidence | null,
  coordinator: RecoveryCoordinator,
  now: number,
  selectedProbe: SelectedProbeEvidence | null = null,
): "selected-healthy" | "all-down" | "unavailable" {
  if (!selected) return "unavailable";
  if (selectedProbe?.tag === selected && selectedProbe.reachable &&
      (result === null || selectedProbe.at >= result.at) &&
      coordinator.freshIndependent(selectedProbe.at, now)) {
    return "selected-healthy";
  }
  if (result === null) return "unavailable";
  if (result.reachable.get(selected) === true && coordinator.freshIndependent(result.at, now)) {
    return "selected-healthy";
  }
  if (result.reachable.size > 0 && [...result.reachable.values()].every(reachable => !reachable) &&
      coordinator.freshCompletedRound(result.at, result.finishedAt, now)) {
    return "all-down";
  }
  return "unavailable";
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

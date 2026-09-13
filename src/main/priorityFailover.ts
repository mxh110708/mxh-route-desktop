import { createServer } from "node:net";
import { DEFAULT_PRIORITY_SETTINGS, type PrioritySettings } from "./prioritySettings";

export interface Candidate { tag: string; port: number }

/** Structural entry groups only: every member must resolve to a concrete proxy. */
export function priorityGroups(content: string): { tag: string; nodes: string[] }[] {
  const config = JSON.parse(content);
  const outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
  return outbounds.filter((group: any) => group.type === "selector" && typeof group.tag === "string" &&
    Array.isArray(group.outbounds) && group.outbounds.length > 0 &&
    group.outbounds.every((tag: unknown) => typeof tag === "string" &&
      outbounds.some((node: any) => node.tag === tag && typeof node.type === "string" &&
        !["direct", "block", "selector", "urltest", "dns"].includes(node.type))))
    .map((group: any) => ({ tag: group.tag, nodes: [...new Set<string>(group.outbounds)] }));
}

export function priorityTags(content: string, settings: PrioritySettings = DEFAULT_PRIORITY_SETTINGS): string[] {
  if (!settings.enabled) return [];
  const group = priorityGroups(content).find(group => group.tag === settings.group);
  if (!group) return [];
  const available = group.nodes;
  if (!settings.order.length) return available;
  if (settings.order.some(tag => !available.includes(tag))) throw new Error("显式故障切换顺序包含不存在、不属于目标组或非代理节点的名称");
  return [...settings.order];
}

export async function allocateProbePorts(count: number): Promise<number[]> {
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer(); servers.push(server);
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    }
    return servers.map(s => (s.address() as { port: number }).port);
  } finally { await Promise.all(servers.map(s => new Promise<void>(resolve => s.close(() => resolve())))); }
}

export function addProbeRoutes(content: string, ports: number[], settings: PrioritySettings = DEFAULT_PRIORITY_SETTINGS): { content: string; candidates: Candidate[] } {
  const config = JSON.parse(content), tags = priorityTags(content, settings);
  if (tags.length !== ports.length) throw new Error("priority probe port count mismatch");
  if (!tags.length) return { content, candidates: [] };
  const candidates = tags.map((tag, i) => ({ tag, port: ports[i] }));
  config.inbounds ??= []; config.route ??= {}; config.route.rules ??= [];
  const rules: unknown[] = [];
  candidates.forEach((candidate, i) => {
    const tag = `mxh-priority-probe-${i}`;
    if (config.inbounds.some((v: any) => v.tag === tag)) throw new Error("reserved priority probe tag collision");
    config.inbounds.push({ type: "http", tag, listen: "127.0.0.1", listen_port: candidate.port });
    rules.push({ inbound: [tag], action: "route", outbound: candidate.tag });
  });
  config.route.rules.unshift(...rules);
  return { content: JSON.stringify(config), candidates };
}

interface History { good: number; bad: number; since: number }
/** No latency ranking. A failure round requires at least two independent HTTPS failures. */
export class PriorityFailover {
  private history = new Map<string, History>();
  private lastSwitch = -Infinity;
  private expected: string | null = null;
  private lastSample: number | null = null;
  paused = false;
  constructor(readonly tags: string[], readonly settings: PrioritySettings = DEFAULT_PRIORITY_SETTINGS) {}
  observeSelection(selected: string): void {
    if (this.expected !== null && selected !== this.expected) this.paused = true;
    this.expected = selected;
  }
  record(results: Map<string, boolean>, now: number): string | null {
    // Sleep/offline gaps are not proof of continuous recovery or consecutive failure.
    const staleGap = Math.max(120000, Math.max(this.settings.healthyIntervalMs, this.settings.failureIntervalMs) + this.tags.length * this.settings.probeTimeoutMs + 30000);
    if (this.lastSample !== null && now - this.lastSample > staleGap) this.history.clear();
    this.lastSample = now;
    for (const tag of this.tags) {
      const old = this.history.get(tag) ?? { good: 0, bad: 0, since: now };
      const ok = results.get(tag) === true;
      this.history.set(tag, ok ? { good: old.good + 1, bad: 0, since: old.good ? old.since : now } : { good: 0, bad: old.bad + 1, since: now });
    }
    if (this.paused || this.expected === null || !this.tags.includes(this.expected)) return null;
    const current = this.history.get(this.expected)!;
    if (current.bad >= this.settings.failureRounds) {
      // A newly failed backup must not be trapped by the failback cooldown.
      return this.tags.find(t => this.history.get(t)!.good >= this.settings.backupSuccessRounds) ?? null;
    }
    if (now - this.lastSwitch < this.settings.failbackCooldownMs) return null;
    const index = this.tags.indexOf(this.expected);
    return this.tags.slice(0, index).find(t => {
      const h = this.history.get(t)!;
      return h.good >= this.settings.recoverySuccessRounds && now - h.since >= this.settings.recoveryStableMs;
    }) ?? null;
  }
  switched(tag: string, now: number): void { this.expected = tag; this.lastSwitch = now; }
}

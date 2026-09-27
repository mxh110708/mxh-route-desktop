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

interface History { good: number; bad: number; since: number; at: number; sampleAt: number }
/** No latency ranking. A failure round requires at least two independent HTTPS failures. */
export class PriorityFailover {
  private history = new Map<string, History>();
  private lastSwitch = -Infinity;
  private expected: string | null = null;
  private lastSample: number | null = null;
  private preferredTag: string | null;
  constructor(readonly tags: string[], readonly settings: PrioritySettings = DEFAULT_PRIORITY_SETTINGS, preferred?: string | null) {
    this.preferredTag = preferred ?? tags[0] ?? null;
  }
  get preferred(): string | null { return this.preferredTag; }
  clearSamples(): void { this.history.clear(); this.lastSample = null; }
  isMonitored(tag: string): boolean { return this.tags.includes(tag); }
  observeSelection(selected: string): boolean {
    const changed = this.expected !== null && selected !== this.expected;
    if (changed) {
      this.preferredTag = selected;
      this.history.clear();
      this.lastSample = null;
      this.lastSwitch = -Infinity;
    }
    this.expected = selected;
    return changed;
  }
  get ownsNodeRecovery(): boolean {
    return this.settings.enabled && this.expected !== null && this.isMonitored(this.expected);
  }
  private rankedTags(): string[] {
    return this.preferredTag !== null && this.isMonitored(this.preferredTag)
      ? [this.preferredTag, ...this.tags.filter(tag => tag !== this.preferredTag)] : this.tags;
  }
  record(results: Map<string, boolean>, now: number, sampleAt = now): string | null {
    // Sleep/offline gaps are not proof of continuous recovery or consecutive failure.
    const staleGap = Math.max(120000, Math.max(this.settings.healthyIntervalMs, this.settings.failureIntervalMs) + this.tags.length * this.settings.probeTimeoutMs + 30000);
    if (this.lastSample !== null && now - this.lastSample > staleGap) this.history.clear();
    this.lastSample = now;
    for (const tag of this.tags) {
      // Independent active/backup lanes only count samples actually collected.
      if (!results.has(tag)) continue;
      const prior = this.history.get(tag);
      if (prior && sampleAt < prior.sampleAt) continue;
      const old = prior && now - prior.at <= staleGap ? prior : { good: 0, bad: 0, since: now, at: now, sampleAt };
      const ok = results.get(tag) === true;
      this.history.set(tag, ok ? { good: old.good + 1, bad: 0, since: old.good ? old.since : now, at: now, sampleAt } : { good: 0, bad: old.bad + 1, since: now, at: now, sampleAt });
    }
    return this.decide(now);
  }
  decide(now: number): string | null {
    if (this.expected === null || !this.isMonitored(this.expected)) return null;
    const current = this.history.get(this.expected);
    const fresh = (h: History | undefined): h is History => !!h && now >= h.at &&
      now - h.at <= Math.max(45000, this.settings.healthyIntervalMs + this.settings.probeTimeoutMs + 5000);
    if (!fresh(current)) return null;
    const ranked = this.rankedTags();
    if (current.bad >= this.settings.failureRounds) {
      // A newly failed backup must not be trapped by the failback cooldown.
      return ranked.find(t => t !== this.expected && fresh(this.history.get(t)) && this.history.get(t)!.good >= this.settings.backupSuccessRounds) ?? null;
    }
    if (now - this.lastSwitch < this.settings.failbackCooldownMs) return null;
    const index = ranked.indexOf(this.expected);
    return ranked.slice(0, index).find(t => {
      const h = this.history.get(t);
      return fresh(h) && h.good >= this.settings.recoverySuccessRounds && now - h.since >= this.settings.recoveryStableMs;
    }) ?? null;
  }
  nextProbeDelay(selected: string, results: ReadonlyMap<string, boolean>): number {
    const failures = this.history.get(selected)?.bad ?? 0;
    // Confirm a newly failed active node promptly, but back off after the configured
    // failure threshold when no backup is ready; do not probe indefinitely at burst rate.
    if (this.isMonitored(selected) && failures > 0 && failures < this.settings.failureRounds) return 1_000;
    return [...results.values()].every(Boolean) ? this.settings.healthyIntervalMs : this.settings.failureIntervalMs;
  }
  switched(tag: string, now: number): void { this.expected = tag; this.lastSwitch = now; }
}

import { createServer } from "node:net";

export const ENTRY_GROUP = "US-West Entry";
export interface Candidate { tag: string; port: number }
const rank = (tag: string): number => /^DMIT-/u.test(tag) ? 0 : /^VMISS-/u.test(tag) ? 1 : /^MoeCloud-/u.test(tag) ? 2 : 99;

export function priorityTags(content: string): string[] {
  const config = JSON.parse(content);
  const group = config.outbounds?.find((v: any) => v.tag === ENTRY_GROUP && v.type === "selector");
  if (!Array.isArray(group?.outbounds)) return [];
  return group.outbounds.filter((tag: unknown): tag is string => typeof tag === "string" && rank(tag) < 99 &&
    config.outbounds.some((v: any) => v.tag === tag && !["direct", "block", "selector", "urltest"].includes(v.type)))
    .sort((a: string, b: string) => rank(a) - rank(b));
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

export function addProbeRoutes(content: string, ports: number[]): { content: string; candidates: Candidate[] } {
  const config = JSON.parse(content), tags = priorityTags(content);
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
  constructor(readonly tags: string[]) {}
  observeSelection(selected: string): void {
    if (this.expected !== null && selected !== this.expected) this.paused = true;
    this.expected = selected;
  }
  record(results: Map<string, boolean>, now: number): string | null {
    // Sleep/offline gaps are not proof of continuous recovery or consecutive failure.
    if (this.lastSample !== null && now - this.lastSample > 120_000) this.history.clear();
    this.lastSample = now;
    for (const tag of this.tags) {
      const old = this.history.get(tag) ?? { good: 0, bad: 0, since: now };
      const ok = results.get(tag) === true;
      this.history.set(tag, ok ? { good: old.good + 1, bad: 0, since: old.good ? old.since : now } : { good: 0, bad: old.bad + 1, since: now });
    }
    if (this.paused || this.expected === null || !this.tags.includes(this.expected)) return null;
    const current = this.history.get(this.expected)!;
    if (current.bad >= 3) {
      // A newly failed backup must not be trapped by the failback cooldown.
      return this.tags.find(t => this.history.get(t)!.good >= 2) ?? null;
    }
    if (now - this.lastSwitch < 60_000) return null;
    const index = this.tags.indexOf(this.expected);
    return this.tags.slice(0, index).find(t => {
      const h = this.history.get(t)!;
      return h.good >= 3 && now - h.since >= 120_000;
    }) ?? null;
  }
  switched(tag: string, now: number): void { this.expected = tag; this.lastSwitch = now; }
}

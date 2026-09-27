import type { Candidate } from "./priorityFailover";

export interface NodeSample { tag: string; at: number; reachable: boolean }

/** One dedicated active-node lane plus at most two background candidate lanes. */
export class PriorityProbeScheduler {
  private activeBusy = false;
  private backupBusy = false;
  private activeDue = 0;
  private backupDue = 0;
  private identity = "";
  private latestActive: NodeSample | null = null;
  private latestBackup: { at: number; finishedAt: number; results: Map<string, boolean> } | null = null;
  get busy(): boolean { return this.activeBusy || this.backupBusy; }
  constructor(private readonly deps: {
    now(): number;
    probe(candidate: Candidate): Promise<boolean>;
    sample(sample: NodeSample): Promise<void>;
    activeDelay(reachable: boolean): number;
    backupInterval(): number;
    round(at: number, finishedAt: number, reachable: Map<string, boolean>): void;
    error(error: unknown): void;
  }) {}

  tick(key: string, selected: string, candidates: Candidate[], valid: () => boolean): void {
    if (key !== this.identity) {
      this.identity = key;
      this.activeDue = this.backupDue = 0;
      this.latestActive = null;
      this.latestBackup = null;
    }
    const current = () => this.identity === key && valid();
    const active = candidates.find(c => c.tag === selected);
    if (!active || !current()) return;
    if (!this.activeBusy && this.deps.now() >= this.activeDue) {
      this.activeBusy = true;
      void (async () => {
        const at = this.deps.now();
        const reachable = await this.deps.probe(active);
        if (!current()) return;
        this.latestActive = { tag: selected, at, reachable };
        await this.deps.sample(this.latestActive);
        if (current()) {
          this.activeDue = this.deps.now() + this.deps.activeDelay(reachable);
          this.publishRound(selected);
        }
      })().catch(this.deps.error).finally(() => { this.activeBusy = false; });
    }
    if (!this.backupBusy && this.deps.now() >= this.backupDue) {
      this.backupBusy = true;
      void (async () => {
        const startedAt = this.deps.now();
        const queue = candidates.filter(c => c.tag !== selected);
        const results = new Map<string, boolean>();
        const worker = async () => {
          while (queue.length && current()) {
            const candidate = queue.shift()!;
            const at = this.deps.now();
            const reachable = await this.deps.probe(candidate);
            if (!current()) return;
            results.set(candidate.tag, reachable);
            await this.deps.sample({ tag: candidate.tag, at, reachable });
          }
        };
        await Promise.all([worker(), worker()]);
        if (!current()) return;
        this.latestBackup = { at: startedAt, finishedAt: this.deps.now(), results };
        this.publishRound(selected);
      })().catch(this.deps.error).finally(() => {
        if (current()) this.backupDue = this.deps.now() + this.deps.backupInterval();
        this.backupBusy = false;
      });
    }
  }

  private publishRound(selected: string): void {
    const active = this.latestActive, backup = this.latestBackup;
    if (!active || !backup || active.tag !== selected) return;
    const at = Math.min(active.at, backup.at);
    // Keep all-down evidence bounded by the oldest actual probe, not by how
    // often a newer active-node result republishes it (also handles one node).
    if (this.deps.now() - at > 60_000) return;
    this.deps.round(at, this.deps.now(), new Map([...backup.results, [selected, active.reachable]]));
  }
}

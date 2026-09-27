import { WindowsProxyRecoveryGate, type WindowsProxyOwnership } from "./systemProxyRecovery";

export type WindowsProxyHealth = "inactive" | "unsupported" | "healthy" | "confirming" | "repairing" | "foreign" | "suspended" | "unknown";
export const WINDOWS_PROXY_POLL_MS = 2_000;
export const WINDOWS_PROXY_CONFIRM_MS = 1_000;
export type ProxyRecoveryCheckpoint = "available" | "used" | "foreign" | "unknown";

export interface WindowsProxyContext {
  // Service/profile/mode identity, deliberately NOT node selection or network epoch.
  key: string;
  read(): Promise<WindowsProxyOwnership>;
  repair(): Promise<void>;
  current(): boolean;
}

/** Independent local-state loop. No Internet probes and no network observation window. */
export class WindowsProxyMonitor {
  private gate = new WindowsProxyRecoveryGate();
  private session = 0;
  private busy = false;
  private pending = false;
  private uncertain = false;
  private contextKey: string | null = null;
  private loaded = false;
  private warned = new Set<WindowsProxyHealth>();
  private state: WindowsProxyHealth = "inactive";
  constructor(private readonly deps: {
    context(): Promise<WindowsProxyContext | null>;
    enqueue(operation: () => Promise<void>): Promise<void>;
    changed(state: WindowsProxyHealth): void;
    warning(state: WindowsProxyHealth): void;
    log(event: string, details?: Record<string, unknown>): void;
    loadCheckpoint?(): ProxyRecoveryCheckpoint;
    saveCheckpoint?(state: ProxyRecoveryCheckpoint): void;
  }) {}

  // Only explicit user start/reapply grants a fresh allowance. Never called by a
  // node switch, stale sample, profile refresh, or automatic service reload.
  newSession(): void {
    this.deps.saveCheckpoint?.("available");
    this.loaded = true;
    this.session++;
    this.gate.reset();
    this.uncertain = false;
    this.warned.clear();
    this.publish("inactive");
  }

  private publish(state: WindowsProxyHealth): void {
    if (state !== this.state) {
      this.state = state;
      this.deps.changed(state);
      this.deps.log("windows-proxy-state", { state });
    }
    if (["foreign", "suspended"].includes(state) && !this.warned.has(state)) {
      this.warned.add(state);
      this.deps.warning(state);
    }
  }

  async poll(): Promise<number> {
    if (this.busy) return WINDOWS_PROXY_POLL_MS;
    this.busy = true;
    const session = this.session;
    try {
      if (!this.loaded) {
        const checkpoint = this.deps.loadCheckpoint?.() ?? "available";
        if (checkpoint !== "available") this.gate.suspend();
        this.uncertain = checkpoint === "unknown";
        this.loaded = true;
      }
      const context = await this.deps.context();
      if (session !== this.session) return WINDOWS_PROXY_CONFIRM_MS;
      if (!context) {
        this.contextKey = null;
        this.gate.interruptConfirmation();
        this.publish("inactive");
        return WINDOWS_PROXY_POLL_MS;
      }
      if (context.key !== this.contextKey) {
        this.contextKey = context.key;
        this.gate.interruptConfirmation();
      }
      const ownership = await context.read();
      if (session !== this.session || !context.current()) {
        this.gate.interruptConfirmation();
        return WINDOWS_PROXY_CONFIRM_MS;
      }
      if (this.pending) return WINDOWS_PROXY_CONFIRM_MS;
      if (this.uncertain) {
        // A timed-out RPC may already have reached the OS. Read, but do not
        // reissue it or mistake a late successful result for a new allowance.
        this.publish("unknown");
        return WINDOWS_PROXY_POLL_MS;
      }
      const action = this.gate.observe(ownership);
      if (action === "foreign") this.deps.saveCheckpoint?.("foreign");
      if (action === "repair") {
        this.pending = true;
        this.publish("repairing");
        void this.deps.enqueue(async () => {
          let dispatched = false;
          try {
            if (session !== this.session || !context.current()) return;
            const before = await context.read();
            if (session !== this.session || !context.current()) return;
            if (before !== "detached") {
              this.gate.cancelPendingRepair();
              this.gate.observe(before);
              if (before === "foreign") this.deps.saveCheckpoint?.("foreign");
              this.publish(before === "owned" ? "healthy" : before);
              return;
            }
            this.deps.saveCheckpoint?.("used");
            dispatched = true;
            await context.repair();
            if (session !== this.session || !context.current()) return;
            const after = await context.read();
            if (session !== this.session || !context.current()) return;
            this.publish(after === "owned" ? "healthy" : after === "detached" ? "suspended" : after);
            this.deps.log("windows-proxy-repair-result", { state: after });
          } catch {
            if (session === this.session) {
              this.uncertain = true;
              this.deps.saveCheckpoint?.("unknown");
              this.publish("unknown");
              this.deps.log("windows-proxy-repair-result-unknown");
            }
          } finally {
            if (!dispatched && session === this.session) this.gate.cancelPendingRepair();
            this.pending = false;
          }
        }).catch(() => {
          this.pending = false;
          if (session === this.session) { this.uncertain = true; this.publish("unknown"); }
        });
      } else {
        this.publish(action === "retry" ? "confirming" : action);
      }
      return action === "retry" || action === "repair" ? WINDOWS_PROXY_CONFIRM_MS : WINDOWS_PROXY_POLL_MS;
    } catch {
      if (session === this.session) {
        this.gate.interruptConfirmation();
        this.publish("unknown");
      }
      return WINDOWS_PROXY_POLL_MS;
    } finally { this.busy = false; }
  }
}

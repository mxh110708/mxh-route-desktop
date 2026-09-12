import { HealthLog } from "./healthLog";

export function redactCoreMessage(message: string): string {
  return message.replace(/\x1b\[[0-9;]*m/gu, "")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1<redacted>@")
    .replace(/([?&](?:token|key|password|secret|auth)[^=\s]*=)[^&\s]+/giu, "$1<redacted>")
    .replace(/((?:password|private[_ -]?key|token|authorization|uuid)["']?\s*[=:]\s*["']?)[^,"'\s}]+/giu, "$1<redacted>")
    .slice(0, 8192);
}

export class CoreLogArchive {
  private dropped = 0;
  private pending = 0;
  private readonly log: HealthLog;
  constructor(path: string) { this.log = new HealthLog(path, 10 * 1024 * 1024, 5); }
  async write(level: number, message: string, historical = false): Promise<void> {
    if (this.pending >= 1024) { this.dropped++; return; }
    this.pending++;
    try {
      if (this.dropped) { const count = this.dropped; this.dropped = 0; await this.log.write("dropped", { count }); }
      await this.log.write("core", { level, historical, message: redactCoreMessage(message) });
    } finally { this.pending--; }
  }
  event(event: string): Promise<void> { return this.log.write(event); }
  flush(): Promise<void> { return this.log.flush(); }
}

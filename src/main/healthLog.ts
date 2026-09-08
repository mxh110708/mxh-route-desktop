import { appendFile, rename, stat, unlink } from "node:fs/promises";

export class HealthLog {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly maxBytes = 2 * 1024 * 1024) {}
  write(event: string, details: Record<string, unknown> = {}): Promise<void> {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }) + "\n";
    const task = this.pending.catch(() => {}).then(async () => {
      const size = await stat(this.path).then(v => v.size, e => { if (e.code === "ENOENT") return 0; throw e; });
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        await unlink(this.path + ".1").catch(e => { if (e.code !== "ENOENT") throw e; });
        await rename(this.path, this.path + ".1").catch(e => { if (e.code !== "ENOENT") throw e; });
      }
      await appendFile(this.path, line);
    });
    this.pending = task;
    return task;
  }
}

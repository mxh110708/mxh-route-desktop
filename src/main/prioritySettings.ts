import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

import type { PrioritySettings } from "../shared/priority";
export type { PrioritySettings } from "../shared/priority";

// Initial defaults only: no provider names or priorities are inferred by the application.
export const DEFAULT_PRIORITY_SETTINGS: PrioritySettings = {
  enabled: true, group: "", order: [], failureRounds: 3,
  backupSuccessRounds: 2, recoverySuccessRounds: 3, recoveryStableMs: 120000,
  failbackCooldownMs: 60000,
  probeTimeoutMs: 8000, healthyIntervalMs: 30000, failureIntervalMs: 10000,
};

export function parsePrioritySettings(value: unknown): PrioritySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("故障切换配置必须是 JSON 对象");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_PRIORITY_SETTINGS, key)) throw new Error(`未知故障切换配置项：${key}`);
  const settings = { ...DEFAULT_PRIORITY_SETTINGS, ...input } as PrioritySettings;
  if (typeof settings.enabled !== "boolean" || typeof settings.group !== "string" || (settings.group !== "" && !settings.group.trim())) throw new Error("enabled 必须是布尔值，group 必须是分组名称或尚未选择的空字符串");
  if (!Array.isArray(settings.order) || settings.order.some(v => typeof v !== "string" || !v.trim()) || new Set(settings.order).size !== settings.order.length) throw new Error("order 必须是无重复节点名称的数组");
  for (const key of ["failureRounds", "backupSuccessRounds", "recoverySuccessRounds"] as const) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > 20) throw new Error(`${key} 必须为 1–20 的整数`);
  }
  for (const key of ["recoveryStableMs", "failbackCooldownMs"] as const) {
    if (!Number.isInteger(settings[key]) || settings[key] < 10000 || settings[key] > 3600000) throw new Error(`${key} 必须为 10000–3600000 的整数毫秒`);
  }
  for (const key of ["probeTimeoutMs", "healthyIntervalMs", "failureIntervalMs"] as const) {
    const min = key === "probeTimeoutMs" ? 1000 : 5000;
    const max = key === "probeTimeoutMs" ? 60000 : 600000;
    if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error(`${key} 必须为 ${min}–${max} 的整数毫秒`);
  }
  return { ...settings, order: [...settings.order] };
}

export async function loadPrioritySettings(path: string): Promise<PrioritySettings> {
  try { return parsePrioritySettings(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { await writeFile(path, JSON.stringify(DEFAULT_PRIORITY_SETTINGS, null, 2) + "\n", { flag: "wx" }); }
    catch (createError) { if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError; }
    return parsePrioritySettings(JSON.parse(await readFile(path, "utf8")));
  }
}

export async function prioritySettingsSnapshot(path: string): Promise<{ settings: PrioritySettings; revision: string }> {
  await loadPrioritySettings(path);
  const content = await readFile(path, "utf8");
  return { settings: parsePrioritySettings(JSON.parse(content)), revision: createHash("sha256").update(content).digest("hex") };
}

let settingsWrite: Promise<unknown> = Promise.resolve();
export function savePrioritySettings(path: string, value: unknown, expectedRevision: string): Promise<void> {
  const task = settingsWrite.catch(() => {}).then(async () => {
    const settings = parsePrioritySettings(value);
    if ((await prioritySettingsSnapshot(path)).revision !== expectedRevision) throw new Error("配置文件已在其他位置修改，请刷新后重试；未覆盖外部修改。");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { flag: "wx" });
      if ((await prioritySettingsSnapshot(path)).revision !== expectedRevision) throw new Error("保存期间配置文件发生变化，请刷新后重试。");
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  });
  settingsWrite = task;
  return task;
}

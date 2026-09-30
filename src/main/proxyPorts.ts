import { applyEdits, modify } from "jsonc-parser";
import { createServer } from "node:net";
import type { ProxyPortSettings } from "../shared/proxyPorts";
import { parseConfig } from "./runtimeConfig";

type Inbound = Record<string, unknown>;
const TYPES = ["mixed", "socks", "http"] as const;

function inbounds(content: string): Inbound[] {
  const value = parseConfig(content).inbounds;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("当前配置的入站格式不正确，请先在配置编辑器中检查。");
  }
  for (const type of TYPES) {
    if (value.filter((item) => item.type === type).length > 1) {
      throw new Error(`当前配置包含多个 ${type} 入站，请在配置编辑器中分别设置端口。`);
    }
  }
  return value;
}

function port(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error("端口必须是 1–65535 的整数。");
  }
  return value;
}

export function parseProxyPorts(value: unknown): ProxyPortSettings {
  if (!value || typeof value !== "object") throw new Error("端口设置格式不正确。");
  const candidate = value as Record<string, unknown>;
  const result = {} as ProxyPortSettings;
  const enabledPorts = new Set<number>();
  for (const type of TYPES) {
    const item = candidate[type] as { enabled?: unknown; port?: unknown } | undefined;
    if (!item || typeof item.enabled !== "boolean") throw new Error("端口开关格式不正确。");
    if (type === "mixed" && !item.enabled) throw new Error("混合端口供系统代理使用，必须保持启用。");
    const number = port(item.port);
    if (item.enabled && enabledPorts.has(number)) throw new Error("已启用的代理端口不能重复。");
    if (item.enabled) enabledPorts.add(number);
    if (type === "mixed") result.mixed = { enabled: true, port: number };
    else result[type] = { enabled: item.enabled, port: number };
  }
  return result;
}

export function readProxyPorts(content: string): ProxyPortSettings {
  const all = inbounds(content);
  const used = new Set(all.map((item) => item.listen_port));
  function nextPort(start: number): number {
    for (let i = 0; i < 65535; i++) {
      const number = (start - 1 + i) % 65535 + 1;
      if (!used.has(number)) { used.add(number); return number; }
    }
    throw new Error("没有可用的配置端口。");
  }
  const mixed = all.find((item) => item.type === "mixed");
  const mixedPort = mixed ? port(mixed.listen_port) : nextPort(2080);
  const result = { mixed: { enabled: true, port: mixedPort } } as ProxyPortSettings;
  for (const type of ["socks", "http"] as const) {
    const item = all.find((entry) => entry.type === type);
    result[type] = { enabled: !!item, port: item ? port(item.listen_port) : nextPort(mixedPort + 1) };
  }
  return result;
}

function address(item: Inbound): string {
  return typeof item.listen === "string" && item.listen !== "" ? item.listen : "127.0.0.1";
}

function overlaps(a: Inbound, b: Inbound): boolean {
  return a.listen_port === b.listen_port && (address(a) === address(b) ||
    ["::", "0.0.0.0"].includes(address(a)) || ["::", "0.0.0.0"].includes(address(b)));
}

export function prepareProxyPortConfig(content: string, input: unknown): string {
  const settings = parseProxyPorts(input);
  const all = inbounds(content);
  const result = all.filter((item) => !TYPES.includes(item.type as typeof TYPES[number]) ||
    settings[item.type as typeof TYPES[number]].enabled);
  const tags = new Set(all.map((item) => item.tag));
  for (const type of TYPES) {
    const setting = settings[type];
    if (!setting.enabled) continue;
    const existing = all.find((item) => item.type === type);
    let tag = `desktop-${type}-in`;
    for (let suffix = 2; tags.has(tag); suffix++) tag = `desktop-${type}-in-${suffix}`;
    tags.add(tag);
    const item = existing ? { ...existing, listen_port: setting.port } :
      { type, tag, listen: "127.0.0.1", listen_port: setting.port };
    const index = result.findIndex((other) => other.type === type);
    if (index >= 0) result[index] = item;
    else result.push(item);
  }
  for (const item of result.filter((entry) => TYPES.includes(entry.type as typeof TYPES[number]))) {
    if (result.some((other) => other !== item && overlaps(item, other))) {
      throw new Error(`端口 ${item.listen_port} 与配置中的其他入站冲突。`);
    }
  }
  return applyEdits(content, modify(content, ["inbounds"], result, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: content.includes("\r\n") ? "\r\n" : "\n" },
  }));
}

export async function assertProxyPortsAvailable(previous: string, next: string, running: boolean): Promise<void> {
  const old = inbounds(previous).filter((item) => TYPES.includes(item.type as typeof TYPES[number]));
  for (const item of inbounds(next).filter((entry) => TYPES.includes(entry.type as typeof TYPES[number]))) {
    // Existing listeners will be closed by the serialized reload and can be reused.
    if (running && old.some((entry) => overlaps(item, entry))) continue;
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => reject(new Error(
        error.code === "EADDRINUSE" ? `端口 ${item.listen_port} 已被其他程序占用。` :
          `无法使用端口 ${item.listen_port}（${error.code ?? "未知错误"}）。`,
      )));
      server.listen({ host: address(item), port: port(item.listen_port), exclusive: true }, () => {
        server.close((error) => error ? reject(error) : resolve());
      });
    });
  }
}

export async function commitProxyPortChange(previous: string, next: string, operation: {
  write(content: string): Promise<void>;
  apply?(content: string, rollback: boolean): Promise<void>;
  current(): boolean;
}): Promise<void> {
  if (!operation.current()) throw new Error("当前配置或代理状态已改变，请刷新后重试。");
  await operation.write(next);
  try {
    if (!operation.current()) throw new Error("端口操作已被其他配置或代理操作取消。");
    await operation.apply?.(next, false);
    if (!operation.current()) throw new Error("端口操作已被其他配置或代理操作取消。");
  } catch (error) {
    const failures: unknown[] = [error];
    try { await operation.write(previous); } catch (rollbackError) { failures.push(rollbackError); }
    if (operation.current() && operation.apply) {
      try { await operation.apply(previous, true); } catch (rollbackError) { failures.push(rollbackError); }
    }
    if (failures.length > 1) throw new AggregateError(failures, "端口修改和回退失败，请检查代理状态和配置。");
    throw error;
  }
}

// Preserve only the preferred-node lookup after a stopped, port-only edit.
// Do not change `hash`: old probe listeners must never be hydrated as current.
export function carryProxyPortPriorityPreference(saved: unknown, profile: string, previousHash: string, nextHash: string): Record<string, unknown> | null {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
  const value = saved as Record<string, unknown>;
  if (value.profile !== profile || (value.hash !== previousHash && value.portEditedHash !== previousHash)) return null;
  return { ...value, portEditedHash: nextHash };
}

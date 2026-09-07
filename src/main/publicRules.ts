import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseJSONC, type ParseError } from "jsonc-parser";

export const PUBLIC_RULE_BUNDLE_URL = "https://raw.githubusercontent.com/mxh110708/mxh-route-desktop/custom-main/resources/public-rules-v1.json";
export const PUBLIC_RULE_BUNDLE_SHA256 = "859c99058f5c9a481f01a8048dce72cf7ce1f623175c85815866b06e8fc29839";
const MAX_BYTES = 2 * 1024 * 1024;
export const PUBLIC_RULE_NAMES = ["geosite-category-ads-all", "geosite-private", "geosite-cn", "geoip-cn", "geosite-geolocation-not-cn"] as const;
type Rule = Record<string, unknown>;
type Config = { route?: { rule_set?: Rule[] } };
function hash(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }

export function publicRuleName(rule: Rule): string | undefined {
  return PUBLIC_RULE_NAMES.find((name) => {
    const geo = name.startsWith("geoip-") ? "geoip" : "geosite";
    const leaf = name.replace(/^geo(?:site|ip)-/u, "").replace("geolocation-not-cn", "geolocation-!cn");
    return rule.type === "remote" && rule.tag === name && rule.format === "binary" &&
      rule.url === `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/${geo}/${leaf}.srs`;
  });
}
function parse(content: string): Config | undefined {
  const errors: ParseError[] = [];
  const value = parseJSONC(content, errors, { allowTrailingComma: true });
  return errors.length === 0 && value && typeof value === "object" ? value : undefined;
}
export function portablePublicRules(content: string): string {
  const config = parse(content);
  if (!Array.isArray(config?.route?.rule_set)) return content;
  let changed = false;
  for (const rule of config.route.rule_set) {
    if (rule && publicRuleName(rule) && "initial_path" in rule) { delete rule.initial_path; changed = true; }
  }
  return changed ? JSON.stringify(config) : content;
}

function decodeBundle(data: Buffer): Map<string, Buffer> {
  if (data.length > MAX_BYTES || hash(data) !== PUBLIC_RULE_BUNDLE_SHA256) throw new Error("公共规则包校验失败，未使用下载内容。");
  const value = JSON.parse(data.toString("utf8"));
  if (value.version !== 1 || !Array.isArray(value.files) || value.files.length !== PUBLIC_RULE_NAMES.length) throw new Error("Invalid public rule bundle");
  const files = new Map<string, Buffer>();
  for (const file of value.files) {
    if (!PUBLIC_RULE_NAMES.includes(file.name) || files.has(file.name) || typeof file.data !== "string") throw new Error("Invalid public rule name");
    const body = Buffer.from(file.data, "base64");
    if (hash(body) !== file.sha256 || body.subarray(0, 3).toString() !== "SRS") throw new Error("Invalid public SRS digest");
    files.set(file.name, body);
  }
  return files;
}

async function atomic(path: string, data: Buffer): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, data); await rename(temp, path); } finally { await unlink(temp).catch(() => {}); }
}

export class PublicRuleCache {
  private pending: Promise<Map<string, string>> | undefined;
  constructor(private readonly directory: string, private readonly request: typeof fetch = fetch) {}

  private async load(): Promise<Map<string, string>> {
    const directory = join(this.directory, PUBLIC_RULE_BUNDLE_SHA256);
    await mkdir(directory, { recursive: true });
    const bundlePath = join(directory, "bundle.json");
    let data: Buffer | undefined;
    try { data = await readFile(bundlePath); decodeBundle(data); } catch { data = undefined; }
    if (!data) {
      try {
        // Only a fixed public GET. No profile content, node address, credential or user URL is sent.
        const response = await this.request(PUBLIC_RULE_BUNDLE_URL, { signal: AbortSignal.timeout(30_000), redirect: "error" });
        if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) throw new Error("download failed");
        const chunks: Buffer[] = []; let size = 0;
        const reader = response.body.getReader();
        for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > MAX_BYTES) { await reader.cancel(); throw new Error("bundle too large"); } chunks.push(Buffer.from(item.value)); }
        data = Buffer.concat(chunks); decodeBundle(data); await atomic(bundlePath, data);
      } catch { throw new Error("无法下载或校验公共规则包，且没有有效缓存。请联网后重试；私人配置未上传。"); }
    }
    const paths = new Map<string, string>();
    for (const [name, body] of decodeBundle(data)) {
      const path = join(directory, `${name}.srs`);
      let valid = false;
      try { valid = hash(await readFile(path)) === hash(body); } catch { /* missing cache */ }
      if (!valid) await atomic(path, body);
      paths.set(name, path);
    }
    return paths;
  }

  async prepare(content: string): Promise<string> {
    const config = parse(content);
    if (!Array.isArray(config?.route?.rule_set)) return content;
    const rules = config.route.rule_set.filter((rule) => rule && publicRuleName(rule));
    if (!rules.length) return content;
    // Coalesce simultaneous imports but revalidate disk files on each later start.
    const operation = this.pending ??= this.load();
    let paths: Map<string, string>;
    try { paths = await operation; } finally { if (this.pending === operation) this.pending = undefined; }
    for (const rule of rules) rule.initial_path = paths.get(publicRuleName(rule)!);
    return JSON.stringify(config);
  }
}

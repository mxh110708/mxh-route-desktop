import {
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";

export type CaptureMode = "system-proxy" | "tun";

type JsonObject = Record<string, unknown>;

const CONTROL_ACTIONS = new Set(["sniff", "resolve", "hijack-dns"]);
const SYSTEM_PROXY_BYPASS = ["localhost", "127.*", "[::1]", "<local>"];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function parseConfig(content: string): JsonObject {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `unable to prepare runtime configuration: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  if (!isObject(parsed)) {
    throw new Error("unable to prepare runtime configuration: top-level value is not an object");
  }
  return parsed;
}

export function parseCaptureMode(value: unknown): CaptureMode {
  if (value !== "system-proxy" && value !== "tun") {
    throw new Error("invalid capture mode");
  }
  return value;
}

function outboundTag(outbounds: JsonObject[], preferred: string[]): string | null {
  for (const tag of preferred) {
    if (outbounds.some((outbound) => outbound.tag === tag)) {
      return tag;
    }
  }
  return null;
}

function directOutboundTag(outbounds: JsonObject[]): string | null {
  return (
    outboundTag(outbounds, ["DIRECT", "Direct"]) ??
    (outbounds.find((outbound) => outbound.type === "direct")?.tag as string | undefined) ??
    null
  );
}

function globalOutboundTag(outbounds: JsonObject[]): string | null {
  return (
    outboundTag(outbounds, ["Final Exit", "Proxy", "GLOBAL"]) ??
    (outbounds.find((outbound) => outbound.type === "selector")?.tag as string | undefined) ??
    null
  );
}

function ruleContainsMode(rule: JsonObject, mode: string): boolean {
  if (typeof rule.clash_mode === "string" && rule.clash_mode.toLowerCase() === mode.toLowerCase()) {
    return true;
  }
  return objectArray(rule.rules).some((nested) => ruleContainsMode(nested, mode));
}

function ensureTrafficModes(config: JsonObject): boolean {
  const outbounds = objectArray(config.outbounds);
  const globalTag = globalOutboundTag(outbounds);
  const directTag = directOutboundTag(outbounds);
  if (globalTag === null || directTag === null) {
    return false;
  }

  const route = isObject(config.route) ? config.route : {};
  config.route = route;
  const rules = objectArray(route.rules);
  route.rules = rules;

  let insertAt = 0;
  while (insertAt < rules.length) {
    const action = rules[insertAt].action;
    if (typeof action !== "string" || !CONTROL_ACTIONS.has(action)) {
      break;
    }
    insertAt += 1;
  }

  const injected: JsonObject[] = [];
  if (!rules.some((rule) => ruleContainsMode(rule, "Global"))) {
    injected.push({ clash_mode: "Global", action: "route", outbound: globalTag });
  }
  if (!rules.some((rule) => ruleContainsMode(rule, "Direct"))) {
    injected.push({ clash_mode: "Direct", action: "route", outbound: directTag });
  }
  rules.splice(insertAt, 0, ...injected);

  const dns = isObject(config.dns) ? config.dns : null;
  if (dns === null) {
    return true;
  }
  const servers = objectArray(dns.servers);
  if (servers.length === 0) {
    return true;
  }
  dns.servers = servers;
  const serverTags = new Set(
    servers.map((server) => server.tag).filter((tag): tag is string => typeof tag === "string"),
  );
  const configuredFinal = typeof dns.final === "string" ? dns.final : null;
  const remoteTag =
    (configuredFinal !== null && serverTags.has(configuredFinal) ? configuredFinal : null) ??
    (servers.find((server) => typeof server.tag === "string")?.tag as string | undefined) ??
    null;
  if (remoteTag === null) {
    return true;
  }
  let localTag = servers.find(
    (server) => server.type === "local" && typeof server.tag === "string",
  )?.tag as string | undefined;
  if (localTag === undefined) {
    localTag = "desktop-local";
    let suffix = 2;
    while (serverTags.has(localTag)) {
      localTag = `desktop-local-${suffix}`;
      suffix += 1;
    }
    servers.push({ type: "local", tag: localTag });
  }
  if (route.default_domain_resolver === undefined) {
    route.default_domain_resolver = localTag;
  }

  const dnsRules = objectArray(dns.rules);
  dns.rules = dnsRules;
  const dnsInjected: JsonObject[] = [];
  if (!dnsRules.some((rule) => ruleContainsMode(rule, "Global"))) {
    dnsInjected.push({ clash_mode: "Global", action: "route", server: remoteTag });
  }
  if (!dnsRules.some((rule) => ruleContainsMode(rule, "Direct"))) {
    dnsInjected.push({ clash_mode: "Direct", action: "route", server: localTag });
  }
  dnsRules.unshift(...dnsInjected);
  return true;
}

function systemProxyAddress(mixed: JsonObject): { server: string; server_port: number } {
  const port = mixed.listen_port;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("system proxy mode requires a mixed inbound with a valid listen_port");
  }
  const listen = typeof mixed.listen === "string" ? mixed.listen : "127.0.0.1";
  let server: string;
  switch (listen) {
    case "":
    case "0.0.0.0":
      server = "127.0.0.1";
      break;
    case "::":
      server = "::1";
      break;
    default:
      server = listen;
      break;
  }
  return { server, server_port: port };
}

function configureCaptureMode(config: JsonObject, mode: CaptureMode): void {
  const inbounds = objectArray(config.inbounds);
  config.inbounds = inbounds;
  const tun = inbounds.find((inbound) => inbound.type === "tun");
  if (tun === undefined) {
    throw new Error("capture mode switching requires a TUN inbound");
  }

  const existingPlatform = isObject(tun.platform) ? tun.platform : {};
  const platform = { ...existingPlatform };
  if (mode === "tun") {
    delete platform.http_proxy;
    if (Object.keys(platform).length === 0) {
      delete tun.platform;
    } else {
      tun.platform = platform;
    }
    return;
  }

  const mixed = inbounds.find((inbound) => inbound.type === "mixed");
  if (mixed === undefined) {
    throw new Error("system proxy mode requires a mixed inbound");
  }
  const proxyAddress = systemProxyAddress(mixed);
  tun.auto_route = false;
  tun.auto_redirect = false;
  tun.strict_route = false;
  platform.http_proxy = {
    enabled: true,
    ...proxyAddress,
    bypass_domain: SYSTEM_PROXY_BYPASS,
  };
  tun.platform = platform;
}

export function buildRuntimeConfig(content: string, mode: CaptureMode): string {
  const config = parseConfig(content);
  ensureTrafficModes(config);
  configureCaptureMode(config, mode);
  return JSON.stringify(config);
}

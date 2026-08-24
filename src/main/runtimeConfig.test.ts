import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeConfig,
  parseCaptureMode,
  readSystemProxyEndpoint,
} from "./runtimeConfig";

function sample(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    dns: {
      servers: [{ type: "https", tag: "dns-remote", server: "1.1.1.1", detour: "Final Exit" }],
      final: "dns-remote",
    },
    inbounds: [
      { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080 },
      { type: "tun", tag: "tun-in", auto_route: true, strict_route: true },
    ],
    outbounds: [
      { type: "selector", tag: "Final Exit", outbounds: ["DIRECT"] },
      { type: "direct", tag: "DIRECT" },
    ],
    route: {
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
        { domain_suffix: ["example.com"], action: "route", outbound: "Final Exit" },
      ],
      final: "Final Exit",
    },
    ...overrides,
  });
}

test("system proxy mode keeps official control rules first and disables TUN routing", () => {
  const config = JSON.parse(buildRuntimeConfig(sample(), "system-proxy"));
  assert.deepEqual(
    config.route.rules.slice(0, 4).map((rule: Record<string, unknown>) => rule.action),
    ["sniff", "hijack-dns", "route", "route"],
  );
  assert.equal(config.route.rules[2].clash_mode, "Global");
  assert.equal(config.route.rules[3].clash_mode, "Direct");
  const tun = config.inbounds.find((inbound: Record<string, unknown>) => inbound.type === "tun");
  assert.equal(tun.auto_route, false);
  assert.equal(tun.strict_route, false);
  assert.deepEqual(tun.platform.http_proxy, {
    enabled: true,
    server: "127.0.0.1",
    server_port: 2080,
    bypass_domain: ["localhost", "127.*", "[::1]", "<local>"],
  });
  assert.equal(config.dns.rules[0].clash_mode, "Global");
  assert.equal(config.dns.rules[1].clash_mode, "Direct");
  assert.equal(config.dns.servers.at(-1).type, "local");
  assert.equal(config.route.default_domain_resolver, config.dns.servers.at(-1).tag);
});

test("Default Exit is preferred for the injected global mode", () => {
  const source = JSON.parse(sample());
  source.outbounds.unshift({ type: "selector", tag: "Default Exit", outbounds: ["DIRECT"] });
  const config = JSON.parse(buildRuntimeConfig(JSON.stringify(source), "system-proxy"));
  const globalRule = config.route.rules.find(
    (rule: Record<string, unknown>) => rule.clash_mode === "Global",
  );
  assert.equal(globalRule.outbound, "Default Exit");
});

test("system proxy endpoint is read from the mixed inbound", () => {
  assert.deepEqual(readSystemProxyEndpoint(sample()), {
    server: "127.0.0.1",
    port: 2080,
  });
});

test("TUN mode removes platform HTTP proxy while preserving other platform options", () => {
  const source = JSON.parse(sample());
  source.inbounds[1].platform = {
    custom_option: true,
    http_proxy: { enabled: true, server: "127.0.0.1", server_port: 2080 },
  };
  const config = JSON.parse(buildRuntimeConfig(JSON.stringify(source), "tun"));
  const tun = config.inbounds.find((inbound: Record<string, unknown>) => inbound.type === "tun");
  assert.deepEqual(tun.platform, { custom_option: true });
  assert.equal(tun.auto_route, true);
  assert.equal(tun.strict_route, true);
});

test("existing mode rules are not duplicated", () => {
  const source = JSON.parse(sample());
  source.route.rules.splice(2, 0,
    { clash_mode: "Global", action: "route", outbound: "Final Exit" },
    { clash_mode: "Direct", action: "route", outbound: "DIRECT" },
  );
  source.dns.rules = [
    { clash_mode: "Global", action: "route", server: "dns-remote" },
    { clash_mode: "Direct", action: "route", server: "dns-remote" },
  ];
  const config = JSON.parse(buildRuntimeConfig(JSON.stringify(source), "tun"));
  assert.equal(config.route.rules.filter((rule: Record<string, unknown>) => rule.clash_mode === "Global").length, 1);
  assert.equal(config.route.rules.filter((rule: Record<string, unknown>) => rule.clash_mode === "Direct").length, 1);
  assert.equal(config.dns.rules.filter((rule: Record<string, unknown>) => rule.clash_mode === "Global").length, 1);
  assert.equal(config.dns.rules.filter((rule: Record<string, unknown>) => rule.clash_mode === "Direct").length, 1);
});

test("an explicit default domain resolver is preserved", () => {
  const source = JSON.parse(sample());
  source.route.default_domain_resolver = "dns-remote";
  const config = JSON.parse(buildRuntimeConfig(JSON.stringify(source), "tun"));
  assert.equal(config.route.default_domain_resolver, "dns-remote");
});

test("JSON with comments and trailing commas is accepted and compacted", () => {
  const source = `{
    // a desktop profile
    "inbounds": [
      { "type": "mixed", "listen_port": 2080 },
      { "type": "tun", "auto_route": true },
    ],
    "outbounds": [{ "type": "direct", "tag": "DIRECT" }],
  }`;
  const runtime = buildRuntimeConfig(source, "tun");
  assert.doesNotMatch(runtime, /\n/);
  assert.equal(JSON.parse(runtime).inbounds.length, 2);
});

test("system proxy mode requires a mixed inbound", () => {
  const source = JSON.parse(sample());
  source.inbounds = source.inbounds.filter((inbound: Record<string, unknown>) => inbound.type !== "mixed");
  assert.throws(() => buildRuntimeConfig(JSON.stringify(source), "system-proxy"), /mixed inbound/);
});

test("capture mode parsing rejects unknown values", () => {
  assert.equal(parseCaptureMode("system-proxy"), "system-proxy");
  assert.equal(parseCaptureMode("tun"), "tun");
  assert.throws(() => parseCaptureMode("automatic"), /invalid capture mode/);
});

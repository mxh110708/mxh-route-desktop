import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = resolve(repositoryRoot, "..", "sing-box");

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function coreSource(path: string): string {
  return readFileSync(resolve(coreRoot, path), "utf8");
}

test("the custom installer cannot target the official service or data directories", () => {
  const installer = source("build/installer.nsh");
  const preflight = source("build/installer-preflight.ps1");

  assert.match(installer, /Software\\SagerNet\\sing-box-custom/u);
  assert.match(installer, /Get-Service -Name sing-box-custom-daemon/u);
  assert.match(installer, /\$APPDATA\\sing-box-custom-daemon/u);
  assert.match(installer, /\$APPDATA\\sing-box-custom/u);
  assert.doesNotMatch(installer, /Get-Service -Name sing-box-daemon(?:\s|")/u);
  assert.doesNotMatch(installer, /"\$APPDATA\\sing-box-daemon"/u);
  assert.doesNotMatch(installer, /"\$APPDATA\\sing-box"/u);

  assert.match(preflight, /Get-ServiceSid "sing-box-custom-daemon"/u);
  assert.match(preflight, /"sing-box-custom-daemon"/u);
  assert.doesNotMatch(preflight, /Get-ServiceSid "sing-box-daemon"/u);
  assert.doesNotMatch(preflight, /Join-Path \$commonApplicationData "sing-box-daemon"/u);
});

test("the custom package does not claim official profile associations or update channel", () => {
  const builder = source("electron-builder.custom.yml");
  const index = source("src/main/index.ts");
  const tray = source("src/main/tray.ts");
  const updates = source("src/main/updates.ts");

  assert.match(builder, /productName: sing-box Custom/u);
  assert.match(builder, /appId: io\.nekohasekai\.sfw\.custom/u);
  assert.match(builder, /fileAssociations: \[\]/u);
  assert.match(
    index,
    /if \(!__CUSTOM_BUILD__\) \{\s*app\.setAsDefaultProtocolClient\("sing-box"\);\s*\}/u,
  );
  assert.match(index, /title: __CUSTOM_BUILD__ \? "sing-box Custom" : "sing-box"/u);
  assert.match(tray, /APPLICATION_LABEL = __CUSTOM_BUILD__ \? "sing-box Custom" : "sing-box"/u);
  assert.match(updates, /releasesURL\(__CUSTOM_BUILD__\)/u);
  assert.match(updates, /isTrustedDownloadURL\(__CUSTOM_BUILD__, info\.downloadURL\)/u);
  const updateSource = source("src/main/updateSource.ts");
  assert.match(
    updateSource,
    /api\.github\.com\/repos\/mxh110708\/sing-box-for-desktop-custom\/releases/u,
  );
  assert.match(updateSource, /sing-box-Custom-\$\{version\}-windows-x64/u);
  assert.doesNotMatch(updateSource, /BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/u);

  const packageScript = source("scripts/package.ts");
  assert.match(packageScript, /electron-builder\.custom\.yml/u);
  assert.match(packageScript, /sing-box-Custom-\\\$\{version\}-windows-/u);
  assert.match(packageScript, /custom Windows packages currently support only x64/u);
  assert.match(updates, /unsafe update installation fallback is disabled for custom builds/u);
});

test("desktop and daemon identities are parallel to the official installation", () => {
  const paths = source("src/main/installationLayout.ts");
  const daemonClient = source("src/main/daemon.ts");
  const workerClient = source("src/main/worker.ts");
  const daemonMain = coreSource("experimental/boxdd/main.go");
  const daemonServer = coreSource("experimental/boxdd/server_windows.go");
  const daemonPeer = coreSource("experimental/boxdd/peer_windows.go");

  assert.match(paths, /SOFTWARE\\SagerNet\\sing-box-custom/u);
  assert.match(paths, /sing-box-custom-daemon/u);
  assert.match(daemonClient, /Administrators\\\\sing-box-custom/u);
  assert.match(workerClient, /sing-box-custom-worker/u);
  assert.match(daemonMain, /serviceName = "sing-box-custom-daemon"/u);
  assert.match(daemonServer, /Administrators\\sing-box-custom/u);
  assert.match(daemonPeer, /applicationExecutableName\s+= "sing-box Custom\.exe"/u);
  assert.match(daemonPeer, /workerPipePrefix\s+= `\\\\\.\\pipe\\sing-box-custom-worker\.`/u);
});

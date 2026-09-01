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
  const migration = source("build/installer-data.ps1");

  assert.match(installer, /Software\\MXH\\Route/u);
  assert.match(installer, /Get-Service -Name mxh-route-daemon/u);
  assert.match(installer, /\$APPDATA\\mxh-route-daemon/u);
  assert.match(installer, /\$APPDATA\\mxh-route/u);
  assert.doesNotMatch(installer, /Get-Service -Name sing-box-daemon(?:\s|")/u);
  assert.doesNotMatch(installer, /"\$APPDATA\\sing-box-daemon"/u);
  assert.doesNotMatch(installer, /"\$APPDATA\\sing-box"/u);

  assert.match(preflight, /Get-ServiceSid "mxh-route-daemon"/u);
  assert.match(preflight, /"mxh-route-daemon"/u);
  assert.doesNotMatch(preflight, /Get-ServiceSid "sing-box-daemon"/u);
  assert.doesNotMatch(preflight, /Join-Path \$commonApplicationData "sing-box-daemon"/u);
  assert.match(migration, /Join-Path \$commonApplicationData "mxh-route-installer"/u);
  assert.match(migration, /AppData\\Roaming\\mxh-route/u);
  assert.match(migration, /mxh-route\.installation-id/u);
  assert.doesNotMatch(migration, /AppData\\Roaming\\sing-box(?:-for-desktop)?/u);
  assert.doesNotMatch(migration, /Join-Path \$commonApplicationData "sing-box-installer"/u);
});

test("orphaned application data recovery remains narrowly gated", () => {
  const installer = source("build/installer.nsh");
  const preflight = source("build/installer-preflight.ps1");

  assert.match(preflight, /\[Guid\]::TryParse\(\$ID, \[ref\]\$parsedID\)/u);
  assert.match(
    preflight,
    /\$AllowOrphanedRecovery -and \(Test-InstallationID \$existingID\)/u,
  );
  assert.match(
    installer,
    /\$hasExistingInstallation == 0[\s\S]+\$hasInstallationLayout == 0[\s\S]+-AdoptOrphanedApplicationDataDirectory/u,
  );
  assert.match(
    installer,
    /!macro customUnInstallSection[\s\S]+Section "-Preserve MXH Route application data layout"[\s\S]+\$keepUninstallData == \$\{BST_CHECKED\}[\s\S]+WriteRegStr HKLM "\$\{INSTALLATION_LAYOUT_REGISTRY_KEY\}" "InstallationID"[\s\S]+SectionEnd/u,
  );
  assert.match(installer, /\$\(keepData\)[\s\S]+\$\(deleteData\)/u);
  assert.match(installer, /NSD_CreateRadioButton[\s\S]+NSD_CreateRadioButton/u);
});

test("the custom package does not claim official profile associations or update channel", () => {
  const builder = source("electron-builder.custom.yml");
  const index = source("src/main/index.ts");
  const tray = source("src/main/tray.ts");
  const updates = source("src/main/updates.ts");

  assert.match(builder, /productName: MXH Route/u);
  assert.match(builder, /appId: io\.mxh\.route/u);
  assert.match(builder, /fileAssociations: \[\]/u);
  assert.match(
    index,
    /if \(!__CUSTOM_BUILD__\) \{[\s\S]*?app\.setAsDefaultProtocolClient\("sing-box"\);[\s\S]*?app\.on\("second-instance"/u,
  );
  assert.match(index, /title: __CUSTOM_BUILD__ \? "MXH Route" : "sing-box"/u);
  assert.match(tray, /APPLICATION_LABEL = __CUSTOM_BUILD__ \? "MXH Route" : "sing-box"/u);
  assert.match(updates, /releasesURL\(__CUSTOM_BUILD__\)/u);
  assert.match(updates, /isTrustedDownloadURL\(__CUSTOM_BUILD__, info\.downloadURL\)/u);
  const updateSource = source("src/main/updateSource.ts");
  assert.match(
    updateSource,
    /api\.github\.com\/repos\/mxh110708\/mxh-route-desktop\/releases/u,
  );
  assert.match(updateSource, /MXH-Route-\$\{version\}-windows-x64/u);
  assert.doesNotMatch(updateSource, /BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/u);

  const packageScript = source("scripts/package.ts");
  assert.match(packageScript, /electron-builder\.custom\.yml/u);
  assert.match(packageScript, /MXH-Route-\\\$\{version\}-windows-/u);
  assert.match(packageScript, /custom Windows packages currently support only x64/u);
  assert.match(packageScript, /runPnpm\(\["icons"\]\)/u);
  assert.match(packageScript, /SING_BOX_CUSTOM_CERTIFICATE_FILE/u);
  assert.match(packageScript, /SING_BOX_CUSTOM_CERTIFICATE_PASSWORD_FILE/u);
  assert.match(packageScript, /SING_BOX_ELECTRON_DIST/u);
  assert.match(updates, /unsafe update installation fallback is disabled for custom builds/u);

  const versionScript = source("scripts/version.ts");
  assert.match(versionScript, /custom-version\.json/u);
  assert.match(versionScript, /\.mxh\.\$\{customMetadata\.revision\}/u);

  const iconScript = source("scripts/icons.ts");
  assert.match(iconScript, /sing-box["', ]+[\s\S]+docs["', ]+[\s\S]+assets["', ]+[\s\S]+icon\.svg/u);
  assert.doesNotMatch(iconScript, /mxh-route-icon\.svg/u);

  const dashboardApp = source("dashboard/src/App.tsx");
  const dashboardTray = source("dashboard/src/TrayMenu.tsx");
  const dashboardSettings = source("dashboard/src/views/SettingsView.tsx");
  const dashboardTaildrop = source("dashboard/src/views/TaildropView.tsx");
  assert.ok(dashboardApp.includes("className={styles.mobileTopbarBrand}>MXH Route</div>"));
  assert.ok(dashboardTray.includes("className={styles.title}>MXH Route</span>"));
  assert.match(dashboardSettings, /github\.com\/mxh110708\/mxh-route-desktop/u);
  assert.match(dashboardSettings, /github\.com\/mxh110708\/mxh-route-dashboard/u);
  assert.match(dashboardTaildrop, /The MXH Route service is not running/u);
  assert.doesNotMatch(dashboardTaildrop, /The sing-box service is not running/u);
});

test("desktop and daemon identities are parallel to the official installation", () => {
  const paths = source("src/main/installationLayout.ts");
  const daemonClient = source("src/main/daemon.ts");
  const workerClient = source("src/main/worker.ts");
  const daemonMain = coreSource("experimental/boxdd/main.go");
  const daemonServer = coreSource("experimental/boxdd/server_windows.go");
  const daemonPeer = coreSource("experimental/boxdd/peer_windows.go");
  const daemonUpdate = coreSource("experimental/boxdd/update_windows.go");

  assert.match(paths, /SOFTWARE\\MXH\\Route/u);
  assert.match(paths, /mxh-route-daemon/u);
  assert.match(daemonClient, /Administrators\\\\mxh-route/u);
  assert.match(workerClient, /mxh-route-worker/u);
  assert.match(daemonMain, /serviceName = "mxh-route-daemon"/u);
  assert.match(daemonServer, /Administrators\\mxh-route/u);
  assert.match(daemonPeer, /applicationExecutableName\s+= "MXH Route\.exe"/u);
  assert.match(daemonPeer, /workerPipePrefix\s+= `\\\\\.\\pipe\\mxh-route-worker\.`/u);
  assert.match(daemonUpdate, /updateProductName\s+= "MXH Route"/u);
});

test("the custom daemon exposes single-item selector groups", () => {
  const startedService = coreSource("daemon/started_service.go");
  assert.match(startedService, /if len\(g\.Items\) == 0 \{/u);
  assert.doesNotMatch(startedService, /if len\(g\.Items\) < 2 \{/u);
});

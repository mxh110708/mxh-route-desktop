import assert from "node:assert/strict";
import test from "node:test";

import {
  isChannelVersion,
  isTrustedDownloadURL,
  releasesURL,
  selectWindowsAsset,
  updatesSupported,
  type UpdateAsset,
} from "./updateSource";

const customAsset: UpdateAsset = {
  name: "sing-box-Custom-1.14.0-beta.14-custom.2-windows-x64.exe",
  browser_download_url:
    "https://github.com/mxh110708/sing-box-for-desktop-custom/releases/download/v1.14.0-beta.14-custom.2/sing-box-Custom-1.14.0-beta.14-custom.2-windows-x64.exe",
  size: 1,
};

test("custom builds use only the personal public release channel", () => {
  assert.equal(
    releasesURL(true),
    "https://api.github.com/repos/mxh110708/sing-box-for-desktop-custom/releases",
  );
  assert.equal(
    releasesURL(false),
    "https://api.github.com/repos/SagerNet/sing-box/releases",
  );
});

test("custom updates are limited to the packaged Windows architecture", () => {
  assert.equal(updatesSupported(true, "win32", "x64"), true);
  assert.equal(updatesSupported(true, "win32", "arm64"), false);
  assert.equal(updatesSupported(true, "linux", "x64"), false);
});

test("custom builds reject official versions and installer names", () => {
  assert.equal(isChannelVersion(true, "1.14.0-beta.14"), false);
  assert.equal(isChannelVersion(true, "1.14.0-beta.14-custom.2"), true);
  assert.equal(
    selectWindowsAsset(true, "x64", "1.14.0-beta.14-custom.2", [customAsset]),
    customAsset,
  );
  assert.equal(
    selectWindowsAsset(true, "x64", "1.14.0-beta.14-custom.2", [
      { ...customAsset, name: "SFW-1.14.0-beta.14-x64.exe" },
    ]),
    null,
  );
  assert.equal(
    selectWindowsAsset(true, "x64", "1.14.0-beta.14-custom.3", [customAsset]),
    null,
  );
});

test("custom downloads must remain inside the personal GitHub release path", () => {
  assert.equal(isTrustedDownloadURL(true, customAsset.browser_download_url), true);
  assert.equal(
    isTrustedDownloadURL(
      true,
      "https://github.com/SagerNet/sing-box/releases/download/v1.14.0-beta.14/SFW-1.14.0-beta.14-x64.exe",
    ),
    false,
  );
  assert.equal(isTrustedDownloadURL(true, "https://example.com/update.exe"), false);
});

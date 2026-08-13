import assert from "node:assert/strict";
import test from "node:test";
import { gt } from "semver";

import {
  isChannelVersion,
  isTrustedDownloadURL,
  releasesURL,
  selectWindowsAsset,
  updatesSupported,
  type UpdateAsset,
} from "./updateSource";

const customAsset: UpdateAsset = {
  name: "MXH-Route-1.14.0-beta.14.mxh.2-windows-x64.exe",
  browser_download_url:
    "https://github.com/mxh110708/mxh-route-desktop/releases/download/v1.14.0-beta.14.mxh.2/MXH-Route-1.14.0-beta.14.mxh.2-windows-x64.exe",
  size: 1,
};

test("custom builds use only the personal public release channel", () => {
  assert.equal(
    releasesURL(true),
    "https://api.github.com/repos/mxh110708/mxh-route-desktop/releases",
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
  assert.equal(isChannelVersion(true, "1.14.0-beta.14.mxh.2"), true);
  assert.equal(
    selectWindowsAsset(true, "x64", "1.14.0-beta.14.mxh.2", [customAsset]),
    customAsset,
  );
  assert.equal(
    selectWindowsAsset(true, "x64", "1.14.0-beta.14.mxh.2", [
      { ...customAsset, name: "SFW-1.14.0-beta.14-x64.exe" },
    ]),
    null,
  );
  assert.equal(
    selectWindowsAsset(true, "x64", "1.14.0-beta.14.mxh.3", [customAsset]),
    null,
  );
});

test("custom semantic versions preserve upstream and revision ordering", () => {
  assert.equal(
    gt("1.14.0-beta.14.mxh.10", "1.14.0-beta.14.mxh.2"),
    true,
  );
  assert.equal(
    gt("1.14.0-beta.15.mxh.1", "1.14.0-beta.14.mxh.99"),
    true,
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

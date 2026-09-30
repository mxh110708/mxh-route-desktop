# Public rule bootstrap cache

MXH Route recognizes the five MetaCubeX remote binary rule sets used by the
private authority configuration. On import validation and service start it
uses a verified application cache first, then the public bootstrap bundle
shipped with the application. Only when neither local copy is valid does it
download `resources/public-rules-v1.json` from this repository using a fixed
public GET. The bundle contains public SRS data only, never a user profile.
The compiled-in SHA-256 pins the bootstrap bundle. Payload size, file names,
per-file digests and SRS signatures are validated before use. There is no ZIP
extraction and no profile-supplied download URL for the bootstrap package.

Verified files are stored under the application's user-data directory in
`public-rule-cache/<bundle-sha256>/`. Runtime-only `initial_path` values point
there. Saved/imported JSON and exported JSON/BPF omit these machine-specific
paths for recognized rule sets. Other rule sets and user files are untouched.
Existing profiles with the old absolute paths are supported at runtime too.

## Offline first import

The installer includes `resources/public-rules-v1.json` (less than 1 MiB) at
the root of the installed application's resource directory. The development
build uses the repository's `resources` directory. Both paths use the same
compiled-in digest and validation as a downloaded bundle.

A new computer with no proxy and no cache can import its private local JSON
and start the proxy without reaching GitHub first. The installed public
bundle is copied into the cache, verified SRS files are extracted, and their
`initial_path` values are used for validation/startup only. The installer
resource is read-only to this code: it is never edited or used to store private
configuration or node credentials.

Later imports and starts use a verified cache without network requests. Damaged
individual SRS files are rebuilt from the verified cached bundle. A missing or
damaged cached bundle, including a completely cleared cache, can be restored
from the installed seed while offline. Clearing the cache therefore does not
reintroduce a dependency on an already-running proxy.

If the cache and installed seed are both missing/invalid, the fixed public
download remains a recovery fallback. If that download is unavailable or fails
validation, the operation fails closed and asks the user to reinstall the
complete application or retry with network access. It never bypasses rule
validation, changes unknown/custom rule sets, or uploads private configuration.
Arbitrary custom remote rule sets are not covered by this allowlisted offline
bootstrap and retain their original behavior.

The sing-box core still uses each original remote URL and daily update interval;
this package only provides initial data, not a replacement update mechanism.
Moving to another computer requires only the private JSON and a compatible
MXH Route installer containing the public bootstrap bundle; the cache is
initialized there automatically even without an already-running proxy.
Other sing-box clients ignore no custom fields because none are added: they
simply download the original remote rule sets without an initial local file.

## Maintainer procedure

Source: https://github.com/MetaCubeX/meta-rules-dat/tree/sing

Generate with `node --import tsx scripts/buildPublicRuleBundle.ts <public-srs-dir>`.
Only five allowlisted SRS files are read. Review upstream provenance/licensing,
update `PUBLIC_RULE_BUNDLE_SHA256`, and run `pnpm test:public-rules` before release.
Never substitute any private profile or private archive for the public SRS input.
Every packaging entry point validates the bundled data before building, and
`afterPack` verifies that the packaged resource matches the verified source.
The base `electron-builder.yml` explicitly includes this one public JSON file;
the custom installer inherits that resource entry. Do not add wildcard private
configuration directories to package resources.

Keep the public download fallback available for clients that pin its digest.
When changing the bootstrap data, publish an immutable versioned URL and update
the client's URL/digest together rather than invalidating older clients' pinned
downloads. The core's regular remote updates do not modify this bootstrap seed.

## Verification (2026-09-30)

- 14 cache/package regression tests cover offline first import, all five known
  rules, concurrent imports, complete cache removal, corrupted files, fallback
  download validation, retry recovery, export portability and package omission.
- The desktop build, type check and all 99 desktop regression tests passed.
- An isolated Windows core integration fixture prepared all five real public
  SRS files from an empty cache without any bootstrap network request. Its rule
  download endpoint deliberately returned HTTP 503. The negative control without
  `initial_path` failed to start; the prepared configuration started and forwarded
  an HTTP 204 request through a random loopback mixed proxy listener.
- This fixture used synthetic configuration, random loopback ports and no TUN.
  It did not start/stop the installed service or change Windows system proxy,
  Clash, the user's private configuration or any VPS. The fix still requires a
  new packaged client; these checks do not constitute an installed-client update.

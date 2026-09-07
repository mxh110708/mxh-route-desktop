# Public rule bootstrap cache

MXH Route recognizes the five MetaCubeX remote binary rule sets used by the
private authority configuration. On import validation and service start it
downloads `resources/public-rules-v1.json` from this repository using a fixed
public GET. The bundle contains public SRS data only, never a user profile.
The compiled-in SHA-256 pins the bootstrap bundle. Payload size, file names,
per-file digests and SRS signatures are validated before use. There is no ZIP
extraction and no profile-supplied download URL for the bootstrap package.

Verified files are stored under the application's user-data directory in
`public-rule-cache/<bundle-sha256>/`. Runtime-only `initial_path` values point
there. Saved/imported JSON and exported JSON/BPF omit these machine-specific
paths for recognized rule sets. Other rule sets and user files are untouched.
Existing profiles with the old absolute paths are supported at runtime too.

The first import requires network access; retry after connecting if unavailable.
Later imports and starts use a verified cache without network requests. Damaged
individual SRS files are rebuilt from the verified cached bundle. If the bundle
itself is invalid and offline, the operation fails with a clear error instead
of trusting bad data. Clearing this cache requires downloading again.

The sing-box core still uses each original remote URL and daily update interval;
this package only provides initial data, not a replacement update mechanism.
Moving to another computer requires only the private JSON and a compatible
MXH Route version; the public bootstrap package is downloaded there automatically.
Other sing-box clients ignore no custom fields because none are added: they
simply download the original remote rule sets without an initial local file.

## Maintainer procedure

Source: https://github.com/MetaCubeX/meta-rules-dat/tree/sing

Generate with `node --import tsx scripts/buildPublicRuleBundle.ts <public-srs-dir>`.
Only five allowlisted SRS files are read. Review upstream provenance/licensing,
update `PUBLIC_RULE_BUNDLE_SHA256`, and run `pnpm test:public-rules` before release.
Never substitute any private profile or private archive for the public SRS input.
Publish the versioned bundle before distributing the client that pins it. Retain
old versioned bundles for older clients. Never replace an existing bundle in place.

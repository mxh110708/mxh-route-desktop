# MXH Route

This repository is a personal Windows distribution based on the official
`SagerNet/sing-box-for-desktop` project. It keeps upstream behavior while
adding two official-style overview controls:

- Routing mode: Rule, Global, Direct.
- Traffic capture: System Proxy, TUN Mode.

The Windows installation is deliberately parallel to the official desktop
client. It uses a separate application identity, service, registry key, pipe,
and data directories.

The assisted uninstaller presents explicit choices to keep application data
for a later reinstall or to delete all application data. Keeping data is the
default. A fresh installer can recover a non-empty data directory only when it
has a valid MXH Route installation marker; unmarked, malformed, or unsafe
directories remain blocked.

Application artwork is generated from the icon shipped in the adjacent
official sing-box core checkout. The product name, application identity, and
update channel remain MXH Route, and this is still an unofficial personal
distribution.

## Upstream maintenance

The maintained branch is `custom-main`. The official repositories are kept as
the `upstream` remotes in all three working trees:

- Desktop: `SagerNet/sing-box-for-desktop`
- Dashboard: `SagerNet/sing-box-dashboard`
- Core: `SagerNet/sing-box`

The corresponding personal `origin` repositories are
`mxh110708/mxh-route-desktop`, `mxh110708/mxh-route-dashboard`, and
`mxh110708/mxh-route-core`.

Run `scripts/sync-upstream.ps1` only from a clean working tree. It fetches the
three upstream repositories, checks out the requested official desktop/core
version, reapplies the custom branches with rebases, updates the dashboard
submodule pointer, and stops on any conflict. Because rebasing rewrites the
personal branches, publish only with `--force-with-lease`, and only after the
tests and signed local package succeed.

## Update channel

Custom builds check only public Releases from
`mxh110708/mxh-route-desktop`. They accept only an installer whose
name exactly matches the custom release version. The privileged service also
requires the update installer to use the same signer as the installed build.
Unsafe signer-mismatch and not-newer fallbacks are disabled in custom builds.

## Secrets and releases

CI is intentionally test-only and receives no signing material. Windows
installers are built locally with `scripts/build-custom-release.ps1`; the code
signing certificate and password stay outside this repository. Never commit a
proxy profile, VPS archive, credential, token, private key, or signing file.
When dependency downloads require a local proxy, pass its URL through the
script's optional `-Proxy` parameter; the value is process-local and is not
stored in the repository.
The upstream-pinned Rust toolchain can likewise remain portable by passing its
Cargo and rustup directories through `-CargoHome` and `-RustupHome`; neither
directory is added to the machine-wide PATH.

The custom release revision comes from `custom-version.json`, while the
official base version remains in `version.json`. A prerelease such as
`1.14.0-beta.14` becomes `1.14.0-beta.14.mxh.1`; this preserves correct SemVer
ordering when the next official prerelease appears. Increment the custom
revision when the base version does not change.

This project remains under the upstream license in `LICENSE` and is not an
official SagerNet distribution.

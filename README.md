# MXH Route

MXH Route is a personal Windows routing client derived from the upstream
[`SagerNet/sing-box-for-desktop`](https://github.com/SagerNet/sing-box-for-desktop)
project. It is independently named and is not an official SagerNet release.

The maintained personal changes add:

- Rule, Global, and Direct routing controls on Overview.
- System Proxy and TUN traffic-capture controls on Overview.
- Adaptive System Proxy recovery that checks the actual CONNECT path, confirms
  consecutive failures, and reloads the selected profile without busy polling.
- A parallel Windows installation that does not take over the official
  desktop client's service, registry key, IPC pipe, or data directories.
- A public personal Release channel with exact asset-name, repository-path,
  version, and signer checks.

See [CUSTOM.md](CUSTOM.md) for upstream synchronization, local signed builds,
security boundaries, and release maintenance.

## Security

This repository and its CI contain no proxy profiles, VPS archives, passwords,
tokens, private keys, or code-signing material. Signed releases are produced
locally. The public application update channel does not embed a GitHub token.

## Upstream and license

The desktop, dashboard, and core source retain their upstream copyright and
license notices. See [LICENSE](LICENSE). The application name MXH Route is used
to comply with the upstream requirement that derivative works not use the
original application's name or imply official association without consent.

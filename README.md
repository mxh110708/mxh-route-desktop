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

## mxh.6：故障切换与日志保存

- `US-West Entry` 按 **DMIT → VMISS → MoeCloud** 优先级自动切换，同一服务商内沿用配置中的 IPv4／IPv6 顺序。
- 每个节点独立进行三个 HTTPS 目标探测，不切换主入口来测速。当前节点连续三轮失败、备用连续两轮可用才切换；首选至少三轮成功且稳定两分钟后自动切回。
- 单个网站失败不触发切换；全部不可用时不回落 DIRECT。手动选节点后暂停自动切换，重新启动代理后恢复。
- 系统代理和 TUN 模式均支持；Direct 路由模式暂停自动决策。需保持桌面应用运行，最小化到托盘即可。
- 核心日志 `core-runtime.log` 与探针日志 `system-proxy-health.log` 各保留当前文件及五份滚动备份，每份最多约 10 MiB。关开代理不会清除磁盘历史。
- 日志可能含节点名称、目标域名或地址，请仅作为本机私有诊断资料。应用未运行期间的核心日志不能完整补录，切换也不保证已有连接无缝迁移。

详见 [探测、恢复与日志规则](docs/proxy-health.md)。

## Security

This repository and its CI contain no proxy profiles, VPS archives, passwords,
tokens, private keys, or code-signing material. Signed releases are produced
locally. The public application update channel does not embed a GitHub token.

## Upstream and license

The desktop, dashboard, and core source retain their upstream copyright and
license notices. See [LICENSE](LICENSE). The application name MXH Route is used
to comply with the upstream requirement that derivative works not use the
original application's name or imply official association without consent.
